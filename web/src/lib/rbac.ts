import { create } from "zustand";
import { supabase } from "@/lib/supabase/client";

export type Right = "view" | "create" | "edit" | "approve" | "delete";
export type MenuGroup = { key: string; title: string; sort_order: number };
export type AppModule = {
  key: string;
  group_key: string;
  label: string;
  path: string | null;
  sort_order: number;
  in_menu: boolean;
  is_active: boolean;
};

type RbacState = {
  loaded: boolean;
  // False while the permissions migration is not on the database yet: then everything is shown and
  // the database's own checks decide, exactly as before Phase 17b.
  available: boolean;
  isAdmin: boolean;
  rights: Set<string>;
  groups: MenuGroup[];
  modules: AppModule[];
  // Admin "preview as employee" (Techwheels' startEmployeePreview): the menu and buttons show what
  // that person would see. The database still checks the Admin's own rights on every call.
  preview: { employeeId: string; name: string } | null;
  ownRights: Set<string> | null;
  ownIsAdmin: boolean;
};

const empty: RbacState = {
  loaded: false,
  available: false,
  isAdmin: false,
  rights: new Set(),
  groups: [],
  modules: [],
  preview: null,
  ownRights: null,
  ownIsAdmin: false,
};

// The signed-in employee's module rights and the menu, loaded once at sign-in (Techwheels' RBAC store).
export const useRbacStore = create<RbacState>(() => empty);

export async function loadRbac() {
  const [rights, groups, modules] = await Promise.all([
    supabase.rpc("my_rights"),
    supabase.from("menu_groups").select("key, title, sort_order").order("sort_order"),
    supabase.from("app_modules").select("key, group_key, label, path, sort_order, in_menu, is_active").order("sort_order"),
  ]);
  if (rights.error || groups.error || modules.error) {
    console.warn("Module rights not available; showing every screen.", rights.error ?? groups.error ?? modules.error);
    useRbacStore.setState({ ...empty, available: false });
    return;
  }
  useRbacStore.setState({
    available: true,
    rights: new Set((rights.data as { module_key: string; right: string }[]).map((r) => `${r.module_key}:${r.right}`)),
    groups: groups.data as MenuGroup[],
    modules: modules.data as AppModule[],
  });
}

// Applied once the employee row has loaded (it arrives alongside the rights, not before them). Only
// then are the rights marked loaded, so an admin never sees a "no access" flash in between.
export function setRbacAdmin(roleRank: number | null) {
  useRbacStore.setState({ isAdmin: roleRank === 0, loaded: true });
}

export async function startPreview(employeeId: string, name: string) {
  const { data, error } = await supabase.rpc("employee_effective_rights", { p_employee_id: employeeId });
  if (error) throw new Error(error.message);
  const rights = new Set(
    (data as { module_key: string; right: string; allowed: boolean }[]).filter((r) => r.allowed).map((r) => `${r.module_key}:${r.right}`),
  );
  const s = useRbacStore.getState();
  useRbacStore.setState({
    preview: { employeeId, name },
    ownRights: s.ownRights ?? s.rights,
    rights,
    isAdmin: false,
    ownIsAdmin: s.preview ? s.ownIsAdmin : s.isAdmin,
  });
}

export function stopPreview() {
  const s = useRbacStore.getState();
  if (!s.preview) return;
  useRbacStore.setState({ preview: null, rights: s.ownRights ?? new Set(), ownRights: null, isAdmin: s.ownIsAdmin });
}

export function resetRbac() {
  useRbacStore.setState(empty);
}

export function can(module: string | undefined, right: Right = "view") {
  if (!module) return true;
  const s = useRbacStore.getState();
  if (!s.available || s.isAdmin) return true;
  return s.rights.has(`${module}:${right}`);
}

// Hooks for pages and buttons, as in Techwheels (usePermissionGate / useRightGate).
export function usePermissionGate(module: string | undefined) {
  return useRightGate(module, "view");
}

export function useRightGate(module: string | undefined, right: Right) {
  return useRbacStore((s) => !module || !s.available || s.isAdmin || s.rights.has(`${module}:${right}`));
}
