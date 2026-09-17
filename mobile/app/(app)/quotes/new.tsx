import { useEffect, useMemo, useState } from "react";
import { View, Text, TextInput, Alert, Switch, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/auth-context";
import { WizardShell } from "@/components/wizard-shell";
import { PickerList, CheckboxRow, type PickerOption } from "@/components/picker-list";
import { priceQuote } from "@/lib/pricing";
import { findApprovalRequirement, createApprovalRequest } from "@/lib/approvals";
import {
  buildQuoteHtml,
  buildWhatsAppMessage,
  generateQuotePdf,
  openWhatsApp,
  shareQuotePdfNative,
  uploadQuotePdf,
} from "@/lib/quote-document";
import type { PricingResult, QuoteSelections } from "@/lib/types";

type Row = Record<string, any>;

const STEP_TITLES = [
  "Customer",
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
  "Summary",
  "Share",
];

export default function NewQuoteScreen() {
  const { employee } = useAuth();
  const [step, setStep] = useState(0);

  // Customer
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerMobile, setCustomerMobile] = useState("");

  // Catalog selections
  const [models, setModels] = useState<Row[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [variantsForModel, setVariantsForModel] = useState<Row[]>([]);
  const [fuelTypeId, setFuelTypeId] = useState<string | null>(null);
  const [transmissionId, setTransmissionId] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [colors, setColors] = useState<Row[]>([]);
  const [colorId, setColorId] = useState<string | null>(null);

  // RTO / scrap
  const [rtoCategories, setRtoCategories] = useState<Row[]>([]);
  const [rtoCategoryId, setRtoCategoryId] = useState<string | null>(null);
  const [scrapSource, setScrapSource] = useState<"Self" | "Rajesh Toyota" | null>(null);
  const [scrapAmount, setScrapAmount] = useState("");
  const [scrapCertificateNumber, setScrapCertificateNumber] = useState("");

  // Schemes
  const [schemeLineItems, setSchemeLineItems] = useState<Row[]>([]);
  const [schemeGroups, setSchemeGroups] = useState<Record<string, string>>({}); // line_item_id -> group
  const [selectedSchemeIds, setSelectedSchemeIds] = useState<string[]>([]);
  const [hasExchange, setHasExchange] = useState(false);

  // Insurance
  const [insuranceChoice, setInsuranceChoice] = useState<"self" | "rajesh_toyota" | null>(null);
  const [insurancePlans, setInsurancePlans] = useState<Row[]>([]);
  const [insurancePlanId, setInsurancePlanId] = useState<string | null>(null);
  const [insuranceAddons, setInsuranceAddons] = useState<Row[]>([]);
  const [insuranceAddonIds, setInsuranceAddonIds] = useState<string[]>([]);

  // Accessories / VAS
  const [accessories, setAccessories] = useState<Row[]>([]);
  const [accessoryIds, setAccessoryIds] = useState<string[]>([]);
  const [vasProducts, setVasProducts] = useState<Row[]>([]);
  const [vasProductIds, setVasProductIds] = useState<string[]>([]);

  // Pricing / approval / save
  const [pricing, setPricing] = useState<PricingResult | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [approvalNeeded, setApprovalNeeded] = useState(false);
  const [approvalRoleName, setApprovalRoleName] = useState<string | null>(null);
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);

  const state = employee?.outletState ?? "Rajasthan";

  // --- data loading, cascaded by selection ---

  useEffect(() => {
    supabase
      .from("models")
      .select("id, name")
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => setModels(data ?? []));
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
      .select("color_id, extra_cost, colors(id, name, hex)")
      .eq("variant_id", variantId)
      .then(({ data }) => {
        const rows = (data ?? []).map((r: Row) => ({
          id: r.colors.id,
          name: r.colors.name,
          extra_cost: r.extra_cost,
        }));
        setColors(rows);
      });
  }, [variantId]);

  useEffect(() => {
    supabase
      .from("rto_categories")
      .select("id, name")
      .order("name")
      .then(({ data }) => setRtoCategories(data ?? []));
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
            if (condition?.mutually_exclusive_group) {
              groups[li.id] = condition.mutually_exclusive_group;
            }
          }
        }
        setSchemeLineItems(items);
        setSchemeGroups(groups);
      });
  }, [modelId]);

  useEffect(() => {
    if (insuranceChoice !== "rajesh_toyota") return;
    supabase
      .from("insurance_plans")
      .select("id, coverage_type, base_rate")
      .then(({ data }) => setInsurancePlans(data ?? []));
    supabase
      .from("insurance_addons")
      .select("id, name, price")
      .then(({ data }) => setInsuranceAddons(data ?? []));
  }, [insuranceChoice]);

  useEffect(() => {
    if (!modelId) return;
    supabase
      .from("accessories")
      .select("id, name, price, variant_id, model_id")
      .or(`variant_id.eq.${variantId ?? "00000000-0000-0000-0000-000000000000"},model_id.eq.${modelId}`)
      .then(({ data }) => setAccessories(data ?? []));
  }, [modelId, variantId]);

  useEffect(() => {
    supabase
      .from("vas_products")
      .select("id, name, price")
      .then(({ data }) => setVasProducts(data ?? []));
  }, []);

  // --- derived option lists ---

  const availableFuelTypes = useMemo(() => {
    const seen = new Map<string, string>();
    for (const v of variantsForModel) {
      if (!seen.has(v.fuel_type_id)) seen.set(v.fuel_type_id, v.fuel_types?.name ?? "");
    }
    return Array.from(seen, ([id, label]) => ({ id, label }));
  }, [variantsForModel]);

  const availableTransmissions = useMemo(() => {
    const filtered = variantsForModel.filter((v) => v.fuel_type_id === fuelTypeId);
    const seen = new Map<string, string>();
    for (const v of filtered) {
      if (!seen.has(v.transmission_id)) seen.set(v.transmission_id, v.transmissions?.name ?? "");
    }
    return Array.from(seen, ([id, label]) => ({ id, label }));
  }, [variantsForModel, fuelTypeId]);

  const availableVariants: PickerOption[] = useMemo(() => {
    return variantsForModel
      .filter((v) => v.fuel_type_id === fuelTypeId && v.transmission_id === transmissionId)
      .map((v) => ({ id: v.id, label: v.name, sublabel: v.suffix }));
  }, [variantsForModel, fuelTypeId, transmissionId]);

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
        // Radio behavior within a mutually-exclusive group.
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
      scrap: isScrapLinkedRto && scrapSource
        ? { source: scrapSource, amount: scrapSource === "Rajesh Toyota" ? Number(scrapAmount) || 0 : 0 }
        : null,
      insurance_plan_id: insuranceChoice === "rajesh_toyota" ? insurancePlanId : null,
      insurance_addon_ids: insuranceChoice === "rajesh_toyota" ? insuranceAddonIds : [],
      accessory_ids: accessoryIds,
      vas_product_ids: vasProductIds,
      selected_scheme_line_item_ids: selectedSchemeIds,
      has_exchange: hasExchange,
      has_scrap: isScrapLinkedRto && !!scrapSource,
    };
  }

  async function runPricingAndSave() {
    setPricingLoading(true);
    setPricingError(null);
    try {
      const result = await priceQuote(buildSelections());
      setPricing(result);

      const requirement = await findApprovalRequirement(
        employee!.outletId,
        result.scheme_discount_customer_facing,
      );

      const { data: inserted, error: insertError } = await supabase
        .from("quotes")
        .insert({
          outlet_id: employee!.outletId,
          employee_id: employee!.id,
          customer_name: customerName,
          customer_phone: customerPhone || null,
          customer_mobile: customerMobile || null,
          variant_id: variantId,
          color_id: colorId,
          rto_category_id: rtoCategoryId,
          insurance_plan_id: insuranceChoice === "rajesh_toyota" ? insurancePlanId : null,
          insurance_addon_ids: insuranceChoice === "rajesh_toyota" ? insuranceAddonIds : [],
          accessory_ids: accessoryIds,
          vas_product_ids: vasProductIds,
          selected_scheme_line_item_ids: selectedSchemeIds,
          priced_snapshot: result,
          total_amount: result.total_amount,
          dealer_margin: result.dealer_margin ?? null,
          priced_as_of: result.priced_as_of,
          status: "draft",
        })
        .select("id")
        .single();

      if (insertError) throw new Error(insertError.message);
      setQuoteId(inserted.id);

      if (requirement) {
        setApprovalNeeded(true);
        setApprovalRoleName(requirement.requiredRoleName);
        await createApprovalRequest({
          quoteId: inserted.id,
          requestedByEmployeeId: employee!.id,
          requiredRoleId: requirement.requiredRoleId,
          discountAmount: result.scheme_discount_customer_facing,
        });
      } else {
        setApprovalNeeded(false);
      }

      setStep(11);
    } catch (e: any) {
      setPricingError(e.message ?? "Failed to price this quote");
    } finally {
      setPricingLoading(false);
    }
  }

  async function handleShare(channel: "pdf" | "whatsapp") {
    if (!pricing || !quoteId || !employee) return;
    setSharing(true);
    try {
      const docData = {
        customerName,
        variantName: selectedVariantName,
        colorName: selectedColorName,
        outletName: employee.outletName ?? "",
        employeeName: employee.name,
        pricing,
      };

      if (channel === "pdf") {
        const html = buildQuoteHtml(docData);
        const uri = await generateQuotePdf(html);
        await uploadQuotePdf(uri, employee.id, quoteId);
        await supabase
          .from("quotes")
          .update({ status: "sent", pdf_storage_path: `${employee.id}/${quoteId}.pdf` })
          .eq("id", quoteId);
        await shareQuotePdfNative(uri);
      } else {
        const message = buildWhatsAppMessage(docData);
        await openWhatsApp(customerMobile || customerPhone, message);
        await supabase.from("quotes").update({ status: "sent" }).eq("id", quoteId);
      }
    } catch (e: any) {
      Alert.alert("Could not share", e.message ?? "Something went wrong");
    } finally {
      setSharing(false);
    }
  }

  // --- step gating ---

  const canProceed: Record<number, boolean> = {
    0: customerName.trim().length > 0,
    1: !!modelId,
    2: !!fuelTypeId,
    3: !!transmissionId,
    4: !!variantId,
    5: !!colorId,
    6: !!rtoCategoryId && (!isScrapLinkedRto || !!scrapSource),
    7: true,
    8: insuranceChoice === "self" || (insuranceChoice === "rajesh_toyota" && !!insurancePlanId),
    9: true,
    10: true,
  };

  function goNext() {
    if (step === 10) {
      runPricingAndSave();
      return;
    }
    setStep((s) => Math.min(s + 1, STEP_TITLES.length - 1));
  }

  function goBack() {
    setStep((s) => Math.max(s - 1, 0));
  }

  // --- render ---

  return (
    <WizardShell
      title={STEP_TITLES[step]}
      stepIndex={step}
      stepCount={STEP_TITLES.length}
      onBack={step > 0 && step !== 12 ? goBack : undefined}
      onNext={step < 11 ? goNext : undefined}
      nextDisabled={step <= 10 ? !canProceed[step] : false}
      nextLoading={pricingLoading && step === 10}
      nextLabel={step === 10 ? "Get Price" : "Continue"}
      hideNext={step === 11 || step === 12}
    >
      {step === 0 && (
        <View className="gap-4">
          <View>
            <Text className="mb-1 text-sm font-medium text-slate-700">Customer Name *</Text>
            <TextInput
              value={customerName}
              onChangeText={setCustomerName}
              className="rounded-lg border border-slate-300 px-4 py-3 text-base"
              placeholder="Full name"
            />
          </View>
          <View>
            <Text className="mb-1 text-sm font-medium text-slate-700">Phone</Text>
            <TextInput
              value={customerPhone}
              onChangeText={setCustomerPhone}
              keyboardType="phone-pad"
              className="rounded-lg border border-slate-300 px-4 py-3 text-base"
            />
          </View>
          <View>
            <Text className="mb-1 text-sm font-medium text-slate-700">Mobile (for WhatsApp)</Text>
            <TextInput
              value={customerMobile}
              onChangeText={setCustomerMobile}
              keyboardType="phone-pad"
              className="rounded-lg border border-slate-300 px-4 py-3 text-base"
            />
          </View>
        </View>
      )}

      {step === 1 && (
        <PickerList
          options={models.map((m) => ({ id: m.id, label: m.name }))}
          selectedId={modelId}
          onSelect={(id) => {
            setModelId(id);
            setFuelTypeId(null);
            setTransmissionId(null);
            setVariantId(null);
            setColorId(null);
          }}
        />
      )}

      {step === 2 && (
        <PickerList
          options={availableFuelTypes}
          selectedId={fuelTypeId}
          onSelect={(id) => {
            setFuelTypeId(id);
            setTransmissionId(null);
            setVariantId(null);
          }}
        />
      )}

      {step === 3 && (
        <PickerList
          options={availableTransmissions}
          selectedId={transmissionId}
          onSelect={(id) => {
            setTransmissionId(id);
            setVariantId(null);
          }}
        />
      )}

      {step === 4 && (
        <PickerList
          options={availableVariants}
          selectedId={variantId}
          onSelect={(id) => {
            setVariantId(id);
            setColorId(null);
          }}
        />
      )}

      {step === 5 && (
        <PickerList
          options={colors.map((c) => ({
            id: c.id,
            label: c.name,
            sublabel: c.extra_cost > 0 ? `+₹${c.extra_cost.toLocaleString("en-IN")}` : undefined,
          }))}
          selectedId={colorId}
          onSelect={setColorId}
        />
      )}

      {step === 6 && (
        <View className="gap-4">
          <PickerList
            options={rtoCategories.map((r) => ({ id: r.id, label: r.name }))}
            selectedId={rtoCategoryId}
            onSelect={(id) => {
              setRtoCategoryId(id);
              setScrapSource(null);
            }}
          />

          {isScrapLinkedRto && (
            <View className="gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <Text className="font-medium text-amber-900">Scrap Certificate</Text>
              <PickerList
                options={[
                  { id: "Self", label: "Self-arranged" },
                  { id: "Rajesh Toyota", label: "Via Rajesh Toyota" },
                ]}
                selectedId={scrapSource}
                onSelect={(id) => setScrapSource(id as "Self" | "Rajesh Toyota")}
              />
              {scrapSource === "Rajesh Toyota" && (
                <>
                  <TextInput
                    value={scrapAmount}
                    onChangeText={setScrapAmount}
                    keyboardType="numeric"
                    placeholder="Scrap bonus amount"
                    className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-base"
                  />
                  <TextInput
                    value={scrapCertificateNumber}
                    onChangeText={setScrapCertificateNumber}
                    placeholder="Certificate number (if available)"
                    className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-base"
                  />
                </>
              )}
            </View>
          )}
        </View>
      )}

      {step === 7 && (
        <View className="gap-3">
          <View className="mb-1 flex-row items-center justify-between rounded-xl border border-slate-200 p-4">
            <Text className="font-medium text-slate-900">Vehicle exchange included?</Text>
            <Switch value={hasExchange} onValueChange={setHasExchange} />
          </View>

          {schemeLineItems.length === 0 ? (
            <Text className="py-6 text-center text-slate-400">No active schemes for this model right now.</Text>
          ) : (
            schemeLineItems.map((item) => {
              const disabled = item.condition?.requires_exchange && !hasExchange;
              return (
                <CheckboxRow
                  key={item.id}
                  label={item.line_type}
                  sublabel={disabled ? "Requires vehicle exchange" : item.condition?.mutually_exclusive_group ? "Choose one" : undefined}
                  checked={selectedSchemeIds.includes(item.id)}
                  onToggle={() => !disabled && toggleScheme(item.id)}
                />
              );
            })
          )}
        </View>
      )}

      {step === 8 && (
        <View className="gap-4">
          <PickerList
            options={[
              { id: "self", label: "Self (customer arranges insurance)" },
              { id: "rajesh_toyota", label: "Via Rajesh Toyota" },
            ]}
            selectedId={insuranceChoice}
            onSelect={(id) => {
              setInsuranceChoice(id as "self" | "rajesh_toyota");
              setInsurancePlanId(null);
              setInsuranceAddonIds([]);
            }}
          />

          {insuranceChoice === "rajesh_toyota" && (
            <>
              <Text className="mt-2 font-medium text-slate-700">Coverage</Text>
              <PickerList
                options={insurancePlans.map((p) => ({ id: p.id, label: p.coverage_type }))}
                selectedId={insurancePlanId}
                onSelect={setInsurancePlanId}
              />

              {insurancePlanId && (
                <>
                  <Text className="mt-2 font-medium text-slate-700">Add-ons</Text>
                  {insuranceAddons.map((addon) => (
                    <CheckboxRow
                      key={addon.id}
                      label={addon.name}
                      sublabel={`₹${addon.price.toLocaleString("en-IN")}`}
                      checked={insuranceAddonIds.includes(addon.id)}
                      onToggle={() => toggleFrom(insuranceAddonIds, setInsuranceAddonIds, addon.id)}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </View>
      )}

      {step === 9 && (
        <View className="gap-2">
          {accessories.length === 0 ? (
            <Text className="py-6 text-center text-slate-400">No accessories configured for this variant.</Text>
          ) : (
            accessories.map((a) => (
              <CheckboxRow
                key={a.id}
                label={a.name}
                sublabel={`₹${a.price.toLocaleString("en-IN")}`}
                checked={accessoryIds.includes(a.id)}
                onToggle={() => toggleFrom(accessoryIds, setAccessoryIds, a.id)}
              />
            ))
          )}
        </View>
      )}

      {step === 10 && (
        <View className="gap-2">
          {vasProducts.length === 0 ? (
            <Text className="py-6 text-center text-slate-400">No VAS products configured.</Text>
          ) : (
            vasProducts.map((v) => (
              <CheckboxRow
                key={v.id}
                label={v.name}
                sublabel={`₹${v.price.toLocaleString("en-IN")}`}
                checked={vasProductIds.includes(v.id)}
                onToggle={() => toggleFrom(vasProductIds, setVasProductIds, v.id)}
              />
            ))
          )}
          {pricingError && <Text className="mt-2 text-sm text-red-600">{pricingError}</Text>}
        </View>
      )}

      {step === 11 && pricing && (
        <View className="gap-4">
          <View className="rounded-xl border border-slate-200 p-4">
            <Text className="text-sm text-slate-500">{selectedModelName} — {selectedVariantName}</Text>
            <Text className="text-sm text-slate-500">{selectedColorName}</Text>
          </View>

          <View className="rounded-xl border border-slate-200 p-4">
            {pricing.line_items.map((item, i) => (
              <View key={i} className="flex-row justify-between py-1.5">
                <Text className="text-slate-600">{item.label}</Text>
                <Text className="text-slate-900">₹{Math.round(item.amount).toLocaleString("en-IN")}</Text>
              </View>
            ))}
            <View className="mt-2 flex-row justify-between border-t border-slate-200 pt-2">
              <Text className="font-semibold text-slate-900">Total</Text>
              <Text className="font-semibold text-slate-900">
                ₹{Math.round(pricing.total_amount).toLocaleString("en-IN")}
              </Text>
            </View>
            {pricing.dealer_margin !== undefined && (
              <View className="mt-1 flex-row justify-between">
                <Text className="text-sm text-slate-400">Dealer Margin</Text>
                <Text className="text-sm text-slate-400">
                  ₹{Math.round(pricing.dealer_margin).toLocaleString("en-IN")}
                </Text>
              </View>
            )}
          </View>

          {approvalNeeded ? (
            <View className="rounded-xl border border-amber-300 bg-amber-50 p-4">
              <Text className="font-medium text-amber-900">Approval required</Text>
              <Text className="mt-1 text-sm text-amber-800">
                This quote&apos;s discount needs approval from a {approvalRoleName} before it can be
                shared with the customer. You&apos;ll be notified once it&apos;s approved.
              </Text>
            </View>
          ) : (
            <View
              className="items-center rounded-lg bg-slate-900 py-3"
              onTouchEnd={() => setStep(12)}
            >
              <Text className="font-medium text-white">Continue to Share</Text>
            </View>
          )}
        </View>
      )}

      {step === 12 && pricing && (
        <View className="gap-3">
          <Text className="text-sm text-slate-500">
            Total: ₹{Math.round(pricing.total_amount).toLocaleString("en-IN")}
          </Text>

          <View
            className={`items-center rounded-lg py-3 ${sharing ? "bg-slate-300" : "bg-emerald-600"}`}
            onTouchEnd={() => !sharing && handleShare("whatsapp")}
          >
            {sharing ? <ActivityIndicator color="#fff" /> : <Text className="font-medium text-white">Share via WhatsApp</Text>}
          </View>

          <View
            className={`items-center rounded-lg border py-3 ${sharing ? "border-slate-200" : "border-slate-900"}`}
            onTouchEnd={() => !sharing && handleShare("pdf")}
          >
            <Text className={`font-medium ${sharing ? "text-slate-400" : "text-slate-900"}`}>Share PDF</Text>
          </View>

          <View className="items-center rounded-lg py-3" onTouchEnd={() => router.replace("/(app)/quotes")}>
            <Text className="font-medium text-slate-500">Done — View My Quotes</Text>
          </View>
        </View>
      )}
    </WizardShell>
  );
}
