import { useState, useTransition, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase/client";
import { refreshPages } from "@/compat/refresh";

export { ActionForm, type Field } from "@/components/action-form";

// ---------- data ----------

// Calls a database function; throws its message on refusal and reloads the pages on screen.
export async function rpc<T = unknown>(name: string, args: Record<string, unknown> = {}, opts: { refresh?: boolean } = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  if (opts.refresh !== false) refreshPages();
  return data as T;
}

// Reads rows from a database function without refreshing anything.
export async function rpcRows<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) {
  return (await rpc<T[]>(name, args, { refresh: false })) ?? [];
}

// FormData -> trimmed string or null, for ActionForm handlers.
export const str = (fd: FormData, key: string) => {
  const v = (fd.get(key) as string | null)?.trim();
  return v ? v : null;
};
export const num = (fd: FormData, key: string) => {
  const v = str(fd, key);
  return v == null ? null : Number(v);
};

// ---------- formatting ----------

export const inr = (n: number | string | null | undefined) =>
  n == null || n === "" ? "—" : `₹${Math.round(Number(n)).toLocaleString("en-IN")}`;
export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-IN") : "—");
export const fmtDateTime = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
export const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
export const monthIst = () => todayIst().slice(0, 7);
export const titleCase = (s: string | null | undefined) =>
  (s ?? "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// ---------- layout ----------

export function PageHeader({ title, note, actions }: { title: string; note?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        {note && <p className="mt-0.5 text-sm text-slate-500">{note}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, note, aside, children }: { title?: ReactNode; note?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-4 rounded-md border border-slate-200 bg-white">
      {(title || aside) && (
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-3 py-2">
          <div>
            {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
            {note && <p className="text-xs text-slate-500">{note}</p>}
          </div>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Tabs({ tabs, current, onChange }: { tabs: { id: string; label: ReactNode }[]; current: string; onChange: (id: string) => void }) {
  return (
    <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`-mb-px rounded-t-md border-b-2 px-3 py-1.5 text-sm ${
            current === t.id ? "border-slate-900 font-medium text-slate-900" : "border-transparent text-slate-500 hover:bg-slate-100"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function LinkTabs({ tabs, current }: { tabs: { href: string; label: ReactNode }[]; current: string }) {
  return (
    <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <Link
          key={t.href}
          to={t.href}
          className={`-mb-px rounded-t-md border-b-2 px-3 py-1.5 text-sm ${
            current === t.href ? "border-slate-900 font-medium text-slate-900" : "border-transparent text-slate-500 hover:bg-slate-100"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

// ---------- tables ----------

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, right, muted, className = "" }: { children?: ReactNode; right?: boolean; muted?: boolean; className?: string }) {
  return (
    <td className={`px-3 py-2 align-top ${right ? "text-right tabular-nums" : ""} ${muted ? "text-slate-500" : "text-slate-800"} ${className}`}>
      {children}
    </td>
  );
}

export function EmptyRow({ cols, text }: { cols: number; text: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-6 text-center text-sm text-slate-400">
        {text}
      </td>
    </tr>
  );
}

const chipTones = {
  slate: "bg-slate-100 text-slate-700",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-700",
  emerald: "bg-emerald-100 text-emerald-800",
  blue: "bg-blue-100 text-blue-800",
} as const;
export type Tone = keyof typeof chipTones;

export function Chip({ children, tone = "slate" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${chipTones[tone]}`}>{children}</span>;
}

export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-xl font-semibold ${tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-700" : "text-slate-900"}`}>
        {value}
      </p>
      {note && <p className="text-xs text-slate-400">{note}</p>}
    </div>
  );
}

// ---------- states ----------

export function Loading() {
  return <p className="py-10 text-center text-sm text-slate-400">Loading…</p>;
}

export function ErrorBox({ message }: { message: string }) {
  return <p className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{message}</p>;
}

// Renders loading / error / content for a useQuery result.
export function Loaded<T>({ q, children }: { q: { data: T | null; error: string | null; loading: boolean }; children: (data: T) => ReactNode }) {
  if (q.error) return <ErrorBox message={q.error} />;
  if (q.data === null) return <Loading />;
  return <>{children(q.data)}</>;
}

// ---------- buttons ----------

// A button that runs an async action, asks first when `confirm` is given, and shows the refusal.
export function RunButton({
  run,
  label,
  tone = "dark",
  confirm,
  disabled,
}: {
  run: () => Promise<unknown>;
  label: ReactNode;
  tone?: "dark" | "light" | "danger";
  confirm?: string;
  disabled?: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const styles = {
    dark: "bg-slate-900 text-white hover:bg-slate-800",
    light: "border border-slate-300 text-slate-700 hover:bg-slate-100",
    danger: "border border-red-300 text-red-700 hover:bg-red-50",
  }[tone];
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        disabled={pending || disabled}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          setError(null);
          start(async () => {
            try {
              await run();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Something went wrong");
            }
          });
        }}
        className={`rounded-md px-2 py-1 text-xs font-medium disabled:opacity-50 ${styles}`}
      >
        {pending ? "…" : label}
      </button>
      {error && <span className="max-w-xs text-xs text-red-600">{error}</span>}
    </span>
  );
}

// ---------- inputs ----------

export const inputCls = "rounded-md border border-slate-300 px-2 py-1 text-sm";

export function Select({
  value,
  onChange,
  options,
  placeholder,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; name: string }[];
  placeholder?: string;
  className?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputCls} ${className}`}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}
