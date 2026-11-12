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
    <div className="flex min-h-screen flex-1 flex-col">
      <header className="sticky top-0 z-40 bg-slate-900 text-white shadow">
        <div className="flex items-center justify-between gap-4 border-b border-slate-800 px-6 py-2">
          <p className="text-sm font-bold uppercase tracking-widest">Rajesh Toyota CRM</p>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm font-medium">{employee.name}</p>
              <p className="text-xs text-slate-400">{employee.roleName ?? "No role assigned"}</p>
            </div>
            <SignOutButton />
          </div>
        </div>
        <div className="px-4">
          <SidebarNav />
        </div>
      </header>

      <main className="flex-1 bg-slate-50 px-6 py-6">{children}</main>
    </div>
  );
}
