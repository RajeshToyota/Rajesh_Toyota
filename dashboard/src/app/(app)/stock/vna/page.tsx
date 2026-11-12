import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { FINANCE_STAGE, whatsappLink, type PoolConfig, type VnaRow } from "@/lib/pool";
import { Card, Chip, Empty, Restricted, Th, fmtDate, inr, isAccounts, isBackOffice } from "../shared";
import { PoolNav } from "../pool/nav";

// "Vehicle Not Available": customers further down their variant + colour queue than there are free
// cars, how long they have waited, and what is free instead.
export default async function VnaPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const employee = await getCurrentEmployee();
  if (!employee || isAccounts(employee)) return <Restricted text="VNA demand is for sales, finance and the back office." />;
  const outlet = params.outlet || null;
  const supabase = await createClient();
  const [{ data: config }, { data: outlets }, { data, error }] = await Promise.all([
    supabase.from("pool_config").select("*").maybeSingle(),
    supabase.from("outlets").select("id, name").eq("is_active", true).order("name"),
    supabase.rpc("pool_vna_demand", { p_outlet_id: outlet }),
  ]);
  const rows = (data ?? []) as VnaRow[];

  // Demand per variant + colour, to order against.
  const demand = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.model_name} ${r.variant_name} · ${r.color_name}`;
    demand.set(k, (demand.get(k) ?? 0) + 1);
  }

  return (
    <>
      <PoolNav config={config as PoolConfig | null} backOffice={isBackOffice(employee)} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-500">Branch:</span>
        <Link href="/stock/vna" className={outlet ? "underline" : "font-semibold"}>
          All
        </Link>
        {(outlets ?? []).map((o) => (
          <Link key={o.id} href={`/stock/vna?outlet=${o.id}`} className={outlet === o.id ? "font-semibold" : "underline"}>
            {o.name.replace(/^Rajesh Toyota - /, "")}
          </Link>
        ))}
      </div>
      {error && <p className="mb-3 text-sm text-red-600">{error.message}</p>}

      <Card title={`Short by variant and colour (${demand.size})`} note="Cars to order or transfer in: customers waiting beyond the free stock.">
        <div className="flex flex-wrap gap-2 px-3 py-2 text-sm">
          {demand.size === 0 && <span className="text-slate-400">Nothing short.</span>}
          {[...demand.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => (
              <Chip key={k} tone="amber">
                {k}: {n}
              </Chip>
            ))}
        </div>
      </Card>

      <Card title={`Customers waiting (${rows.length})`} note="Offer another colour or a nearby variant that is free now. 30+ days amber, 60+ days red.">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Customer</Th>
              <Th>Car wanted</Th>
              <Th>Booked</Th>
              <Th right>Queue</Th>
              <Th>Finance</Th>
              <Th>Free instead</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && <Empty cols={6} text="Every waiting customer has a car free for them." />}
            {rows.map((r) => {
              const offer = [
                ...r.other_colors.map((c) => `${r.variant_name} in ${c.color}`),
                ...r.other_variants.map((v) => v.variant),
              ];
              const wa =
                offer.length > 0
                  ? whatsappLink(
                      r.customer_mobile,
                      `Dear ${r.customer_name ?? "Customer"}, your ${r.model_name} ${r.variant_name} in ${r.color_name} is still on its way. ` +
                        `If you'd like your car sooner, we have ${offer.slice(0, 3).join(", ")} available now at Rajesh Toyota. Reply and we'll share the details.`,
                    )
                  : null;
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
                    <div className="text-xs text-slate-500">{r.color_name}</div>
                  </td>
                  <td className="space-x-1 px-3 py-2">
                    <span>{fmtDate(r.booking_date)}</span>
                    <Chip tone={r.days_waiting >= 60 ? "red" : r.days_waiting >= 30 ? "amber" : "slate"}>{r.days_waiting} days</Chip>
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    #{r.queue_position} · {r.free_cars} free
                  </td>
                  <td className="px-3 py-2">{r.finance_status ? FINANCE_STAGE[r.finance_status] ?? r.finance_status : "Cash"}</td>
                  <td className="px-3 py-2 text-xs">
                    {offer.length === 0 && <span className="text-slate-400">Nothing similar free</span>}
                    {r.other_colors.map((c) => (
                      <div key={c.color_id}>
                        {c.color} <span className="text-slate-500">({c.free} free)</span>
                      </div>
                    ))}
                    {r.other_variants.map((v) => (
                      <div key={v.variant_id}>
                        {v.variant}{" "}
                        <span className="text-slate-500">
                          ({v.free} free{v.price_difference != null ? `, ${v.price_difference >= 0 ? "+" : "−"}${inr(Math.abs(v.price_difference))}` : ""})
                        </span>
                      </div>
                    ))}
                    {wa && (
                      <a href={wa} target="_blank" rel="noreferrer" className="mt-1 block text-emerald-700 underline">
                        WhatsApp offer
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </>
  );
}
