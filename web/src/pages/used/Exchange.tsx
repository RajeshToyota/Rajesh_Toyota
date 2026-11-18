import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Table, Tabs, Td, fmtDate, inr, num, rpc, rpcRows, str } from "@/ui";

type Row = {
  kind: "evaluation" | "quote" | "booking";
  id: string;
  ref_id: string | null;
  outlet: string;
  customer_name: string;
  customer_mobile: string | null;
  reg_no: string | null;
  car: string | null;
  status: string;
  deal_status: string | null;
  evaluator_price: number | null;
  offer_price: number | null;
  asking_price: number | null;
  final_price: number | null;
  refurb_required: boolean | null;
  refurb_estimate: number | null;
  is_accidental: boolean | null;
  consultant: string | null;
  created_at: string;
};
type Lead = { id: string; lead_source: string; seller_name: string; seller_mobile: string | null; reg_no: string; make: string; model: string; mfg_year: number | null; expected_price: number | null; status: string; lost_reason: string | null; evaluation_id: string | null; approved_price: number | null };

const DEAL_TONE: Record<string, "slate" | "blue" | "amber" | "emerald" | "red"> = { pending: "slate", offered: "blue", negotiating: "amber", deal_done: "emerald", no_deal: "red" };
const NO_DEAL = ["price_gap", "customer_retained", "sold_elsewhere", "documents_issue", "car_condition", "other"].map((id) => ({ id, name: id.replace(/_/g, " ") }));
const LOST = ["price_gap", "sold_elsewhere", "seller_not_responding", "documents_issue", "car_condition", "other"].map((id) => ({ id, name: id.replace(/_/g, " ") }));
const SOURCES = ["referral", "online_portal", "broker", "walk_in", "social_media", "existing_customer", "other"].map((id) => ({ id, name: id.replace(/_/g, " ") }));

// Techwheels' Exchange Business: every exchange car by where it came from, the deal (offer / asking),
// refurbishment set by the office, the structured inspection, and outside-car procurement.
export default function ExchangeBusiness() {
  const [tab, setTab] = useState("walkin");
  const [inspect, setInspect] = useState<string | null>(null);
  return (
    <div>
      <PageHeader title="Exchange Business" note="Deal: pending → offered (offer communicated) → negotiating (customer asks more) → deal done / no deal." />
      <Tabs
        current={tab}
        onChange={(t) => {
          setTab(t);
          setInspect(null);
        }}
        tabs={[
          { id: "walkin", label: "Walk-in" },
          { id: "quote", label: "Quote" },
          { id: "booking", label: "Booking" },
          { id: "outside", label: "Outside" },
          { id: "enable", label: "Enable exchange" },
        ]}
      />
      {inspect && <Inspection evaluationId={inspect} onClose={() => setInspect(null)} />}
      {tab === "outside" && <OutsideLeads />}
      <Evaluations tab={tab} onInspect={setInspect} />
    </div>
  );
}

