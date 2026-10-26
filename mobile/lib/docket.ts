import { supabase } from "@/lib/supabase";
import type { PricingResult } from "@/lib/types";

// Welcome Docket (20261028000001_welcome_dockets.sql). One per booking; opened (and prefilled) by
// open_welcome_docket(), saved field by field through RLS, and marked complete only by
// complete_welcome_docket(), which returns what is still missing. Files live in the
// booking-documents bucket under `<booking_id>/`.

const BUCKET = "booking-documents";

export const DOC_TYPES: { id: string; label: string; required?: boolean }[] = [
  { id: "photo", label: "Passport Size Photograph", required: true },
  { id: "aadhaar", label: "Aadhar Card", required: true },
  { id: "pan_or_voter_id", label: "PAN Card / Voter ID", required: true },
  { id: "passport_or_driving_licence", label: "Passport / Driving License" },
  { id: "telephone_bill", label: "Telephone Bill" },
  { id: "salary_slips", label: "Latest 3 months Salary slip" },
  { id: "form_16", label: "Form 16" },
  { id: "bank_statement", label: "Bank Statement (last 6 months)" },
  { id: "it_returns", label: "IT Returns (last 2 yrs)" },
  { id: "balance_sheet", label: "Audited Balance Sheet (2 yrs) / Banker's Verifications / Passbook (12 months)" },
  { id: "signature_verification", label: "Signature Verification / Down Payment receipt / Employer's Certificate / Board Resolution" },
  { id: "memorandum", label: "Memorandum of Article / Statement of Loan Accounts / Proposal Form" },
  { id: "partnership_deed", label: "Partnership Deed copy" },
  { id: "partner_authority_letter", label: "Partner's Authority Letter" },
  { id: "ncb_certificate", label: "NCB Certificate" },
  { id: "employment_letter", label: "Letter of Employment" },
  { id: "other", label: "Others (not mentioned above)" },
];

export const docTypeLabel = (id: string) => DOC_TYPES.find((d) => d.id === id)?.label ?? id;

export interface AccessoryOrderItem {
  accessory_id: string;
  name?: string;
  part_no?: string | null;
  qty: number;
  price?: number;
  amount?: number;
}

export interface Referral {
  name?: string;
  occupation?: string;
  phone?: string;
  address?: string;
  car_owned?: string;
}

export interface Docket {
  id: string;
  booking_id: string;
  status: "draft" | "complete";
  mobile: string | null;
  alt_phone: string | null;
  email: string | null;
  communication_address: string | null;
  address_type: "residence" | "office" | null;
  pin: string | null;
  father_or_husband_name: string | null;
  registration_address: string | null;
  hypothecated_to: string | null;
  insurance_coverage: "in_house" | "by_party" | null;
  registration_period: "permanent" | "temporary" | null;
  rto_location: string | null;
  registration_use: "private" | "commercial" | null;
  permit_type: "state" | "all_india" | null;
  special_registration_number: string | null;
  registration_date: string | null;
  delivery_at: string | null;
  delivery_place: string | null;
  temp_registration_validity_days: number | null;
  rc_days: number | null;
  hsrp_days: number | null;
  accessory_order_items: AccessoryOrderItem[];
  accessories_total: number;
  accessories_advance: number;
  accessories_payment_mode: "cash" | "card" | null;
  utrust_interest: boolean;
  tconnect_interest: boolean;
  extended_warranty_interest: boolean;
  smiles_interest: boolean;
  referrals: Referral[];
  terms_accepted: boolean;
  rto_terms_accepted: boolean;
  customer_signature_path: string | null;
  consultant_signature_path: string | null;
  pdf_storage_path: string | null;
  completed_at: string | null;
  reopened_reason: string | null;
}

export interface DocketDocument {
  id: string;
  doc_type: string;
  label: string | null;
  storage_path: string | null;
  collected_on_paper: boolean;
  created_at: string;
}

// The booking fields the docket screens and PDF show.
export interface DocketBooking {
  id: string;
  order_booking_no: string | null;
  ctdms_order_booking_no: string | null;
  ctdms_enquiry_no: string | null;
  customer_name: string | null;
  customer_mobile: string | null;
  status: string;
  total_amount: number | null;
  priced_snapshot: PricingResult | null;
  mode_of_purchase: string | null;
  pan_number: string | null;
  date_of_birth: string | null;
  occupation: string | null;
  nominee_name: string | null;
  mothers_maiden_name: string | null;
  is_company_purchase: boolean;
  company_name: string | null;
  payment_instrument_type: string | null;
  payment_instrument_no: string | null;
  payment_date: string | null;
  payment_amount: number | null;
  payment_bank_name: string | null;
  likely_delivery_date: string | null;
  data_consent: boolean;
  created_at: string;
  variants: { name: string; suffix: string | null; model_id: string; models: { name: string } | null } | null;
  colors: { name: string } | null;
  outlets: { name: string; address: string | null } | null;
  employees: { name: string } | null;
}

