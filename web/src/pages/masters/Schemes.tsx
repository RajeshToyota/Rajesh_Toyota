import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { parseCsv } from "@/lib/csv";
import { Card, Chip, EmptyRow, ErrorBox, Loaded, RunButton, Select, Table, Td, fmtDate, inr, inputCls, rpc, todayIst } from "@/ui";
import { MasterTabs, useCanWriteMaster } from "./shared";

type Line = {
  id?: string;
  line_type: string;
  scheme_master_code: string | null;
  tkm_share: number;
  dealer_share: number;
  prev_my_tkm_share: number | null;
  prev_my_dealer_share: number | null;
  is_customer_facing: boolean;
};
type Scheme = {
  id: string;
  name: string;
  model_id: string;
  suffix_scope_list: string[] | null;
  valid_from: string;
  valid_to: string;
  models: { name: string } | null;
  scheme_line_items: Line[];
};

// Techwheels' Schemes: revisions entered by start date only (end dates follow from the next
// revision), category rules, previous model-year amounts, and a bulk CSV entry with preview.
export default function Schemes() {
  return (
    <MasterTabs
      page="schemes"
      title="Schemes"
      note="Enter a scheme from its start date: it closes the revision it falls in and runs until the next one. One corporate and one loyalty scheme per deal; exchange and scrappage never together."
      panels={{
        revisions: () => <Revisions />,
        bulk: () => <Bulk />,
      }}
    />
  );
}

function useModels() {
  return useQuery(async () => must(await supabase.from("models").select("id, name").eq("is_active", true).order("name")) as { id: string; name: string }[], []);
}
function useCategories() {
  return useQuery(async () => must(await supabase.from("scheme_master").select("code, name, category").eq("is_active", true).order("code")) as { code: string; name: string; category: string }[], []);
}

function Revisions() {
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

const emptyLine = (): Line => ({
  line_type: "",
  scheme_master_code: null,
  tkm_share: 0,
  dealer_share: 0,
  prev_my_tkm_share: null,
  prev_my_dealer_share: null,
  is_customer_facing: true,
});

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

// CSV columns: model, scheme, valid_from, suffixes, category, line, tkm_share, dealer_share,
// prev_my_tkm_share, prev_my_dealer_share, customer_facing. Rows with the same model + scheme +
// valid_from become one revision.
function Bulk() {
  const canWrite = useCanWriteMaster("schemes");
  const models = useModels();
  const [rows, setRows] = useState<string[][] | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(() => {
    if (!rows || rows.length < 2) return [];
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const col = (r: string[], k: string) => (r[head.indexOf(k)] ?? "").trim();
    const byName = new Map((models.data ?? []).map((m) => [m.name.toLowerCase(), m.id]));
    const groups = new Map<string, { model: string; model_id: string | undefined; name: string; valid_from: string; suffixes: string; lines: Line[] }>();
    for (const r of rows.slice(1)) {
      if (!r.some((c) => c.trim())) continue;
      const key = [col(r, "model"), col(r, "scheme"), col(r, "valid_from")].join("|");
      if (!groups.has(key))
        groups.set(key, {
          model: col(r, "model"),
          model_id: byName.get(col(r, "model").toLowerCase()),
          name: col(r, "scheme"),
          valid_from: col(r, "valid_from"),
          suffixes: col(r, "suffixes"),
          lines: [],
        });
      const num = (k: string) => (col(r, k) === "" ? null : Number(col(r, k)));
      groups.get(key)!.lines.push({
        line_type: col(r, "line"),
        scheme_master_code: col(r, "category") || null,
        tkm_share: num("tkm_share") ?? 0,
        dealer_share: num("dealer_share") ?? 0,
        prev_my_tkm_share: num("prev_my_tkm_share"),
        prev_my_dealer_share: num("prev_my_dealer_share"),
        is_customer_facing: !/^(n|no|false|0)$/i.test(col(r, "customer_facing")),
      });
    }
    return [...groups.values()];
  }, [rows, models.data]);

  return (
    <Card title="Bulk scheme entry" note="Columns: model, scheme, valid_from (YYYY-MM-DD), suffixes, category, line, tkm_share, dealer_share, prev_my_tkm_share, prev_my_dealer_share, customer_facing.">
      <div className="space-y-2 px-3 py-2 text-sm">
        <input
          type="file"
          accept=".csv,text/csv"
          className="text-xs"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setResult(null);
            f.text().then((t) => setRows(parseCsv(t)));
          }}
        />
        {error && <ErrorBox message={error} />}
        {result && <p className="text-sm text-emerald-700">{result}</p>}
        {preview.length > 0 && (
          <>
            <Table head={["Model", "Scheme", "From", "Suffixes", "Lines", ""]}>
              {preview.map((g, i) => (
                <tr key={i}>
                  <Td>{g.model}</Td>
                  <Td>{g.name}</Td>
                  <Td muted>{g.valid_from}</Td>
                  <Td muted>{g.suffixes || "All"}</Td>
                  <Td muted>{g.lines.map((l) => `${l.line_type || l.scheme_master_code}: ${l.tkm_share}+${l.dealer_share}`).join("; ")}</Td>
                  <Td>{g.model_id ? <Chip tone="emerald">OK</Chip> : <Chip tone="red">Unknown model</Chip>}</Td>
                </tr>
              ))}
            </Table>
            {canWrite && (
              <RunButton
                label={`Save ${preview.filter((g) => g.model_id).length} revisions`}
                run={async () => {
                  setError(null);
                  let n = 0;
                  for (const g of preview.filter((x) => x.model_id)) {
                    const scope = g.suffixes.split(/[,;]/).map((s) => s.trim().toUpperCase()).filter(Boolean);
                    try {
                      await rpc("save_scheme_revision", { p: { model_id: g.model_id, name: g.name, valid_from: g.valid_from, suffix_scope_list: scope.length ? scope : null, lines: g.lines } }, { refresh: false });
                      n++;
                    } catch (e) {
                      setError(`${g.model} / ${g.name} / ${g.valid_from}: ${e instanceof Error ? e.message : e}. ${n} saved before this row.`);
                      return;
                    }
                  }
                  setResult(`${n} revisions saved.`);
                  setRows(null);
                }}
              />
            )}
          </>
        )}
      </div>
    </Card>
  );
}
