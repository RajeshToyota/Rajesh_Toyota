import { create } from "zustand";
import { supabase } from "@/lib/supabase/client";

export interface CurrentEmployee {
  id: string;
  name: string;
  email: string | null;
  roleName: string | null;
  roleRank: number | null;
  outletId: string | null;
}

// Admin/Business Head (rank <= 1) — the only roles allowed to write master data, per RLS's
// is_master_data_admin(). Mirrored here so the UI can hide write controls it knows
// the database will reject anyway, rather than the user finding out via a failed request.
export const MASTER_DATA_ADMIN_MAX_RANK = 1;

type AuthState = {
  employee: CurrentEmployee | null;
  loading: boolean;
  initialized: boolean;
};

// The signed-in employee, loaded once by <ProtectedRoute> (the same pattern as Techwheels' RBAC store).
export const useAuthStore = create<AuthState>(() => ({ employee: null, loading: false, initialized: false }));

export const useCurrentEmployee = () => useAuthStore((s) => s.employee);

async function fetchEmployee(): Promise<CurrentEmployee | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const user = session?.user;
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

export async function loadCurrentEmployee({ force = false } = {}) {
  const state = useAuthStore.getState();
  if (state.initialized && !force) return state.employee;
  useAuthStore.setState({ loading: true });
  try {
    const employee = await fetchEmployee();
    useAuthStore.setState({ employee, initialized: true });
    return employee;
  } finally {
    useAuthStore.setState({ loading: false });
  }
}

export function resetCurrentEmployee() {
  useAuthStore.setState({ employee: null, initialized: false, loading: false });
}

// Used by the ported pages: returns the employee already loaded at sign-in.
export async function getCurrentEmployee(): Promise<CurrentEmployee | null> {
  return loadCurrentEmployee();
}

export function isMasterDataAdmin(employee: CurrentEmployee | null): boolean {
  return employee?.roleRank !== null && employee?.roleRank !== undefined &&
    employee.roleRank <= MASTER_DATA_ADMIN_MAX_RANK;
}
