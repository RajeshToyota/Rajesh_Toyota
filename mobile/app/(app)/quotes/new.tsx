import { useEffect, useState } from "react";
import { View, Text, TextInput } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/auth-context";
import { WizardShell } from "@/components/wizard-shell";
import { VehicleSelectionStep } from "@/components/vehicle-selection-step";
import { useVehicleSelection, VEHICLE_STEP_TITLES } from "@/hooks/use-vehicle-selection";
import { priceQuote } from "@/lib/pricing";
import { createScrapCertificate, linkScrapCertificate } from "@/lib/scrap";

// The quote starts at its basic (list) price: company schemes and any dealer discount are added
// afterwards, stage by stage with approvals, on the quote's own screen (quotes/[id]).
const SCHEMES_STEP = VEHICLE_STEP_TITLES.indexOf("Schemes");
const QUOTE_VEHICLE_STEPS = VEHICLE_STEP_TITLES.map((_, i) => i).filter((i) => i !== SCHEMES_STEP);
const STEP_TITLES = ["Customer", ...QUOTE_VEHICLE_STEPS.map((i) => VEHICLE_STEP_TITLES[i])];
const LAST_STEP = STEP_TITLES.length - 1;

export default function NewQuoteScreen() {
  const { employee } = useAuth();
  const { enquiryId } = useLocalSearchParams<{ enquiryId?: string }>();
  const [step, setStep] = useState(0);

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerMobile, setCustomerMobile] = useState("");

  const vs = useVehicleSelection(employee?.outletState ?? "Rajasthan");

  // Started from an enquiry: carry over the customer and the model/fuel they asked about.
  const { setModelId, setFuelTypeId } = vs;
  useEffect(() => {
    if (!enquiryId) return;
    supabase
      .from("enquiries")
      .select("model_id, fuel_type_id, customers(name, mobile)")
      .eq("id", enquiryId)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        const customer: any = Array.isArray(data.customers) ? data.customers[0] : data.customers;
        if (customer) {
          setCustomerName(customer.name);
          setCustomerMobile(customer.mobile);
        }
        setModelId(data.model_id);
        if (data.fuel_type_id) setFuelTypeId(data.fuel_type_id);
      });
  }, [enquiryId, setModelId, setFuelTypeId]);

  const [pricingError, setPricingError] = useState<string | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);

  async function runPricingAndSave() {
    setPricingLoading(true);
    setPricingError(null);
    try {
      // Priced without schemes: the basic price. The database prices the row again on insert.
      const result = await priceQuote({ ...vs.buildSelections(), selected_scheme_line_item_ids: [] });

      const { data: inserted, error: insertError } = await supabase
        .from("quotes")
        .insert({
          outlet_id: employee!.outletId,
          employee_id: employee!.id,
          customer_name: customerName,
          customer_phone: customerPhone || null,
          customer_mobile: customerMobile || null,
          enquiry_id: enquiryId ?? null,
          variant_id: vs.variantId,
          color_id: vs.colorId,
          rto_category_id: vs.rtoCategoryId,
          price_list_type: vs.priceListType,
          insurance_option: vs.usesListInsurance ? vs.insuranceOption : null,
          include_extended_warranty: vs.includeExtendedWarranty,
          insurance_plan_id: vs.insuranceChoice === "rajesh_toyota" && !vs.usesListInsurance ? vs.insurancePlanId : null,
          insurance_addon_ids: vs.insuranceChoice === "rajesh_toyota" ? vs.insuranceAddonIds : [],
          accessory_ids: vs.accessoryIds,
          vas_product_ids: vs.vasProductIds,
          priced_snapshot: result,
          total_amount: result.total_amount,
          priced_as_of: result.priced_as_of,
          status: "draft",
        })
        .select("id")
        .single();

      if (insertError) throw new Error(insertError.message);

      // Persist the scrap certificate and link it back onto the quote row, if one was captured.
      if (vs.isScrapLinkedRto && vs.scrapSource) {
        const certId = await createScrapCertificate({
          source: vs.scrapSource,
          amount: vs.scrapSource === "Rajesh Toyota" ? Number(vs.scrapAmount) || 0 : undefined,
          certificateNumber: vs.scrapCertificateNumber,
        });
        await linkScrapCertificate(certId, { quoteId: inserted.id });
        await supabase.from("quotes").update({ scrap_certificate_id: certId }).eq("id", inserted.id);
      }

      router.replace(`/(app)/quotes/${inserted.id}`);
    } catch (e: any) {
      setPricingError(e.message ?? "Failed to price this quote");
    } finally {
      setPricingLoading(false);
    }
  }

  const vehicleStep = (s: number) => QUOTE_VEHICLE_STEPS[s - 1];
  const canProceed = step === 0 ? customerName.trim().length > 0 : vs.stepValid[vehicleStep(step)];

  function goNext() {
    if (step === LAST_STEP) {
      runPricingAndSave();
      return;
    }
    setStep((s) => Math.min(s + 1, STEP_TITLES.length - 1));
  }

  function goBack() {
    setStep((s) => Math.max(s - 1, 0));
  }

  return (
    <WizardShell
      title={STEP_TITLES[step]}
      stepIndex={step}
      stepCount={STEP_TITLES.length}
      onBack={step > 0 ? goBack : undefined}
      onNext={goNext}
      nextDisabled={!canProceed}
      nextLoading={pricingLoading && step === LAST_STEP}
      nextLabel={step === LAST_STEP ? "Get Basic Price" : "Continue"}
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

      {step >= 1 && <VehicleSelectionStep step={vehicleStep(step)} vs={vs} />}

      {step === LAST_STEP && pricingError && <Text className="mt-2 text-sm text-red-600">{pricingError}</Text>}
    </WizardShell>
  );
}
