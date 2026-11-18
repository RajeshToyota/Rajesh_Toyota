import { lazy, type ComponentType } from "react";

// Screens added by Phases 18–22, written as plain React pages (no compat layer). Each module key
// is seeded in that phase's migration (app_modules) with its menu label and path.
export const phaseRoutes: { path: string; module?: string; Component: ComponentType }[] = [
  // Phase 18: Ops Billing, PDI, gate pass, delivery slots
  { path: "/ops-billing", module: "ops_billing", Component: lazy(() => import("@/pages/ops/OpsBilling")) },
  { path: "/ops-billing/gate-pass", module: "gate_pass", Component: lazy(() => import("@/pages/ops/GatePass")) },
  { path: "/pdi-board", module: "pdi_board", Component: lazy(() => import("@/pages/ops/PdiBoard")) },
  { path: "/delivery-scheduler", module: "delivery_scheduler", Component: lazy(() => import("@/pages/ops/DeliveryScheduler")) },
];
