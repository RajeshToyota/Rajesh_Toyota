"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const optional = (formData: FormData, key: string) => {
  const v = (formData.get(key) as string | null)?.trim();
  return v ? v : null;
};

export async function markEnquiryEntered(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_enquiry_entered_in_ctdms", {
    p_enquiry_id: formData.get("enquiry_id") as string,
    p_ctdms_enquiry_no: optional(formData, "ctdms_no"),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/crm-sync");
}

export async function markBookingEntered(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_booking_entered_in_ctdms", {
    p_booking_id: formData.get("booking_id") as string,
    p_ctdms_order_no: optional(formData, "ctdms_no"),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/crm-sync");
}

export async function createEnquiryFromCtdms(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_enquiry_from_ctdms", {
    p_row_id: formData.get("row_id") as string,
    p_assigned_employee_id: optional(formData, "employee_id"),
    p_model_id: optional(formData, "model_id"),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/crm-sync");
  revalidatePath("/enquiries");
}

// Bulk "Create in our CRM" for every Missing row whose Sales Officer and model resolve on their own.
// Each row is its own RPC call, so one bad row doesn't stop the rest; failures come back by number.
export async function createEnquiriesFromCtdms(rowIds: string[]) {
  const supabase = await createClient();
  const failed: { ctdmsNo: string; message: string }[] = [];
  let created = 0;
  const ids = [...new Set(rowIds)].slice(0, 1000);
  const { data: rows } = await supabase.from("crm_import_rows").select("id, ctdms_no").in("id", ids);
  const noById = new Map((rows ?? []).map((r) => [r.id, r.ctdms_no as string]));
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(
      ids.slice(i, i + 10).map(async (id) => {
        const { error } = await supabase.rpc("create_enquiry_from_ctdms", { p_row_id: id });
        if (error) failed.push({ ctdmsNo: noById.get(id) ?? id, message: error.message });
        else created++;
      }),
    );
  }
  revalidatePath("/crm-sync");
  revalidatePath("/enquiries");
  return { created, failed };
}
