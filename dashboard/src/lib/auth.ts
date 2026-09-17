import { createClient } from "@/lib/supabase/server";

export interface CurrentEmployee {
  id: string;
  name: string;
  email: string | null;
  roleName: string | null;
  roleRank: number | null;
  outletId: string | null;
}

// Admin/Business Head (rank <= 1) — the only roles allowed to write master data, per RLS's
// is_master_data_admin(). Mirrored here so the dashboard UI can hide write controls it knows
// the database will reject anyway, rather than the user finding out via a failed request.
export const MASTER_DATA_ADMIN_MAX_RANK = 1;

export async function getCurrentEmployee(): Promise<CurrentEmployee | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data } = await supabase
    .from("employees")
    .select("id, name, email, outlet_id, roles(name, rank)")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!data) return null;

  const role = Array.isArray(data.roles) ? data.roles[0] : data.roles;

  return {
    id: data.id,
    name: data.name,
    email: data.email,
    outletId: data.outlet_id,
    roleName: role?.name ?? null,
    roleRank: role?.rank ?? null,
  };
}

export function isMasterDataAdmin(employee: CurrentEmployee | null): boolean {
  return employee?.roleRank !== null && employee?.roleRank !== undefined &&
    employee.roleRank <= MASTER_DATA_ADMIN_MAX_RANK;
}
