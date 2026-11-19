import { useMemo, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase/client";
import {
  OUTCOME_LABEL,
  guessOwnDealers,
  isToyota,
  matchRto,
  matchesCsv,
  parseEnquiries,
  parseRto,
  readSheet,
  tally,
  uniq,
  type EnquiryRow,
  type Match,
  type Outcome,
  type RtoRow,
} from "@/lib/lost-sales";
import { Card, Chip, EmptyRow, ErrorBox, PageHeader, RunButton, Stat, Table, Td, fmtDate, inputCls, inr } from "@/ui";

type Loaded<T> = { file: string; rows: T[]; note?: string };

const PAGE = 200;
const outcomeTone = { ours: "emerald", other_toyota: "amber", other_brand: "red" } as const;
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

// Lost to Competition: of the customers who once enquired with us, who registered a vehicle bought
// elsewhere: from another Toyota dealer, or another brand. Upload the RTO registration dump (one
// file per month is fine; each month's column layout may differ) and the enquiry dump; they are
// matched on mobile number in the browser and never leave this computer.
export default function LostSales() {
  const [rtoFiles, setRtoFiles] = useState<Loaded<RtoRow>[]>([]);
  const [enqFiles, setEnqFiles] = useState<Loaded<EnquiryRow>[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [ownDealers, setOwnDealers] = useState<Set<string> | null>(null);
  const [bulkLimit, setBulkLimit] = useState(5);
  const [carsOnly, setCarsOnly] = useState(true);

  const rto = useMemo(() => rtoFiles.flatMap((f) => f.rows), [rtoFiles]);
  const enquiries = useMemo(() => enqFiles.flatMap((f) => f.rows), [enqFiles]);

  // Toyota dealers in the dump, busiest first, so our own can be ticked.
  const toyotaDealers = useMemo(() => tally(rto.filter(isToyota), (r) => r.dealer), [rto]);
  const own = useMemo(() => ownDealers ?? new Set(guessOwnDealers(rto)), [ownDealers, rto]);

  const result = useMemo(
    () => (rto.length && enquiries.length ? matchRto(rto, enquiries, { ownDealers: own, bulkLimit, carsOnly }) : null),
    [rto, enquiries, own, bulkLimit, carsOnly],
  );

  async function load<T>(files: FileList | null, label: string, parse: (grid: string[][], name: string) => Loaded<T>, set: (f: (prev: Loaded<T>[]) => Loaded<T>[]) => void) {
    if (!files?.length) return;
    const errs: string[] = [];
    for (const file of Array.from(files)) {
      setBusy(`Reading ${label} ${file.name}…`);
      try {
        const loaded = parse(await readSheet(file), file.name);
        set((prev) => [...prev.filter((p) => p.file !== loaded.file), loaded]);
      } catch (e) {
        errs.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setErrors(errs);
    setBusy(null);
  }

  async function loadCrmEnquiries() {
    const rows: EnquiryRow[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("enquiries")
        .select("created_at, customers(name, mobile), models(name), assigned:employees!enquiries_assigned_employee_id_fkey(name)")
        .order("created_at")
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      type Row = { created_at: string; customers: { name: string; mobile: string } | null; models: { name: string } | null; assigned: { name: string } | null };
      for (const r of data as unknown as Row[]) {
        if (!r.customers?.mobile) continue;
        rows.push({ source: "CRM", name: r.customers.name, mobile: r.customers.mobile, model: r.models?.name ?? "", grade: "", officer: r.assigned?.name ?? "", date: r.created_at.slice(0, 10) });
      }
      if (data.length < 1000) break;
    }
    setEnqFiles((prev) => [...prev.filter((p) => p.file !== "CRM enquiries"), { file: "CRM enquiries", rows }]);
  }

  return (
    <div>
      <PageHeader
        title="Lost to Competition"
        note="Customers who enquired with us and then registered a car bought from another Toyota dealer or another brand, matched on mobile number."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="1. RTO registration dump" note="Excel (.xlsx / .xls) or CSV. Select several months at once; the columns are found by their names.">
          <div className="p-3">
          <input type="file" multiple accept=".xlsx,.xls,.csv" className="text-sm" onChange={(e) => {
            const files = e.target.files;
            void load(files, "RTO", (g, n) => ({ file: n, rows: parseRto(g, n) }), setRtoFiles);
            e.target.value = "";
          }} />
          <FileList files={rtoFiles} unit="registrations" onRemove={(f) => setRtoFiles((p) => p.filter((x) => x.file !== f))} />
          </div>
        </Card>
        <Card title="2. Enquiry dump" note="Needs a Mobile Number column; Customer Name, Model Name, Grade Code and Sales Officer are used when present.">
          <div className="p-3">
          <div className="flex flex-wrap items-center gap-3">
            <input type="file" multiple accept=".xlsx,.xls,.csv" className="text-sm" onChange={(e) => {
              const files = e.target.files;
              void load(files, "enquiries", (g, n) => {
                const p = parseEnquiries(g, n);
                return { file: n, rows: p.rows, note: p.badMobiles ? `${p.badMobiles} rows without a valid mobile skipped` : undefined };
              }, setEnqFiles);
              e.target.value = "";
            }} />
            <RunButton tone="light" label="Add enquiries from this CRM" run={loadCrmEnquiries} />
          </div>
          <FileList files={enqFiles} unit="enquiries" onRemove={(f) => setEnqFiles((p) => p.filter((x) => x.file !== f))} />
          </div>
        </Card>
      </div>

      {busy && <p className="my-3 text-sm text-slate-500">{busy}</p>}
      {errors.map((e) => <ErrorBox key={e} message={e} />)}

      {rto.length > 0 && (
        <Card
          title="3. Our dealership"
          note="Toyota sales by the ticked dealer names count as bought from us; other Toyota dealers are lost. Pre-ticked: Toyota dealer names with RAJESH."
        >
          <div className="p-3">
          <div className="mb-3 flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={carsOnly} onChange={(e) => setCarsOnly(e.target.checked)} />
              Cars only (leave out tractors, buses, goods vehicles)
            </label>
            <label className="flex items-center gap-2">
              Ignore a mobile number on more than
              <input type="number" min={1} value={bulkLimit} onChange={(e) => setBulkLimit(Math.max(1, Number(e.target.value) || 1))} className={`${inputCls} w-16`} />
              registrations (a dealer's or agent's number)
            </label>
          </div>
          <div className="max-h-56 overflow-y-auto rounded border border-slate-200 p-2">
            {toyotaDealers.map(([dealer, n]) => (
              <label key={dealer} className="flex items-center gap-2 py-0.5 text-sm">
                <input
                  type="checkbox"
                  checked={own.has(dealer)}
                  onChange={(e) => {
                    const next = new Set(own);
                    if (e.target.checked) next.add(dealer);
                    else next.delete(dealer);
                    setOwnDealers(next);
                  }}
                />
                <span className={own.has(dealer) ? "font-medium" : "text-slate-600"}>{dealer}</span>
                <span className="text-xs text-slate-400">{n} Toyota</span>
              </label>
            ))}
            {toyotaDealers.length === 0 && <p className="text-sm text-slate-500">No Toyota registrations in the dump.</p>}
          </div>
          </div>
        </Card>
      )}

      {result ? <Results result={result} /> : (
        <p className="mt-6 text-center text-sm text-slate-400">Upload both the RTO dump and the enquiry dump to see the result.</p>
      )}
    </div>
  );
}

function FileList<T>({ files, unit, onRemove }: { files: Loaded<T>[]; unit: string; onRemove: (file: string) => void }) {
  if (!files.length) return null;
  return (
    <ul className="mt-3 space-y-1 text-sm">
      {files.map((f) => (
        <li key={f.file} className="flex items-center gap-2">
          <span className="font-medium">{f.file}</span>
          <span className="text-slate-500">{f.rows.length.toLocaleString("en-IN")} {unit}</span>
          {f.note && <span className="text-xs text-amber-700">{f.note}</span>}
          <button type="button" className="text-xs text-slate-400 hover:text-red-600" onClick={() => onRemove(f.file)}>remove</button>
        </li>
      ))}
    </ul>
  );
}

type Result = ReturnType<typeof matchRto>;

function Results({ result }: { result: Result }) {
  const { matches } = result;
  const [outcome, setOutcome] = useState<"lost" | Outcome | "all">("lost");
  const [brand, setBrand] = useState("");
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);

  const lost = matches.filter((m) => m.outcome !== "ours");
  const ours = matches.length - lost.length;
  const otherToyota = lost.filter((m) => m.outcome === "other_toyota").length;
  const customers = new Set(matches.map((m) => m.mobile)).size;
  const lostCustomers = new Set(lost.map((m) => m.mobile)).size;

  const officers = useMemo(() => {
    const m = new Map<string, { ours: number; lost: number }>();
    for (const r of matches) {
      const k = uniq(r.enquiries.map((e) => e.officer)) || "—";
      const v = m.get(k) ?? { ours: 0, lost: 0 };
      if (r.outcome === "ours") v.ours++;
      else v.lost++;
      m.set(k, v);
    }
    return [...m].sort((a, b) => b[1].lost - a[1].lost);
  }, [matches]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return matches.filter(
      (m) =>
        (outcome === "all" || (outcome === "lost" ? m.outcome !== "ours" : m.outcome === outcome)) &&
        (!brand || m.brand === brand) &&
        (!q || [m.owner, m.mobile, m.regNo, m.model, m.dealer, ...m.enquiries.flatMap((e) => [e.name, e.model, e.officer])].some((s) => s.toUpperCase().includes(q))),
    );
  }, [matches, outcome, brand, search]);

  function download() {
    const blob = new Blob(["﻿" + matchesCsv(filtered)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `lost-to-competition-${outcome}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="RTO registrations checked" value={result.considered.toLocaleString("en-IN")} note={result.skippedNotCar ? `${result.skippedNotCar.toLocaleString("en-IN")} non-cars left out` : undefined} />
        <Stat label="Enquiry customers" value={result.enquiryMobiles.toLocaleString("en-IN")} note="unique mobile numbers" />
        <Stat label="Enquired, then registered" value={matches.length} note={`${customers} customers`} />
        <Stat label="Bought from us" value={ours} note={pct(ours, matches.length)} />
        <Stat label="Lost: other Toyota dealer" value={otherToyota} tone="amber" note={pct(otherToyota, matches.length)} />
        <Stat label="Lost: other brand" value={lost.length - otherToyota} tone="red" note={pct(lost.length - otherToyota, matches.length)} />
      </div>
      <p className="text-xs text-slate-500">
        {lost.length} vehicles ({lostCustomers} customers) bought elsewhere by people who enquired with us.
        {result.skippedBulk > 0 && ` ${result.skippedBulk} matches left out because the mobile number is on more than the limit of registrations.`}
        {result.noMobile > 0 && ` ${result.noMobile} registrations had no usable mobile number.`}
      </p>

      <div className="grid gap-4 lg:grid-cols-3">
        <Breakdown title="Lost, by brand bought" rows={tally(lost, (m) => m.brand)} total={lost.length} onPick={(b) => { setBrand(b); setOutcome("lost"); }} />
        <Breakdown title="Lost, by dealer" rows={tally(lost, (m) => m.dealer)} total={lost.length} />
        <Breakdown title="Lost, by model enquired" rows={tally(lost, (m) => uniq(m.enquiries.map((e) => e.model)))} total={lost.length} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="By sales officer" note="Enquiries that registered: bought from us vs lost.">
          <div className="max-h-80 overflow-y-auto">
            <Table head={["Sales officer", "Bought from us", "Lost", "Lost %"]}>
              {officers.map(([o, v]) => (
                <tr key={o}>
                  <Td>{o}</Td>
                  <Td right>{v.ours}</Td>
                  <Td right>{v.lost}</Td>
                  <Td right muted>{pct(v.lost, v.ours + v.lost)}</Td>
                </tr>
              ))}
            </Table>
          </div>
        </Card>
        <Breakdown title="Lost, by model bought" rows={tally(lost, (m) => `${m.brand} · ${m.model}`)} total={lost.length} />
      </div>

      <Card
        title={`Customers (${filtered.length})`}
        aside={
          <div className="flex flex-wrap items-center gap-2">
            <select value={outcome} onChange={(e) => { setOutcome(e.target.value as typeof outcome); setShown(PAGE); }} className={inputCls}>
              <option value="lost">Lost (all)</option>
              <option value="other_toyota">{OUTCOME_LABEL.other_toyota}</option>
              <option value="other_brand">{OUTCOME_LABEL.other_brand}</option>
              <option value="ours">{OUTCOME_LABEL.ours}</option>
              <option value="all">All matches</option>
            </select>
            <select value={brand} onChange={(e) => { setBrand(e.target.value); setShown(PAGE); }} className={inputCls}>
              <option value="">All brands</option>
              {tally(matches, (m) => m.brand).map(([b]) => <option key={b} value={b}>{b}</option>)}
            </select>
            <input value={search} onChange={(e) => { setSearch(e.target.value); setShown(PAGE); }} placeholder="Search name, mobile, model, dealer, officer" className={`${inputCls} w-64`} />
            <button type="button" onClick={download} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100">Download CSV</button>
          </div>
        }
      >
        <Table head={["Customer", "Enquired with us", "Bought", "Dealer", "Registered", ""]}>
          {filtered.length === 0 ? (
            <EmptyRow cols={6} text="No customers for this filter." />
          ) : (
            filtered.slice(0, shown).map((m, i) => <MatchRow key={`${m.regNo}-${m.mobile}-${i}`} m={m} />)
          )}
        </Table>
        {filtered.length > shown && (
          <button type="button" onClick={() => setShown((s) => s + PAGE)} className="m-3 text-sm text-blue-700 hover:underline">
            Show {Math.min(PAGE, filtered.length - shown)} more
          </button>
        )}
      </Card>
    </div>
  );
}

function MatchRow({ m }: { m: Match }) {
  return (
    <tr>
      <Td>
        {m.owner}
        <div className="text-xs text-slate-500">{m.mobile}</div>
      </Td>
      <Td>
        {uniq(m.enquiries.map((e) => [e.model, e.grade].filter(Boolean).join(" "))) || "—"}
        <div className="text-xs text-slate-500">
          {uniq(m.enquiries.map((e) => e.officer))}
          {m.enquiries.length > 1 && ` · ${m.enquiries.length} enquiries`}
          {uniq(m.enquiries.map((e) => e.name)) && uniq(m.enquiries.map((e) => e.name)).toUpperCase() !== m.owner.toUpperCase() && ` · as ${uniq(m.enquiries.map((e) => e.name))}`}
        </div>
      </Td>
      <Td>
        {m.brand} · {m.model}
        <div className="text-xs text-slate-500">{m.amount ? inr(m.amount) : ""}{m.financer && ` · ${m.financer}`}</div>
      </Td>
      <Td muted>{m.dealer}</Td>
      <Td>
        {m.regNo}
        <div className="text-xs text-slate-500">{fmtDate(m.regDate)} · {m.office}</div>
      </Td>
      <Td>
        <Chip tone={outcomeTone[m.outcome]}>{OUTCOME_LABEL[m.outcome]}</Chip>
      </Td>
    </tr>
  );
}

function Breakdown({ title, rows, total, onPick }: { title: ReactNode; rows: [string, number][]; total: number; onPick?: (key: string) => void }) {
  const max = rows[0]?.[1] ?? 0;
  return (
    <Card title={title}>
      <div className="max-h-80 space-y-1 overflow-y-auto p-3">
        {rows.length === 0 && <p className="text-sm text-slate-500">Nothing lost.</p>}
        {rows.map(([k, n]) => (
          <div key={k} className={`text-sm ${onPick ? "cursor-pointer hover:bg-slate-50" : ""}`} onClick={onPick && (() => onPick(k))}>
            <div className="flex justify-between gap-2">
              <span className="truncate" title={k}>{k}</span>
              <span className="shrink-0 tabular-nums text-slate-600">{n} <span className="text-xs text-slate-400">{pct(n, total)}</span></span>
            </div>
            <div className="h-1 rounded bg-slate-100">
              <div className="h-1 rounded bg-slate-400" style={{ width: `${max ? (n / max) * 100 : 0}%` }} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
