import { createClient } from "@/lib/supabase/server";
import { ApprovalActions } from "./approval-actions";

const STAGE_LABELS: Record<string, string> = {
  with_schemes: "Quote · company schemes",
  with_dealer_discount: "Quote · dealer discount",
};
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
type ApprovalRow = {
  id: string; stage: string | null; requested_discount_amount: number; status: string; created_at: string;
  comment: string | null; quote_id: string | null; booking_id: string | null;
  requested_by: { name: string } | null; required_role: { name: string } | null;
  quote: { customer_name: string; total_amount: number | null } | null;
  booking: { customer_name: string | null; total_amount: number | null } | null;
};

const STATUS_TABS = ["pending", "approved", "rejected"] as const;

export default async function ApprovalsReportPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status = "pending" } = await searchParams;
  const supabase = await createClient();

  const { data: approvals } = await supabase
    .from("approvals")
    .select(
      "id, stage, requested_discount_amount, status, created_at, comment, quote_id, booking_id, " +
        "requested_by:requested_by_employee_id(name), required_role:required_role_id(name), " +
        "quote:quote_id(customer_name, total_amount), booking:booking_id(customer_name, total_amount)",
    )
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div>
      <div className="mb-4 flex gap-2">
        {STATUS_TABS.map((s) => (
          <a
            key={s}
            href={`/reports/approvals?status=${s}`}
            className={`rounded-full px-3 py-1 text-sm capitalize ${status === s ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`}
          >
            {s}
          </a>
        ))}
      </div>

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Requested By</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Customer</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Type</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Discount</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Required Approver</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Requested At</th>
              {status === "pending" && <th className="px-3 py-2 text-left font-medium text-slate-600">Action</th>}
              {status !== "pending" && <th className="px-3 py-2 text-left font-medium text-slate-600">Comment</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {((approvals ?? []) as unknown as ApprovalRow[]).map((a) => {
              const requester = one(a.requested_by);
              const role = one(a.required_role);
              const subject = one(a.quote) ?? one(a.booking);
              return (
                <tr key={a.id}>
                  <td className="px-3 py-2">{requester?.name ?? "—"}</td>
                  <td className="px-3 py-2">
                    <div>{subject?.customer_name ?? "—"}</div>
                    {subject?.total_amount != null && (
                      <div className="text-xs text-slate-500">₹{Math.round(subject.total_amount).toLocaleString("en-IN")} on-road</div>
                    )}
                  </td>
                  <td className="px-3 py-2">{a.stage ? STAGE_LABELS[a.stage] ?? a.stage : a.quote_id ? "Quote" : "Booking"}</td>
                  <td className="px-3 py-2">₹{Number(a.requested_discount_amount).toLocaleString("en-IN")}</td>
                  <td className="px-3 py-2">{role?.name ?? "—"}</td>
                  <td className="px-3 py-2">{new Date(a.created_at).toLocaleString()}</td>
                  {status === "pending" ? (
                    <td className="px-3 py-2">
                      <ApprovalActions approvalId={a.id} />
                    </td>
                  ) : (
                    <td className="px-3 py-2 text-slate-500">{a.comment ?? "—"}</td>
                  )}
                </tr>
              );
            })}
            {(!approvals || approvals.length === 0) && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-400">
                  No {status} approvals.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
