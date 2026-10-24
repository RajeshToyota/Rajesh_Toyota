import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { PriceListType, QuoteSelections } from "@/lib/types";
import type { PickerOption } from "@/components/picker-list";

// Shared by both the quote wizard and the direct-booking wizard (spec 6.2 entry point B) — the
// vehicle/scheme/RTO/insurance/accessory/VAS selection steps are identical in both flows, only
// what happens after pricing (share vs. booking-form + signature) differs.
type Row = Record<string, any>;

export const VEHICLE_STEP_TITLES = [
  "Model",
  "Fuel Type",
  "Transmission",
  "Variant",
  "Color",
  "RTO & Scrap",
  "Schemes",
  "Insurance",
  "Accessories",
  "VAS",
] as const;

export function useVehicleSelection(state: string) {
  const [models, setModels] = useState<Row[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [variantsForModel, setVariantsForModel] = useState<Row[]>([]);
  const [fuelTypeId, setFuelTypeId] = useState<string | null>(null);
  const [transmissionId, setTransmissionId] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [colors, setColors] = useState<Row[]>([]);
  const [colorId, setColorId] = useState<string | null>(null);

  const [rtoCategories, setRtoCategories] = useState<Row[]>([]);
  const [rtoCategoryId, setRtoCategoryId] = useState<string | null>(null);
  const [scrapSource, setScrapSource] = useState<"Self" | "Rajesh Toyota" | null>(null);
  const [scrapAmount, setScrapAmount] = useState("");
  const [scrapCertificateNumber, setScrapCertificateNumber] = useState("");

  const [schemeLineItems, setSchemeLineItems] = useState<Row[]>([]);
  const [schemeGroups, setSchemeGroups] = useState<Record<string, string>>({});
  const [selectedSchemeIds, setSelectedSchemeIds] = useState<string[]>([]);
  const [hasExchange, setHasExchange] = useState(false);

  const [insuranceChoice, setInsuranceChoice] = useState<"self" | "rajesh_toyota" | null>(null);
  const [insurancePlans, setInsurancePlans] = useState<Row[]>([]);
  const [insurancePlanId, setInsurancePlanId] = useState<string | null>(null);
  const [insuranceAddons, setInsuranceAddons] = useState<Row[]>([]);
  const [insuranceAddonIds, setInsuranceAddonIds] = useState<string[]>([]);

  // Dealer price-list rows for the chosen variant: which lists (private / commercial / CSD) it is
  // on, the insurance options each prints, and the 5th-year warranty amount.
  const [priceRows, setPriceRows] = useState<Row[]>([]);
  const [priceListType, setPriceListType] = useState<PriceListType>("private");
  const [insuranceOption, setInsuranceOption] = useState<string | null>(null);
  const [includeExtendedWarranty, setIncludeExtendedWarranty] = useState(false);

  const [accessories, setAccessories] = useState<Row[]>([]);
  const [accessoryIds, setAccessoryIds] = useState<string[]>([]);
  const [vasProducts, setVasProducts] = useState<Row[]>([]);
  const [vasProductIds, setVasProductIds] = useState<string[]>([]);

  useEffect(() => {
    supabase.from("models").select("id, name").eq("is_active", true).order("name").then(({ data }) => setModels(data ?? []));
  }, []);

  useEffect(() => {
    if (!modelId) {
      setVariantsForModel([]);
      return;
    }
    supabase
      .from("variants")
      .select("id, name, suffix, fuel_type_id, transmission_id, fuel_types(name), transmissions(name)")
      .eq("model_id", modelId)
      .eq("is_active", true)
      .then(({ data }) => setVariantsForModel(data ?? []));
  }, [modelId]);

  useEffect(() => {
    if (!variantId) {
      setColors([]);
      return;
    }
    supabase
      .from("variant_colors")
      .select("color_id, extra_cost, colors(id, name, hex, paint_category)")
      .eq("variant_id", variantId)
      .then(({ data }) => {
        const rows = (data ?? []).map((r: Row) => ({
          id: r.colors.id,
          name: r.colors.name,
          extra_cost: r.extra_cost,
          paint_category: r.colors.paint_category,
        }));
        setColors(rows);
      });
  }, [variantId]);

  useEffect(() => {
    if (!variantId) {
      setPriceRows([]);
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    supabase
      .from("price_list")
      .select("list_type, paint_category, color_id, insurance_options, ew_5th_year_amount, effective_from")
      .eq("variant_id", variantId)
      .eq("state", state)
      .lte("effective_from", today)
      .or(`effective_to.is.null,effective_to.gte.${today}`)
      .order("effective_from", { ascending: false })
      .then(({ data }) => setPriceRows(data ?? []));
  }, [variantId, state]);

  useEffect(() => {
    supabase.from("rto_categories").select("id, name").order("name").then(({ data }) => setRtoCategories(data ?? []));
  }, []);

  useEffect(() => {
    if (!modelId) return;
    const today = new Date().toISOString().slice(0, 10);
    supabase
      .from("schemes")
      .select("id, scheme_line_items(id, line_type, is_customer_facing, scheme_conditions(mutually_exclusive_group, requires_exchange, requires_scrap))")
      .eq("model_id", modelId)
      .lte("valid_from", today)
      .gte("valid_to", today)
      .then(({ data }) => {
        const items: Row[] = [];
        const groups: Record<string, string> = {};
        for (const scheme of data ?? []) {
          for (const li of scheme.scheme_line_items ?? []) {
            if (!li.is_customer_facing) continue;
            const condition = Array.isArray(li.scheme_conditions) ? li.scheme_conditions[0] : li.scheme_conditions;
            items.push({ ...li, condition });
            if (condition?.mutually_exclusive_group) groups[li.id] = condition.mutually_exclusive_group;
          }
        }
        setSchemeLineItems(items);
        setSchemeGroups(groups);
      });
  }, [modelId]);

  useEffect(() => {
    if (insuranceChoice !== "rajesh_toyota") return;
    supabase.from("insurance_plans").select("id, coverage_type, base_rate").then(({ data }) => setInsurancePlans(data ?? []));
    supabase.from("insurance_addons").select("id, name, price").then(({ data }) => setInsuranceAddons(data ?? []));
  }, [insuranceChoice]);

  useEffect(() => {
    if (!modelId) return;
    supabase
      .from("accessories")
      .select("id, name, price, variant_id, model_id, category")
      .eq("is_active", true)
      .or(`variant_id.eq.${variantId ?? "00000000-0000-0000-0000-000000000000"},model_id.eq.${modelId}`)
      .order("sort_order", { nullsFirst: false })
      .then(({ data }) => setAccessories(data ?? []));
  }, [modelId, variantId]);

  useEffect(() => {
    // Model-specific VAS (e.g. TGLOSS packages) plus anything not tied to a model.
    let query = supabase.from("vas_products").select("id, name, price, model_id").eq("is_active", true);
    query = modelId ? query.or(`model_id.is.null,model_id.eq.${modelId}`) : query.is("model_id", null);
    query.order("name").then(({ data }) => setVasProducts(data ?? []));
  }, [modelId]);

  const availableFuelTypes: PickerOption[] = useMemo(() => {
    const seen = new Map<string, string>();
    for (const v of variantsForModel) if (!seen.has(v.fuel_type_id)) seen.set(v.fuel_type_id, v.fuel_types?.name ?? "");
    return Array.from(seen, ([id, label]) => ({ id, label }));
  }, [variantsForModel]);

  const availableTransmissions: PickerOption[] = useMemo(() => {
    const filtered = variantsForModel.filter((v) => v.fuel_type_id === fuelTypeId);
    const seen = new Map<string, string>();
    for (const v of filtered) if (!seen.has(v.transmission_id)) seen.set(v.transmission_id, v.transmissions?.name ?? "");
    return Array.from(seen, ([id, label]) => ({ id, label }));
  }, [variantsForModel, fuelTypeId]);

  const availableVariants: PickerOption[] = useMemo(() => {
    return variantsForModel
      .filter((v) => v.fuel_type_id === fuelTypeId && v.transmission_id === transmissionId)
      .map((v) => ({ id: v.id, label: v.name, sublabel: v.suffix }));
  }, [variantsForModel, fuelTypeId, transmissionId]);

  const availableListTypes: PriceListType[] = useMemo(
    () => (["private", "commercial", "csd"] as PriceListType[]).filter((t) => priceRows.some((r) => r.list_type === t)),
    [priceRows],
  );

  // Same row choice as calculate_price: this colour's own row, else its paint category, else standard.
  const activePriceRow: Row | null = useMemo(() => {
    const paint = colors.find((c) => c.id === colorId)?.paint_category ?? "standard";
    const rows = priceRows.filter((r) => r.list_type === priceListType);
    return (
      rows.find((r) => r.color_id === colorId) ??
      rows.find((r) => !r.color_id && r.paint_category === paint) ??
      rows.find((r) => !r.color_id && r.paint_category === "standard") ??
      null
    );
  }, [priceRows, priceListType, colors, colorId]);

  const listInsuranceOptions: { id: string; amount: number }[] = useMemo(
    () => Object.entries(activePriceRow?.insurance_options ?? {}).map(([id, amount]) => ({ id, amount: Number(amount) })),
    [activePriceRow],
  );
  const extendedWarrantyAmount: number | null = activePriceRow?.ew_5th_year_amount ?? null;

  useEffect(() => {
    if (availableListTypes.length > 0 && !availableListTypes.includes(priceListType)) setPriceListType(availableListTypes[0]);
  }, [availableListTypes, priceListType]);

  useEffect(() => {
    if (insuranceOption && !listInsuranceOptions.some((o) => o.id === insuranceOption)) setInsuranceOption(null);
    if (extendedWarrantyAmount === null) setIncludeExtendedWarranty(false);
  }, [listInsuranceOptions, insuranceOption, extendedWarrantyAmount]);

  const usesListInsurance = insuranceChoice === "rajesh_toyota" && listInsuranceOptions.length > 0;

  const selectedVariantName = variantsForModel.find((v) => v.id === variantId)?.name ?? "";
  const selectedColorName = colors.find((c) => c.id === colorId)?.name ?? "";
  const selectedModelName = models.find((m) => m.id === modelId)?.name ?? "";
  const selectedRtoName = rtoCategories.find((r) => r.id === rtoCategoryId)?.name ?? "";
  const isScrapLinkedRto = selectedRtoName.toLowerCase().includes("scrap");

  function toggleScheme(id: string) {
    const group = schemeGroups[id];
    setSelectedSchemeIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (group) {
        const withoutGroup = prev.filter((x) => schemeGroups[x] !== group);
        return [...withoutGroup, id];
      }
      return [...prev, id];
    });
  }

  function toggleFrom(list: string[], setList: (v: string[]) => void, id: string) {
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  }

  function buildSelections(): QuoteSelections {
    return {
      variant_id: variantId!,
      color_id: colorId!,
      state,
      rto_category_id: rtoCategoryId!,
      list_type: priceListType,
      insurance_option: usesListInsurance ? insuranceOption : null,
      include_extended_warranty: includeExtendedWarranty,
      scrap:
        isScrapLinkedRto && scrapSource
          ? { source: scrapSource, amount: scrapSource === "Rajesh Toyota" ? Number(scrapAmount) || 0 : 0 }
          : null,
      insurance_plan_id: insuranceChoice === "rajesh_toyota" && !usesListInsurance ? insurancePlanId : null,
      insurance_addon_ids: insuranceChoice === "rajesh_toyota" ? insuranceAddonIds : [],
      accessory_ids: accessoryIds,
      vas_product_ids: vasProductIds,
      selected_scheme_line_item_ids: selectedSchemeIds,
      has_exchange: hasExchange,
      has_scrap: isScrapLinkedRto && !!scrapSource,
    };
  }

  const stepValid: Record<number, boolean> = {
    0: !!modelId,
    1: !!fuelTypeId,
    2: !!transmissionId,
    3: !!variantId,
    4: !!colorId,
    5: !!rtoCategoryId && (!isScrapLinkedRto || !!scrapSource),
    6: true,
    7:
      insuranceChoice === "self" ||
      (insuranceChoice === "rajesh_toyota" && (usesListInsurance ? !!insuranceOption : !!insurancePlanId)),
    8: true,
    9: true,
  };

  return {
    models, modelId, setModelId,
    variantsForModel, fuelTypeId, setFuelTypeId,
    transmissionId, setTransmissionId,
    variantId, setVariantId,
    colors, colorId, setColorId,
    rtoCategories, rtoCategoryId, setRtoCategoryId,
    scrapSource, setScrapSource, scrapAmount, setScrapAmount,
    scrapCertificateNumber, setScrapCertificateNumber,
    schemeLineItems, selectedSchemeIds, toggleScheme,
    hasExchange, setHasExchange,
    insuranceChoice, setInsuranceChoice,
    availableListTypes, priceListType, setPriceListType,
    listInsuranceOptions, usesListInsurance, insuranceOption, setInsuranceOption,
    extendedWarrantyAmount, includeExtendedWarranty, setIncludeExtendedWarranty,
    insurancePlans, insurancePlanId, setInsurancePlanId,
    insuranceAddons, insuranceAddonIds, setInsuranceAddonIds,
    accessories, accessoryIds, setAccessoryIds,
    vasProducts, vasProductIds, setVasProductIds,
    toggleFrom,
    availableFuelTypes, availableTransmissions, availableVariants,
    selectedVariantName, selectedColorName, selectedModelName,
    isScrapLinkedRto,
    buildSelections,
    stepValid,
  };
}

export type VehicleSelection = ReturnType<typeof useVehicleSelection>;
