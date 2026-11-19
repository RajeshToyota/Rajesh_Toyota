import { lazy, type ComponentType } from "react";
import { ported } from "@/compat/ported";

// Screens that hold several tabs (the Masters pages and screens merged under one menu entry).
//
// Every tab is its own route, /<screen path>/<tab id>, with its own lazily loaded code: opening a
// tab downloads only that tab, so a screen does not get heavier as tabs are added, and each tab has
// exactly one address. /<screen path> alone opens the first tab the employee may see.
//
// A tab with `entity` edits that master table (lib/entities). This tab is the table's only page:
// the menu links here and /admin/<slug> only redirects. Other tabs name a `Component`.
//
// scripts/check-modules.mjs reads this file: keep `path: "…"` on screens and build tabs with
// <x>.table("id", …), <x>.tool("id", …) or screen("id", …), in file order.
export type ScreenTab = {
  id: string;
  label: string;
  // Who may open the tab: the view right on any of these modules.
  modules: string[];
  entity?: string;
  Component?: ComponentType;
  // Listed on its own in the Masters menu, under this label (tools that are not a table).
  menuLabel?: string;
};
export type TabbedScreen = {
  path: string;
  module: string;
  title?: string;
  note?: string;
  // Masters menu group (lib/entities) whose flyout lists this screen's tools.
  mastersGroup?: string;
  tabs: ScreenTab[];
};

type Load = () => Promise<{ default: ComponentType }>;
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K): Load => () => load().then((m) => ({ default: m[name] }));

// A master table on a Masters page: open to the page's module or the general "masters" view right.
const table = (module: string) => (id: string, label: string, entity: string): ScreenTab => ({ id, label, entity, modules: [module, "masters"] });
// A custom tool on a Masters page: needs the page's own module.
const tool = (module: string) => (id: string, label: string, load: Load, menuLabel?: string): ScreenTab => ({ id, label, modules: [module], Component: lazy(load), menuLabel });
// A screen merged into a tabbed screen: needs its own module.
const screen = (id: string, label: string, module: string, Component: ComponentType): ScreenTab => ({ id, label, modules: [module], Component });

const catalog = { table: table("catalog"), tool: tool("catalog") };
const insurance = { table: table("insurance_rates"), tool: tool("insurance_rates") };
const rto = { table: table("rto_settings"), tool: tool("rto_settings") };
const schemes = { table: table("schemes"), tool: tool("schemes") };
const stage = (name: "CrmBillingStage" | "ReceiptsStage") => lazy(named(() => import("@/pages/ops/billing/Stages"), name));