const BOOKING_FIELDS =
  "id, order_booking_no, ctdms_order_booking_no, ctdms_enquiry_no, customer_name, customer_mobile, status, total_amount, " +
  "priced_snapshot, mode_of_purchase, pan_number, date_of_birth, occupation, nominee_name, mothers_maiden_name, " +
  "is_company_purchase, company_name, payment_instrument_type, payment_instrument_no, payment_date, payment_amount, " +
  "payment_bank_name, likely_delivery_date, data_consent, created_at, variants(name, suffix, model_id, models(name)), " +
  "colors(name), outlets(name, address), employees!bookings_employee_id_fkey(name)";

export async function loadBooking(bookingId: string): Promise<DocketBooking> {
  const { data, error } = await supabase.from("bookings").select(BOOKING_FIELDS).eq("id", bookingId).single();
  if (error) throw new Error(error.message);
  return data as unknown as DocketBooking;
}

export async function findDocket(bookingId: string): Promise<Docket | null> {
  const { data, error } = await supabase.from("welcome_dockets").select("*").eq("booking_id", bookingId).maybeSingle();
  if (error) throw new Error(error.message);
  return data as Docket | null;
}

export async function openDocket(bookingId: string): Promise<Docket> {
  const { data: id, error } = await supabase.rpc("open_welcome_docket", { p_booking_id: bookingId });
  if (error) throw new Error(error.message);
  const { data, error: loadError } = await supabase.from("welcome_dockets").select("*").eq("id", id).single();
  if (loadError) throw new Error(loadError.message);
  return data as Docket;
}

// Saves the given fields and returns the stored row (the database recomputes the accessories order).
export async function saveDocket(docketId: string, patch: Partial<Docket>): Promise<Docket> {
  const { data, error } = await supabase.from("welcome_dockets").update(patch).eq("id", docketId).select("*").single();
  if (error) throw new Error(error.message);
  return data as Docket;
}

export async function completeDocket(docketId: string): Promise<{ completed: boolean; missing: string[] }> {
  const { data, error } = await supabase.rpc("complete_welcome_docket", { p_docket_id: docketId });
  if (error) throw new Error(error.message);
  return { completed: !!data?.completed, missing: (data?.missing ?? []) as string[] };
}

export async function loadDocuments(docketId: string): Promise<DocketDocument[]> {
  const { data, error } = await supabase
    .from("docket_documents")
    .select("id, doc_type, label, storage_path, collected_on_paper, created_at")
    .eq("docket_id", docketId)
    .order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as DocketDocument[];
}

async function uploadFile(path: string, localUri: string, contentType: string) {
  const response = await fetch(localUri);
  const blob = await response.blob();
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType, upsert: true });
  if (error) throw new Error(error.message);
}

export async function addDocumentPhoto(params: {
  docketId: string;
  bookingId: string;
  docType: string;
  label?: string;
  localUri: string;
  mimeType?: string | null;
}) {
  const contentType = params.mimeType || "image/jpeg";
  const ext = contentType === "image/png" ? "png" : contentType === "application/pdf" ? "pdf" : "jpg";
  const path = `${params.bookingId}/documents/${params.docType}-${Date.now()}.${ext}`;
  await uploadFile(path, params.localUri, contentType);
  const { error } = await supabase.from("docket_documents").insert({
    docket_id: params.docketId,
    doc_type: params.docType,
    label: params.label || null,
    storage_path: path,
  });
  if (error) throw new Error(error.message);
}

export async function markCollectedOnPaper(docketId: string, docType: string, label?: string) {
  const { error } = await supabase
    .from("docket_documents")
    .insert({ docket_id: docketId, doc_type: docType, label: label || null, collected_on_paper: true });
  if (error) throw new Error(error.message);
}

export async function removeDocument(doc: DocketDocument) {
  const { error } = await supabase.from("docket_documents").delete().eq("id", doc.id);
  if (error) throw new Error(error.message);
  if (doc.storage_path) await supabase.storage.from(BUCKET).remove([doc.storage_path]);
}

export async function saveSignature(
  docketId: string,
  bookingId: string,
  who: "customer" | "consultant",
  localUri: string,
): Promise<Docket> {
  const path = `${bookingId}/signatures/${who}.png`;
  await uploadFile(path, localUri, "image/png");
  return saveDocket(docketId, who === "customer" ? { customer_signature_path: path } : { consultant_signature_path: path });
}

export async function uploadDocketPdf(docketId: string, bookingId: string, localUri: string): Promise<string> {
  const path = `${bookingId}/welcome-docket.pdf`;
  await uploadFile(path, localUri, "application/pdf");
  await saveDocket(docketId, { pdf_storage_path: path });
  return path;
}

// Reads a stored file as a data: URL so it can be embedded in the PDF without network access.
export async function fileAsDataUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(data);
  });
}

export async function signedUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(path, 600);
  return data?.signedUrl ?? null;
}

export interface AccessoryOption {
  id: string;
  name: string;
  part_no: string | null;
  price: number;
  category: string | null;
}

// Active Toyota Genuine Accessories for this model, for the Accessories Order Form.
export async function loadAccessoryOptions(modelId: string): Promise<AccessoryOption[]> {
  const { data, error } = await supabase
    .from("accessories")
    .select("id, name, part_no, price, category")
    .eq("model_id", modelId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []).map((a) => ({ ...a, price: Number(a.price) })) as AccessoryOption[];
}
