import { createClient } from "@/lib/supabase/server";
import { PeriodBar } from "@/components/pipeline-ui";
import { ACTIVITY_KEYS, SNAPSHOT_KEYS, loadActivity, loadSnapshot, pct, resolvePeriod, sumBy } from "@/lib/pipeline";

type Person = { id: string; name: string; roles: { name: string } | { name: string }[] | null; outlets: { name: string } | { name: string }[] | null };
const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

// Per person: what they did in the period and what they hold open now, most bookings first.
export default async function ConsultantsReportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const period = resolvePeriod(params);
  const supabase = await createClient();

  const [{ data: outlets }, { data: people }, activity, snapshot] = await Promise.all([
    supabase.from("outlets").select("id, name").eq("is_active", true).order("name"),
    supabase.from("employees").select("id, name, roles(name), outlets(name)"),
    loadActivity(supabase, period.from, period.to, period.outletId),
    loadSnapshot(supabase, period.outletId),
  ]);

  const personById = new Map(((people ?? []) as Person[]).map((p) => [p.id, p]));
  const act = sumBy(activity, ACTIVITY_KEYS, (r) => r.employee_id);
  const snap = sumBy(snapshot, SNAPSHOT_KEYS, (r) => r.employee_id);
  const ids = [...new Set([...act.keys(), ...snap.keys()])];
  const zeroA = Object.fromEntries(ACTIVITY_KEYS.map((k) => [k, 0])) as Record<(typeof ACTIVITY_KEYS)[number], number>;
  const zeroS = Object.fromEntries(SNAPSHOT_KEYS.map((k) => [k, 0])) as Record<(typeof SNAPSHOT_KEYS)[number], number>;
  const rows = ids
    .map((id) => {
      const p = id ? personById.get(id) : null;
      const a = act.get(id) ?? zeroA;
      const s = snap.get(id) ?? zeroS;
      return {
        id: id ?? "none",
        name: p?.name ?? "Not assigned",
        role: one(p?.roles ?? null)?.name ?? "",
        branch: one(p?.outlets ?? null)?.name ?? "",
        ...a,
        openEnquiries: s.open_enquiries + s.quoted_enquiries,
        openBookings: s.awaiting_car + s.allotted + s.with_accounts + s.billed_not_delivered + s.on_hold + s.cancel_requested,
      };
    })
    .sort((x, y) => y.bookings - x.bookings || y.enquiries - x.enquiries || x.name.localeCompare(y.name));
  const total = rows.reduce(
    (t, r) => {
      for (const k of ACTIVITY_KEYS) t[k] += r[k];
      t.openEnquiries += r.openEnquiries;
      t.openBookings += r.openBookings;
      return t;
    },
    { ...zeroA, openEnquiries: 0, openBookings: 0 },
  );

  const cols: { key: keyof typeof total; label: string }[] = [
    { key: "enquiries", label: "Enquiries" },
    { key: "test_drives", label: "Test drives" },
    { key: "quotes", label: "Quotes" },
    { key: "bookings", label: "Bookings" },
    { key: "billed", label: "Billed" },
    { key: "delivered", label: "Delivered" },
    { key: "cancelled", label: "Cancelled" },
    { key: "lost", label: "Lost" },
  ];

  return (
    <div className="space-y-4">
      <PeriodBar outlets={outlets ?? []} period={period} />
      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">Person</th>
              <th className="px-3 py-2">Branch</th>
              {cols.map((c) => (
                <th key={c.key} className="px-3 py-2 text-right">
                  {c.label}
                </th>
              ))}
              <th className="px-3 py-2 text-right" title="Bookings ÷ enquiries in the period">
                Conversion
              </th>
              <th className="px-3 py-2 text-right">Open enquiries</th>
              <th className="px-3 py-2 text-right">Open bookings</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 tabular-nums">
            {rows.length === 0 && (
              <tr>
                <td colSpan={cols.length + 5} className="px-3 py-6 text-center text-slate-400">
                  Nothing in this period.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-1.5">
                  {r.name}
                  {r.role && <span className="text-xs text-slate-500"> · {r.role}</span>}
                </td>
                <td className="px-3 py-1.5">{r.branch || "—"}</td>
                {cols.map((c) => (
                  <td key={c.key} className="px-3 py-1.5 text-right">
                    {r[c.key] || <span className="text-slate-300">0</span>}
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right">{pct(r.bookings, r.enquiries)}</td>
                <td className="px-3 py-1.5 text-right">{r.openEnquiries}</td>
                <td className="px-3 py-1.5 text-right">{r.openBookings}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 1 && (
            <tfoot className="border-t border-slate-200 font-medium tabular-nums">
              <tr>
                <td className="px-3 py-2" colSpan={2}>
                  Total
                </td>
                {cols.map((c) => (
                  <td key={c.key} className="px-3 py-2 text-right">
                    {total[c.key]}
                  </td>
                ))}
                <td className="px-3 py-2 text-right">{pct(total.bookings, total.enquiries)}</td>
                <td className="px-3 py-2 text-right">{total.openEnquiries}</td>
                <td className="px-3 py-2 text-right">{total.openBookings}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Imported CTDMS orders count on their CTDMS order date. Numbers follow who holds each record now: when someone leaves,
        their open enquiries and bookings count under the colleague who took them over.
      </p>
    </div>
  );
}
