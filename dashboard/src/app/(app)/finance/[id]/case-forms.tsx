"use client";

import { useState, useTransition } from "react";
import { moveFinanceCase, updateFinanceCase } from "../actions";

type Values = Record<string, string>;

function useAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const run = (action: (fd: FormData) => Promise<void>, fields: Values) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v) fd.set(k, v);
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        await action(fd);
        setSaved(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  };
  return { pending, error, saved, run };
}

const GROUPS: { title: string; fields: { key: string; label: string; type?: "number" | "date" | "text" }[] }[] = [
  {
    title: "Login",
    fields: [
      { key: "application_no", label: "Application no." },
      { key: "login_date", label: "Login date", type: "date" },
    ],
  },
  {
    title: "Sanction",
    fields: [
      { key: "loan_amount", label: "Loan amount ₹", type: "number" },
      { key: "tenure_months", label: "Tenure (months)", type: "number" },
      { key: "roi_percent", label: "Rate of interest %", type: "number" },
      { key: "advance_emis", label: "Advance EMIs", type: "number" },
      { key: "processing_fee", label: "Processing fee ₹", type: "number" },
      { key: "sanction_date", label: "Sanction date", type: "date" },
    ],
  },
  {
    title: "Delivery order",
    fields: [
      { key: "do_number", label: "DO number" },
      { key: "do_amount", label: "DO amount ₹", type: "number" },
      { key: "do_date", label: "DO date", type: "date" },
    ],
  },
  {
    title: "Disbursement",
    fields: [
      { key: "disbursed_amount", label: "Disbursed amount ₹", type: "number" },
      { key: "disbursed_date", label: "Disbursed date", type: "date" },
    ],
  },
];

// Terms, DO and disbursement details. Saved fields stay as they are when left blank.
export function TermsForm({
  caseId,
  initial,
  financiers,
  disabled,
}: {
  caseId: string;
  initial: Values;
  financiers: { id: string; name: string }[];
  disabled: boolean;
}) {
  const [values, setValues] = useState<Values>(initial);
  const { pending, error, saved, run } = useAction();
  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));

  return (
    <div className="space-y-4">
      <label className="block text-sm">
        <span className="text-slate-600">Financier</span>
        <select
          disabled={disabled}
          value={values.financier_id ?? ""}
          onChange={(e) => set("financier_id", e.target.value)}
          className="mt-1 block w-72 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        >
          {financiers.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      {GROUPS.map((g) => (
        <fieldset key={g.title}>
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{g.title}</legend>
          <div className="flex flex-wrap gap-3">
            {g.fields.map((f) => (
              <label key={f.key} className="text-sm">
                <span className="text-slate-600">{f.label}</span>
                <input
                  disabled={disabled}
                  type={f.type ?? "text"}
                  step={f.type === "number" ? "any" : undefined}
                  value={values[f.key] ?? ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  className="mt-1 block w-44 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                />
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <label className="block text-sm">
        <span className="text-slate-600">Notes</span>
        <textarea
          disabled={disabled}
          value={values.notes ?? ""}
          onChange={(e) => set("notes", e.target.value)}
          className="mt-1 block w-full max-w-xl rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
      </label>
      {!disabled && (
        <div className="flex items-center gap-3">
          <button
            disabled={pending}
            onClick={() => run(updateFinanceCase, { ...values, case_id: caseId })}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save details"}
          </button>
          {saved && !error && <span className="text-sm text-emerald-700">Saved</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      )}
    </div>
  );
}

export function StageActions({ caseId, next, nextLabel }: { caseId: string; next: string | null; nextLabel: string | null }) {
  const [note, setNote] = useState("");
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-2">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (needed for a rejection)"
        className="w-80 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
      />
      <div className="flex gap-2">
        {next && (
          <button
            disabled={pending}
            onClick={() => run(moveFinanceCase, { case_id: caseId, status: next, note })}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Move to {nextLabel}
          </button>
        )}
        <button
          disabled={pending || !note.trim()}
          onClick={() => {
            if (window.confirm("Mark this case rejected by the financier? A new case can then be opened.")) {
              run(moveFinanceCase, { case_id: caseId, status: "rejected", note });
            }
          }}
          className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          Rejected by financier
        </button>
      </div>
      {error && <p className="max-w-xl text-sm text-red-600">{error}</p>}
    </div>
  );
}
