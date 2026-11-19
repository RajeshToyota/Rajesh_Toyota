import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { Card, Chip, EmptyRow, ErrorBox, Loaded, RunButton, Select, Table, Td, fmtDate, inr, inputCls, rpc, todayIst } from "@/ui";
import { useCanWriteMaster } from "../shared";
import { emptyLine, useCategories, useModels, type Line, type Scheme } from "./common";

// Scheme revisions, entered by start date only: a new one closes the revision it falls in and runs
// until the next one. A revision can be edited in place (its lines keep their conditions and claim
// documents) or deleted; this tab is the only editor of schemes and their lines.
export default function Revisions() {
  const canWrite = useCanWriteMaster("schemes");
  const models = useModels();
  const [modelId, setModelId] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<Scheme | null>(null);
  const schemes = useQuery(async () => {
    if (!modelId) return [] as Scheme[];
    let q = supabase
      .from("schemes")
      .select("id, name, model_id, suffix_scope_list, valid_from, valid_to, models(name), scheme_line_items(id, line_type, scheme_master_code, tkm_share, dealer_share, prev_my_tkm_share, prev_my_dealer_share, is_customer_facing)")
      .eq("model_id", modelId)
      .order("name")
      .order("valid_from", { ascending: false });
    if (!showAll) q = q.gte("valid_to", todayIst());
    return must(await q) as unknown as Scheme[];
  }, [modelId, showAll]);
  const today = todayIst();

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <Select value={modelId} onChange={(v) => { setModelId(v); setEditing(null); }} placeholder="Model" options={models.data ?? []} />
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show ended revisions
        </label>
      </div>
      {canWrite && modelId && (editing ? <RevisionForm key={editing.id} modelId={modelId} editing={editing} onDone={() => setEditing(null)} /> : <RevisionForm key="new" modelId={modelId} />)}
      <Card title="Revisions">
        <Loaded q={schemes}>
          {(rows) => (
            <Table head={["Scheme", "Suffixes", "From", "To", "Lines", "", ...(canWrite ? [""] : [])]}>
              {rows.length === 0 ? (
                <EmptyRow cols={canWrite ? 7 : 6} text={modelId ? "No schemes." : "Pick a model."} />
              ) : (
                rows.map((s) => (
                  <tr key={s.id}>
                    <Td>{s.name}</Td>
                    <Td muted>{s.suffix_scope_list?.join(", ") ?? "All"}</Td>
                    <Td muted>{fmtDate(s.valid_from)}</Td>
                    <Td muted>{s.valid_to >= "2099-01-01" ? "Open" : fmtDate(s.valid_to)}</Td>
                    <Td>
                      {s.scheme_line_items.map((l) => (
                        <div key={l.id} className="text-xs">
                          {l.line_type}
                          {l.scheme_master_code && <span className="text-slate-400"> [{l.scheme_master_code}]</span>}: TKM {inr(l.tkm_share)} + dealer {inr(l.dealer_share)}
                          {l.prev_my_tkm_share != null && <span className="text-slate-400"> · prev MY TKM {inr(l.prev_my_tkm_share)}</span>}
                          {!l.is_customer_facing && <span className="text-slate-400"> · dealer only</span>}
                        </div>
                      ))}
                    </Td>
                    <Td>{s.valid_from <= today && s.valid_to >= today ? <Chip tone="emerald">Live</Chip> : s.valid_from > today ? <Chip tone="blue">Upcoming</Chip> : <Chip>Ended</Chip>}</Td>
                    {canWrite && (
                      <Td>
                        <div className="flex gap-3 text-xs">
                          <button type="button" className="text-blue-700 hover:underline" onClick={() => { setEditing(s); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="text-red-600 hover:underline"
                            onClick={async () => {
                              if (!confirm(`Delete the ${s.name} revision from ${fmtDate(s.valid_from)}? Its lines and their conditions go with it.`)) return;
                              try {
                                await rpc("delete_scheme_revision", { p_id: s.id });
                                if (editing?.id === s.id) setEditing(null);
                              } catch (err) {
                                alert(err instanceof Error ? err.message : String(err));
                              }
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </Td>
                    )}
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

// New revision, or (with `editing`) a change to an existing one: name, suffixes, dates and lines.
function RevisionForm({ modelId, editing, onDone }: { modelId: string; editing?: Scheme; onDone?: () => void }) {
  const cats = useCategories();
  const [name, setName] = useState(editing?.name ?? "");
  const [from, setFrom] = useState(editing?.valid_from ?? todayIst());
  const [to, setTo] = useState(editing && editing.valid_to < "2099-01-01" ? editing.valid_to : "");
  const [suffixes, setSuffixes] = useState(editing?.suffix_scope_list?.join(", ") ?? "");
  const [lines, setLines] = useState<Line[]>(editing ? editing.scheme_line_items.map((l) => ({ ...l })) : [emptyLine()]);
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const numOrNull = (v: string) => (v === "" ? null : Number(v));

  return (
    <Card
      title={editing ? `Edit revision: ${editing.name} from ${fmtDate(editing.valid_from)}` : "New revision"}
      note={editing ? "Leave the end date blank for an open-ended revision. It may not overlap another revision of the same scheme." : "Same scheme name and start date replaces that revision."}
    >
      <div className="space-y-2 px-3 py-2 text-sm">
        <div className="flex flex-wrap gap-2">
          <input className={`${inputCls} w-56`} placeholder="Scheme name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className={inputCls} type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="Start date" />
          {editing && <input className={inputCls} type="date" value={to} onChange={(e) => setTo(e.target.value)} title="End date (blank = open)" />}
          <input className={`${inputCls} w-64`} placeholder="Suffix codes, comma-separated (blank = all)" value={suffixes} onChange={(e) => setSuffixes(e.target.value)} />
        </div>
        {lines.map((l, i) => (
          <div key={l.id ?? `new-${i}`} className="flex flex-wrap items-center gap-2">
            <Select value={l.scheme_master_code ?? ""} onChange={(v) => set(i, { scheme_master_code: v || null })} options={(cats.data ?? []).map((c) => ({ id: c.code, name: c.name }))} placeholder="Category" />
            <input className={`${inputCls} w-40`} placeholder="Line label" value={l.line_type} onChange={(e) => set(i, { line_type: e.target.value })} />
            <input className={`${inputCls} w-24`} type="number" placeholder="TKM" value={l.tkm_share || ""} onChange={(e) => set(i, { tkm_share: Number(e.target.value) })} />
            <input className={`${inputCls} w-24`} type="number" placeholder="Dealer" value={l.dealer_share || ""} onChange={(e) => set(i, { dealer_share: Number(e.target.value) })} />
            <input className={`${inputCls} w-28`} type="number" placeholder="Prev MY TKM" value={l.prev_my_tkm_share ?? ""} onChange={(e) => set(i, { prev_my_tkm_share: numOrNull(e.target.value) })} />
            <input className={`${inputCls} w-28`} type="number" placeholder="Prev MY dealer" value={l.prev_my_dealer_share ?? ""} onChange={(e) => set(i, { prev_my_dealer_share: numOrNull(e.target.value) })} />
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={l.is_customer_facing} onChange={(e) => set(i, { is_customer_facing: e.target.checked })} /> Customer
            </label>
            {lines.length > 1 && (
              <button type="button" className="text-xs text-red-600" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                Remove
              </button>
            )}
          </div>
        ))}
        <div className="flex gap-2">
          <RunButton tone="light" label="Add line" run={async () => setLines([...lines, emptyLine()])} />
          <RunButton
            label={editing ? "Save changes" : "Save revision"}
            run={async () => {
              const scope = suffixes.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
              const suffix_scope_list = scope.length ? scope : null;
              if (editing) {
                await rpc("update_scheme_revision", { p: { id: editing.id, name, valid_from: from, valid_to: to || null, suffix_scope_list, lines } });
                onDone?.();
                return;
              }
              await rpc("save_scheme_revision", { p: { model_id: modelId, name, valid_from: from, suffix_scope_list, lines } });
              setName("");
              setLines([emptyLine()]);
            }}
          />
          {editing && <RunButton tone="light" label="Cancel" run={async () => onDone?.()} />}
        </div>
      </div>
    </Card>
  );
}
