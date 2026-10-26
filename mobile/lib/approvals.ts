import { supabase } from "@/lib/supabase";

// Approvals are raised and decided only by database RPCs (20261027000001_staged_quotes.sql):
// quote stages raise their own requests in submit_quote_stage(); direct bookings ask here. The
// approver's rank and the no-self-approval rule are enforced in decide_approval().

export async function requestBookingApproval(
  bookingId: string,
): Promise<{ approvalRequired: boolean; requiredRole: string | null }> {
  const { data, error } = await supabase.rpc("request_booking_approval", { p_booking_id: bookingId });
  if (error) throw new Error(error.message);
  return { approvalRequired: !!data?.approval_required, requiredRole: data?.required_role ?? null };
}

export async function decideApproval(approvalId: string, decision: "approved" | "rejected", comment?: string) {
  const { error } = await supabase.rpc("decide_approval", {
    p_approval_id: approvalId,
    p_decision: decision,
    p_comment: comment || null,
  });
  if (error) throw new Error(error.message);
}
