"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";

export async function decideApproval(formData: FormData) {
  const approvalId = formData.get("approval_id") as string;
  const decision = formData.get("decision") as "approved" | "rejected";
  const comment = (formData.get("comment") as string) || null;

  const employee = await getCurrentEmployee();
  if (!employee) throw new Error("Not signed in");

  const supabase = await createClient();
  const { error } = await supabase
    .from("approvals")
    .update({
      status: decision,
      approver_employee_id: employee.id,
      comment,
      decided_at: new Date().toISOString(),
    })
    .eq("id", approvalId);

  if (error) throw new Error(error.message);

  revalidatePath("/reports/approvals");
}
