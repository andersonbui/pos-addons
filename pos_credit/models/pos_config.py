from odoo import api, fields, models, _
from odoo.exceptions import ValidationError, UserError


class PosConfig(models.Model):

    _inherit = 'pos.config'
    _description = 'Point of Sale Configuration'

    cash_rounding = fields.Boolean(string="Cash Rounding")