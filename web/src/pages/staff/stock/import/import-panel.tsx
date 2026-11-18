"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { readStockPdf, type StockStatement } from "@/lib/stock-pdf";

type Outlet = { id: string; name: string; city: string | null; ctdms_dealer_code: string | null };
type Summary = Record<string, unknown>;

const MAX_FILE_BYTES = 25 * 1024 * 1024;

// The PDF is read here, in the browser; only the parsed rows go to the database.
export function StockImportPanel({ outlets, defaultOutletId }: { outlets: Outlet[]; defaultOutletId: string | null }) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const [fileName, setFileName] = useState<string | null>(null);
  const [report, setReport] = useState<StockStatement | null>(null);
  const [outletId, setOutletId] = useState<string>(defaultOutletId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    setReport(null);
    setSummary(null);
    setError(null);
    if (!file) return;
    setFileName(file.name);
    if (file.size > MAX_FILE_BYTES) {
      setError("File is too large for a CTDMS stock statement.");
      return;
    }
    setBusy(true);
    try {
      const parsed = await readStockPdf(await file.arrayBuffer());
      setReport(parsed);
      // The Transit report prints the dealer code; the Physical one only the dealer name.
      const byCode = outlets.find((o) => o.ctdms_dealer_code && o.ctdms_dealer_code === parsed.dealerCode);
      const byName = outlets.find((o) => {
        const name = parsed.dealerName?.toUpperCase() ?? "";
        return (o.city && name.includes(o.city.toUpperCase())) || name.includes(o.name.toUpperCase());
      });
      if (byCode ?? byName) setOutletId((byCode ?? byName)!.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read this PDF.");
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!report || !outletId) return;
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc("import_stock_statement", {
      p_outlet_id: outletId,
      p_source: report.source,
      p_report_date: report.reportDate,
      p_file_name: fileName,
      p_rows: report.rows,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setSummary(data as Summary);
    setReport(null);
    router.refresh();
  }

  const n = (k: string) => Number(summary?.[k] ?? 0);
  const list = (k: string) => (Array.isArray(summary?.[k]) ? (summary![k] as string[]) : []);

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Upload a CTDMS Stock Statement</h2>
      <p className="mb-3 text-xs text-slate-500">
        The <b>Transit</b> or <b>Physical Stock</b> PDF, exactly as CTDMS prints it, with Vehicle Status and Order Status set
        to All. Upload both every day: cars no longer in a report are flagged.
      </p>
      <input type="file" accept="application/pdf,.pdf" onChange={handleFile} className="text-sm" disabled={busy} />
      {busy && !report && <p className="mt-2 text-sm text-slate-500">Reading…</p>}

      {report && (
        <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm">
          <p>
            <b>{report.source === "transit" ? "Transit" : "Physical Stock"}</b> of{" "}
            {report.reportDate ? new Date(`${report.reportDate}T00:00:00`).toLocaleDateString("en-IN") : "?"} ·{" "}
            {report.dealerName ?? "dealer not printed"} {report.dealerCode ? `(${report.dealerCode})` : ""} · {report.rows.length} cars
            {report.totalVehicles !== null ? ` (report says ${report.totalVehicles})` : ""} ·{" "}
            {report.rows.filter((r) => r.block_status && r.block_status !== "Free").length} blocked/allotted in CTDMS
          </p>
          {report.warnings.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-amber-700">
              {report.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex items-center gap-2">
            <label className="text-xs text-slate-600">Branch</label>
            <select value={outletId} onChange={(e) => setOutletId(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
              <option value="">Choose…</option>
              {outlets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.ctdms_dealer_code ? ` (${o.ctdms_dealer_code})` : ""}
                </option>
              ))}
            </select>
            <button
              onClick={runImport}
              disabled={busy || !outletId || report.rows.length === 0}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? "Importing…" : "Import"}
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {summary && (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <p>
            {n("rows")} cars · {n("inserted")} new · {n("updated")} updated · {n("moved_to_physical")} arrived from transit ·{" "}
            {n("missing_from_report")} no longer in this report{n("back_in_report") ? ` · ${n("back_in_report")} back in it` : ""}
          </p>
          {n("ctdms_allotments_to_confirm") > 0 && (
            <p className="mt-1 text-xs">
              {n("ctdms_allotments_to_confirm")} cars are blocked in CTDMS for our open orders: confirm them under{" "}
              <a href="/stock/match" className="underline">Match</a>.
            </p>
          )}
          {list("unmapped_variants").length > 0 && (
            <p className="mt-1 text-xs">Suffix codes not in master data: {list("unmapped_variants").join(", ")}</p>
          )}
          {list("unmapped_colors").length > 0 && (
            <p className="mt-1 text-xs">
              Colours to map under <a href="/stock/ctdms" className="underline">CTDMS To-do</a>: {list("unmapped_colors").join(", ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
