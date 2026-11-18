import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { useCurrentEmployee } from "@/lib/auth";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Select, Stat, Table, Td, fmtDate, fmtDateTime, rpc, rpcRows, str, todayIst, type Tone } from "@/ui";
import { OutletPicker } from "./shared";

type FlowRow = {
  booking_id: string;
  customer_name: string;
  outlet_id: string;
  outlet: string;
  car: string;
  vin: string;
  location: string | null;
  stage: string;
  detail: string;
  inspection_id: string | null;
  scheduled_for: string | null;
  slot: string | null;
};

const STAGE: Record<string, { label: string; tone: Tone }> = {
  to_rework: { label: "Rework", tone: "red" },
  pdi_pending: { label: "PDI", tone: "amber" },
  to_move: { label: "Move to bay", tone: "blue" },
  to_wash: { label: "Wash", tone: "blue" },
  ready: { label: "Ready", tone: "emerald" },
  no_vehicle: { label: "No car", tone: "slate" },
};

// Techwheels' PDI flow: failed → workshop → PDI again; passed → delivery bay → wash → ready.
export function PdiFlow() {
  const [outlet, setOutlet] = useState("");
  const canEdit = useRightGate("pdi_board", "edit");
  const q = useQuery(() => rpcRows<FlowRow>("pdi_flow_board", { p_outlet_id: outlet || null }), [outlet]);
  const yards = useQuery(async () => must(await supabase.from("yards").select("id, outlet_id, name, kind").eq("is_active", true)) as { id: string; outlet_id: string; name: string; kind: string }[], []);
  const yardOf = (outletId: string, kind: string) => yards.data?.find((y) => y.outlet_id === outletId && y.kind === kind)?.id;
  const counts = (q.data ?? []).reduce<Record<string, number>>((m, r) => ({ ...m, [r.stage]: (m[r.stage] ?? 0) + 1 }), {});
  return (
    <div>
      <PageHeader title="PDI Flow" note="Every allotted car until it is ready to hand over. The stage follows the PDI result and where the car is." actions={<OutletPicker value={outlet} onChange={setOutlet} />} />
      <div className="mb-4 grid gap-3 sm:grid-cols-5">
        {["to_rework", "pdi_pending", "to_move", "to_wash", "ready"].map((s) => (
          <Stat key={s} label={STAGE[s].label} value={counts[s] ?? 0} tone={s === "to_rework" && counts[s] ? "red" : undefined} />
        ))}
      </div>
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Customer", "Car", "Where", "Stage", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={5} text="No allotted cars." />
              ) : (
                rows.map((r) => (
                  <tr key={r.booking_id}>
                    <Td>
                      <Link to={`/reports/bookings/${r.booking_id}`} className="text-blue-700 hover:underline">{r.customer_name}</Link>
                      <div className="text-xs text-slate-500">{r.outlet}</div>
                    </Td>
                    <Td>
                      {r.car}
                      <div className="font-mono text-xs text-slate-500">{r.vin}</div>
                    </Td>
                    <Td muted>{r.location ?? "—"}</Td>
                    <Td>
                      <Chip tone={STAGE[r.stage]?.tone}>{STAGE[r.stage]?.label ?? r.stage}</Chip>
                      <div className="text-xs text-slate-500">{r.detail}</div>
                    </Td>
                    <Td>
                      {canEdit && (
                        <div className="flex flex-col gap-1">
                          {r.stage === "to_rework" && yardOf(r.outlet_id, "workshop") && (
                            <RunButton label="Moved to workshop" run={() => rpc("pdi_mark_at_location", { p_booking_id: r.booking_id, p_yard_id: yardOf(r.outlet_id, "workshop") })} />
                          )}
                          {r.stage === "pdi_pending" && (
                            <ActionForm
                              tone="light"
                              label={r.inspection_id ? "Move PDI" : "Schedule PDI"}
                              hidden={{}}
                              fields={[
                                { name: "date", placeholder: "Date", type: "date", required: true, width: "w-36", initial: r.scheduled_for ?? todayIst() },
                                { name: "time", placeholder: "Time", type: "time", required: true, width: "w-28", initial: r.slot ?? "" },
                              ]}
                              action={async (fd) => {
                                await rpc("schedule_pdi_at", { p_booking_id: r.booking_id, p_date: str(fd, "date"), p_time: str(fd, "time") });
                              }}
                            />
                          )}
                          {r.stage === "to_move" && yardOf(r.outlet_id, "delivery_bay") && (
                            <RunButton label="At the delivery bay" run={() => rpc("pdi_mark_at_location", { p_booking_id: r.booking_id, p_yard_id: yardOf(r.outlet_id, "delivery_bay") })} />
                          )}
                          {r.stage === "to_wash" && <RunButton label="Washed" run={() => rpc("pdi_mark_washed", { p_booking_id: r.booking_id })} />}
                        </div>
                      )}
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

type Cell = {
  slot_time: string;
  bay_no: number;
  bay: string;
  slot_id: string | null;
  booking_id: string | null;
  customer_name: string | null;
  customer_mobile: string | null;
  car: string | null;
  consultant: string | null;
  open_stages: number | null;
  pdi_stage: string | null;
  gate_pass_no: string | null;
  delivered: boolean | null;
  last_wa_sent: string | null;
  wa_slot_changed: boolean | null;
};

// Techwheels' delivery day board: bays × time slots, each car's readiness, and a WhatsApp to the
// customer (logged, with a warning when the slot has changed since).
export function DeliveryDayBoard() {
  const me = useCurrentEmployee();
  const outlets = useQuery(async () => must(await supabase.from("outlets").select("id, name").eq("is_active", true).order("name")) as { id: string; name: string }[], []);
  const [outlet, setOutlet] = useState("");
  const [date, setDate] = useState(todayIst());
  const oid = outlet || me?.outletId || outlets.data?.[0]?.id || "";
  const q = useQuery(() => (oid ? rpcRows<Cell>("delivery_day_board", { p_outlet_id: oid, p_date: date }) : Promise.resolve([] as Cell[])), [oid, date]);
  const counts = useQuery(() => rpcRows<{ ftd: number; mtd: number; ltd: number }>("delivered_counts", { p_outlet_id: oid || null }), [oid]);
  const times = [...new Set((q.data ?? []).map((c) => c.slot_time))];
  const bays = [...new Map((q.data ?? []).map((c) => [c.bay_no, c.bay])).entries()];

  return (
    <div>
      <PageHeader
        title="Delivery Day Board"
        note="Each bay takes a few cars per slot. Readiness counts the ops stages still open; book a slot from the booking's delivery row below."
        actions={
          <>
            <Select value={oid} onChange={setOutlet} options={outlets.data ?? []} />
            <input type="date" className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={date} onChange={(e) => setDate(e.target.value)} />
          </>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label="Delivered today" value={counts.data?.[0]?.ftd ?? "—"} />
        <Stat label="This month" value={counts.data?.[0]?.mtd ?? "—"} />
        <Stat label="All time" value={counts.data?.[0]?.ltd ?? "—"} />
      </div>
      <BookBay outletId={oid} date={date} onBooked={q.reload} />
      <Card>
        <Loaded q={q}>
          {(cells) => (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-slate-50">
                    <th className="px-2 py-1 text-left text-xs text-slate-500">Time</th>
                    {bays.map(([no, name]) => (
                      <th key={no} className="px-2 py-1 text-left text-xs text-slate-500">{name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {times.map((t) => (
                    <tr key={t} className="border-t border-slate-100 align-top">
                      <td className="px-2 py-1 text-xs text-slate-500">{t}</td>
                      {bays.map(([no]) => (
                        <td key={no} className="px-2 py-1">
                          {cells
                            .filter((c) => c.slot_time === t && c.bay_no === no && c.booking_id)
                            .map((c) => (
                              <BayCar key={c.slot_id} c={c} date={date} onSent={q.reload} />
                            ))}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {cells.length === 0 && (
                    <tr>
                      <td className="px-3 py-6 text-center text-slate-400">Set the branch's hours and bays first.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Loaded>
      </Card>
    </div>
  );
}

function BayCar({ c, date, onSent }: { c: Cell; date: string; onSent: () => void }) {
  const ready = (c.open_stages ?? 0) === 0;
  const text = `Dear ${c.customer_name}, your ${c.car} will be handed over on ${fmtDate(date)} at ${c.slot_time} at Rajesh Toyota. Please carry your ID.`;
  return (
    <div className={`mb-1 rounded border px-2 py-1 text-xs ${c.delivered ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white"}`}>
      <Link to={`/reports/bookings/${c.booking_id}/delivery`} className="font-medium text-blue-700 hover:underline">
        {c.customer_name}
      </Link>
      <div className="text-slate-500">{c.car}</div>
      <div className="mt-0.5 flex flex-wrap gap-1">
        {c.delivered ? <Chip tone="emerald">Delivered</Chip> : ready ? <Chip tone="emerald">Ready</Chip> : <Chip tone="amber">{c.open_stages} left</Chip>}
        {c.pdi_stage && c.pdi_stage !== "ready" && <Chip>{STAGE[c.pdi_stage]?.label ?? c.pdi_stage}</Chip>}
        {c.gate_pass_no && <Chip tone="blue">GP</Chip>}
        {c.last_wa_sent && <Chip tone={c.wa_slot_changed ? "red" : "slate"}>{c.wa_slot_changed ? "slot changed since WhatsApp" : `sent ${fmtDateTime(c.last_wa_sent)}`}</Chip>}
      </div>
      {c.customer_mobile && !c.delivered && (
        <a
          className="text-emerald-700 hover:underline"
          target="_blank"
          rel="noreferrer"
          href={`https://wa.me/91${c.customer_mobile.replace(/\D/g, "").slice(-10)}?text=${encodeURIComponent(text)}`}
          onClick={() => {
            supabase.from("whatsapp_send_log").insert({ context: "delivery", booking_id: c.booking_id, mobile: c.customer_mobile, slot_ref: `${date} ${c.slot_time}` }).then(onSent);
          }}
        >
          WhatsApp
        </a>
      )}
    </div>
  );
}

function BookBay({ outletId, date, onBooked }: { outletId: string; date: string; onBooked: () => void }) {
  const [search, setSearch] = useState("");
  const matches = useQuery(async () => {
    const safe = search.replace(/[,()%*]/g, " ").trim();
    if (safe.length < 3 || !outletId) return [] as { id: string; customer_name: string | null; ctdms_order_booking_no: string | null }[];
    return must(
      await supabase
        .from("bookings")
        .select("id, customer_name, ctdms_order_booking_no")
        .eq("outlet_id", outletId)
        .in("status", ["ready_to_invoice", "allocated"])
        .or(`customer_name.ilike.%${safe}%,ctdms_order_booking_no.ilike.%${safe}%`)
        .limit(8),
    ) as { id: string; customer_name: string | null; ctdms_order_booking_no: string | null }[];
  }, [search, outletId]);
  return (
    <Card title="Book a bay">
      <div className="space-y-1 px-3 py-2 text-sm">
        <input className="rounded-md border border-slate-300 px-2 py-1" placeholder="Customer or CTDMS order no." value={search} onChange={(e) => setSearch(e.target.value)} />
        {(matches.data ?? []).map((b) => (
          <div key={b.id} className="flex flex-wrap items-center gap-2">
            <span className="w-56">{b.customer_name} <span className="text-xs text-slate-500">{b.ctdms_order_booking_no}</span></span>
            <ActionForm
              label="Book"
              hidden={{}}
              fields={[
                { name: "time", placeholder: "Time", type: "time", required: true, width: "w-28" },
                { name: "bay", placeholder: "Bay (auto)", type: "number", width: "w-24" },
                { name: "note", placeholder: "Note", width: "w-32" },
              ]}
              action={async (fd) => {
                await rpc("book_delivery_bay", { p_booking_id: b.id, p_date: date, p_time: str(fd, "time"), p_bay_no: str(fd, "bay") ? Number(str(fd, "bay")) : null, p_note: str(fd, "note") });
                setSearch("");
                onBooked();
              }}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}
