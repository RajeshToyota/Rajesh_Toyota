import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Table, Tabs, Td, fmtDate, fmtDateTime, inr, num, rpc, rpcRows, str, todayIst } from "@/ui";
import { OutletPicker, STAGES, StageChip, carLine, type StageId, type StageState } from "../shared";

type Row = {
  booking_id: string;
  outlet_id: string;
  outlet: string;
  customer_name: string;
  customer_mobile: string | null;
  order_no: string | null;
  consultant: string | null;
  model: string | null;
  variant: string | null;
  color: string | null;
  vin: string | null;
  invoice_no: string | null;
  invoice_date: string | null;
  outstanding: number;
  stages: Record<StageId, StageState>;
};

// One Ops Billing desk (Techwheels' OpsBilling<Stage>Page): the cars waiting on this stage, or all of
// them, each with the desk's panel.
function StageScreen({
  stage,
  title,
  note,
  extra,
  panel,
}: {
  stage: StageId;
  title: string;
  note: string;
  extra?: (outlet: string) => ReactNode;
  panel: (row: Row, reload: () => void) => ReactNode;
}) {
  const [outlet, setOutlet] = useState("");
  const [waitingOnly, setWaitingOnly] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery(() => rpcRows<Row>("ops_board", { p_stage: waitingOnly ? stage : null, p_outlet_id: outlet || null }), [stage, outlet, waitingOnly]);
  return (
    <div>
      <PageHeader
        title={title}
        note={note}
        actions={
          <>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={waitingOnly} onChange={(e) => setWaitingOnly(e.target.checked)} /> Waiting on this desk
            </label>
            <OutletPicker value={outlet} onChange={setOutlet} />
          </>
        }
      />
      {extra?.(outlet)}
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Customer", "Car", "Invoice", "Due", "Stages", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={6} text="Nothing waiting." />
              ) : (
                rows.flatMap((r) => [
                  <tr key={r.booking_id}>
                    <Td>
                      <Link to={`/reports/bookings/${r.booking_id}`} className="text-blue-700 hover:underline">
                        {r.customer_name}
                      </Link>
                      <div className="text-xs text-slate-500">
                        {r.order_no ?? "—"} · {r.consultant} · {r.outlet}
                      </div>
                    </Td>
                    <Td>
                      {carLine(r)}
                      <div className="font-mono text-xs text-slate-500">{r.vin}</div>
                    </Td>
                    <Td muted>
                      {r.invoice_no ?? "Not invoiced"}
                      <div className="text-xs">{fmtDate(r.invoice_date)}</div>
                    </Td>
                    <Td right>{r.outstanding > 0 ? <Chip tone="amber">{inr(r.outstanding)}</Chip> : <Chip tone="emerald">Paid</Chip>}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {STAGES.map((s) => (
                          <StageChip key={s.id} stage={s.id} state={r.stages?.[s.id]} />
                        ))}
                      </div>
                      <p className="mt-1 text-xs text-slate-500">{r.stages?.[stage]?.detail}</p>
                    </Td>
                    <Td>
                      <button type="button" className="text-sm text-blue-700 hover:underline" onClick={() => setOpen(open === r.booking_id ? null : r.booking_id)}>
                        {open === r.booking_id ? "Close" : "Work on it"}
                      </button>
                    </Td>
                  </tr>,
                  open === r.booking_id && (
                    <tr key={`${r.booking_id}-panel`}>
                      <td colSpan={6} className="bg-slate-50 px-3 py-3">
                        {panel(r, q.reload)}
                        <Reopen row={r} stage={stage} />
                      </td>
                    </tr>
                  ),
                ])
              )}
            </Table>
          )}
        </Loaded>
      </Card>
    </div>
  );
}

function MarkStage({ row, stage, needsNote, refLabel }: { row: Row; stage: string; needsNote?: boolean; refLabel?: string }) {
  if (row.stages?.[stage as StageId]?.status !== "pending") return null;
  return (
    <ActionForm
      label="Mark done"
      hidden={{}}
      fields={[
        { name: "note", placeholder: needsNote ? "How it is covered" : "Note", required: !!needsNote, width: "w-52" },
        ...(refLabel ? [{ name: "ref", placeholder: refLabel, width: "w-32" }] : []),
      ]}
      action={async (fd) => {
        await rpc("ops_mark_stage", { p_booking_id: row.booking_id, p_stage: stage, p_status: "done", p_note: str(fd, "note"), p_ref_no: str(fd, "ref") });
      }}
    />
  );
}

