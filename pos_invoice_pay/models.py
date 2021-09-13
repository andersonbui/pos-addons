# Copyright 2017 Artyom Losev
# Copyright 2018 Kolushov Alexandr <https://it-projects.info/team/KolushovAlexandr>
# License MIT (https://opensource.org/licenses/MIT).
from odoo import _, api, fields, models
from odoo.tools import float_is_zero

SO_CHANNEL = "pos_sale_orders"
INV_CHANNEL = "pos_invoices"


class PosOrder(models.Model):
    _inherit = "pos.order"

    @api.model
    def create_from_ui(self, orders, draft=False):
        invoices_to_pay = [o for o in orders if o.get("data").get("invoice_to_pay")]
        original_orders = [o for o in orders if o not in invoices_to_pay]

        res = super(PosOrder, self).create_from_ui(original_orders, draft=draft)

        self.create_from_ui_aux(invoices_to_pay, draft=draft)

        if invoices_to_pay:
            for inv in invoices_to_pay:
                #self.process_invoice_payment(inv)
                # este pago es una entrada de dinero que deberia registrarse en la caja y no deberia devolverse
                # el total pagado como estaba originalmente
                inv['data']['amount_return'] = 0

        return res

    def create_from_ui_aux(self, orders, draft=False):
        """ Create and update Orders from the frontend PoS application.

        Create new orders and update orders that are in draft status. If an order already exists with a status
        diferent from 'draft'it will be discareded, otherwise it will be saved to the database. If saved with
        'draft' status the order can be overwritten later by this function.

        :param orders: dictionary with the orders to be created.
        :type orders: dict.
        :param draft: Indicate if the orders are ment to be finalised or temporarily saved.
        :type draft: bool.
        :Returns: list -- list of db-ids for the created and updated orders.
        """
        order_ids = []
        for order in orders:
            existing_order = False

            order

            if 'server_id' in order['data']:
                order_server_id = order['data']['server_id']
                order_name = order['data']['name']
                existing_order = self.env['pos.order'].search(['|', ('id', '=', order_server_id), ('pos_reference', '=', order_name)], limit=1)
            if (existing_order and existing_order.state == 'draft') or not existing_order:
                order_ids.append(self._process_order(order, draft, existing_order))


    def process_invoice_payment(self, invoice):
        for statement in invoice["data"]["statement_ids"]:
            if(statement == 0):
                continue
            inv_id = invoice["data"]["invoice_to_pay"]["id"]
            inv_obj = self.env["account.move"].browse(inv_id)
            payment_method_id = statement[2]["payment_method_id"]
            journal = self.env["pos.payment.method"].browse(payment_method_id)
            amount = min(
                statement[2]["amount"],  # amount payed including change
                invoice["data"]["invoice_to_pay"][
                    "amount_residual"
                ],  # amount required to pay
            )
            cashier = invoice["data"]["user_id"]
            writeoff_acc_id = False
            payment_difference_handling = "open"

            vals = {
                "journal_id": journal.id,
                "payment_method_id": payment_method_id,
                "payment_date": invoice["data"]["creation_date"],
                # "communication": invoice["data"]["invoice_to_pay"]["number"],
                "invoice_ids": [(4, inv_id, None)],
                "payment_type": "inbound",
                "amount": amount,
                "currency_id": inv_obj.currency_id.id,
                "partner_id": invoice["data"]["invoice_to_pay"]["partner_id"][0],
                "partner_type": "customer",
                "payment_difference_handling": payment_difference_handling,
                "writeoff_account_id": writeoff_acc_id,
                "pos_session_id": invoice["data"]["pos_session_id"],
                "cashier": cashier,
            }
            payment = self.env["account.payment"].create(vals)
            payment.post()

    def action_pos_order_paid(self):
        self.write({'state': 'paid'})
        return self.create_picking()

    def write(self, vals):
        for order in self:
            if vals.get('state') and vals['state'] == 'paid' and order.name == '/':
                vals['name'] = order.config_id.sequence_id._next()
        return super(PosOrder, self).write(vals)


    def action_pos_order_paid(self):
        self.write({'state': 'paid'})
        return self.create_picking()


    def _process_payment_lines(self, pos_order, order, pos_session, draft):
        """Create account.bank.statement.lines from the dictionary given to the parent function.

        If the payment_line is an updated version of an existing one, the existing payment_line will first be
        removed before making a new one.
        :param pos_order: dictionary representing the order.
        :type pos_order: dict.
        :param order: Order object the payment lines should belong to.
        :type order: pos.order
        :param pos_session: PoS session the order was created in.
        :type pos_session: pos.session
        :param draft: Indicate that the pos_order is not validated yet.
        :type draft: bool.
        """
        prec_acc = order.pricelist_id.currency_id.decimal_places
        #self.write({'state': 'paid'})

        order_bank_statement_lines = self.env['pos.payment'].search([('pos_order_id', '=', order.id)])
        order_bank_statement_lines.unlink()
        for payments in pos_order['statement_ids']:
            payamount = payments[2]['amount']
            if not float_is_zero(payamount, precision_digits=prec_acc):
                paymentfields = self._payment_fields(order, payments[2])
                order.add_payment(paymentfields)

        order.amount_paid = sum(order.payment_ids.mapped('amount'))
        pass

    @api.model
    def process_invoices_creation(self, sale_order_id):
        order = self.env["sale.order"].browse(sale_order_id)
        inv_id = order._create_invoices(final=True)
        inv_id.action_post()
        return inv_id.id


