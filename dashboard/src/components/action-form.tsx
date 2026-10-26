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
