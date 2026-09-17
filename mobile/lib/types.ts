export interface Employee {
  id: string;
  name: string;
  email: string | null;
  outletId: string | null;
  outletName: string | null;
  outletState: string | null;
  roleName: string | null;
  roleRank: number | null;
  reportsToEmployeeId: string | null;
}

export interface PriceLineItem {
  type: string;
  label: string;
  amount: number;
}

export interface PricingResult {
  as_of_date: string;
  ex_showroom_price: number;
  color_extra_cost: number;
  scheme_discount_customer_facing: number;
  tcs_rate_percentage: number;
  tcs_amount: number;
  rto_amount: number;
  scrap_amount: number;
  insurance_amount: number;
  accessories_amount: number;
  vas_amount: number;
  total_amount: number;
  dealer_margin?: number;
  line_items: PriceLineItem[];
  priced_as_of: string;
}

export interface QuoteSelections {
  variant_id: string;
  color_id: string;
  state: string;
  rto_category_id: string;
  scrap?: { source: "Rajesh Toyota" | "Self"; amount: number } | null;
  insurance_plan_id?: string | null;
  insurance_addon_ids?: string[];
  accessory_ids?: string[];
  vas_product_ids?: string[];
  selected_scheme_line_item_ids?: string[];
  has_exchange?: boolean;
  has_scrap?: boolean;
  as_of_date?: string;
}
