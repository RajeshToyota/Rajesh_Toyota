"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Chip, Th } from "./shared";

export type StockRow = {
  id: string;
  vin: string;
  suffix: string | null;
  model: string;
  variant: string;
  fuel: string | null;
  color: string;
  age: number | null;
  invoiceDate: string | null;
  transit: boolean;
  location: string | null;
  branch: string | null;
  block: string | null;
  flag: { tone: "red" | "amber"; text: string } | null;
};

const OLD_DAYS = 60;
const fmt = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-GB") : "—");

const countBy = (rows: StockRow[], key: (r: StockRow) => string) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
};

// Flat free-stock list, one row per chassis, filtered by model, fuel and yard/transit.
export function StockTable({ rows }: { rows: StockRow[] }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [model, setModel] = useState<string | null>(null);
  const [fuel, setFuel] = useState<string | null>(null);
  const [where, setWhere] = useState<"" | "yard" | "transit">("");

  const fuelOf = (r: StockRow) => r.fuel ?? "Unknown";
  const byWhere = useMemo(() => rows.filter((r) => !where || (where === "transit") === r.transit), [rows, where]);
  // Each chip row is counted with the other filter applied, so the numbers always add up.
  const models = countBy(byWhere.filter((r) => !fuel || fuelOf(r) === fuel), (r) => r.model);
  const fuels = countBy(byWhere.filter((r) => !model || r.model === model), fuelOf);
  const shown = byWhere.filter((r) => (!model || r.model === model) && (!fuel || fuelOf(r) === fuel));

  const yard = shown.filter((r) => !r.transit).length;
  const old = shown.filter((r) => (r.age ?? 0) > OLD_DAYS).length;

  function exportCsv() {
    const head = ["VIN", "Suffix", "Model", "Variant", "Fuel", "Colour", "Ageing (days)", "TKM invoice date", "Where", "Location", "Branch", "CTDMS"];
    const lines = shown.map((r) =>
      [r.vin, r.suffix, r.model, r.variant, r.fuel, r.color, r.age, r.invoiceDate, r.transit ? "Transit" : "Yard", r.location, r.branch, r.block ?? "Free"]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `free-stock-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100"}`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => startRefresh(() => router.refresh())}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <span className="flex gap-1.5">
          {(
            [
              ["", `All (${rows.length})`],
              ["yard", `Yard (${rows.filter((r) => !r.transit).length})`],
              ["transit", `Transit (${rows.filter((r) => r.transit).length})`],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setWhere(id)} className={pill(where === id)}>
              {label}
            </button>
          ))}
        </span>
        <span className="ml-auto flex items-center gap-3 text-sm text-slate-600">
          <span>
            <b className="text-slate-900">{shown.length}</b> rows · {yard} yard · {shown.length - yard} transit ·{" "}
            <span className={old ? "font-semibold text-red-700" : ""}>{old} over 60 days</span>
          </span>
          <button type="button" onClick={exportCsv} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            Export CSV
          </button>
        </span>
      </div>

      <div className="mb-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => setModel(null)} className={pill(!model)}>
          All models ({models.reduce((s, [, n]) => s + n, 0)})
        </button>
        {models.map(([m, n]) => (
          <button key={m} type="button" onClick={() => setModel(model === m ? null : m)} className={pill(model === m)}>
            {m} ({n})
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => setFuel(null)} className={pill(!fuel)}>
          All fuel types ({fuels.reduce((s, [, n]) => s + n, 0)})
        </button>
        {fuels.map(([f, n]) => (
          <button key={f} type="button" onClick={() => setFuel(fuel === f ? null : f)} className={pill(fuel === f)}>
            {f.toUpperCase()} ({n})
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>VIN</Th>
              <Th>Suffix</Th>
              <Th>Model</Th>
              <Th>Variant</Th>
              <Th>Fuel</Th>
              <Th>Colour</Th>
              <Th right>Ageing</Th>
              <Th>TKM invoice date</Th>
              <Th>Where</Th>
              <Th>Location</Th>
              <Th>Branch</Th>
              <Th>CTDMS</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.length === 0 && (
              <tr>
                <td colSpan={12} className="px-3 py-6 text-center text-slate-400">
                  {rows.length === 0 ? "No free stock. Import the CTDMS stock statements under Import." : "No cars match these filters."}
                </td>
              </tr>
            )}
            {shown.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs">
                  <Link href={`/stock/vehicle/${r.id}`} className="underline">
                    {r.vin}
                  </Link>
                </td>
                <td className="px-3 py-1.5 font-mono text-xs">{r.suffix ?? "—"}</td>
                <td className="whitespace-nowrap px-3 py-1.5">{r.model}</td>
                <td className="px-3 py-1.5">
                  {r.variant}
                  {r.flag && (
                    <>
                      {" "}
                      <Chip tone={r.flag.tone}>{r.flag.text}</Chip>
                    </>
                  )}
                </td>
                <td className="px-3 py-1.5 text-xs">{r.fuel?.toUpperCase() ?? "—"}</td>
                <td className="px-3 py-1.5">{r.color}</td>
                <td className={`whitespace-nowrap px-3 py-1.5 text-right ${(r.age ?? 0) > OLD_DAYS ? "font-semibold text-red-700" : ""}`}>
                  {r.age == null ? "—" : `${r.age} days`}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5">{fmt(r.invoiceDate)}</td>
                <td className="px-3 py-1.5">{r.transit ? <Chip tone="blue">In transit</Chip> : "Yard"}</td>
                <td className="px-3 py-1.5">{r.location ?? "—"}</td>
                <td className="px-3 py-1.5">{r.branch ?? "—"}</td>
                <td className="px-3 py-1.5">{r.block ? <Chip tone="amber">{r.block}</Chip> : "Free"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
