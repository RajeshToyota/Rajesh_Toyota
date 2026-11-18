import { Link, useParams } from "react-router-dom";
import { useQuery } from "@/lib/query";
import { ActionForm, Card, Chip, Loaded, PageHeader, RunButton, Stat, Td, Table, EmptyRow, fmtDate, fmtDateTime, inr, rpc, str, titleCase } from "@/ui";
import { STAGES, StageChip, type StageState } from "@/pages/ops/shared";
import { bucketLabel } from "./RmConsole";
import { localDateTime, toIso } from "./shared";

type Detail = {
  booking: {
    id: string;
    customer_name: string;
    mobile: string | null;
    email: string | null;
    order_no: string | null;
    status: string;
    booked_on: string;
    outlet: string;
    consultant: string | null;
    rm: string | null;
    model: string | null;
    variant: string | null;
    color: string | null;
    mode_of_purchase: string | null;
    total_amount: number | null;
    likely_delivery_date: string | null;
    bucket: string;
  };
  account: { deal_amount: number; cleared: number; pending: number; outstanding: number } | null;
  vehicle: { vin: string; source: string; location: string | null } | null;
  finance: { status: string; financier: string | null; loan_amount: number | null } | null;
  stages: { stage: string; status: StageState["status"]; detail: string }[];
  slot: { id: string; date: string; time: string } | null;
  notes: { id: string; kind: string; body: string; author: string; created_at: string }[];
  requests: { id: string; kind: string; detail: string; status: string; resolution: string | null; created_at: string; created_by: string | null }[];
  tasks: { id: string; title: string; due_at: string | null; status: string; assigned_to: string }[];
};

const REQUEST_KINDS = [
  { id: "delivery_date", name: "Delivery date" },
  { id: "accessories", name: "Accessories" },
  { id: "finance", name: "Finance" },
  { id: "documents", name: "Documents" },
  { id: "colour_variant_change", name: "Colour / variant change" },
  { id: "cancellation", name: "Cancellation" },
  { id: "other", name: "Other" },
];