class AccountPayment(models.Model):
    _inherit = "account.payment"

    pos_session_id = fields.Many2one("pos.session", string="POS session")
    cashier = fields.Many2one("res.users")
    datetime = fields.Datetime(string="Datetime", default=fields.Datetime.now)


class AccountInvoice(models.Model):
    _inherit = "account.move"

    def action_updated_invoice(self):
        message = {"channel": INV_CHANNEL, "id": self.id}
        self.env["pos.config"].search([])._send_to_channel(INV_CHANNEL, message)

    @api.model
    def get_invoice_lines_for_pos(self, move_ids):
        res = self.env["account.move.line"].search_read(
            [("mode_id", "in", move_ids)],
            [
                "id",
                "move_id",
                "name",
                "account",
                "product",
                "price_unit",
                "qty",
                "tax",
                "discount",
                "amount",
            ],
        )
        return res

    @api.depends("payment_move_line_ids.amount_residual")
    def _get_payment_info_JSON(self):
        for record in self:
            if not record.payment_move_line_ids:
                pass
            for move in record.payment_move_line_ids:
                if move.payment_id.cashier:
                    if move.move_id.ref:
                        move.move_id.ref = "{} by {}".format(
                            move.move_id.ref, move.payment_id.cashier.name
                        )
                    else:
                        move.move_id.name = "{} by {}".format(
                            move.move_id.name, move.payment_id.cashier.name
                        )
        data = super(AccountInvoice, self)._get_payment_info_JSON()
        return data


class SaleOrder(models.Model):
    _inherit = "sale.order"

    def action_updated_sale_order(self):
        message = {"channel": SO_CHANNEL, "id": self.id}
        self.env["pos.config"].search([])._send_to_channel(SO_CHANNEL, message)

    @api.model
    def get_order_lines_for_pos(self, sale_order_ids):
        res = []
        order_lines = self.env["sale.order.line"].search(
            [("order_id", "in", sale_order_ids)]
        )
        for i in order_lines:
            line = {
                "order_id": i.order_id.id,
                "id": i.id,
                "name": i.name,
                "product": i.product_id.name,
                "uom_qty": i.product_uom_qty,
                "qty_delivered": i.qty_delivered,
                "qty_invoiced": i.qty_invoiced,
                "tax": [tax.name or " " for tax in i.tax_id],
                "discount": i.discount,
                "subtotal": i.price_subtotal,
                "total": i.price_total,
                "invoiceble": (
                    (i.qty_delivered > 0) or (i.product_id.invoice_policy == "order")
                ),
            }
            res.append(line)
        return res


class PosConfig(models.Model):
    _inherit = "pos.config"

    def _get_default_writeoff_account(self):
        acc = self.env["account.account"].search([("code", "=", 220000)]).id
        return acc if acc else False

    show_invoices = fields.Boolean(help="Show invoices in POS", default=True)
    show_sale_orders = fields.Boolean(help="Show sale orders in POS", default=True)
    pos_invoice_pay_writeoff_account_id = fields.Many2one(
        "account.account",
        string="Difference Account",
        help="The account is used for the difference between due and paid amount",
        default=_get_default_writeoff_account,
    )
    invoice_cashier_selection = fields.Boolean(
        string="Select Invoice Cashier",
        help="Ask for a cashier when fetch invoices",
        defaul=True,
    )
    sale_order_cashier_selection = fields.Boolean(
        string="Select Sale Order Cashier",
        help="Ask for a cashier when fetch orders",
        defaul=True,
    )


class PosSession(models.Model):
    _inherit = "pos.session"

    session_payments = fields.One2many(
        "account.payment",
        "pos_session_id",
        string="Invoice Payments",
        help="Show invoices paid in the Session",
    )
    session_invoices_total = fields.Float(
        "Invoices", compute="_compute_session_invoices_total"
    )

    def _compute_session_invoices_total(self):
        for rec in self:
            rec.session_invoices_total = sum(
                rec.session_payments.mapped("invoice_ids").mapped("amount_total") + [0]
            )

    def action_invoice_payments(self):
        payments = self.env["account.payment"].search(
            [("pos_session_id", "in", self.ids)]
        )
        invoices = payments.mapped("invoice_ids").ids
        domain = [("id", "in", invoices)]
        return {
            "name": _("Invoice Payments"),
            "type": "ir.actions.act_window",
            "domain": domain,
            "res_model": "account.move",
            "view_type": "form",
            "view_mode": "tree,form",
        }
