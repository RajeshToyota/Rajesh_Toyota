import { supabase } from "@/lib/supabase";

export interface ApprovalRequirement {
  requiredRoleId: string;
  requiredRoleName: string;
  threshold: number;
}

// Finds the strictest approval rule the given discount amount crosses, preferring an
// outlet-specific rule over an org-wide one at the same threshold. Returns null if no rule is
// crossed (i.e. no approval needed).
export async function findApprovalRequirement(
  outletId: string | null,
  discountAmount: number,
): Promise<ApprovalRequirement | null> {
  const { data, error } = await supabase
    .from("approval_rules")
    .select("outlet_id, discount_threshold, roles:required_role_id(id, name, rank)")
    .or(outletId ? `outlet_id.eq.${outletId},outlet_id.is.null` : "outlet_id.is.null")
    .lte("discount_threshold", discountAmount)
    .order("discount_threshold", { ascending: false });

  if (error || !data || data.length === 0) return null;

  // Prefer the outlet-specific rule if both an outlet and an org-wide rule are crossed at the
  // same (highest) threshold; otherwise the highest threshold wins regardless of scope.
  const topThreshold = data[0].discount_threshold;
  const atTop = data.filter((r) => r.discount_threshold === topThreshold);
  const chosen = atTop.find((r) => r.outlet_id !== null) ?? atTop[0];

  const role = Array.isArray(chosen.roles) ? chosen.roles[0] : chosen.roles;
  if (!role) return null;

  return {
    requiredRoleId: role.id,
    requiredRoleName: role.name,
    threshold: chosen.discount_threshold,
  };
}

export async function createApprovalRequest(params: {
  quoteId?: string;
  bookingId?: string;
  requestedByEmployeeId: string;
  requiredRoleId: string;
  discountAmount: number;
}) {
  const { error } = await supabase.from("approvals").insert({
    quote_id: params.quoteId ?? null,
    booking_id: params.bookingId ?? null,
    requested_by_employee_id: params.requestedByEmployeeId,
    required_role_id: params.requiredRoleId,
    status: "pending",
    requested_discount_amount: params.discountAmount,
  });

  if (error) throw new Error(error.message);
}

export async function decideApproval(
  approvalId: string,
  decision: "approved" | "rejected",
  approverEmployeeId: string,
  comment?: string,
) {
  const { error } = await supabase
    .from("approvals")
    .update({
      status: decision,
      approver_employee_id: approverEmployeeId,
      comment: comment || null,
      decided_at: new Date().toISOString(),
    })
    .eq("id", approvalId);

  if (error) throw new Error(error.message);
}

export async function getLatestApprovalStatus(quoteId: string) {
  const { data } = await supabase
    .from("approvals")
    .select("status")
    .eq("quote_id", quoteId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.status as "pending" | "approved" | "rejected" | undefined;
}
