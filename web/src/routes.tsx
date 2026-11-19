import { lazy, type ComponentType } from "react";
import { ported } from "@/compat/ported";
import { mergedPage } from "@/components/merged-page";

const stage = (name: "CrmBillingStage" | "ReceiptsStage") => lazy(() => import("@/pages/ops/billing/Stages").then((m) => ({ default: m[name] })));

// Screens added by Phases 18–22, written as plain React pages (no compat layer). Each module key
// is seeded in that phase's migration (app_modules) with its menu label and path.
export const phaseRoutes: { path: string; module?: string; Component: ComponentType }[] = [
  // Phase 18: Ops Billing, PDI, gate pass, delivery slots
  { path: "/ops-billing", module: "ops_billing", Component: lazy(() => import("@/pages/ops/OpsBilling")) },
  { path: "/ops-billing/gate-pass", module: "gate_pass", Component: lazy(() => import("@/pages/ops/GatePass")) },
  { path: "/pdi-board", module: "pdi_board", Component: lazy(() => import("@/pages/ops/PdiBoard")) },
  { path: "/delivery-scheduler", module: "delivery_scheduler", Component: lazy(() => import("@/pages/ops/DeliveryScheduler")) },

  // Phase 19: follow-ups, tasks, reception, test drives, RM console
  { path: "/followups", module: "followups", Component: lazy(() => import("@/pages/crm/Followups")) },
  { path: "/tasks", module: "tasks", Component: lazy(() => import("@/pages/crm/Tasks")) },
  { path: "/reception", module: "reception", Component: lazy(() => import("@/pages/crm/Reception")) },
  { path: "/test-drives", module: "test_drive", Component: lazy(() => import("@/pages/crm/TestDrives")) },
  { path: "/rm", module: "rm_console", Component: lazy(() => import("@/pages/crm/RmConsole")) },
  { path: "/rm/booking/:id", module: "rm_console", Component: lazy(() => import("@/pages/crm/RmBooking")) },
  { path: "/reports/walkins", module: "rpt_walkins", Component: lazy(() => import("@/pages/crm/Reports").then((m) => ({ default: m.WalkinReport }))) },
  { path: "/reports/followups", module: "rpt_followups", Component: lazy(() => import("@/pages/crm/Reports").then((m) => ({ default: m.FollowupReport }))) },

  // Phase 20: targets and incentives
  { path: "/targets", module: "targets", Component: lazy(() => import("@/pages/incentives/Targets")) },
  { path: "/incentives", module: "incentives", Component: lazy(() => import("@/pages/incentives/Runs")) },
  { path: "/incentives/schemes", module: "incentive_schemes", Component: lazy(() => import("@/pages/incentives/Schemes")) },
  { path: "/incentives/bank-payouts", module: "bank_payouts", Component: lazy(() => import("@/pages/incentives/BankPayouts")) },
  { path: "/incentives/me", module: "my_incentive", Component: lazy(() => import("@/pages/incentives/MyIncentive")) },

  // Phase 21: stock extras
  { path: "/stock/price-diff", module: "price_diff", Component: lazy(() => import("@/pages/stockx/PriceDiff")) },
  { path: "/stock/control", module: "stock_control", Component: lazy(() => import("@/pages/stockx/StockControl")) },
  { path: "/stock/transfers", module: "stock_transfers", Component: lazy(() => import("@/pages/stockx/Transfers")) },
  { path: "/stock/yard", module: "vehicle_location", Component: lazy(() => import("@/pages/stockx/Yard")) },
  { path: "/stock/other-dealers", module: "other_dealers", Component: lazy(() => import("@/pages/stockx/OtherDealers")) },
  { path: "/search", module: "search_console", Component: lazy(() => import("@/pages/stockx/Search")) },

  // Phase 22: exchange and used cars
  { path: "/used-cars/evaluations", module: "used_car_evaluations", Component: lazy(() => import("@/pages/used/Evaluations")) },
  { path: "/used-cars/stock", module: "used_car_stock", Component: lazy(() => import("@/pages/used/Stock")) },
  { path: "/used-cars/summary", module: "rpt_used_cars", Component: lazy(() => import("@/pages/used/Stock").then((m) => ({ default: m.UsedCarSummary }))) },

  // Phase 23: Access Studio depth
  { path: "/admin/departments", module: "departments", Component: lazy(() => import("@/pages/admin/Departments")) },
  { path: "/admin/reporting-hierarchy", module: "reporting_hierarchy", Component: lazy(() => import("@/pages/admin/ReportingHierarchy")) },

  // Phase 24: catalog and pricing masters
  { path: "/masters/catalog", module: "catalog", Component: lazy(() => import("@/pages/masters/Catalog")) },
  { path: "/masters/insurance", module: "insurance_rates", Component: lazy(() => import("@/pages/masters/Insurance")) },
  { path: "/masters/rto", module: "rto_settings", Component: lazy(() => import("@/pages/masters/Rto")) },
  { path: "/masters/schemes", module: "schemes", Component: lazy(() => import("@/pages/masters/Schemes")) },
  { path: "/masters/discount-rules", module: "discount_rules", Component: lazy(() => import("@/pages/masters/DiscountRules")) },

  // Phase 25: quotes workbench
  { path: "/quotes", module: "quotes", Component: lazy(() => import("@/pages/quotes/Quotes")) },
  { path: "/quotes/:id", module: "quotes", Component: lazy(() => import("@/pages/quotes/QuoteDetail")) },

  // Phase 26: booking documents, cancelled customers, refunds, hold
  { path: "/booking-docs", module: "booking_docs", Component: lazy(() => import("@/pages/bookings/BookingDocs")) },
  { path: "/cancelled-customers", module: "cancelled_customers", Component: lazy(() => import("@/pages/bookings/CancelledCustomers")) },
  { path: "/refunds", module: "refunds", Component: lazy(() => import("@/pages/bookings/Refunds")) },
  { path: "/hold-customers", module: "hold_customers", Component: lazy(() => import("@/pages/bookings/HoldCustomers")) },

  // Phase 27: stock, yard and Form 22
  { path: "/stock/dealer-transfers", module: "dealer_transfers", Component: lazy(() => import("@/pages/stockx/DealerTransfers")) },
  { path: "/stock/monitor", module: "stock_monitor", Component: lazy(() => import("@/pages/stockx/Monitor")) },
  { path: "/stock/planning", module: "stock_planning", Component: lazy(() => import("@/pages/stockx/Planning")) },

  // Phase 28: pool extras
  { path: "/stock/pool/next-in-line", module: "stock_pool_extras", Component: lazy(() => import("@/pages/stockx/PoolExtras")) },

  // Phase 29: finance
  { path: "/finance/banks", module: "finance_banks", Component: lazy(() => import("@/pages/finance/Banks")) },
  { path: "/finance/desk", module: "finance_desk", Component: lazy(() => import("@/pages/finance/Desk")) },
  { path: "/finance/claims-payouts", module: "finance_claims", Component: lazy(() => import("@/pages/finance/ClaimsPayouts")) },

  // Phase 30: one screen per Ops Billing stage (the board at /ops-billing is the stage status)
  { path: "/ops-billing/accounts", module: "ops_accounts", Component: lazy(() => import("@/pages/ops/billing/Stages").then((m) => ({ default: m.AccountsStage }))) },
  // CRM Billing: the CTDMS tracker and the invoice queue (Stock → Billing), one menu entry.
  {
    path: "/ops-billing/crm-billing", module: "ops_crm_billing",
    Component: mergedPage([
      { id: "crm", label: "CRM billing", module: "ops_crm_billing", Component: stage("CrmBillingStage") },
      { id: "invoices", label: "Invoice queue", module: "stock_billing", Component: ported(() => import("@/pages/staff/stock/billing/page")) },
    ]),
  },
  { path: "/ops-billing/insurance", module: "ops_insurance", Component: lazy(() => import("@/pages/ops/billing/Stages").then((m) => ({ default: m.InsuranceStage }))) },
  { path: "/ops-billing/rto", module: "ops_rto", Component: lazy(() => import("@/pages/ops/billing/Stages").then((m) => ({ default: m.RtoStage }))) },
  { path: "/ops-billing/accessories", module: "ops_accessories", Component: lazy(() => import("@/pages/ops/billing/Stages").then((m) => ({ default: m.AccessoriesStage }))) },
  { path: "/ops-billing/schemes", module: "ops_scheme", Component: lazy(() => import("@/pages/ops/billing/Stages").then((m) => ({ default: m.SchemesStage }))) },
  { path: "/ops-billing/scrap", module: "ops_scrap", Component: lazy(() => import("@/pages/ops/billing/Stages").then((m) => ({ default: m.ScrapStage }))) },
  // Payment Receipts: the receipt register and clearance / what customers still owe, one menu entry.
  {
    path: "/ops-billing/receipts", module: "ops_receipts",
    Component: mergedPage([
      { id: "receipts", label: "Receipts", module: "ops_receipts", Component: stage("ReceiptsStage") },
      { id: "clearance", label: "Clearance & dues", module: "payments", Component: ported(() => import("@/pages/staff/payments/page")) },
    ]),
  },

  // Phase 32: payroll
  { path: "/payroll", module: "payroll", Component: lazy(() => import("@/pages/payroll/Payroll")) },

  // Phase 33: used cars and reception
  // Exchange: evaluations (request, value, buy in) and the deal desk, one menu entry.
  {
    path: "/used-cars/exchange", module: "used_car_exchange",
    Component: mergedPage([
      { id: "evaluations", label: "Evaluations", module: "used_car_evaluations", Component: lazy(() => import("@/pages/used/Evaluations")) },
      { id: "deals", label: "Deals, inspection & outside cars", module: "used_car_exchange", Component: lazy(() => import("@/pages/used/Exchange")) },
    ]),
  },
  { path: "/kiosk", module: "kiosk", Component: lazy(() => import("@/pages/crm/Kiosk")) },
  { path: "/reception/ctdms-queue", module: "reception_ctdms", Component: lazy(() => import("@/pages/crm/CtdmsQueue")) },
];
