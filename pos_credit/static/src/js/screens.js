odoo.define('point_of_sale_screens', function (require) {
    "use strict";

    var core = require('web.core');
    var utils = require('web.utils');

    var _t = core._t;

    var PaymentScreenWidget = ScreenWidget.extend({
        template: 'PaymentScreenWidget',
        back_screen: 'product',

        order_is_valid: function (force_validation) {
            var self = this;
            var order = this.pos.get_order();
            var paymentlines = order.get_paymentlines()
            var splitPayments = paymentlines.filter(payment => payment.payment_method.split_transactions)

            // FIXME: this check is there because the backend is unable to
            // process empty orders. This is not the right place to fix it.
            if (order.get_orderlines().length === 0 && order.is_to_invoice()) {
                this.gui.show_popup('error', {
                    'title': _t('Empty Order'),
                    'body': _t('There must be at least one product in your order before it can be validated'),
                });
                return false;
            }
            if ((order.is_to_invoice() || splitPayments.length) && !order.get_client()) {
                var title = _t('Please select the Customer');
                var description = _t('You need to select the customer before you can invoice an order.');
                if (splitPayments.length) {
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
            if (forcevalid === 'Confirm Large Amount' && totalwithtax > 0 && (totalwithtax * 250 < order.get_total_paid())) {
                this.gui.show_popup('confirm', {
                    title: _t('Please Confirm Large Amount'),
                    body: _t('Are you sure that the customer wants to  pay') +
                        ' ' +
                        this.format_currency(order.get_total_paid()) +
                        ' ' +
                        _t('for an order of') +
                        ' ' +
                        this.format_currency(totalwithtax) +
                        ' ' +
                        _t('? Clicking "Confirm" will validate the payment.'),
                    confirm: function () {
                        self.validate_order('Confirm Large Amount');
                    },
                });
                return false;
            }

            if (!order.is_paid() || this.invoicing) {
                return false;
            }

            // The exact amount must be paid if there is no cash payment method defined.
            if (Math.abs(order.get_total_balance()) > 0.00001) {
                var cash = false;
                for (var i = 0; i < this.pos.payment_methods.length; i++) {
                    cash = cash || (this.pos.payment_methods[i].is_cash_count);
                }
                if (!cash) {
                    this.gui.show_popup('error', {
                        title: _t('Cannot return change without a cash payment method'),
                        body: _t('There is no cash payment method available in this point of sale to handle the change.\n\n Please pay the exact amount or add a cash payment method in the point of sale configuration'),
                    });
                    return false;
                }
            }

            var client = order.get_client();
            if (order.is_to_email() && (!client || client && !utils.is_email(client.email))) {
                var title = !client
                    ? _t('Please select the customer')
                    : _t('Please provide valid email');
                var body = !client
                    ? _t('You need to select the customer before you can send the receipt via email.')
                    : _t('This customer does not have a valid email address, define one or do not send an email.');
                this.gui.show_popup('confirm', {
                    'title': title,
                    'body': body,
                    confirm: function () {
                        this.gui.show_screen('clientlist');
                    },
                });
                return false;
            }

            // if the change is too large, it's probably an input error, make the user confirm.
            if (!force_validation && order.get_total_with_tax() > 0 && (order.get_total_with_tax() * 1000 < order.get_total_paid())) {
                this.gui.show_popup('confirm', {
                    title: _t('Please Confirm Large Amount'),
                    body: _t('Are you sure that the customer wants to  pay') +
                        ' ' +
                        this.format_currency(order.get_total_paid()) +
                        ' ' +
                        _t('for an order of') +
                        ' ' +
                        this.format_currency(order.get_total_with_tax()) +
                        ' ' +
                        _t('? Clicking "Confirm" will validate the payment.'),
                    confirm: function () {
                        self.validate_order('confirm');
                    },
                });
                return false;
            }
            return true;
        },

        finalize_validation: function () {
            var self = this;
            var order = this.pos.get_order();
            // definir facturacion automaticamente para creditos
            var paymentlines = order.get_paymentlines()
            var splitPayments = paymentlines.filter(payment => payment.payment_method.split_transactions)

            if (splitPayments.length) {
                // facturar aquellas ventas que son a credito
                order.set_to_invoice(true);
            }

            if ((order.is_paid_with_cash() || order.get_change()) && this.pos.config.iface_cashdrawer) {
                this.pos.proxy.printer.open_cashbox();
            }

            order.initialize_validation_date();
            order.finalized = true;

            if (order.is_to_invoice()) {
                var invoiced = this.pos.push_and_invoice_order(order);
                this.invoicing = true;

                invoiced.catch(this._handleFailedPushForInvoice.bind(this, order, false));

                invoiced.then(function (server_ids) {
                    self.invoicing = false;
                    var post_push_promise = [];
                    post_push_promise = self.post_push_order_resolve(order, server_ids);
                    post_push_promise.then(function () {
                        self.gui.show_screen('receipt');
                    }).catch(function (error) {
                        self.gui.show_screen('receipt');
                        if (error) {
                            self.gui.show_popup('error', {
                                'title': "Error: no internet connection",
                                'body': error,
                            });
                        }
                    });
                });
            } else {
                var ordered = this.pos.push_order(order);
                if (order.wait_for_push_order()) {
                    var server_ids = [];
                    ordered.then(function (ids) {
                        server_ids = ids;
                    }).finally(function () {
                        var post_push_promise = [];
                        post_push_promise = self.post_push_order_resolve(order, server_ids);
                        post_push_promise.then(function () {
                            self.gui.show_screen('receipt');
                        }).catch(function (error) {
                            self.gui.show_screen('receipt');
                            if (error) {
                                self.gui.show_popup('error', {
                                    'title': "Error: no internet connection",
                                    'body': error,
                                });
                            }
                        });
                    });
                }
                else {
                    self.gui.show_screen('receipt');
                }

            }
        },

        validate_order: function (force_validation) {
            if (this.order_is_valid(force_validation)) {
                var order = this.pos.get_order();
                var paymentlines = order.get_paymentlines()
                for (let line of paymentlines) {
                    if (!line.is_done()) order.remove_paymentline(line);
                }
                this.finalize_validation();
            }
            if (this.pos.config.cash_rounding) {
                // TODO: hacer algo aqui
            }
            // return this._super();
        },

    });

    return {
        PaymentScreenWidget: PaymentScreenWidget,
  
    };

});