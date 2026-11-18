import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { allotVehicle, releaseAllotment, swapVehicle } from "../../actions";
import { ActionForm } from "../../ui";
import { Card, Chip, Empty, Th, ageDays, canManageStock, fmtDate, inr, one } from "../../shared";

type Named = { name: string };
type Candidate = {
  booking_id: string;
  customer_name: string | null;
  ctdms_order_no: string | null;
  booking_date: string;
  outlet: string;
  variant_name: string | null;
  color_name: string | null;
  matches: boolean;
};

// One car: its CTDMS details, who it is allotted to (with release / swap), the allotment history,
// and the bookings it could go to.
export default async function VehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const employee = await getCurrentEmployee();

  const { data: vehicle } = await supabase
    .from("vehicles")
    .select("*, variants(name, models(name)), colors(name), outlets(name)")
    .eq("id", id)
    .maybeSingle();
  if (!vehicle) notFound();
  const v = vehicle as typeof vehicle & {
    variants: (Named & { models: Named | Named[] | null }) | null;
    colors: Named | null;
    outlets: Named | null;
  };

  const [{ data: history }, { data: candidates }] = await Promise.all([
    supabase
      .from("allotments")
      .select("id, method, override_reason, allotted_at, released_at, release_reason, bookings(id, customer_name, ctdms_order_booking_no)")
      .eq("vehicle_id", id)
      .order("allotted_at", { ascending: false }),
    supabase.rpc("allotment_candidates", { p_vehicle_id: id }),
  ]);
  const active = (history ?? []).find((a) => !a.released_at);
  const activeBooking = active ? one(active.bookings as unknown as { id: string; customer_name: string | null } | null) : null;
  const canAllot = canManageStock(employee);
  const options = ((candidates ?? []) as Candidate[]).map((c) => ({
    id: c.booking_id,
    name: `${c.matches ? "" : "≠ "}${c.customer_name ?? "?"} · ${c.ctdms_order_no ?? "no order no."} · ${fmtDate(c.booking_date)} · ${c.outlet}`,
  }));

  return (
    <div className="space-y-4">
      <div>
        <Link href="/stock" className="text-sm text-slate-500 hover:underline">
          ← Free stock
        </Link>
        <h2 className="mt-1 font-mono text-base font-semibold text-slate-900">{v.vin}</h2>
        <p className="text-sm text-slate-600">
          {one(v.variants?.models ?? null)?.name ?? v.ctdms_model} · {v.variants?.name ?? `suffix ${v.ctdms_suffix_code} (not in master)`} ·{" "}
          {v.colors?.name ?? `${v.ext_color_desc} (colour to map)`} · {v.outlets?.name}
        </p>
        <p className="mt-1 flex flex-wrap gap-2 text-sm">
          {v.source === "transit" ? <Chip tone="blue">In transit</Chip> : <Chip>In the yard</Chip>}
          <Chip tone={v.status === "available" ? "emerald" : v.status === "billed" ? "slate" : "amber"}>{v.status}</Chip>
          {v.missing_from_report && <Chip tone="red">Missing from the latest report</Chip>}
          {v.ctdms_order_status === "Invoiced" && <Chip tone="red">Invoiced in CTDMS</Chip>}
          <span className="text-slate-500">
            Age {ageDays(v) ?? "—"} days · TKM invoice {inr(v.tkm_invoice_amount)} · interest {inr(v.interest_amount)} · engine {v.engine_no ?? "—"}
            {v.key_no ? ` · key ${v.key_no}` : ""}
          </span>
        </p>
        {v.ctdms_block_status && v.ctdms_block_status !== "Free" && (
          <p className="mt-1 text-sm text-slate-600">
            CTDMS: {v.ctdms_block_status} for {v.ctdms_order_no} ({v.ctdms_customer_name ?? "—"}, {v.ctdms_order_status ?? "—"})
          </p>
        )}
      </div>

      {canAllot && v.status !== "billed" && (
        <Card title={active ? "Allotted" : "Allot this car"}>
          <div className="space-y-3 px-3 py-3 text-sm">
            {active && (
              <>
                <p>
                  Allotted to <b>{activeBooking?.customer_name ?? "—"}</b> on {fmtDate(active.allotted_at)} ({active.method})
                  {active.override_reason ? ` — ${active.override_reason}` : ""}
                </p>
                <ActionForm
                  action={releaseAllotment}
                  hidden={{ allotment_id: active.id }}
                  fields={[{ name: "reason", placeholder: "Reason for releasing", required: true, width: "w-72" }]}
                  label="Release"
                  tone="danger"
                  confirm="Release this car? The booking goes back to the queue."
                />
                <ActionForm
                  action={swapVehicle}
                  hidden={{ vehicle_id: v.id }}
                  fields={[
                    { name: "booking_id", placeholder: "Give it to…", options, required: true, width: "w-96" },
                    { name: "reason", placeholder: "Reason for the swap", required: true, width: "w-72" },
                  ]}
                  label="Swap customer"
                  tone="light"
                />
              </>
            )}
            {!active && (
              <ActionForm
                action={allotVehicle}
                hidden={{ vehicle_id: v.id, method: "manual" }}
                fields={[
                  { name: "booking_id", placeholder: "Booking…", options, required: true, width: "w-96" },
                  { name: "reason", placeholder: "Reason (needed if variant/colour differ)", width: "w-72" },
                ]}
                label="Allot"
              />
            )}
            <p className="text-xs text-slate-500">
              {options.length} open bookings of this model can take it; ≠ marks a different variant or colour.
            </p>
          </div>
        </Card>
      )}

      <Card title="Allotment history">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Customer</Th>
              <Th>Order</Th>
              <Th>Allotted</Th>
              <Th>How</Th>
              <Th>Released</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(history ?? []).length === 0 && <Empty cols={5} text="Never allotted." />}
            {(history ?? []).map((a) => {
              const b = one(a.bookings as unknown as { id: string; customer_name: string | null; ctdms_order_booking_no: string | null } | null);
              return (
                <tr key={a.id}>
                  <td className="px-3 py-2">{b?.customer_name ?? "—"}</td>
                  <td className="px-3 py-2">{b?.ctdms_order_booking_no ?? "—"}</td>
                  <td className="px-3 py-2">{fmtDate(a.allotted_at)}</td>
                  <td className="px-3 py-2">
                    {a.method}
                    {a.override_reason ? ` — ${a.override_reason}` : ""}
                  </td>
                  <td className="px-3 py-2">{a.released_at ? `${fmtDate(a.released_at)} — ${a.release_reason ?? ""}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
