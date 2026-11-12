import Link from "next/link";
import { getCurrentEmployee } from "@/lib/auth";
import { BACK_OFFICE_MAX_RANK, isAccounts } from "./shared";

const TABS = [
  { href: "/stock", label: "Free Stock" },
  { href: "/stock/pool", label: "Pool" },
  { href: "/stock/finance-queue", label: "Finance Queue" },
  { href: "/stock/vna", label: "VNA" },
  { href: "/stock/match", label: "Match" },
  { href: "/stock/allotted", label: "Allotted" },
  { href: "/stock/billing", label: "Billing" },
  { href: "/stock/ctdms", label: "CTDMS To-do" },
  { href: "/stock/import", label: "Import" },
];

export default async function StockLayout({ children }: { children: React.ReactNode }) {
  const employee = await getCurrentEmployee();
  const backOffice = employee?.roleRank != null && employee.roleRank <= BACK_OFFICE_MAX_RANK;
  // Accounts works only the billing queue; others below back office see the free stock and the
  // pool's queues (filtered to the bookings they work).
  const SALES_TABS = ["/stock", "/stock/finance-queue", "/stock/vna"];
  const tabs = isAccounts(employee)
    ? TABS.filter((t) => t.href === "/stock/billing")
    : backOffice
      ? TABS
      : TABS.filter((t) => SALES_TABS.includes(t.href));

  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Stock</h1>
      <div className="mt-3 flex gap-1 border-b border-slate-200">
        {tabs.map((tab) => (
          <Link key={tab.href} href={tab.href} className="rounded-t-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100">
            {tab.label}
          </Link>
        ))}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}
