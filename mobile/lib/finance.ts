import { supabase } from "@/lib/supabase";
import { uploadBookingFile } from "@/lib/docket";

// Finance cases (20261030000001_finance_cases.sql). The consultant opens the case and collects the
// documents; the branch's Finance Executive works the terms and stages on the dashboard.

export type FinanceStatus = "docs_pending" | "logged_in" | "sanctioned" | "do_received" | "disbursed" | "rejected";
export type ApplicantType = "salaried" | "self_employed" | "company";

export const FINANCE_STAGES: { id: FinanceStatus; label: string }[] = [
  { id: "docs_pending", label: "Documents pending" },
  { id: "logged_in", label: "Logged in" },
  { id: "sanctioned", label: "Sanctioned" },
  { id: "do_received", label: "DO received" },
  { id: "disbursed", label: "Disbursed" },
];
export const financeStageLabel = (s: string) =>
  s === "rejected" ? "Rejected" : (FINANCE_STAGES.find((x) => x.id === s)?.label ?? s);

export const APPLICANT_TYPES: { id: ApplicantType; label: string }[] = [
  { id: "salaried", label: "Salaried" },
  { id: "self_employed", label: "Self-employed" },
  { id: "company", label: "Company / firm" },
];

export interface FinanceCase {
  id: string;
  booking_id: string;
  status: FinanceStatus;
  finance_type: "in_house" | "own";
  applicant_type: ApplicantType;
  application_no: string | null;
  loan_amount: number | null;
  tenure_months: number | null;
  roi_percent: number | null;
  emi: number | null;
  do_number: string | null;
  do_amount: number | null;
  disbursed_amount: number | null;
  rejection_reason: string | null;
  created_at: string;
  financiers: { name: string } | null;
}

export interface FinanceDocType {
  id: string;
  label: string;
  applicant_types: string[];
  required_for: string[];
  sort_order: number;
}

export interface FinanceDocument {
  id: string;
  doc_type: string;
  label: string | null;
  storage_path: string | null;
  collected_on_paper: boolean;
}

const CASE_FIELDS =
  "id, booking_id, status, finance_type, applicant_type, application_no, loan_amount, tenure_months, roi_percent, emi, " +
  "do_number, do_amount, disbursed_amount, rejection_reason, created_at, financiers(name)";

// The live case first, then earlier rejected ones.
export async function loadCases(bookingId: string): Promise<FinanceCase[]> {
  const { data, error } = await supabase
    .from("finance_cases")
    .select(CASE_FIELDS)
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  const cases = (data ?? []) as unknown as FinanceCase[];
  return cases.sort((a, b) => Number(a.status === "rejected") - Number(b.status === "rejected"));
}

export async function loadFinanciers(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase.from("financiers").select("id, name, is_captive").eq("is_active", true).order("is_captive", { ascending: false }).order("name");
  if (error) throw new Error(error.message);
  return (data ?? []).map((f) => ({ id: f.id, name: f.name }));
}

export async function loadDocTypes(): Promise<FinanceDocType[]> {
  const { data, error } = await supabase.from("finance_document_types").select("*").order("sort_order");
  if (error) throw new Error(error.message);
  return (data ?? []) as FinanceDocType[];
}

export async function loadFinanceDocuments(caseId: string): Promise<FinanceDocument[]> {
  const { data, error } = await supabase
    .from("finance_documents")
    .select("id, doc_type, label, storage_path, collected_on_paper")
    .eq("case_id", caseId)
    .order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as FinanceDocument[];
}

export async function openCase(bookingId: string, financierId: string, applicantType: ApplicantType, financeType: "in_house" | "own") {
  const { error } = await supabase.rpc("open_finance_case", {
    p_booking_id: bookingId,
    p_financier_id: financierId,
    p_applicant_type: applicantType,
    p_finance_type: financeType,
  });
  if (error) throw new Error(error.message);
}

export async function addFinancePhoto(params: {
  caseId: string;
  bookingId: string;
  docType: string;
  label?: string;
  localUri: string;
  mimeType?: string | null;
}) {
  const contentType = params.mimeType || "image/jpeg";
  const ext = contentType === "image/png" ? "png" : contentType === "application/pdf" ? "pdf" : "jpg";
  const path = `${params.bookingId}/finance/${params.docType}-${Date.now()}.${ext}`;
  await uploadBookingFile(path, params.localUri, contentType);
  const { error } = await supabase
    .from("finance_documents")
    .insert({ case_id: params.caseId, doc_type: params.docType, label: params.label || null, storage_path: path });
  if (error) throw new Error(error.message);
}

export async function markFinanceDocOnPaper(caseId: string, docType: string, label?: string) {
  const { error } = await supabase
    .from("finance_documents")
    .insert({ case_id: caseId, doc_type: docType, label: label || null, collected_on_paper: true });
  if (error) throw new Error(error.message);
}

export async function removeFinanceDocument(doc: FinanceDocument) {
  const { error } = await supabase.from("finance_documents").delete().eq("id", doc.id);
  if (error) throw new Error(error.message);
  if (doc.storage_path) await supabase.storage.from("booking-documents").remove([doc.storage_path]);
}
