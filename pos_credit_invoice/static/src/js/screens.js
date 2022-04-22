//  Copyright 2021 Anderson Buitron <https://github.com/andersonbui/>

//  License MIT (https://opensource.org/licenses/MIT).
/* eslint no-useless-escape: "off"*/
odoo.define("pos_invoices_credit.screens", function (require) {
    "use strict";

    var core = require("web.core");
    var gui = require("point_of_sale.gui");
    // var models = require("point_of_sale.models");
    // var PosDb = require("point_of_sale.DB");
    // var utils = require("web.utils");
    var screens = require("point_of_sale.screens");
    // var rpc = require("web.rpc");
    // var chrome = require("point_of_sale.chrome");
    // var field_utils = require('web.field_utils');

    // var QWeb = core.qweb;
    var _t = core._t;
    // var round_pr = utils.round_precision;



    var InvoicePayment = screens.PaymentScreenWidget.extend({

        order_is_valid: function (force_validation) {
            var order = this.pos.get_order();
            var paymentlines = order.get_paymentlines()
            var splitPayments = paymentlines.filter(payment => payment.payment_method.split_transactions)

            if (order.get_orderlines().length === 0 && order.is_to_invoice()) {
                this.gui.show_popup('error', {
                    'title': _t('Empty Order'),
                    'body':  _t('There must be at least one product in your order before it can be validated and invoiced'),
                });
                return false;
            }
            if ((order.is_to_invoice() || splitPayments.length ) && !order.get_client()) {
                var title = _t('Please select the Customer');
                var description = _t('You need to select the customer before you can invoice an order.');
                if(splitPayments.length ){
                    var paymentMethod = splitPayments[0].payment_method
                    description = _.str.sprintf(_t('Se requiere al cliente para el metodo de pago: %s.'), paymentMethod.name)
                }
                this.gui.show_popup('confirm', {
                    'title': title,
                    'body': description,
                    confirm: function () {
                        this.gui.show_screen('clientlist');
                    },
                });
                return false;
            }
            var forcevalid = force_validation
            var totalwithtax = order.get_total_with_tax()
            // if the change is too large, it's probably an input error, make the user confirm.
            if ( forcevalid === 'Confirm Large Amount' && totalwithtax > 0 && (totalwithtax * 250 < order.get_total_paid())) {
                this.gui.show_popup('confirm',{
                    title: _t('Please Confirm Large Amount'),
                    body:  _t('Are you sure that the customer wants to  pay') + 
                           ' ' + 
                           this.format_currency(order.get_total_paid()) +
                           ' ' +
                           _t('for an order of') +
                           ' ' +
                           this.format_currency(totalwithtax) +
                           ' ' +
                           _t('? Clicking "Confirm" will validate the payment.'),
                    confirm: function() {
                        self.validate_order('Confirm Large Amount');
                    },
                });
                return false;
            }
            return this._super();
        },
        finalize_validation: function() {
            var self = this;
            var order = this.pos.get_order();
    
            // definir facturacion automaticamente para creditos
            var paymentlines = order.get_paymentlines()
            var splitPayments = paymentlines.filter(payment => payment.payment_method.split_transactions)
            if(splitPayments.length){
                // facturar aquellas ventas que son a credito
                order.set_to_invoice(true);
            }
            return this._super();
        },
        validate_order: function(force_validation) {
            if (this.order_is_valid(force_validation)) {
                var order = this.pos.get_order();
                var paymentlines = order.get_paymentlines()
                for (let line of paymentlines) {
                    if (!line.is_done()) order.remove_paymentline(line);
                }
                this.finalize_validation();
            }
            if(this.pos.config.cash_rounding){
                // TODO: hacer algo aqui
            }
            // return this._super();
        },
    });

    gui.define_screen({name: "payment", widget: InvoicePayment});

});
