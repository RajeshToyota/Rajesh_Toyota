"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { parseCsv } from "@/lib/csv";
import { readXls } from "@/lib/xls";
import { detectCtdmsReport, type CtdmsReport } from "@/lib/ctdms-import";

type Summary = Record<string, unknown>;

const MAX_FILE_BYTES = 20 * 1024 * 1024;

const fmtDate = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN") : "?");

// The file is parsed here, in the browser; only the mapped rows go to the database.
export function UploadPanel() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const [fileName, setFileName] = useState<string | null>(null);
  const [report, setReport] = useState<CtdmsReport | null>(null);
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
      setError("File is too large for a CTDMS report.");
      return;
    }
    try {
      const grid = file.name.toLowerCase().endsWith(".csv")
        ? parseCsv(await file.text())
        : readXls(await file.arrayBuffer());
      setReport(detectCtdmsReport(grid));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read this file.");
    }
  }

  async function runImport() {
    if (!report) return;
    setBusy(true);
    setError(null);
    const { data, error: rpcError } =
      report.kind === "enquiry_report"
        ? await supabase.rpc("import_ctdms_enquiry_report", {
            p_file_name: fileName,
            p_from: report.from,
            p_to: report.to,
            p_rows: report.rows,
          })
        : await supabase.rpc("import_ctdms_order_listing", {
            p_file_name: fileName,
            p_dealer_code: report.dealerCode,
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

  const openOnly = report?.kind === "order_listing" && report.statusFilter?.replace(/\s/g, "").toLowerCase() === "booked,accepted";

  return (
    <div className="mb-6 rounded-md border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Upload from CTDMS</h2>
      <p className="mb-3 text-xs text-slate-500">
        The daily <b>Enquiry Survey Report</b>, or a branch&apos;s <b>PO Order Listing</b> filtered to Booked + Accepted.
        Upload the .xls exactly as CTDMS exports it (or saved as CSV).
      </p>
      <input type="file" accept=".xls,.csv" onChange={handleFile} className="text-sm" />

      {report && (
        <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm">
          {report.kind === "enquiry_report" ? (
            <p>
              <b>Enquiry Survey Report</b> · {fmtDate(report.from)} to {fmtDate(report.to)} ·{" "}
              {report.dealerCodes.join(", ") || "no dealer code"} · {report.rows.length} enquiries
            </p>
          ) : (
            <>
              <p>
                <b>PO Order Listing</b> · {report.dealerCode} · {report.rows.length} orders
                {report.statusFilter ? ` · status filter: ${report.statusFilter}` : ""}
              </p>
              {!openOnly && (
                <p className="mt-1 text-xs text-amber-700">
                  This export is not filtered to Booked + Accepted. Only those statuses are added; open orders missing
                  from the file will be marked closed, so check it is the branch&apos;s complete open list.
                </p>
              )}
            </>
          )}
          <button
            onClick={runImport}
            disabled={busy}
            className="mt-2 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? "Importing…" : "Import"}
          </button>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {summary && <ImportSummary summary={summary} />}
    </div>
  );
}

export function ImportSummary({ summary }: { summary: Summary }) {
  const n = (k: string) => Number(summary[k] ?? 0);
  const list = (k: string) => (Array.isArray(summary[k]) ? (summary[k] as string[]) : []);
  const isEnquiry = "matched" in summary;
  return (
    <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
      {isEnquiry ? (
        <p>
          {n("rows")} lines read · {n("matched")} matched to our enquiries · {n("missing_in_crm")} missing in our CRM ·{" "}
          {n("mismatch")} marked entered but not in CTDMS{n("reverified") ? ` · ${n("reverified")} fixed since last time` : ""}
        </p>
      ) : (
        <p>
          {n("rows")} orders · {n("inserted")} new · {n("updated")} updated · {n("verified")} of our bookings verified ·{" "}
          {n("mismatch")} of ours not in CTDMS
        </p>
      )}
      {list("closed_in_ctdms").length > 0 && (
        <p className="mt-1 text-xs">No longer open in CTDMS (invoiced or cancelled): {list("closed_in_ctdms").join(", ")}</p>
      )}
      {list("new_sales_officers").length > 0 && (
        <p className="mt-1 text-xs">New Sales Officers added: {list("new_sales_officers").join(", ")}</p>
      )}
      {list("unknown_sales_officers").length > 0 && (
        <p className="mt-1 text-xs">Not set up in our CRM yet: {list("unknown_sales_officers").join(", ")}</p>
      )}
    </div>
  );
}
