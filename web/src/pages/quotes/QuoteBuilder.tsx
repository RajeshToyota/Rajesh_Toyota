import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useCurrentEmployee } from "@/lib/auth";
import { Card, ErrorBox, RunButton, Select, Table, Td, inputCls, inr, rpc, rpcRows } from "@/ui";

type Named = { id: string; name: string };
type Variant = { id: string; name: string; model_id: string; tkm_suffix_code: string | null; models: { name: string } | null };
type Line = { type: string; label: string; amount: number };
export type Priced = {
  total_amount: number;
  line_items: Line[];
  dealer_margin: number;
  margin_available: number | null;
  margin_used: number;
  margin_floor_breached: boolean;
  coupon_cap: number;
};

const LIST_TYPES = [
  { id: "private", name: "Private" },
  { id: "commercial", name: "Commercial" },
  { id: "csd", name: "CSD" },
];
const RTO_TYPES = [
  { id: "NORMAL", name: "Normal registration" },
  { id: "BH", name: "BH series" },
  { id: "SCRAP", name: "Against a scrapped car" },
  { id: "TRANSFER", name: "Transfer" },
];

// The web quote (Techwheels' admin "Create Quote"): the same selections as the mobile app plus the
// Phase 24 extras, priced live by the database, saved as a Basic quote.
export default function QuoteBuilder({ onSaved }: { onSaved: () => void }) {
  const me = useCurrentEmployee();
  const navigate = useNavigate();
  const masters = useQuery(async () => {
    const [outlets, variants, colors, rto, financiers] = await Promise.all([
      supabase.from("outlets").select("id, name").eq("is_active", true).order("name"),
      // TKM stock codes (FRNBK…) are reached through their sales variant + interior.
      supabase.from("variants").select("id, name, model_id, tkm_suffix_code, models(name)").eq("is_active", true).is("sales_variant_id", null).order("name"),
      supabase.from("colors").select("id, name").order("name"),
      supabase.from("rto_categories").select("id, name").order("name"),
      supabase.from("financiers").select("id, name").eq("is_active", true).order("name"),
    ]);
    return {
      outlets: must(outlets) as Named[],
      variants: must(variants) as unknown as Variant[],
      colors: must(colors) as Named[],
      rto: must(rto) as Named[],
      financiers: must(financiers) as Named[],
    };
  }, []);

  const [f, setF] = useState({
    customer_name: "",
    customer_mobile: "",
    outlet_id: "",
    variant_id: "",
    color_id: "",
    interior_color_id: "",
    price_list_type: "private",
    rto_category_id: "00000000-0000-0000-000b-000000000001",
    rto_type: "NORMAL",
    insurance: "",
    include_extended_warranty: false,
    quantity: 1,
    preferred_financier_id: "",
    exchange_interest: false,
    model_year: "current",
    ceramic_coating_id: "",
    coupon_amount: 0,
    apply_mr_discount: false,
  });
  const [accessoryIds, setAccessoryIds] = useState<string[]>([]);
  const [vasIds, setVasIds] = useState<string[]>([]);
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  useEffect(() => {
    if (!f.outlet_id && me?.outletId) set({ outlet_id: me.outletId });
  }, [me?.outletId, f.outlet_id]);

  const variant = masters.data?.variants.find((v) => v.id === f.variant_id);
  const options = useQuery(async () => {
    if (!variant) return null;
    const [acc, vas, ceramic, insurers, list, colours, interiors] = await Promise.all([
      rpcRows<{ id: string; name: string; price: number; is_top: boolean }>("accessories_for_variant", { p_variant_id: variant.id }),
      supabase.from("vas_products").select("id, name, price, model_id").eq("is_active", true).order("name"),
      supabase.from("ceramic_coating_prices").select("id, name, price").eq("model_id", variant.model_id).eq("is_active", true),
      rpcRows<{ provider_id: string; provider: string; premium: number; is_cheapest: boolean }>("insurance_quotes", { p_variant_id: variant.id }),
      supabase.from("price_list").select("insurance_options").eq("variant_id", variant.id).eq("list_type", f.price_list_type).order("effective_from", { ascending: false }).limit(1),
      supabase.from("variant_colors").select("color_id").eq("variant_id", variant.id),
      supabase.from("variant_interior_colors").select("interior_colors(id, name, is_active)").eq("variant_id", variant.id),
    ]);
    const vasRows = (must(vas) as { id: string; name: string; price: number; model_id: string | null }[]).filter((v) => !v.model_id || v.model_id === variant.model_id);
    const listOpts = Object.keys(((must(list) as { insurance_options: Record<string, number> | null }[])[0]?.insurance_options ?? {}) as object);
    return {
      accessories: acc,
      vas: vasRows,
      ceramic: must(ceramic) as { id: string; name: string; price: number }[],
      insurers,
      listOptions: listOpts,
      colourIds: new Set((must(colours) as { color_id: string }[]).map((c) => c.color_id)),
      interiors: (must(interiors) as unknown as { interior_colors: (Named & { is_active: boolean }) | (Named & { is_active: boolean })[] | null }[])
        .map((r) => (Array.isArray(r.interior_colors) ? r.interior_colors[0] : r.interior_colors))
        .filter((c): c is Named & { is_active: boolean } => !!c && c.is_active)
        .map((c) => ({ id: c.id, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [variant?.id, f.price_list_type]);

  const payload = useMemo(() => {
    const insuranceOption = f.insurance.startsWith("list:") ? f.insurance.slice(5) : null;
    const providerId = f.insurance.startsWith("insurer:") ? f.insurance.slice(8) : null;
    return {
      variant_id: f.variant_id,
      color_id: f.color_id,
      outlet_id: f.outlet_id,
      rto_category_id: f.rto_category_id,
      price_list_type: f.price_list_type,
      insurance_option: insuranceOption,
      include_extended_warranty: f.include_extended_warranty,
      accessory_ids: accessoryIds,
      vas_product_ids: vasIds,
      pricing_extras: {
        model_year: f.model_year,
        rto_type: f.rto_type,
        ...(providerId ? { insurance_provider_id: providerId } : {}),
        ...(f.ceramic_coating_id ? { ceramic_coating_id: f.ceramic_coating_id } : {}),
        ...(f.coupon_amount > 0 ? { coupon_amount: f.coupon_amount } : {}),
        ...(f.apply_mr_discount ? { apply_mr_discount: true } : {}),
      },
    };
  }, [f, accessoryIds, vasIds]);

  // One interior fills itself in; with more (Black or Chamois…) it must be picked, as it decides the TKM suffix.
  const interiors = options.data?.interiors ?? [];
  const interiorId = interiors.length === 1 ? interiors[0].id : f.interior_color_id;
  const ready = !!(f.variant_id && f.color_id && f.outlet_id && (interiors.length === 0 || interiorId));
  const price = useQuery(() => (ready ? rpc<Priced>("preview_quote_price", { p: payload }, { refresh: false }) : Promise.resolve(null)), [ready, JSON.stringify(payload)]);

  if (!masters.data) return <p className="text-sm text-slate-400">Loading…</p>;
  const m = masters.data;
  const toggle = (list: string[], id: string, setList: (x: string[]) => void) => setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const colourOptions = options.data?.colourIds.size ? m.colors.filter((c) => options.data!.colourIds.has(c.id)) : m.colors;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div>
        <Card title="Customer">
          <div className="flex flex-wrap gap-2 px-3 py-2">
            <input className={`${inputCls} w-64`} placeholder="Customer name" value={f.customer_name} onChange={(e) => set({ customer_name: e.target.value })} />
            <input className={`${inputCls} w-44`} placeholder="Mobile" value={f.customer_mobile} onChange={(e) => set({ customer_mobile: e.target.value })} />
            <Select value={f.outlet_id} onChange={(v) => set({ outlet_id: v })} options={m.outlets} placeholder="Branch" />
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={f.exchange_interest} onChange={(e) => set({ exchange_interest: e.target.checked })} /> Has a car to exchange
            </label>
          </div>
        </Card>
        <Card title="Car">
          <div className="flex flex-wrap gap-2 px-3 py-2">
            <Select
              value={f.variant_id}
              onChange={(v) => {
                set({ variant_id: v, color_id: "", interior_color_id: "", ceramic_coating_id: "", insurance: "" });
                setAccessoryIds([]);
                setVasIds([]);
              }}
              placeholder="Variant"
              options={m.variants.map((v) => ({ id: v.id, name: `${v.models?.name ?? ""} ${v.name}${v.tkm_suffix_code ? ` (${v.tkm_suffix_code})` : ""}` }))}
            />
            <Select value={f.color_id} onChange={(v) => set({ color_id: v })} options={colourOptions} placeholder="Colour" />
            {interiors.length > 1 && (
              <Select value={f.interior_color_id} onChange={(v) => set({ interior_color_id: v })} options={interiors} placeholder="Interior" />
            )}
            {interiors.length === 1 && <span className="self-center text-xs text-slate-500">Interior: {interiors[0].name}</span>}
            <Select value={f.price_list_type} onChange={(v) => set({ price_list_type: v })} options={LIST_TYPES} />
            <Select value={f.model_year} onChange={(v) => set({ model_year: v })} options={[{ id: "current", name: "Current model year" }, { id: "previous", name: "Previous model year" }]} />
            <input
              className={`${inputCls} w-24`}
              type="number"
              min={1}
              value={f.quantity}
              onChange={(e) => set({ quantity: Math.max(1, Number(e.target.value) || 1) })}
              title="Number of cars (fleet)"
            />
            <span className="self-center text-xs text-slate-500">cars</span>
          </div>
        </Card>
        <Card title="Registration, insurance and finance">
          <div className="flex flex-wrap gap-2 px-3 py-2">
            <Select value={f.rto_category_id} onChange={(v) => set({ rto_category_id: v })} options={m.rto} />
            <Select value={f.rto_type} onChange={(v) => set({ rto_type: v })} options={RTO_TYPES} />
            <Select
              value={f.insurance}
              onChange={(v) => set({ insurance: v })}
              placeholder="No insurance"
              options={[
                ...(options.data?.listOptions ?? []).map((o) => ({ id: `list:${o}`, name: `Price list: ${o.replace("_3plus3", " 3+3").replace(/_/g, " ")}` })),
                ...(options.data?.insurers ?? []).map((i) => ({ id: `insurer:${i.provider_id}`, name: `${i.provider} ${inr(i.premium)}${i.is_cheapest ? " (cheapest)" : ""}` })),
              ]}
            />
            <Select value={f.preferred_financier_id} onChange={(v) => set({ preferred_financier_id: v })} options={m.financiers} placeholder="Preferred financier" />
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={f.include_extended_warranty} onChange={(e) => set({ include_extended_warranty: e.target.checked })} /> 5th-year warranty
            </label>
          </div>
        </Card>
        {options.data && (
          <Card title="Accessories, VAS and coating">
            <div className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-2">
              {options.data.accessories.map((a) => (
                <label key={a.id} className="flex items-center gap-1">
                  <input type="checkbox" checked={accessoryIds.includes(a.id)} onChange={() => toggle(accessoryIds, a.id, setAccessoryIds)} />
                  {a.name} <span className="text-slate-400">{inr(a.price)}</span>
                  {a.is_top && <span className="text-xs text-amber-700">top</span>}
                </label>
              ))}
              {options.data.vas.map((v) => (
                <label key={v.id} className="flex items-center gap-1">
                  <input type="checkbox" checked={vasIds.includes(v.id)} onChange={() => toggle(vasIds, v.id, setVasIds)} />
                  {v.name} <span className="text-slate-400">{inr(v.price)}</span>
                </label>
              ))}
            </div>
            {options.data.ceramic.length > 0 && (
              <div className="px-3 pb-2">
                <Select
                  value={f.ceramic_coating_id}
                  onChange={(v) => set({ ceramic_coating_id: v })}
                  placeholder="No ceramic coating"
                  options={options.data.ceramic.map((c) => ({ id: c.id, name: `${c.name} ${inr(c.price)}` }))}
                />
              </div>
            )}
          </Card>
        )}
        <Card title="Coupon" note={price.data ? `Cap on this variant: ${inr(price.data.coupon_cap)}` : undefined}>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <input className={`${inputCls} w-32`} type="number" min={0} placeholder="Coupon" value={f.coupon_amount || ""} onChange={(e) => set({ coupon_amount: Number(e.target.value) || 0 })} />
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={f.apply_mr_discount} onChange={(e) => set({ apply_mr_discount: e.target.checked })} /> Approved MR discount
            </label>
          </div>
        </Card>
      </div>

      <div>
        <Card title="Price">
          {price.error && <ErrorBox message={price.error} />}
          {!ready ? (
            <p className="px-3 py-4 text-sm text-slate-400">Pick a branch, variant, colour{interiors.length > 1 ? " and interior" : ""}.</p>
          ) : price.data ? (
            <>
              <Table head={["", ""]}>
                {price.data.line_items.map((l, i) => (
                  <tr key={i}>
                    <Td>{l.label}</Td>
                    <Td right>{inr(l.amount)}</Td>
                  </tr>
                ))}
                <tr>
                  <Td className="font-semibold">On-road{f.quantity > 1 ? " (per car)" : ""}</Td>
                  <Td right className="font-semibold">
                    {inr(price.data.total_amount)}
                  </Td>
                </tr>
                {f.quantity > 1 && (
                  <tr>
                    <Td>{f.quantity} cars</Td>
                    <Td right>{inr(price.data.total_amount * f.quantity)}</Td>
                  </tr>
                )}
              </Table>
              {price.data.margin_floor_breached && (
                <p className="mx-3 my-2 rounded bg-amber-50 p-2 text-xs text-amber-800">
                  Discounts ({inr(price.data.margin_used)}) are below the margin floor ({inr(price.data.margin_available)} available): the Business Head must approve.
                </p>
              )}
            </>
          ) : (
            <p className="px-3 py-4 text-sm text-slate-400">Pricing…</p>
          )}
          <div className="px-3 py-2">
            <RunButton
              label="Save quote"
              disabled={!ready || !price.data || !f.customer_name.trim() || !me}
              run={async () => {
                const { data, error } = await supabase
                  .from("quotes")
                  .insert({
                    outlet_id: f.outlet_id,
                    employee_id: me!.id,
                    customer_name: f.customer_name.trim(),
                    customer_mobile: f.customer_mobile.trim() || null,
                    variant_id: f.variant_id,
                    color_id: f.color_id,
                    interior_color_id: interiorId || null,
                    rto_category_id: f.rto_category_id,
                    price_list_type: f.price_list_type,
                    insurance_option: payload.insurance_option,
                    include_extended_warranty: f.include_extended_warranty,
                    accessory_ids: accessoryIds,
                    vas_product_ids: vasIds,
                    pricing_extras: payload.pricing_extras,
                    quantity: f.quantity,
                    source: "web",
                    preferred_financier_id: f.preferred_financier_id || null,
                    exchange_interest: f.exchange_interest,
                  })
                  .select("id")
                  .single();
                if (error) throw new Error(error.message);
                onSaved();
                navigate(`/quotes/${data.id}`);
              }}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
