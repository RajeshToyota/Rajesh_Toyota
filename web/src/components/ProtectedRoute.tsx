import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { supabase } from "@/lib/supabase/client";
import { loadCurrentEmployee, resetCurrentEmployee, useAuthStore } from "@/lib/auth";
import { loadRbac, resetRbac, setRbacAdmin, useRbacStore } from "@/lib/rbac";

// The employee row and the module rights are independent requests, so fetch them together: with the
// database in us-east-1 and staff in India each round-trip is ~300 ms, and doing them back to back
// added one to every page load. Rights only need the role rank afterwards (for the admin bypass).
async function loadAll(force = false) {
  const [employee] = await Promise.all([loadCurrentEmployee({ force }), loadRbac()]);
  if (employee) setRbacAdmin(employee.roleRank);
  else resetRbac();
}

// Gate for every staff page (Techwheels' ProtectedRoute): needs a Supabase session and a linked,
// active employee row. Without either it sends the user to /login.
export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const { employee, initialized } = useAuthStore();
  const rbacLoaded = useRbacStore((s) => s.loaded);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      const signedIn = Boolean(data.session);
      setHasSession(signedIn);
      if (signedIn) await loadAll();
      else {
        resetCurrentEmployee();
        resetRbac();
      }
      if (!cancelled) setChecking(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        resetCurrentEmployee();
        resetRbac();
        setHasSession(false);
      } else if (event === "SIGNED_IN" || event === "USER_UPDATED") {
        setHasSession(Boolean(session));
        void loadAll(true);
      }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (checking || (hasSession && (!initialized || (employee && !rbacLoaded)))) {
    return <p className="py-20 text-center text-sm text-slate-400">Loading…</p>;
  }
  if (!hasSession) return <Navigate to="/login" replace />;
  if (!employee) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-50 p-6 text-center">
        <p className="max-w-md text-sm text-slate-600">
          You are signed in, but your login is not linked to an active employee. Ask HR to send you a login link.
        </p>
        <button
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
          onClick={() => supabase.auth.signOut()}
        >
          Sign out
        </button>
      </div>
    );
  }
  return <>{children}</>;
}
