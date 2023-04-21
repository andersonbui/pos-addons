//  Copyright 2021 Ingenioso <https://github.com/ingenioso-sas/>

//  License MIT (https://opensource.org/licenses/MIT).
/* eslint no-useless-escape: "off"*/
odoo.define("pos_invoices", function (require) {
    "use strict";

    var core = require("web.core");
    var screens = require("point_of_sale.screens");

    var _t = core._t;

    
    var InvoicePayment = screens.PaymentScreenWidget.extend({
        template: "InvoicePaymentScreenWidget",
        get_invoice_residual: function () {
            if (this.pos.selected_invoice) {
                return round_pr(
                    this.pos.selected_invoice.amount_residual,
                    this.pos.currency.rounding
                );
            }
            return 0;
        },

        finalize_validation: function () {
            var invoices = [];
            var self = this,
                order = this.pos.get_order();
            order.invoice_to_pay = this.pos.selected_invoice;
            invoices = order.pos.invoices;
            order.invoices = [];

            for (let i = 0; i < invoices.length; i++){                
                if(invoices[i].invoice_origin == order.invoice_to_pay.invoice_origin){
                    order.invoices = invoices[i];
                }                
            };

            self.pos.start_invoice_processing();
            if (order.is_paid_with_cash() && this.pos.config.iface_cashdrawer) {
                this.pos.proxy.open_cashbox();
            }
            order.initialize_validation_date();
            if (order.is_to_invoice() ) {
                this.pos.push_order(order).then(function () {
                    self.pos.update_or_fetch_invoice(self.pos.selected_invoice.id);
                    self.gui.show_screen("invoice_receipt");
                    rpc.query({
                        model: "account.move",
                        method: "invoice_print",
                        args: [order.invoice_to_pay.id],
                    }).then(function (action) {
                        self.chrome.do_action(action);
                        self.pos.stop_invoice_processing();
                    });
                });
            } else {
                this.pos.push_order(order).then(function (res) {
                    self.pos.update_or_fetch_invoice(self.pos.selected_invoice.id);
                    self.gui.show_screen("invoice_receipt");
                    self.pos.stop_invoice_processing();
                });
            }
        },

        validate_order: function (force_validation) {
            var order = this.pos.get_order();
            order.invoice_to_pay = this.pos.selected_invoice
            if (
                !this.pos.config.pos_invoice_pay_writeoff_account_id &&
                order.invoice_to_pay &&
                order.get_total_paid() > this.get_invoice_residual()
            ) {
                this.gui.show_popup("error", {
                    title: _t("Excessive payment amount."),
                    body: _t(
                        "You can not validate the order with a change because difference account is not set. Please enter the exact payment amount."
                    ),
                });
                return;
            }
            var paymentlines = order.get_paymentlines()
            var splitPayments = paymentlines.filter(payment => payment.payment_method.split_transactions)

            if ( splitPayments.length ) {
                var title = _t('Please select the diferent Pyment Method');
                var description = _t('Para realizar pagos usted necesita seleccionar un metodo de pago que NO sea de Credito.');
                this.gui.show_popup('error', {
                    'title': title,
                    'body': description
                });
                return false;
            }
            this._super();
        },

        order_is_valid: function () {
            var order = this.pos.get_order(),
                plines = order.get_paymentlines(),
                i = 0;
            if (plines.length === 0) {
                this.gui.show_popup("error", {
                    title: _t("Zero payment amount."),
                    body: _t(
                        "You can not validate the order with zero payment amount."
                    ),
                });
                return false;
            }
            for (i = 0; i < plines.length; i++) {
                if (plines[i].get_amount() <= 0) {
                    this.gui.show_popup("error", {
                        title: _t("Wrong payment amount."),
                        body: _t("You can only create positive payments."),
                    });
                    return false;
                }
            }
            return true;
        },
        get_type: function () {
            return this.gui.get_current_screen_param("type");
        },
        show: function () {
            this._super();
            if (this.pos.config.module_account) {
                var order = this.pos.get_order();
                if (!order.is_to_invoice() && this.get_type() === "orders") {
                    this.click_invoice();
                } else if (order.is_to_invoice() && this.get_type() === "invoices") {
                    this.click_invoice();
                }
            }
        },
    });

    gui.define_screen({name: "invoice_payment", widget: InvoicePayment});
    
})