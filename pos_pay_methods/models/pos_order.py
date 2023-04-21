# Copyright 2017 Artyom Losev
# Copyright 2018 Kolushov Alexandr <https://it-projects.info/team/KolushovAlexandr>
# License MIT (https://opensource.org/licenses/MIT).

from functools import reduce
from pyexpat import model
import psycopg2
import logging
from odoo import _, api, fields, models, tools
from odoo.tools import float_is_zero, float_round
from odoo.exceptions import ValidationError, UserError

_logger = logging.getLogger(__name__)

class PosOrder(models.Model):
    _inherit = "pos.order"

    invoice_to_pay = fields.Boolean(
        string='',
        default=False,
        help='')

    @api.model
    def create_from_ui(self, orders, draft=False):
        invoices_to_pay = [o for o in orders if o.get("data").get("invoice_to_pay")]
        original_orders = [o for o in orders if o not in invoices_to_pay]

        res = super(PosOrder, self).create_from_ui(original_orders, draft=draft)
        if invoices_to_pay:
            self.create_from_ui_aux(invoices_to_pay, draft=draft)

        return res

    @api.model
    def _order_fields(self, ui_order):
        process_line = super(PosOrder, self)._order_fields(ui_order) 
        if 'invoice_to_pay' in (ui_order):
            process_line['invoice_to_pay'] = ui_order['invoice_to_pay']     
            process_line['account_move'] = ui_order['invoice_to_pay']['id']     
            process_line['state'] = 'invoiced'           
        else:
            process_line['invoice_to_pay'] = False
        
        return process_line

    @api.model
    def process_invoices_creation(self, sale_order_id):
        """Crea factura desde API"""
        order = self.env["sale.order"].browse(sale_order_id)
        inv_id = order._create_invoices(final=True)
        if inv_id.state == 'draft': # factura sin publicar publicada
            inv_id.sudo().with_context(force_company=order.company_id.id).action_post()
            # inv_id.sudo().with_context(force_company=order.company_id.id).post()
        return inv_id.id