function Reopen({ row, stage }: { row: Row; stage: StageId }) {
  const [show, setShow] = useState(false);
  const types = useQuery(async () => (show ? (must(await supabase.from("booking_document_types").select("code, label").order("sort_order")) as { code: string; label: string }[]) : []), [show]);
  const [docs, setDocs] = useState<string[]>([]);
  if (!["accounts", "accessories", "scheme", "scrap", "pdi", "gate_pass", "billing"].includes(stage)) return null;
  if (!show)
    return (
      <button type="button" className="mt-2 text-xs text-slate-500 underline" onClick={() => setShow(true)}>
        Ask to reopen a stage…
      </button>
    );
  return (
    <div className="mt-3 space-y-1 border-t border-slate-200 pt-2 text-sm">
      <p className="text-xs text-slate-500">The Outlet Head decides. Reopening billing cancels the invoice; documents you tick are cleared.</p>
      <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto text-xs">
        {(types.data ?? []).map((t) => (
          <label key={t.code} className="flex items-center gap-1">
            <input type="checkbox" checked={docs.includes(t.code)} onChange={() => setDocs(docs.includes(t.code) ? docs.filter((x) => x !== t.code) : [...docs, t.code])} />
            {t.label}
          </label>
        ))}
      </div>
      <ActionForm
        tone="danger"
        label="Ask to reopen"
        hidden={{}}
        fields={[
          {
            name: "stage",
            placeholder: "Stage",
            options: [{ id: "billing", name: "Billing (cancel invoice)" }, ...STAGES.filter((s) => ["accounts", "accessories", "scheme", "scrap", "pdi", "gate_pass"].includes(s.id)).map((s) => ({ id: s.id, name: s.label }))],
            required: true,
            width: "w-44",
            initial: stage,
          },
          { name: "reason", placeholder: "Reason", required: true, width: "w-56" },
        ]}
        action={async (fd) => {
          await rpc("request_stage_reversal_v2", { p_booking_id: row.booking_id, p_stage: str(fd, "stage"), p_reason: str(fd, "reason"), p_documents: docs });
          setShow(false);
        }}
      />
    </div>
  );
}

type Rework = { id: string; booking_id: string; stage: string; kind: string; amount: number; remarks: string; status: string; requested_at: string; bookings: { customer_name: string } | null };

function ReworkRequest({ row, stage, kinds }: { row: Row; stage: "insurance" | "accessories"; kinds: { id: string; name: string }[] }) {
  return (
    <ActionForm
      tone="light"
      label="Ask Accounts for a rework"
      hidden={{}}
      fields={[
        { name: "kind", placeholder: "What", options: kinds, required: true, width: "w-40" },
        { name: "amount", placeholder: "New amount (0 = none)", type: "number", required: true, width: "w-40" },
        { name: "remarks", placeholder: "Remarks", required: true, width: "w-56" },
      ]}
      action={async (fd) => {
        await rpc("request_rework", { p_booking_id: row.booking_id, p_stage: stage, p_kind: str(fd, "kind"), p_amount: num(fd, "amount"), p_remarks: str(fd, "remarks") });
      }}
    />
  );
}

// ===== Accounts =====
export function AccountsStage() {
  return (
    <StageScreen
      stage="accounts"
      title="Ops Billing: Accounts"
      note="Done by itself when nothing is due; otherwise Accounts confirms how the balance is covered (e.g. the DO). Reworks asked by the insurance and accessories desks are approved here."
      extra={() => <ReworkQueue />}
      panel={(r) => (
        <div className="space-y-2">
          <Due bookingId={r.booking_id} />
          <div className="flex flex-wrap gap-2 text-sm">
            <Link className="text-blue-700 hover:underline" to={`/reports/bookings/${r.booking_id}/payments`}>
              Receipts
            </Link>
          </div>
          <MarkStage row={r} stage="accounts" needsNote />
        </div>
      )}
    />
  );
}

function Due({ bookingId }: { bookingId: string }) {
  const q = useQuery(() => rpcRows<{ deal_amount: number; do_amount: number; other_cleared: number; due: number }>("booking_due", { p_booking_id: bookingId }), [bookingId]);
  const d = q.data?.[0];
  if (!d) return null;
  return (
    <p className="text-sm">
      Deal {inr(d.deal_amount)} − DO {inr(d.do_amount)} − other receipts {inr(d.other_cleared)} = <strong>due {inr(d.due)}</strong>
    </p>
  );
}

