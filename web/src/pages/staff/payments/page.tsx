import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { ActionForm } from "@/components/action-form";
import { setClearance } from "../reports/bookings/[id]/actions";

const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${Math.round(Number(n)).toLocaleString("en-IN")}`);
const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-IN") : "—");

type Outstanding = {
  booking_id: string;
  customer_name: string | null;
  ctdms_order_no: string | null;
  status: string;
  outlet: string;
  deal_amount: number;
  cleared: number;
  pending: number;
  outstanding: number;
};

// The payments desk: receipts waiting for clearance, and what allotted customers still owe.
export default async function PaymentsPage() {
  const employee = await getCurrentEmployee();
  const allowed = employee?.roleName === "Accounts" || (employee?.roleRank != null && employee.roleRank <= 3);
  if (!allowed) return <p className="text-sm text-slate-600">Payments are for Accounts and the back office.</p>;
  const canClear = employee?.roleName === "Accounts" || (employee?.roleRank != null && employee.roleRank <= 1);
  const supabase = await createClient();

  const [{ data: pending }, { data: owed }] = await Promise.all([
    supabase
      .from("payment_receipts")
      .select("id, receipt_no, booking_id, mode, amount, received_on, instrument_no, bank_name, bookings(customer_name)")
      .eq("clearance_status", "pending")
      .order("received_on"),
    supabase.rpc("outstanding_bookings"),
  ]);
  const owedRows = ((owed ?? []) as Outstanding[]).filter((r) => Number(r.outstanding) > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Payments</h1>
        <p className="text-sm text-slate-500">Record receipts on each booking&apos;s Payments tab. Delivery needs nothing outstanding.</p>
      </div>

      <section className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <h2 className="border-b border-slate-100 px-3 py-2 text-sm font-semibold text-slate-900">
          Awaiting clearance ({(pending ?? []).length})
        </h2>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <tbody className="divide-y divide-slate-100">
            {(pending ?? []).length === 0 && (
              <tr>
                <td className="px-3 py-4 text-center text-slate-400">No cheques or drafts waiting.</td>
              </tr>
            )}
            {(pending ?? []).map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">{r.receipt_no}</td>
                <td className="px-3 py-2">
                  <Link href={`/reports/bookings/${r.booking_id}/payments`} className="underline">
                    {(Array.isArray(r.bookings) ? r.bookings[0] : r.bookings)?.customer_name ?? "—"}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  {r.mode} {r.instrument_no ?? ""} {r.bank_name ?? ""}
                </td>
                <td className="px-3 py-2">{fmtDate(r.received_on)}</td>
                <td className="px-3 py-2">{inr(r.amount)}</td>
                <td className="px-3 py-2">
                  {canClear && (
                    <div className="flex gap-1">
                      <ActionForm action={setClearance} hidden={{ receipt_id: r.id, booking_id: r.booking_id, status: "cleared" }} label="Cleared" />
                      <ActionForm
                        action={setClearance}
                        hidden={{ receipt_id: r.id, booking_id: r.booking_id, status: "bounced" }}
                        label="Bounced"
                        tone="danger"
                        confirm="Mark this receipt bounced?"
                      />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <h2 className="border-b border-slate-100 px-3 py-2 text-sm font-semibold text-slate-900">
          Allotted cars with money outstanding ({owedRows.length})
        </h2>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              {["Customer", "Order", "Branch", "Stage", "Deal", "Received", "Awaiting", "Outstanding"].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium text-slate-600">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {owedRows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-center text-slate-400">
                  Nothing outstanding on allotted cars.
                </td>
              </tr>
            )}
            {owedRows.map((r) => (
              <tr key={r.booking_id}>
                <td className="px-3 py-2">
                  <Link href={`/reports/bookings/${r.booking_id}/payments`} className="underline">
                    {r.customer_name ?? "—"}
                  </Link>
                </td>
                <td className="px-3 py-2">{r.ctdms_order_no ?? "—"}</td>
                <td className="px-3 py-2">{r.outlet}</td>
                <td className="px-3 py-2">{r.status === "ready_to_invoice" ? "Sent for billing" : "Allotted"}</td>
                <td className="px-3 py-2">{inr(r.deal_amount)}</td>
                <td className="px-3 py-2">{inr(r.cleared)}</td>
                <td className="px-3 py-2">{inr(r.pending)}</td>
                <td className="px-3 py-2 font-semibold text-red-700">{inr(r.outstanding)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