export const tabbedScreens: TabbedScreen[] = [
  // ---- Masters (Phase 24) ----
  {
    path: "/masters/catalog",
    module: "catalog",
    title: "Cars & Variants",
    note: "Prices come from the TKM price list. Tax data on the variant is used by the RTO formula; content and photos are for the quote and the customer.",
    mastersGroup: "Catalog",
    tabs: [
      catalog.table("models", "Cars", "models"),
      catalog.table("variants", "Variants", "variants"),
      catalog.table("colours", "Colours", "colors"),
      catalog.table("variant-colours", "Variant colours", "variant-colors"),
      catalog.tool("photos", "Colour photos", () => import("@/pages/masters/catalog/ColourPhotos"), "Colour Photos"),
      catalog.tool("content", "Variant content", () => import("@/pages/masters/catalog/VariantContent"), "Variant Content"),
      catalog.table("accessories", "Accessories", "accessories"),
      catalog.tool("accessory-check", "Accessories by variant", () => import("@/pages/masters/catalog/AccessoriesByVariant"), "Accessories by Variant"),
      catalog.table("ew", "Extended warranty", "ew-prices"),
      catalog.table("ceramic", "TGLOSS", "ceramic-coating"),
    ],
  },
  {
    path: "/masters/insurance",
    module: "insurance_rates",
    title: "Insurance Rates",
    note: "Premium = OD less the highest enabled discount + TP + other charges + add-ons (% of IDV) + 18% GST. When the price list prints an insurance option, that is used instead.",
    mastersGroup: "Insurance",
    tabs: [
      insurance.tool("compare", "Compare insurers", () => import("@/pages/masters/insurance/Compare"), "Compare Insurers"),
      insurance.table("rates", "Variant rates", "insurance-rates"),
      insurance.table("od", "OD discounts", "insurance-od-discounts"),
      insurance.table("addon-rates", "Add-on rates", "insurance-addon-rates"),
      insurance.table("other", "Other charges", "insurance-other-charges"),
      insurance.table("tp", "TP type per variant", "variant-tp-types"),
      insurance.table("providers", "Insurers", "insurance-providers"),
      insurance.table("addons", "Add-ons", "insurance-addons"),
    ],
  },
  {
    path: "/masters/rto",
    module: "rto_settings",
    title: "RTO Settings",
    note: "Normal: the list's fixed charges + MV tax (ex-showroom × the price-list row's rate) + surcharge + the row's green tax and extra charges; a row with no MV tax rate uses the printed figure. BH = ex/(1+GST) × rate ÷ 6 + fixed charges + BH fee. Scrap: 26% of tax + surcharge off, at most ₹1,00,000. Transfer: flat.",
    mastersGroup: "RTO",
    tabs: [
      rto.tool("calc", "Calculator", () => import("@/pages/masters/rto/Calculator"), "RTO Calculator"),
      rto.table("fixed", "Fixed charges", "rto-settings"),
      rto.table("pricing", "RTO price table", "rto-pricing"),
      rto.table("settings", "Rates & caps", "pricing-config"),
    ],
  },
  {
    path: "/masters/schemes",
    module: "schemes",
    title: "Schemes",
    note: "Enter a scheme from its start date: it closes the revision it falls in and runs until the next one. One corporate and one loyalty scheme per deal; exchange and scrappage never together.",
    mastersGroup: "Schemes",
    tabs: [
      schemes.tool("revisions", "Schemes", () => import("@/pages/masters/schemes/Revisions"), "Scheme Revisions"),
      schemes.tool("bulk", "Bulk entry (CSV)", () => import("@/pages/masters/schemes/Bulk"), "Bulk Scheme Entry"),
      schemes.table("categories", "Categories", "scheme-master"),
      schemes.table("conditions", "Conditions", "scheme-conditions"),
    ],
  },

  // ---- Screens that do one job, behind one menu entry ----
  // Finance Cases: the stage pipeline and the multi-bank desk (verification).
  {
    path: "/finance",
    module: "finance_cases",
    tabs: [
      screen("pipeline", "Pipeline", "finance_cases", ported(() => import("@/pages/staff/finance/page"))),
      screen("desk", "All banks & verification", "finance_desk", lazy(() => import("@/pages/finance/Desk"))),
    ],
  },
  // CRM Billing: the CTDMS tracker and the invoice queue (Stock → Billing).
  {
    path: "/ops-billing/crm-billing",
    module: "ops_crm_billing",
    tabs: [
      screen("crm", "CRM billing", "ops_crm_billing", stage("CrmBillingStage")),
      screen("invoices", "Invoice queue", "stock_billing", ported(() => import("@/pages/staff/stock/billing/page"))),
    ],
  },
  // Payment Receipts: the receipt register and clearance / what customers still owe.
  {
    path: "/ops-billing/receipts",
    module: "ops_receipts",
    tabs: [
      screen("receipts", "Receipts", "ops_receipts", stage("ReceiptsStage")),
      screen("clearance", "Clearance & dues", "payments", ported(() => import("@/pages/staff/payments/page"))),
    ],
  },
  // Exchange: evaluations (request, value, buy in) and the deal desk.
  {
    path: "/used-cars/exchange",
    module: "used_car_exchange",
    tabs: [
      screen("evaluations", "Evaluations", "used_car_evaluations", lazy(() => import("@/pages/used/Evaluations"))),
      screen("deals", "Deals, inspection & outside cars", "used_car_exchange", lazy(() => import("@/pages/used/Exchange"))),
    ],
  },
];

export const tabHref = (s: TabbedScreen, t: ScreenTab) => `${s.path}/${t.id}`;

// Anyone who may open any tab may open the screen (it then shows only those tabs). Keyed by path.
export const screenModules: Record<string, string[]> = Object.fromEntries(
  tabbedScreens.map((s) => [s.path, [...new Set(s.tabs.flatMap((t) => t.modules))]]),
);

// The tab that holds this master table, if one does.
export function masterTabFor(slug: string): { href: string; modules: string[] } | undefined {
  for (const s of tabbedScreens) {
    const t = s.tabs.find((x) => x.entity === slug);
    if (t) return { href: tabHref(s, t), modules: t.modules };
  }
  return undefined;
}

// Old addresses of screens that are now a tab: they only redirect, so bookmarks and old links work.
// (Old ?tab= links on a tabbed screen are redirected by the screen itself.)
export const movedScreens: Record<string, string> = {
  "/stock/billing": "/ops-billing/crm-billing/invoices",
  "/payments": "/ops-billing/receipts/clearance",
  "/used-cars/evaluations": "/used-cars/exchange/evaluations",
  ...Object.fromEntries(
    tabbedScreens.flatMap((s) => s.tabs.flatMap((t) => (t.entity ? [[`/admin/${t.entity}`, tabHref(s, t)]] : []))),
  ),
};
