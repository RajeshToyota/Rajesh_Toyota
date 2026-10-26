import { supabase } from "@/lib/supabase";
import { uploadBookingFile } from "@/lib/docket";

// Hold and cancellation (20261101000001_hold_cancel.sql). The consultant puts a booking on hold or
// asks for it to be cancelled (with the customer's written request); the Outlet Head decides
// cancellations and Accounts pays the refunds.

export const CANCEL_REASONS = [
  { id: "finance_not_approved", label: "Finance not approved" },
  { id: "bought_elsewhere", label: "Bought elsewhere" },
  { id: "delivery_delay", label: "Delivery delay" },
  { id: "price", label: "Price" },
  { id: "changed_mind", label: "Changed mind / model" },
  { id: "personal", label: "Personal reasons" },
  { id: "other", label: "Other" },
] as const;

export interface Hold {
  id: string;
  reason: string;
  expected_resume_date: string | null;
  held_at: string;
  resumed_at: string | null;
}

export interface Cancellation {
  id: string;
  reason_category: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  decision_note: string | null;
}

export interface Refund {
  id: string;
  payee: "customer" | "financier";
  payee_name: string | null;
  amount: number;
  due_date: string;
  status: "pending" | "paid";
  cheque_no: string | null;
  paid_on: string | null;
}

export async function loadHoldCancel(bookingId: string) {
  const [holds, cancellations, refunds] = await Promise.all([
    supabase.from("booking_holds").select("id, reason, expected_resume_date, held_at, resumed_at").eq("booking_id", bookingId).is("resumed_at", null).maybeSingle(),
    supabase.from("booking_cancellations").select("id, reason_category, reason, status, requested_at, decision_note").eq("booking_id", bookingId).order("requested_at", { ascending: false }),
    supabase.from("refunds").select("id, payee, payee_name, amount, due_date, status, cheque_no, paid_on").eq("booking_id", bookingId),
  ]);
  for (const r of [holds, cancellations, refunds]) if (r.error) throw new Error(r.error.message);
  return {
    hold: (holds.data ?? null) as Hold | null,
    cancellations: (cancellations.data ?? []) as Cancellation[],
    refunds: (refunds.data ?? []) as Refund[],
  };
}

export async function holdBooking(bookingId: string, reason: string, expectedResume: string | null) {
  const { error } = await supabase.rpc("hold_booking", {
    p_booking_id: bookingId,
    p_reason: reason,
    p_expected_resume: expectedResume || null,
  });
  if (error) throw new Error(error.message);
}

export async function resumeBooking(bookingId: string, note?: string) {
  const { error } = await supabase.rpc("resume_booking", { p_booking_id: bookingId, p_note: note || null });
  if (error) throw new Error(error.message);
}

export async function requestCancellation(params: {
  bookingId: string;
  reasonCategory: string;
  reason: string;
  letterUri?: string | null;
  letterMime?: string | null;
}) {
  let path: string | null = null;
  if (params.letterUri) {
    path = `${params.bookingId}/cancellation/request-${Date.now()}.jpg`;
    await uploadBookingFile(path, params.letterUri, params.letterMime || "image/jpeg");
  }
  const { error } = await supabase.rpc("request_cancellation", {
    p_booking_id: params.bookingId,
    p_reason_category: params.reasonCategory,
    p_reason: params.reason,
    p_request_path: path,
  });
  if (error) throw new Error(error.message);
}
