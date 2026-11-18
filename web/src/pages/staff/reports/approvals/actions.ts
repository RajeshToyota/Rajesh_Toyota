"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// decide_approval() checks the approver's rank and that nobody approves their own request;
// approvals cannot be updated directly.
export async function decideApproval(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("decide_approval", {
    p_approval_id: formData.get("approval_id") as string,
    p_decision: formData.get("decision") as string,
    p_comment: (formData.get("comment") as string) || null,
  });

  if (error) throw new Error(error.message);

  revalidatePath("/reports/approvals");
}
