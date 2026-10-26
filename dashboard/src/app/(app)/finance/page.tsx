import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { APPLICANT_LABELS, FINANCE_STAGES, canSeeFinance, fmtDate, inr } from "./shared";

type Row = {
  id: string;
  status: string;
  applicant_type: string;
  finance_type: string;
  loan_amount: number | null;
  do_number: string | null;
  updated_at: string;
  created_at: string;
  financiers: { name: string } | null;
  outlets: { name: string } | null;
  bookings: {
    customer_name: string | null;
    ctdms_order_booking_no: string | null;
    employees: { name: string } | null;
    variants: { name: string } | null;
  } | null;
};

// The finance pipeline: open cases by stage, oldest activity first within a stage.
export default async function FinancePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const employee = await getCurrentEmployee();
  if (!canSeeFinance(employee)) {
    return <p className="text-sm text-slate-600">Finance cases are for Finance Executives and the back office.</p>;
  }
  const supabase = await createClient();
  const showClosed = params.closed === "1";

  let query = supabase
    .from("finance_cases")
    .select(
      "id, status, applicant_type, finance_type, loan_amount, do_number, updated_at, created_at, financiers(name), outlets(name), " +
        "bookings(customer_name, ctdms_order_booking_no, employees!bookings_employee_id_fkey(name), variants(name))",
    )
    .order("updated_at", { ascending: true })
    .limit(1000);
  query = showClosed ? query.in("status", ["disbursed", "rejected"]) : query.not("status", "in", "(disbursed,rejected)");
  const { data } = await query;
  const rows = (data ?? []) as unknown as Row[];

  const columns = showClosed
    ? [
        { id: "disbursed", label: "Disbursed" },
        { id: "rejected", label: "Rejected" },
      ]
    : FINANCE_STAGES.filter((s) => s.id !== "disbursed");

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Finance Cases</h1>
          <p className="text-sm text-slate-500">
            Consultants open cases and collect documents on the app; the branch&apos;s Finance Executive moves them on here.
          </p>
        </div>
        <Link href={showClosed ? "/finance" : "/finance?closed=1"} className="text-sm text-slate-600 underline">
          {showClosed ? "Open cases" : "Disbursed & rejected"}
        </Link>
      </div>

      <div className="grid gap-3 lg:grid-cols-4">
        {columns.map((col) => {
          const cards = rows.filter((r) => r.status === col.id);
          return (
            <section key={col.id} className="rounded-md border border-slate-200 bg-white">
              <h2 className="border-b border-slate-100 px-3 py-2 text-sm font-semibold text-slate-900">
                {col.label} <span className="font-normal text-slate-400">({cards.length})</span>
              </h2>
              <ul className="divide-y divide-slate-100">
                {cards.length === 0 && <li className="px-3 py-4 text-center text-xs text-slate-400">None</li>}
                {cards.map((r) => (
                  <li key={r.id} className="px-3 py-2 text-sm">
                    <Link href={`/finance/${r.id}`} className="font-medium text-slate-900 underline">
                      {r.bookings?.customer_name ?? "—"}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {r.financiers?.name} · {APPLICANT_LABELS[r.applicant_type]}
                      {r.finance_type === "own" ? " · own finance" : ""}
                    </div>
                    <div className="text-xs text-slate-500">
                      {r.bookings?.variants?.name ?? ""} · {r.outlets?.name} · {r.bookings?.employees?.name ?? "—"}
                    </div>
                    <div className="text-xs text-slate-400">
                      {r.loan_amount ? `${inr(r.loan_amount)} · ` : ""}
                      updated {fmtDate(r.updated_at)}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
