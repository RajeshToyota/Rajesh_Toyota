import { useEffect, useRef, useState } from "react";
import { View, Text, ActivityIndicator, ScrollView } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/auth-context";
import { priceQuote } from "@/lib/pricing";
import { confirmBooking } from "@/lib/bookings";
import { useBookingForm } from "@/hooks/use-booking-form";
import { BookingFormFields } from "@/components/booking-form-fields";
import { WizardShell } from "@/components/wizard-shell";
import { PriceSummary } from "@/components/price-summary";
import { SignaturePad, type SignaturePadHandle } from "@/components/signature-pad";
import { uploadSignature } from "@/lib/signature";
import type { PricingResult, QuoteSelections } from "@/lib/types";

type Step = "loading" | "diff" | "booking-form" | "signature" | "confirm" | "done" | "error";

function DiffRow({ label, oldAmount, newAmount }: { label: string; oldAmount: number | null; newAmount: number | null }) {
  const changed = oldAmount !== newAmount;
  return (
    <View className={`flex-row items-center justify-between py-2 ${changed ? "bg-amber-50" : ""}`}>
      <Text className="flex-1 text-slate-700">{label}</Text>
      <Text className={`text-sm ${changed ? "text-slate-400 line-through" : "text-slate-400"}`}>
        {oldAmount !== null ? `₹${Math.round(oldAmount).toLocaleString("en-IN")}` : "—"}
      </Text>
      <Text className={`ml-2 text-sm font-medium ${changed ? "text-amber-700" : "text-slate-900"}`}>
        {newAmount !== null ? `₹${Math.round(newAmount).toLocaleString("en-IN")}` : "—"}
      </Text>
    </View>
  );
}

