import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase/client";
import { useRightGate } from "@/lib/rbac";
import {
  OUTCOME_LABEL,
  guessOwnDealers,
  matchRto,
  matchesCsv,
  parseEnquiries,
  parseRto,
  readSheet,
  tally,
  uniq,
  type Candidate,
  type Dataset,
  type EnquiryRow,
  type Match,
  type Outcome,
} from "@/lib/lost-sales";
import { Card, Chip, EmptyRow, ErrorBox, PageHeader, Stat, Table, Td, fmtDate, fmtDateTime, inputCls, inr } from "@/ui";

type SavedFile = { id: string; kind: "rto" | "enquiry"; file_name: string; row_count: number; skipped_rows: number; uploaded_at: string; employees: { name: string } | null };

const PAGE = 200;
const BATCH = 2000;
const outcomeTone = { ours: "emerald", other_toyota: "amber", other_brand: "red" } as const;
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

// Fixed rules: Toyota sales by a dealer named RAJESH are ours; only cars count; a mobile number on more
// than BULK_LIMIT registrations is a dealer's or agent's, not the customer's.
const BULK_LIMIT = 5;

// Per-viewer setting: whether the CRM's own enquiries are included.
const SETTINGS_KEY = "lost-sales-settings";
type Settings = { includeCrm?: boolean };
function readSettings(): Settings {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Settings;
  } catch {
    return {};
  }
}
function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private window: settings just aren't remembered */
  }
}

type DbRto = {
  office: string | null; reg_no: string | null; reg_date: string | null; vehicle_class: string | null; owner: string | null; mobile: string | null;
  address: string | null; financer: string | null; maker: string | null; brand: string | null; model: string | null; purchase_date: string | null;
  amount: number | null; dealer: string | null; is_car: boolean; is_toyota: boolean; mobile_regs: number;
};
type DbEnquiry = { mobile: string; name: string | null; model: string | null; grade: string | null; officer: string | null; enquiry_date: string | null; source: string };
type DbData = { totals: { rows: number; no_mobile: number; not_car: number }; enquiry_mobiles: number; toyota_dealers: [string, number][]; candidates: DbRto[]; enquiries: DbEnquiry[] };

const s = (v: string | null | undefined) => v ?? "";
function toDataset(d: DbData): Dataset {
  return {
    totals: { rows: d.totals.rows, noMobile: d.totals.no_mobile, notCar: d.totals.not_car },
    enquiryMobiles: d.enquiry_mobiles,
    toyotaDealers: d.toyota_dealers,
    candidates: d.candidates.map(
      (r): Candidate => ({
        file: "", office: s(r.office), regNo: s(r.reg_no), regDate: s(r.reg_date), vehicleClass: s(r.vehicle_class), owner: s(r.owner),
        mobile: r.mobile, address: s(r.address), financer: s(r.financer), maker: s(r.maker), brand: s(r.brand), model: s(r.model),
        purchaseDate: s(r.purchase_date), amount: r.amount === null ? null : Number(r.amount), dealer: s(r.dealer), isCar: r.is_car,
        isToyota: r.is_toyota, mobileRegs: Number(r.mobile_regs),
      }),
    ),
    enquiries: d.enquiries.map((e): EnquiryRow => ({ source: e.source, name: s(e.name), mobile: e.mobile, model: s(e.model), grade: s(e.grade), officer: s(e.officer), date: s(e.enquiry_date) })),
  };
}

