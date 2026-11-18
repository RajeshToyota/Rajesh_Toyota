import { supabase } from "@/lib/supabase";

export type FlowRow = {
  booking_id: string;
  customer_name: string;
  outlet_id: string;
  outlet: string;
  car: string;
  vin: string;
  location: string | null;
  stage: string;
  detail: string;
  inspection_id: string | null;
  scheduled_for: string | null;
  slot: string | null;
};

export type ChecklistItem = { code: string; section: string; label: string };

export const STAGE_LABEL: Record<string, string> = {
  to_rework: "Rework",
  pdi_pending: "PDI",
  to_move: "Move to bay",
  to_wash: "Wash",
  ready: "Ready",
  no_vehicle: "No car",
};

export async function loadPdiFlow(): Promise<FlowRow[]> {
  const { data, error } = await supabase.rpc("pdi_flow_board", { p_outlet_id: null });
  if (error) throw new Error(error.message);
  return (data ?? []) as FlowRow[];
}

export async function loadChecklist(): Promise<ChecklistItem[]> {
  const { data, error } = await supabase.from("pdi_checklist_items").select("code, section, label").eq("is_active", true).order("sort_order");
  if (error) throw new Error(error.message);
  return (data ?? []) as ChecklistItem[];
}

// Photos go to booking-documents/<booking_id>/pdi/, where record_pdi_result expects them.
export async function uploadPdiPhoto(bookingId: string, localUri: string, mimeType?: string | null): Promise<string> {
  const ext = mimeType === "image/png" ? "png" : "jpg";
  const path = `${bookingId}/pdi/${Date.now()}.${ext}`;
  const body = await (await fetch(localUri)).arrayBuffer();
  const { error } = await supabase.storage.from("booking-documents").upload(path, body, { contentType: mimeType ?? "image/jpeg" });
  if (error) throw new Error(error.message);
  return path;
}

export async function recordPdi(inspectionId: string, results: Record<string, string>, remarks: string, photos: string[]) {
  const { data, error } = await supabase.rpc("record_pdi_result", {
    p_inspection_id: inspectionId,
    p_results: results,
    p_remarks: remarks || null,
    p_photo_paths: photos,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function markWashed(bookingId: string) {
  const { error } = await supabase.rpc("pdi_mark_washed", { p_booking_id: bookingId });
  if (error) throw new Error(error.message);
}

export async function markAtYard(bookingId: string, outletId: string, kind: "workshop" | "delivery_bay") {
  const { data: yard } = await supabase.from("yards").select("id").eq("outlet_id", outletId).eq("kind", kind).eq("is_active", true).limit(1).maybeSingle();
  if (!yard) throw new Error("This branch has no such yard set up");
  const { error } = await supabase.rpc("pdi_mark_at_location", { p_booking_id: bookingId, p_yard_id: yard.id });
  if (error) throw new Error(error.message);
}

export type MyDelivery = {
  id: string;
  slot_date: string;
  slot_time: string;
  bay_no: number | null;
  booking_id: string;
  bookings: { customer_name: string | null; customer_mobile: string | null } | null;
};

// The signed-in consultant's booked delivery slots from today on (RLS limits them to their bookings).
export async function loadMyDeliveries(employeeId: string): Promise<(MyDelivery & { stage: string | null })[]> {
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("delivery_slots")
    .select("id, slot_date, slot_time, bay_no, booking_id, bookings!inner(customer_name, customer_mobile, employee_id)")
    .eq("status", "booked")
    .eq("bookings.employee_id", employeeId)
    .gte("slot_date", today)
    .order("slot_date")
    .order("slot_time");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as MyDelivery[];
  return Promise.all(
    rows.map(async (r) => {
      const { data: s } = await supabase.rpc("pdi_stage", { p_booking_id: r.booking_id });
      const st = Array.isArray(s) ? s[0] : s;
      return { ...r, stage: (st as { stage?: string } | null)?.stage ?? null };
    }),
  );
}
