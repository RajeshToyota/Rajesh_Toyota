import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { mapColor, markBlockDone } from "../actions";
import { ActionForm } from "../ui";
import { Card, Chip, Empty, Restricted, Th, fmtDate, isBackOffice } from "../shared";

type Task = {
  id: string;
  action: "block" | "unblock";
  created_at: string;
  vehicles: { id: string; vin: string; ctdms_block_status: string | null } | null;
  bookings: { customer_name: string | null; ctdms_order_booking_no: string | null; outlets: { name: string } | null } | null;
};
type Mismatch = {
  kind: string;
  vehicle_id: string;
  vin: string;
  ctdms_block_status: string | null;
  ctdms_order_no: string | null;
  booking_id: string | null;
  booking_order_no: string | null;
  customer_name: string | null;
};

const MISMATCH_LABELS: Record<string, string> = {
  blocked_in_ctdms_only: "Blocked in CTDMS, free with us",
  free_in_ctdms: "Allotted with us, still free in CTDMS",
  different_order: "Blocked in CTDMS for a different order",
  missing_from_report: "Allotted, but missing from the latest report",
  invoiced_in_ctdms: "Invoiced in CTDMS, not billed with us",
};

// What to do in CTDMS after our allotments, where CTDMS disagrees after the last upload, and
// CTDMS colour names still to map.
export default async function CtdmsTodoPage() {
  const employee = await getCurrentEmployee();
  if (!isBackOffice(employee)) return <Restricted text="The CTDMS to-do is for the back office." />;
  const supabase = await createClient();

  const [{ data: tasks }, { data: mismatches }, { data: unmapped }, { data: colors }, { data: batches }] = await Promise.all([
    supabase
      .from("ctdms_block_tasks")
      .select("id, action, created_at, vehicles(id, vin, ctdms_block_status), bookings(customer_name, ctdms_order_booking_no, outlets(name))")
      .eq("status", "pending")
      .order("created_at"),
    supabase.rpc("stock_ctdms_mismatches"),
    supabase
      .from("vehicles")
      .select("variant_id, ctdms_suffix_code, ext_color_desc, variants(name)")
      .eq("status", "available")
      .is("color_id", null)
      .limit(500),
    supabase.from("colors").select("id, name").order("name"),
    supabase.from("stock_import_batches").select("id, source, report_date, file_name, summary, created_at, outlets(name)").order("created_at", { ascending: false }).limit(10),
  ]);

  const todo = (tasks ?? []) as unknown as Task[];
  const mm = (mismatches ?? []) as Mismatch[];
  const colorOptions = (colors ?? []).map((c) => ({ id: c.id, name: c.name }));
  const toMap = new Map<string, { variantId: string | null; suffix: string | null; desc: string; variant: string | null; n: number }>();
  for (const v of (unmapped ?? []) as unknown as {
    variant_id: string | null;
    ctdms_suffix_code: string | null;
    ext_color_desc: string | null;
    variants: { name: string } | null;
  }[]) {
    const key = `${v.variant_id ?? v.ctdms_suffix_code}|${v.ext_color_desc}`;
    const cur = toMap.get(key);
    if (cur) cur.n++;
    else toMap.set(key, { variantId: v.variant_id, suffix: v.ctdms_suffix_code, desc: v.ext_color_desc ?? "", variant: v.variants?.name ?? null, n: 1 });
  }

  return (
    <div>
      <Card title={`Do in CTDMS (${todo.length})`} note="Block or unblock each car in CTDMS for the order shown, then tick it off.">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Action</Th>
              <Th>VIN</Th>
              <Th>Order</Th>
              <Th>Customer</Th>
              <Th>Branch</Th>
              <Th>Since</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {todo.length === 0 && <Empty cols={7} text="Nothing to do in CTDMS." />}
            {todo.map((t) => (
              <tr key={t.id}>
                <td className="px-3 py-2">{t.action === "block" ? <Chip tone="amber">Block</Chip> : <Chip tone="blue">Unblock</Chip>}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  <Link href={`/stock/vehicle/${t.vehicles?.id}`} className="underline">
                    {t.vehicles?.vin}
                  </Link>
                </td>
                <td className="px-3 py-2">{t.bookings?.ctdms_order_booking_no ?? <span className="text-amber-700">Not in CTDMS yet</span>}</td>
                <td className="px-3 py-2">{t.bookings?.customer_name ?? "—"}</td>
                <td className="px-3 py-2">{t.bookings?.outlets?.name ?? "—"}</td>
                <td className="px-3 py-2">{fmtDate(t.created_at)}</td>
                <td className="px-3 py-2">
                  <ActionForm action={markBlockDone} hidden={{ task_id: t.id }} label="Done" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title={`CTDMS disagrees (${mm.length})`} note="From the latest stock upload. Fix it in CTDMS, or allot / release here, then upload again.">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>What</Th>
              <Th>VIN</Th>
              <Th>CTDMS</Th>
              <Th>Ours</Th>
              <Th>Customer</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {mm.length === 0 && <Empty cols={5} text="CTDMS and our allotments agree." />}
            {mm.map((m, i) => (
              <tr key={`${m.kind}-${m.vehicle_id}-${i}`}>
                <td className="px-3 py-2">{MISMATCH_LABELS[m.kind] ?? m.kind}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  <Link href={`/stock/vehicle/${m.vehicle_id}`} className="underline">
                    {m.vin}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  {m.ctdms_block_status ?? "—"} {m.ctdms_order_no ?? ""}
                </td>
                <td className="px-3 py-2">{m.booking_id ? (m.booking_order_no ?? "allotted, no order no.") : "free"}</td>
                <td className="px-3 py-2">{m.customer_name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title={`Colours to map (${toMap.size})`}
        note={
          <>
            CTDMS colour names we could not match. Pick our colour once; it applies to every car with that name and variant. A
            suffix that is not in master data has to be added under{" "}
            <Link href="/admin/variants" className="underline">
              Variants
            </Link>{" "}
            (TKM suffix code) first.
          </>
        }
      >
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Variant</Th>
              <Th>CTDMS colour</Th>
              <Th right>Cars</Th>
              <Th>Our colour</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {toMap.size === 0 && <Empty cols={4} text="Every car's colour is mapped." />}
            {[...toMap.values()].map((m) => (
              <tr key={`${m.variantId ?? m.suffix}|${m.desc}`}>
                <td className="px-3 py-2">{m.variant ?? <Chip tone="red">Suffix {m.suffix} not in master</Chip>}</td>
                <td className="px-3 py-2">{m.desc}</td>
                <td className="px-3 py-2 text-right">{m.n}</td>
                <td className="px-3 py-2">
                  {m.variantId ? (
                    <ActionForm
                      action={mapColor}
                      hidden={{ description: m.desc, variant_id: m.variantId }}
                      fields={[{ name: "color_id", placeholder: "Pick colour…", options: colorOptions, required: true, width: "w-72" }]}
                      label="Map"
                    />
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Recent stock uploads">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Uploaded</Th>
              <Th>Report</Th>
              <Th>Branch</Th>
              <Th>Result</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(batches ?? []).length === 0 && <Empty cols={4} text="No uploads yet." />}
            {(batches ?? []).map((b) => {
              const s = (b.summary ?? {}) as Record<string, number>;
              const outlet = Array.isArray(b.outlets) ? b.outlets[0] : b.outlets;
              return (
                <tr key={b.id}>
                  <td className="px-3 py-2">{new Date(b.created_at).toLocaleString("en-IN")}</td>
                  <td className="px-3 py-2">
                    {b.source === "transit" ? "Transit" : "Physical"} of {fmtDate(b.report_date)}
                    <div className="text-xs text-slate-400">{b.file_name}</div>
                  </td>
                  <td className="px-3 py-2">{(outlet as { name: string } | null)?.name ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    {s.rows} cars · {s.inserted} new · {s.moved_to_physical} arrived from transit · {s.missing_from_report} no longer listed
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
