import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { Card, Chip, EmptyRow, ErrorBox, Loaded, RunButton, Select, Table, Td, fmtDate, inr, inputCls, rpc, todayIst } from "@/ui";
import { useCanWriteMaster } from "../shared";
import { emptyLine, useCategories, useModels, type Line, type Scheme } from "./common";

// Scheme revisions, entered by start date only: a new one closes the revision it falls in and runs
// until the next one.
export default function Revisions() {
  const canWrite = useCanWriteMaster("schemes");
  const models = useModels();
  const [modelId, setModelId] = useState("");
  const [showAll, setShowAll] = useState(false);
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
        <Select value={modelId} onChange={setModelId} placeholder="Model" options={models.data ?? []} />
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show ended revisions
        </label>
      </div>
      {canWrite && modelId && <RevisionForm modelId={modelId} />}
      <Card title="Revisions">
        <Loaded q={schemes}>
          {(rows) => (
            <Table head={["Scheme", "Suffixes", "From", "To", "Lines", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={6} text={modelId ? "No schemes." : "Pick a model."} />
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

function RevisionForm({ modelId }: { modelId: string }) {
  const cats = useCategories();
  const [name, setName] = useState("");
  const [from, setFrom] = useState(todayIst());
  const [suffixes, setSuffixes] = useState("");
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const numOrNull = (v: string) => (v === "" ? null : Number(v));

  return (
    <Card title="New revision" note="Same scheme name and start date replaces that revision.">
      <div className="space-y-2 px-3 py-2 text-sm">
        <div className="flex flex-wrap gap-2">
          <input className={`${inputCls} w-56`} placeholder="Scheme name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className={inputCls} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input className={`${inputCls} w-64`} placeholder="Suffix codes, comma-separated (blank = all)" value={suffixes} onChange={(e) => setSuffixes(e.target.value)} />
        </div>
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
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
            label="Save revision"
            run={async () => {
              const scope = suffixes.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
              await rpc("save_scheme_revision", {
                p: { model_id: modelId, name, valid_from: from, suffix_scope_list: scope.length ? scope : null, lines },
              });
              setName("");
              setLines([emptyLine()]);
            }}
          />
        </div>
      </div>
    </Card>
  );
}
