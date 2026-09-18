import { createClient } from "@/lib/supabase/server";
import { ReportFilterBar } from "@/components/report-filter-bar";

const STATUS_OPTIONS = ["booked", "allocated", "delivered", "cancelled", "ready_to_invoice"].map((s) => ({ id: s, name: s }));

export default async function BookingsReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const supabase = await createClient();

  const [{ data: outlets }, { data: employees }] = await Promise.all([
    supabase.from("outlets").select("id, name").order("name"),
    supabase.from("employees").select("id, name").order("name"),
  ]);

  let query = supabase
    .from("bookings")
    .select("id, order_booking_no, total_amount, status, created_at, outlets(name), employees(name)")
    .order("created_at", { ascending: false })
    .limit(200);

  if (params.outlet_id) query = query.eq("outlet_id", params.outlet_id);
  if (params.employee_id) query = query.eq("employee_id", params.employee_id);
  if (params.status) query = query.eq("status", params.status);
  if (params.from) query = query.gte("created_at", params.from);
  if (params.to) query = query.lte("created_at", `${params.to}T23:59:59`);

  const { data: bookings } = await query;

  return (
    <div>
      <ReportFilterBar
        outlets={outlets ?? []}
        employees={employees ?? []}
        values={params}
        extra={[{ name: "status", label: "Status", options: STATUS_OPTIONS }]}
      />

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Booking No.</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Outlet</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Sales Consultant</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Total</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(bookings ?? []).map((b) => {
              const outlet = Array.isArray(b.outlets) ? b.outlets[0] : b.outlets;
              const employee = Array.isArray(b.employees) ? b.employees[0] : b.employees;
              return (
                <tr key={b.id}>
                  <td className="px-3 py-2">{b.order_booking_no ?? "—"}</td>
                  <td className="px-3 py-2">{outlet?.name ?? "—"}</td>
                  <td className="px-3 py-2">{employee?.name ?? "—"}</td>
                  <td className="px-3 py-2">{b.total_amount ? `₹${Number(b.total_amount).toLocaleString("en-IN")}` : "—"}</td>
                  <td className="px-3 py-2 capitalize">{b.status}</td>
                  <td className="px-3 py-2">{new Date(b.created_at).toLocaleDateString()}</td>
                </tr>
              );
            })}
            {(!bookings || bookings.length === 0) && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-400">
                  No bookings match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
