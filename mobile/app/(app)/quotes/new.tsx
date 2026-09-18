import { useState } from "react";
import { View, Text, TextInput, Alert, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/auth-context";
import { WizardShell } from "@/components/wizard-shell";
import { VehicleSelectionStep } from "@/components/vehicle-selection-step";
import { PriceSummary } from "@/components/price-summary";
import { useVehicleSelection, VEHICLE_STEP_TITLES } from "@/hooks/use-vehicle-selection";
import { priceQuote } from "@/lib/pricing";
import { findApprovalRequirement, createApprovalRequest } from "@/lib/approvals";
import { createScrapCertificate, linkScrapCertificate } from "@/lib/scrap";
import {
  buildQuoteHtml,
  buildWhatsAppMessage,
  generateQuotePdf,
  openWhatsApp,
  shareQuotePdfNative,
  uploadQuotePdf,
} from "@/lib/quote-document";
import { queuePendingUpload } from "@/lib/upload-queue";
import type { PricingResult } from "@/lib/types";

const STEP_TITLES = ["Customer", ...VEHICLE_STEP_TITLES, "Summary", "Share"];

export default function NewQuoteScreen() {
  const { employee } = useAuth();
  const [step, setStep] = useState(0);

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerMobile, setCustomerMobile] = useState("");

  const vs = useVehicleSelection(employee?.outletState ?? "Rajasthan");

  const [pricing, setPricing] = useState<PricingResult | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [approvalNeeded, setApprovalNeeded] = useState(false);
  const [approvalRoleName, setApprovalRoleName] = useState<string | null>(null);
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  const SUMMARY_STEP = 11;
  const SHARE_STEP = 12;

  async function runPricingAndSave() {
    setPricingLoading(true);
    setPricingError(null);
    try {
      const result = await priceQuote(vs.buildSelections());
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
          variant_id: vs.variantId,
          color_id: vs.colorId,
          rto_category_id: vs.rtoCategoryId,
          insurance_plan_id: vs.insuranceChoice === "rajesh_toyota" ? vs.insurancePlanId : null,
          insurance_addon_ids: vs.insuranceChoice === "rajesh_toyota" ? vs.insuranceAddonIds : [],
          accessory_ids: vs.accessoryIds,
          vas_product_ids: vs.vasProductIds,
          selected_scheme_line_item_ids: vs.selectedSchemeIds,
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

      setStep(SUMMARY_STEP);
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
        variantName: vs.selectedVariantName,
        colorName: vs.selectedColorName,
        outletName: employee.outletName ?? "",
        employeeName: employee.name,
        pricing,
      };

      if (channel === "pdf") {
        // Generation and the native share sheet are fully local/offline — only the Storage
        // upload + status update need a network round-trip, so isolate that failure from the
        // rest of the action rather than losing the whole share attempt to a dropped connection.
        const html = buildQuoteHtml(docData);
        const uri = await generateQuotePdf(html);

        try {
          await uploadQuotePdf(uri, employee.id, quoteId);
          await supabase
            .from("quotes")
            .update({ status: "sent", pdf_storage_path: `${employee.id}/${quoteId}.pdf` })
            .eq("id", quoteId);
        } catch {
          await queuePendingUpload({ quoteId, employeeId: employee.id, localUri: uri });
          Alert.alert(
            "Saved for later upload",
            "The PDF is ready to share now, but couldn't be saved to your quote record — it'll upload automatically once you're back online.",
          );
        }

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

  const canProceed: Record<number, boolean> =
    step === 0 ? { 0: customerName.trim().length > 0 } : { [step]: vs.stepValid[step - 1] };

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

  return (
    <WizardShell
      title={STEP_TITLES[step]}
      stepIndex={step}
      stepCount={STEP_TITLES.length}
      onBack={step > 0 && step !== SHARE_STEP ? goBack : undefined}
      onNext={step < SUMMARY_STEP ? goNext : undefined}
      nextDisabled={step <= 10 ? !canProceed[step] : false}
      nextLoading={pricingLoading && step === 10}
      nextLabel={step === 10 ? "Get Price" : "Continue"}
      hideNext={step === SUMMARY_STEP || step === SHARE_STEP}
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

      {step >= 1 && step <= 10 && <VehicleSelectionStep step={step - 1} vs={vs} />}

      {step === 10 && pricingError && <Text className="mt-2 text-sm text-red-600">{pricingError}</Text>}

      {step === SUMMARY_STEP && pricing && (
        <View className="gap-4">
          <View className="rounded-xl border border-slate-200 p-4">
            <Text className="text-sm text-slate-500">{vs.selectedModelName} — {vs.selectedVariantName}</Text>
            <Text className="text-sm text-slate-500">{vs.selectedColorName}</Text>
          </View>

          <PriceSummary pricing={pricing} />

          {approvalNeeded ? (
            <View className="rounded-xl border border-amber-300 bg-amber-50 p-4">
              <Text className="font-medium text-amber-900">Approval required</Text>
              <Text className="mt-1 text-sm text-amber-800">
                This quote&apos;s discount needs approval from a {approvalRoleName} before it can be
                shared with the customer. You&apos;ll be notified once it&apos;s approved.
              </Text>
            </View>
          ) : (
            <View className="items-center rounded-lg bg-slate-900 py-3" onTouchEnd={() => setStep(SHARE_STEP)}>
              <Text className="font-medium text-white">Continue to Share</Text>
            </View>
          )}
        </View>
      )}

      {step === SHARE_STEP && pricing && (
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
