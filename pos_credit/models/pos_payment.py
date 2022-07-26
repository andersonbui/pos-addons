from odoo import api, fields, models, _
from odoo.tools import formatLang, float_is_zero
from odoo.exceptions import ValidationError

class PosPayment(models.Model): 
    """ Used to register payments made in a pos.order.

    See `payment_ids` field of pos.order model.
    The main characteristics of pos.payment can be read from
    `payment_method_id`.
    """

    _inherit= "pos.payment"

    cardholder_name = fields.Char('Cardholder Name')
    payment_status = fields.Char('Payment Status')
    ticket = fields.Char('Payment Receipt Info')
    is_change = fields.Boolean(string='Is this payment change?', default=False)
    account_move_id = fields.Many2one('account.move')


    def _export_for_ui(self, payment):
        return {
            'payment_method_id': payment.payment_method_id.id,
            'amount': payment.amount,
            'payment_status': payment.payment_status,
            'card_type': payment.card_type,
            'cardholder_name': payment.cardholder_name,
            'transaction_id': payment.transaction_id,
            'ticket': payment.ticket,
            'is_change': payment.is_change,
        }

    def export_for_ui(self):
        return self.mapped(self._export_for_ui) if self else []

    def _create_payment_moves(self):
        result = self.env['account.move']
        for payment in self:
            order = payment.pos_order_id
            payment_method = payment.payment_method_id
            if payment_method.type == 'pay_later' or float_is_zero(payment.amount, precision_rounding=order.currency_id.rounding):
                continue
            accounting_partner = self.env["res.partner"]._find_accounting_partner(payment.partner_id)
            pos_session = order.session_id
            journal = pos_session.config_id.journal_id
            payment_move = self.env['account.move'].with_context(default_journal_id=journal.id).create({
                'journal_id': journal.id,
                'date': fields.Date.context_today(payment),
                'ref': _('Invoice payment for %s (%s) using %s') % (order.name, order.account_move.name, payment_method.name),
                'pos_payment_ids': payment.ids,
            })
            result |= payment_move
            payment.write({'account_move_id': payment_move.id})
            amounts = pos_session._update_amounts({'amount': 0, 'amount_converted': 0}, {'amount': payment.amount}, payment.payment_date)
            credit_line_vals = pos_session._credit_amounts({
                'account_id': accounting_partner.property_account_receivable_id.id,
                'partner_id': accounting_partner.id,
                'move_id': payment_move.id,
            }, amounts['amount'], amounts['amount_converted'])
            debit_line_vals = pos_session._debit_amounts({
                'account_id': pos_session.company_id.account_default_pos_receivable_account_id.id,
                'move_id': payment_move.id,
            }, amounts['amount'], amounts['amount_converted'])
            self.env['account.move.line'].with_context(check_move_validity=False).create([credit_line_vals, debit_line_vals])
            payment_move.post()
        return result

 
