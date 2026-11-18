"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Everything is checked in the database (20261102000001_employee_management.sql): only HR and the
// Business Head / Admin manage staff, and HR can never touch the top roles. Login invites and closing a
// leaver's login need the service key, so they run in the employee-login edge function, which makes
// the same check first.

const str = (fd: FormData, key: string) => {
  const v = (fd.get(key) as string | null)?.trim();
  return v ? v : null;
};

async function call(name: string, args: Record<string, unknown>, employeeId: string | null) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  if (employeeId) revalidatePath(`/hr/${employeeId}`);
  revalidatePath("/hr");
  return data;
}

const EMPLOYEE_KEYS = [
  "name", "phone", "email", "role_id", "outlet_id", "reports_to_employee_id", "employee_code", "designation",
  "department", "date_of_birth", "joining_date", "emergency_contact_name", "emergency_contact_phone", "ctdms_name",
];

// Returns the employee id (new or existing).
export async function saveEmployee(fd: FormData): Promise<string> {
  const id = str(fd, "employee_id");
  const p = Object.fromEntries(EMPLOYEE_KEYS.map((k) => [k, str(fd, k) ?? ""]));
  return (await call("save_employee", { p_employee_id: id, p }, id)) as string;
}

const PRIVATE_KEYS = [
  "pan", "aadhaar_last4", "bank_account_name", "bank_account_no", "bank_ifsc", "bank_name", "personal_email",
  "current_address", "permanent_address",
];

export async function saveEmployeePrivate(fd: FormData) {
  const id = str(fd, "employee_id");
  const p = Object.fromEntries(PRIVATE_KEYS.map((k) => [k, str(fd, k) ?? ""]));
  await call("save_employee_private", { p_employee_id: id, p }, id);
}

export async function setEmployeeTask(fd: FormData) {
  await call("set_employee_task", { p_task_id: str(fd, "task_id"), p_status: str(fd, "status"), p_note: str(fd, "note") }, str(fd, "employee_id"));
}

export async function startChecklist(fd: FormData) {
  await call("start_employee_checklist", { p_employee_id: str(fd, "employee_id"), p_kind: str(fd, "kind") }, str(fd, "employee_id"));
}

export async function issueAsset(fd: FormData) {
  await call(
    "issue_asset",
    {
      p_employee_id: str(fd, "employee_id"),
      p_asset_type: str(fd, "asset_type"),
      p_description: str(fd, "description"),
      p_serial_no: str(fd, "serial_no"),
      p_issued_on: str(fd, "issued_on"),
      p_note: str(fd, "note"),
    },
    str(fd, "employee_id"),
  );
}

export async function returnAsset(fd: FormData) {
  await call(
    "return_asset",
    { p_asset_id: str(fd, "asset_id"), p_returned_on: str(fd, "returned_on"), p_condition: str(fd, "condition") },
    str(fd, "employee_id"),
  );
}

export async function addEmployeeDocument(fd: FormData) {
  const employeeId = str(fd, "employee_id");
  const supabase = await createClient();
  const { error } = await supabase.from("employee_documents").insert({
    employee_id: employeeId,
    kind: str(fd, "kind"),
    storage_path: str(fd, "storage_path"),
    note: str(fd, "note"),
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/hr/${employeeId}`);
}

function setPasswordUrl() {
  const fixed = import.meta.env.VITE_SITE_URL;
  const origin = fixed ? fixed.replace(/\/$/, "") : window.location.origin;
  return `${origin}/auth/set-password`;
}

async function employeeLogin(body: Record<string, unknown>) {
  const supabase = await createClient();
  const { data, error } = await supabase.functions.invoke("employee-login", { body });
  if (error) {
    // The function answers refusals with { error } and a 4xx; show that message, not the generic one.
    const context = (error as { context?: Response }).context;
    const detail = context ? await context.json().catch(() => null) : null;
    throw new Error(detail?.error ?? error.message);
  }
  return data;
}

// No login yet: invite by email and link the new user to the employee. Already linked: send a
// set-password link instead (forgotten password, or the invite expired).
export async function sendLoginLink(fd: FormData) {
  const employeeId = str(fd, "employee_id");
  await employeeLogin({ action: "send_link", employee_id: employeeId, redirect_to: setPasswordUrl() });
  revalidatePath(`/hr/${employeeId}`);
  revalidatePath("/hr");
}

// Hands the work over and records the exit in the database, then blocks the login itself (an inactive
// employee already sees no data either way, so a failure here is not shown as an error).
export async function offboardEmployee(fd: FormData) {
  const employeeId = str(fd, "employee_id");
  await call(
    "offboard_employee",
    {
      p_employee_id: employeeId,
      p_exit_date: str(fd, "exit_date"),
      p_reason: str(fd, "reason"),
      p_handover_to: str(fd, "handover_to"),
    },
    employeeId,
  );
  await employeeLogin({ action: "block_login", employee_id: employeeId }).catch((e) =>
    console.warn("Could not block the leaver's login:", e),
  );
}
