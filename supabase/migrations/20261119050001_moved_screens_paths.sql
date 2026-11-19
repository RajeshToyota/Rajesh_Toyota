-- One address per screen. These screens are now a tab on another screen (menu_merges); their old
-- addresses only redirect, so their modules point at the tab.
update app_modules set path = '/finance?tab=desk' where key = 'finance_desk';
update app_modules set path = '/ops-billing/crm-billing?tab=invoices' where key = 'stock_billing';
update app_modules set path = '/ops-billing/receipts?tab=clearance' where key = 'payments';
update app_modules set path = '/used-cars/exchange?tab=evaluations' where key = 'used_car_evaluations';