export default function ProceedToBookingScreen() {
  const { quoteId } = useLocalSearchParams<{ quoteId: string }>();
  const { employee } = useAuth();
  const [step, setStep] = useState<Step>("loading");
  const [error, setError] = useState<string | null>(null);

  const [quote, setQuote] = useState<any>(null);
  const [selections, setSelections] = useState<QuoteSelections | null>(null);
  const [oldPricing, setOldPricing] = useState<PricingResult | null>(null);
  const [newPricing, setNewPricing] = useState<PricingResult | null>(null);

  const bf = useBookingForm();
  const signatureRef = useRef<SignaturePadHandle>(null);
  const [confirming, setConfirming] = useState(false);
  const [approvalNeeded, setApprovalNeeded] = useState(false);
  const [approvalRoleName, setApprovalRoleName] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const { data: quoteRow, error: quoteError } = await supabase
        .from("quotes")
        .select("*, outlets(state)")
        .eq("id", quoteId)
        .single();

      if (quoteError || !quoteRow) {
        setError(quoteError?.message ?? "Quote not found");
        setStep("error");
        return;
      }
      setQuote(quoteRow);

      let scrap: QuoteSelections["scrap"] = null;
      if (quoteRow.scrap_certificate_id) {
        const { data: cert } = await supabase
          .from("scrap_certificates")
          .select("source, amount")
          .eq("id", quoteRow.scrap_certificate_id)
          .single();
        if (cert) scrap = { source: cert.source, amount: cert.amount ?? 0 };
      }

      const sel: QuoteSelections = {
        variant_id: quoteRow.variant_id,
        color_id: quoteRow.color_id,
        state: quoteRow.outlets?.state ?? "Rajasthan",
        rto_category_id: quoteRow.rto_category_id,
        scrap,
        insurance_plan_id: quoteRow.insurance_plan_id,
        insurance_addon_ids: quoteRow.insurance_addon_ids ?? [],
        accessory_ids: quoteRow.accessory_ids ?? [],
        vas_product_ids: quoteRow.vas_product_ids ?? [],
        selected_scheme_line_item_ids: quoteRow.selected_scheme_line_item_ids ?? [],
        has_exchange: true, // the quote was already priced with whatever exchange context applied
        has_scrap: !!scrap,
      };
      setSelections(sel);
      setOldPricing(quoteRow.priced_snapshot as PricingResult);

      try {
        // Mandatory re-price as of today (calculate_price defaults as_of_date to current_date).
        const fresh = await priceQuote(sel);
        setNewPricing(fresh);
        setStep("diff");
      } catch (e: any) {
        setError(e.message ?? "Failed to re-price this quote");
        setStep("error");
      }
    }

    load();
  }, [quoteId]);

  async function handleConfirm() {
    if (!employee || !selections || !newPricing) return;
    setConfirming(true);
    setError(null);
    try {
      let signatureUri: string | null = null;
      if (signatureRef.current && !signatureRef.current.isEmpty()) {
        signatureUri = await signatureRef.current.captureAsPngUri();
      }

      const { bookingId, approvalNeeded, approvalRoleName } = await confirmBooking({
        quoteId: quote.id,
        outletId: employee.outletId!,
        employeeId: employee.id,
        selections,
        pricing: newPricing,
        bookingForm: bf.toPayload(),
        signaturePath: null,
      });

      if (signatureUri) {
        const path = await uploadSignature(signatureUri, employee.id, bookingId);
        await supabase.from("bookings").update({ signature_storage_path: path }).eq("id", bookingId);
      }

      if (quote.scrap_certificate_id) {
        await supabase
          .from("scrap_certificates")
          .update({ linked_booking_id: bookingId })
          .eq("id", quote.scrap_certificate_id);
        await supabase.from("bookings").update({ scrap_certificate_id: quote.scrap_certificate_id }).eq("id", bookingId);
      }

      await supabase.from("quotes").update({ status: "converted" }).eq("id", quote.id);

      setApprovalNeeded(approvalNeeded);
      setApprovalRoleName(approvalRoleName);
      setStep("done");
    } catch (e: any) {
      setError(e.message ?? "Failed to confirm this booking");
    } finally {
      setConfirming(false);
    }
  }

  if (step === "loading") {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <ActivityIndicator />
        <Text className="mt-2 text-sm text-slate-500">Re-pricing against today&apos;s master data…</Text>
      </SafeAreaView>
    );
  }

  if (step === "error") {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white px-6">
        <Text className="text-center text-red-600">{error}</Text>
      </SafeAreaView>
    );
  }

  if (step === "diff" && oldPricing && newPricing) {
    const changed = oldPricing.total_amount !== newPricing.total_amount;
    const labels = Array.from(
      new Set([...oldPricing.line_items.map((i) => i.label), ...newPricing.line_items.map((i) => i.label)]),
    );

    return (
      <SafeAreaView edges={["bottom"]} className="flex-1 bg-white">
        <ScrollView contentContainerClassName="p-4 gap-4">
          <Text className="text-lg font-semibold text-slate-900">Price Check</Text>
          <Text className="text-sm text-slate-500">
            Quoted on {new Date(oldPricing.priced_as_of).toLocaleDateString()}, re-priced today against
            live master data.
          </Text>

          {changed ? (
            <View className="rounded-xl border border-amber-300 bg-amber-50 p-3">
              <Text className="font-medium text-amber-900">Pricing has changed since this quote was made</Text>
            </View>
          ) : (
            <View className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
              <Text className="font-medium text-emerald-800">No pricing changes since the quote</Text>
            </View>
          )}

          <View className="rounded-xl border border-slate-200 px-4">
            <View className="flex-row justify-between border-b border-slate-100 py-2">
              <Text className="flex-1 text-xs uppercase text-slate-400">Line Item</Text>
              <Text className="text-xs uppercase text-slate-400">Quoted</Text>
              <Text className="ml-2 text-xs uppercase text-slate-400">Today</Text>
            </View>
            {labels.map((label) => (
              <DiffRow
                key={label}
                label={label}
                oldAmount={oldPricing.line_items.find((i) => i.label === label)?.amount ?? null}
                newAmount={newPricing.line_items.find((i) => i.label === label)?.amount ?? null}
              />
            ))}
            <View className="flex-row justify-between border-t border-slate-200 py-2">
              <Text className="flex-1 font-semibold text-slate-900">Total</Text>
              <Text className="text-sm text-slate-400">₹{Math.round(oldPricing.total_amount).toLocaleString("en-IN")}</Text>
              <Text className="ml-2 font-semibold text-slate-900">₹{Math.round(newPricing.total_amount).toLocaleString("en-IN")}</Text>
            </View>
          </View>

          <View className="items-center rounded-lg bg-slate-900 py-3" onTouchEnd={() => setStep("booking-form")}>
            <Text className="font-medium text-white">Confirm and Proceed to Booking</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (step === "booking-form" || step === "signature" || step === "confirm") {
    const steps: Step[] = ["booking-form", "signature", "confirm"];
    const idx = steps.indexOf(step);
    return (
      <WizardShell
        title={step === "booking-form" ? "Booking Details" : step === "signature" ? "Signature" : "Confirm"}
        stepIndex={idx}
        stepCount={steps.length}
        onBack={() => setStep(idx === 0 ? "diff" : steps[idx - 1])}
        onNext={step === "confirm" ? handleConfirm : () => setStep(steps[idx + 1])}
        nextDisabled={step === "booking-form" && !bf.isValid}
        nextLoading={confirming}
        nextLabel={step === "confirm" ? "Confirm Booking" : "Continue"}
      >
        {step === "booking-form" && <BookingFormFields bf={bf} />}
        {step === "signature" && (
          <View>
            <Text className="mb-2 text-sm text-slate-500">Have the customer sign below to confirm this booking.</Text>
            <SignaturePad ref={signatureRef} />
          </View>
        )}
        {step === "confirm" && newPricing && (
          <View className="gap-4">
            <PriceSummary pricing={newPricing} />
            {error && <Text className="text-sm text-red-600">{error}</Text>}
          </View>
        )}
      </WizardShell>
    );
  }

  if (step === "done" && newPricing) {
    return (
      <SafeAreaView edges={["bottom"]} className="flex-1 bg-white">
        <View className="flex-1 gap-4 p-4">
          <PriceSummary pricing={newPricing} title="Booking Confirmed" />
          {approvalNeeded && (
            <View className="rounded-xl border border-amber-300 bg-amber-50 p-4">
              <Text className="font-medium text-amber-900">Pending approval</Text>
              <Text className="mt-1 text-sm text-amber-800">
                This booking&apos;s discount needs approval from a {approvalRoleName}.
              </Text>
            </View>
          )}
          <View className="items-center rounded-lg bg-slate-900 py-3" onTouchEnd={() => router.replace("/(app)/bookings")}>
            <Text className="font-medium text-white">View My Bookings</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return null;
}
