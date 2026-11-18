"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Employee = { id: string; name: string; employee_code: string | null };
type ImportRow = {
  line: number;
  employeeCode: string;
  name: string;
  values: Record<string, string>;
  employee: Employee | null;
  issue: string | null;
};

const FIELD_ALIASES: Record<string, string[]> = {
  employee_code: ["employee_code", "employee code", "emp code", "code"],
  name: ["name", "employee name", "full name"],
  pan: ["pan", "pan number", "pan no"],
  aadhaar_last4: ["aadhaar_last4", "aadhaar last4", "aadhaar last 4", "aadhaar last four"],
  bank_account_name: ["bank_account_name", "bank account name", "account holder name"],
  bank_account_no: ["bank_account_no", "bank account no", "account number", "bank account number"],
  bank_ifsc: ["bank_ifsc", "bank ifsc", "ifsc", "ifsc code"],
  bank_name: ["bank_name", "bank name"],
  personal_email: ["personal_email", "personal email", "personal mail"],
  current_address: ["current_address", "current address"],
  permanent_address: ["permanent_address", "permanent address"],
};

const PRIVATE_FIELDS = [
  "pan", "aadhaar_last4", "bank_account_name", "bank_account_no", "bank_ifsc",
  "bank_name", "personal_email", "current_address", "permanent_address",
];

function normalizeHeader(value: string) {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[.-]/g, " ").replace(/\s+/g, " ");
}

// Small RFC-4180-style CSV reader (quoted commas, escaped quotes and multiline cells).
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.length === 0) quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell.replace(/\r$/, ""));
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

function getColumn(headers: string[], key: string) {
  const aliases = FIELD_ALIASES[key].map(normalizeHeader);
  return headers.findIndex((h) => aliases.includes(normalizeHeader(h)));
}

