# -*- coding: utf-8 -*-

from collections import defaultdict
from odoo.tools import float_is_zero, float_compare
from odoo import api, fields, models, _

class PosSession(models.Model):
    _inherit = 'pos.session'    

    opening_notes = fields.Text(string="Opening Notes")

    cash_real_difference = fields.Monetary(string='Difference', readonly=True)
    cash_real_transaction = fields.Monetary(string='Transaction', readonly=True)
    cash_real_expected = fields.Monetary(string="Expected", readonly=True)

    failed_pickings = fields.Boolean(compute='_compute_picking_count')

    update_stock_at_closing = fields.Boolean('Stock should be updated at closing')

    def _compute_picking_count(self):
        for pos in self:
            pickings = pos.order_ids.mapped('picking_ids').filtered(lambda x: x.state != 'done')
            pos.picking_count = len(pickings.ids)

    def action_stock_picking(self):
        pickings = self.order_ids.mapped('picking_ids').filtered(lambda x: x.state != 'done')
        action_picking = self.env.ref('stock.action_picking_tree_ready')
        action = action_picking.read()[0]
        action['context'] = {}
        action['domain'] = [('id', 'in', pickings.ids)]
        return action

    def _create_account_move(self):
        """ Create account.move and account.move.line records for this session.

        Side-effects include:
            - setting self.move_id to the created account.move record
            - creating and validating account.bank.statement for cash payments
            - reconciling cash receivable lines, invoice receivable lines and stock output lines
        """
        journal = self.config_id.journal_id
        # Passing default_journal_id for the calculation of default currency of account move
        # See _get_default_currency in the account/account_move.py.
        account_move = self.env['account.move'].with_context(default_journal_id=journal.id).create({
            'journal_id': journal.id,
            'date': fields.Date.context_today(self),
            'ref': self.name,
        })
        self.write({'move_id': account_move.id})

        data = {'bank_payment_method_diffs': {}}
        data = self._accumulate_amounts(data)
        data = self._create_non_reconciliable_move_lines(data)
        data = self._create_bank_payment_moves(data)
        data = self._create_cash_statement_lines_and_cash_move_lines(data)
        data = self._create_invoice_receivable_lines(data)
        data = self._create_stock_output_lines(data)
        data = self._create_extra_move_lines(data)
        data = self._create_balancing_line(data)
        data = self._reconcile_account_move_lines(data)

        return data

    def _accumulate_amounts(self, data):
        # Accumulate the amounts for each accounting lines group
        # Each dict maps `key` -> `amounts`, where `key` is the group key.
        # E.g. `combine_receivables` is derived from pos.payment records
        # in the self.order_ids with group key of the `payment_method_id`
        # field of the pos.payment record.
        amounts = lambda: {'amount': 0.0, 'amount_converted': 0.0}
        tax_amounts = lambda: {'amount': 0.0, 'amount_converted': 0.0, 'base_amount': 0.0, 'base_amount_converted': 0.0}

        split_receivables = defaultdict(amounts)
        split_receivables_cash = defaultdict(amounts)
        split_receivables_pay_later = defaultdict(amounts)

        combine_receivables = defaultdict(amounts)
        combine_receivables_cash = defaultdict(amounts)
        combine_receivables_pay_later = defaultdict(amounts)

        combine_invoice_receivables = defaultdict(amounts)
        split_invoice_receivables = defaultdict(amounts)

        sales = defaultdict(amounts)
        taxes = defaultdict(tax_amounts)
        stock_expense = defaultdict(amounts)
        stock_output = defaultdict(amounts)
        stock_return = defaultdict(amounts)
        rounding_difference = {'amount': 0.0, 'amount_converted': 0.0}
        # Track the receivable lines of the invoiced orders' account moves for reconciliation
        # These receivable lines are reconciled to the corresponding invoice receivable lines
        # of this session's move_id.
        combine_inv_payment_receivable_lines = defaultdict(lambda: self.env['account.move.line'])
        split_inv_payment_receivable_lines = defaultdict(lambda: self.env['account.move.line'])
        rounded_globally = self.company_id.tax_calculation_rounding_method == 'round_globally'
        pos_receivable_account = self.company_id.account_default_pos_receivable_account_id
        
        for order in self.order_ids:
            order_is_invoiced = order.is_invoiced
            # Combine pos receivable lines
            # Separate cash payments for cash reconciliation later.
            for payment in order.payment_ids:
                amount, date = payment.amount, payment.payment_date
                payment_method = payment.payment_method_id
                is_split_payment = payment_method.split_transactions
                payment_type = payment_method.type

                # If not pay_later, we create the receivable vals for both invoiced and uninvoiced orders.
                #   Separate the split and aggregated payments.
                # Moreover, if the order is invoiced, we create the pos receivable vals that will balance the
                # pos receivable lines from the invoice payments.
                if payment_type != 'pay_later':

                    if is_split_payment and payment_type == 'cash':
                        split_receivables_cash[payment] = self._update_amounts(split_receivables_cash[payment], {'amount': amount}, date)
                    elif not is_split_payment and payment_type == 'cash':
                        combine_receivables_cash[payment_method] = self._update_amounts(combine_receivables_cash[payment_method], {'amount': amount}, date)
                    elif is_split_payment and payment_type == 'bank':
                        split_receivables[payment] = self._update_amounts(split_receivables[payment], {'amount': amount}, date)
                    elif not is_split_payment and payment_type == 'bank':
                        combine_receivables[payment_method] = self._update_amounts(combine_receivables[payment_method], {'amount': amount}, date)

                    # Create the vals to create the pos receivables that wi*-ll balance the pos receivables from invoice payment moves.
                    if order_is_invoiced:
                        if is_split_payment:
                            split_inv_payment_receivable_lines[payment] |= payment.account_move_id.line_ids.filtered(
                                lambda line: line.account_id == pos_receivable_account)
                            split_invoice_receivables[payment] = self._update_amounts(
                                split_invoice_receivables[payment], {'amount': payment.amount}, order.date_order)
                        else:
                            combine_inv_payment_receivable_lines[payment_method] |= payment.account_move_id.line_ids.filtered(
                                lambda line: line.account_id == pos_receivable_account)
                            combine_invoice_receivables[payment_method] = self._update_amounts(
                                combine_invoice_receivables[payment_method], {'amount': payment.amount}, order.date_order)

                # If pay_later, we create the receivable lines.
                #   if split, with partner
                #   Otherwise, it's aggregated (combined)
                # But only do if order is *not* invoiced because no account move is created for pay later invoice payments.
                if payment_type == 'pay_later' and not order_is_invoiced:
                    if is_split_payment:
                        split_receivables_pay_later[payment] = self._update_amounts(split_receivables_pay_later[payment], {'amount': amount}, date)
                    elif not is_split_payment:
                        combine_receivables_pay_later[payment_method] = self._update_amounts( combine_receivables_pay_later[payment_method], {'amount': amount}, date)

            if not order_is_invoiced:
                order_taxes = defaultdict(tax_amounts)
                for order_line in order.lines:
                    line = self._prepare_line(order_line)
                    # Combine sales/refund lines
                    sale_key = (
                        # account
                        line['income_account_id'],
                        # sign
                        -1 if line['amount'] < 0 else 1,
                        # for taxes
                        tuple((tax['id'], tax['account_id'], tax['tax_repartition_line_id']) for tax in line['taxes']),
                        line['base_tags'],
                    )
                    sales[sale_key] = self._update_amounts(sales[sale_key], {'amount': line['amount']}, line['date_order'])
                    # Combine tax lines
                    for tax in line['taxes']:
                        tax_key = (tax['account_id'], tax['tax_repartition_line_id'], tax['id'], tuple(tax['tag_ids']))
                        order_taxes[tax_key] = self._update_amounts(
                            order_taxes[tax_key],
                            {'amount': tax['amount'], 'base_amount': tax['base']},
                            tax['date_order'],
                            round=not rounded_globally
                        )
                for tax_key, amounts in order_taxes.items():
                    if rounded_globally:
                        amounts = self._round_amounts(amounts)
                    for amount_key, amount in amounts.items():
                        taxes[tax_key][amount_key] += amount

                if self.company_id.anglo_saxon_accounting and order.picking_ids.id:
                    # Combine stock lines
                    order_pickings = self.env['stock.picking'].search([
                        '|',
                        ('origin', '=', '%s - %s' % (self.name, order.name)),
                        ('id', '=', order.picking_ids.id)
                    ])
                    stock_moves = self.env['stock.move'].search([
                        ('picking_ids', 'in', order_pickings.ids),
                        ('company_id.anglo_saxon_accounting', '=', True),
                        ('product_id.categ_id.property_valuation', '=', 'real_time')
                    ])
                    for move in stock_moves:
                        exp_key = move.product_id.property_account_expense_id or move.product_id.categ_id.property_account_expense_categ_id
                        out_key = move.product_id.categ_id.property_stock_account_output_categ_id
                        amount = -sum(move.sudo().stock_valuation_layer_ids.mapped('value'))
                        stock_expense[exp_key] = self._update_amounts(stock_expense[exp_key], {'amount': amount}, move.picking_id.date, force_company_currency=True)
                        if move.location_id.usage == 'customer':
                            stock_return[out_key] = self._update_amounts(stock_output[out_key], {'amount': amount}, move.picking_id.date, force_company_currency=True)
                        else:
                            stock_output[out_key] = self._update_amounts(stock_output[out_key], {'amount': amount}, move.picking_id.date, force_company_currency=True)

                # Increasing current partner's customer_rank
                partners = (order.partner_id | order.partner_id.commercial_partner_id)
                partners._increase_rank('customer_rank')

        MoveLine = self.env['account.move.line'].with_context(check_move_validity=False)

        data.update({
            'taxes':                               taxes,
            'sales':                               sales,
            'stock_expense':                       stock_expense,
            'split_receivables':                   split_receivables,
            'combine_receivables':                 combine_receivables,
            'split_receivables_cash':              split_receivables_cash,
            'combine_receivables_cash':            combine_receivables_cash,
            'split_invoice_receivables':           split_invoice_receivables,
            'combine_invoice_receivables':         combine_invoice_receivables,
            'split_receivables_pay_later':         split_receivables_pay_later,
            'combine_receivables_pay_later':       combine_receivables_pay_later,
            'stock_return':                        stock_return,
            'stock_output':                        stock_output,
            'combine_inv_payment_receivable_lines': combine_inv_payment_receivable_lines,
            'MoveLine':                            MoveLine,
            'rounding_difference':                 rounding_difference,
            'split_inv_payment_receivable_lines':  split_inv_payment_receivable_lines,
        })
        return data

    def _create_bank_payment_moves(self, data):
        combine_receivables_bank = data.get('combine_receivables')
        split_receivables_bank = data.get('split_receivables')
        bank_payment_method_diffs = data.get('bank_payment_method_diffs')
        MoveLine = data.get('MoveLine')
        payment_method_to_receivable_lines = {}
        payment_to_receivable_lines = {}
        for payment_method, amounts in combine_receivables_bank.items():
            combine_receivable_line = MoveLine.create(self._get_combine_receivable_vals(payment_method, amounts['amount'], amounts['amount_converted']))
            payment_receivable_line = self._create_combine_account_payment(payment_method, amounts, diff_amount=bank_payment_method_diffs.get(payment_method.id) or 0)
            payment_method_to_receivable_lines[payment_method] = combine_receivable_line | payment_receivable_line

        for payment, amounts in split_receivables_bank.items():
            split_receivable_line = MoveLine.create(self._get_split_receivable_vals(payment, amounts['amount'], amounts['amount_converted']))
            payment_receivable_line = self._create_split_account_payment(payment, amounts)
            payment_to_receivable_lines[payment] = split_receivable_line | payment_receivable_line

        for bank_payment_method in self.payment_method_ids.filtered(lambda pm: pm.type == 'bank' and pm.split_transactions):
            self._create_diff_account_move_for_split_payment_method(bank_payment_method, bank_payment_method_diffs.get(bank_payment_method.id) or 0)

        data['payment_method_to_receivable_lines'] = payment_method_to_receivable_lines
        data['payment_to_receivable_lines'] = payment_to_receivable_lines
        return data

    def _create_pay_later_receivable_lines(self, data):
        MoveLine = data.get('MoveLine')
        combine_receivables_pay_later = data.get('combine_receivables_pay_later')
        split_receivables_pay_later = data.get('split_receivables_pay_later')
        vals = []
        for payment_method, amounts in combine_receivables_pay_later.items():
            vals.append(self._get_combine_receivable_vals(payment_method, amounts['amount'], amounts['amount_converted']))
        for payment, amounts in split_receivables_pay_later.items():
            vals.append(self._get_split_receivable_vals(payment, amounts['amount'], amounts['amount_converted']))
        MoveLine.create(vals)
        return data


    def _create_invoice_receivable_lines(self, data):
        # Create invoice receivable lines for this session's move_id.
        # Keep reference of the invoice receivable lines because
        # they are reconciled with the lines in combine_inv_payment_receivable_lines
        MoveLine = data.get('MoveLine')
        combine_invoice_receivables = data.get('combine_invoice_receivables')
        split_invoice_receivables = data.get('split_invoice_receivables')

        combine_invoice_receivable_vals = defaultdict(list)
        split_invoice_receivable_vals = defaultdict(list)
        combine_invoice_receivable_lines = {}
        split_invoice_receivable_lines = {}
        for payment_method, amounts in combine_invoice_receivables.items():
            combine_invoice_receivable_vals[payment_method].append(self._get_invoice_receivable_vals(amounts['amount'], amounts['amount_converted']))
        for payment, amounts in split_invoice_receivables.items():
            split_invoice_receivable_vals[payment].append(self._get_invoice_receivable_vals(amounts['amount'], amounts['amount_converted']))
        for payment_method, vals in combine_invoice_receivable_vals.items():
            receivable_lines = MoveLine.create(vals)
            combine_invoice_receivable_lines[payment_method] = receivable_lines
        for payment, vals in split_invoice_receivable_vals.items():
            receivable_lines = MoveLine.create(vals)
            split_invoice_receivable_lines[payment] = receivable_lines

        data.update({'combine_invoice_receivable_lines': combine_invoice_receivable_lines})
        data.update({'split_invoice_receivable_lines': split_invoice_receivable_lines})
        return data


    def _reconcile_account_move_lines(self, data):
        # reconcile cash receivable lines
        split_cash_statement_lines = data.get('split_cash_statement_lines')
        combine_cash_statement_lines = data.get('combine_cash_statement_lines')
        split_cash_receivable_lines = data.get('split_cash_receivable_lines')
        combine_cash_receivable_lines = data.get('combine_cash_receivable_lines')
        combine_inv_payment_receivable_lines = data.get('combine_inv_payment_receivable_lines')
        split_inv_payment_receivable_lines = data.get('split_inv_payment_receivable_lines')
        combine_invoice_receivable_lines = data.get('combine_invoice_receivable_lines')
        split_invoice_receivable_lines = data.get('split_invoice_receivable_lines')
        stock_output_lines = data.get('stock_output_lines')
        payment_method_to_receivable_lines = data.get('payment_method_to_receivable_lines')
        payment_to_receivable_lines = data.get('payment_to_receivable_lines')

        for statement in self.statement_ids:
            if not self.config_id.cash_control:
                statement.write({'balance_end_real': statement.balance_end})
            statement.button_confirm_bank()
            all_lines = (
                  split_cash_statement_lines[statement].mapped('journal_entry_ids').filtered(lambda aml: aml.account_id.internal_type == 'receivable')
                | combine_cash_statement_lines[statement].mapped('journal_entry_ids').filtered(lambda aml: aml.account_id.internal_type == 'receivable')
                | split_cash_receivable_lines[statement]
                | combine_cash_receivable_lines[statement]
            )
            accounts = all_lines.mapped('account_id')
            lines_by_account = [all_lines.filtered(lambda l: l.account_id == account and not l.reconciled) for account in accounts]
            for lines in lines_by_account:
                lines.reconcile()

        for payment_method, lines in payment_method_to_receivable_lines.items():
            receivable_account = self._get_receivable_account(payment_method)
            if receivable_account.reconcile:
                lines.filtered(lambda line: not line.reconciled).reconcile()

        for payment, lines in payment_to_receivable_lines.items():
            if payment.partner_id.property_account_receivable_id.reconcile:
                lines.filtered(lambda line: not line.reconciled).reconcile()

        # reconcile stock output lines
        orders_to_invoice = self.order_ids.filtered(lambda order: not order.is_invoiced)
        stock_moves = (
            orders_to_invoice.mapped('picking_ids') +
            self.env['stock.picking'].search([('origin', 'in', orders_to_invoice.mapped(lambda o: '%s - %s' % (self.name, o.name)))])
        ).mapped('move_lines')
        stock_account_move_lines = self.env['account.move'].search([('stock_move_id', 'in', stock_moves.ids)]).mapped('line_ids')
        for account_id in stock_output_lines:
            lista = ( stock_output_lines[account_id]
            | stock_account_move_lines.filtered(lambda aml: aml.account_id == account_id)
            ).filtered(lambda aml: not aml.reconciled)
            lista.reconcile()
        return data
        

    def _get_invoice_receivable_vals(self, amount, amount_converted):
        account_id = self.company_id.account_default_pos_receivable_account_id.id
        partial_vals = {
            'account_id': account_id,
            'move_id': self.move_id.id,
            'name': 'From invoiced orders',
        }
        return self._credit_amounts(partial_vals, amount, amount_converted)


    def _create_combine_account_payment(self, payment_method, amounts, diff_amount):
        outstanding_account = payment_method.outstanding_account_id or self.company_id.account_journal_payment_debit_account_id
        destination_account = self._get_receivable_account(payment_method)

        if float_compare(amounts['amount'], 0, precision_rounding=self.currency_id.rounding) < 0:
            # revert the accounts because account.payment doesn't accept negative amount.
            outstanding_account, destination_account = destination_account, outstanding_account

        account_payment = self.env['account.payment'].create({
            'payment_type': 'outbound',
            'payment_method_id': payment_method.id,
            'amount': abs(amounts['amount']),
            #'journal_id': payment_method.journal_id.id,
            'journal_id': payment_method.cash_journal_id.id,
            'force_outstanding_account_id': outstanding_account.id,
            'destination_account_id':  destination_account.id,
            #'ref': 1,#_('Combine %s POS payments from %s') % (payment_method.name, self.name),            
            'pos_payment_method_id': payment_method.id,
            'pos_session_id': self.id,
        })

        diff_amount_compare_to_zero = self.currency_id.compare_amounts(diff_amount, 0)
        if diff_amount_compare_to_zero != 0:
            self._apply_diff_on_account_payment_move(account_payment, payment_method, diff_amount)

        account_payment.action_post()
        return account_payment.move_id.line_ids.filtered(lambda line: line.account_id == account_payment.destination_account_id)

    
    def _get_receivable_account(self, payment_method):
        """Returns the default pos receivable account if no receivable_account_id is set on the payment method."""
        return payment_method.receivable_account_id or self.company_id.account_default_pos_receivable_account_id
        