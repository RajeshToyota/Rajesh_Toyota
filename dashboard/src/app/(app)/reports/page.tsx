import { createClient } from "@/lib/supabase/server";

export default async function ReportsPage() {
  const supabase = await createClient();
  const { data: pending } = await supabase
    .from("approvals")
    .select("id, requested_discount_amount, status, created_at, requested_by_employee_id, employees:requested_by_employee_id(name)")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Pending Approvals</h1>
      <p className="mt-1 text-sm text-slate-500">
        Full quotes/bookings reporting and margin summaries land in Phase 5, once the mobile app is
        creating real quotes and bookings. This queue is live now.
      </p>

      {!pending || pending.length === 0 ? (
        <p className="mt-6 text-sm text-slate-500">No pending approvals.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Requested By</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Discount Amount</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Requested At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pending.map((row) => {
                const requester = Array.isArray(row.employees) ? row.employees[0] : row.employees;
                return (
                  <tr key={row.id}>
                    <td className="px-3 py-2">{requester?.name ?? "—"}</td>
                    <td className="px-3 py-2">₹{Number(row.requested_discount_amount).toLocaleString("en-IN")}</td>
                    <td className="px-3 py-2">{new Date(row.created_at).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
