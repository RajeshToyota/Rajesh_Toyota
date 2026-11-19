-- Each tab of a tabbed screen is its own address, /<screen>/<tab> (web/src/lib/tabbed-screens.tsx),
-- instead of /<screen>?tab=<tab>. Point the modules that are a tab at it.
update app_modules set path = '/finance/desk' where key = 'finance_desk';
update app_modules set path = '/ops-billing/crm-billing/invoices' where key = 'stock_billing';
update app_modules set path = '/ops-billing/receipts/clearance' where key = 'payments';
update app_modules set path = '/used-cars/exchange/evaluations' where key = 'used_car_evaluations';
