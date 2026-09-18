import { View, Text, TextInput, Switch } from "react-native";
import type { BookingForm } from "@/hooks/use-booking-form";

function Field({
  label,
  value,
  onChangeText,
  keyboardType,
  placeholder,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  keyboardType?: "default" | "numeric" | "phone-pad";
  placeholder?: string;
}) {
  return (
    <View>
      <Text className="mb-1 text-sm font-medium text-slate-700">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        placeholder={placeholder}
        className="rounded-lg border border-slate-300 px-4 py-3 text-base"
      />
    </View>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <Text className="mb-1 mt-5 text-xs font-semibold uppercase tracking-wide text-slate-400">{children}</Text>;
}

export function BookingFormFields({ bf }: { bf: BookingForm }) {
  return (
    <View className="gap-3">
      <SectionTitle>Personal Details</SectionTitle>
      <Field label="PAN Number" value={bf.panNumber} onChangeText={bf.setPanNumber} />
      <Field label="Date of Birth (YYYY-MM-DD)" value={bf.dateOfBirth} onChangeText={bf.setDateOfBirth} />
      <Field label="Marital Status" value={bf.maritalStatus} onChangeText={bf.setMaritalStatus} />
      <Field label="Wedding Anniversary (YYYY-MM-DD)" value={bf.weddingAnniversary} onChangeText={bf.setWeddingAnniversary} />
      <Field label="Family Size" value={bf.familySize} onChangeText={bf.setFamilySize} keyboardType="numeric" />
      <Field label="Family Status" value={bf.familyStatus} onChangeText={bf.setFamilyStatus} />
      <Field label="Qualification" value={bf.qualification} onChangeText={bf.setQualification} />
      <Field label="Income Group" value={bf.incomeGroup} onChangeText={bf.setIncomeGroup} />
      <Field label="Occupation" value={bf.occupation} onChangeText={bf.setOccupation} />
      <Field label="Mother's Maiden Name" value={bf.mothersMaidenName} onChangeText={bf.setMothersMaidenName} />
      <Field label="Nominee Name" value={bf.nomineeName} onChangeText={bf.setNomineeName} />

      <SectionTitle>Registration &amp; Purchase Details</SectionTitle>
      <Field label="Registration Type (White/Yellow Board, Permit)" value={bf.registrationType} onChangeText={bf.setRegistrationType} />
      <Field label="Vehicle Booked Type (First Purchase / Additional / Replacement)" value={bf.vehicleBookedType} onChangeText={bf.setVehicleBookedType} />
      {bf.vehicleBookedType.toLowerCase().includes("replace") && (
        <Field label="Replacement Vehicle Details" value={bf.replacementVehicleDetails} onChangeText={bf.setReplacementVehicleDetails} />
      )}
      <Field label="Mode of Purchase (Cash / Own Finance / In-House Finance) *" value={bf.modeOfPurchase} onChangeText={bf.setModeOfPurchase} />
      <Field label="Driving Licence Number" value={bf.drivingLicenceNumber} onChangeText={bf.setDrivingLicenceNumber} />
      <Field label="Likely Delivery Date (YYYY-MM-DD)" value={bf.likelyDeliveryDate} onChangeText={bf.setLikelyDeliveryDate} />

      <View className="mt-3 flex-row items-center justify-between rounded-xl border border-slate-200 p-4">
        <Text className="font-medium text-slate-900">Company Purchase</Text>
        <Switch value={bf.isCompanyPurchase} onValueChange={bf.setIsCompanyPurchase} />
      </View>

      {bf.isCompanyPurchase && (
        <>
          <SectionTitle>Company Purchase Details</SectionTitle>
          <Field label="Company Name *" value={bf.companyName} onChangeText={bf.setCompanyName} />
          <Field label="Company Contact Person" value={bf.companyContactPerson} onChangeText={bf.setCompanyContactPerson} />
          <Field label="Company Designation" value={bf.companyDesignation} onChangeText={bf.setCompanyDesignation} />
        </>
      )}

      <SectionTitle>Payment Details</SectionTitle>
      <Field label="Payment Instrument Type" value={bf.paymentInstrumentType} onChangeText={bf.setPaymentInstrumentType} />
      <Field label="Payment Instrument No." value={bf.paymentInstrumentNo} onChangeText={bf.setPaymentInstrumentNo} />
      <Field label="Payment Date (YYYY-MM-DD)" value={bf.paymentDate} onChangeText={bf.setPaymentDate} />
      <Field label="Payment Amount" value={bf.paymentAmount} onChangeText={bf.setPaymentAmount} keyboardType="numeric" />
      <Field label="Payment Bank Name" value={bf.paymentBankName} onChangeText={bf.setPaymentBankName} />

      <View className="mt-3 flex-row items-center justify-between rounded-xl border border-slate-200 p-4">
        <Text className="flex-1 pr-3 text-slate-900">
          Customer consents to their data being collected and used for this booking *
        </Text>
        <Switch value={bf.dataConsent} onValueChange={bf.setDataConsent} />
      </View>
    </View>
  );
}
