import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { ageDays, isAccounts, isBackOffice, one } from "./shared";
import { StockTable, type StockRow } from "./stock-table";

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
  location: string | null;
  variants: (Named & { models: Named | Named[] | null; fuel_types: Named | Named[] | null }) | null;
  colors: Named | null;
  outlets: Named | null;
};

// Unallotted cars, one row per chassis; filtering happens in the table.
export default async function FreeStockPage() {
  const supabase = await createClient();
  const employee = await getCurrentEmployee();
  if (isAccounts(employee)) {
    return <p className="text-sm text-slate-600">Accounts works the <Link href="/stock/billing" className="underline">billing queue</Link>.</p>;
  }

  const { data } = await supabase
    .from("vehicles")
    .select(
      "id, vin, source, ctdms_suffix_code, ext_color_desc, ctdms_model, days_since_invoice, tkm_invoice_date, tkm_invoice_amount, " +
        "ctdms_block_status, ctdms_order_status, missing_from_report, location, variants(name, models(name), fuel_types(name)), colors(name), outlets(name)",
    )
    .eq("status", "available")
    .order("tkm_invoice_date", { ascending: true, nullsFirst: false })
    .limit(2000);
  const all = (data ?? []) as unknown as Vehicle[];
  const free = all.filter((v) => !v.missing_from_report && v.ctdms_order_status !== "Invoiced");
  const hidden = all.length - free.length;

  const modelOf = (v: Vehicle) => one(v.variants?.models ?? null)?.name ?? v.ctdms_model ?? "Not in master data";
  const rows: StockRow[] = free
    .map((v) => ({
      id: v.id,
      vin: v.vin,
      suffix: v.ctdms_suffix_code,
      model: modelOf(v),
      variant: v.variants?.name ?? v.ctdms_suffix_code ?? "?",
      fuel: one(v.variants?.fuel_types ?? null)?.name ?? null,
      color: v.colors?.name ?? v.ext_color_desc ?? "?",
      age: ageDays(v),
      invoiceDate: v.tkm_invoice_date,
      transit: v.source === "transit",
      location: v.location,
      branch: v.outlets?.name ?? null,
      block: v.ctdms_block_status && v.ctdms_block_status !== "Free" ? v.ctdms_block_status : null,
      flag: !v.variants
        ? { tone: "red" as const, text: `Suffix ${v.ctdms_suffix_code} not in master` }
        : !v.colors
          ? { tone: "amber" as const, text: "Colour to map" }
          : null,
    }))
    // Model, then variant, then oldest first so ageing stock moves first.
    .sort((a, b) => a.model.localeCompare(b.model) || a.variant.localeCompare(b.variant) || (b.age ?? -1) - (a.age ?? -1));

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-slate-900">Free stock</h2>
        <p className="text-xs text-slate-500">
          Cars not yet allotted to a customer. Ageing is counted from the TKM invoice date.
          {hidden > 0 && (
            <>
              {" "}
              {hidden} not shown: invoiced in CTDMS or missing from the latest report
              {isBackOffice(employee) && (
                <>
                  {" "}
                  (<Link href="/stock/ctdms" className="underline">CTDMS To-do</Link>)
                </>
              )}
              .
            </>
          )}
        </p>
      </div>
      <StockTable rows={rows} />
    </div>
  );
}
