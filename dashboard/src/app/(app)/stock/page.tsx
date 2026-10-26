import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { Card, Chip, Empty, Th, ageDays, inr, isAccounts, isBackOffice, one } from "./shared";

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

// Unallotted cars, grouped model -> variant -> colour, oldest first so ageing stock moves first.
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

  const groups = new Map<string, Vehicle[]>();
  for (const v of free) {
    const model = one(v.variants?.models ?? null)?.name ?? v.ctdms_model ?? "Not in master data";
    const key = `${model}|${v.variants?.name ?? v.ctdms_suffix_code ?? "?"}|${v.colors?.name ?? v.ext_color_desc ?? "?"}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const interest = free.reduce((s, v) => s + Number(v.interest_amount ?? 0), 0);
  const old = free.filter((v) => (ageDays(v) ?? 0) > 60).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
        <span>
          <b>{free.filter((v) => v.source === "physical").length}</b> in the yard · <b>{free.filter((v) => v.source === "transit").length}</b>{" "}
          in transit · <b>{old}</b> over 60 days · interest so far {inr(interest)}
        </span>
        <span className="flex gap-2 text-xs">
          {[
            ["", "All"],
            ["physical", "Yard"],
            ["transit", "Transit"],
          ].map(([id, label]) => (
            <Link
              key={id}
              href={id ? `/stock?source=${id}` : "/stock"}
              className={`rounded-full px-2 py-0.5 ${(params.source ?? "") === id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`}
            >
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

      <Card title="Free stock" note="Oldest first within each group. Ageing is counted from the TKM invoice date.">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Model / variant / colour</Th>
              <Th>VIN</Th>
              <Th>Where</Th>
              <Th right>Age (days)</Th>
              <Th right>Interest</Th>
              <Th>Branch</Th>
              <Th>CTDMS</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.length === 0 && <Empty cols={7} text="No free stock. Import the CTDMS stock statements under Import." />}
            {sorted.map(([key, cars]) =>
              cars.map((v, i) => {
                const [model, variant, color] = key.split("|");
                const age = ageDays(v);
                return (
                  <tr key={v.id} className={i === 0 ? "border-t-2 border-slate-200" : ""}>
                    <td className="px-3 py-1.5">
                      {i === 0 ? (
                        <span>
                          <b>{model}</b> · {variant} · {color} <span className="text-xs text-slate-400">({cars.length})</span>
                          {!v.variants && <Chip tone="red">Suffix {v.ctdms_suffix_code} not in master</Chip>}
                          {v.variants && !v.colors && <Chip tone="amber">Colour to map</Chip>}
                        </span>
                      ) : null}
                    </td>
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
              }),
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
