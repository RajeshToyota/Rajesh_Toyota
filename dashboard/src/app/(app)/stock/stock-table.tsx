"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { Chip, Th } from "./shared";

export type StockCar = { id: string; vin: string; transit: boolean; age: number | null; branch: string | null; block: string | null };
export type VariantGroup = {
  key: string;
  variant: string;
  color: string;
  flag: { tone: "red" | "amber"; text: string } | null;
  cars: StockCar[];
};
export type ModelGroup = { model: string; variants: VariantGroup[] };

const OLD_DAYS = 60;

function totals(cars: StockCar[]) {
  const ages = cars.map((c) => c.age).filter((a): a is number => a != null);
  return {
    total: cars.length,
    yard: cars.filter((c) => !c.transit).length,
    transit: cars.filter((c) => c.transit).length,
    old: ages.filter((a) => a > OLD_DAYS).length,
    oldest: ages.length ? Math.max(...ages) : null,
  };
}

// One table that drills down: model row > variant · colour rows > one row per car.
export function StockTable({ groups, expandAll }: { groups: ModelGroup[]; expandAll: boolean }) {
  const [openModels, setOpenModels] = useState<Set<string>>(() => new Set(expandAll ? groups.map((g) => g.model) : []));
  const [openVariants, setOpenVariants] = useState<Set<string>>(() => new Set());
  const flip = (set: Set<string>, k: string) => {
    const n = new Set(set);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  };

  return (
    <table className="min-w-full divide-y divide-slate-200 text-sm">
      <thead className="bg-slate-50">
        <tr>
          <Th>Model / variant / colour / VIN</Th>
          <Th right>Cars</Th>
          <Th right>Yard</Th>
          <Th right>Transit</Th>
          <Th right>Over 60d</Th>
          <Th right>Oldest / age (days)</Th>
          <Th>Branch</Th>
          <Th>CTDMS</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {groups.length === 0 && (
          <tr>
            <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
              No free stock. Import the CTDMS stock statements under Import.
            </td>
          </tr>
        )}
        {groups.map((g) => {
          const modelOpen = openModels.has(g.model);
          const t = totals(g.variants.flatMap((v) => v.cars));
          return (
            <Fragment key={g.model}>
              <tr
                onClick={() => setOpenModels((s) => flip(s, g.model))}
                className={`cursor-pointer border-t-2 border-slate-200 ${modelOpen ? "bg-slate-100" : "hover:bg-slate-50"}`}
              >
                <td className="px-3 py-2 font-semibold text-slate-900">
                  <Caret open={modelOpen} /> {g.model} <span className="text-xs font-normal text-slate-400">({g.variants.length} variant/colour)</span>
                </td>
                <Counts t={t} bold />
                <td colSpan={2} />
              </tr>

              {modelOpen &&
                g.variants.map((v) => {
                  const vk = `${g.model}|${v.key}`;
                  const variantOpen = openVariants.has(vk);
                  const vt = totals(v.cars);
                  return (
                    <Fragment key={vk}>
                      <tr onClick={() => setOpenVariants((s) => flip(s, vk))} className={`cursor-pointer ${variantOpen ? "bg-slate-50" : "hover:bg-slate-50"}`}>
                        <td className="py-1.5 pl-8 pr-3">
                          <Caret open={variantOpen} /> {v.variant} · <span className="text-slate-600">{v.color}</span>
                          {v.flag && (
                            <>
                              {" "}
                              <Chip tone={v.flag.tone}>{v.flag.text}</Chip>
                            </>
                          )}
                        </td>
                        <Counts t={vt} />
                        <td colSpan={2} />
                      </tr>

                      {variantOpen &&
                        v.cars.map((c) => (
                          <tr key={c.id} className="bg-white">
                            <td className="py-1.5 pl-14 pr-3 font-mono text-xs">
                              <Link href={`/stock/vehicle/${c.id}`} className="underline">
                                {c.vin}
                              </Link>
                            </td>
                            <td />
                            <td className="px-3 py-1.5 text-right">{c.transit ? "" : "Yard"}</td>
                            <td className="px-3 py-1.5 text-right">{c.transit ? <Chip tone="blue">In transit</Chip> : ""}</td>
                            <td />
                            <td className={`px-3 py-1.5 text-right ${(c.age ?? 0) > OLD_DAYS ? "font-semibold text-red-700" : ""}`}>{c.age ?? "—"}</td>
                            <td className="px-3 py-1.5">{c.branch ?? "—"}</td>
                            <td className="px-3 py-1.5">{c.block ? <Chip tone="amber">{c.block}</Chip> : "Free"}</td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function Caret({ open }: { open: boolean }) {
  return <span className={`inline-block w-3 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>;
}

function Counts({ t, bold }: { t: ReturnType<typeof totals>; bold?: boolean }) {
  return (
    <>
      <td className={`px-3 py-1.5 text-right ${bold ? "font-semibold" : ""}`}>{t.total}</td>
      <td className="px-3 py-1.5 text-right">{t.yard}</td>
      <td className="px-3 py-1.5 text-right">{t.transit}</td>
      <td className={`px-3 py-1.5 text-right ${t.old > 0 ? "font-semibold text-red-700" : "text-slate-400"}`}>{t.old}</td>
      <td className={`px-3 py-1.5 text-right ${(t.oldest ?? 0) > OLD_DAYS ? "text-red-700" : ""}`}>{t.oldest ?? "—"}</td>
    </>
  );
}
