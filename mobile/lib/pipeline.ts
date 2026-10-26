import { supabase } from "@/lib/supabase";

// "My month" numbers from the pipeline functions (20261103000001_pipeline_reports.sql). They run as
// the signed-in user, so a consultant gets their own figures and a Team Leader their team's.

export interface MonthSummary {
  enquiries: number;
  testDrives: number;
  bookings: number;
  delivered: number;
  lost: number;
  openEnquiries: number;
  openBookings: number;
}

function monthStartIst() {
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  return { from: `${today.slice(0, 8)}01`, to: today };
}

type Row = Record<string, number | string | null>;
const sum = (rows: Row[], keys: string[]) => rows.reduce((t, r) => t + keys.reduce((s, k) => s + Number(r[k] ?? 0), 0), 0);

export async function loadMonthSummary(): Promise<MonthSummary> {
  const { from, to } = monthStartIst();
  const [activity, snapshot] = await Promise.all([
    supabase.rpc("pipeline_activity", { p_from: from, p_to: to }),
    supabase.rpc("pipeline_snapshot", {}),
  ]);
  if (activity.error) throw new Error(activity.error.message);
  if (snapshot.error) throw new Error(snapshot.error.message);
  const a = (activity.data ?? []) as Row[];
  const s = (snapshot.data ?? []) as Row[];
  return {
    enquiries: sum(a, ["enquiries"]),
    testDrives: sum(a, ["test_drives"]),
    bookings: sum(a, ["bookings"]),
    delivered: sum(a, ["delivered"]),
    lost: sum(a, ["lost"]),
    openEnquiries: sum(s, ["open_enquiries", "quoted_enquiries"]),
    openBookings: sum(s, ["awaiting_car", "allotted", "with_accounts", "billed_not_delivered", "on_hold", "cancel_requested"]),
  };
}
