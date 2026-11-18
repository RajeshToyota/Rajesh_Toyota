import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { FINANCE_STAGE, whatsappLink, type FinanceQueueRow, type NonPoolRow, type PoolConfig } from "@/lib/pool";
import { poolFastTrack, poolHold } from "../actions";
import { ActionForm } from "../ui";
import { Card, Chip, Empty, Restricted, Th, canManageStock, fmtDate, inr, isAccounts, isBackOffice } from "../shared";
import { PoolNav } from "../pool/nav";

function CashBar({ percent, target }: { percent: number | null; target: number }) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  const done = p >= target;
  return (
    <div className="w-28">
      <div className="relative h-2 rounded bg-slate-100">
        <div className={`h-2 rounded ${done ? "bg-emerald-500" : "bg-amber-400"}`} style={{ width: `${p}%` }} />
        <div className="absolute top-[-2px] h-3 w-px bg-slate-500" style={{ left: `${target}%` }} />
      </div>
      <div className="mt-0.5 text-xs text-slate-500">
        {percent == null ? "No price" : `${percent}% of ${target}%`}
      </div>
    </div>
  );
}

// Pool members still waiting for a car, with how far each has got with the DO or payment (In Pool),
// and bookings that could take a car but are not in a pool (Not in Pool).
export default async function FinanceQueuePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const employee = await getCurrentEmployee();
  if (!employee || isAccounts(employee)) return <Restricted text="The finance queue is for sales, finance and the back office." />;
  const tab = params.tab === "non-pool" ? "non-pool" : "pool";
  const outlet = params.outlet || null;
  const supabase = await createClient();
  const canFastTrack = canManageStock(employee);

  const [{ data: config }, { data: outlets }, { data, error }] = await Promise.all([
    supabase.from("pool_config").select("*").maybeSingle(),
    supabase.from("outlets").select("id, name").eq("is_active", true).order("name"),
    tab === "pool"
      ? supabase.rpc("pool_finance_queue", { p_outlet_id: outlet })
      : supabase.rpc("pool_non_pool_bookings", { p_outlet_id: outlet }),
  ]);
  const cfg = config as PoolConfig | null;
  const target = cfg?.cash_payment_percentage ?? 70;
  const href = (t: string, o: string | null) => `/stock/finance-queue?tab=${t}${o ? `&outlet=${o}` : ""}`;

  return (
    <>
      <PoolNav config={cfg} backOffice={isBackOffice(employee)} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Link href={href("pool", outlet)} className={`rounded-md px-3 py-1 ${tab === "pool" ? "bg-slate-900 text-white" : "border border-slate-300"}`}>
          In Pool
        </Link>
        <Link href={href("non-pool", outlet)} className={`rounded-md px-3 py-1 ${tab === "non-pool" ? "bg-slate-900 text-white" : "border border-slate-300"}`}>
          Not in Pool
        </Link>
        <span className="ml-4 text-slate-500">Branch:</span>
        <Link href={href(tab, null)} className={outlet ? "underline" : "font-semibold"}>
          All
        </Link>
        {(outlets ?? []).map((o) => (
          <Link key={o.id} href={href(tab, o.id)} className={outlet === o.id ? "font-semibold" : "underline"}>
            {o.name.replace(/^Rajesh Toyota - /, "")}
          </Link>
        ))}
      </div>
      {error && <p className="mb-3 text-sm text-red-600">{error.message}</p>}

      {tab === "pool" ? (
        <Card
          title={`In pool (${(data ?? []).length})`}
          note={`A car is free for each of these customers' variant and colour. The first to get the DO (financed) or clear ${target}% (cash) gets it.`}
        >
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <Th>Customer</Th>
                <Th>Car wanted</Th>
                <Th>Booked</Th>
                <Th>Finance</Th>
                <Th>Cash</Th>
                <Th right>Deal · Cleared · Pending</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(data ?? []).length === 0 && <Empty cols={7} text="Nobody is waiting in a pool." />}
              {((data ?? []) as FinanceQueueRow[]).map((r) => {
                const wa = whatsappLink(
                  r.customer_mobile,
                  `Dear ${r.customer_name ?? "Customer"}, a ${r.model_name} ${r.variant_name} in ${r.color_name} is available for you at Rajesh Toyota. ` +
                    (r.finance_status
                      ? "Cars go to the first customers whose loan DO is in, so please complete your finance formalities at the earliest."
                      : `Cars go to the first customers who have paid ${target}%, so please complete your payment at the earliest.`),
                );
                return (
                  <tr key={r.booking_id}>
                    <td className="px-3 py-2">
                      <Link href={`/reports/bookings/${r.booking_id}`} className="underline">
                        {r.customer_name ?? "—"}
                      </Link>
                      <div className="text-xs text-slate-500">
                        {r.outlet.replace(/^Rajesh Toyota - /, "")} · {r.consultant ?? "—"}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {r.model_name} {r.variant_name}
                      <div className="text-xs text-slate-500">
                        {r.color_name} · {r.free_cars} free
                      </div>
                    </td>
                    <td className="space-x-1 px-3 py-2">
                      <span>{fmtDate(r.booking_date)}</span>
                      {r.fast_tracked && <Chip tone="blue">Fast-tracked</Chip>}
                    </td>
                    <td className="px-3 py-2">
                      {r.finance_status ? (
                        <>
                          <Chip tone={r.finance_status === "do_received" || r.finance_status === "disbursed" ? "emerald" : "amber"}>
                            {FINANCE_STAGE[r.finance_status] ?? r.finance_status}
                          </Chip>
                          <div className="text-xs text-slate-500">
                            {r.financier ?? ""} {r.do_number ? `· DO ${r.do_number}` : ""}
                          </div>
                        </>
                      ) : (
                        <span className="text-slate-500">Cash</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{r.finance_status ? "—" : <CashBar percent={r.cash_percent} target={target} />}</td>
                    <td className="px-3 py-2 text-right text-xs">
                      {inr(r.deal_amount)}
                      <div className="text-slate-500">
                        {inr(r.cleared)} · {inr(r.pending)}
                      </div>
                    </td>
                    <td className="space-y-1 px-3 py-2">
                      {r.completed_at ? <Chip tone="emerald">Completed: car next</Chip> : null}
                      {wa && (
                        <a href={wa} target="_blank" rel="noreferrer" className="block text-xs text-emerald-700 underline">
                          WhatsApp nudge
                        </a>
                      )}
                      <ActionForm
                        action={poolHold}
                        hidden={{ booking_id: r.booking_id }}
                        fields={[{ name: "reason", placeholder: "Hold reason", required: true, width: "w-28" }]}
                        label="Hold"
                        tone="light"
                        confirm="Put this booking on hold? It leaves the pool until it is resumed."
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ) : (
        <Card
          title={`Not in a pool (${(data ?? []).length})`}
          note="Bookings that could take a car but are behind the queue or have no free car. An Outlet Head can fast-track one into its pool when a car is free."
        >
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <Th>Customer</Th>
                <Th>Car wanted</Th>
                <Th>Booked</Th>
                <Th>Finance</Th>
                <Th right>Cash cleared</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(data ?? []).length === 0 && <Empty cols={6} text="No bookings outside the pools." />}
              {((data ?? []) as NonPoolRow[]).map((r) => (
                <tr key={r.booking_id}>
                  <td className="px-3 py-2">
                    <Link href={`/reports/bookings/${r.booking_id}`} className="underline">
                      {r.customer_name ?? "—"}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {r.outlet.replace(/^Rajesh Toyota - /, "")} · {r.consultant ?? "—"}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {r.model_name} {r.variant_name}
                    <div className="text-xs text-slate-500">
                      {r.color_name} · {r.free_cars > 0 ? `${r.free_cars} free` : "none free"}
                    </div>
                  </td>
                  <td className="px-3 py-2">{fmtDate(r.booking_date)}</td>
                  <td className="px-3 py-2">{r.finance_status ? FINANCE_STAGE[r.finance_status] ?? r.finance_status : "Cash"}</td>
                  <td className="px-3 py-2 text-right">{r.cash_percent == null ? "—" : `${r.cash_percent}%`}</td>
                  <td className="space-y-1 px-3 py-2">
                    {canFastTrack && cfg?.enabled && r.free_cars > 0 && (
                      <ActionForm
                        action={poolFastTrack}
                        hidden={{ booking_id: r.booking_id }}
                        fields={[{ name: "reason", placeholder: "Why fast-track", required: true, width: "w-32" }]}
                        label="Add to pool"
                        confirm="Fast-track this booking into its pool? It can't then be pushed out by earlier bookings."
                      />
                    )}
                    <ActionForm
                      action={poolHold}
                      hidden={{ booking_id: r.booking_id }}
                      fields={[{ name: "reason", placeholder: "Hold reason", required: true, width: "w-28" }]}
                      label="Hold"
                      tone="light"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
