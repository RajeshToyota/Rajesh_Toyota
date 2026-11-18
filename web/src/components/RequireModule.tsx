import type { ReactNode } from "react";
import { usePermissionGate } from "@/lib/rbac";

// Route gate: shows the page only when the employee may view its module.
export default function RequireModule({ module, children }: { module?: string; children: ReactNode }) {
  const allowed = usePermissionGate(module);
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