// Techwheels' RM booking 360: one page with everything about the customer's booking.
export default function RmBooking() {
  const { id = "" } = useParams();
  const q = useQuery(() => rpc<Detail>("rm_booking_detail", { p_booking_id: id }, { refresh: false }), [id]);

  return (
    <Loaded q={q}>
      {(d) => {
        const b = d.booking;
        const stages = Object.fromEntries(d.stages.map((s) => [s.stage, { status: s.status, detail: s.detail }]));
        return (
          <div>
            <PageHeader
              title={b.customer_name}
              note={
                <>
                  {[b.mobile, b.email, b.order_no, b.outlet].filter(Boolean).join(" · ")} ·{" "}
                  <Link to={`/reports/bookings/${b.id}`} className="underline">
                    Booking file
                  </Link>
                </>
              }
              actions={<Chip tone={b.bucket === "ready" ? "emerald" : "amber"}>{bucketLabel(b.bucket)}</Chip>}
            />
            <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
              <Stat label="Car" value={b.model ?? "—"} note={[b.variant, b.color].filter(Boolean).join(" · ")} />
              <Stat label="Booked" value={fmtDate(b.booked_on)} note={`${b.consultant ?? ""}${b.rm ? ` · RM ${b.rm}` : ""}`} />
              <Stat
                label="Outstanding"
                value={inr(d.account?.outstanding)}
                note={`Deal ${inr(d.account?.deal_amount)} · pending ${inr(d.account?.pending)}`}
                tone={Number(d.account?.outstanding) > 0 ? "amber" : undefined}
              />
              <Stat
                label="Delivery"
                value={d.slot ? `${fmtDate(d.slot.date)} ${d.slot.time}` : fmtDate(b.likely_delivery_date)}
                note={d.slot ? "Slot booked" : "Likely date"}
              />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <Card title="Where it stands">
                  <div className="space-y-1 px-3 py-2 text-sm">
                    <p>
                      <span className="text-slate-500">Purchase:</span> {b.mode_of_purchase ?? "—"}
                      {d.finance && (
                        <>
                          {" "}
                          · {d.finance.financier} {inr(d.finance.loan_amount)} <Chip>{titleCase(d.finance.status)}</Chip>
                        </>
                      )}
                    </p>
                    <p>
                      <span className="text-slate-500">Car:</span>{" "}
                      {d.vehicle ? `${d.vehicle.vin} (${d.vehicle.source === "physical" ? "in the yard" : "in transit"})` : "Not allotted yet"}
                    </p>
                    {d.stages.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {STAGES.map((s) => (
                          <StageChip key={s.id} stage={s.id} state={stages[s.id]} />
                        ))}
                      </div>
                    )}
                  </div>
                </Card>
                <Card title="Customer requests">
                  <Table head={["Request", "Status", ""]}>
                    {d.requests.length === 0 ? (
                      <EmptyRow cols={3} text="No requests." />
                    ) : (
                      d.requests.map((r) => (
                        <tr key={r.id}>
                          <Td>
                            <span className="font-medium">{REQUEST_KINDS.find((k) => k.id === r.kind)?.name}</span>
                            <div className="text-xs text-slate-500">{r.detail}</div>
                            {r.resolution && <div className="text-xs text-emerald-700">{r.resolution}</div>}
                          </Td>
                          <Td>
                            <Chip tone={r.status === "done" ? "emerald" : r.status === "rejected" ? "slate" : "amber"}>{titleCase(r.status)}</Chip>
                          </Td>
                          <Td>
                            {(r.status === "open" || r.status === "in_progress") && (
                              <div className="flex flex-col gap-1">
                                {r.status === "open" && (
                                  <RunButton tone="light" label="Working on it" run={() => rpc("update_customer_request", { p_request_id: r.id, p_status: "in_progress" })} />
                                )}
                                <ActionForm
                                  label="Close"
                                  hidden={{}}
                                  fields={[{ name: "res", placeholder: "What was done", required: true, width: "w-40" }]}
                                  action={async (fd) => {
                                    await rpc("update_customer_request", { p_request_id: r.id, p_status: "done", p_resolution: str(fd, "res") });
                                  }}
                                />
                              </div>
                            )}
                          </Td>
                        </tr>
                      ))
                    )}
                  </Table>
                  <div className="border-t border-slate-100 px-3 py-2">
                    <ActionForm
                      label="Add request"
                      hidden={{}}
                      fields={[
                        { name: "kind", placeholder: "Type", options: REQUEST_KINDS, required: true, width: "w-40" },
                        { name: "detail", placeholder: "What the customer asked", required: true, width: "w-64" },
                      ]}
                      action={async (fd) => {
                        await rpc("raise_customer_request", { p_booking_id: b.id, p_kind: str(fd, "kind"), p_detail: str(fd, "detail") });
                      }}
                    />
                  </div>
                </Card>
              </div>
              <div>
                <Card title="Notes">
                  <div className="border-b border-slate-100 px-3 py-2">
                    <ActionForm
                      label="Add note"
                      hidden={{}}
                      fields={[
                        {
                          name: "kind",
                          placeholder: "Type",
                          options: [
                            { id: "call", name: "Call" },
                            { id: "whatsapp", name: "WhatsApp" },
                            { id: "visit", name: "Visit" },
                            { id: "note", name: "Note" },
                          ],
                          width: "w-28",
                        },
                        { name: "body", placeholder: "What happened", required: true, width: "w-72" },
                      ]}
                      action={async (fd) => {
                        await rpc("add_booking_note", { p_booking_id: b.id, p_body: str(fd, "body"), p_kind: str(fd, "kind") ?? "note" });
                      }}
                    />
                  </div>
                  <ul className="divide-y divide-slate-100">
                    {d.notes.length === 0 && <li className="px-3 py-4 text-center text-sm text-slate-400">No notes yet.</li>}
                    {d.notes.map((n) => (
                      <li key={n.id} className="px-3 py-2 text-sm">
                        <span className="text-xs text-slate-400">
                          {fmtDateTime(n.created_at)} · {n.author} · {n.kind}
                        </span>
                        <p>{n.body}</p>
                      </li>
                    ))}
                  </ul>
                </Card>
                <Card title="Tasks">
                  <ul className="divide-y divide-slate-100">
                    {d.tasks.map((t) => (
                      <li key={t.id} className="flex items-center justify-between px-3 py-2 text-sm">
                        <span>
                          {t.title}
                          <span className="ml-2 text-xs text-slate-400">
                            {t.assigned_to} · {fmtDateTime(t.due_at)}
                          </span>
                        </span>
                        {t.status === "open" ? (
                          <RunButton tone="light" label="Done" run={() => rpc("complete_task", { p_task_id: t.id, p_status: "done" })} />
                        ) : (
                          <Chip tone="emerald">{t.status}</Chip>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="border-t border-slate-100 px-3 py-2">
                    <ActionForm
                      label="Add task"
                      hidden={{}}
                      fields={[
                        { name: "title", placeholder: "To do", required: true, width: "w-56" },
                        { name: "due", placeholder: "Due", type: "datetime-local", initial: localDateTime(new Date(Date.now() + 86_400_000)), width: "w-44" },
                      ]}
                      action={async (fd) => {
                        await rpc("create_task", { p_title: str(fd, "title"), p_due_at: toIso(str(fd, "due")), p_booking_id: b.id });
                      }}
                    />
                  </div>
                </Card>
              </div>
            </div>
          </div>
        );
      }}
    </Loaded>
  );
}
