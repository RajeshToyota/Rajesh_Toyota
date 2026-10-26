import Link from "next/link";
import { PRESETS, fmtDay } from "@/lib/pipeline";

// The period + branch filter shared by the pipeline pages. Plain GET form: the choice lives in the URL.
export function PeriodBar({
  outlets,
  period,
  extra,
}: {
  outlets: { id: string; name: string }[];
  period: { preset: string; from: string; to: string; outletId: string | null };
  extra?: React.ReactNode;
}) {
  return (
    <form className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-white p-3">
      <label className="text-xs font-medium text-slate-500">
        Period
        <select name="period" defaultValue={period.preset} className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900">
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-medium text-slate-500">
        From (custom)
        <input type="date" name="from" defaultValue={period.preset === "custom" ? period.from : ""} className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
      </label>
      <label className="text-xs font-medium text-slate-500">
        To (custom)
        <input type="date" name="to" defaultValue={period.preset === "custom" ? period.to : ""} className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
      </label>
      <label className="text-xs font-medium text-slate-500">
        Branch
        <select name="outlet_id" defaultValue={period.outletId ?? ""} className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900">
          <option value="">All branches I can see</option>
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      {extra}
      <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800">
        Show
      </button>
      <p className="w-full text-xs text-slate-500">
        {fmtDay(period.from)} – {fmtDay(period.to)}
      </p>
    </form>
  );
}

export function StatTile({ label, value, note, href }: { label: string; value: string | number; note?: string; href?: string }) {
  const body = (
    <>
      <p className="text-2xl font-semibold text-slate-900">{value}</p>
      <p className="mt-1 text-sm text-slate-600">{label}</p>
      {note && <p className="mt-0.5 text-xs text-slate-500">{note}</p>}
    </>
  );
  const cls = "block rounded-lg border border-slate-200 bg-white p-4";
  return href ? (
    <Link href={href} className={`${cls} hover:border-slate-400`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

// One-series horizontal bars: one hue, value printed in text ink beside each bar, native tooltip on hover.
export function Bars({
  rows,
  max,
}: {
  rows: { label: string; value: number; note?: string; href?: string }[];
  max?: number;
}) {
  const top = Math.max(max ?? 0, ...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => {
        const width = r.value > 0 ? Math.max((r.value / top) * 100, 1.5) : 0;
        const tip = `${r.label}: ${r.value.toLocaleString("en-IN")}${r.note ? ` (${r.note})` : ""}`;
        const label = r.href ? (
          <Link href={r.href} className="underline decoration-slate-300 hover:decoration-slate-600">
            {r.label}
          </Link>
        ) : (
          r.label
        );
        return (
          <li key={r.label} title={tip} className="grid grid-cols-1 gap-0.5 text-sm sm:grid-cols-[minmax(7rem,11rem)_1fr] sm:items-center sm:gap-3">
            <span className="truncate text-slate-700">{label}</span>
            <span className="flex items-center gap-2">
              <span className="h-4 flex-1">
                {width > 0 && <span className="block h-4 rounded-r bg-[#2a78d6]" style={{ width: `${width}%` }} />}
              </span>
              <span className="min-w-12 shrink-0 text-right tabular-nums text-slate-900">
                {r.value.toLocaleString("en-IN")}
                {r.note && <span className="ml-1 text-xs text-slate-500">{r.note}</span>}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function Panel({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
