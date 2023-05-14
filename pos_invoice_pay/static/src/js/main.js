//  Copyright 2018 Artyom Losev
//  Copyright 2018 Dinar Gabbasov <https://it-projects.info/team/GabbasovDinar>
//  Copyright 2018 Kolushov Alexandr <https://it-projects.info/team/KolushovAlexandr>
//  Copyright 2021 Anderson Buitron <https://github.com/andersonbui/>
//  Copyright 2021 Ilya Ilchenko <https://github.com/mentalko>

//  License MIT (https://opensource.org/licenses/MIT).
/* eslint no-useless-escape: "off"*/
odoo.define("pos_invoices", function (require) {
    "use strict";

    var core = require("web.core");
    var gui = require("point_of_sale.gui");
    var models = require("point_of_sale.models");
    var PosDb = require("point_of_sale.DB");
    var utils = require("web.utils");
    var screens = require("point_of_sale.screens");
    var rpc = require("web.rpc");
    var chrome = require("point_of_sale.chrome");
    var field_utils = require('web.field_utils');

    var QWeb = core.qweb;
    var _t = core._t;
    var round_pr = utils.round_precision;

    chrome.Chrome.include({
        build_widgets: function () {
            this._super();
            // For compatibility with https://www.odoo.com/apps/modules/12.0/pos_mobile/
            if (odoo.is_mobile) {
                var payment_method = $(
                    ".invoice-payment-screen .paymentmethods-container"
                );
                payment_method.detach();
                $(".invoice-payment-screen .paymentlines-container").after(
                    payment_method
                );

                $(".invoice-payment-screen .touch-scrollable").niceScroll();
            }
        },
    });

    models.load_models({
        model: "sale.order",
        fields: [
            "id",
            "name",
            "partner_id",
            "date_order",
            "user_id",
            "amount_total",
            "order_line",
            "invoice_status",
        ],
        domain: [
            // ["invoice_status", "=", "to invoice"],                              
            ["state", "=", "sale"],            
        ],
        loaded: function (self, sale_orders) {
            var so_ids = _.pluck(sale_orders, "id");
            self.prepare_so_data(sale_orders);
            self.sale_orders = sale_orders;
            self.db.add_sale_orders(sale_orders);
            self.get_sale_order_lines(so_ids);
        },
    });

    models.load_models({
        model:  'product.product',
        fields: ['display_name', 'lst_price', 'standard_price', 'categ_id', 'pos_categ_id', 'taxes_id',
                 'barcode', 'default_code', 'to_weight', 'uom_id', 'description_sale', 'description',
                 'product_tmpl_id','tracking'],
        order:  _.map(['sequence','default_code','name'], function (name) { return {name: name}; }),
        domain: function(self){
            var domain = ['&', '&', ['sale_ok','=',true],['available_in_pos','=',false],'|',['company_id','=',self.config.company_id[0]],['company_id','=',false]];
            if (self.config.limit_categories &&  self.config.iface_available_categ_ids.length) {
                domain.unshift('&');
                domain.push(['pos_categ_id', 'in', self.config.iface_available_categ_ids]);
            }
            if (self.config.iface_tipproduct){
              domain.unshift(['id', '=', self.config.tip_product_id[0]]);
              domain.unshift('|');
            }
            return domain;
        },
        context: function(self){ return { display_default_code: false }; },
        loaded: function(self, products){
            var using_company_currency = self.config.currency_id[0] === self.company.currency_id[0];
            var conversion_rate = self.currency.rate / self.company_currency.rate;
            var lista_obj_products=_.map(products, function (product) {
                if (!using_company_currency) {
                    product.lst_price = round_pr(product.lst_price * conversion_rate, self.currency.rounding);
                }
                product.categ = _.findWhere(self.product_categories, {'id': product.categ_id[0]});
                product.pos = self;
                return new models.Product({}, product);
            });
            self.db.products_no_availables = lista_obj_products
            self.db.products_no_availables_by_id = {}
            
            for(var i = 0, len = lista_obj_products.length; i < len; i++){
                var product = lista_obj_products[i]; 
                self.db.products_no_availables_by_id[product.id] = product;
            }
        },

    });
    models.load_models({
        model: "account.move",
        fields: [
            "name",
            "partner_id",
            "invoice_date",
            "invoice_date_due",
            "invoice_origin",
            "amount_total",
            "invoice_user_id",
            "amount_residual",
            "invoice_payment_state",
            "amount_untaxed",
            "amount_tax",
            "state",
            "type",
        ],
        domain: [
            ["invoice_payment_state", "=", "not_paid"],            
            ["state", "=", "posted"],
            ["type", "=", "out_invoice"],
        ],
        loaded: function (self, invoices) {
            _.each(invoices, function (invoice) {
                invoice.user_id = invoice.invoice_user_id;
            });

            var invoices_ids = _.pluck(invoices, "id");
            self.prepare_invoices_data(invoices);
            self.invoices = invoices;
            self.db.add_invoices(invoices);
            self.get_invoice_lines(invoices_ids);
        },
    });

    var _super_posmodel = models.PosModel.prototype;
    models.PosModel = models.PosModel.extend({
        initialize: function (session, attributes) {
            _super_posmodel.initialize.apply(this, arguments);
            this.bus.add_channel_callback(
                "pos_sale_orders",
                this.on_notification,
                this
            );
            this.bus.add_channel_callback("pos_invoices", this.on_notification, this);
        },

        fetch_lines: function (data, model_name, method_name, fields) {
            return rpc.query({
                model: model_name,
                method: method_name,
                domain: data,
                fields: fields,
            });
        },

        get_sale_order_lines: function (ids) {
            var self = this;
            return this.fetch_lines([["order_id", "in", ids]], "sale.order.line", "search_read", [
                "id",
                "name",
                "order_id",
                "invoice_status",
                "product_id",
                "product_uom_qty",
                "qty_delivered",
                "qty_invoiced",
                "tax_id",
                "discount",
                "price_unit",
                "price_subtotal",
                "price_total",
            ]).then(function (lines) {
                _.each(lines, function (l) {              
                    var so = self.db.sale_orders_by_id[l.order_id[0]];
                    if (!so) {
                        return;
                    }
                    self.db.sale_orders_by_id[l.order_id[0]].lines = so.lines || {};
                    self.db.sale_orders_by_id[l.order_id[0]].lines[l.id] = l;
                });
            });
        },

        get_invoice_lines: function (data) {
            var self = this;
            data = data || [];
            return this.fetch_lines(
                [["move_id", "in", data]],
                "account.move.line",
                "search_read",
                [
                    "id",
                    "move_id",
                    "name",
                    "account_id",
                    "product_id",
                    "price_unit",
                    "quantity",
                    "tax_ids",
                    "discount",
                    "amount_currency",
                ]
            ).then(function (lines) {
                _.each(lines, function (l) {
                    var invoice = self.db.invoices_by_id[l.move_id[0]];
                    if (!invoice) {
                        return;
                    }
                    invoice.lines = invoice.lines || {};
                    invoice.lines[l.id] = l;
                });
            });
        },

        on_notification: function (notification) {
            var invoices_to_update = [];
            var sale_orders_to_update = [];
            var channel = notification.channel;
            var message = notification.id;
            if (channel === "pos_invoices") {
                invoices_to_update.push(message);
            }
            if (channel === "pos_sale_orders") {
                sale_orders_to_update.push(message);
            }
            if (invoices_to_update.length > 0) {
                this.update_invoices_from_poll(_.unique(invoices_to_update));
            }
            if (sale_orders_to_update.length > 0) {
                this.update_sale_orders_from_poll(_.unique(sale_orders_to_update));
            }
        },

        update_invoices_from_poll: function (ids) {
            var self = this;
            _.each(ids, function (id) {
                self.update_or_fetch_invoice(id).then(function () {
                    var current_screen = self.gui.current_screen;
                    if (current_screen.invoice_screen) {
                        current_screen.show();
                    }
                });
            });
        },

        update_sale_orders_from_poll: function (ids) {
            var self = this;
            _.each(ids, function (id) {
                self.update_or_fetch_sale_order(id).then(function () {
                    self.gui.current_screen.show();
                });
            });
        },

        prepare_invoices_data: function (data) {
            _.each(data, function (item) {
                for (var property in item) {
                    if (Object.prototype.hasOwnProperty.call(item, property)) {
                        if (item[property] === false) {
                            item[property] = " ";
                        }
                    }
                }
            });
        },

        prepare_so_data: function (data) {
            _.each(data, function (item) {
                switch (item.invoice_status) {
                    case "to invoice":
                        item.invoice_status = "To invoice";
                        break;
                    case "no":
                        item.invoice_status = "Nothing to invoice";
                        break;
                }
            });
        },

        get_res: function (model_name, id) {
            var fields = _.find(this.models, function (model) {
                    return model.model === model_name;
                }).fields,
                domain = [["id", "=", id]];
            return rpc.query({
                model: model_name,
                method: "search_read",
                args: [domain, fields],
            });
        },

        update_or_fetch_invoice: function (id) {
            var self = this,
                def = $.Deferred();
            this.get_res("account.move", id).then(function (res) {
                self.prepare_invoices_data(res);
                self.db.update_invoice_db(res[0]);
                self.get_invoice_lines([res[0].id]).then(function () {
                    def.resolve(id);
                });
            });
            return def.promise();
        },

        update_or_fetch_sale_order: function (id) {
            var def = $.Deferred(),
                self = this;
            this.get_res("sale.order", id).then(function (res) {
                self.prepare_so_data(res);
                self.db.update_so_db(res[0]);
                self.get_sale_order_lines([res[0].id]).then(function () {
                    def.resolve(id);
                });
            });
            return def.promise();
        },

        validate_invoice: function (id) {
            return rpc.query({
                model: "account.move",
                method: "action_invoice_open",
                args: [id],
            });
        },

        get_invoices_to_render: function (invoices) {
            var muted_invoices_ids = [],
                order = {},
                id = 0,
                i = 0,
                client = this.get_client(),
                orders_to_mute = _.filter(this.db.get_orders(), function (mtd_order) {
                    return mtd_order.data.invoice_to_pay;
                });
            if (orders_to_mute) {
                for (i = 0; orders_to_mute.length > i; i++) {
                    order = orders_to_mute[i];
                    id = order.data.invoice_to_pay.id;
                    muted_invoices_ids.push(id);
                }
            }
            if (muted_invoices_ids && muted_invoices_ids.length) {
                invoices = _.filter(invoices, function (inv) {
                    return !_.contains(muted_invoices_ids, inv.id);
                });
            }
            if (client) {
                invoices = _.filter(invoices, function (inv) {
                    return inv.partner_id[0] === client.id;
                });
                return invoices;
            }
            invoices = _.filter(invoices, function (inv) {
                return (
                    inv.state === "posted" && inv.invoice_payment_state === "not_paid"
                );
            });
            return invoices;
        },

        get_sale_order_to_render: function (sale_orders) {
            var client = this.get_client();
            if (client) {
                sale_orders = _.filter(sale_orders, function (so) {
                    return so.partner_id[0] === client.id;
                });
                return sale_orders;
            }
            return sale_orders;
        },

        start_invoice_processing: function () {
            this.add_itp_data = true;
        },

        stop_invoice_processing: function () {
            this.add_itp_data = false;
            // Remove order paymentlines
            var order = this.get_order();
            var lines = order.get_paymentlines();
            for (var i = 0; i < lines.length; i++) {
                order.remove_paymentline(lines[i]);
            }
        },
    });

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

    PosDb.include({
        init: function (options) {
            this._super(options);
            this.sale_orders = [];
            this.sale_orders_by_id = {};
            this.sale_orders_search_string = "";
            this.invoices = [];
            this.invoices_by_id = {};
            this.invoices_search_string = "";
        },

        add_sale_orders: function (sale_orders) {
            var self = this;
            _.each(sale_orders, function (order) {
                self.sale_orders.push(order);
                self.sale_orders_by_id[order.id] = order;
                self.sale_orders_search_string += self._sale_order_search_string(order);
            });
        },

        update_so_search_string: function (sale_orders) {
            var self = this;
            self.sale_orders_search_string = "";
            _.each(sale_orders, function (order) {
                self.sale_orders_search_string += self._sale_order_search_string(order);
            });
        },

        update_invoices_search_string: function (invoices) {
            var self = this;
            self.invoices_search_string = "";
            _.each(invoices, function (inv) {
                self.invoices_search_string += self._invoice_search_string(inv);
            });
        },

        _sale_order_search_string: function (sale_order) {
            var str = sale_order.name;
            if (sale_order.date_order) {
                str += "|" + sale_order.date_order;
            }
            if (sale_order.partner_id[1]) {
                str += "|" + sale_order.partner_id[1];
            }
            if (sale_order.user_id[1]) {
                str += "|" + sale_order.user_id[1];
            }
            if (sale_order.amount_total) {
                str += "|" + sale_order.amount_total;
            }

            str = String(sale_order.id) + ":" + str.replace(":", "") + "\n";
            return str;
        },

        search_sale_orders: function (query) {
            try {
                query = query.replace(
                    /[\[\]\(\)\+\*\?\.\-\!\&\^\$\|\~\_\{\}\:\,\\\/]/g,
                    "."
                );
                query = query.replace(/ /g, ".+");
                var re = RegExp("([0-9]+):.*?" + query, "gi");
            } catch (e) {
                return [];
            }
            var results = [];
            for (var i = 0; i < this.limit; i++) {
                var r = re.exec(this.sale_orders_search_string);
                if (r) {
                    var id = Number(r[1]);
                    results.push(this.get_sale_order_by_id(id));
                } else {
                    break;
                }
            }
            return results.filter(function (res) {
                return typeof res === "object";
            });
        },

        get_sale_order_by_id: function (id) {
            return this.sale_orders_by_id[id];
        },

        update_so_db: function (updated_so) {
            for (var i = 0; i < this.sale_orders.length; i++) {
                if (this.sale_orders[i].id === updated_so.id) {
                    this.sale_orders.splice(i, 1);
                    break;
                }
            }
            delete this.sale_orders_by_id[updated_so.id];
            if (updated_so.invoice_status === "To invoice") {
                this.sale_orders.unshift(updated_so);
                this.sale_orders_by_id[updated_so.id] = updated_so;
            }
            this.update_so_search_string(this.sale_orders);
        },

        add_invoices: function (invoices) {
            var self = this;
            _.each(invoices, function (invoice) {
                self.invoices.push(invoice);
                self.invoices_by_id[invoice.id] = invoice;
                self.invoices_search_string += self._invoice_search_string(invoice);
            });
        },

        update_invoice_db: function (updated_invoice) {
            if(!updated_invoice) {
                return;
            }
            for (var i = 0; i < this.invoices.length; i++) {
                if (this.invoices[i].id === updated_invoice.id) {
                    this.invoices.splice(i, 1);
                    break;
                }
            }
            if (
                updated_invoice.state === "draft" ||
                updated_invoice.state === "posted"
            ) {
                this.invoices.unshift(updated_invoice);
                this.invoices_by_id[updated_invoice.id] = updated_invoice;
            } else {
                delete this.invoices_by_id[updated_invoice.id];
            }
            this.update_invoices_search_string(this.invoices);
        },

        _invoice_search_string: function (invoice) {
            var str = invoice.partner_id[1];
            if (invoice.name) {
                str += "|" + invoice.name;
            }
            if (invoice.invoice_date) {
                str += "|" + invoice.invoice_date;
            }
            if (invoice.invoice_date_due) {
                str += "|" + invoice.invoice_date_due;
            }
            if (invoice.invoice_user_id[1]) {
                str += "|" + invoice.invoice_user_id[1];
            }
            if (invoice.amount_total) {
                str += "|" + invoice.amount_total;
            }
            str = String(invoice.id) + ":" + str.replace(":", "") + "\n";
            return str;
        },

        search_invoices: function (query) {
            try {
                query = query.replace(
                    /[\[\]\(\)\+\*\?\.\-\!\&\^\$\|\~\_\{\}\:\,\\\/]/g,
                    "."
                );
                query = query.replace(/ /g, ".+");
                var re = RegExp("([0-9]+):.*?" + query, "gi");
            } catch (e) {
                return [];
            }
            var results = [];
            for (var i = 0; i < this.limit; i++) {
                var r = re.exec(this.invoices_search_string);
                if (r) {
                    var id = Number(r[1]);
                    results.push(this.get_invoice_by_id(id));
                } else {
                    break;
                }
            }
            return results.filter(function (res) {
                return typeof res === "object";
            });
        },

        get_invoice_by_id: function (id) {
            return this.invoices_by_id[id];
        },
    });

    var InvoicesButton = screens.ActionButtonWidget.extend({
        template: "InvoicesButton",
        button_click: function () {
            if (!this.pos.config.invoice_cashier_selection) {
                this.gui.show_screen("invoices_list");
                return;
            }
            var self = this;
            self.gui
                .select_user({
                    security: true,
                    current_user: self.pos.get_cashier(),
                    title: _t("Change Cashier"),
                })
                .then(function (user) {
                    self.pos.set_cashier(user);
                    self.gui.chrome.widget.username.renderElement();
                    self.gui.show_screen("invoices_list");
                });
        },
    });

    screens.define_action_button({
        name: "invoices_button",
        widget: InvoicesButton,
        condition: function () {
            return this.pos.config.show_invoices;
        },
    });

    var SaleOrdersButton = screens.ActionButtonWidget.extend({
        template: "SaleOrdersButton",
        button_click: function () {
            if (!this.pos.config.sale_order_cashier_selection) {
                this.gui.show_screen("sale_orders_list");
                return;
            }
            var self = this;
            self.gui
                .select_user({
                    security: true,
                    current_user: self.pos.get_cashier(),
                    title: _t("Change Cashier"),
                })
                .then(function (user) {
                    self.pos.set_cashier(user);
                    self.gui.chrome.widget.username.renderElement();
                    self.gui.show_screen("sale_orders_list");
                });
        },
    });

    screens.define_action_button({
        name: "so_button",
        widget: SaleOrdersButton,
        condition: function () {
            return this.pos.config.show_sale_orders;
        },
    });
    var InvoicesAndOrdersBaseWidget = screens.ScreenWidget.extend({
        show: function () {
            var self = this;
            this._super();
            this.renderElement();

            this.$(".next").click(function (e) {
                e.preventDefault();
                self.click_next(e);
            });

            this.render_data(this.get_data());

            this.$(".list-contents").delegate(this.$listEl, "click", function (event) {
                self.select_line(event, $(this), parseInt($(this).data("id"), 10));
            });

            if (this.pos.config.iface_vkeyboard && this.chrome.widget.keyboard) {
                this.chrome.widget.keyboard.connect(this.$(".searchbox input"));
            }

            var search_timeout = null;
            this.$(".searchbox input").on("keypress", function (event) {
                var query = this.value;
                clearTimeout(search_timeout);
                search_timeout = setTimeout(function () {
                    self._search(query);
                }, 70);
            });

            this.$(".searchbox .search-clear").click(function () {
                self._clear_search();
            });

            if (odoo.is_mobile) {
                // For compatibility with https://www.odoo.com/apps/modules/12.0/pos_mobile/
                setTimeout(function () {
                    var width = self.$(".screen-content").width();
                    var height = self.$("table.list").height();
                    var max_height = self.$(".full-content").height();
                    if (height > max_height) {
                        height = max_height;
                    }
                    self.$(
                        ".subwindow-container-fix.touch-scrollable.scrollable-y"
                    ).css({
                        width: width,
                        height: height,
                    });
                    self.$(".touch-scrollable").niceScroll();
                }, 0);
            }
        },
        render_data: function (data) {
            var self = this;
            var contents = this.$el[0].querySelector(".list-contents");
            contents.innerHTML = "";
            for (var i = 0, len = Math.min(data.length, 1000); i < len; i++) {
                var item_html = QWeb.render(this.itemTemplate, {
                    widget: this,
                    item: data[i],
                });
                var item_line = document.createElement("tbody");

                var $tr = document.createElement("tr");
                if (data[i].lines) {
                    var $td = document.createElement("td");
                    $td.setAttribute("colspan", this.num_columns);

                    $tr.classList.add("line-element-hidden");
                    $tr.classList.add("line-element-container");

                    var $table = this.render_lines_table(data[i].lines);

                    $td.appendChild($table);
                    $tr.appendChild($td);
                }
                item_line.innerHTML = item_html;
                item_line = item_line.childNodes[1];

                contents.appendChild(item_line);
                contents.appendChild($tr);
            }
            
            this.$(".order-list-reprint").off("click");
            this.$(".order-list-reprint").click(function(event) {
                self.order_list_actions(event, "print");
            });       
        },        
        render_lines_table: function (data_lines) {
            var $table = document.createElement("table"),
                $header = this.render_header(),
                $tableData = this.render_product_lines(data_lines);
            $table.classList.add("lines-table");
            $table.appendChild($header);
            $table.appendChild($tableData);
            return $table;
        },
        order_list_actions: function(event, action) {
            var self = this;
            var dataset = event.target.parentNode.dataset;                        
            let orderId = parseInt(dataset.orderId, 10)
            var order_data = this.pos.db.get_sale_order_by_id(orderId);            
            self.order_action(order_data, action);
        },
        
        order_action: function(order_data, action) {
            if (this.old_order !== null || _.isUndefined(order_data)) {
                this.gui.back();
            }
            var order = this.load_order_from_data(order_data, action);
            if (!order) {
                // The load of the order failed. (products not found, ...
                // We cancel the action
                return;
            }
            this["action_" + action](order_data, order);
        },
        load_order_from_data: function(order_data, action) {
            var self = this;
            this.unknown_products = [];
            var order = self._prepare_order_from_order_data(order_data, action);
            // Forbid POS Order loading if some products are unknown
            if (self.unknown_products.length > 0) {
                self.gui.show_popup("error-traceback", {
                    title: _t("Unknown Products"),
                    body:
                        _t(
                            "Unable to load some order lines because the " +
                                "products are not available in the POS cache.\n\n" +
                                "Please check that lines :\n\n  * "
                        ) + self.unknown_products.join("; \n  *"),
                });
                return false;
            }
            return order;
        },
        _prepare_order_from_order_data: function(order_data, action) {
            var self = this;
            var order = new models.Order(
                {},
                {
                    pos: this.pos,
                }
            );

            if (order_data === undefined){
                alert('Intenta de Nuevo');
                return false;
            }

            // Get Customer
            if (order_data.partner_id) {
                order.set_client(this.pos.db.get_partner_by_id(order_data.partner_id[0]));
            }

            // Get fiscal position
            if (order_data.fiscal_position && this.pos.fiscal_positions) {
                var fiscal_positions = this.pos.fiscal_positions;
                order.fiscal_position = fiscal_positions.filter(function(p) {
                    return p.id === order_data.fiscal_position;
                })[0];
                order.trigger("change");
            }

            // Get order lines
            self._prepare_orderlines_from_order_data(order, order_data, action);

            // Get Name
            if (["print"].indexOf(action) !== -1) {
                // order.name = order_data.pos_reference;
                order.name = order_data.name;
            } else if (["return"].indexOf(action) !== -1) {
                order.name = _t("Refund ") + order.uid;
            }

            // Get to invoice
            if (["return", "copy"].indexOf(action) !== -1) {
                // If previous order was invoiced, we need a refund too
                order.set_to_invoice(order_data.to_invoice);
            }

            // Get returned Order
            if (["print"].indexOf(action) !== -1) {
                // Get the same value as the original
                order.returned_order_id = order_data.returned_order_id;
                order.returned_order_reference = order_data.returned_order_reference;
            } else if (["return"].indexOf(action) !== -1) {
                order.returned_order_id = order_data.id;
                order.returned_order_reference = order_data.pos_reference;
            }

            // Get Date
            if (["print"].indexOf(action) !== -1) {
                order.formatted_validation_date = moment(order_data.date_order).format(
                    "YYYY-MM-DD HH:mm:ss"
                );
            }

            // Get Payment lines
            if (["print"].indexOf(action) !== -1) {
                // var paymentLines = order_data.statement_ids || [];
                var paymentLines = order_data.lines || [];

                _.each(paymentLines, function(paymentLine) {
                    var line = paymentLine;
                    // In case of local data
                    if (line.length === 3) {
                        line = line[2];
                    }
                    _.each(self.pos.payment_methods, function(cashregister) {
                        if (cashregister.id === line.payment_method_id) {
                            if (line.amount > 0) {
                                // If it is not change
                                order.add_paymentline(cashregister);
                                order.selected_paymentline.set_amount(line.amount);
                            }
                        }
                    });
                });
            }
            return order;
        },
        
        _prepare_product_options_from_orderline_data: function(order, line, action) {
            var qty = line.qty;
            if (["return"].indexOf(action) !== -1) {
                // Invert line quantities
                qty *= -1;
            }
            return {
                price: line.price_unit,                
                // quantity: qty,
                quantity: line.product_uom_qty,
                discount: line.discount,
                merge: false,
                extras: {
                    return_pack_lot_names: line.pack_lot_names,
                },
            };
        },


        action_print: function(order_data, order) {
            // We store temporarily the current order so we can safely compute
            // taxes based on fiscal position
            this.pos.current_order = this.pos.get_order();

            this.pos.set_order(order);

            this.pos.reloaded_order = order;
            var skip_screen_state = this.pos.config.iface_print_skip_screen;
            // Disable temporarily skip screen if set
            this.pos.config.iface_print_skip_screen = false;
            this.gui.show_screen("sale_order_receipt");
            this.pos.reloaded_order = false;
            // Set skip screen to whatever previous state
            this.pos.config.iface_print_skip_screen = skip_screen_state;

            // If it's invoiced, we also print the invoice
            if (order_data.to_invoice) {
                this.pos.chrome.do_action("point_of_sale.pos_invoice_report", {
                    additional_context: {active_ids: [order_data.id]},
                });
            }

            // Destroy the order so it's removed from localStorage
            // Otherwise it will stay there and reappear on browser refresh
            order.destroy();
        },

        _prepare_orderlines_from_order_data: function(order, order_data, action) {
            var orderLines = order_data.line_ids || order_data.lines || [];

            var self = this;
            _.each(orderLines, function(orderLine) {
                var line = orderLine;
                // In case of local data
                if (line.length === 3) {
                    line = line[2];
                }

                var product = self.pos.db.get_product_by_id(line.product_id[0]);

                if(_.isUndefined(product)){
                    product = self.pos.db.products_no_availables_by_id[line.product_id[0]];                    

                } 
                self.get_product_product(product, order, action, line);
            });
        },
     
        get_product_product: function (product, order, action, line) {
            let self = this          
            // Check if product are available in pos
            if (_.isUndefined(product)) {
                self.unknown_products.push(String(line.product_id));
            } else {
                // Create a new order line
                order.add_product(
                    product,
                    self._prepare_product_options_from_orderline_data(
                        order,
                        line,
                        action
                    )
                );
                // Restore lot information.
                if (["return"].indexOf(action) !== -1) {
                    var orderline = order.get_selected_orderline();
                    if (orderline.pack_lot_lines) {
                        _.each(orderline.return_pack_lot_names, function(lot_name) {
                            orderline.pack_lot_lines.add(
                                new models.Packlotline(
                                    {lot_name: lot_name},
                                    {order_line: orderline}
                                )
                            );
                        });
                        orderline.trigger("change", orderline);
                    }
                }
            }
        },

        render_header: function () {
            var $header = document.createElement("thead");
            $header.innerHTML = QWeb.render(this.linesHeaderTemplate);
            return $header;
        },
        render_product_lines: function (data_lines) {
            var self = this;
            var $body = document.createElement("tbody"),
                lines = "",
                line_html = "";
            _.each(_.keys(data_lines), function (l) {
                line_html = QWeb.render(self.lineTemplate, {
                    widget: self,
                    line: data_lines[l],
                });
                lines += line_html;
            });
            $body.innerHTML = lines;
            return $body;
        },
    });

    var SaleOrdersWidget = InvoicesAndOrdersBaseWidget.extend({
        template: "SaleOrdersWidget",
        init: function () {
            this._super.apply(this, arguments);
            this.$listEl = ".sale-order";
            this.itemTemplate = "SaleOrder";
            this.linesHeaderTemplate = "SaleOrderLinesHeader";
            this.lineTemplate = "SaleOrderLine";
            this.num_columns = 6;
            this.selected_SO = false;
        },
        show: function () {
            var self = this;
            this._super();

            this.$(".back").click(function () {
                self.gui.show_screen("products");
            });
        },
        get_data: function () {
            return this.pos.get_sale_order_to_render(this.pos.db.sale_orders);
        },
        select_line: function (event, $line, id) {
            var sale_order = this.pos.db.get_sale_order_by_id(id);
            this.$(".list .lowlight").removeClass("lowlight");
            this.$(".line-element-container").addClass("line-element-hidden");
            if ($line.hasClass("highlight")) {
                this.selected_SO = false;
                $line.removeClass("highlight");
                $line.addClass("lowlight");
                $line.next().addClass("line-element-hidden");
            } else {
                this.$(".list .highlight").removeClass("highlight");
                $line.addClass("highlight");
                this.selected_SO = sale_order;
                $line.next().removeClass("line-element-hidden");
                $line.next().addClass("line-element");
            }
            this.toggle_save_button(this.selected_SO);
            if (odoo.is_mobile) {
                var height = this.$("table.list").height();
                var max_height = this.$(".full-content").height();
                if (height > max_height) {
                    height = max_height;
                }
                this.$(".subwindow-container-fix.touch-scrollable.scrollable-y").css({
                    height: height,
                });
                this.$(".subwindow-container-fix.touch-scrollable.scrollable-y")
                    .getNiceScroll()
                    .resize();
            }
        },
        toggle_save_button: function (selected_invoice) {            
            var $button = this.$(".button.next");
            if(selected_invoice == false){                
                $button.addClass("oe_hidden");
            }
            else{
                if (selected_invoice.invoice_status != "To invoice") {
                    $button.addClass("oe_hidden");
                } else {                    
                    $button.removeClass("oe_hidden");
                }
            }            
        },
        click_next: function () {
            if (this.selected_SO) {
                this.create_invoice(this.selected_SO);
            } else {
                this.gui.show_popup("error", {
                    title: _t("No invoice"),
                    body: _t("There must be invoice selected."),
                });
                return false;
            }
        },
        create_invoice: function (sale_order) {
            var self = this;
            rpc.query({
                model: "pos.order",
                method: "process_invoices_creation",
                args: [sale_order.id],
            }).then(function (created_invoice_id) {
                // Explicitly update the db to avoid race condition.
                self.pos
                    .update_or_fetch_invoice(created_invoice_id)
                    .then(function (res) {
                        // self.pos.selected_invoice = self.pos.db.get_invoice_by_id(res);
                        // self.pos.gui.screen_instances.invoice_payment.render_paymentlines();
                        // self.gui.show_screen("invoice_payment", {type: "orders"});
                        self.gui.back();
                    });
            });
            // Fail(function(err, errorEvent) {
            //     self.gui.show_popup("error", {
            //         title: _t(err.message.message),
            //         body: _t(err.message.data.arguments[0]),
            //     });
            //     if (errorEvent) {
            //         errorEvent.preventDefault();
            //     }
            // });
        },
        _search: function (query) {
            var sale_orders = [];
            if (query) {
                sale_orders = this.pos.db.search_sale_orders(query);
                sale_orders = this.pos.get_sale_order_to_render(sale_orders);
                this.render_data(sale_orders);
            } else {
                sale_orders = this.pos.db.sale_orders;
                sale_orders = this.pos.get_sale_order_to_render(sale_orders);
                this.render_data(sale_orders);
            }
        },
        _clear_search: function () {
            var sale_orders = this.pos.db.sale_orders;
            this.render_data(sale_orders);
            this.$(".searchbox input")[0].value = "";
            this.$(".searchbox input").focus();
        },
    });

    gui.define_screen({name: "sale_orders_list", widget: SaleOrdersWidget});

    var InvoicesWidget = InvoicesAndOrdersBaseWidget.extend({
        template: "InvoicesWidget",
        invoice_screen: true,
        init: function () {
            this._super.apply(this, arguments);
            this.$listEl = ".invoice";
            this.itemTemplate = "Invoice";
            this.linesHeaderTemplate = "InvoiceLinesHeader";
            this.lineTemplate = "InvoiceLine";
            this.num_columns = 8;
            this.selected_invoice = false;
        },

        get_data: function () {
            return this.pos.get_invoices_to_render(this.pos.db.invoices);
        },

        show: function () {
            var self = this;
            this._super();

            this.$(".back").click(function () {
                self.gui.back();
            });
        },

        select_line: function (event, $line, id) {
            var invoice = this.pos.db.get_invoice_by_id(id);
            this.$(".list .lowlight").removeClass("lowlight");
            this.$(".line-element-container").addClass("line-element-hidden");
            if ($line.hasClass("highlight")) {
                this.selected_invoice = false;
                $line.removeClass("highlight");
                $line.addClass("lowlight");
                $line.next().addClass("line-element-hidden");
            } else {
                this.$(".list .highlight").removeClass("highlight");
                $line.addClass("highlight");
                this.selected_invoice = invoice;
                $line.next().removeClass("line-element-hidden");
                $line.next().addClass("line-element");
            }
            this.toggle_save_button(this.selected_invoice);
            if (odoo.is_mobile) {
                var height = this.$("table.list").height();
                var max_height = this.$(".full-content").height();
                if (height > max_height) {
                    height = max_height;
                }
                this.$(".subwindow-container-fix.touch-scrollable.scrollable-y").css({
                    height: height,
                });
                this.$(".subwindow-container-fix.touch-scrollable.scrollable-y")
                    .getNiceScroll()
                    .resize();
            }
        },

        toggle_save_button: function (selected_invoice) {
            var $button = this.$(".button.next");
            if (selected_invoice) {
                $button.removeClass("oe_hidden");
            } else {
                $button.addClass("oe_hidden");
            }
        },

        _search: function (query) {
            var invoices = [];
            if (query) {
                invoices = this.pos.db.search_invoices(query);
                invoices = this.pos.get_invoices_to_render(invoices);
                this.render_data(invoices);
            } else {
                invoices = this.pos.db.invoices;
                invoices = this.pos.get_invoices_to_render(invoices);
                this.render_data(invoices);
            }
        },

        _clear_search: function () {
            var invoices = this.pos.db.invoices;
            this.render_data(invoices);
            this.$(".searchbox input")[0].value = "";
            this.$(".searchbox input").focus();
        },

        click_next: function () {
            if (this.selected_invoice) {
                this.pos.selected_invoice = this.selected_invoice;
                //  TODO: aqui validar factura antes de asociar pago

                // Switch (this.selected_invoice.state) {
                //     case "draft":
                //         this.pos
                //             .validate_invoice(this.selected_invoice.id)
                //             .then(function(id) {
                //                 self.pos.update_or_fetch_invoice(id).then(function() {
                //                     self.render_data(
                //                         self.pos.get_invoices_to_render(
                //                             self.pos.db.invoices
                //                         )
                //                     );
                //                     self.toggle_save_button();
                //                     self.pos.selected_invoice = self.pos.db.get_invoice_by_id(
                //                         self.selected_invoice.id
                //                     );
                //                     self.gui.show_screen("invoice_payment", {
                //                         type: "invoices",
                //                     });
                //                 });
                //             })
                //             .fail(function() {
                //                 this.gui.show_popup("error", {
                //                     title: _t("Error"),
                //                     body: _t("Can't validate selected invoice."),
                //                 });
                //             });
                //         break;
                //     case "posted":
                //         this.gui.show_screen("invoice_payment", {type: "invoices"});
                // }
                let valuePos = this.pos.selected_invoice.amount_residual
                let value = this.pos.selected_invoice.amount_residual;
                // reemplazar puntos (.) por comas (,)
                value = value.toString().replace(/\./g, ",");
                this.gui.show_popup('number', {
                    // 'title': _t('Select amount'),
                    'title': _t('Seleccionar Cantidad'),
                    'value': this.format_currency_no_symbol(""+value),
                    'confirm': function(value) {
                        var valuePay = parseInt(value)
                        if(valuePay > valuePos){
                            this.gui.show_popup("error",{
                                // title: _t("Rectify payment"),
                                // body: _t("The value paid is greater than the value owed."),
                                title: _t("Rectificar Pago"),
                                body: _t("El valor a PAGAR es MAYOR que el valor ADEUDADO."),
                            });
                        }
                        else{
                            this.pos.selected_invoice = JSON.parse(JSON.stringify(this.pos.selected_invoice))
                            this.pos.selected_invoice.amount_residual = field_utils.parse.float(value);
                            this.pos.selected_invoice.amount_tax = 0.0;
                            this.pos.selected_invoice.amount_total = field_utils.parse.float(value);
                            this.gui.show_screen("invoice_payment", { type: "invoices"});
                        }                        
                    },
                });
            } else {
                this.gui.show_popup("error", {
                    title: _t("No invoice"),
                    body: _t("There must be invoice selected."),
                });
                return false;
            }
        },
    });

    gui.define_screen({name: "invoices_list", widget: InvoicesWidget});

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

        render_paymentlines: function () {
            var self = this;
            var order = this.pos.get_order();
            if (!order || typeof order !== "object") {
                return;
            }
            var lines = order.get_paymentlines();
            if (typeof this.pos.selected_invoice !== "object") {
                return;
            }
            order.invoice_to_pay = this.pos.selected_invoice;

            order.invoice_to_pay.get_due = function (paymentline) {
                var total = self.pos.selected_invoice.amount_residual,
                    due = 0,
                    plines = order.paymentlines.models;
                if (paymentline === undefined) {
                    due = total - order.get_total_paid();
                } else {
                    due = total;
                    for (var i = 0; i < plines.length; i++) {
                        if (plines[i] === paymentline) {
                            break;
                        } else {
                            due -= plines[i].get_amount();
                        }
                    }
                }
                return round_pr(Math.max(0, due), self.pos.currency.rounding);
            };

            order.invoice_to_pay.get_change = function (paymentline) {
                var due = self.pos.selected_invoice.amount_residual,
                    change = 0,
                    plines = order.paymentlines.models,
                    i = 0;
                if (paymentline === undefined) {
                    change = -due + order.get_total_paid();
                } else {
                    change = -due;
                    for (i = 0; i < plines.length; i++) {
                        change += plines[i].get_amount();
                        if (plines[i] === paymentline) {
                            break;
                        }
                    }
                }
                return round_pr(Math.max(0, change), self.pos.currency.rounding);
            };

            order.invoice_to_pay.get_subtotal = function () {
                var tax = self.pos.selected_invoice.amount_tax,
                    due = self.pos.selected_invoice.amount_residual,
                    subtotal = due - tax;
                return round_pr(Math.max(0, subtotal), self.pos.currency.rounding);
            };

            this.$(".paymentlines-container").empty();
            lines = $(
                QWeb.render("InvoicePaymentScreen-Paymentlines", {
                    widget: this,
                    order: order,
                    paymentlines: lines,
                })
            );

            lines.on("click", ".delete-button", function () {
                self.click_delete_paymentline($(this).data("cid"));
            });

            lines.on("click", ".paymentline", function () {
                self.click_paymentline($(this).data("cid"));
            });

            lines.appendTo(this.$(".paymentlines-container"));
        },

        click_paymentmethods: function (_id) {
            this.pos
                .get_order()
                .add_paymentline(
                    this.pos.payment_methods_by_id[_id],
                    "pos_invoice_pay"
                );
            this.reset_input();
            this.render_paymentlines();
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

    var SaleOrderReceiptScreenWidget = screens.ReceiptScreenWidget.extend({
        click_next: function() {
            this.gui.show_screen(this.gui.startup_screen);
            return this._super();
        },
    });

    gui.define_screen({name: "sale_order_receipt", widget: SaleOrderReceiptScreenWidget});

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
});
