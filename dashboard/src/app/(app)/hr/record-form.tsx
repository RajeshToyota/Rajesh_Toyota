"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export type RecordInput = {
  key: string;
  label: string;
  type?: "text" | "date" | "email" | "tel" | "textarea";
  options?: { id: string; name: string }[];
  required?: boolean;
};

// A labelled two-column form posting every input (blank included, so a field can be cleared) to a
// server action. With redirectPrefix, the page moves to prefix + the action's result (a new record).
export function RecordForm({
  inputs,
  initial,
  hidden,
  action,
  submitLabel,
  redirectPrefix,
}: {
  inputs: RecordInput[];
  initial: Record<string, string>;
  hidden: Record<string, string>;
  action: (fd: FormData) => Promise<unknown>;
  submitLabel: string;
  redirectPrefix?: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const missing = inputs.some((i) => i.required && !values[i.key]?.trim());
  const set = (key: string, value: string) => {
    setSaved(false);
    setValues((v) => ({ ...v, [key]: value }));
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    for (const [k, v] of Object.entries(hidden)) fd.set(k, v);
    for (const i of inputs) fd.set(i.key, values[i.key] ?? "");
    setError(null);
    startTransition(async () => {
      try {
        const result = await action(fd);
        if (redirectPrefix) router.push(`${redirectPrefix}${result}`);
        else setSaved(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save");
      }
    });
  }

  const box = "mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5";
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {inputs.map((i) => (
          <label key={i.key} className={`block text-sm ${i.type === "textarea" ? "sm:col-span-2" : ""}`}>
            <span className="text-slate-600">
              {i.label}
              {i.required && " *"}
            </span>
            {i.options ? (
              <select value={values[i.key] ?? ""} onChange={(e) => set(i.key, e.target.value)} className={box}>
                <option value="">—</option>
                {i.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            ) : i.type === "textarea" ? (
              <textarea value={values[i.key] ?? ""} onChange={(e) => set(i.key, e.target.value)} rows={2} className={box} />
            ) : (
              <input type={i.type ?? "text"} value={values[i.key] ?? ""} onChange={(e) => set(i.key, e.target.value)} className={box} />
            )}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || missing}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
        {saved && <span className="text-sm text-emerald-700">Saved</span>}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
