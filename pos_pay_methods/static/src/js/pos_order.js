//  Copyright 2021 Ingenioso <https://github.com/ingenioso-sas/>

//  License MIT (https://opensource.org/licenses/MIT).
/* eslint no-useless-escape: "off"*/
odoo.define("pos_invoices", function (require) {
    "use strict";

    var core = require("web.core");
    var models = require("point_of_sale.models");

    var _t = core._t;

    var _super_order = models.Order.prototype;
    models.Order = models.Order.extend({
        export_as_JSON: function () {
            if (this.pos.add_itp_data && this.invoice_to_pay) {
                var data = _super_order.export_as_JSON.apply(this, arguments);
                data.invoice_to_pay = this.invoice_to_pay;
                if( this.invoice_to_pay ){
                    // Si es un pago parcial, asignar factura ya existente
                    data.to_invoice = true;
                    data.account_move = this.invoice_to_pay.id;
                    data.state = 'invoiced';
                    data.amount_total = data.amount_return;
                    data.amount_paid = data.amount_return;
                    data.amount_return = 0;
                    data.partner_id = this.invoice_to_pay.partner_id[0];
                }
                return data;
            }
            return _super_order.export_as_JSON.call(this, arguments);
        },

        add_paymentline: function (payment_method, mode) {
            if (!mode) {
                return _super_order.add_paymentline.call(this, payment_method);
            }
            this.assert_editable();
            var newPaymentline = new models.Paymentline(
                {},
                {order: this, payment_method: payment_method, pos: this.pos}
            );
            if (payment_method.is_cash_count || this.pos.config.iface_precompute_cash) {
                newPaymentline.set_amount(Math.max(this.invoice_to_pay.get_due(), 0));
            }
            this.paymentlines.add(newPaymentline);
            this.select_paymentline(newPaymentline);
        },
    });

})