function Evaluations({ tab, onInspect }: { tab: string; onInspect: (id: string) => void }) {
  const q = useQuery(() => rpcRows<Row>("exchange_business", { p_tab: tab }), [tab]);
  const canApprove = useRightGate("used_car_evaluations", "approve");
  const canEdit = useRightGate("used_car_evaluations", "edit");
  if (tab === "enable") return <EnableExchange q={q} />;
  return (
    <Card>
      <Loaded q={q}>
        {(rows) => (
          <Table head={["Car", "Customer", "Valuation", "Offer / asking", "Deal", "Refurbishment", ""]}>
            {rows.length === 0 ? (
              <EmptyRow cols={7} text="No exchange cars here." />
            ) : (
              rows.map((r) => {
                const closed = ["procured", "rejected", "cancelled"].includes(r.status);
                return (
                  <tr key={r.id}>
                    <Td>
                      <span className="font-mono text-xs">{r.reg_no}</span> {r.is_accidental && <Chip tone="red">Accidental</Chip>}
                      <div>{r.car}</div>
                      <div className="text-xs text-slate-500">{r.outlet} · {fmtDate(r.created_at)}</div>
                    </Td>
                    <Td>
                      {r.customer_name}
                      <div className="text-xs text-slate-500">{r.customer_mobile} · {r.consultant}</div>
                    </Td>
                    <Td right>{inr(r.evaluator_price)}<div className="text-xs text-slate-500">{r.status}</div></Td>
                    <Td right>
                      {inr(r.offer_price)} / {inr(r.asking_price)}
                      {r.final_price != null && <div className="text-xs text-emerald-700">final {inr(r.final_price)}</div>}
                    </Td>
                    <Td><Chip tone={DEAL_TONE[r.deal_status ?? "pending"]}>{(r.deal_status ?? "").replace("_", " ")}</Chip></Td>
                    <Td muted>{r.refurb_required == null ? "Not set" : r.refurb_required ? inr(r.refurb_estimate) : "None"}</Td>
                    <Td>
                      <div className="flex flex-col gap-1">
                        {["evaluated", "negotiating"].includes(r.status) && (
                          <>
                            <ActionForm
                              tone="light"
                              label="Save offer"
                              hidden={{}}
                              fields={[
                                { name: "offer", placeholder: "Offer ₹", type: "number", width: "w-24", initial: r.offer_price != null ? String(r.offer_price) : "" },
                                { name: "ask", placeholder: "Asking ₹", type: "number", width: "w-24", initial: r.asking_price != null ? String(r.asking_price) : "" },
                                { name: "told", placeholder: "Told?", options: [{ id: "1", name: "Communicated" }], width: "w-32" },
                              ]}
                              action={async (fd) => {
                                await rpc("set_used_car_offer", { p_id: r.id, p_offer: num(fd, "offer"), p_asking: num(fd, "ask"), p_communicated: str(fd, "told") === "1" });
                              }}
                            />
                            <RunButton label="Deal done" run={() => rpc("accept_used_car_offer", { p_id: r.id })} />
                          </>
                        )}
                        {!closed && (
                          <ActionForm
                            tone="danger"
                            label="No deal"
                            hidden={{}}
                            fields={[
                              { name: "why", placeholder: "Reason", options: NO_DEAL, required: true, width: "w-36" },
                              { name: "note", placeholder: "Note", width: "w-28" },
                            ]}
                            action={async (fd) => {
                              await rpc("mark_used_car_no_deal", { p_id: r.id, p_reason: str(fd, "why"), p_note: str(fd, "note") });
                            }}
                          />
                        )}
                        {["rejected", "cancelled"].includes(r.status) && (
                          <ActionForm
                            tone="light"
                            label="Reopen"
                            hidden={{}}
                            fields={[{ name: "why", placeholder: "Why", required: true, width: "w-32" }]}
                            action={async (fd) => {
                              await rpc("reopen_used_car_evaluation", { p_id: r.id, p_reason: str(fd, "why") });
                            }}
                          />
                        )}
                        {canApprove && !closed && (
                          <ActionForm
                            tone="light"
                            label="Set refurb."
                            hidden={{}}
                            fields={[
                              { name: "req", placeholder: "Needed?", options: [{ id: "yes", name: "Needed" }, { id: "no", name: "Not needed" }], required: true, width: "w-28" },
                              { name: "est", placeholder: "Estimate ₹", type: "number", width: "w-24" },
                              { name: "work", placeholder: "Work", width: "w-32" },
                            ]}
                            action={async (fd) => {
                              await rpc("set_used_car_refurbishment", { p_id: r.id, p_required: str(fd, "req") === "yes", p_estimate: num(fd, "est"), p_work: str(fd, "work") });
                            }}
                          />
                        )}
                        {(canEdit || canApprove) && !closed && <RunButton tone="light" label="Inspection" run={async () => onInspect(r.id)} />}
                      </div>
                    </Td>
                  </tr>
                );
              })
            )}
          </Table>
        )}
      </Loaded>
    </Card>
  );
}

