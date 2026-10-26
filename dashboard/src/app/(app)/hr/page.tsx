import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { canManageHr, canSeeHr, fmtDate, one } from "./shared";

type Row = {
  id: string;
  name: string;
  employee_code: string | null;
  designation: string | null;
  joining_date: string | null;
  exit_date: string | null;
  is_active: boolean;
  auth_user_id: string | null;
  login_invited_at: string | null;
  outlet_id: string | null;
  roles: { name: string } | null;
  outlets: { name: string } | null;
  manager: { name: string } | null;
};

// Staff list. HR and the Business Head see everyone; an Outlet Head sees their branch (RLS).
export default async function HrPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const employee = await getCurrentEmployee();
  if (!canSeeHr(employee)) return <p className="text-sm text-slate-600">This page is for HR, Outlet Heads and the Business Head.</p>;
  const supabase = await createClient();
  const showLeft = params.left === "1";
  const outlet = params.outlet ?? "";
  const q = (params.q ?? "").trim().toLowerCase();

  const [{ data }, { data: outlets }, { data: tasks }, { data: assets }] = await Promise.all([
    supabase
      .from("employees")
      .select(
        "id, name, employee_code, designation, joining_date, exit_date, is_active, auth_user_id, login_invited_at, outlet_id, " +
          "roles(name), outlets(name), manager:employees!reports_to_employee_id(name)",
      )
      .eq("is_active", !showLeft)
      .order("name")
      .limit(2000),
    supabase.from("outlets").select("id, name").eq("is_active", true).order("name"),
    supabase.from("employee_tasks").select("employee_id, kind, status"),
    supabase.from("employee_assets").select("employee_id").is("returned_on", null),
  ]);

  const progress = new Map<string, { done: number; total: number }>();
  for (const t of tasks ?? []) {
    if (t.kind !== (showLeft ? "offboarding" : "onboarding")) continue;
    const p = progress.get(t.employee_id) ?? { done: 0, total: 0 };
    p.total += 1;
    if (t.status !== "pending") p.done += 1;
    progress.set(t.employee_id, p);
  }
  const assetsOut = new Map<string, number>();
  for (const a of assets ?? []) assetsOut.set(a.employee_id, (assetsOut.get(a.employee_id) ?? 0) + 1);

  const rows = ((data ?? []) as unknown as Row[]).filter(
    (r) =>
      (!outlet || r.outlet_id === outlet) &&
      (!q || r.name.toLowerCase().includes(q) || (r.employee_code ?? "").toLowerCase().includes(q)),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{showLeft ? "Former employees" : "Employees"}</h1>
          <p className="text-sm text-slate-500">
            {rows.length} {showLeft ? "who have left" : "active"} · open someone for their checklist, assets, documents and login.
          </p>
        </div>
        {canManageHr(employee) && (
          <Link href="/hr/new" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800">
            Add employee
          </Link>
        )}
      </div>

      <form className="flex flex-wrap items-center gap-2 text-sm">
        <input name="q" defaultValue={params.q ?? ""} placeholder="Name or code" className="rounded-md border border-slate-300 px-2 py-1" />
        <select name="outlet" defaultValue={outlet} className="rounded-md border border-slate-300 px-2 py-1">
          <option value="">All branches</option>
          {(outlets ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <select name="left" defaultValue={showLeft ? "1" : ""} className="rounded-md border border-slate-300 px-2 py-1">
          <option value="">Active</option>
          <option value="1">Left</option>
        </select>
        <button className="rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-100">Filter</button>
      </form>

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Role / designation</th>
              <th className="px-3 py-2">Branch</th>
              <th className="px-3 py-2">Reports to</th>
              <th className="px-3 py-2">{showLeft ? "Left" : "Joined"}</th>
              <th className="px-3 py-2">Login</th>
              <th className="px-3 py-2">{showLeft ? "Offboarding" : "Onboarding"}</th>
              <th className="px-3 py-2">Assets out</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-slate-400">
                  No one matches.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const p = progress.get(r.id);
              const out = assetsOut.get(r.id) ?? 0;
              return (
                <tr key={r.id}>
                  <td className="px-3 py-2">
                    <Link href={`/hr/${r.id}`} className="font-medium underline">
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{r.employee_code ?? "—"}</td>
                  <td className="px-3 py-2">
                    {one(r.roles)?.name ?? "—"}
                    {r.designation ? <span className="text-slate-500"> · {r.designation}</span> : null}
                  </td>
                  <td className="px-3 py-2">{one(r.outlets)?.name ?? "—"}</td>
                  <td className="px-3 py-2">{one(r.manager)?.name ?? "—"}</td>
                  <td className="px-3 py-2">{fmtDate(showLeft ? r.exit_date : r.joining_date)}</td>
                  <td className="px-3 py-2">
                    {r.auth_user_id ? (
                      <span className="text-emerald-700">Yes</span>
                    ) : r.login_invited_at ? (
                      `Invited ${fmtDate(r.login_invited_at)}`
                    ) : (
                      <span className="text-slate-400">None</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {p ? (
                      <span className={p.done < p.total ? "text-amber-700" : "text-emerald-700"}>
                        {p.done}/{p.total}
                      </span>
                    ) : (
                      <span className="text-slate-400">Not started</span>
                    )}
                  </td>
                  <td className={`px-3 py-2 ${out && showLeft ? "font-semibold text-red-700" : ""}`}>{out || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
