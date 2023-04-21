# Copyright 2018 Artyom Losev
# Copyright 2018 Dinar Gabbasov <https://it-projects.info/team/GabbasovDinar>
# Copyright 2021 Ilya Ilchenko <https://github.com/mentalko>
# License MIT (https://opensource.org/licenses/MIT).
{
    "name": """POS: Payment methods""",
    "summary": """Handle the payment methods on Point of Sale""",
    "category": "Point of Sale",
    "images": ["images/pos_invoice_pay_main.png"],
    "version": "13.0.0",
    "application": False,
    "author": "Ingenioso",
    "support": "soporte@ingenioso.co",
    "website": "https://ingenioso.co/",
    "license": "Other OSI approved licence",  # MIT
    "currency": "COP",
    "depends": ["point_of_sale"],
    "external_dependencies": {"python": [], "bin": []},
    "data": [
        "data/data.xml",
        "actions/base_action_rules.xml",
        "report/report.xml",
        "views/view.xml",
        "views/pos_payment_method_views.xml"
    ],
    "qweb": ["static/src/xml/pos.xml"],
    "demo": [],
    "post_load": None,
    "pre_init_hook": None,
    "post_init_hook": None,
    "auto_install": False,
    "installable": True,
    "demo_title": "Payment methods on POS",
    "demo_addons": [],
    "demo_addons_hidden": [],
    "demo_url": "payment_methods",
    "demo_summary": "Provide payment methods in Point of Sale",
    "demo_images": ["images/pos_invoice_pay_main.png"],
}
