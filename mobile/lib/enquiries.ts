import { supabase } from "@/lib/supabase";
import type { PickerOption } from "@/components/picker-list";

// Option lists mirror the CHECK constraints in 20261025000001_customers_enquiries.sql. Mode and
// source use CTDMS's own wording so the Phase 7 daily sync can compare them directly.
export const PURPOSE_OPTIONS: PickerOption[] = [
  { id: "new_purchase", label: "New purchase" },
  { id: "test_drive", label: "Test drive" },
  { id: "exchange", label: "Exchange / upgrade" },
  { id: "price_enquiry", label: "Price enquiry" },
  { id: "finance_enquiry", label: "Finance enquiry" },
  { id: "other", label: "Other" },
];

export const MODE_OPTIONS: PickerOption[] = [
  "Walk-in",
  "Dealer CAC Call-In",
  "Dealer CAC Call-Out",
  "TKM Digital",
  "Dealer Digital",
  "Cold Call(visit)",
  "UIO Lead (Service)",
  "Other",
].map((m) => ({ id: m, label: m }));

export const SOURCE_OPTIONS: PickerOption[] = [
  "Referral Existing Customer",
  "Referral Friends/Relatives",
  "Print Advertisement",
  "TKM- Aggregator",
  "Dealer Website",
  "Promotional Mailers/SMS",
  "Other",
].map((s) => ({ id: s, label: s }));

export const TEMPERATURE_OPTIONS: PickerOption[] = [
  { id: "HOT", label: "Hot", sublabel: "Likely to book soon" },
  { id: "WRM", label: "Warm", sublabel: "Interested, comparing" },
  { id: "CLD", label: "Cold", sublabel: "Early stage" },
];

export const STAGE_LABELS: Record<string, string> = {
  open: "Open",
  quoted: "Quoted",
  booked: "Booked",
  lost: "Lost",
};

export function purposeLabel(id: string) {
  return PURPOSE_OPTIONS.find((p) => p.id === id)?.label ?? id;
}

// Same rule as the database's normalize_mobile(): returns the 10-digit number or null.
export function normalizeMobile(input: string): string | null {
  const d = input.replace(/\D/g, "");
  if (/^[6-9]\d{9}$/.test(d)) return d;
  if (/^91[6-9]\d{9}$/.test(d)) return d.slice(2);
  if (/^0[6-9]\d{9}$/.test(d)) return d.slice(1);
  return null;
}

export interface CustomerLookup {
  mobile: string;
  customer: { id: string; name: string } | null;
  open_enquiries: {
    id: string;
    created_at: string;
    stage: string;
    model: string;
    assigned_to: string;
    outlet: string;
    mine: boolean;
  }[];
}

export async function findCustomer(mobile: string): Promise<CustomerLookup | null> {
  const { data, error } = await supabase.rpc("find_customer", { p_mobile: mobile });
  if (error) throw new Error(error.message);
  return data as CustomerLookup | null;
}

export interface NewEnquiry {
  mobile: string;
  name: string;
  email?: string;
  purpose_of_visit: string;
  model_id: string;
  fuel_type_id?: string | null;
  mode: string;
  source_desc?: string | null;
  test_drive_given: boolean;
  temperature: string;
  notes?: string;
  assigned_employee_id?: string | null;
}

export async function createEnquiry(enquiry: NewEnquiry): Promise<string> {
  const { data, error } = await supabase.rpc("create_enquiry", { p: enquiry });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function markEnquiryLost(enquiryId: string, reason: string) {
  const { error } = await supabase.rpc("mark_enquiry_lost", { p_enquiry_id: enquiryId, p_reason: reason });
  if (error) throw new Error(error.message);
}
