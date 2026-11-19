import type { ReactNode } from "react";
import { useRbacStore } from "@/lib/rbac";

// Route gate: shows the page only when the employee may view its module (any one of them, for a
// screen that holds other screens as tabs).
export default function RequireModule({ module, children }: { module?: string | string[]; children: ReactNode }) {
  const modules = module === undefined ? [] : Array.isArray(module) ? module : [module];
  const allowed = useRbacStore((s) => modules.length === 0 || !s.available || s.isAdmin || modules.some((m) => s.rights.has(`${m}:view`)));
  if (!allowed) {
    return (
      <div className="py-16 text-center text-sm text-slate-500">
        <p>You do not have access to this screen.</p>
        <p className="mt-1 text-xs text-slate-400">Ask the Admin or Business Head to give you access in the Access Studio.</p>
      </div>
    );
  }
  return <>{children}</>;
}
