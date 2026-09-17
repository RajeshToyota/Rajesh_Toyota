import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

async function count(table: string) {
  const supabase = await createClient();
  const { count } = await supabase.from(table).select("*", { count: "exact", head: true });
  return count ?? 0;
}

export default async function DashboardHome() {
  const [outlets, employees, variants, schemes, pendingApprovals] = await Promise.all([
    count("outlets"),
    count("employees"),
    count("variants"),
    count("schemes"),
    (async () => {
      const supabase = await createClient();
      const { count } = await supabase
        .from("approvals")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending");
      return count ?? 0;
    })(),
  ]);

  const tiles = [
    { label: "Outlets", value: outlets, href: "/admin/outlets" },
    { label: "Employees", value: employees, href: "/admin/employees" },
    { label: "Variants", value: variants, href: "/admin/variants" },
    { label: "Active Schemes", value: schemes, href: "/admin/schemes" },
    { label: "Pending Approvals", value: pendingApprovals, href: "/reports" },
  ];

  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Overview</h1>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => (
          <Link
            key={t.label}
            href={t.href}
            className="rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-300"
          >
            <p className="text-2xl font-semibold text-slate-900">{t.value}</p>
            <p className="mt-1 text-sm text-slate-500">{t.label}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