function EnableExchange({ q }: { q: { data: Row[] | null; error: string | null; loading: boolean } }) {
  return (
    <Card note="Quotes (last 60 days) and open bookings with no exchange evaluation. Enter the customer's car to send it to the evaluator.">
      <Loaded q={q}>
        {(rows) => (
          <Table head={["", "Customer", "Model", "Consultant", "Exchange car"]}>
            {rows.length === 0 ? (
              <EmptyRow cols={5} text="Nothing to back-fill." />
            ) : (
              rows.map((r) => (
                <tr key={`${r.kind}-${r.id}`}>
                  <Td><Chip tone={r.kind === "booking" ? "emerald" : "blue"}>{r.kind}</Chip><div className="text-xs text-slate-500">{fmtDate(r.created_at)}</div></Td>
                  <Td>{r.customer_name}<div className="text-xs text-slate-500">{r.customer_mobile}</div></Td>
                  <Td>{r.car}</Td>
                  <Td muted>{r.consultant}</Td>
                  <Td>
                    <ActionForm
                      tone="light"
                      label="Enable exchange"
                      hidden={{}}
                      fields={[
                        { name: "reg", placeholder: "Reg. no.", required: true, width: "w-28" },
                        { name: "make", placeholder: "Make", width: "w-20" },
                        { name: "model", placeholder: "Model", required: true, width: "w-24" },
                        { name: "year", placeholder: "Year", type: "number", width: "w-16" },
                      ]}
                      action={async (fd) => {
                        await rpc("enable_exchange", { p_kind: r.kind, p_id: r.id, p_car: { reg_no: str(fd, "reg"), make: str(fd, "make"), model: str(fd, "model"), mfg_year: str(fd, "year") } });
                      }}
                    />
                  </Td>
                </tr>
              ))
            )}
          </Table>
        )}
      </Loaded>
    </Card>
  );
}

