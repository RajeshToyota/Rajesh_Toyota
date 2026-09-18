import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { Employee } from "@/lib/types";

interface AuthContextValue {
  session: Session | null;
  employee: Employee | null;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshEmployee: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

async function fetchEmployee(authUserId: string): Promise<Employee | null> {
  const { data } = await supabase
    .from("employees")
    .select("id, name, email, outlet_id, reports_to_employee_id, outlets(name, state), roles(name, rank)")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (!data) return null;

  const role = Array.isArray(data.roles) ? data.roles[0] : data.roles;
  const outlet = Array.isArray(data.outlets) ? data.outlets[0] : data.outlets;

  return {
    id: data.id,
    name: data.name,
    email: data.email,
    outletId: data.outlet_id,
    outletName: outlet?.name ?? null,
    outletState: outlet?.state ?? null,
    roleName: role?.name ?? null,
    roleRank: role?.rank ?? null,
    reportsToEmployeeId: data.reports_to_employee_id,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadEmployeeFor(session: Session | null) {
    if (!session) {
      setEmployee(null);
      return;
    }
    const emp = await fetchEmployee(session.user.id);
    setEmployee(emp);
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session);
      await loadEmployeeFor(session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setSession(session);
      await loadEmployeeFor(session);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
  }

  async function refreshEmployee() {
    await loadEmployeeFor(session);
  }

  return (
    <AuthContext.Provider value={{ session, employee, loading, signOut, refreshEmployee }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
