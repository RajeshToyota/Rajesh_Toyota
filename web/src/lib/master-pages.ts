// The Phase 24 masters pages and their tabs. A tab with `entity` is that master table's one
// address: the menu links to it and /admin/<slug> redirects there, so a table never has two pages.
// A tab without `entity` is a custom panel the page supplies.
export type MasterPageTab = { id: string; label: string; entity?: string };
export type MasterPage = { path: string; module: string; tabs: MasterPageTab[] };

export const masterPages = {
  catalog: {
    path: "/masters/catalog",
    module: "catalog",
    tabs: [
      { id: "models", label: "Cars", entity: "models" },
      { id: "variants", label: "Variants", entity: "variants" },
      { id: "colours", label: "Colours", entity: "colors" },
      { id: "variant-colours", label: "Variant colours", entity: "variant-colors" },
      { id: "photos", label: "Colour photos" },
      { id: "content", label: "Variant content" },
      { id: "accessories", label: "Accessories", entity: "accessories" },
      { id: "accessory-check", label: "Accessories by variant" },
      { id: "ew", label: "Extended warranty", entity: "ew-prices" },
      { id: "ceramic", label: "TGLOSS", entity: "ceramic-coating" },
    ],
  },
  insurance: {
    path: "/masters/insurance",
    module: "insurance_rates",
    tabs: [
      { id: "compare", label: "Compare insurers" },
      { id: "rates", label: "Variant rates", entity: "insurance-rates" },
      { id: "od", label: "OD discounts", entity: "insurance-od-discounts" },
      { id: "addon-rates", label: "Add-on rates", entity: "insurance-addon-rates" },
      { id: "other", label: "Other charges", entity: "insurance-other-charges" },
      { id: "tp", label: "TP type per variant", entity: "variant-tp-types" },
      { id: "providers", label: "Insurers", entity: "insurance-providers" },
      { id: "addons", label: "Add-ons", entity: "insurance-addons" },
    ],
  },
  rto: {
    path: "/masters/rto",
    module: "rto_settings",
    tabs: [
      { id: "calc", label: "Calculator" },
      { id: "fixed", label: "Fixed charges", entity: "rto-settings" },
      { id: "pricing", label: "RTO price table", entity: "rto-pricing" },
      { id: "settings", label: "Rates & caps", entity: "pricing-config" },
    ],
  },
  schemes: {
    path: "/masters/schemes",
    module: "schemes",
    tabs: [
      { id: "revisions", label: "Schemes" },
      { id: "bulk", label: "Bulk entry (CSV)" },
      { id: "categories", label: "Categories", entity: "scheme-master" },
      { id: "conditions", label: "Conditions", entity: "scheme-conditions" },
    ],
  },
} satisfies Record<string, MasterPage>;

export type MasterPageKey = keyof typeof masterPages;

// The masters page tab that holds this table, if one does.
export function masterTabFor(slug: string): { href: string; module: string } | undefined {
  for (const page of Object.values(masterPages) as MasterPage[]) {
    const tab = page.tabs.find((t) => t.entity === slug);
    if (tab) return { href: `${page.path}?tab=${tab.id}`, module: page.module };
  }
  return undefined;
}

export const hostedEntitySlugs = (Object.values(masterPages) as MasterPage[]).flatMap((p) => p.tabs.flatMap((t) => (t.entity ? [t.entity] : [])));
