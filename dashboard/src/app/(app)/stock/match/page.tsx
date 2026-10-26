import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { allotProposals } from "../actions";
import { ProposalList } from "../ui";
import { Card, Chip, Restricted, canManageStock, fmtDate, isBackOffice } from "../shared";

type FifoProposal = {
  booking_id: string;
  vehicle_id: string;
  booking_date: string;
  customer_name: string | null;
  ctdms_order_no: string | null;
  booking_outlet: string;
  vin: string;
  vehicle_source: string;
  days_since_invoice: number | null;
  variant_name: string;
  color_name: string;
};
type CtdmsProposal = {
  booking_id: string;
  vehicle_id: string;
  ctdms_order_no: string;
  customer_name: string | null;
  vin: string;
  matches_booking: boolean;
};

export default async function MatchPage() {
  const employee = await getCurrentEmployee();
  if (!isBackOffice(employee)) return <Restricted text="Matching stock is for the back office and Outlet Heads." />;
  const supabase = await createClient();
  const canAllot = canManageStock(employee);

  const [{ data: fifo, error: fifoError }, { data: ctdms }] = await Promise.all([
    supabase.rpc("propose_fifo_allotments"),
    supabase.rpc("propose_ctdms_allotments"),
  ]);
  const fifoRows = (fifo ?? []) as FifoProposal[];
  const ctdmsRows = (ctdms ?? []) as CtdmsProposal[];

  // Bookings still waiting for a car once the proposals above are taken: demand to order against.
  const proposed = new Set([...fifoRows, ...ctdmsRows].map((p) => p.booking_id));
  const { data: waiting } = await supabase
    .from("bookings")
    .select("id, customer_name, ctdms_order_booking_no, ctdms_order_date, created_at, ctdms_order_status, variants(name, models(name)), colors(name)")
    .eq("status", "booked")
    .not("variant_id", "is", null)
    .limit(1000);
  const demand = new Map<string, number>();
  for (const b of (waiting ?? []) as unknown as {
    id: string;
    ctdms_order_status: string | null;
    variants: { name: string; models: { name: string } | null } | null;
    colors: { name: string } | null;
  }[]) {
    if (proposed.has(b.id) || b.ctdms_order_status === "Closed in CTDMS") continue;
    const key = `${b.variants?.models?.name ?? ""} ${b.variants?.name ?? ""} · ${b.colors?.name ?? "?"}`;
    demand.set(key, (demand.get(key) ?? 0) + 1);
  }

  return (
    <div>
      {!canAllot && (
        <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Only an Outlet Head or above can confirm allotments; you can review the proposals.
        </p>
      )}

      <Card
        title={`Already blocked in CTDMS (${ctdmsRows.length})`}
        note="CTDMS has these cars blocked for one of our open orders. Confirming records the allotment here; nothing needs doing in CTDMS."
      >
        {canAllot ? (
          <ProposalList
            action={allotProposals}
            method="ctdms"
            columns={["Order", "Customer", "VIN", "Variant & colour"]}
            rows={ctdmsRows.map((p) => ({
              key: `${p.booking_id}:${p.vehicle_id}`,
              cells: [
                p.ctdms_order_no,
                p.customer_name ?? "—",
                <Link key="v" href={`/stock/vehicle/${p.vehicle_id}`} className="font-mono text-xs underline">
                  {p.vin}
                </Link>,
                p.matches_booking ? "Matches" : <Chip key="c" tone="amber">Differs from the booking</Chip>,
              ],
            }))}
          />
        ) : (
          <p className="px-3 py-3 text-sm text-slate-500">{ctdmsRows.length} to confirm.</p>
        )}
      </Card>

      <Card
        title={`FIFO proposals (${fifoRows.length})`}
        note="Earliest booking first; each gets the oldest matching car (same variant and colour), yard before transit. Cars are shared across branches."
      >
        {fifoError ? (
          <p className="px-3 py-3 text-sm text-red-600">{fifoError.message}</p>
        ) : canAllot ? (
          <ProposalList
            action={allotProposals}
            method="fifo"
            columns={["Booked", "Customer", "Order", "Branch", "Variant · colour", "Car", "Age"]}
            rows={fifoRows.map((p) => ({
              key: `${p.booking_id}:${p.vehicle_id}`,
              cells: [
                fmtDate(p.booking_date),
                p.customer_name ?? "—",
                p.ctdms_order_no ?? "—",
                p.booking_outlet,
                `${p.variant_name} · ${p.color_name}`,
                <span key="v" className="font-mono text-xs">
                  {p.vin} {p.vehicle_source === "transit" && <Chip tone="blue">In transit</Chip>}
                </span>,
                p.days_since_invoice ?? "—",
              ],
            }))}
          />
        ) : (
          <p className="px-3 py-3 text-sm text-slate-500">{fifoRows.length} proposals.</p>
        )}
      </Card>

      <Card title="Waiting for stock" note="Open bookings with no matching car in stock or transit, by variant and colour.">
        <ul className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {[...demand.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => (
              <li key={k}>
                <b>{n}</b> × {k}
              </li>
            ))}
          {demand.size === 0 && <li className="text-slate-400">Every open booking has a car proposed.</li>}
        </ul>
      </Card>
    </div>
  );
}