function ReworkQueue() {
  const q = useQuery(
    async () => must(await supabase.from("ops_reworks").select("id, booking_id, stage, kind, amount, remarks, status, requested_at, bookings(customer_name)").eq("status", "requested").order("requested_at")) as unknown as Rework[],
    [],
  );
  if (!q.data?.length) return null;
  return (
    <Card title="Reworks waiting for Accounts">
      <Table head={["Customer", "Stage", "Change", "New amount", ""]}>
        {q.data.map((w) => (
          <tr key={w.id}>
            <Td>{w.bookings?.customer_name}</Td>
            <Td>{w.stage}</Td>
            <Td>
              {w.kind.replace("_", " ")} <div className="text-xs text-slate-500">{w.remarks}</div>
            </Td>
            <Td right>{inr(w.amount)}</Td>
            <Td>
              <div className="flex gap-1">
                <RunButton label="Approve" run={async () => { await rpc("resolve_rework", { p_rework_id: w.id, p_approve: true }); q.reload(); }} />
                <RunButton
                  tone="danger"
                  label="Reject"
                  run={async () => {
                    const why = window.prompt("Why?");
                    if (why) {
                      await rpc("resolve_rework", { p_rework_id: w.id, p_approve: false, p_note: why });
                      q.reload();
                    }
                  }}
                />
              </div>
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

// ===== CRM billing =====
type Tracker = { booking_id: string; customer_name: string; outlet: string; consultant: string | null; status: string; booked_on: string; lag_days: number; missing: string };

export function CrmBillingStage() {
  return (
    <StageScreen
      stage="billing"
      title="Ops Billing: CRM Billing"
      note="Invoice in CTDMS, then record the invoice against the car allotted to the booking (Stock → Billing). Bookings still missing their CTDMS order number or date are listed above."
      extra={(outlet) => <CtdmsTracker outlet={outlet} />}
      panel={(r) => (
        <div className="text-sm">
          {r.invoice_no ? `Invoiced ${r.invoice_no}` : (
            <Link to="/stock/billing" className="text-blue-700 hover:underline">
              Record the invoice on the Billing page
            </Link>
          )}
        </div>
      )}
    />
  );
}

function CtdmsTracker({ outlet }: { outlet: string }) {
  const q = useQuery(() => rpcRows<Tracker>("ctdms_order_tracker", { p_outlet_id: outlet || null }), [outlet]);
  return (
    <Card title={`CTDMS order details missing (${q.data?.length ?? 0})`} note="Every booking should get its CTDMS order number and date within a day.">
      <Loaded q={q}>
        {(rows) => (
          <Table head={["Customer", "Branch", "Booked", "Lag", "Missing"]}>
            {rows.length === 0 ? (
              <EmptyRow cols={5} text="All bookings have their CTDMS order." />
            ) : (
              rows.slice(0, 50).map((t) => (
                <tr key={t.booking_id}>
                  <Td>
                    <Link to={`/reports/bookings/${t.booking_id}`} className="text-blue-700 hover:underline">
                      {t.customer_name}
                    </Link>
                    <div className="text-xs text-slate-500">{t.consultant}</div>
                  </Td>
                  <Td muted>{t.outlet}</Td>
                  <Td muted>{fmtDate(t.booked_on)}</Td>
                  <Td>{t.lag_days > 1 ? <Chip tone="red">{t.lag_days} days</Chip> : `${t.lag_days} days`}</Td>
                  <Td>{t.missing}</Td>
                </tr>
              ))
            )}
          </Table>
        )}
      </Loaded>
    </Card>
  );
}

// ===== Insurance =====
export function InsuranceStage() {
  return (
    <StageScreen
      stage="insurance"
      title="Ops Billing: Insurance"
      note="Record the policy on the booking's Insurance & RTO tab. If the customer insures the car himself or wants different add-ons, ask Accounts for a rework: once approved the deal and the amount due change."
      panel={(r) => (
        <div className="space-y-2 text-sm">
          <Link to={`/reports/bookings/${r.booking_id}/insurance-rto`} className="text-blue-700 hover:underline">
            Record the policy
          </Link>
          <ReworkRequest row={r} stage="insurance" kinds={[{ id: "self", name: "Self-insured" }, { id: "add_ons", name: "Add-ons changed" }]} />
        </div>
      )}
    />
  );
}

// ===== RTO =====
type Recon = { reg_no: string; vin: string; owner_name: string; booking_id: string | null; customer_name: string | null; match_basis: string; name_match: boolean | null; rto_status: string | null };
type Payout = { case_id: string; customer_name: string; financier: string; do_value: number; bank_payout: number; ca_payout: number; reg_no: string };

export function RtoStage() {
  const [tab, setTab] = useState("desk");
  return (
    <div>
      <Tabs current={tab} onChange={setTab} tabs={[{ id: "desk", label: "RTO desk" }, { id: "recon", label: "Register reconciliation" }, { id: "payout", label: "In-house payout expected" }]} />
      {tab === "desk" ? (
        <StageScreen
          stage="rto"
          title="Ops Billing: RTO"
          note="Record the registration on the booking's Insurance & RTO tab; set the registration type and any special number here."
          panel={(r) => (
            <div className="space-y-2 text-sm">
              <Link to={`/reports/bookings/${r.booking_id}/insurance-rto`} className="text-blue-700 hover:underline">
                Record the registration
              </Link>
              <ActionForm
                tone="light"
                label="Save"
                hidden={{}}
                fields={[
                  { name: "type", placeholder: "Type", options: [{ id: "NORMAL", name: "Normal" }, { id: "BH", name: "BH series" }, { id: "TRANSFER", name: "Transfer" }], required: true, width: "w-32", initial: "NORMAL" },
                  { name: "special", placeholder: "Special number", width: "w-36" },
                  { name: "amt", placeholder: "Its cost", type: "number", width: "w-28" },
                ]}
                action={async (fd) => {
                  await rpc("set_rto_extras", { p_booking_id: r.booking_id, p_rto_type: str(fd, "type"), p_special_number: str(fd, "special"), p_special_amount: num(fd, "amt") });
                }}
              />
            </div>
          )}
        />
      ) : tab === "recon" ? (
        <RtoRecon />
      ) : (
        <InhousePayout />
      )}
    </div>
  );
}

function RtoRecon() {
  const [rows, setRows] = useState<Recon[] | null>(null);
  return (
    <Card title="RTO register" note="CSV columns: reg_no, vin, owner_name. Each row is matched to our bookings by registration, else VIN, and the owner's first name is compared.">
      <div className="px-3 py-2">
        <input
          type="file"
          accept=".csv"
          className="text-xs"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const { parseCsv } = await import("@/lib/csv");
            const grid = parseCsv(await f.text());
            const head = grid[0].map((h) => h.trim().toLowerCase());
            const data = grid.slice(1).filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
            setRows(await rpcRows<Recon>("rto_reconcile", { p_rows: data }));
          }}
        />
      </div>
      {rows && (
        <Table head={["Register", "Owner", "Our booking", "Matched by", "Name", "Our record"]}>
          {rows.map((r, i) => (
            <tr key={i}>
              <Td>
                {r.reg_no} <div className="font-mono text-xs text-slate-500">{r.vin}</div>
              </Td>
              <Td>{r.owner_name}</Td>
              <Td>{r.customer_name ?? "—"}</Td>
              <Td>
                <Chip tone={r.match_basis === "not found" ? "red" : "emerald"}>{r.match_basis}</Chip>
              </Td>
              <Td>{r.name_match == null ? "" : r.name_match ? <Chip tone="emerald">agrees</Chip> : <Chip tone="amber">differs</Chip>}</Td>
              <Td muted>{r.rto_status}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function InhousePayout() {
  const [month, setMonth] = useState(todayIst().slice(0, 7));
  const q = useQuery(() => rpcRows<Payout>("inhouse_payout_expected", { p_month: `${month}-01` }), [month]);
  return (
    <Card title="Expected payout on in-house cases registered this month" aside={<input type="month" className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={month} onChange={(e) => setMonth(e.target.value)} />}>
      <Loaded q={q}>
        {(rows) => (
          <Table head={["Customer", "Bank", "Registration", "DO", "Bank payout", "CA payout"]}>
            {rows.length === 0 ? <EmptyRow cols={6} text="None." /> : rows.map((p) => (
              <tr key={p.case_id}>
                <Td>{p.customer_name}</Td>
                <Td muted>{p.financier}</Td>
                <Td muted>{p.reg_no}</Td>
                <Td right>{inr(p.do_value)}</Td>
                <Td right>{inr(p.bank_payout)}</Td>
                <Td right>{inr(p.ca_payout)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Loaded>
    </Card>
  );
}

// ===== Accessories =====
type Fitment = { item_key: string; label: string; fitted: boolean };

export function AccessoriesStage() {
  const [tab, setTab] = useState("desk");
  return (
    <div>
      <Tabs current={tab} onChange={setTab} tabs={[{ id: "desk", label: "Fitment desk" }, { id: "counter", label: "Counter sales" }]} />
      {tab === "desk" ? (
        <StageScreen
          stage="accessories"
          title="Ops Billing: Accessories"
          note="Tick each item as it is fitted. To reduce or add accessories after billing, ask Accounts for a rework."
          panel={(r) => <FitmentPanel row={r} />}
        />
      ) : (
        <CounterSales />
      )}
    </div>
  );
}

function FitmentPanel({ row }: { row: Row }) {
  const q = useQuery(async () => {
    const [b, d, f] = await Promise.all([
      supabase.from("bookings").select("accessory_ids").eq("id", row.booking_id).single(),
      supabase.from("welcome_dockets").select("accessory_order_items").eq("booking_id", row.booking_id).maybeSingle(),
      supabase.from("accessory_fitments").select("item_key, label, fitted").eq("booking_id", row.booking_id),
    ]);
    const ids = ((must(b) as { accessory_ids: string[] }).accessory_ids ?? []) as string[];
    const docket = ((must(d) as { accessory_order_items: { accessory_id: string; name?: string; qty?: number }[] } | null)?.accessory_order_items ?? []) as { accessory_id: string; name?: string; qty?: number }[];
    const allIds = [...new Set([...ids, ...docket.map((x) => x.accessory_id)])];
    const names = allIds.length ? (must(await supabase.from("accessories").select("id, name").in("id", allIds)) as { id: string; name: string }[]) : [];
    const saved = new Map((must(f) as Fitment[]).map((x) => [x.item_key, x]));
    return allIds.map((id) => ({ item_key: id, label: names.find((n) => n.id === id)?.name ?? id, fitted: saved.get(id)?.fitted ?? false }));
  }, [row.booking_id]);
  const [items, setItems] = useState<Fitment[] | null>(null);
  const list = items ?? q.data ?? [];
  return (
    <div className="space-y-2 text-sm">
      {list.length === 0 ? (
        <p className="text-slate-500">No accessories on this booking.</p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {list.map((i) => (
            <label key={i.item_key} className="flex items-center gap-1">
              <input type="checkbox" checked={i.fitted} onChange={() => setItems(list.map((x) => (x.item_key === i.item_key ? { ...x, fitted: !x.fitted } : x)))} />
              {i.label}
            </label>
          ))}
          <RunButton label="Save fitment" disabled={!items} run={async () => { await rpc("save_accessory_fitment", { p_booking_id: row.booking_id, p_items: list }); setItems(null); q.reload(); }} />
        </div>
      )}
      <ReworkRequest row={row} stage="accessories" kinds={[{ id: "reduce", name: "Reduce" }, { id: "add_ons", name: "Add more" }]} />
      <MarkStage row={row} stage="accessories" />
    </div>
  );
}

type Sale = { id: string; customer_name: string; customer_mobile: string | null; items: { name: string; qty: number; price: number }[]; total: number; payment_mode: string; sold_at: string };

function CounterSales() {
  const outlets = useQuery(async () => must(await supabase.from("outlets").select("id, name").eq("is_active", true).order("name")) as { id: string; name: string }[], []);
  const q = useQuery(async () => must(await supabase.from("counter_accessory_sales").select("id, customer_name, customer_mobile, items, total, payment_mode, sold_at").order("sold_at", { ascending: false }).limit(100)) as Sale[], []);
  const [lines, setLines] = useState<{ name: string; qty: number; price: number }[]>([{ name: "", qty: 1, price: 0 }]);
  const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
  return (
    <>
      <Card title="Counter sale" note="Accessories sold to someone without a booking with us.">
        <div className="space-y-2 px-3 py-2 text-sm">
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <input className="rounded-md border border-slate-300 px-2 py-1" placeholder="Item" value={l.name} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input className="w-16 rounded-md border border-slate-300 px-2 py-1" type="number" min={1} value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} />
              <input className="w-28 rounded-md border border-slate-300 px-2 py-1" type="number" placeholder="Price" value={l.price || ""} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, price: Number(e.target.value) } : x)))} />
            </div>
          ))}
          <RunButton tone="light" label="Add item" run={async () => setLines([...lines, { name: "", qty: 1, price: 0 }])} />
          <p>Total {inr(total)}</p>
          <ActionForm
            label="Record sale"
            hidden={{}}
            fields={[
              { name: "outlet", placeholder: "Branch", options: outlets.data ?? [], required: true, width: "w-36" },
              { name: "name", placeholder: "Customer", required: true, width: "w-40" },
              { name: "mobile", placeholder: "Mobile", width: "w-32" },
              { name: "mode", placeholder: "Paid by", options: [{ id: "cash", name: "Cash" }, { id: "upi", name: "UPI" }, { id: "card", name: "Card" }, { id: "bank_transfer", name: "Bank transfer" }], required: true, width: "w-32" },
              { name: "ref", placeholder: "Reference", width: "w-28" },
            ]}
            action={async (fd) => {
              const items = lines.filter((l) => l.name.trim() && l.price > 0);
              if (!items.length) throw new Error("Add the items sold");
              must(
                await supabase.from("counter_accessory_sales").insert({
                  outlet_id: str(fd, "outlet"),
                  customer_name: str(fd, "name"),
                  customer_mobile: str(fd, "mobile"),
                  items,
                  total: items.reduce((s, l) => s + l.qty * l.price, 0),
                  payment_mode: str(fd, "mode"),
                  payment_reference: str(fd, "ref"),
                }),
              );
              setLines([{ name: "", qty: 1, price: 0 }]);
              q.reload();
            }}
          />
        </div>
      </Card>
      <Card title="Recent counter sales">
        <Loaded q={q}>
          {(rows) => (
            <Table head={["When", "Customer", "Items", "Total", "Paid"]}>
              {rows.length === 0 ? <EmptyRow cols={5} text="None." /> : rows.map((s) => (
                <tr key={s.id}>
                  <Td muted>{fmtDateTime(s.sold_at)}</Td>
                  <Td>{s.customer_name} <span className="text-xs text-slate-500">{s.customer_mobile}</span></Td>
                  <Td muted>{s.items.map((i) => `${i.name} ×${i.qty}`).join(", ")}</Td>
                  <Td right>{inr(s.total)}</Td>
                  <Td muted>{s.payment_mode}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Loaded>
      </Card>
    </>
  );
}

// ===== Schemes =====
export function SchemesStage() {
  return (
    <StageScreen
      stage="scheme"
      title="Ops Billing: Schemes"
      note="Upload the claim proof for every TKM scheme on the booking (and the MSME certificate where it applies); the stage can be marked done once every scheme has its proof."
      panel={(r) => <SchemePanel row={r} />}
    />
  );
}

function SchemePanel({ row }: { row: Row }) {
  const q = useQuery(() => rpcRows<{ scheme_line_item_id: string; line: string; amount: number; has_proof: boolean }>("scheme_claim_status", { p_booking_id: row.booking_id }), [row.booking_id]);
  async function upload(lineId: string | null, kind: string, file: File) {
    const path = `${row.booking_id}/scheme/${kind}-${Date.now()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
    const up = await supabase.storage.from("booking-documents").upload(path, file);
    if (up.error) throw new Error(up.error.message);
    must(await supabase.from("scheme_claim_documents").insert({ booking_id: row.booking_id, scheme_line_item_id: lineId, doc_kind: kind, storage_path: path }));
    q.reload();
  }
  return (
    <div className="space-y-2 text-sm">
      {(q.data ?? []).map((s) => (
        <div key={s.scheme_line_item_id} className="flex items-center gap-2">
          {s.has_proof ? <Chip tone="emerald">Proof in</Chip> : <Chip tone="amber">Proof needed</Chip>}
          {s.line} {inr(s.amount)}
          <input type="file" className="text-xs" onChange={(e) => e.target.files?.[0] && upload(s.scheme_line_item_id, "claim_proof", e.target.files[0]).catch((err) => alert(err.message))} />
        </div>
      ))}
      <div className="flex items-center gap-2">
        MSME certificate
        <input type="file" className="text-xs" onChange={(e) => e.target.files?.[0] && upload(null, "msme_certificate", e.target.files[0]).catch((err) => alert(err.message))} />
      </div>
      <MarkStage row={row} stage="scheme" refLabel="TKM claim no." />
    </div>
  );
}

// ===== Scrap =====
export function ScrapStage() {
  const suppliers = useQuery(async () => must(await supabase.from("scrap_suppliers").select("id, name").eq("is_active", true).order("name")) as { id: string; name: string }[], []);
  const canEdit = useRightGate("ops_scrap", "edit");
  return (
    <StageScreen
      stage="scrap"
      title="Ops Billing: Scrap"
      note="Record the scrap supplier, COD number, date and price. A certificate discount cannot be more than the scrap amount quoted. The stage needs the COD number."
      extra={() =>
        canEdit ? (
          <Card title="Scrap suppliers">
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              {(suppliers.data ?? []).map((s) => <Chip key={s.id}>{s.name}</Chip>)}
              <ActionForm
                tone="light"
                label="Add"
                hidden={{}}
                fields={[{ name: "name", placeholder: "Supplier", required: true, width: "w-40" }, { name: "phone", placeholder: "Phone", width: "w-28" }]}
                action={async (fd) => {
                  must(await supabase.from("scrap_suppliers").insert({ name: str(fd, "name"), phone: str(fd, "phone") }));
                  suppliers.reload();
                }}
              />
            </div>
          </Card>
        ) : null
      }
      panel={(r) => (
        <div className="space-y-2">
          <ActionForm
            tone="light"
            label="Save scrap details"
            hidden={{}}
            fields={[
              { name: "supplier", placeholder: "Supplier", options: suppliers.data ?? [], width: "w-40" },
              { name: "cod", placeholder: "COD no.", required: true, width: "w-28" },
              { name: "date", placeholder: "Date", type: "date", width: "w-36" },
              { name: "price", placeholder: "Scrap price", type: "number", width: "w-28" },
              { name: "disc", placeholder: "Certificate discount", type: "number", width: "w-36" },
            ]}
            action={async (fd) => {
              await rpc("save_scrap_details", {
                p_booking_id: r.booking_id,
                p: { supplier_id: str(fd, "supplier"), cod_no: str(fd, "cod"), scrap_date: str(fd, "date"), scrap_price: num(fd, "price"), certificate_discount: num(fd, "disc") ?? 0 },
              });
            }}
          />
          <MarkStage row={r} stage="scrap" />
        </div>
      )}
    />
  );
}

// ===== Payment receipts =====
type Receipt = {
  id: string;
  receipt_no: string;
  booking_id: string;
  mode: string;
  amount: number;
  received_on: string;
  clearance_status: string;
  accounting_entry: boolean;
  due_before: number | null;
  due_after: number | null;
  cancel_reason: string | null;
  bookings: { customer_name: string | null; ctdms_order_booking_no: string | null } | null;
};

export function ReceiptsStage() {
  const [search, setSearch] = useState("");
  const [showCancelled, setShowCancelled] = useState(false);
  const q = useQuery(async () => {
    let query = supabase
      .from("payment_receipts")
      .select("id, receipt_no, booking_id, mode, amount, received_on, clearance_status, accounting_entry, due_before, due_after, cancel_reason, bookings!payment_receipts_booking_id_fkey(customer_name, ctdms_order_booking_no)")
      .order("created_at", { ascending: false })
      .limit(300);
    if (!showCancelled) query = query.neq("clearance_status", "cancelled");
    const safe = search.replace(/[,()%*]/g, " ").trim();
    if (safe) query = query.ilike("receipt_no", `%${safe}%`);
    return must(await query) as unknown as Receipt[];
  }, [search, showCancelled]);
  return (
    <div>
      <PageHeader
        title="Ops Billing: Payment Receipts"
        note="Tick a receipt once it is entered in the accounts; an entered receipt cannot be cancelled. Moving a receipt to another booking is logged. Customers can check a receipt by its number."
        actions={
          <>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Show cancelled
            </label>
            <input className="rounded-md border border-slate-300 px-2 py-1 text-sm" placeholder="Receipt no." value={search} onChange={(e) => setSearch(e.target.value)} />
          </>
        }
      />
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Receipt", "Customer", "Amount", "Due before → after", "Status", "In accounts", ""]}>
              {rows.length === 0 ? <EmptyRow cols={7} text="No receipts." /> : rows.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <span className="font-mono text-xs">{r.receipt_no}</span>
                    <div className="text-xs text-slate-500">{fmtDate(r.received_on)} · {r.mode.replace(/_/g, " ")}</div>
                  </Td>
                  <Td>
                    <Link to={`/reports/bookings/${r.booking_id}/payments`} className="text-blue-700 hover:underline">{r.bookings?.customer_name}</Link>
                    <div className="text-xs text-slate-500">{r.bookings?.ctdms_order_booking_no}</div>
                  </Td>
                  <Td right>{inr(r.amount)}</Td>
                  <Td right muted>{r.due_before != null ? `${inr(r.due_before)} → ${inr(r.due_after)}` : "—"}</Td>
                  <Td>
                    <Chip tone={r.clearance_status === "cleared" ? "emerald" : r.clearance_status === "pending" ? "amber" : "red"}>{r.clearance_status}</Chip>
                    {r.cancel_reason && <div className="text-xs text-slate-500">{r.cancel_reason}</div>}
                  </Td>
                  <Td>
                    {r.clearance_status !== "cancelled" && (
                      <input type="checkbox" checked={r.accounting_entry} onChange={() => rpc("set_receipt_accounting_entry", { p_receipt_id: r.id, p_on: !r.accounting_entry }).then(() => q.reload()).catch((e) => alert(e.message))} />
                    )}
                  </Td>
                  <Td>
                    {r.clearance_status !== "cancelled" && r.mode !== "finance_disbursement" && (
                      <div className="flex flex-col gap-1">
                        <ActionForm tone="danger" label="Cancel" hidden={{}} fields={[{ name: "why", placeholder: "Reason", required: true, width: "w-28" }]} action={async (fd) => { await rpc("cancel_receipt", { p_receipt_id: r.id, p_reason: str(fd, "why") }); q.reload(); }} />
                        <TransferForm receipt={r} onDone={q.reload} />
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Loaded>
      </Card>
    </div>
  );
}

function TransferForm({ receipt, onDone }: { receipt: Receipt; onDone: () => void }) {
  return (
    <ActionForm
      tone="light"
      label="Move"
      hidden={{}}
      fields={[
        { name: "order", placeholder: "To CTDMS order no.", required: true, width: "w-32" },
        { name: "why", placeholder: "Reason", required: true, width: "w-28" },
      ]}
      action={async (fd) => {
        const { data } = await supabase.from("bookings").select("id").eq("ctdms_order_booking_no", str(fd, "order")!).neq("status", "cancelled").limit(2);
        if (!data || data.length !== 1) throw new Error("Booking not found");
        await rpc("transfer_receipt", { p_receipt_id: receipt.id, p_to_booking_id: data[0].id, p_reason: str(fd, "why") });
        onDone();
      }}
    />
  );
}

// ===== Public receipt check (no sign-in) =====
export function VerifyReceipt() {
  const [no, setNo] = useState(new URLSearchParams(window.location.search).get("no") ?? "");
  const [res, setRes] = useState<{ receipt_no: string; received_on: string; amount: number; status: string } | null | undefined>(undefined);
  return (
    <div className="mx-auto mt-16 max-w-md rounded-md border border-slate-200 bg-white p-6 text-sm">
      <h1 className="mb-3 text-lg font-semibold">Check a Rajesh Toyota receipt</h1>
      <div className="flex gap-2">
        <input className="flex-1 rounded-md border border-slate-300 px-2 py-1" placeholder="Receipt number" value={no} onChange={(e) => setNo(e.target.value)} />
        <RunButton
          label="Check"
          run={async () => {
            const { data, error } = await supabase.rpc("verify_receipt", { p_receipt_no: no });
            if (error) throw new Error(error.message);
            setRes((data as typeof res[])?.[0] ?? null);
          }}
        />
      </div>
      {res === null && <p className="mt-3 text-red-600">No receipt with this number.</p>}
      {res && (
        <p className="mt-3">
          {res.receipt_no} · {fmtDate(res.received_on)} · {inr(res.amount)} ·{" "}
          <Chip tone={res.status === "valid" ? "emerald" : res.status === "awaiting clearance" ? "amber" : "red"}>{res.status}</Chip>
        </p>
      )}
    </div>
  );
}

