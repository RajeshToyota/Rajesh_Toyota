"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Everything is checked in the database (20261102000001_employee_management.sql): only HR and the
// Business Head / Admin manage staff, and HR can never touch the top roles. The service key is used
// only for login invites and for closing a leaver's login, after the same check.

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

async function requireHrManager() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("can_manage_hr");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Only HR or the Business Head can do this");
  return supabase;
}

function adminOrExplain() {
  const admin = createAdminClient();
  if (!admin) {
    throw new Error(
      "Login emails need the Supabase service-role key: add SUPABASE_SERVICE_ROLE_KEY to the dashboard's server environment.",
    );
  }
  return admin;
}

async function setPasswordUrl() {
  const fixed = process.env.NEXT_PUBLIC_SITE_URL;
  if (fixed) return `${fixed.replace(/\/$/, "")}/auth/set-password`;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/auth/set-password`;
}

// No login yet: invite by email and link the new user to the employee. Already linked: send a
// set-password link instead (forgotten password, or the invite expired).
export async function sendLoginLink(fd: FormData) {
  const employeeId = str(fd, "employee_id");
  const supabase = await requireHrManager();
  const { data: emp, error } = await supabase
    .from("employees")
    .select("id, email, is_active, auth_user_id")
    .eq("id", employeeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!emp) throw new Error("Employee not found");
  if (!emp.is_active) throw new Error("This employee has left");
  if (!emp.email) throw new Error("Add the employee's email first");

  const admin = adminOrExplain();
  const redirectTo = await setPasswordUrl();

  if (emp.auth_user_id) {
    const { error: resetError } = await admin.auth.resetPasswordForEmail(emp.email, { redirectTo });
    if (resetError) throw new Error(resetError.message);
  } else {
    let userId: string | null = null;
    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(emp.email, { redirectTo });
    if (inviteError) {
      if (!/already.*registered|already exists/i.test(inviteError.message)) throw new Error(inviteError.message);
      // A login with this email exists but was never linked: link it and send a set-password link.
      const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "recovery", email: emp.email });
      if (linkError) throw new Error(linkError.message);
      userId = link.user.id;
      const { error: resetError } = await admin.auth.resetPasswordForEmail(emp.email, { redirectTo });
      if (resetError) throw new Error(resetError.message);
    } else {
      userId = invited.user.id;
    }
    const { data: taken } = await admin.from("employees").select("name").eq("auth_user_id", userId).neq("id", emp.id).maybeSingle();
    if (taken) throw new Error(`That login already belongs to ${taken.name}`);
    const { error: updateError } = await admin
      .from("employees")
      .update({ auth_user_id: userId })
      .eq("id", emp.id)
      .is("auth_user_id", null);
    if (updateError) throw new Error(updateError.message);
  }

  const { error: markError } = await supabase.rpc("mark_login_invited", { p_employee_id: emp.id });
  if (markError) throw new Error(markError.message);
  revalidatePath(`/hr/${emp.id}`);
  revalidatePath("/hr");
}

// Hands the work over and records the exit in the database, then blocks the login itself when the
// service key is available (an inactive employee already sees no data either way).
export async function offboardEmployee(fd: FormData) {
  const employeeId = str(fd, "employee_id");
  const supabase = await createClient();
  const { data: emp } = await supabase.from("employees").select("auth_user_id").eq("id", employeeId).maybeSingle();
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
  const admin = createAdminClient();
  if (admin && emp?.auth_user_id) {
    await admin.auth.admin.updateUserById(emp.auth_user_id, { ban_duration: "876000h" });
  }
}
