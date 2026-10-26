import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { cancelBilling, recordInvoice } from "../actions";
import { ActionForm } from "../ui";
import { Card, Empty, Restricted, Th, canManageStock, fmtDate, inr, isAccounts, isBackOffice, todayIst } from "../shared";

type Row = {
  id: string;
  status: string;
  requested_at: string;
  invoice_no: string | null;
  invoice_date: string | null;
  invoice_amount: number | null;
  invoiced_at: string | null;
  outlets: { name: string } | null;
  vehicles: { vin: string; engine_no: string | null } | null;
  bookings: {
    id: string;
    customer_name: string | null;
    ctdms_order_booking_no: string | null;
    total_amount: number | null;
    variants: { name: string } | null;
    colors: { name: string } | null;
  } | null;
};

const SELECT =
  "id, status, requested_at, invoice_no, invoice_date, invoice_amount, invoiced_at, outlets(name), vehicles(vin, engine_no), " +
  "bookings(id, customer_name, ctdms_order_booking_no, total_amount, variants(name), colors(name))";

// The billing queue: Accounts enters each invoice; Outlet Heads can pull a request back.
export default async function BillingPage() {
  const employee = await getCurrentEmployee();
  const accounts = isAccounts(employee);
  if (!accounts && !isBackOffice(employee)) return <Restricted text="The billing queue is for Accounts and the back office." />;
  const canInvoice = accounts || (employee?.roleRank != null && employee.roleRank <= 1);
  const canCancel = canManageStock(employee);
  const supabase = await createClient();

  const [{ data: pending }, { data: done }] = await Promise.all([
    supabase.from("billing_requests").select(SELECT).eq("status", "pending").order("requested_at"),
    supabase.from("billing_requests").select(SELECT).eq("status", "invoiced").order("invoiced_at", { ascending: false }).limit(50),
  ]);
  const queue = (pending ?? []) as unknown as Row[];
  const invoiced = (done ?? []) as unknown as Row[];
  const today = todayIst();

  return (
    <div>
      <Card title={`To invoice (${queue.length})`} note="Enter the invoice exactly as raised; the car is then marked billed.">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Sent</Th>
              <Th>Customer</Th>
              <Th>Order</Th>
              <Th>Vehicle</Th>
              <Th>VIN / engine</Th>
              <Th right>Booked price</Th>
              <Th>Branch</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {queue.length === 0 && <Empty cols={8} text="Nothing waiting for an invoice." />}
            {queue.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">{fmtDate(r.requested_at)}</td>
                <td className="px-3 py-2">
                  {isBackOffice(employee) && r.bookings ? (
                    <Link href={`/reports/bookings/${r.bookings.id}`} className="underline">
                      {r.bookings.customer_name ?? "—"}
                    </Link>
                  ) : (
                    (r.bookings?.customer_name ?? "—")
                  )}
                </td>
                <td className="px-3 py-2">{r.bookings?.ctdms_order_booking_no ?? "—"}</td>
                <td className="px-3 py-2">
                  {r.bookings?.variants?.name} · {r.bookings?.colors?.name}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {r.vehicles?.vin}
                  <div>{r.vehicles?.engine_no}</div>
                </td>
                <td className="px-3 py-2 text-right">{inr(r.bookings?.total_amount)}</td>
                <td className="px-3 py-2">{r.outlets?.name}</td>
                <td className="space-y-1 px-3 py-2">
                  {canInvoice && (
                    <ActionForm
                      action={recordInvoice}
                      hidden={{ request_id: r.id }}
                      fields={[
                        { name: "invoice_no", placeholder: "Invoice no.", required: true, width: "w-28" },
                        { name: "invoice_date", placeholder: "Date", type: "date", required: true, width: "w-36", initial: today },
                        { name: "invoice_amount", placeholder: "Amount ₹", type: "number", required: true, width: "w-28" },
                      ]}
                      label="Record invoice"
                    />
                  )}
                  {canCancel && (
                    <ActionForm
                      action={cancelBilling}
                      hidden={{ request_id: r.id }}
                      fields={[{ name: "reason", placeholder: "Reason", required: true, width: "w-28" }]}
                      label="Pull back"
                      tone="danger"
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Recently invoiced">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Invoice</Th>
              <Th>Date</Th>
              <Th right>Amount</Th>
              <Th>Customer</Th>
              <Th>VIN</Th>
              <Th>Branch</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {invoiced.length === 0 && <Empty cols={6} text="No invoices yet." />}
            {invoiced.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">{r.invoice_no}</td>
                <td className="px-3 py-2">{fmtDate(r.invoice_date)}</td>
                <td className="px-3 py-2 text-right">{inr(r.invoice_amount)}</td>
                <td className="px-3 py-2">{r.bookings?.customer_name ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.vehicles?.vin}</td>
                <td className="px-3 py-2">{r.outlets?.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
