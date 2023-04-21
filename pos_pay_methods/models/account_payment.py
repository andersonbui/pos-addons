from odoo import api, fields, models

class AccountPayment(models.Model):
    _inherit = "account.payment"
    #_inherits = {'account.move': 'ref'}

    # --------------------------------------
    # Business Fields
    # --------------------------------------

    move_id = fields.Many2one(
        comodel_name='account.move',
        #string='Journal Entry', required=True, readonly=True, ondelete='cascade',
        string='Journal Entry', readonly=True, ondelete='cascade',
        check_company=True)


    is_internal_transfer = fields.Boolean(string="Internal Transfer",
        readonly=False, store=True,
        tracking=True,
        compute="_compute_is_internal_transfer")

    paired_internal_transfer_payment_id = fields.Many2one('account.payment',
        help="When an internal transfer is posted, a paired payment is created. "
        "They are cross referenced trough this field")


    pos_payment_method_id = fields.Many2one('pos.payment.method', "POS Payment Method")
    force_outstanding_account_id = fields.Many2one("account.account", "Forced Outstanding Account", check_company=True)
    pos_session_id = fields.Many2one('pos.session', "POS Session")

    ref = fields.Char(string='Reference', copy=False, store=True)

    def _get_valid_liquidity_accounts(self):
        result = super()._get_valid_liquidity_accounts()
        return result + (self.pos_payment_method_id.outstanding_account_id,)

    @api.depends("force_outstanding_account_id")
    def _compute_outstanding_account_id(self):
        """When force_outstanding_account_id is set, we use it as the outstanding_account_id."""
        super()._compute_outstanding_account_id()
        for payment in self:
            if payment.force_outstanding_account_id:
                payment.outstanding_account_id = payment.force_outstanding_account_id

    
    # -----------------------------------
    # METHODS COMPUTE 
    # -----------------------------------
    @api.depends('partner_id', 'destination_account_id', 'journal_id')
    def _compute_is_internal_transfer(self):
        for payment in self:
            payment.is_internal_transfer = payment.partner_id and payment.partner_id == payment.journal_id.company_id.partner_id
    

    # -----------------------------------
    # BUSINESS METHODS
    # -----------------------------------
    def action_post(self):
        ''' draft -> posted '''
        #self.move_id._post(soft=False)
        self.move_id.post()

        self.filtered(
          lambda pay: pay.is_internal_transfer and not pay.paired_internal_transfer_payment_id
             )._create_paired_internal_transfer_payment()



    # -------------------------------------------------------------------------
    # SYNCHRONIZATION account.payment <-> account.move
    # -------------------------------------------------------------------------

    def _create_paired_internal_transfer_payment(self):
        ''' When an internal transfer is posted, a paired payment is created
        with opposite payment_type and swapped journal_id & destination_journal_id.
        Both payments liquidity transfer lines are then reconciled.
        '''
        for payment in self:

            paired_payment = payment.copy({
                'journal_id': payment.destination_journal_id.id,
                'destination_journal_id': payment.journal_id.id,
                'payment_type': payment.payment_type == 'outbound' and 'inbound' or 'outbound',
                'move_id': None,
                'ref': payment.ref,
                'paired_internal_transfer_payment_id': payment.id,
                'date': payment.date,
            })
            paired_payment.move_id._post(soft=False)
            payment.paired_internal_transfer_payment_id = paired_payment

            body = _('This payment has been created from <a href=# data-oe-model=account.payment data-oe-id=%d>%s</a>') % (payment.id, payment.name)
            paired_payment.message_post(body=body)
            body = _('A second payment has been created: <a href=# data-oe-model=account.payment data-oe-id=%d>%s</a>') % (paired_payment.id, paired_payment.name)
            payment.message_post(body=body)

            lines = (payment.move_id.line_ids + paired_payment.move_id.line_ids).filtered(
                lambda l: l.account_id == payment.destination_account_id and not l.reconciled)
            lines.reconcile()