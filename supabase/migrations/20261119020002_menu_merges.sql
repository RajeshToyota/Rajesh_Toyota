-- One menu entry per job. Each pair below is now one screen with a tab per part (each tab still
-- needs its own module's view right); the second module's menu entry goes, its route stays.
--   Finance Cases (/finance)               pipeline + finance desk (all banks, verification)
--   Ops Billing: CRM Billing               CTDMS tracker + the invoice queue (Stock → Billing)
--   Ops Billing: Payment Receipts          receipt register + clearance and dues (Payments)
--   Exchange (/used-cars/exchange)         evaluations + deals, inspection and outside cars
update app_modules set in_menu = false where key in ('finance_desk', 'stock_billing', 'payments', 'used_car_evaluations');
update app_modules set label = 'Exchange' where key = 'used_car_exchange';
-- The old Hold & Cancellations screen now lists only cancellations awaiting approval; refunds and
-- holds have their own screens (Booking Refunds, Hold Customers).
update app_modules set label = 'Cancellation Approvals' where key = 'cancellations';
-- "Quotes" was both the Sales workbench and this report.
update app_modules set label = 'Quote Report' where key = 'rpt_quotes';
