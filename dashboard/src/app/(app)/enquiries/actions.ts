"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface EnquiryFormState {
  error: string | null;
}

const optional = (formData: FormData, key: string) => {
  const v = (formData.get(key) as string | null)?.trim();
  return v ? v : null;
};

export async function createEnquiry(_prev: EnquiryFormState, formData: FormData): Promise<EnquiryFormState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_enquiry", {
    p: {
      mobile: optional(formData, "mobile"),
      name: optional(formData, "name"),
      email: optional(formData, "email"),
      address: optional(formData, "address"),
      pin: optional(formData, "pin"),
      purpose_of_visit: optional(formData, "purpose_of_visit"),
      model_id: optional(formData, "model_id"),
      fuel_type_id: optional(formData, "fuel_type_id"),
      mode: optional(formData, "mode"),
      source_desc: optional(formData, "source_desc"),
      test_drive_given: formData.get("test_drive_given") === "on",
      temperature: optional(formData, "temperature"),
      notes: optional(formData, "notes"),
      assigned_employee_id: optional(formData, "assigned_employee_id"),
    },
  });

  if (error) return { error: error.message };

  revalidatePath("/enquiries");
  redirect("/enquiries");
}

export async function reassignEnquiry(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("reassign_enquiry", {
    p_enquiry_id: formData.get("enquiry_id") as string,
    p_employee_id: formData.get("employee_id") as string,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/enquiries");
}

export async function markEnquiryLost(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_enquiry_lost", {
    p_enquiry_id: formData.get("enquiry_id") as string,
    p_reason: formData.get("reason") as string,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/enquiries");
}
