import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { Card, Chip, Th, ageDays, inr, isAccounts, isBackOffice, one } from "./shared";

type Named = { name: string };
type Vehicle = {
  id: string;
  vin: string;
  source: "transit" | "physical";
  ctdms_suffix_code: string | null;
  ext_color_desc: string | null;
  ctdms_model: string | null;
  days_since_invoice: number | null;
  tkm_invoice_date: string | null;
  tkm_invoice_amount: number | null;
  interest_amount: number | null;
  ctdms_block_status: string | null;
  ctdms_order_status: string | null;
  missing_from_report: boolean;
  variants: (Named & { models: Named | Named[] | null }) | null;
  colors: Named | null;
  outlets: Named | null;
};

// Unallotted cars, drilled down model -> variant/colour -> VIN, oldest first so ageing stock moves first.
export default async function FreeStockPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const employee = await getCurrentEmployee();
  if (isAccounts(employee)) {
    return <p className="text-sm text-slate-600">Accounts works the <Link href="/stock/billing" className="underline">billing queue</Link>.</p>;
  }

  let query = supabase
    .from("vehicles")
    .select(
      "id, vin, source, ctdms_suffix_code, ext_color_desc, ctdms_model, days_since_invoice, tkm_invoice_date, tkm_invoice_amount, " +
        "interest_amount, ctdms_block_status, ctdms_order_status, missing_from_report, variants(name, models(name)), colors(name), outlets(name)",
    )
    .eq("status", "available")
    .order("tkm_invoice_date", { ascending: true, nullsFirst: false })
    .limit(2000);
  if (params.source === "transit" || params.source === "physical") query = query.eq("source", params.source);
  const { data } = await query;
  const all = (data ?? []) as unknown as Vehicle[];
  const free = all.filter((v) => !v.missing_from_report && v.ctdms_order_status !== "Invoiced");
  const hidden = all.length - free.length;

  const modelOf = (v: Vehicle) => one(v.variants?.models ?? null)?.name ?? v.ctdms_model ?? "Not in master data";

  // Model chips are counted before the model filter so every model stays visible.
  const modelCounts = new Map<string, number>();
  for (const v of free) modelCounts.set(modelOf(v), (modelCounts.get(modelOf(v)) ?? 0) + 1);
  const models = [...modelCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const selectedModel = params.model && modelCounts.has(params.model) ? params.model : null;
  const shown = selectedModel ? free.filter((v) => modelOf(v) === selectedModel) : free;

  // model -> "variant|colour" -> cars (already oldest first from the query).
  const tree = new Map<string, Map<string, Vehicle[]>>();
  for (const v of shown) {
    const model = modelOf(v);
    const key = `${v.variants?.name ?? v.ctdms_suffix_code ?? "?"}|${v.colors?.name ?? v.ext_color_desc ?? "?"}`;
    const byKey = tree.get(model) ?? new Map<string, Vehicle[]>();
    byKey.set(key, [...(byKey.get(key) ?? []), v]);
    tree.set(model, byKey);
  }
  const sortedModels = [...tree.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const interest = shown.reduce((s, v) => s + Number(v.interest_amount ?? 0), 0);
  const old = shown.filter((v) => (ageDays(v) ?? 0) > 60).length;

  const href = (next: { source?: string; model?: string | null }) => {
    const q = new URLSearchParams();
    const source = next.source !== undefined ? next.source : (params.source ?? "");
    const model = next.model !== undefined ? next.model : selectedModel;
    if (source) q.set("source", source);
    if (model) q.set("model", model);
    const s = q.toString();
    return s ? `/stock?${s}` : "/stock";
  };
  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs font-medium ${
      active ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
    }`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-sm">
        <span>
          <b>{shown.filter((v) => v.source === "physical").length}</b> in the yard · <b>{shown.filter((v) => v.source === "transit").length}</b>{" "}
          in transit · <b>{old}</b> over 60 days · interest so far {inr(interest)}
        </span>
        <span className="flex gap-2">
          {[
            ["", "All"],
            ["physical", "Yard"],
            ["transit", "Transit"],
          ].map(([id, label]) => (
            <Link key={id} href={href({ source: id })} className={pill((params.source ?? "") === id)}>
              {label}
            </Link>
          ))}
        </span>
        {hidden > 0 && (
          <span className="text-xs text-slate-500">
            {hidden} not shown: invoiced in CTDMS or missing from the latest report
            {isBackOffice(employee) && (
              <>
                {" "}
                (<Link href="/stock/ctdms" className="underline">CTDMS To-do</Link>)
              </>
            )}
          </span>
        )}
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href={href({ model: null })} className={pill(!selectedModel)}>
          All models ({free.length})
        </Link>
        {models.map(([m, n]) => (
          <Link key={m} href={href({ model: m })} className={pill(selectedModel === m)}>
            {m} ({n})
          </Link>
        ))}
      </div>

      <Card title="Free stock" note="Click a model to see its variants, then a variant to see each car. Oldest first. Ageing is counted from the TKM invoice date.">
        {sortedModels.length === 0 && <p className="px-3 py-6 text-center text-sm text-slate-400">No free stock. Import the CTDMS stock statements under Import.</p>}
        <div className="divide-y divide-slate-200">
          {sortedModels.map(([model, byKey]) => {
            const cars = [...byKey.values()].flat();
            const m = summary(cars);
            return (
              <details key={model} open={!!selectedModel || sortedModels.length === 1} className="group/model">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-6 gap-y-1 px-3 py-3 hover:bg-slate-50">
                  <span className="w-3 text-slate-400 transition-transform group-open/model:rotate-90">▸</span>
                  <span className="min-w-40 font-semibold text-slate-900">{model}</span>
                  <Stats s={m} />
                  <span className="text-xs text-slate-400">{byKey.size} variant/colour</span>
                </summary>

                <div className="border-t border-slate-100 bg-slate-50/60 pb-2 pl-6">
                  {[...byKey.entries()]
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([key, group]) => {
                      const [variant, color] = key.split("|");
                      const first = group[0];
                      return (
                        <details key={key} className="group/variant border-b border-slate-100 last:border-b-0">
                          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-6 gap-y-1 px-3 py-2 text-sm hover:bg-white">
                            <span className="w-3 text-slate-400 transition-transform group-open/variant:rotate-90">▸</span>
                            <span className="min-w-72">
                              {variant} · <span className="text-slate-600">{color}</span>
                              {!first.variants && (
                                <>
                                  {" "}
                                  <Chip tone="red">Suffix {first.ctdms_suffix_code} not in master</Chip>
                                </>
                              )}
                              {first.variants && !first.colors && (
                                <>
                                  {" "}
                                  <Chip tone="amber">Colour to map</Chip>
                                </>
                              )}
                            </span>
                            <Stats s={summary(group)} />
                          </summary>
                          <div className="overflow-x-auto bg-white">
                            <table className="min-w-full divide-y divide-slate-200 text-sm">
                              <thead className="bg-slate-50">
                                <tr>
                                  <Th>VIN</Th>
                                  <Th>Where</Th>
                                  <Th right>Age (days)</Th>
                                  <Th right>Interest</Th>
                                  <Th>Branch</Th>
                                  <Th>CTDMS</Th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {group.map((v) => {
                                  const age = ageDays(v);
                                  return (
                                    <tr key={v.id}>
                                      <td className="px-3 py-1.5 font-mono text-xs">
                                        <Link href={`/stock/vehicle/${v.id}`} className="underline">
                                          {v.vin}
                                        </Link>
                                      </td>
                                      <td className="px-3 py-1.5">{v.source === "transit" ? <Chip tone="blue">In transit</Chip> : "Yard"}</td>
                                      <td className={`px-3 py-1.5 text-right ${(age ?? 0) > 60 ? "font-semibold text-red-700" : ""}`}>{age ?? "—"}</td>
                                      <td className="px-3 py-1.5 text-right">{inr(v.interest_amount)}</td>
                                      <td className="px-3 py-1.5">{v.outlets?.name ?? "—"}</td>
                                      <td className="px-3 py-1.5">
                                        {v.ctdms_block_status && v.ctdms_block_status !== "Free" ? <Chip tone="amber">{v.ctdms_block_status}</Chip> : "Free"}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </details>
                      );
                    })}
                </div>
              </details>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

type Summary = { total: number; yard: number; transit: number; old: number; oldest: number | null; interest: number };

function summary(cars: Vehicle[]): Summary {
  const ages = cars.map((v) => ageDays(v)).filter((a): a is number => a != null);
  return {
    total: cars.length,
    yard: cars.filter((v) => v.source === "physical").length,
    transit: cars.filter((v) => v.source === "transit").length,
    old: ages.filter((a) => a > 60).length,
    oldest: ages.length ? Math.max(...ages) : null,
    interest: cars.reduce((s, v) => s + Number(v.interest_amount ?? 0), 0),
  };
}

function Stats({ s }: { s: Summary }) {
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
      <span>
        <b className="text-sm text-slate-900">{s.total}</b> cars
      </span>
      <span>{s.yard} yard</span>
      <span>{s.transit} transit</span>
      <span className={s.old > 0 ? "font-semibold text-red-700" : ""}>{s.old} over 60d</span>
      <span>oldest {s.oldest ?? "—"}d</span>
      <span>{inr(s.interest)} interest</span>
    </span>
  );
}
