import { useState } from "react";
import { Card, Loaded, Select, Table, Td, inr, inputCls, rpc } from "@/ui";
import { useQuery } from "@/lib/query";
import { MasterTabs, useVariants, variantLabel } from "./shared";

type Breakdown = Record<string, number | string>;

// Techwheels' RTO settings and formula. The TKM price list's Road Tax & Registration is used for a
// normal registration when it is printed; the formula prices BH, transfer and scrap registrations,
// and normal ones when the list leaves the amount blank.
export default function Rto() {
  return (
    <MasterTabs
      title="RTO Settings"
      module="rto_settings"
      note="Formula: MV tax = ex-showroom × the variant's rate, + 12.5% surcharge, + green tax by engine cc, + fixed charges (+ hypothecation when financed). BH = ex/(1+GST) × rate ÷ 6 + BH fee. Scrap: 26% of tax + surcharge off, at most ₹1,00,000. Transfer: ₹1,000."
      tabs={[
        { id: "calc", label: "Calculator", render: () => <Calculator /> },
        { id: "fixed", label: "Fixed charges", entity: "rto-settings" },
        { id: "green", label: "Green tax", entity: "green-tax-slabs" },
        { id: "pricing", label: "RTO price table", entity: "rto-pricing" },
        { id: "settings", label: "Rates & caps", entity: "pricing-config" },
      ]}
    />
  );
}

const LABELS: Record<string, string> = {
  new_registration: "New registration",
  duplicate_tax_card: "Tax card",
  hypothecation_addition: "Hypothecation",
  mv_tax: "MV tax",
  surcharge: "Surcharge",
  green_tax: "Green tax",
  rebate_waiver: "Scrap rebate (less)",
  bh_processing_fee: "BH processing fee",
  total: "Total",
};

function Calculator() {
  const variants = useVariants();
  const [variantId, setVariantId] = useState("");
  const [ex, setEx] = useState("");
  const [financed, setFinanced] = useState(false);
  const rows = useQuery(async () => {
    if (!variantId || !Number(ex)) return null;
    const types = ["NORMAL", "BH", "SCRAP", "TRANSFER"];
    const out = await Promise.all(
      types.map((t) => rpc<Breakdown | null>("rto_calc", { p_variant_id: variantId, p_ex_showroom: Number(ex), p_type: t, p_financed: financed }, { refresh: false })),
    );
    return types.map((t, i) => ({ type: t, b: out[i] }));
  }, [variantId, ex, financed]);

  return (
    <Card title="Work out the RTO">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <Select value={variantId} onChange={setVariantId} placeholder="Variant" options={(variants.data ?? []).map((v) => ({ id: v.id, name: variantLabel(v) }))} />
        <input className={`${inputCls} w-36`} type="number" placeholder="Ex-showroom" value={ex} onChange={(e) => setEx(e.target.value)} />
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={financed} onChange={(e) => setFinanced(e.target.checked)} /> Financed
        </label>
      </div>
      <Loaded q={{ ...rows, data: rows.data ?? (rows.loading ? null : []) }}>
        {(list) =>
          list.length === 0 ? (
            <p className="px-3 pb-3 text-sm text-slate-400">Pick a variant and enter the ex-showroom price.</p>
          ) : (
            <Table head={["", ...list.map((r) => r.type)]}>
              {Object.keys(LABELS).map((k) => (
                <tr key={k}>
                  <Td muted>{LABELS[k]}</Td>
                  {list.map((r) => (
                    <Td key={r.type} right className={k === "total" ? "font-semibold" : ""}>
                      {r.b ? (r.b[k] !== undefined ? inr(r.b[k]) : "—") : k === "total" ? "Set the MV tax rate on the variant" : ""}
                    </Td>
                  ))}
                </tr>
              ))}
            </Table>
          )
        }
      </Loaded>
    </Card>
  );
}
