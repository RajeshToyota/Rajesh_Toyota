import type { CurrentEmployee } from "@/lib/auth";

// HR, Business Head and Admin manage staff (can_manage_hr() in 20261102000001_employee_management.sql).
export const canManageHr = (e: CurrentEmployee | null) =>
  e?.roleName === "HR" || (e?.roleRank != null && e.roleRank <= 1);

// Outlet Heads also see their branch's staff, read-only.
export const canSeeHr = (e: CurrentEmployee | null) => canManageHr(e) || (e?.roleRank != null && e.roleRank <= 2);

export const DEPARTMENTS = [
  { id: "sales", name: "Sales" },
  { id: "customer_relations", name: "Customer relations" },
  { id: "accounts", name: "Accounts" },
  { id: "finance", name: "Finance" },
  { id: "insurance_rto", name: "Insurance & RTO" },
  { id: "workshop", name: "Workshop" },
  { id: "hr_admin", name: "HR & admin" },
  { id: "management", name: "Management" },
  { id: "other", name: "Other" },
];

export const ASSET_TYPES = [
  { id: "laptop", name: "Laptop" },
  { id: "mobile_phone", name: "Mobile phone" },
  { id: "sim_card", name: "SIM card" },
  { id: "tablet", name: "Tablet" },
  { id: "id_card", name: "ID card" },
  { id: "uniform", name: "Uniform" },
  { id: "vehicle", name: "Vehicle" },
  { id: "other", name: "Other" },
];

export const DOCUMENT_KINDS = [
  { id: "photo", name: "Photo" },
  { id: "pan", name: "PAN card" },
  { id: "aadhaar", name: "Aadhaar card" },
  { id: "bank_proof", name: "Cancelled cheque / passbook" },
  { id: "resume", name: "Résumé" },
  { id: "education", name: "Education certificate" },
  { id: "offer_letter", name: "Offer letter" },
  { id: "appointment_letter", name: "Appointment letter" },
  { id: "previous_relieving", name: "Previous employer's relieving letter" },
  { id: "relieving_letter", name: "Our relieving letter" },
  { id: "other", name: "Other" },
];

export const label = (list: { id: string; name: string }[], id: string | null | undefined) =>
  list.find((x) => x.id === id)?.name ?? id ?? "—";

export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-IN") : "—");

export const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

type Option = { id: string; name: string };

export function employeeInputs(roles: Option[], outlets: Option[], managers: Option[]) {
  return [
    { key: "name", label: "Full name", required: true },
    { key: "employee_code", label: "Employee code" },
    { key: "phone", label: "Mobile", type: "tel" as const },
    { key: "email", label: "Work email (used for the CRM login)", type: "email" as const },
    { key: "role_id", label: "CRM role", options: roles, required: true },
    { key: "designation", label: "Designation" },
    { key: "department", label: "Department", options: DEPARTMENTS },
    { key: "outlet_id", label: "Branch", options: outlets },
    { key: "reports_to_employee_id", label: "Reports to", options: managers },
    { key: "joining_date", label: "Joining date", type: "date" as const },
    { key: "date_of_birth", label: "Date of birth", type: "date" as const },
    { key: "ctdms_name", label: "Name in CTDMS (sales staff)" },
    { key: "emergency_contact_name", label: "Emergency contact" },
    { key: "emergency_contact_phone", label: "Emergency contact mobile", type: "tel" as const },
  ];
}

export const PRIVATE_INPUTS = [
  { key: "pan", label: "PAN" },
  { key: "aadhaar_last4", label: "Aadhaar (last 4 digits only)" },
  { key: "bank_account_name", label: "Bank account name" },
  { key: "bank_account_no", label: "Bank account number" },
  { key: "bank_ifsc", label: "IFSC" },
  { key: "bank_name", label: "Bank" },
  { key: "personal_email", label: "Personal email", type: "email" as const },
  { key: "current_address", label: "Current address", type: "textarea" as const },
  { key: "permanent_address", label: "Permanent address", type: "textarea" as const },
];
