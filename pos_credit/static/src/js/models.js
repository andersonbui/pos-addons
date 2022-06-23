odoo.define('point_of_sale_models', function(require){
    "use strict";
    //var pos_models = require('point_of_sale.models');
    //exports.PosModel = Backbone.Model.extend({
    var models = require('point_of_sale_models');
    models.PosModels = models.PosModels.extend({

        models: [
            {
                model:  'pos.payment.method',
                fields: ['name', 'is_cash_count', 'use_payment_terminal','split_transactions', 'type'],
                domain: function(self, tmp) {
                    return [['id', 'in', tmp.payment_method_ids]];
                },
                loaded: function(self, payment_methods) {
                    self.payment_methods = payment_methods.sort(function(a,b){
                        // prefer cash payment_method to be first in the list
                        if (a.is_cash_count && !b.is_cash_count) {
                            return -1;
                        } else if (!a.is_cash_count && b.is_cash_count) {
                            return 1;
                        } else {
                            return a.id - b.id;
                        }
                    });
                    self.payment_methods_by_id = {};
                    _.each(self.payment_methods, function(payment_method) {
                        self.payment_methods_by_id[payment_method.id] = payment_method;
            
                        var PaymentInterface = self.electronic_payment_interfaces[payment_method.use_payment_terminal];
                        if (PaymentInterface) {
                            payment_method.payment_terminal = new PaymentInterface(self, payment_method);
                        }
                    });
                }
            }
        ]
    });


// Every Paymentline contains a cashregister and an amount of money.
    exports.Paymentline = Paymentline.Model.extend({
        /**
     * Check if paymentline is done.
     * Paymentline is done if there is no payment status or the payment status is done.
     */
        is_done: function() {
            return this.get_payment_status() ? this.get_payment_status() === 'done' || this.get_payment_status() === 'reversed': true;
        },
    });
});