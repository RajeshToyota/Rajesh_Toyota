import { lazy, type ComponentType } from "react";

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
];
