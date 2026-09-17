import { useState } from "react";

// Order Booking Form fields not already captured by the quote/selection flow (spec section 3.9),
// grouped for the UI: Personal Details -> Registration & Purchase Details -> Payment Details ->
// Company Purchase (shown only if is_company_purchase).
export function useBookingForm() {
  const [panNumber, setPanNumber] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState(""); // YYYY-MM-DD
  const [maritalStatus, setMaritalStatus] = useState("");
  const [weddingAnniversary, setWeddingAnniversary] = useState("");
  const [familySize, setFamilySize] = useState("");
  const [familyStatus, setFamilyStatus] = useState("");
  const [qualification, setQualification] = useState("");
  const [incomeGroup, setIncomeGroup] = useState("");
  const [occupation, setOccupation] = useState("");

  const [registrationType, setRegistrationType] = useState("");
  const [vehicleBookedType, setVehicleBookedType] = useState("");
  const [replacementVehicleDetails, setReplacementVehicleDetails] = useState("");
  const [modeOfPurchase, setModeOfPurchase] = useState("");
  const [nomineeName, setNomineeName] = useState("");
  const [mothersMaidenName, setMothersMaidenName] = useState("");
  const [drivingLicenceNumber, setDrivingLicenceNumber] = useState("");
  const [likelyDeliveryDate, setLikelyDeliveryDate] = useState("");

  const [isCompanyPurchase, setIsCompanyPurchase] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [companyContactPerson, setCompanyContactPerson] = useState("");
  const [companyDesignation, setCompanyDesignation] = useState("");

  const [paymentInstrumentType, setPaymentInstrumentType] = useState("");
  const [paymentInstrumentNo, setPaymentInstrumentNo] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentBankName, setPaymentBankName] = useState("");

  const [dataConsent, setDataConsent] = useState(false);

  const isValid =
    dataConsent &&
    modeOfPurchase.trim().length > 0 &&
    (!isCompanyPurchase || companyName.trim().length > 0);

  function toPayload() {
    return {
      pan_number: panNumber || null,
      date_of_birth: dateOfBirth || null,
      marital_status: maritalStatus || null,
      wedding_anniversary: weddingAnniversary || null,
      family_size: familySize ? Number(familySize) : null,
      family_status: familyStatus || null,
      qualification: qualification || null,
      income_group: incomeGroup || null,
      occupation: occupation || null,
      registration_type: registrationType || null,
      vehicle_booked_type: vehicleBookedType || null,
      replacement_vehicle_details: replacementVehicleDetails || null,
      mode_of_purchase: modeOfPurchase || null,
      nominee_name: nomineeName || null,
      mothers_maiden_name: mothersMaidenName || null,
      driving_licence_number: drivingLicenceNumber || null,
      likely_delivery_date: likelyDeliveryDate || null,
      is_company_purchase: isCompanyPurchase,
      company_name: isCompanyPurchase ? companyName || null : null,
      company_contact_person: isCompanyPurchase ? companyContactPerson || null : null,
      company_designation: isCompanyPurchase ? companyDesignation || null : null,
      payment_instrument_type: paymentInstrumentType || null,
      payment_instrument_no: paymentInstrumentNo || null,
      payment_date: paymentDate || null,
      payment_amount: paymentAmount ? Number(paymentAmount) : null,
      payment_bank_name: paymentBankName || null,
      data_consent: dataConsent,
    };
  }

  return {
    panNumber, setPanNumber,
    dateOfBirth, setDateOfBirth,
    maritalStatus, setMaritalStatus,
    weddingAnniversary, setWeddingAnniversary,
    familySize, setFamilySize,
    familyStatus, setFamilyStatus,
    qualification, setQualification,
    incomeGroup, setIncomeGroup,
    occupation, setOccupation,
    registrationType, setRegistrationType,
    vehicleBookedType, setVehicleBookedType,
    replacementVehicleDetails, setReplacementVehicleDetails,
    modeOfPurchase, setModeOfPurchase,
    nomineeName, setNomineeName,
    mothersMaidenName, setMothersMaidenName,
    drivingLicenceNumber, setDrivingLicenceNumber,
    likelyDeliveryDate, setLikelyDeliveryDate,
    isCompanyPurchase, setIsCompanyPurchase,
    companyName, setCompanyName,
    companyContactPerson, setCompanyContactPerson,
    companyDesignation, setCompanyDesignation,
    paymentInstrumentType, setPaymentInstrumentType,
    paymentInstrumentNo, setPaymentInstrumentNo,
    paymentDate, setPaymentDate,
    paymentAmount, setPaymentAmount,
    paymentBankName, setPaymentBankName,
    dataConsent, setDataConsent,
    isValid,
    toPayload,
  };
}

export type BookingForm = ReturnType<typeof useBookingForm>;
