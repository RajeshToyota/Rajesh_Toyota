"use client";

import { useState, useTransition } from "react";

export { ActionForm, type Field } from "@/components/action-form";

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
