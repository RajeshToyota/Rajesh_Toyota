import { hostedEntitySlugs, masterPages, masterTabFor } from "@/lib/master-pages";

// Screens that hold other screens as tabs. Anyone who may view any of these modules may open the
// screen; it then shows only the tabs they may see. Keyed by path.
export const screenModules: Record<string, string[]> = {
  "/finance": ["finance_cases", "finance_desk"],
  "/ops-billing/crm-billing": ["ops_crm_billing", "stock_billing"],
  "/ops-billing/receipts": ["ops_receipts", "payments"],
  "/used-cars/exchange": ["used_car_exchange", "used_car_evaluations"],
  ...Object.fromEntries(Object.values(masterPages).map((p) => [p.path, [p.module, "masters"]])),
};

// Old addresses of screens that are now a tab on another screen. Each screen has one address, so
// these only redirect (bookmarks and old links keep working).
export const movedScreens: Record<string, string> = {
  "/finance/desk": "/finance?tab=desk",
  "/stock/billing": "/ops-billing/crm-billing?tab=invoices",
  "/payments": "/ops-billing/receipts?tab=clearance",
  "/used-cars/evaluations": "/used-cars/exchange?tab=evaluations",
  ...Object.fromEntries(hostedEntitySlugs.map((slug) => [`/admin/${slug}`, masterTabFor(slug)!.href])),
};
