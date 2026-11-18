import type { createClient } from "@/lib/supabase/server";

// Period handling and the pipeline functions (20261103000001_pipeline_reports.sql). The functions run
// as the signed-in user, so every number is limited to what that person may see.

type Client = Awaited<ReturnType<typeof createClient>>;

export type Activity = {
  outlet_id: string;
  employee_id: string | null;
  enquiries: number;
  test_drives: number;
  quotes: number;
  final_quotes: number;
  bookings: number;
  allotted: number;
  billed: number;
  delivered: number;
  cancelled: number;
  lost: number;
};

export type Snapshot = {
  outlet_id: string;
  employee_id: string | null;
  open_enquiries: number;
  quoted_enquiries: number;
  quotes_awaiting_approval: number;
  awaiting_car: number;
  allotted: number;
  with_accounts: number;
  billed_not_delivered: number;
  on_hold: number;
  cancel_requested: number;
};

export type Breakdown = { kind: "source" | "lost_reason" | "cancel_reason" | "model"; label: string; total: number; converted: number };

export type Ageing = {
  outlet_id: string;
  source: "transit" | "physical";
  age_band: "0-30" | "31-60" | "61-90" | "90+" | "unknown";
  cars: number;
  free_cars: number;
  interest: number;
  invoice_value: number;
};

export const ACTIVITY_KEYS = [
  "enquiries", "test_drives", "quotes", "final_quotes", "bookings", "allotted", "billed", "delivered", "cancelled", "lost",
] as const;
export const SNAPSHOT_KEYS = [
  "open_enquiries", "quoted_enquiries", "quotes_awaiting_approval", "awaiting_car", "allotted", "with_accounts",
  "billed_not_delivered", "on_hold", "cancel_requested",
] as const;

export const PRESETS = [
  { id: "month", name: "This month" },
  { id: "last_month", name: "Last month" },
  { id: "90d", name: "Last 90 days" },
  { id: "fy", name: "This financial year" },
  { id: "custom", name: "Custom dates" },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);

// Today's date in India, independent of the server's time zone.
export function todayIst() {
  return iso(new Date(Date.now() + 5.5 * 3_600_000));
}

export function resolvePeriod(params: Record<string, string | undefined>) {
  const today = todayIst();
  const [y, m] = today.split("-").map(Number);
  const preset = PRESETS.some((p) => p.id === params.period) ? params.period! : params.from || params.to ? "custom" : "month";
  let from: string;
  let to = today;
  if (preset === "last_month") {
    from = iso(new Date(Date.UTC(y, m - 2, 1)));
    to = iso(new Date(Date.UTC(y, m - 1, 0)));
  } else if (preset === "90d") {
    from = iso(new Date(Date.UTC(y, m - 1, Number(today.slice(8)) - 89)));
  } else if (preset === "fy") {
    from = iso(new Date(Date.UTC(m >= 4 ? y : y - 1, 3, 1)));
  } else if (preset === "custom") {
    from = params.from || iso(new Date(Date.UTC(y, m - 1, 1)));
    to = params.to || today;
  } else {
    from = iso(new Date(Date.UTC(y, m - 1, 1)));
  }
  if (from > to) [from, to] = [to, from];
  return { preset, from, to, outletId: params.outlet_id || null };
}

export async function loadActivity(supabase: Client, from: string, to: string, outletId: string | null) {
  const { data, error } = await supabase.rpc("pipeline_activity", { p_from: from, p_to: to, p_outlet_id: outletId });
  if (error) throw new Error(error.message);
  return (data ?? []) as Activity[];
}

export async function loadSnapshot(supabase: Client, outletId: string | null) {
  const { data, error } = await supabase.rpc("pipeline_snapshot", { p_outlet_id: outletId });
  if (error) throw new Error(error.message);
  return (data ?? []) as Snapshot[];
}

export async function loadBreakdowns(supabase: Client, from: string, to: string, outletId: string | null) {
  const { data, error } = await supabase.rpc("pipeline_breakdowns", { p_from: from, p_to: to, p_outlet_id: outletId });
  if (error) throw new Error(error.message);
  return (data ?? []) as Breakdown[];
}

export async function loadAgeing(supabase: Client, outletId: string | null) {
  const { data, error } = await supabase.rpc("stock_ageing", { p_outlet_id: outletId });
  if (error) throw new Error(error.message);
  return (data ?? []) as Ageing[];
}

// Adds rows up by a key (null key = everything together).
export function sumBy<T extends Record<string, unknown>, K extends keyof T>(
  rows: T[],
  keys: readonly K[],
  groupBy: (r: T) => string | null = () => null,
) {
  const out = new Map<string | null, Record<K, number>>();
  for (const r of rows) {
    const g = groupBy(r);
    const acc = out.get(g) ?? (Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>);
    for (const k of keys) acc[k] += Number(r[k] ?? 0);
    out.set(g, acc);
  }
  return out;
}

export const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");
export const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
export const fmtDay = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
