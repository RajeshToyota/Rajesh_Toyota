import { createClient } from "@/lib/supabase/server";
import { ReportFilterBar } from "@/components/report-filter-bar";

export default async function MarginReportPage({
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
    .select("dealer_margin, total_amount, outlet_id, employee_id, created_at, outlets(name), employees(name)")
    .not("status", "eq", "cancelled");

  if (params.outlet_id) query = query.eq("outlet_id", params.outlet_id);
  if (params.employee_id) query = query.eq("employee_id", params.employee_id);
  if (params.from) query = query.gte("created_at", params.from);
  if (params.to) query = query.lte("created_at", `${params.to}T23:59:59`);

  const { data: bookings } = await query;

  const rows = bookings ?? [];
  const totalMargin = rows.reduce((sum, r) => sum + Number(r.dealer_margin ?? 0), 0);
  const totalRevenue = rows.reduce((sum, r) => sum + Number(r.total_amount ?? 0), 0);

  const byOutlet = new Map<string, { name: string; margin: number; count: number }>();
  for (const r of rows) {
    const outlet = Array.isArray(r.outlets) ? r.outlets[0] : r.outlets;
    const key = r.outlet_id ?? "unknown";
    const existing = byOutlet.get(key) ?? { name: outlet?.name ?? "Unknown", margin: 0, count: 0 };
    existing.margin += Number(r.dealer_margin ?? 0);
    existing.count += 1;
    byOutlet.set(key, existing);
  }

  return (
    <div>
      <ReportFilterBar outlets={outlets ?? []} employees={employees ?? []} values={params} />

      <div className="mb-6 grid grid-cols-3 gap-4">
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">Bookings</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{rows.length}</p>
        </div>
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">Total Revenue</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">₹{totalRevenue.toLocaleString("en-IN")}</p>
        </div>
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">Total Dealer Margin</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">₹{totalMargin.toLocaleString("en-IN")}</p>
        </div>
      </div>

      <h2 className="mb-2 text-sm font-semibold text-slate-700">By Outlet</h2>
      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Outlet</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Bookings</th>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Dealer Margin</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {Array.from(byOutlet.values()).map((o) => (
              <tr key={o.name}>
                <td className="px-3 py-2">{o.name}</td>
                <td className="px-3 py-2">{o.count}</td>
                <td className="px-3 py-2">₹{o.margin.toLocaleString("en-IN")}</td>
              </tr>
            ))}
            {byOutlet.size === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-slate-400">
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
