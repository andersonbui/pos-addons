odoo.define("pos_invoices_credit.screens", function (require) {
    "use strict";

    var core = require("web.core");
    var gui = require("point_of_sale.gui");
    var models = require("point_of_sale.models");
    // var PosDb = require("point_of_sale.DB");
    // var utils = require("web.utils");
    // var rpc = require("web.rpc");
    // var chrome = require("point_of_sale.chrome");
    // var field_utils = require('web.field_utils');

    // var QWeb = core.qweb;
    var _t = core._t;
    // var round_pr = utils.round_precision;


    models.load_models({
        model: "pos.payment.method",
        fields: [
            'split_transactions', 'type'
        ],
    });

    var _super_order = models.Order.prototype;
    models.Paymentline = models.Paymentline.extend({
        /**
         * Check if paymentline is done.
         * Paymentline is done if there is no payment status or the payment status is done.
         */
        is_done: function() {
            return this.get_payment_status() ? this.get_payment_status() === 'done' || this.get_payment_status() === 'reversed': true;
        },
    });
});
