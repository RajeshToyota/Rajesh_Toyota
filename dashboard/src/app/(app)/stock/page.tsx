import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { Card, ageDays, isAccounts, isBackOffice, one } from "./shared";
import { StockTable, type ModelGroup } from "./stock-table";

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
        "ctdms_block_status, ctdms_order_status, missing_from_report, variants(name, models(name)), colors(name), outlets(name)",
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

  // model -> variant/colour -> cars (already oldest first from the query), shaped for the table.
  const tree = new Map<string, Map<string, Vehicle[]>>();
  for (const v of shown) {
    const model = modelOf(v);
    const key = `${v.variants?.name ?? v.ctdms_suffix_code ?? "?"}|${v.colors?.name ?? v.ext_color_desc ?? "?"}`;
    const byKey = tree.get(model) ?? new Map<string, Vehicle[]>();
    byKey.set(key, [...(byKey.get(key) ?? []), v]);
    tree.set(model, byKey);
  }
  const groups: ModelGroup[] = [...tree.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([model, byKey]) => ({
      model,
      variants: [...byKey.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, cars]) => {
          const [variant, color] = key.split("|");
          const first = cars[0];
          return {
            key,
            variant,
            color,
            flag: !first.variants
              ? { tone: "red" as const, text: `Suffix ${first.ctdms_suffix_code} not in master` }
              : !first.colors
                ? { tone: "amber" as const, text: "Colour to map" }
                : null,
            cars: cars.map((v) => ({
              id: v.id,
              vin: v.vin,
              transit: v.source === "transit",
              age: ageDays(v),
              branch: v.outlets?.name ?? null,
              block: v.ctdms_block_status && v.ctdms_block_status !== "Free" ? v.ctdms_block_status : null,
            })),
          };
        }),
    }));

  const old = shown.filter((v) => (ageDays(v) ?? 0) > 60).length;

  const href = (next: { source?: string; model?: string | null }) => {
    const q = new URLSearchParams();
    const source = next.source !== undefined ? next.source : (params.source ?? "");
    const model = next.model !== undefined ? next.model : selectedModel;
    if (source) q.set("source", source);
    if (model) q.set("model", model);
    const qs = q.toString();
    return qs ? `/stock?${qs}` : "/stock";
  };
  const pill = (active: boolean) => `rounded-full px-2 py-0.5 ${active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-sm">
        <span>
          <b>{shown.filter((v) => v.source === "physical").length}</b> in the yard · <b>{shown.filter((v) => v.source === "transit").length}</b>{" "}
          in transit · <b>{old}</b> over 60 days
        </span>
        <span className="flex gap-2 text-xs">
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

      <div className="mb-4 flex flex-wrap gap-2 text-xs">
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
        <StockTable groups={groups} expandAll={!!selectedModel} />
      </Card>
    </div>
  );
}
