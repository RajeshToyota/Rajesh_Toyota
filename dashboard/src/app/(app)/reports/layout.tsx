import Link from "next/link";

const TABS = [
  { href: "/reports/quotes", label: "Quotes" },
  { href: "/reports/bookings", label: "Bookings" },
  { href: "/reports/approvals", label: "Approvals" },
  { href: "/reports/margin", label: "Margin Summary" },
];

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Reporting</h1>
      <div className="mt-3 flex gap-1 border-b border-slate-200">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className="rounded-t-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            {tab.label}
          </Link>
        ))}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}
