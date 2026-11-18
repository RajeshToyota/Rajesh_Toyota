import type { createClient } from "@/lib/supabase/server";
import type { CurrentEmployee } from "@/lib/auth";

type Client = Awaited<ReturnType<typeof createClient>>;

// Pickers for the employee form. HR is not offered the Business Head / Admin roles (the database
// refuses them anyway).
export async function staffOptions(supabase: Client, employee: CurrentEmployee | null) {
  const [{ data: roles }, { data: outlets }, { data: staff }] = await Promise.all([
    supabase.from("roles").select("id, name, rank").order("rank").order("name"),
    supabase.from("outlets").select("id, name").eq("is_active", true).order("name"),
    supabase.from("employees").select("id, name, designation, roles(name)").eq("is_active", true).order("name"),
  ]);
  const topRoleAllowed = employee?.roleRank != null && employee.roleRank <= 1;
  return {
    roles: (roles ?? []).filter((r) => topRoleAllowed || r.rank > 1).map((r) => ({ id: r.id, name: r.name })),
    outlets: outlets ?? [],
    managers: (staff ?? []).map((s) => {
      const role = Array.isArray(s.roles) ? s.roles[0] : s.roles;
      return { id: s.id, name: `${s.name}${role ? ` — ${role.name}` : ""}` };
    }),
  };
}