function csvTemplate() {
  const headers = ["employee_code", "name", ...PRIVATE_FIELDS];
  const sample = ["EMP001", "Example Employee", "ABCDE1234F", "1234", "Example Employee", "000000000000", "HDFC0000000", "HDFC Bank", "employee@example.com", "Current address", "Permanent address"];
  return [headers, sample].map((r) => r.map((v) => '"' + v.replace(/"/g, '""') + '"').join(",")).join("\r\n");
}

export default function EmployeePrivateImport() {
  const supabase = useMemo(() => createClient(), []);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ saved: number; failed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data, error: permissionError } = await supabase.rpc("can_manage_hr");
      if (!live) return;
      if (permissionError || !data) { setAllowed(false); return; }
      setAllowed(true);
      const { data: staff, error: staffError } = await supabase
        .from("employees")
        .select("id, name, employee_code")
        .eq("is_active", true)
        .not("employee_code", "is", null)
        .limit(3000);
      if (!live) return;
      if (staffError) { setError("Could not load the employee list. Please refresh and try again."); return; }
      setEmployees((staff ?? []) as Employee[]);
    })();
    return () => { live = false; };
  }, [supabase]);

  async function readFile(file?: File) {
    setError(null);
    setResult(null);
    setRows([]);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Please export the employee sheet as CSV UTF-8 and upload the CSV file.");
      return;
    }
    setFileName(file.name);
    const text = await file.text();
    const matrix = parseCsv(text);
    if (matrix.length < 2) { setError("The CSV has no employee rows."); return; }
    const headers = matrix[0];
    const codeCol = getColumn(headers, "employee_code");
    const nameCol = getColumn(headers, "name");
    if (codeCol < 0) { setError("Required column missing: employee_code (or Employee Code)."); return; }
    const columns = Object.fromEntries(PRIVATE_FIELDS.map((key) => [key, getColumn(headers, key)]));
    const byCode = new Map<string, Employee>();
    for (const employee of employees) {
      const key = (employee.employee_code ?? "").trim().toLowerCase();
      if (key && !byCode.has(key)) byCode.set(key, employee);
    }
    const seen = new Set<string>();
    const parsed: ImportRow[] = matrix.slice(1).map((cells, index) => {
      const employeeCode = (cells[codeCol] ?? "").trim();
      const codeKey = employeeCode.toLowerCase();
      const values = Object.fromEntries(PRIVATE_FIELDS.map((key) => [key, columns[key] < 0 ? "" : (cells[columns[key]] ?? "").trim()]));
      const duplicate = !!codeKey && seen.has(codeKey);
      if (codeKey) seen.add(codeKey);
      const employee = byCode.get(codeKey) ?? null;
      const hasData = PRIVATE_FIELDS.some((key) => values[key]);
      let issue: string | null = null;
      if (!employeeCode) issue = "Missing employee code";
      else if (duplicate) issue = "Duplicate employee code in CSV";
      else if (!employee) issue = "No exact employee-code match";
      else if (!hasData) issue = "No private fields to import";
      if (values.aadhaar_last4 && !/^\d{4}$/.test(values.aadhaar_last4)) issue = "Aadhaar must contain last 4 digits only";
      if (values.pan && !/^[A-Z]{5}\d{4}[A-Z]$/i.test(values.pan)) issue = "PAN format is invalid";
      if (values.bank_ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(values.bank_ifsc)) issue = "IFSC format is invalid";
      return { line: index + 2, employeeCode, name: (nameCol < 0 ? "" : (cells[nameCol] ?? "").trim()), values, employee, issue };
    }).filter((r) => r.employeeCode || r.name || PRIVATE_FIELDS.some((key) => r.values[key]));
    setRows(parsed);
  }

  const ready = rows.filter((r) => r.employee && !r.issue && PRIVATE_FIELDS.some((key) => r.values[key]));
  const blocked = rows.length - ready.length;

  async function importRows() {
    if (!ready.length || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    let saved = 0;
    let failed = 0;
    try {
      // Re-check the server-side permission immediately before writing. The RPC itself also
      // enforces HR manager authorization for every employee.
      const { data: permitted, error: permissionError } = await supabase.rpc("can_manage_hr");
      if (permissionError || !permitted) throw new Error("Your HR permission is no longer valid. Sign in again or contact an administrator.");
      for (const row of ready) {
        const payload = Object.fromEntries(PRIVATE_FIELDS.map((key) => [key, row.values[key] ?? ""]));
        const { error: saveError } = await supabase.rpc("save_employee_private", {
          p_employee_id: row.employee!.id,
          p: payload,
        });
        if (saveError) failed += 1;
        else saved += 1;
      }
      setResult({ saved, failed });
      if (failed === 0) setRows([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import could not be completed.");
    } finally {
      setLoading(false);
    }
  }

  if (allowed === null) return <p className="text-sm text-slate-500">Checking HR permissions…</p>;
  if (!allowed) return <p className="text-sm text-red-700">Access denied. Only HR or the Business Head can use the employee private-data importer.</p>;

  const th = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500";
  return (
    <div className="max-w-6xl space-y-5">
      <div>
        <Link href="/hr" className="text-sm text-slate-500 underline">← Employees</Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Bulk import private employee details</h1>
        <p className="mt-1 text-sm text-slate-500">Upload a CSV exported from Excel. Employees are matched only by an exact employee code; no fuzzy name matching is used.</p>
      </div>

      <section className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-medium text-slate-900">1. Prepare your CSV</h2>
            <p className="text-sm text-slate-500">Use employee_code and any of the supported private-data columns. Blank cells are left unchanged.</p>
          </div>
          <button type="button" onClick={() => {
            const blob = new Blob([csvTemplate()], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href = url; a.download = "employee-private-import-template.csv"; a.click();
            URL.revokeObjectURL(url);
          }} className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">Download CSV template</button>
        </div>
        <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          Security: full Aadhaar numbers are not accepted or stored. Enter only the last 4 digits. Do not upload salary, UAN or ESIC columns here. Salary requires verified salary type and monthly amount; statutory IDs are handled separately.
        </div>
        <label className="block text-sm font-medium text-slate-700">
          Choose CSV file
          <input type="file" accept=".csv,text/csv" onChange={(e) => void readFile(e.target.files?.[0])} className="mt-1 block w-full rounded-md border border-slate-300 p-2 text-sm" />
        </label>
        {fileName && <p className="text-xs text-slate-500">Loaded: {fileName}</p>}
      </section>

      {rows.length > 0 && <section className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
        <div>
          <h2 className="font-medium text-slate-900">2. Review before saving</h2>
          <p className="text-sm text-slate-500">{rows.length} rows · {ready.length} ready · {blocked} skipped / needs correction. Sensitive field values are hidden in this preview.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50"><tr><th className={th}>CSV row</th><th className={th}>Employee</th><th className={th}>Code</th><th className={th}>Fields supplied</th><th className={th}>Status</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => <tr key={r.line}>
                <td className="px-3 py-2">{r.line}</td>
                <td className="px-3 py-2">{r.employee?.name ?? r.name ?? "—"}</td>
                <td className="px-3 py-2">{r.employeeCode || "—"}</td>
                <td className="px-3 py-2">{PRIVATE_FIELDS.filter((key) => r.values[key]).length}</td>
                <td className="px-3 py-2">{r.issue ? <span className="text-amber-700">{r.issue}</span> : <span className="text-emerald-700">Ready</span>}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={!ready.length || loading} onClick={() => void importRows()} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{loading ? "Importing…" : `Import ${ready.length} matched employees`}</button>
          <button type="button" disabled={loading} onClick={() => { setRows([]); setFileName(""); setResult(null); }} className="rounded-md border border-slate-300 px-3 py-2 text-sm">Clear preview</button>
        </div>
      </section>}

      {result && <p className="rounded-md border border-slate-200 bg-white p-3 text-sm">Import finished: <strong>{result.saved}</strong> saved, <strong>{result.failed}</strong> failed. Failed rows can be retried after checking the employee details.</p>}
      {error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    </div>
  );
}
