import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { Card, Chip, EmptyRow, Loaded, Select, Table, Td, inr, rpcRows } from "@/ui";
import { MasterTabs, useVariants, variantLabel } from "./shared";

type Quote = {
  provider_id: string;
  provider: string;
  premium: number;
  is_cheapest: boolean;
  breakdown: {
    tp_type: string;
    idv: number;
    od: number;
    od_discount_percent: number;
    net_od: number;
    tp: number;
    other_charges: number;
    addons: { name: string; amount: number; mandatory: boolean; rate_percent: number }[];
    taxable: number;
    gst: number;
  };
};

// Techwheels' insurance settings: per-variant rates, OD discounts, insurer add-on rates and the
// comparison the quote uses (cheapest insurer first; zero-dep and consumables always included).
export default function Insurance() {
  return (
    <MasterTabs
      page="insurance"
      title="Insurance Rates"
      note="Premium = OD less the highest enabled discount + TP + other charges + add-ons (% of IDV) + 18% GST. When the price list prints an insurance option, that is used instead."
      panels={{
        compare: () => <Compare />,
      }}
    />
  );
}

function Compare() {
  const variants = useVariants();
  const addons = useQuery(
    async () => must(await supabase.from("insurance_addons").select("id, name, is_mandatory").order("name")) as { id: string; name: string; is_mandatory: boolean }[],
    [],
  );
  const [variantId, setVariantId] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const quotes = useQuery(
    () => (variantId ? rpcRows<Quote>("insurance_quotes", { p_variant_id: variantId, p_addon_ids: picked }) : Promise.resolve([] as Quote[])),
    [variantId, picked.join(",")],
  );
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <Select value={variantId} onChange={setVariantId} placeholder="Variant" options={(variants.data ?? []).map((v) => ({ id: v.id, name: variantLabel(v) }))} />
        {(addons.data ?? [])
          .filter((a) => !a.is_mandatory)
          .map((a) => (
            <label key={a.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={picked.includes(a.id)}
                onChange={() => setPicked(picked.includes(a.id) ? picked.filter((x) => x !== a.id) : [...picked, a.id])}
              />
              {a.name}
            </label>
          ))}
      </div>
      <Card title="Insurers for this variant" note="Insurers without rates for this variant, or without a rate for an always-included add-on, are not listed.">
        <Loaded q={quotes}>
          {(rows) => (
            <Table head={["Insurer", "IDV", "OD (after discount)", "TP", "Other", "Add-ons", "GST", "Premium"]}>
              {rows.length === 0 ? (
                <EmptyRow cols={8} text={variantId ? "No insurer can quote this variant yet." : "Pick a variant."} />
              ) : (
                rows.map((q) => (
                  <tr key={q.provider_id}>
                    <Td>
                      {q.provider} {q.is_cheapest && <Chip tone="emerald">Cheapest</Chip>}
                      <div className="text-xs text-slate-400">{q.breakdown.tp_type}</div>
                    </Td>
                    <Td right>{inr(q.breakdown.idv)}</Td>
                    <Td right>
                      {inr(q.breakdown.net_od)}
                      <div className="text-xs text-slate-400">
                        {inr(q.breakdown.od)} − {q.breakdown.od_discount_percent}%
                      </div>
                    </Td>
                    <Td right>{inr(q.breakdown.tp)}</Td>
                    <Td right>{inr(q.breakdown.other_charges)}</Td>
                    <Td>
                      {q.breakdown.addons.map((a) => (
                        <div key={a.name} className="text-xs">
                          {a.name} {a.rate_percent}% = {inr(a.amount)} {a.mandatory && <span className="text-slate-400">(always)</span>}
                        </div>
                      ))}
                    </Td>
                    <Td right>{inr(q.breakdown.gst)}</Td>
                    <Td right className="font-semibold">
                      {inr(q.premium)}
                    </Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
      </Card>
    </>
  );
}
