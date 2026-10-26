"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Stage and term changes are checked in the database (20261030000001_finance_cases.sql): only the
// branch's Finance Executive or Outlet Head and above, one stage at a time.

const NUMBER_FIELDS = ["loan_amount", "tenure_months", "roi_percent", "advance_emis", "processing_fee", "do_amount", "disbursed_amount"];
const TEXT_FIELDS = ["application_no", "do_number", "notes", "financier_id", "applicant_type", "finance_type"];
const DATE_FIELDS = ["login_date", "sanction_date", "do_date", "disbursed_date"];

export async function updateFinanceCase(fd: FormData) {
  const caseId = fd.get("case_id") as string;
  const patch: Record<string, string | number> = {};
  for (const key of [...NUMBER_FIELDS, ...TEXT_FIELDS, ...DATE_FIELDS]) {
    const raw = (fd.get(key) as string | null)?.trim();
    if (!raw) continue;
    if (NUMBER_FIELDS.includes(key)) {
      const n = Number(raw.replace(/,/g, ""));
      if (!Number.isFinite(n)) throw new Error(`${key.replace(/_/g, " ")} must be a number`);
      patch[key] = n;
    } else patch[key] = raw;
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_finance_case", { p_case_id: caseId, p: patch });
  if (error) throw new Error(error.message);
  revalidatePath(`/finance/${caseId}`);
  revalidatePath("/finance");
}

export async function moveFinanceCase(fd: FormData) {
  const caseId = fd.get("case_id") as string;
  const supabase = await createClient();
  const { error } = await supabase.rpc("move_finance_case", {
    p_case_id: caseId,
    p_status: fd.get("status") as string,
    p_note: ((fd.get("note") as string | null) ?? "").trim() || null,
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/finance/${caseId}`);
  revalidatePath("/finance");
}
