import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { POOL_EVENT, type PoolAuditRow, type PoolConfig } from "@/lib/pool";
import { Card, Chip, Empty, Restricted, Th, isBackOffice } from "../../shared";
import { PoolNav } from "../nav";

const TONE: Record<string, "emerald" | "amber" | "red" | "blue" | "slate"> = {
  allotted: "emerald",
  completion_banked: "emerald",
  released: "red",
  completion_unbanked: "amber",
  pool_bump: "amber",
  engine_error: "red",
  fast_track: "blue",
  change_vehicle: "blue",
};

function detailText(r: PoolAuditRow) {
  const d = r.details ?? {};
  const parts: string[] = [];
  if (typeof d.reason === "string") parts.push(d.reason);
  if (typeof d.win_path === "string") parts.push(d.win_path === "do" ? "on DO" : d.win_path === "cash" ? "on cash" : d.win_path);
  if (typeof d.free_cars === "number") parts.push(`${d.free_cars} free, pool of ${d.pool_size}`);
  if (typeof d.error === "string") parts.push(d.error);
  if (d.after && typeof d.after === "object") {
    const a = d.after as Record<string, unknown>;
    parts.push(`${a.enabled ? "on" : "off"}, ${a.base_pool_size} + ${a.increment_per_vehicle}, cash ${a.cash_payment_percentage}%`);
  }
  return parts.join(" · ");
}

// Every pool move, newest first: search by VIN (or part of it).
export default async function PoolAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const employee = await getCurrentEmployee();
  if (!isBackOffice(employee)) return <Restricted text="The pool audit log is for the back office and Outlet Heads." />;
  const supabase = await createClient();
  const vin = params.vin?.trim() || null;
  const booking = params.booking || null;
  const [{ data: config }, { data, error }] = await Promise.all([
    supabase.from("pool_config").select("*").maybeSingle(),
    supabase.rpc("pool_audit_search", { p_booking_id: booking, p_vin: vin }),
  ]);
  const rows = (data ?? []) as PoolAuditRow[];

  return (
    <>
      <PoolNav config={config as PoolConfig | null} />
      <form className="mb-3 flex items-center gap-2 text-sm" action="/stock/pool/audit">
        <input name="vin" defaultValue={vin ?? ""} placeholder="VIN or last digits" className="w-56 rounded-md border border-slate-300 px-2 py-1" />
        <button className="rounded-md bg-slate-900 px-3 py-1 text-white">Search</button>
        {(vin || booking) && (
          <Link href="/stock/pool/audit" className="underline">
            Clear
          </Link>
        )}
      </form>
      <Card title={`Pool audit log (${rows.length}${rows.length === 300 ? "+" : ""})`}>
        {error && <p className="px-3 py-2 text-sm text-red-600">{error.message}</p>}
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>When</Th>
              <Th>What</Th>
              <Th>Customer</Th>
              <Th>Car</Th>
              <Th>Details</Th>
              <Th>By</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && <Empty cols={6} text="Nothing logged." />}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap px-3 py-2 text-xs">{new Date(r.created_at).toLocaleString("en-IN")}</td>
                <td className="px-3 py-2">
                  <Chip tone={TONE[r.event] ?? "slate"}>{POOL_EVENT[r.event] ?? r.event}</Chip>
                </td>
                <td className="px-3 py-2">
                  {r.booking_id ? (
                    <Link href={`/stock/pool/audit?booking=${r.booking_id}`} className="underline">
                      {r.customer_name ?? "—"}
                    </Link>
                  ) : (
                    "—"
                  )}
                  <div className="text-xs text-slate-500">
                    {[r.variant_name, r.color_name].filter(Boolean).join(" · ")}
                  </div>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{r.vin ?? "—"}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{detailText(r)}</td>
                <td className="px-3 py-2 text-xs">{r.by_name ?? "System"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
