import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { cancelReasonLabel } from "./labels";

const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${Math.round(Number(n)).toLocaleString("en-IN")}`);
const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-IN") : "—");
const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

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

// Cancellations waiting for an Outlet Head, refunds still to pay, and bookings on hold.
export default async function CancellationsPage() {
  const employee = await getCurrentEmployee();
  const allowed = employee?.roleName === "Accounts" || (employee?.roleRank != null && employee.roleRank <= 3);
  if (!allowed) return <p className="text-sm text-slate-600">This page is for Outlet Heads, back office and Accounts.</p>;
  const supabase = await createClient();
  const today = todayIst();

  const [{ data: pending }, { data: refunds }, { data: holds }] = await Promise.all([
    supabase
      .from("booking_cancellations")
      .select("id, booking_id, reason_category, reason, requested_at, bookings(customer_name, ctdms_order_booking_no, outlets(name))")
      .eq("status", "pending")
      .order("requested_at"),
    supabase
      .from("refunds")
      .select("id, booking_id, payee, payee_name, amount, due_date, bookings(customer_name, ctdms_order_booking_no, outlets(name))")
      .eq("status", "pending")
      .order("due_date"),
    supabase
      .from("booking_holds")
      .select("id, booking_id, reason, held_at, expected_resume_date, bookings(customer_name, ctdms_order_booking_no, outlets(name))")
      .is("resumed_at", null)
      .order("expected_resume_date", { nullsFirst: false }),
  ]);
  const ref = (b: unknown) => (Array.isArray(b) ? b[0] : b) as BookingRef;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Hold &amp; Cancellations</h1>
        <p className="text-sm text-slate-500">Open a booking to approve, reject, resume or pay a refund.</p>
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

      <Section title={`Refunds to pay (${(refunds ?? []).length})`}>
        {(refunds ?? []).length === 0 && <li className="px-3 py-4 text-center text-slate-400">None.</li>}
        {(refunds ?? []).map((r) => {
          const b = ref(r.bookings);
          return (
            <li key={r.id} className="px-3 py-2">
              <Customer id={r.booking_id} b={b} /> · {inr(r.amount)} to{" "}
              {r.payee === "financier" ? `financier ${r.payee_name}` : "the customer"} ·{" "}
              <span className={r.due_date < today ? "font-semibold text-red-700" : "text-amber-700"}>due {fmtDate(r.due_date)}</span> ·{" "}
              {b?.outlets?.name}
            </li>
          );
        })}
      </Section>

      <Section title={`On hold (${(holds ?? []).length})`}>
        {(holds ?? []).length === 0 && <li className="px-3 py-4 text-center text-slate-400">None.</li>}
        {(holds ?? []).map((h) => {
          const b = ref(h.bookings);
          return (
            <li key={h.id} className="px-3 py-2">
              <Customer id={h.booking_id} b={b} /> · {h.reason} · since {fmtDate(h.held_at)}
              {h.expected_resume_date && (
                <span className={h.expected_resume_date < today ? "font-semibold text-red-700" : ""}>
                  {" "}
                  · expected back {fmtDate(h.expected_resume_date)}
                </span>
              )}{" "}
              · {b?.outlets?.name}
            </li>
          );
        })}
      </Section>
    </div>
  );
}
