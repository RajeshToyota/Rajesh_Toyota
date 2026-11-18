import { Outlet } from "react-router-dom";
import { SidebarNav } from "@/components/sidebar-nav";
import { SignOutButton } from "@/components/sign-out-button";
import { useCurrentEmployee } from "@/lib/auth";

// The staff app's frame (Techwheels' AdminPanel): header with the signed-in employee, the top menu,
// and the current page below.
export default function AdminPanel() {
  const employee = useCurrentEmployee();

  return (
    <div className="flex min-h-screen flex-1 flex-col">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-6 py-2">
          <p className="text-sm font-semibold text-slate-900">Rajesh Toyota CRM</p>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm font-medium text-slate-900">{employee?.name}</p>
              <p className="text-xs text-slate-500">{employee?.roleName ?? "No role assigned"}</p>
            </div>
            <SignOutButton />
          </div>
        </div>
        <div className="px-4">
          <SidebarNav />
        </div>
      </header>

      <main className="flex-1 bg-slate-50 px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
