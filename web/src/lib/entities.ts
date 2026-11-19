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
  /** Worked out by the database: shown and exported, never edited or imported. */
  readOnly?: boolean;
  step?: string;
}

export interface EntityConfig {
  slug: string;
  // Still reachable at /admin/<slug>, but not listed under Masters (another menu has the full screen).
  hideInMenu?: boolean;
  table: string;
  title: string;
  description?: string;
  orderBy?: string;
  /** Dated rows: show only the ones in effect today, with a toggle for the rest. */
  currentOnly?: { fromKey: string; toKey: string };
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
          { key: "tkm_model_code", label: "TKM Model Code (e.g. D22)", type: "text" },
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
        description:
          "Where TKM gives one configuration a suffix per interior (Fortuner 4x2 AT: FRNBK Black, FRNCK Chamois), " +
          "the suffixes are stock codes under one sales variant: set their Sales Variant, and keep the price list " +
          "and colours on the sales variant only. Quotes pick the sales variant and an interior; the interior picks the stock code.",
        orderBy: "name",
        fields: [
          { key: "model_id", label: "Model", type: "foreign_key", foreignTable: "models", required: true },
          { key: "fuel_type_id", label: "Fuel Type", type: "foreign_key", foreignTable: "fuel_types", required: true },
          { key: "transmission_id", label: "Transmission", type: "foreign_key", foreignTable: "transmissions", required: true },
          { key: "suffix", label: "Suffix", type: "text", required: true },
          { key: "tkm_suffix_code", label: "TKM Suffix Code (e.g. D22U4)", type: "text" },
          { key: "old_suffix_code", label: "Old Suffix Code", type: "text", hideInTable: true },
          { key: "name", label: "Name", type: "text", required: true },
          { key: "sales_variant_id", label: "Sales Variant (for a TKM stock code)", type: "foreign_key", foreignTable: "variants", foreignLabelKey: "name" },
          { key: "gst_rate_percent", label: "GST %", type: "number", step: "0.01", hideInTable: true },
          { key: "engine_cc", label: "Engine cc", type: "number", hideInTable: true },
          { key: "hsn_code", label: "HSN Code (8 digits)", type: "text", hideInTable: true },
          { key: "is_ev", label: "Electric (EV)", type: "boolean", hideInTable: true },
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
          { key: "tkm_color_code", label: "TKM Colour Code", type: "text" },
          {
            key: "paint_category",
            label: "Paint (price-list row)",
            type: "select",
            required: true,
            options: [
              { value: "standard", label: "Standard" },
              { value: "pearl_white", label: "Pearl White" },
              { value: "dual_tone", label: "Dual Tone" },
            ],
          },
          { key: "is_dual_tone", label: "Dual Tone", type: "boolean" },
        ],
      },
      {
        slug: "variant-colors",
        table: "variant_colors",
        title: "Variant ↔ Color availability",
        description:
          "Which colors are offered for which variant. Every colour is sold at the variant's price-list price; " +
          "enter a price difference only for a colour that costs more (e.g. Pearl White +20,000) or less. " +
          "RTO and TCS are worked out on the price including this difference.",
        fields: [
          { key: "variant_id", label: "Variant", type: "foreign_key", foreignTable: "variants", foreignLabelKey: "name", required: true },
          { key: "color_id", label: "Color", type: "foreign_key", foreignTable: "colors", required: true },
          { key: "extra_cost", label: "Price Difference (vs variant price)", type: "number", step: "0.01" },
        ],
      },
      {
        slug: "interior-colors",
        table: "interior_colors",
        title: "Interior Colors",
        orderBy: "name",
        fields: [
          { key: "name", label: "Name", type: "text", required: true },
          { key: "is_active", label: "Active", type: "boolean" },
        ],
      },
      {
        slug: "variant-interior-colors",
        table: "variant_interior_colors",
        title: "Variant ↔ Interior Color",
        description:
          "Which interiors each variant comes in. A variant with one interior gets it filled in on quotes and " +
          "bookings automatically; with two or more (e.g. Black or Maroon), the interior is picked on the quote.",
        fields: [
          { key: "variant_id", label: "Variant", type: "foreign_key", foreignTable: "variants", foreignLabelKey: "name", required: true },
          { key: "interior_color_id", label: "Interior Color", type: "foreign_key", foreignTable: "interior_colors", required: true },
        ],
      },
      {
        slug: "price-list",
        table: "price_list",
        title: "Price List",
        description:
          "One row per variant, list (private / commercial / CSD) and state, with effective dating. The price applies to " +
          "every colour; colour price differences are set in Variant ↔ Color. RTO (Normal) is worked out as in Techwheels: " +
          "the list's fixed charges (RTO Settings) + MV tax at this row's rate + 12.5% surcharge + green tax + extra charges. " +
          "A row with no MV tax rate uses the printed Road Tax & Registration.",
        orderBy: "effective_from",
        currentOnly: { fromKey: "effective_from", toKey: "effective_to" },
        fields: [
          { key: "variant_id", label: "Variant", type: "foreign_key", foreignTable: "variants", foreignLabelKey: "name", required: true },
          {
            key: "list_type",
            label: "List",
            type: "select",
            required: true,
            options: [
              { value: "private", label: "Private" },
              { value: "commercial", label: "Commercial" },
              { value: "csd", label: "CSD" },
            ],
          },
          { key: "state", label: "State", type: "text", required: true },
          { key: "ex_showroom_price", label: "Ex-Showroom Price", type: "number", step: "0.01", required: true },
          { key: "tcs_amount", label: "TCS (as printed)", type: "number", step: "0.01", hideInTable: true },
          { key: "mv_tax_rate", label: "MV Tax Rate (%)", type: "number", step: "any" },
          { key: "green_tax", label: "Green Tax", type: "number", step: "0.01", hideInTable: true },
          { key: "extra_rto_charges", label: "Extra RTO Charges (e.g. fitness)", type: "number", step: "0.01", hideInTable: true },
          { key: "rto_amount", label: "RTO (Normal)", type: "number", readOnly: true },
          { key: "road_tax_registration", label: "Road Tax & Registration (as printed)", type: "number", step: "0.01", hideInTable: true },
          { key: "fastag_amount", label: "FASTag", type: "number", step: "0.01", hideInTable: true },
          { key: "ew_5th_year_amount", label: "True Warranty 5th Year", type: "number", step: "0.01", hideInTable: true },
          { key: "tgloss_package_amount", label: "TGLOSS Package", type: "number", step: "0.01", hideInTable: true },
          { key: "tga_combo_amount", label: "TGA Combo", type: "number", step: "0.01", hideInTable: true },
          { key: "on_road_listed", label: "On-Road (as printed)", type: "number", step: "0.01" },
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
          { key: "scheme_master_code", label: "Category (scheme master code)", type: "text" },
          { key: "tkm_share", label: "TKM Share", type: "number", step: "0.01" },
          { key: "dealer_share", label: "Dealer Share", type: "number", step: "0.01" },
          { key: "prev_my_tkm_share", label: "TKM Share (previous MY)", type: "number", step: "0.01", hideInTable: true },
          { key: "prev_my_dealer_share", label: "Dealer Share (previous MY)", type: "number", step: "0.01", hideInTable: true },
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
      {
        slug: "scheme-master",
        table: "scheme_master",
        title: "Scheme Categories",
        description: "One corporate and one loyalty scheme per deal; exchange and scrappage never together.",
        orderBy: "code",
        fields: [
          { key: "code", label: "Code", type: "text", required: true },
          { key: "name", label: "Name", type: "text", required: true },
          {
            key: "category",
            label: "Category",
            type: "select",
            required: true,
            options: [
              { value: "upfront", label: "Upfront" },
              { value: "corporate", label: "Corporate" },
              { value: "exchange", label: "Exchange" },
              { value: "scrappage", label: "Scrappage" },
              { value: "loyalty", label: "Loyalty" },
              { value: "additional", label: "Additional" },
            ],
          },
          { key: "has_company_share", label: "TKM shares the cost", type: "boolean" },
          { key: "is_active", label: "Active", type: "boolean" },
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
        slug: "rto-settings",
        table: "rto_settings",
        title: "RTO Settings",
        description:
          "Fixed RTO charges for each price list, from the RTO calculation sheet. RTO (Normal registration) = these " +
          "charges + MV tax (ex-showroom incl. colour difference × the price-list row's MV tax rate) + surcharge on MV " +
          "tax + the row's green tax and extra charges. EVs pay no MV tax, surcharge or green tax.",
        orderBy: "list_type",
        fields: [
          {
            key: "list_type",
            label: "List",
            type: "select",
            required: true,
            options: [
              { value: "private", label: "Private" },
              { value: "commercial", label: "Commercial" },
              { value: "csd", label: "CSD" },
            ],
          },
          { key: "rc_charge", label: "RC", type: "number", step: "0.01", required: true },
          { key: "tcc_charge", label: "TCC", type: "number", step: "0.01", required: true },
          { key: "hpn_charge", label: "HPN", type: "number", step: "0.01", required: true },
          { key: "smart_card_charge", label: "Smart Card", type: "number", step: "0.01", required: true },
          { key: "number_plate_charge", label: "Number Plate", type: "number", step: "0.01", required: true },
          { key: "service_charge", label: "Service Charge", type: "number", step: "0.01", required: true },
          { key: "other_charges", label: "Other Charges", type: "number", step: "0.01", required: true },
          { key: "surcharge_percent", label: "Surcharge on MV Tax (%)", type: "number", step: "0.001", required: true },
          { key: "bh_processing_fee", label: "BH processing fee", type: "number", step: "0.01" },
          { key: "notes", label: "Notes", type: "text", hideInTable: true },
        ],
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
        fields: [
          { key: "name", label: "Name", type: "text", required: true },
          { key: "is_active", label: "Active", type: "boolean" },
        ],
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
          { key: "price", label: "Price (flat, old plans)", type: "number", step: "0.01", required: true },
          { key: "is_mandatory", label: "Always included", type: "boolean" },
          { key: "ev_only", label: "EV only", type: "boolean" },
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
      {
        slug: "insurance-rates",
        table: "insurance_rates",
        title: "Insurance Rates (per variant)",
        description: "IDV (blank = ex-showroom × 95%), OD and TP premiums and other charges per variant and TP type.",
        orderBy: "effective_from",
        fields: [
          { key: "variant_id", label: "Variant", type: "foreign_key", foreignTable: "variants", foreignLabelKey: "name", required: true },
          { key: "tp_type_code", label: "TP type", type: "select", required: true, options: [{ value: "1+3", label: "1 yr OD + 3 yr TP" }, { value: "3+3", label: "3 yr OD + 3 yr TP" }] },
          { key: "idv_amount", label: "IDV", type: "number", step: "0.01" },
          { key: "od_amount", label: "OD premium", type: "number", step: "0.01", required: true },
          { key: "tp_amount", label: "TP premium", type: "number", step: "0.01", required: true },
          { key: "other_charges", label: "Other charges", type: "number", step: "0.01" },
          { key: "effective_from", label: "Effective From", type: "date", required: true },
          { key: "effective_to", label: "Effective To", type: "date" },
        ],
      },
      {
        slug: "insurance-od-discounts",
        table: "insurance_od_discounts",
        title: "OD Discount Options",
        description: "The highest enabled discount is applied to the OD premium.",
        fields: [
          { key: "variant_id", label: "Variant", type: "foreign_key", foreignTable: "variants", foreignLabelKey: "name", required: true },
          { key: "discount_percent", label: "Discount %", type: "number", step: "0.01", required: true },
          { key: "is_enabled", label: "Enabled", type: "boolean" },
        ],
      },
      {
        slug: "insurance-addon-rates",
        table: "insurance_addon_rates",
        title: "Add-on Rates (per insurer)",
        description: "% of IDV, per insurer, add-on and TP type. An insurer without a rate for an always-included add-on cannot quote.",
        fields: [
          { key: "provider_id", label: "Insurer", type: "foreign_key", foreignTable: "insurance_providers", required: true },
          { key: "addon_id", label: "Add-on", type: "foreign_key", foreignTable: "insurance_addons", required: true },
          { key: "tp_type_code", label: "TP type", type: "select", required: true, options: [{ value: "1+3", label: "1 yr OD + 3 yr TP" }, { value: "3+3", label: "3 yr OD + 3 yr TP" }] },
          { key: "rate_percent", label: "Rate (% of IDV)", type: "number", step: "0.001", required: true },
        ],
      },
      {
        slug: "insurance-other-charges",
        table: "insurance_other_charges",
        title: "Other Charges (per TP type)",
        fields: [
          { key: "tp_type_code", label: "TP type", type: "select", required: true, options: [{ value: "1+3", label: "1 yr OD + 3 yr TP" }, { value: "3+3", label: "3 yr OD + 3 yr TP" }] },
          { key: "amount", label: "Amount", type: "number", step: "0.01", required: true },
        ],
      },
      {
        slug: "variant-tp-types",
        table: "variant_tp_types",
        title: "Default TP Type per Variant",
        fields: [
          { key: "variant_id", label: "Variant", type: "foreign_key", foreignTable: "variants", foreignLabelKey: "name", required: true },
          { key: "tp_type_code", label: "TP type", type: "select", required: true, options: [{ value: "1+3", label: "1 yr OD + 3 yr TP" }, { value: "3+3", label: "3 yr OD + 3 yr TP" }] },
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
          { key: "category", label: "Category", type: "text" },
          { key: "price", label: "Price", type: "number", step: "0.01", required: true },
          { key: "sort_order", label: "Order-form S.No", type: "number", hideInTable: true },
          { key: "is_universal", label: "Universal (all models)", type: "boolean", hideInTable: true },
          { key: "excluded_model_ids", label: "Excluded model ids (universal only, comma-separated)", type: "text_array", hideInTable: true },
          { key: "is_top", label: "Top pick", type: "boolean" },
          { key: "top_order", label: "Top pick order", type: "number", hideInTable: true },
          { key: "is_pack", label: "Pack", type: "boolean", hideInTable: true },
          { key: "variant_group", label: "Variant group", type: "text", hideInTable: true },
          { key: "warranty_years", label: "Warranty (years)", type: "number", hideInTable: true },
          { key: "is_active", label: "Active", type: "boolean" },
        ],
      },
      {
        slug: "vas-products",
        table: "vas_products",
        title: "VAS Products",
        orderBy: "name",
        fields: [
          { key: "model_id", label: "Model (blank = all)", type: "foreign_key", foreignTable: "models" },
          { key: "category", label: "Category", type: "text" },
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
          { key: "is_active", label: "Active", type: "boolean" },
        ],
      },
      {
        slug: "ew-prices",
        table: "ew_prices",
        title: "Extended Warranty Prices",
        description: "T-Secure customer prices (incl. GST) by model group, vehicle age at purchase and product.",
        orderBy: "model_group",
        fields: [
          { key: "model_group", label: "Model Group", type: "text", required: true },
          { key: "model_id", label: "Model", type: "foreign_key", foreignTable: "models" },
          { key: "min_age_months", label: "Age From (months)", type: "number", required: true },
          { key: "max_age_months", label: "Age To (months)", type: "number", required: true },
          {
            key: "product",
            label: "Product",
            type: "select",
            required: true,
            options: [
              { value: "true_warranty_4th_year", label: "True Warranty – 4th year" },
              { value: "true_warranty_5th_year", label: "True Warranty – 5th year" },
              { value: "driveline_5th_year", label: "Driveline – 5th year" },
              { value: "unlimited_5th_year", label: "5th year / unlimited km" },
            ],
          },
          { key: "km_limit", label: "Km Limit", type: "number" },
          { key: "price", label: "Price", type: "number", step: "0.01", required: true },
          { key: "effective_from", label: "Effective From", type: "date", required: true },
        ],
      },
      {
        slug: "ceramic-coating",
        table: "ceramic_coating_prices",
        title: "TGLOSS",
        fields: [
          { key: "model_id", label: "Model", type: "foreign_key", foreignTable: "models", required: true },
          { key: "name", label: "Name", type: "text", required: true },
          { key: "price", label: "Price", type: "number", step: "0.01", required: true },
          { key: "is_active", label: "Active", type: "boolean" },
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
        description:
          "Who approves a discount: needed when the amount is above the threshold; the highest threshold crossed decides the role. Stage blank = direct bookings.",
        fields: [
          { key: "outlet_id", label: "Outlet (blank = org-wide)", type: "foreign_key", foreignTable: "outlets" },
          {
            key: "stage",
            label: "Quote stage",
            type: "select",
            options: [
              { value: "with_schemes", label: "Company schemes" },
              { value: "with_dealer_discount", label: "Additional dealer discount" },
            ],
          },
          { key: "discount_threshold", label: "Above amount (₹)", type: "number", step: "0.01", required: true },
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
          { key: "dealer_code", label: "Dealer Code", type: "text" },
          { key: "ctdms_dealer_code", label: "CTDMS Dealer Code (e.g. JP05A)", type: "text" },
          { key: "city", label: "City", type: "text" },
          { key: "state", label: "State", type: "text" },
          { key: "address", label: "Address", type: "textarea" },
          { key: "is_active", label: "Active", type: "boolean" },
        ],
      },
      {
        slug: "employees",
        hideInMenu: true,
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
          { key: "ctdms_name", label: "Name in CTDMS (Sales Officer / Team Leader)", type: "text", hideInTable: true },
          { key: "is_active", label: "Active", type: "boolean" },
        ],
      },
      {
        slug: "hr-checklist",
        table: "hr_task_templates",
        title: "HR Checklist Items",
        description:
          "Items copied onto each new joiner's onboarding (or a leaver's offboarding) checklist. Changes apply to checklists started afterwards.",
        orderBy: "sort_order",
        fields: [
          {
            key: "kind",
            label: "Checklist",
            type: "select",
            required: true,
            options: [
              { value: "onboarding", label: "Onboarding" },
              { value: "offboarding", label: "Offboarding" },
            ],
          },
          { key: "title", label: "Item", type: "text", required: true },
          { key: "sort_order", label: "Order", type: "number", required: true },
          { key: "sales_staff_only", label: "Sales line only (Outlet Head to Consultant)", type: "boolean" },
          { key: "is_active", label: "Active", type: "boolean" },
        ],
      },
    ],
  },
  {
    title: "Finance",
    entities: [
      {
        slug: "financiers",
        hideInMenu: true,
        table: "financiers",
        title: "Financiers",
        description: "Banks and NBFCs for finance cases. Captive = Toyota Financial Services (subvention schemes).",
        orderBy: "name",
        fields: [
          { key: "name", label: "Name", type: "text", required: true },
          { key: "short_name", label: "Short name", type: "text" },
          { key: "is_captive", label: "Captive (TFS)", type: "boolean" },
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
      {
        slug: "pricing-config",
        table: "pricing_config",
        title: "Pricing Settings",
        orderBy: "key",
        fields: [
          { key: "key", label: "Setting", type: "text", required: true },
          { key: "value", label: "Value", type: "number", step: "0.01", required: true },
          { key: "note", label: "Note", type: "text" },
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
