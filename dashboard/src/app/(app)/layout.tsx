import { redirect } from "next/navigation";
import { SidebarNav } from "@/components/sidebar-nav";
import { SignOutButton } from "@/components/sign-out-button";
import { getCurrentEmployee } from "@/lib/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const employee = await getCurrentEmployee();

  if (!employee) {
    // Authenticated with Supabase but no matching employees row (e.g. auth user created without
    // being linked yet) — nothing in the dashboard is meaningful without an employee identity.
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen flex-1">
      <aside className="w-64 shrink-0 overflow-y-auto border-r border-slate-200 bg-white px-3 py-4">
        <div className="mb-4 px-3">
          <p className="text-sm font-semibold text-slate-900">Rajesh Toyota CRM</p>
        </div>
        <SidebarNav />
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <div>
            <p className="text-sm font-medium text-slate-900">{employee.name}</p>
            <p className="text-xs text-slate-500">{employee.roleName ?? "No role assigned"}</p>
          </div>
          <SignOutButton />
        </header>

        <main className="flex-1 bg-slate-50 px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
