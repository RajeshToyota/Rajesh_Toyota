"use client";

import { useState, useTransition } from "react";

export type Field =
  | { name: string; placeholder: string; type?: "text" | "date" | "number"; required?: boolean; width?: string; initial?: string }
  | { name: string; placeholder: string; options: { id: string; name: string }[]; required?: boolean; width?: string };

// A small inline form for one stock action: hidden ids, optional inputs, a button, and the
// database's refusal shown under it.
export function ActionForm({
  action,
  hidden,
  fields = [],
  label,
  tone = "dark",
  confirm,
}: {
  action: (fd: FormData) => Promise<void>;
  hidden: Record<string, string>;
  fields?: Field[];
  label: string;
  tone?: "dark" | "light" | "danger";
  confirm?: string;
}) {
  const initial = () =>
    Object.fromEntries(fields.flatMap((f) => ("initial" in f && f.initial ? [[f.name, f.initial]] : [])));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const missing = fields.some((f) => f.required && !values[f.name]?.trim());

  function submit() {
    if (confirm && !window.confirm(confirm)) return;
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...hidden, ...values })) if (v) fd.set(k, v);
    setError(null);
    startTransition(async () => {
      try {
        await action(fd);
        setValues(initial());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  }

  const styles = {
    dark: "bg-slate-900 text-white hover:bg-slate-800",
    light: "border border-slate-300 text-slate-700 hover:bg-slate-100",
    danger: "border border-red-300 text-red-700 hover:bg-red-50",
  }[tone];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {fields.map((f) =>
          "options" in f ? (
            <select
              key={f.name}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              className={`rounded-md border border-slate-300 px-2 py-1 text-xs ${f.width ?? "w-48"}`}
            >
              <option value="">{f.placeholder}</option>
              {f.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              key={f.name}
              type={f.type ?? "text"}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              placeholder={f.placeholder}
              className={`rounded-md border border-slate-300 px-2 py-1 text-xs ${f.width ?? "w-48"}`}
            />
          ),
        )}
        <button
          disabled={pending || missing}
          onClick={submit}
          className={`rounded-md px-2 py-1 text-xs font-medium disabled:opacity-50 ${styles}`}
        >
          {pending ? "…" : label}
        </button>
      </div>
      {error && <p className="max-w-md text-xs text-red-600">{error}</p>}
    </div>
  );
}

// Proposals with tick boxes, confirmed together.
export function ProposalList({
  action,
  method,
  rows,
  columns,
}: {
  action: (fd: FormData) => Promise<void>;
  method: "fifo" | "ctdms";
  rows: { key: string; cells: React.ReactNode[] }[];
  columns: string[];
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(rows.map((r) => r.key)));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toggle = (k: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  function submit() {
    const fd = new FormData();
    fd.set("method", method);
    for (const k of picked) fd.append("pair", k);
    setError(null);
    startTransition(async () => {
      try {
        await action(fd);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  }

  if (rows.length === 0) return <p className="px-3 py-4 text-sm text-slate-400">Nothing to propose right now.</p>;
  return (
    <div>
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="w-8 px-3 py-2" />
            {columns.map((c) => (
              <th key={c} className="px-3 py-2 text-left font-medium text-slate-600">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="px-3 py-2">
                <input type="checkbox" checked={picked.has(r.key)} onChange={() => toggle(r.key)} />
              </td>
              {r.cells.map((c, i) => (
                <td key={i} className="px-3 py-2">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-3 border-t border-slate-100 px-3 py-2">
        <button
          disabled={pending || picked.size === 0}
          onClick={submit}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "Allotting…" : `Allot ${picked.size} selected`}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
