import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import {
  ActionForm,
  Card,
  Chip,
  EmptyRow,
  ErrorBox,
  Loaded,
  PageHeader,
  RunButton,
  Table,
  Td,
  inputCls,
  rpc,
  rpcRows,
  str,
  todayIst,
} from "@/ui";
import { OutletPicker, carLine } from "./shared";

type BoardRow = {
  kind: "scheduled" | "waiting";
  inspection_id: string | null;
  booking_id: string;
  outlet: string;
  customer_name: string;
  model: string | null;
  variant: string | null;
  color: string | null;
  vin: string | null;
  scheduled_for: string | null;
  slot: string | null;
  status: string;
  remarks: string | null;
  inspected_by: string | null;
};
type Item = { code: string; section: string; label: string; sort_order: number };

// Techwheels' PDI board: the day's inspections and the allotted yard cars still waiting for one.
export default function PdiBoard() {
  const [date, setDate] = useState(todayIst());
  const [outlet, setOutlet] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const board = useQuery(() => rpcRows<BoardRow>("pdi_board", { p_date: date, p_outlet_id: outlet || null }), [date, outlet]);
  const items = useQuery(async () => must(await supabase.from("pdi_checklist_items").select("code, section, label, sort_order").eq("is_active", true).order("sort_order")) as Item[], []);
  const canSchedule = useRightGate("pdi_board", "create");
  const canRecord = useRightGate("pdi_board", "edit");

  return (
    <div>
      <PageHeader
        title="PDI Board"
        note="Pre-delivery inspection. Every item is checked; one fail fails the PDI and the car needs another. A pass ticks PDI on the delivery checklist."
        actions={
          <>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
            <OutletPicker value={outlet} onChange={setOutlet} />
          </>
        }
      />
      <Loaded q={board}>
        {(rows) => {
          const scheduled = rows.filter((r) => r.kind === "scheduled");
          const waiting = rows.filter((r) => r.kind === "waiting");
          return (
            <>
              <Card title={`PDIs on ${new Date(date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} (${scheduled.length})`}>
                <Table head={["Slot", "Customer", "Car", "Status", ""]}>
                  {scheduled.length === 0 ? (
                    <EmptyRow cols={5} text="No PDIs booked for this day." />
                  ) : (
                    scheduled.flatMap((r) => [
                      <tr key={r.inspection_id!}>
                        <Td muted>{r.slot ?? "—"}</Td>
                        <Td>
                          {r.customer_name}
                          <div className="text-xs text-slate-500">{r.outlet}</div>
                        </Td>
                        <Td>
                          {carLine(r)}
                          <div className="font-mono text-xs text-slate-500">{r.vin}</div>
                        </Td>
                        <Td>
                          <Chip tone={r.status === "passed" ? "emerald" : r.status === "failed" ? "red" : "amber"}>{r.status}</Chip>
                          {r.remarks && <div className="text-xs text-slate-500">{r.remarks}</div>}
                          {r.inspected_by && <div className="text-xs text-slate-400">by {r.inspected_by}</div>}
                        </Td>
                        <Td>
                          {r.status === "scheduled" && (
                            <div className="flex gap-1">
                              {canRecord && (
                                <RunButton
                                  label={open === r.inspection_id ? "Close" : "Record result"}
                                  run={async () => setOpen(open === r.inspection_id ? null : r.inspection_id)}
                                />
                              )}
                              {canSchedule && (
                                <ActionForm
                                  tone="danger"
                                  label="Cancel"
                                  hidden={{}}
                                  fields={[{ name: "reason", placeholder: "Reason", width: "w-28" }]}
                                  action={async (fd) => {
                                    await rpc("cancel_pdi", { p_inspection_id: r.inspection_id, p_reason: str(fd, "reason") });
                                  }}
                                />
                              )}
                            </div>
                          )}
                        </Td>
                      </tr>,
                      open === r.inspection_id && items.data ? (
                        <tr key={`${r.inspection_id}-form`}>
                          <td colSpan={5} className="bg-slate-50 px-3 py-3">
                            <Checklist
                              items={items.data}
                              onSubmit={async (results, remarks) => {
                                await rpc("record_pdi_result", { p_inspection_id: r.inspection_id, p_results: results, p_remarks: remarks });
                                setOpen(null);
                              }}
                            />
                          </td>
                        </tr>
                      ) : null,
                    ])
                  )}
                </Table>
              </Card>
              <Card title={`Waiting for a PDI (${waiting.length})`} note="Allotted cars in the yard with no PDI booked, or whose last PDI failed.">
                <Table head={["Customer", "Car", "Last result", "Book"]}>
                  {waiting.length === 0 ? (
                    <EmptyRow cols={4} text="Every allotted yard car has a PDI." />
                  ) : (
                    waiting.map((r) => (
                      <tr key={r.booking_id}>
                        <Td>
                          {r.customer_name}
                          <div className="text-xs text-slate-500">{r.outlet}</div>
                        </Td>
                        <Td>
                          {carLine(r)}
                          <div className="font-mono text-xs text-slate-500">{r.vin}</div>
                        </Td>
                        <Td>{r.status === "failed" ? <Chip tone="red">Failed: {r.remarks}</Chip> : <Chip>Not booked</Chip>}</Td>
                        <Td>
                          {canSchedule && (
                            <ActionForm
                              label="Book"
                              hidden={{}}
                              fields={[
                                { name: "date", placeholder: "Date", type: "date", initial: date, required: true, width: "w-36" },
                                { name: "slot", placeholder: "Time", width: "w-20" },
                              ]}
                              action={async (fd) => {
                                await rpc("schedule_pdi", { p_booking_id: r.booking_id, p_date: str(fd, "date"), p_slot: str(fd, "slot") });
                              }}
                            />
                          )}
                        </Td>
                      </tr>
                    ))
                  )}
                </Table>
              </Card>
            </>
          );
        }}
      </Loaded>
    </div>
  );
}

