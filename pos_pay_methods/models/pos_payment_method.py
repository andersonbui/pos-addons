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

class PosPaymentMethod(models.Model):
    _name = "pos.payment.method"
    _description = "Point of Sale Payment Methods"
    _order = "id asc"
    _inherit = 'pos.payment.method'

    cash_journal_id = fields.Many2one('account.journal',
        string='Journal',
        domain=[('type', 'in', ('cash', 'bank'))],
        ondelete='restrict',
        help='The payment method is of type cash. A cash statement will be automatically generated.\n'
             'Leave empty to use the receivable account of customer.\n'
             'Defines the journal where to book the accumulated payments (or individual payment if Identify Customer is true) after closing the session.\n'
             'For cash journal, we directly write to the default account in the journal via statement lines.\n'
             'For bank journal, we write to the outstanding account specified in this payment method.\n'
             'Only cash and bank journals are allowed.')
    
    is_cash_count = fields.Boolean(string='Cash', compute="_compute_is_cash_count", store=True)
    active = fields.Boolean(default=True)
    _type = fields.Selection(selection=[('cash', 'Cash'), ('bank', 'Bank'), ('pay_later', 'Customer Account')], compute="_compute_type", store=True)
    hide_use_payment_terminal = fields.Boolean(compute='_compute_hide_use_payment_terminal', help='Technical field which is used to '
                                               'hide use_payment_terminal when no payment interfaces are installed.')
    open_session_ids = fields.Many2many('pos.session', string='Pos Sessions', compute='_compute_open_session_ids', help='Open PoS sessions that are using this payment method.')
                                               
    @api.depends('_type')
    def _compute_is_cash_count(self):
        for pm in self:
            pm.is_cash_count = pm._type == 'cash'

    @api.depends('config_ids')
    def _compute_open_session_ids(self):
        for payment_method in self:
            payment_method.open_session_ids = self.env['pos.session'].search([('config_id', 'in', payment_method.config_ids.ids), ('state', '!=', 'closed')])    

    @api.depends('cash_journal_id', 'split_transactions')
    def _compute_type(self):
        for pm in self:
            if pm.cash_journal_id.type in {'cash', 'bank'}:
                pm._type = pm.cash_journal_id.type
            else:
                pm._type = 'pay_later'

    @api.depends('_type')
    def _compute_hide_use_payment_terminal(self):
        no_terminals = not bool(self._fields['use_payment_terminal'].selection(self))
        for payment_method in self:
            payment_method.hide_use_payment_terminal = no_terminals or payment_method._type in ('cash', 'pay_later')

    def _is_write_forbidden(self, fields):
        return bool(fields and self.open_session_ids)

    def write(self, vals):
        if self._is_write_forbidden(set(vals.keys())):
            raise UserError('Please close and validate the following open PoS Sessions before modifying this payment method.\n'
                            'Open sessions: %s' % (' '.join(self.open_session_ids.mapped('name')),))
        return super(PosPaymentMethod, self).write(vals)