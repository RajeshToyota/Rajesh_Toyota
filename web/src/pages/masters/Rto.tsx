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
      page="rto"
      title="RTO Settings"
      note="Normal: the list's fixed charges + MV tax (ex-showroom × the price-list row's rate) + surcharge + the row's green tax and extra charges; a row with no MV tax rate uses the printed figure. BH = ex/(1+GST) × rate ÷ 6 + fixed charges + BH fee. Scrap: 26% of tax + surcharge off, at most ₹1,00,000. Transfer: flat."
      panels={{
        calc: () => <Calculator />,
      }}
    />
  );
}

const LABELS: Record<string, string> = {
  fixed_charges: "Fixed charges",
  mv_tax: "MV tax",
  surcharge_mv_tax: "Surcharge",
  green_tax: "Green tax",
  extra_charges: "Extra charges",
  rebate_waiver: "Scrap rebate (less)",
  bh_processing_fee: "BH processing fee",
  total: "Total",
};

function Calculator() {
  const variants = useVariants();
  const [variantId, setVariantId] = useState("");
  const [ex, setEx] = useState("");
  const [listType, setListType] = useState("private");
  const rows = useQuery(async () => {
    if (!variantId || !Number(ex)) return null;
    const types = ["NORMAL", "BH", "SCRAP", "TRANSFER"];
    const out = await Promise.all(
      types.map((t) => rpc<Breakdown | null>("rto_calc", { p_variant_id: variantId, p_ex_showroom: Number(ex), p_type: t, p_list_type: listType }, { refresh: false })),
    );
    return types.map((t, i) => ({ type: t, b: out[i] }));
  }, [variantId, ex, listType]);

  return (
    <Card title="Work out the RTO">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <Select value={variantId} onChange={setVariantId} placeholder="Variant" options={(variants.data ?? []).map((v) => ({ id: v.id, name: variantLabel(v) }))} />
        <input className={`${inputCls} w-36`} type="number" placeholder="Ex-showroom" value={ex} onChange={(e) => setEx(e.target.value)} />
        <Select value={listType} onChange={setListType} options={[{ id: "private", name: "Private" }, { id: "commercial", name: "Commercial" }, { id: "csd", name: "CSD" }]} />
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
                      {r.b ? (r.b[k] !== undefined ? inr(r.b[k]) : "—") : k === "total" ? "No MV tax rate on the price list" : ""}
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
