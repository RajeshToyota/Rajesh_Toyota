import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { ActionForm } from "@/components/action-form";
import { recordPayment, setClearance } from "../actions";

const MODES = [
  { id: "cash", name: "Cash" },
  { id: "cheque", name: "Cheque" },
  { id: "dd", name: "Demand draft" },
  { id: "upi", name: "UPI" },
  { id: "bank_transfer", name: "NEFT / RTGS / IMPS" },
  { id: "card", name: "Card" },
  { id: "exchange", name: "Exchange car value" },
  { id: "scrap", name: "Scrap certificate value" },
  { id: "other", name: "Other" },
];
const MODE_LABEL: Record<string, string> = { ...Object.fromEntries(MODES.map((m) => [m.id, m.name])), finance_disbursement: "Finance disbursement" };

const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${Math.round(Number(n)).toLocaleString("en-IN")}`);
const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-IN") : "—");
const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

type Receipt = {
  id: string;
  receipt_no: string;
  mode: string;
  amount: number;
  received_on: string;
  instrument_no: string | null;
  bank_name: string | null;
  clearance_status: "pending" | "cleared" | "bounced";
  cleared_on: string | null;
  is_booking_amount: boolean;
  notes: string | null;
};

export default async function BookingPaymentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const employee = await getCurrentEmployee();

  const { data: booking } = await supabase
    .from("bookings")
    .select("id, outlet_id, customer_name, status, received_amount, imported_from_ctdms")
    .eq("id", id)
    .maybeSingle();
  if (!booking) notFound();

  const [{ data: account }, { data: receipts }] = await Promise.all([
    supabase.rpc("booking_account", { p_booking_id: id }).single(),
    supabase.from("payment_receipts").select("*").eq("booking_id", id).order("received_on").order("created_at"),
  ]);
  const a = account as { deal_amount: number; vehicle_amount: number; accessories_amount: number; cleared: number; pending: number; outstanding: number } | null;
  const rows = (receipts ?? []) as Receipt[];
  const isAccounts =
    employee?.roleRank != null &&
    (employee.roleRank <= 1 || (employee.roleName === "Accounts" && employee.outletId === booking.outlet_id));
  const today = todayIst();

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-slate-900">{booking.customer_name ?? "Booking"} — payments</h2>

      {a && (
        <div className="grid gap-3 sm:grid-cols-4">
          {[
            ["Deal amount", inr(a.deal_amount), `car ${inr(a.vehicle_amount)} + accessories ${inr(a.accessories_amount)}`],
            ["Received (cleared)", inr(a.cleared), null],
            ["Awaiting clearance", inr(a.pending), null],
            ["Outstanding", inr(a.outstanding), null],
          ].map(([k, v, note]) => (
            <div key={k} className="rounded-md border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-500">{k}</p>
              <p className={`text-lg font-semibold ${k === "Outstanding" && Number(a.outstanding) > 0 ? "text-red-700" : "text-slate-900"}`}>{v}</p>
              {note && <p className="text-xs text-slate-400">{note}</p>}
            </div>
          ))}
        </div>
      )}
      {booking.imported_from_ctdms && booking.received_amount != null && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Imported from CTDMS, which shows {inr(booking.received_amount)} received. Record those receipts here so the outstanding amount is right.
        </p>
      )}

      <section className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              {["Receipt", "Date", "Mode", "Instrument / bank", "Amount", "Status", ""].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium text-slate-600">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-400">
                  No receipts yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className={r.clearance_status === "bounced" ? "text-slate-400 line-through" : ""}>
                <td className="px-3 py-2">
                  {r.receipt_no}
                  {r.is_booking_amount && <span className="ml-1 text-xs text-slate-400">(booking)</span>}
                </td>
                <td className="px-3 py-2">{fmtDate(r.received_on)}</td>
                <td className="px-3 py-2">{MODE_LABEL[r.mode] ?? r.mode}</td>
                <td className="px-3 py-2">{[r.instrument_no, r.bank_name, r.notes].filter(Boolean).join(" · ") || "—"}</td>
                <td className="px-3 py-2">{inr(r.amount)}</td>
                <td className="px-3 py-2">
                  {r.clearance_status === "pending" ? (
                    <span className="text-amber-700">Awaiting clearance</span>
                  ) : r.clearance_status === "cleared" ? (
                    `Cleared ${fmtDate(r.cleared_on)}`
                  ) : (
                    "Bounced"
                  )}
                </td>
                <td className="space-y-1 px-3 py-2">
                  {isAccounts && r.clearance_status === "pending" && (
                    <>
                      <ActionForm action={setClearance} hidden={{ receipt_id: r.id, booking_id: id, status: "cleared" }} label="Cleared" />
                      <ActionForm
                        action={setClearance}
                        hidden={{ receipt_id: r.id, booking_id: id, status: "bounced" }}
                        label="Bounced"
                        tone="danger"
                        confirm="Mark this receipt bounced? It will no longer count as paid."
                      />
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {isAccounts && booking.status !== "cancelled" && (
        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Record a payment</h3>
          <ActionForm
            action={recordPayment}
            hidden={{ booking_id: id }}
            fields={[
              { name: "mode", placeholder: "Mode…", options: MODES, required: true, width: "w-44" },
              { name: "amount", placeholder: "Amount ₹", type: "number", required: true, width: "w-32" },
              { name: "received_on", placeholder: "Date", type: "date", required: true, width: "w-36", initial: today },
              { name: "instrument_no", placeholder: "Cheque / DD / UTR no.", width: "w-44" },
              { name: "bank_name", placeholder: "Bank", width: "w-36" },
              { name: "notes", placeholder: "Note", width: "w-44" },
            ]}
            label="Record"
          />
          <p className="mt-2 text-xs text-slate-500">
            Cash, UPI, card and bank transfers count as paid at once; cheques and DDs once cleared. Finance disbursements are
            added automatically when the finance case is disbursed.
          </p>
        </section>
      )}
    </div>
  );
}