const nullIfEmpty = (v: string) => (v ? v : null);
const isoOrNull = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// Lost to Competition: of the customers who once enquired with us, who registered a vehicle bought
// elsewhere: from another Toyota dealer, or another brand. Each month's RTO dump and each enquiry dump
// is uploaded once and saved (lost_sales_* tables); uploading a file with the same name replaces it.
export default function LostSales() {
  const canUpload = useRightGate("rpt_lost_sales", "create");
  const canDelete = useRightGate("rpt_lost_sales", "delete");
  const initial = useMemo(readSettings, []);
  const [files, setFiles] = useState<SavedFile[] | null>(null);
  const [data, setData] = useState<Dataset | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [includeCrm, setIncludeCrm] = useState(initial.includeCrm ?? false);

  useEffect(() => {
    saveSettings({ includeCrm });
  }, [includeCrm]);

  const reload = useCallback(async () => {
    const [f, d] = await Promise.all([
      supabase.from("lost_sales_files").select("id, kind, file_name, row_count, skipped_rows, uploaded_at, employees(name)").order("file_name"),
      supabase.rpc("lost_sales_data", { p_include_crm: includeCrm }),
    ]);
    if (f.error || d.error) {
      setErrors([(f.error ?? d.error)!.message]);
      return;
    }
    setFiles(f.data as unknown as SavedFile[]);
    setData(toDataset(d.data as DbData));
  }, [includeCrm]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const own = useMemo(() => new Set(guessOwnDealers(data?.toyotaDealers ?? [])), [data]);
  const rtoFiles = files?.filter((f) => f.kind === "rto") ?? [];
  const enqFiles = files?.filter((f) => f.kind === "enquiry") ?? [];
  const result = useMemo(
    () => (data && data.totals.rows > 0 && data.enquiryMobiles > 0 ? matchRto(data, { ownDealers: own, bulkLimit: BULK_LIMIT, carsOnly: true }) : null),
    [data, own],
  );

  async function upload(list: FileList | null, kind: "rto" | "enquiry") {
    if (!list?.length) return;
    const errs: string[] = [];
    for (const file of Array.from(list)) {
      try {
        setBusy(`Reading ${file.name}…`);
        const grid = await readSheet(file);
        let rows: Record<string, unknown>[];
        let skipped = 0;
        if (kind === "rto") {
          rows = parseRto(grid, file.name).map((r) => ({
            office: r.office, reg_no: r.regNo, reg_date: isoOrNull(r.regDate), vehicle_class: r.vehicleClass, owner: r.owner, mobile: r.mobile,
            address: r.address, financer: r.financer, maker: r.maker, brand: r.brand, model: r.model, purchase_date: isoOrNull(r.purchaseDate),
            amount: r.amount, dealer: r.dealer, is_car: r.isCar, is_toyota: r.isToyota,
          }));
        } else {
          const p = parseEnquiries(grid, file.name);
          skipped = p.badMobiles;
          rows = p.rows.map((e) => ({ name: e.name, mobile: e.mobile, model: e.model, grade: nullIfEmpty(e.grade), officer: e.officer, enquiry_date: isoOrNull(e.date) }));
        }
        const begin = await supabase.rpc("lost_sales_begin_file", { p_kind: kind, p_file_name: file.name });
        if (begin.error) throw new Error(begin.error.message);
        for (let i = 0; i < rows.length; i += BATCH) {
          setBusy(`Saving ${file.name}: ${Math.min(i + BATCH, rows.length).toLocaleString("en-IN")} of ${rows.length.toLocaleString("en-IN")} rows…`);
          const add = await supabase.rpc("lost_sales_add_rows", { p_file_id: begin.data, p_rows: rows.slice(i, i + BATCH), p_skipped: i === 0 ? skipped : 0 });
          if (add.error) throw new Error(`${add.error.message} (saved up to row ${i}; upload the file again)`);
        }
      } catch (e) {
        errs.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setBusy("Updating the report…");
    await reload();
    setErrors(errs);
    setBusy(null);
  }

  async function remove(f: SavedFile) {
    if (!window.confirm(`Remove ${f.file_name} and its ${f.row_count.toLocaleString("en-IN")} rows?`)) return;
    setBusy(`Removing ${f.file_name}…`);
    const { error } = await supabase.rpc("lost_sales_delete_file", { p_file_id: f.id });
    if (error) setErrors([error.message]);
    await reload();
    setBusy(null);
  }

  const picker = (kind: "rto" | "enquiry") =>
    canUpload && (
      <input type="file" multiple accept=".xlsx,.xls,.csv" disabled={!!busy} className="text-sm" onChange={(e) => {
        const list = e.target.files;
        void upload(list, kind);
        e.target.value = "";
      }} />
    );

  return (
    <div>
      <PageHeader
        title="Lost to Competition"
        note="Customers who enquired with us and then registered a car bought from another Toyota dealer or another brand, matched on mobile number."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="1. RTO registration dumps" note="Saved once, kept for everyone. Add each new month as it comes; a file with the same name replaces the old one. A registration in two files counts once.">
          <div className="p-3">
            {picker("rto")}
            <FileList files={rtoFiles} unit="registrations" canDelete={canDelete} onRemove={remove} />
          </div>
        </Card>
        <Card title="2. Enquiry dumps" note="Needs a Mobile Number column; Customer Name, Model Name, Grade Code and Sales Officer are used when present.">
          <div className="p-3">
            {picker("enquiry")}
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={includeCrm} onChange={(e) => setIncludeCrm(e.target.checked)} />
              Also use the enquiries entered in this CRM
            </label>
            <FileList files={enqFiles} unit="enquiries" canDelete={canDelete} onRemove={remove} />
          </div>
        </Card>
      </div>

      {busy && <p className="my-3 text-sm text-slate-500">{busy}</p>}
      {errors.map((e) => <ErrorBox key={e} message={e} />)}
      {files === null && !errors.length && <p className="my-3 text-sm text-slate-400">Loading saved files…</p>}

      {result ? <Results result={result} /> : files !== null && (
        <p className="mt-6 text-center text-sm text-slate-400">
          {canUpload ? "Upload the RTO dump and the enquiry dump to see the result." : "No RTO and enquiry dumps have been saved yet."}
        </p>
      )}
    </div>
  );
}

function FileList({ files, unit, canDelete, onRemove }: { files: SavedFile[]; unit: string; canDelete: boolean; onRemove: (f: SavedFile) => void }) {
  if (!files.length) return <p className="mt-3 text-sm text-slate-400">Nothing saved yet.</p>;
  return (
    <ul className="mt-3 space-y-1 text-sm">
      {files.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center gap-x-2">
          <span className="font-medium">{f.file_name}</span>
          <span className="text-slate-500">{f.row_count.toLocaleString("en-IN")} {unit}</span>
          {f.skipped_rows > 0 && <span className="text-xs text-amber-700">{f.skipped_rows} rows without a valid mobile skipped</span>}
          <span className="text-xs text-slate-400">
            {fmtDateTime(f.uploaded_at)}
            {f.employees?.name && ` · ${f.employees.name}`}
          </span>
          {canDelete && (
            <button type="button" className="text-xs text-slate-400 hover:text-red-600" onClick={() => onRemove(f)}>remove</button>
          )}
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
