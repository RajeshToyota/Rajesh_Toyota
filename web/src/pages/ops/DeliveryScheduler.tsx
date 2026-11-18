import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, Loaded, PageHeader, RunButton, inputCls, rpc, rpcRows, str, todayIst } from "@/ui";
import { OutletPicker } from "./shared";

type Cell = {
  outlet_id: string;
  outlet: string;
  slot_date: string;
  slot_time: string;
  capacity: number;
  slot_id: string | null;
  booking_id: string | null;
  customer_name: string | null;
  customer_mobile: string | null;
  model: string | null;
  variant: string | null;
  consultant: string | null;
  open_stages: number | null;
  gate_pass_no: string | null;
  delivered: boolean | null;
};
type Candidate = { booking_id: string; customer_name: string; model: string | null; variant: string | null; outlet: string; delivery_slot: string | null };

const addDays = (d: string, n: number) => new Date(new Date(d).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const dayLabel = (d: string) => new Date(d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

// Techwheels' delivery scheduler: a week of handover slots per branch, with how ready each car is.
export default function DeliveryScheduler() {
  const [from, setFrom] = useState(todayIst());
  const [outlet, setOutlet] = useState("");
  const to = addDays(from, 6);
  const q = useQuery(() => rpcRows<Cell>("delivery_schedule", { p_from: from, p_to: to, p_outlet_id: outlet || null }), [from, outlet]);
  const canBook = useRightGate("delivery_scheduler", "create");

  return (
    <div>
      <PageHeader
        title="Delivery Scheduler"
        note="Book the handover once the car is sent for billing. Green: every ops stage is done; amber: stages still open."
        actions={
          <>
            <RunButton tone="light" label="← Week" run={async () => setFrom(addDays(from, -7))} />
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
            <RunButton tone="light" label="Week →" run={async () => setFrom(addDays(from, 7))} />
            <OutletPicker value={outlet} onChange={setOutlet} />
          </>
        }
      />
      {canBook && <BookSlot from={from} />}
      <Loaded q={q}>{(cells) => <Week cells={cells} from={from} />}</Loaded>
    </div>
  );
}

function Week({ cells, from }: { cells: Cell[]; from: string }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const outlets = useMemo(() => [...new Map(cells.map((c) => [c.outlet_id, c.outlet])).entries()], [cells]);
  return (
    <>
      {outlets.map(([oid, oname]) => {
        const mine = cells.filter((c) => c.outlet_id === oid);
        const times = [...new Set(mine.map((c) => c.slot_time))];
        const capacity = mine[0]?.capacity ?? 1;
        return (
          <Card key={oid} title={oname} note={`${capacity} car${capacity > 1 ? "s" : ""} per slot`}>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="w-16 px-2 py-2" />
                    {days.map((d) => (
                      <th key={d} className="px-2 py-2 text-left text-xs font-medium text-slate-500">
                        {dayLabel(d)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {times.map((t) => (
                    <tr key={t}>
                      <td className="px-2 py-2 align-top text-xs text-slate-500">{t}</td>
                      {days.map((d) => {
                        const here = mine.filter((c) => c.slot_date === d && c.slot_time === t && c.booking_id);
                        return (
                          <td key={d} className="min-w-36 px-2 py-1 align-top">
                            {here.map((c) => (
                              <SlotCar key={c.slot_id!} c={c} />
                            ))}
                            {here.length < capacity && <span className="text-xs text-slate-300">{capacity - here.length} free</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
    </>
  );
}

function SlotCar({ c }: { c: Cell }) {
  const tone = c.delivered ? "blue" : c.open_stages === 0 ? "emerald" : "amber";
  const canEdit = useRightGate("delivery_scheduler", "create");
  return (
    <div className="mb-1 rounded border border-slate-200 bg-white p-1.5 text-xs">
      <Link to={`/reports/bookings/${c.booking_id}`} className="font-medium text-slate-900 hover:underline">
        {c.customer_name}
      </Link>
      <div className="text-slate-500">{[c.model, c.variant].filter(Boolean).join(" ")}</div>
      <div className="text-slate-400">{[c.customer_mobile, c.consultant].filter(Boolean).join(" · ")}</div>
      <div className="mt-1 flex items-center gap-1">
        <Chip tone={tone}>{c.delivered ? "Delivered" : c.open_stages === 0 ? "Ready" : `${c.open_stages} open`}</Chip>
        {c.gate_pass_no && <span className="font-mono text-[10px] text-slate-500">{c.gate_pass_no}</span>}
      </div>
      {canEdit && !c.delivered && (
        <div className="mt-1">
          <ActionForm
            tone="light"
            label="Cancel"
            hidden={{}}
            fields={[{ name: "reason", placeholder: "Reason", required: true, width: "w-24" }]}
            action={async (fd) => {
              await rpc("cancel_delivery_slot", { p_slot_id: c.slot_id, p_reason: str(fd, "reason") });
            }}
          />
        </div>
      )}
    </div>
  );
}

function BookSlot({ from }: { from: string }) {
  const q = useQuery(async () => {
    const rows = await rpcRows<Candidate>("ops_board", { p_stage: null, p_outlet_id: null }).catch(() => [] as Candidate[]);
    return rows;
  }, []);
  const options = (q.data ?? []).map((r) => ({
    id: r.booking_id,
    name: `${r.customer_name} · ${[r.model, r.variant].filter(Boolean).join(" ")} · ${r.outlet}${r.delivery_slot ? ` (now ${r.delivery_slot})` : ""}`,
  }));
  return (
    <Card title="Book or move a delivery" note="Cars sent for billing and not yet delivered. Moving a booking frees its old slot.">
      <div className="px-3 py-2">
        <ActionForm
          label="Book slot"
          hidden={{}}
          fields={[
            { name: "booking", placeholder: "Pick the booking", options, required: true, width: "w-96" },
            { name: "date", placeholder: "Date", type: "date", initial: from, required: true, width: "w-36" },
            { name: "time", placeholder: "Time, e.g. 10:00", required: true, width: "w-28" },
            { name: "note", placeholder: "Note", width: "w-48" },
          ]}
          action={async (fd) => {
            await rpc("book_delivery_slot", {
              p_booking_id: str(fd, "booking"),
              p_date: str(fd, "date"),
              p_time: str(fd, "time"),
              p_note: str(fd, "note"),
            });
          }}
        />
      </div>
    </Card>
  );
}
