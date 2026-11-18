// Types for the Stock Allotment Pool functions (20261113000001_stock_allotment_pool.sql).

export type PoolConfig = {
  enabled: boolean;
  base_pool_size: number;
  increment_per_vehicle: number;
  cash_payment_percentage: number;
  updated_at: string;
};

export type PoolOverviewRow = {
  variant_id: string;
  color_id: string;
  model_name: string;
  variant_name: string;
  color_name: string;
  free_cars: number;
  pool_size: number;
  members: number;
  winners: number;
  allotted: number;
  waiting: number;
};

export type PoolPlace = "allotted" | "winner" | "member" | "queue";

export type PoolDetailRow = {
  booking_id: string;
  customer_name: string | null;
  ctdms_order_no: string | null;
  outlet: string | null;
  consultant: string | null;
  booking_date: string;
  place: PoolPlace;
  fast_tracked: boolean;
  completed_at: string | null;
  win_path: "do" | "cash" | "manual" | null;
  finance_status: string | null;
  cash_percent: number | null;
  vin: string | null;
  queue_position: number;
};

export type FinanceQueueRow = {
  booking_id: string;
  customer_name: string | null;
  customer_mobile: string | null;
  ctdms_order_no: string | null;
  outlet_id: string;
  outlet: string;
  consultant: string | null;
  model_name: string;
  variant_name: string;
  color_name: string;
  booking_date: string;
  fast_tracked: boolean;
  completed_at: string | null;
  win_path: string | null;
  finance_status: string | null;
  financier: string | null;
  do_number: string | null;
  do_date: string | null;
  deal_amount: number | null;
  cleared: number | null;
  pending: number | null;
  cash_percent: number | null;
  cash_target_percent: number;
  free_cars: number;
};

export type NonPoolRow = {
  booking_id: string;
  customer_name: string | null;
  customer_mobile: string | null;
  ctdms_order_no: string | null;
  outlet_id: string;
  outlet: string;
  consultant: string | null;
  model_name: string;
  variant_name: string;
  color_name: string;
  booking_date: string;
  finance_status: string | null;
  cash_percent: number | null;
  free_cars: number;
};

export type VnaRow = {
  booking_id: string;
  customer_name: string | null;
  customer_mobile: string | null;
  ctdms_order_no: string | null;
  outlet_id: string;
  outlet: string;
  consultant: string | null;
  model_name: string;
  variant_name: string;
  color_name: string;
  booking_date: string;
  days_waiting: number;
  queue_position: number;
  free_cars: number;
  finance_status: string | null;
  other_colors: { color_id: string; color: string; free: number }[];
  other_variants: { variant_id: string; variant: string; free: number; price_difference: number | null }[];
};

export type PoolAuditRow = {
  id: string;
  created_at: string;
  event: string;
  booking_id: string | null;
  customer_name: string | null;
  ctdms_order_no: string | null;
  vin: string | null;
  variant_name: string | null;
  color_name: string | null;
  details: Record<string, unknown>;
  by_name: string | null;
};

export const FINANCE_STAGE: Record<string, string> = {
  docs_pending: "Docs pending",
  logged_in: "Logged in",
  sanctioned: "Sanctioned",
  do_received: "DO received",
  disbursed: "Disbursed",
};

export const POOL_EVENT: Record<string, string> = {
  pool_join: "Joined pool",
  pool_bump: "Pushed out of pool",
  removed_ineligible: "Left pool (not eligible)",
  completion_banked: "Completed (DO / payment)",
  completion_unbanked: "Completion lost",
  allotted: "Car allotted",
  released: "Car taken back",
  fast_track: "Fast-tracked",
  hold: "Put on hold",
  change_vehicle: "Car changed",
  config_change: "Pool settings changed",
  engine_error: "Engine error",
};

export const winPathLabel = (p: string | null | undefined) =>
  p === "do" ? "DO" : p === "cash" ? "Cash" : p === "manual" ? "Manual" : null;

// A WhatsApp link to the customer (Indian mobile numbers), with a prefilled message.
export function whatsappLink(mobile: string | null | undefined, text: string) {
  const digits = (mobile ?? "").replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return null;
  return `https://wa.me/91${digits}?text=${encodeURIComponent(text)}`;
}
