/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";

patch(PaymentScreen.prototype, {

    async validateOrder(isForceValidate) {
        await super.validateOrder(isForceValidate,...arguments);
    },

    async _finalizeValidation() {

        const splitPayments = this.paymentLines.filter(
            (payment) => payment.payment_method.split_transactions
        );
        // definir facturacion automaticamente para creditos
        if (splitPayments.length) {
            // facturar aquellas ventas que son a credito
            this.currentOrder.set_to_invoice(true);
        }
        await super._finalizeValidation(...arguments);
    }
})

