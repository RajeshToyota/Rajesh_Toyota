import { useRef, useState } from "react";
import { View, Text, TextInput } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@/contexts/auth-context";
import { supabase } from "@/lib/supabase";
import { WizardShell } from "@/components/wizard-shell";
import { VehicleSelectionStep } from "@/components/vehicle-selection-step";
import { BookingFormFields } from "@/components/booking-form-fields";
import { PriceSummary } from "@/components/price-summary";
import { SignaturePad, type SignaturePadHandle } from "@/components/signature-pad";
import { useVehicleSelection, VEHICLE_STEP_TITLES } from "@/hooks/use-vehicle-selection";
import { useBookingForm } from "@/hooks/use-booking-form";
import { priceQuote } from "@/lib/pricing";
import { createScrapCertificate, linkScrapCertificate } from "@/lib/scrap";
import { uploadSignature } from "@/lib/signature";
import { confirmBooking } from "@/lib/bookings";
import type { PricingResult } from "@/lib/types";

const STEP_TITLES = ["Customer", ...VEHICLE_STEP_TITLES, "Booking Details", "Signature", "Confirm", "Done"];
const BOOKING_FORM_STEP = 11;
const SIGNATURE_STEP = 12;
const CONFIRM_STEP = 13;
const DONE_STEP = 14;

export default function NewBookingScreen() {
  const { employee } = useAuth();
  const [step, setStep] = useState(0);

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerMobile, setCustomerMobile] = useState("");

  const vs = useVehicleSelection(employee?.outletState ?? "Rajasthan");
  const bf = useBookingForm();
  const signatureRef = useRef<SignaturePadHandle>(null);

  const [pricing, setPricing] = useState<PricingResult | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [approvalNeeded, setApprovalNeeded] = useState(false);
  const [approvalRoleName, setApprovalRoleName] = useState<string | null>(null);
  const [signatureCaptured, setSignatureCaptured] = useState(false);

  async function handleConfirm() {
    if (!employee) return;
    setConfirming(true);
    setPricingError(null);
    try {
      const selections = vs.buildSelections();
      const result = await priceQuote(selections);
      setPricing(result);

      let signaturePath: string | null = null;
      if (signatureRef.current && !signatureRef.current.isEmpty()) {
        const uri = await signatureRef.current.captureAsPngUri();
        // Use a temporary id for the path prefix; re-uploaded under the real booking id below
        // isn't necessary since storage path only needs to be stable per employee/booking, and
        // we don't have the booking id until after insert — so capture now, upload after insert.
        signaturePath = uri;
      }

      const { bookingId, approvalNeeded, approvalRoleName } = await confirmBooking({
        outletId: employee.outletId!,
        employeeId: employee.id,
        selections,
        pricing: result,
        bookingForm: bf.toPayload(),
        signaturePath: null,
      });

      if (signaturePath) {
        const path = await uploadSignature(signaturePath, employee.id, bookingId);
        await supabase.from("bookings").update({ signature_storage_path: path }).eq("id", bookingId);
      }

      if (vs.isScrapLinkedRto && vs.scrapSource) {
        const certId = await createScrapCertificate({
          source: vs.scrapSource,
          amount: vs.scrapSource === "Rajesh Toyota" ? Number(vs.scrapAmount) || 0 : undefined,
          certificateNumber: vs.scrapCertificateNumber,
        });
        await linkScrapCertificate(certId, { bookingId });
        await supabase.from("bookings").update({ scrap_certificate_id: certId }).eq("id", bookingId);
      }

      setApprovalNeeded(approvalNeeded);
      setApprovalRoleName(approvalRoleName);
      setStep(DONE_STEP);
    } catch (e: any) {
      setPricingError(e.message ?? "Failed to confirm this booking");
    } finally {
      setConfirming(false);
    }
  }

  const canProceed: Record<number, boolean> = {
    0: customerName.trim().length > 0,
    [BOOKING_FORM_STEP]: bf.isValid,
    [SIGNATURE_STEP]: signatureCaptured || true, // signature is best-effort; not blocking
  };
  if (step >= 1 && step <= 10) canProceed[step] = vs.stepValid[step - 1];

  function goNext() {
    if (step === CONFIRM_STEP) {
      handleConfirm();
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
      onBack={step > 0 && step !== DONE_STEP ? goBack : undefined}
      onNext={step < DONE_STEP ? goNext : undefined}
      nextDisabled={!(canProceed[step] ?? true)}
      nextLoading={confirming && step === CONFIRM_STEP}
      nextLabel={step === CONFIRM_STEP ? "Confirm Booking" : "Continue"}
      hideNext={step === DONE_STEP}
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
            <Text className="mb-1 text-sm font-medium text-slate-700">Mobile</Text>
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

      {step === BOOKING_FORM_STEP && <BookingFormFields bf={bf} />}

      {step === SIGNATURE_STEP && (
        <View>
          <Text className="mb-2 text-sm text-slate-500">
            Have the customer sign below to confirm this booking.
          </Text>
          <SignaturePad ref={signatureRef} />
        </View>
      )}

      {step === CONFIRM_STEP && (
        <View className="gap-4">
          <View className="rounded-xl border border-slate-200 p-4">
            <Text className="text-sm text-slate-500">{vs.selectedModelName} — {vs.selectedVariantName}</Text>
            <Text className="text-sm text-slate-500">{vs.selectedColorName}</Text>
            <Text className="mt-1 text-sm text-slate-500">Customer: {customerName}</Text>
          </View>
          <Text className="text-sm text-slate-500">
            Tapping Confirm Booking will re-price against today&apos;s live master data and create
            the booking record.
          </Text>
          {pricingError && <Text className="text-sm text-red-600">{pricingError}</Text>}
        </View>
      )}

      {step === DONE_STEP && pricing && (
        <View className="gap-4">
          <PriceSummary pricing={pricing} title="Booking Confirmed" />

          {approvalNeeded && (
            <View className="rounded-xl border border-amber-300 bg-amber-50 p-4">
              <Text className="font-medium text-amber-900">Pending approval</Text>
              <Text className="mt-1 text-sm text-amber-800">
                This booking&apos;s discount needs approval from a {approvalRoleName}. It has been
                recorded but will need sign-off before it can proceed further.
              </Text>
            </View>
          )}

          <View className="items-center rounded-lg bg-slate-900 py-3" onTouchEnd={() => router.replace("/(app)/bookings")}>
            <Text className="font-medium text-white">View My Bookings</Text>
          </View>
        </View>
      )}
    </WizardShell>
  );
}
