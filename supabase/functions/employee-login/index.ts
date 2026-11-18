// employee-login: the two HR jobs that need the service-role key, moved here from the old Next.js
// dashboard's server actions (dashboard/src/app/(app)/hr/actions.ts) when the dashboard became a
// browser-only Vite app (web/).
//
//   { action: "send_link", employee_id, redirect_to }  invite a new login, or send a set-password link
//   { action: "block_login", employee_id }              block a leaver's login after offboard_employee
//
// The caller's own token is checked first with can_manage_hr() (HR, Business Head, Admin), exactly as
// the server action did; only then is the service-role client used.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

class Refusal extends Error {}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: { action?: string; employee_id?: string; redirect_to?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.employee_id) return json({ error: "employee_id is required" }, 400);

  const url = Deno.env.get("SUPABASE_URL")!;
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data: allowed, error: rightsError } = await caller.rpc("can_manage_hr");
    if (rightsError) throw new Refusal(rightsError.message);
    if (!allowed) throw new Refusal("Only HR or the Business Head can do this");

    if (body.action === "send_link") {
      if (!body.redirect_to) throw new Refusal("redirect_to is required");
      await sendLoginLink(caller, admin, body.employee_id, body.redirect_to);
      return json({ ok: true });
    }
    if (body.action === "block_login") {
      const { data: emp } = await caller
        .from("employees")
        .select("auth_user_id, is_active")
        .eq("id", body.employee_id)
        .maybeSingle();
      if (!emp) throw new Refusal("Employee not found");
      if (emp.is_active) throw new Refusal("Offboard the employee before blocking the login");
      if (emp.auth_user_id) {
        const { error } = await admin.auth.admin.updateUserById(emp.auth_user_id, { ban_duration: "876000h" });
        if (error) throw new Refusal(error.message);
      }
      return json({ ok: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof Refusal ? 400 : 500);
  }
});

// deno-lint-ignore no-explicit-any
type Client = any;

// No login yet: invite by email and link the new user to the employee. Already linked: send a
// set-password link instead (forgotten password, or the invite expired).
async function sendLoginLink(caller: Client, admin: Client, employeeId: string, redirectTo: string) {
  const { data: emp, error } = await caller
    .from("employees")
    .select("id, email, is_active, auth_user_id")
    .eq("id", employeeId)
    .maybeSingle();
  if (error) throw new Refusal(error.message);
  if (!emp) throw new Refusal("Employee not found");
  if (!emp.is_active) throw new Refusal("This employee has left");
  if (!emp.email) throw new Refusal("Add the employee's email first");

  if (emp.auth_user_id) {
    const { error: resetError } = await admin.auth.resetPasswordForEmail(emp.email, { redirectTo });
    if (resetError) throw new Refusal(resetError.message);
  } else {
    let userId: string | null = null;
    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(emp.email, { redirectTo });
    if (inviteError) {
      if (!/already.*registered|already exists/i.test(inviteError.message)) throw new Refusal(inviteError.message);
      // A login with this email exists but was never linked: link it and send a set-password link.
      const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "recovery", email: emp.email });
      if (linkError) throw new Refusal(linkError.message);
      userId = link.user.id;
      const { error: resetError } = await admin.auth.resetPasswordForEmail(emp.email, { redirectTo });
      if (resetError) throw new Refusal(resetError.message);
    } else {
      userId = invited.user.id;
    }
    const { data: taken } = await admin
      .from("employees")
      .select("name")
      .eq("auth_user_id", userId)
      .neq("id", emp.id)
      .maybeSingle();
    if (taken) throw new Refusal(`That login already belongs to ${taken.name}`);
    const { error: updateError } = await admin
      .from("employees")
      .update({ auth_user_id: userId })
      .eq("id", emp.id)
      .is("auth_user_id", null);
    if (updateError) throw new Refusal(updateError.message);
  }

  const { error: markError } = await caller.rpc("mark_login_invited", { p_employee_id: emp.id });
  if (markError) throw new Refusal(markError.message);
}
