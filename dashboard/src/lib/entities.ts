// Config-driven CRUD: one generic page + form renders every master-data table below. Adding a
// new manageable table means adding an entry here, not a new page.

export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "date"
  | "select"
  | "foreign_key"
  | "text_array";

export interface FieldConfig {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  foreignTable?: string;
  foreignLabelKey?: string;
  hideInTable?: boolean;
  step?: string;
}

export interface EntityConfig {
  slug: string;
  table: string;
  title: string;
  description?: string;
  orderBy?: string;
  fields: FieldConfig[];
}

export const entityGroups: { title: string; entities: EntityConfig[] }[] = [
  {
    title: "Catalog",
    entities: [
      {
        slug: "models",
        table: "models",
        title: "Models",
        orderBy: "name",
        fields: [
          { key: "name", label: "Name", type: "text", required: true },
          { key: "segment", label: "Segment", type: "text" },
          { key: "is_active", label: "Active", type: "boolean" },
        ],
      },
      {
        slug: "fuel-types",
        table: "fuel_types",
        title: "Fuel Types",
        orderBy: "name",
        fields: [{ key: "name", label: "Name", type: "text", required: true }],
      },
      {
        slug: "transmissions",
        table: "transmissions",
        title: "Transmissions",
        orderBy: "name",
        fields: [{ key: "name", label: "Name", type: "text", required: true }],
      },
      {
        slug: "variants",
        table: "variants",
        title: "Variants",
        orderBy: "name",
        fields: [
          { key: "model_id", label: "Model", type: "foreign_key", foreignTable: "models", required: true },
          { key: "fuel_type_id", label: "Fuel Type", type: "foreign_key", foreignTable: "fuel_types", required: true },
          { key: "transmission_id", label: "Transmission", type: "foreign_key", foreignTable: "transmissions", required: true },
          { key: "suffix", label: "Suffix", type: "text", required: true },
          { key: "name", label: "Name", type: "text", required: true },
          { key: "is_active", label: "Active", type: "boolean" },
        ],
      },
      {
        slug: "colors",
        table: "colors",
        title: "Colors",
        orderBy: "name",
        fields: [
          { key: "name", label: "Name", type: "text", required: true },
          { key: "hex", label: "Hex", type: "text" },
          { key: "is_dual_tone", label: "Dual Tone", type: "boolean" },
        ],
      },
      {
        slug: "variant-colors",
        table: "variant_colors",
        title: "Variant ↔ Color availability",
        description: "Which colors are offered for which variant, and any extra dealer upcharge.",
        fields: [
          { key: "variant_id", label: "Variant", type: "foreign_key", foreignTable: "variants", foreignLabelKey: "name", required: true },
          { key: "color_id", label: "Color", type: "foreign_key", foreignTable: "colors", required: true },
          { key: "extra_cost", label: "Extra Cost", type: "number", step: "0.01" },
        ],
      },
      {
        slug: "price-list",
        table: "price_list",
        title: "Price List",
        description: "Ex-showroom pricing by variant, color, and state, with effective dating.",
        orderBy: "effective_from",
        fields: [
          { key: "variant_id", label: "Variant", type: "foreign_key", foreignTable: "variants", foreignLabelKey: "name", required: true },
          { key: "color_id", label: "Color", type: "foreign_key", foreignTable: "colors", required: true },
          { key: "state", label: "State", type: "text", required: true },
          { key: "ex_showroom_price", label: "Ex-Showroom Price", type: "number", step: "0.01", required: true },
          { key: "dealer_purchase_price", label: "Dealer Purchase Price", type: "number", step: "0.01" },
          { key: "effective_from", label: "Effective From", type: "date", required: true },
          { key: "effective_to", label: "Effective To", type: "date" },
        ],
      },
    ],
  },
  {
    title: "Schemes",
    entities: [
      {
        slug: "schemes",
        table: "schemes",
        title: "Schemes",
        orderBy: "valid_from",
        fields: [
          { key: "model_id", label: "Model", type: "foreign_key", foreignTable: "models", required: true },
          { key: "suffix_scope_list", label: "Suffix Scope (comma-separated codes, blank = all)", type: "text_array" },
          { key: "name", label: "Name", type: "text", required: true },
          { key: "valid_from", label: "Valid From", type: "date", required: true },
          { key: "valid_to", label: "Valid To", type: "date", required: true },
        ],
      },
      {
        slug: "scheme-line-items",
        table: "scheme_line_items",
        title: "Scheme Line Items",
        description: "Individual discount/incentive lines within a scheme. Mark is_customer_facing = off for dealer/TKM-only margin items — these are never shown on a customer quote.",
        fields: [
          { key: "scheme_id", label: "Scheme", type: "foreign_key", foreignTable: "schemes", required: true },
          { key: "line_type", label: "Line Type", type: "text", required: true },
          { key: "tkm_share", label: "TKM Share", type: "number", step: "0.01" },
          { key: "dealer_share", label: "Dealer Share", type: "number", step: "0.01" },
          { key: "is_customer_facing", label: "Customer Facing", type: "boolean" },
        ],
      },
      {
        slug: "scheme-conditions",
        table: "scheme_conditions",
        title: "Scheme Conditions",
        description: "Mutually-exclusive groups render as a radio choice on the quote wizard instead of independent checkboxes.",
        fields: [
          { key: "scheme_line_item_id", label: "Scheme Line Item", type: "foreign_key", foreignTable: "scheme_line_items", foreignLabelKey: "line_type", required: true },
          { key: "mutually_exclusive_group", label: "Mutually Exclusive Group", type: "text" },
          { key: "requires_exchange", label: "Requires Exchange", type: "boolean" },
          { key: "requires_scrap", label: "Requires Scrap", type: "boolean" },
        ],
      },
    ],
  },
  {
    title: "RTO",
    entities: [
      {
        slug: "rto-categories",
        table: "rto_categories",
        title: "RTO Categories",
        orderBy: "name",
        fields: [{ key: "name", label: "Name", type: "text", required: true }],
      },
      {
        slug: "rto-pricing",
        table: "rto_pricing",
        title: "RTO Pricing",
        description: "Scope to a variant to override the model-level default.",
        orderBy: "effective_from",
        fields: [
          { key: "rto_category_id", label: "RTO Category", type: "foreign_key", foreignTable: "rto_categories", required: true },
          { key: "state", label: "State", type: "text", required: true },
          { key: "model_id", label: "Model (leave blank if variant-scoped)", type: "foreign_key", foreignTable: "models" },
          { key: "variant_id", label: "Variant (leave blank if model-scoped)", type: "foreign_key", foreignTable: "variants", foreignLabelKey: "name" },
          { key: "amount", label: "Amount", type: "number", step: "0.01", required: true },
          { key: "effective_from", label: "Effective From", type: "date", required: true },
          { key: "effective_to", label: "Effective To", type: "date" },
        ],
      },
    ],
  },
  {
    title: "Insurance",
    entities: [
      {
        slug: "insurance-providers",
        table: "insurance_providers",
        title: "Insurance Providers",
        orderBy: "name",
        fields: [{ key: "name", label: "Name", type: "text", required: true }],
      },
      {
        slug: "insurance-plans",
        table: "insurance_plans",
        title: "Insurance Plans",
        fields: [
          { key: "provider_id", label: "Provider", type: "foreign_key", foreignTable: "insurance_providers", required: true },
          { key: "coverage_type", label: "Coverage Type", type: "text", required: true },
          {
            key: "pricing_basis",
            label: "Pricing Basis",
            type: "select",
            required: true,
            options: [
              { value: "idv_percentage", label: "IDV Percentage" },
              { value: "flat", label: "Flat" },
              { value: "slab", label: "Slab" },
            ],
          },
          { key: "base_rate", label: "Base Rate", type: "number", step: "0.01", required: true },
        ],
      },
      {
        slug: "insurance-addons",
        table: "insurance_addons",
        title: "Insurance Add-ons",
        orderBy: "name",
        fields: [
          { key: "name", label: "Name", type: "text", required: true },
          { key: "price", label: "Price", type: "number", step: "0.01", required: true },
        ],
      },
      {
        slug: "idv-slabs",
        table: "idv_slabs",
        title: "IDV Depreciation Slabs",
        description: "Placeholder slabs from Phase 0 — confirm the real TKM/insurer depreciation table.",
        orderBy: "min_age_months",
        fields: [
          { key: "min_age_months", label: "Min Age (months)", type: "number", required: true },
          { key: "max_age_months", label: "Max Age (months)", type: "number", required: true },
          { key: "depreciation_percentage", label: "Depreciation %", type: "number", step: "0.01", required: true },
        ],
      },
    ],
  },
  {
    title: "Accessories & VAS",
    entities: [
      {
        slug: "accessories",
        table: "accessories",
        title: "Accessories",
        orderBy: "name",
        fields: [
          { key: "model_id", label: "Model (optional)", type: "foreign_key", foreignTable: "models" },
          { key: "variant_id", label: "Variant (optional)", type: "foreign_key", foreignTable: "variants", foreignLabelKey: "name" },
          { key: "name", label: "Name", type: "text", required: true },
          { key: "part_no", label: "Part No.", type: "text" },
          { key: "price", label: "Price", type: "number", step: "0.01", required: true },
        ],
      },
      {
        slug: "vas-products",
        table: "vas_products",
        title: "VAS Products",
        orderBy: "name",
        fields: [
          { key: "name", label: "Name", type: "text", required: true },
          {
            key: "pricing_type",
            label: "Pricing Type",
            type: "select",
            required: true,
            options: [
              { value: "flat", label: "Flat" },
              { value: "slab_by_model", label: "Slab by Model" },
            ],
          },
          { key: "price", label: "Price", type: "number", step: "0.01", required: true },
          { key: "tenure_months", label: "Tenure (months)", type: "number" },
        ],
      },
    ],
  },
  {
    title: "Approvals",
    entities: [
      {
        slug: "approval-rules",
        table: "approval_rules",
        title: "Approval Rules",
        description: "Discount thresholds that trigger a mandatory approval before a quote/booking can be shared or confirmed.",
        fields: [
          { key: "outlet_id", label: "Outlet (blank = org-wide)", type: "foreign_key", foreignTable: "outlets" },
          { key: "discount_threshold", label: "Discount Threshold", type: "number", step: "0.01", required: true },
          { key: "required_role_id", label: "Required Approver Role", type: "foreign_key", foreignTable: "roles", required: true },
        ],
      },
    ],
  },
  {
    title: "Organization",
    entities: [
      {
        slug: "outlets",
        table: "outlets",
        title: "Outlets",
        orderBy: "name",
        fields: [
          { key: "name", label: "Name", type: "text", required: true },
          { key: "dealer_code", label: "Dealer Code (CTDMS)", type: "text" },
          { key: "city", label: "City", type: "text" },
          { key: "state", label: "State", type: "text" },
          { key: "address", label: "Address", type: "textarea" },
          { key: "is_active", label: "Active", type: "boolean" },
        ],
      },
      {
        slug: "employees",
        table: "employees",
        title: "Employees",
        description: "Role + outlet + manager assignment drives both approval routing and RLS visibility.",
        orderBy: "name",
        fields: [
          { key: "name", label: "Name", type: "text", required: true },
          { key: "phone", label: "Phone", type: "text" },
          { key: "email", label: "Email", type: "text" },
          { key: "role_id", label: "Role", type: "foreign_key", foreignTable: "roles", required: true },
          { key: "outlet_id", label: "Outlet", type: "foreign_key", foreignTable: "outlets" },
          { key: "reports_to_employee_id", label: "Reports To", type: "foreign_key", foreignTable: "employees", foreignLabelKey: "name" },
          { key: "is_active", label: "Active", type: "boolean" },
        ],
      },
    ],
  },
  {
    title: "Configuration",
    entities: [
      {
        slug: "tax-config",
        table: "tax_config",
        title: "Tax Config (TCS)",
        description: "STUB rate from Phase 0 — confirm the current TCS % with finance.",
        fields: [
          { key: "name", label: "Name", type: "text", required: true },
          { key: "rate_percentage", label: "Rate %", type: "number", step: "0.01", required: true },
          { key: "effective_from", label: "Effective From", type: "date", required: true },
          { key: "effective_to", label: "Effective To", type: "date" },
        ],
      },
    ],
  },
];

export function findEntity(slug: string): EntityConfig | undefined {
  for (const group of entityGroups) {
    const entity = group.entities.find((e) => e.slug === slug);
    if (entity) return entity;
  }
  return undefined;
}
