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

class AccountMove(models.Model):

    _inherit = 'account.move'
    pos_payment_ids = fields.One2many('pos.payment', 'account_move_id')


    def _compute_amount(self):

        super(AccountMove, self)._compute_amount()        
        for inv in self:            
            if inv.type in ['out_invoice', 'out_refund'] and inv.pos_order_ids and any(s != 'closed' for s in inv.pos_order_ids.mapped('session_id.state')):
                amount = 0 
                rounding = 0.0
                amountTotal = 0
                amountResidual = 0
            
                rounding = inv.pos_order_ids.currency_id.rounding
                amountResidual = inv.amount_residual
                amountTotal = inv.amount_total

                isPaid = float_is_zero(amountResidual, rounding)
                if isPaid:
                    inv.invoice_payment_state = 'paid'
                
                else:
                    inv.invoice_payment_state = 'not_paid'