function OutsideLeads() {
  const canCreate = useRightGate("used_car_exchange", "create");
  const canApprove = useRightGate("used_car_exchange", "approve");
  const q = useQuery(async () => must(await supabase.from("used_car_outside_leads").select("*").order("created_at", { ascending: false })) as Lead[], []);
  return (
    <>
      {canCreate && (
        <Card title="New procurement lead" note="An outside car goes straight to the evaluator. It can be bought in only after the purchase is approved.">
          <div className="px-3 py-2">
            <ActionForm
              label="Add lead"
              hidden={{}}
              fields={[
                { name: "src", placeholder: "Source", options: SOURCES, required: true, width: "w-32" },
                { name: "seller", placeholder: "Seller", required: true, width: "w-32" },
                { name: "mobile", placeholder: "Mobile", width: "w-28" },
                { name: "reg", placeholder: "Reg. no.", required: true, width: "w-28" },
                { name: "make", placeholder: "Make", width: "w-20" },
                { name: "model", placeholder: "Model", required: true, width: "w-24" },
                { name: "year", placeholder: "Year", type: "number", width: "w-16" },
                { name: "km", placeholder: "km", type: "number", width: "w-20" },
                { name: "price", placeholder: "Expected ₹", type: "number", width: "w-24" },
              ]}
              action={async (fd) => {
                await rpc("create_outside_lead", {
                  p: { lead_source: str(fd, "src"), seller_name: str(fd, "seller"), seller_mobile: str(fd, "mobile"), reg_no: str(fd, "reg"), make: str(fd, "make"), model: str(fd, "model"), mfg_year: str(fd, "year"), odometer_km: str(fd, "km"), expected_price: str(fd, "price") },
                });
                q.reload();
              }}
            />
          </div>
        </Card>
      )}
      <Card title="Procurement leads">
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Car", "Seller", "Expected", "Status", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={5} text="No leads." />
              ) : (
                rows.map((l) => (
                  <tr key={l.id}>
                    <Td><span className="font-mono text-xs">{l.reg_no}</span><div>{l.make} {l.model} {l.mfg_year}</div></Td>
                    <Td>{l.seller_name}<div className="text-xs text-slate-500">{l.seller_mobile} · {l.lead_source.replace(/_/g, " ")}</div></Td>
                    <Td right>{inr(l.expected_price)}{l.approved_price != null && <div className="text-xs text-emerald-700">approved {inr(l.approved_price)}</div>}</Td>
                    <Td>
                      <Chip tone={l.status === "purchased" ? "emerald" : l.status === "lost" ? "red" : l.status === "purchase_approved" ? "blue" : "amber"}>{l.status.replace(/_/g, " ")}</Chip>
                      {l.lost_reason && <div className="text-xs text-slate-500">{l.lost_reason.replace(/_/g, " ")}</div>}
                    </Td>
                    <Td>
                      <div className="flex flex-col gap-1">
                        {canApprove && ["evaluated", "under_negotiation"].includes(l.status) && (
                          <ActionForm
                            label="Approve purchase"
                            hidden={{}}
                            fields={[{ name: "price", placeholder: "Price ₹", type: "number", required: true, width: "w-28" }]}
                            action={async (fd) => {
                              await rpc("approve_outside_purchase", { p_lead_id: l.id, p_price: num(fd, "price") });
                              q.reload();
                            }}
                          />
                        )}
                        {!["purchased", "lost"].includes(l.status) && (
                          <ActionForm
                            tone="danger"
                            label="Lost"
                            hidden={{}}
                            fields={[
                              { name: "why", placeholder: "Reason", options: LOST, required: true, width: "w-36" },
                              { name: "note", placeholder: "Note", width: "w-28" },
                            ]}
                            action={async (fd) => {
                              await rpc("mark_outside_lead_lost", { p_lead_id: l.id, p_reason: str(fd, "why"), p_note: str(fd, "note") });
                              q.reload();
                            }}
                          />
                        )}
                      </div>
                    </Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
      </Card>
    </>
  );
}

// ---------- structured inspection ----------
const CHECKLIST = [
  "Front bumper", "Bonnet", "Front-left fender", "Front-right fender", "Left doors", "Right doors", "Roof", "Boot lid", "Rear bumper",
  "A-pillars", "B-pillars", "C-pillars", "Apron / chassis rails", "Floor & boot floor", "Radiator support", "Engine & gearbox",
  "Suspension & steering", "Electricals & AC",
];
const RED_FLAGS = [
  ["flood_damage", "Flood damage"], ["fire_damage", "Fire damage"], ["chassis_repair", "Chassis repaired"], ["airbag_deployed", "Airbag deployed"],
  ["odometer_tampered", "Odometer tampered"], ["engine_replaced", "Engine replaced"], ["pillar_repair", "Pillar repaired"], ["structural_damage", "Structural damage"],
] as const;
type Item = { finding?: string; note?: string; photo?: string };
type Insp = { checklist: Record<string, Item>; interior: Record<string, Item>; damage: Record<string, Item>; red_flags: string[]; is_draft: boolean; accidental_override: boolean; override_reason: string | null; computed_accidental: boolean };

function Inspection({ evaluationId, onClose }: { evaluationId: string; onClose: () => void }) {
  const q = useQuery(async () => (must(await supabase.from("used_car_inspections").select("*").eq("evaluation_id", evaluationId).maybeSingle()) as Insp | null), [evaluationId]);
  return <Loaded q={q}>{(saved) => <InspectionForm key={evaluationId} evaluationId={evaluationId} saved={saved} onClose={onClose} />}</Loaded>;
}

function InspectionForm({ evaluationId, saved, onClose }: { evaluationId: string; saved: Insp | null; onClose: () => void }) {
  const [check, setCheck] = useState<Record<string, Item>>(saved?.checklist ?? {});
  const [interior, setInterior] = useState<Record<string, Item>>(saved?.interior ?? {});
  const [damage, setDamage] = useState<Record<string, Item>>(saved?.damage ?? {});
  const [flags, setFlags] = useState<string[]>(saved?.red_flags ?? []);
  const [override, setOverride] = useState(saved?.accidental_override ?? false);
  const [reason, setReason] = useState(saved?.override_reason ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const accidental = flags.length > 0 || Object.values(check).some((i) => i.finding === "suspected" || i.finding === "confirmed");

  async function upload(file: File) {
    const path = `used-car/${evaluationId}/${Date.now()}-${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
    const { error } = await supabase.storage.from("used-car-photos").upload(path, file);
    if (error) throw new Error(error.message);
    return path;
  }
  const photoInput = (set: (f: (x: Record<string, Item>) => Record<string, Item>) => void, k: string, item?: Item) => (
    <label className="cursor-pointer text-xs text-slate-600 underline decoration-dotted">
      {item?.photo ? "✓ photo" : "photo"}
      <input
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            const p = await upload(f);
            set((x) => ({ ...x, [k]: { ...x[k], photo: p } }));
          } catch (err) {
            setMsg(err instanceof Error ? err.message : "Upload failed");
          }
        }}
      />
    </label>
  );

  async function save(final: boolean) {
    setMsg(null);
    const acc = await rpc<boolean>("save_used_car_inspection", {
      p_id: evaluationId,
      p: { checklist: check, interior, damage, red_flags: flags, accidental_override: override, override_reason: reason || null },
      p_final: final,
    });
    setMsg(final ? (acc ? "Final — the car is marked accidental." : "Final — not accidental.") : "Draft saved.");
  }

  return (
    <Card
      title={`Inspection${saved && !saved.is_draft ? " (final)" : saved ? " (draft)" : ""}`}
      aside={<RunButton tone="light" label="Close" run={async () => onClose()} />}
      note="All 18 items need a finding to finalise. Any suspected or confirmed finding, or any red flag, makes the car accidental unless overridden with a reason."
    >
      <div className="grid gap-1 px-3 py-2 md:grid-cols-2">
        {CHECKLIST.map((label, i) => {
          const k = String(i + 1);
          const item = check[k] ?? {};
          return (
            <div key={k} className="flex items-center gap-2 text-sm">
              <span className="w-6 text-right text-slate-400">{k}</span>
              <span className="w-44">{label}</span>
              <select className="rounded border border-slate-300 px-1 py-0.5 text-xs" value={item.finding ?? ""} onChange={(e) => setCheck((x) => ({ ...x, [k]: { ...x[k], finding: e.target.value || undefined } }))}>
                <option value="">—</option>
                <option value="none">None</option>
                <option value="suspected">Suspected</option>
                <option value="confirmed">Confirmed</option>
              </select>
              <input className="w-32 rounded border border-slate-300 px-1 py-0.5 text-xs" placeholder="Note" value={item.note ?? ""} onChange={(e) => setCheck((x) => ({ ...x, [k]: { ...x[k], note: e.target.value } }))} />
              {photoInput(setCheck, k, item)}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-4 px-3 py-2 text-sm">
        <div>
          <div className="text-xs font-semibold uppercase text-slate-500">Interior</div>
          {[1, 2, 3, 4].map((n) => <span key={n} className="mr-2">{n}: {photoInput(setInterior, String(n), interior[String(n)])}</span>)}
        </div>
        <div>
          <div className="text-xs font-semibold uppercase text-slate-500">Damage</div>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <span key={n} className="mr-2">{n}: {photoInput(setDamage, String(n), damage[String(n)])}</span>)}
        </div>
      </div>
      <div className="flex flex-wrap gap-3 px-3 py-2 text-sm">
        {RED_FLAGS.map(([id, label]) => (
          <label key={id} className="flex items-center gap-1">
            <input type="checkbox" checked={flags.includes(id)} onChange={(e) => setFlags((f) => (e.target.checked ? [...f, id] : f.filter((x) => x !== id)))} />
            <span className="text-red-700">{label}</span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
        <Chip tone={accidental && !override ? "red" : "emerald"}>{accidental ? (override ? "Accidental — overridden" : "Accidental") : "Not accidental"}</Chip>
        {accidental && (
          <>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Override
            </label>
            {override && <input className="w-64 rounded border border-slate-300 px-2 py-1 text-sm" placeholder="Reason for the override" value={reason} onChange={(e) => setReason(e.target.value)} />}
          </>
        )}
        <RunButton tone="light" label="Save draft" run={() => save(false)} />
        <RunButton label="Finalise" run={() => save(true)} />
        {msg && <span className="text-xs text-slate-600">{msg}</span>}
      </div>
    </Card>
  );
}
