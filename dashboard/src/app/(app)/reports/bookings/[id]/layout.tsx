import Link from "next/link";

// One booking's file: the Welcome Docket, payments, insurance and RTO, delivery, and hold / cancel.
export default async function BookingFileLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const base = `/reports/bookings/${id}`;
  const tabs = [
    { href: base, label: "Welcome Docket" },
    { href: `${base}/payments`, label: "Payments" },
    { href: `${base}/insurance-rto`, label: "Insurance & RTO" },
    { href: `${base}/delivery`, label: "Delivery" },
    { href: `${base}/hold-cancel`, label: "Hold & Cancel" },
  ];
  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {tabs.map((t) => (
          <Link key={t.href} href={t.href} className="rounded-t-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">
            {t.label}
          </Link>
        ))}
      </div>
      {children}
    </div>
  );
}
