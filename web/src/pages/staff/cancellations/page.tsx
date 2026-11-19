import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { cancelReasonLabel } from "./labels";

const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-IN") : "—");

type BookingRef = { customer_name: string | null; ctdms_order_booking_no: string | null; outlets: { name: string } | null } | null;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <h2 className="border-b border-slate-100 px-3 py-2 text-sm font-semibold text-slate-900">{title}</h2>
      <ul className="divide-y divide-slate-100 text-sm">{children}</ul>
    </section>
  );
}

function Customer({ id, b }: { id: string; b: BookingRef }) {
  return (
    <Link href={`/reports/bookings/${id}/hold-cancel`} className="font-medium underline">
      {b?.customer_name ?? "—"}
    </Link>
  );
}

// Cancellations waiting for an Outlet Head. Refunds to pay and bookings on hold have their own pages
// (Booking Refunds, Hold Customers).
export default async function CancellationsPage() {
  const employee = await getCurrentEmployee();
  const allowed = employee?.roleName === "Accounts" || (employee?.roleRank != null && employee.roleRank <= 3);
  if (!allowed) return <p className="text-sm text-slate-600">This page is for Outlet Heads, back office and Accounts.</p>;
  const supabase = await createClient();

  const { data: pending } = await supabase
    .from("booking_cancellations")
    .select("id, booking_id, reason_category, reason, requested_at, bookings(customer_name, ctdms_order_booking_no, outlets(name))")
    .eq("status", "pending")
    .order("requested_at");
  const ref = (b: unknown) => (Array.isArray(b) ? b[0] : b) as BookingRef;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Cancellation Approvals</h1>
        <p className="text-sm text-slate-500">
          Open a booking to approve or reject its cancellation. Refunds to pay are under{" "}
          <Link href="/refunds" className="underline">Booking Refunds</Link>, bookings on hold under{" "}
          <Link href="/hold-customers" className="underline">Hold Customers</Link>.
        </p>
      </div>

      <Section title={`Cancellations waiting for approval (${(pending ?? []).length})`}>
        {(pending ?? []).length === 0 && <li className="px-3 py-4 text-center text-slate-400">None.</li>}
        {(pending ?? []).map((c) => {
          const b = ref(c.bookings);
          return (
            <li key={c.id} className="px-3 py-2">
              <Customer id={c.booking_id} b={b} /> · {b?.ctdms_order_booking_no ?? "—"} · {b?.outlets?.name} ·{" "}
              {cancelReasonLabel(c.reason_category)}: {c.reason} · requested {fmtDate(c.requested_at)}
            </li>
          );
        })}
      </Section>

    </div>
  );
}
