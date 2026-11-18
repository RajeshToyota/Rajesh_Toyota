import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, Stat, Table, Td, fmtDate, rpc, rpcRows, str } from "@/ui";

export const BUCKETS = [
  { id: "on_hold", label: "On hold", note: "Booking held" },
  { id: "docket", label: "Docket", note: "Welcome Docket not complete" },
  { id: "finance", label: "Finance", note: "Loan before DO" },
  { id: "allotment", label: "Allotment", note: "No car yet" },
  { id: "billing", label: "Billing", note: "Car allotted, not sent for billing" },
  { id: "ops", label: "Ops", note: "Insurance, RTO, PDI…" },
  { id: "ready", label: "Ready", note: "All stages done" },
];
export const bucketLabel = (id: string) => BUCKETS.find((b) => b.id === id)?.label ?? id;

type Row = {
  booking_id: string;
  customer_name: string;
  mobile: string | null;
  order_no: string | null;
  booked_on: string;
  outlet: string;
  consultant: string | null;
  rm: string | null;
  rm_employee_id: string | null;
  model: string | null;
  variant: string | null;
  color: string | null;
  bucket: string;
  open_requests: number;
  open_tasks: number;
  last_note_at: string | null;
  delivery_slot: string | null;
  likely_delivery_date: string | null;
};
type Candidate = { id: string; name: string; role: string; open_bookings: number };

// Techwheels' RM console: after booking, a Relationship Manager owns the customer until delivery.
// The pipeline shows where each booking is stuck.
export default function RmConsole() {
  const [params, setParams] = useSearchParams();
  const bucket = params.get("bucket") ?? "";
  const [rm, setRm] = useState("");
  const canAssign = useRightGate("rm_assign", "edit");
  const counts = useQuery(() => rpcRows<{ bucket: string; bookings: number }>("rm_pipeline_counts", { p_rm: rm || null }), [rm]);
  const list = useQuery(() => rpcRows<Row>("rm_pipeline", { p_bucket: bucket || null, p_rm: rm || null }), [bucket, rm]);
  const count = (id: string) => counts.data?.find((c) => c.bucket === id)?.bookings ?? 0;

  return (
    <div>
      <PageHeader
        title="RM Console"
        note="Open bookings from booking to delivery. Click a stage to see who is waiting there."
        actions={
          canAssign && (
            <select value={rm} onChange={(e) => setRm(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
              <option value="">All RMs</option>
              <option value="none">Unassigned</option>
              {[...new Map((list.data ?? []).filter((r) => r.rm_employee_id).map((r) => [r.rm_employee_id!, r.rm!])).entries()].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          )
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-7">
        {BUCKETS.map((b) => (
          <button key={b.id} type="button" onClick={() => setParams(bucket === b.id ? {} : { bucket: b.id })} className={`text-left ${bucket === b.id ? "ring-2 ring-slate-900" : ""} rounded-md`}>
            <Stat label={b.label} value={count(b.id)} note={b.note} tone={b.id === "on_hold" && count(b.id) ? "amber" : undefined} />
          </button>
        ))}
      </div>
      <Card title={bucket ? `${bucketLabel(bucket)} (${list.data?.length ?? 0})` : `All open bookings (${list.data?.length ?? 0})`}>
        <Loaded q={list}>
          {(rows) => (
            <Table head={["Customer", "Car", "Booked", "Stage", "RM", "Follow-up"]}>
              {rows.length === 0 ? (
                <EmptyRow cols={6} text="No bookings here." />
              ) : (
                rows.map((r) => (
                  <tr key={r.booking_id}>
                    <Td>
                      <Link to={`/rm/booking/${r.booking_id}`} className="font-medium text-slate-900 hover:underline">
                        {r.customer_name}
                      </Link>
                      <div className="text-xs text-slate-500">{[r.mobile, r.order_no, r.consultant].filter(Boolean).join(" · ")}</div>
                    </Td>
                    <Td>{[r.model, r.variant, r.color].filter(Boolean).join(" · ")}</Td>
                    <Td muted>
                      {fmtDate(r.booked_on)}
                      <div className="text-xs">{r.outlet}</div>
                    </Td>
                    <Td>
                      <Chip tone={r.bucket === "ready" ? "emerald" : r.bucket === "on_hold" ? "red" : "amber"}>{bucketLabel(r.bucket)}</Chip>
                      {r.delivery_slot && <div className="text-xs text-slate-500">Delivery {r.delivery_slot}</div>}
                    </Td>
                    <Td>
                      {r.rm ?? <span className="text-slate-400">—</span>}
                      {canAssign && <AssignRm bookingId={r.booking_id} />}
                    </Td>
                    <Td muted>
                      {r.open_requests > 0 && <Chip tone="red">{r.open_requests} request{r.open_requests > 1 ? "s" : ""}</Chip>}{" "}
                      {r.open_tasks > 0 && <Chip tone="amber">{r.open_tasks} task{r.open_tasks > 1 ? "s" : ""}</Chip>}
                      <div className="text-xs">{r.last_note_at ? `Last note ${fmtDate(r.last_note_at)}` : "No notes yet"}</div>
                    </Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
      </Card>
    </div>
  );
}

function AssignRm({ bookingId }: { bookingId: string }) {
  const [outletRms, setOutletRms] = useState<Candidate[] | null>(null);
  if (!outletRms) {
    return (
      <button
        type="button"
        className="block text-xs text-slate-600 underline"
        onClick={async () => {
          const detail = await rpc<{ booking: { outlet_id: string } }>("rm_booking_detail", { p_booking_id: bookingId }, { refresh: false });
          setOutletRms(await rpcRows<Candidate>("rm_candidates", { p_outlet_id: detail.booking.outlet_id }));
        }}
      >
        Assign
      </button>
    );
  }
  return (
    <ActionForm
      label="Save"
      hidden={{}}
      fields={[{ name: "rm", placeholder: "Pick RM", options: outletRms.map((c) => ({ id: c.id, name: `${c.name} (${c.open_bookings})` })), required: true, width: "w-40" }]}
      action={async (fd) => {
        await rpc("rm_assign_booking", { p_booking_id: bookingId, p_rm_employee_id: str(fd, "rm") });
        setOutletRms(null);
      }}
    />
  );
}
