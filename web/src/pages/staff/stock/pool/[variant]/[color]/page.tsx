import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { FINANCE_STAGE, winPathLabel, type PoolConfig, type PoolDetailRow } from "@/lib/pool";
import { poolHold } from "../../../actions";
import { ActionForm } from "../../../ui";
import { Card, Chip, Empty, Restricted, Th, ageDays, fmtDate, isBackOffice } from "../../../shared";
import { PoolNav } from "../../nav";

const PLACE: Record<PoolDetailRow["place"], { label: string; tone: "emerald" | "blue" | "slate" | "amber" }> = {
  allotted: { label: "Allotted", tone: "blue" },
  winner: { label: "Completed: next car", tone: "emerald" },
  member: { label: "In pool", tone: "slate" },
  queue: { label: "Waiting", tone: "amber" },
};

type FreeCar = { id: string; vin: string; source: string; days_since_invoice: number | null; tkm_invoice_date: string | null; ctdms_block_status: string | null; missing_from_report: boolean };

// One variant + colour: the free cars, and everyone in or queuing for the pool in the order the
// pool sees them.
export default async function PoolDetailPage({ params }: { params: Promise<{ variant: string; color: string }> }) {
  const { variant, color } = await params;
  const employee = await getCurrentEmployee();
  if (!isBackOffice(employee)) return <Restricted text="The allotment pool is for the back office and Outlet Heads." />;
  const supabase = await createClient();

  const [{ data: config }, { data: names }, { data: colorRow }, { data: rowsData, error }, { data: cars }] = await Promise.all([
    supabase.from("pool_config").select("*").maybeSingle(),
    supabase.from("variants").select("name, models(name)").eq("id", variant).maybeSingle(),
    supabase.from("colors").select("name").eq("id", color).maybeSingle(),
    supabase.rpc("pool_detail", { p_variant_id: variant, p_color_id: color }),
    supabase
      .from("vehicles")
      .select("id, vin, source, days_since_invoice, tkm_invoice_date, ctdms_block_status, missing_from_report")
      .eq("variant_id", variant)
      .eq("color_id", color)
      .eq("status", "available")
      .order("days_since_invoice", { ascending: false, nullsFirst: false }),
  ]);
  const rows = (rowsData ?? []) as PoolDetailRow[];
  const free = ((cars ?? []) as FreeCar[]).filter((c) => !c.missing_from_report);
  const model = (names as unknown as { name: string; models: { name: string } | null } | null) ?? null;
  const title = `${model?.models?.name ?? ""} ${model?.name ?? ""} · ${(colorRow as { name: string } | null)?.name ?? ""}`;
  const cashTarget = (config as PoolConfig | null)?.cash_payment_percentage ?? 70;

  return (
    <>
      <PoolNav config={config as PoolConfig | null} />
      <h2 className="mb-3 text-base font-semibold text-slate-900">{title}</h2>

      <Card title={`Free cars (${free.length})`} note="Oldest first: yard before transit, then days since TKM invoice. A car blocked in CTDMS stays out of the pool.">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>VIN</Th>
              <Th>Where</Th>
              <Th right>Age (days)</Th>
              <Th>CTDMS</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {free.length === 0 && <Empty cols={4} text="No free car of this variant and colour." />}
            {free.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-2">
                  <Link href={`/stock/vehicle/${c.id}`} className="font-mono text-xs underline">
                    {c.vin}
                  </Link>
                </td>
                <td className="px-3 py-2">{c.source === "physical" ? "Yard" : <Chip tone="blue">In transit</Chip>}</td>
                <td className="px-3 py-2 text-right">{ageDays(c) ?? "—"}</td>
                <td className="px-3 py-2">
                  {c.ctdms_block_status === "Blocked" || c.ctdms_block_status === "Alloted" ? (
                    <Chip tone="amber">{c.ctdms_block_status}: not in pool</Chip>
                  ) : (
                    (c.ctdms_block_status ?? "—")
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title={`Bookings (${rows.length})`}
        note={`Completed bookings get cars in the order they completed; then the pool fills by booking date. Cash completes at ${cashTarget}% cleared.`}
      >
        {error && <p className="px-3 py-2 text-sm text-red-600">{error.message}</p>}
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th right>#</Th>
              <Th>Customer</Th>
              <Th>Booked</Th>
              <Th>Branch · Consultant</Th>
              <Th>Place</Th>
              <Th>Finance</Th>
              <Th right>Cash cleared</Th>
              <Th>Completed</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && <Empty cols={9} text="No bookings for this variant and colour." />}
            {rows.map((r) => (
              <tr key={r.booking_id}>
                <td className="px-3 py-2 text-right text-slate-500">{r.queue_position}</td>
                <td className="px-3 py-2">
                  <Link href={`/reports/bookings/${r.booking_id}`} className="underline">
                    {r.customer_name ?? "—"}
                  </Link>
                  <div className="text-xs text-slate-500">{r.ctdms_order_no ?? ""}</div>
                </td>
                <td className="px-3 py-2">{fmtDate(r.booking_date)}</td>
                <td className="px-3 py-2">
                  {r.outlet ?? "—"}
                  <div className="text-xs text-slate-500">{r.consultant ?? ""}</div>
                </td>
                <td className="space-x-1 px-3 py-2">
                  <Chip tone={PLACE[r.place].tone}>{PLACE[r.place].label}</Chip>
                  {r.fast_tracked && <Chip tone="blue">Fast-tracked</Chip>}
                  {r.vin && <span className="font-mono text-xs">{r.vin}</span>}
                </td>
                <td className="px-3 py-2">{r.finance_status ? FINANCE_STAGE[r.finance_status] ?? r.finance_status : "Cash"}</td>
                <td className="px-3 py-2 text-right">{r.cash_percent == null ? "—" : `${r.cash_percent}%`}</td>
                <td className="px-3 py-2">
                  {r.completed_at ? (
                    <>
                      {fmtDate(r.completed_at)} <span className="text-xs text-slate-500">{winPathLabel(r.win_path)}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2">
                  {r.place !== "allotted" && (
                    <ActionForm
                      action={poolHold}
                      hidden={{ booking_id: r.booking_id }}
                      fields={[{ name: "reason", placeholder: "Hold reason", required: true, width: "w-32" }]}
                      label="Hold"
                      tone="light"
                      confirm="Put this booking on hold? It leaves the pool until it is resumed."
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
