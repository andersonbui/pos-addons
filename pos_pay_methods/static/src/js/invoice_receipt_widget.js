//  Copyright 2021 Ingenioso <https://github.com/ingenioso-sas/>

//  License MIT (https://opensource.org/licenses/MIT).
/* eslint no-useless-escape: "off"*/
odoo.define("pos_invoices", function (require) {
    "use strict";

    var core = require("web.core");
    var screens = require("point_of_sale.screens");

    var _t = core._t;

    var InvoiceReceiptScreenWidget = screens.ReceiptScreenWidget.extend({
        template: "InvoiceReceiptScreenWidget",
        render_invoice_ticket: function () {
            var order = this.pos.get_order();
            return QWeb.render("PosInvoiceTicket", {
                widget: this,
                order: order,
                receipt: order.export_for_printing(),
                orderlines: order.get_orderlines(),
                paymentlines: order.get_paymentlines(),
            });
        },
        render_invoice_receipt: function () {
            var order = this.pos.get_order();
            return QWeb.render("PosInvoiceReceipt", {
                widget: this,
                order: order,
                receipt: order.export_for_printing(),
                orderlines: order.get_orderlines(),
                paymentlines: order.get_paymentlines(),
            });
        },
        render_receipt: function () {
            var order = this.pos.get_order();
            if (order.invoice_to_pay) {
                var receipt = this.render_invoice_ticket();
                this.$(".pos-receipt-container").html(receipt);
            } else {
                this._super();
            }
        },
        print_xml: function () {
            var order = this.pos.get_order();
            if (order.invoice_to_pay) {
                var receipt = this.render_invoice_receipt();
                this.pos.proxy.print_receipt(receipt);
                order._printed = true;
            } else {
                this._super();
            }
        },
        render_change: function () {
            var order = this.pos.get_order();
            this.$(".change-value").html(
                this.format_currency(order.invoice_to_pay.get_change())
            );
        },
        click_next: function () {
            this.gui.show_screen("products");
            this._super();
        },
    });

    gui.define_screen({name: "invoice_receipt", widget: InvoiceReceiptScreenWidget});
})