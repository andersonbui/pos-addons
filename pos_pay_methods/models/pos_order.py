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

    picking_ids = fields.Many2one('stock.picking', string='Picking', readonly=True, copy=False)