function Checklist({ items, onSubmit }: { items: Item[]; onSubmit: (results: Record<string, string>, remarks: string) => Promise<void> }) {
  const [results, setResults] = useState<Record<string, string>>(() => Object.fromEntries(items.map((i) => [i.code, "ok"])));
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sections = [...new Set(items.map((i) => i.section))];
  const fails = Object.values(results).filter((v) => v === "fail").length;
  return (
    <div>
      {error && <ErrorBox message={error} />}
      <div className="grid gap-3 md:grid-cols-2">
        {sections.map((sec) => (
          <div key={sec}>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{sec}</p>
            {items
              .filter((i) => i.section === sec)
              .map((i) => (
                <div key={i.code} className="flex items-center justify-between gap-2 py-0.5 text-sm">
                  <span>{i.label}</span>
                  <span className="flex gap-1">
                    {(["ok", "fail", "na"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setResults((r) => ({ ...r, [i.code]: v }))}
                        className={`rounded px-2 py-0.5 text-xs ${
                          results[i.code] === v
                            ? v === "ok"
                              ? "bg-emerald-600 text-white"
                              : v === "fail"
                                ? "bg-red-600 text-white"
                                : "bg-slate-600 text-white"
                            : "border border-slate-300 text-slate-600"
                        }`}
                      >
                        {v.toUpperCase()}
                      </button>
                    ))}
                  </span>
                </div>
              ))}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder={fails ? "What failed (required)" : "Remarks"}
          className={`${inputCls} w-96`}
        />
        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await onSubmit(results, remarks);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setSaving(false);
            }
          }}
          className={`rounded-md px-3 py-1 text-sm font-medium text-white ${fails ? "bg-red-600" : "bg-emerald-600"} disabled:opacity-50`}
        >
          {saving ? "…" : fails ? `Fail PDI (${fails})` : "Pass PDI"}
        </button>
      </div>
    </div>
  );
}
