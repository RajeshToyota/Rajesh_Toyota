import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentEmployee } from "@/lib/auth";
import { ActionForm } from "@/components/action-form";
import { decideCancellation, holdBooking, markRefundPaid, requestCancellation, resumeBooking } from "../actions";
import { CANCEL_REASONS, EVENT_LABELS, cancelReasonLabel } from "../../../../cancellations/labels";

const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${Math.round(Number(n)).toLocaleString("en-IN")}`);
const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-IN") : "—");
const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

type Named = { name: string };
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

// Hold, cancellation and refunds for one booking, with its full history.
export default async function HoldCancelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const employee = await getCurrentEmployee();

  const { data: booking } = await supabase.from("bookings").select("id, outlet_id, status, customer_name").eq("id", id).maybeSingle();
  if (!booking) notFound();

  const [{ data: holds }, { data: cancellations }, { data: refunds }, { data: events }] = await Promise.all([
    supabase.from("booking_holds").select("*").eq("booking_id", id).order("held_at", { ascending: false }),
    supabase.from("booking_cancellations").select("*").eq("booking_id", id).order("requested_at", { ascending: false }),
    supabase.from("refunds").select("*").eq("booking_id", id).order("payee"),
    supabase
      .from("booking_events")
      .select("id, kind, status_from, status_to, note, created_at, employees:by_employee_id(name)")
      .eq("booking_id", id)
      .order("created_at"),
  ]);
  const activeHold = (holds ?? []).find((h) => !h.resumed_at);
  const pending = (cancellations ?? []).find((c) => c.status === "pending");
  const paths = (cancellations ?? []).map((c) => c.request_storage_path).filter((p): p is string => !!p);
  const links = new Map<string, string>();
  if (paths.length) {
    const { data: signed } = await supabase.storage.from("booking-documents").createSignedUrls(paths, 600);
    for (const s of signed ?? []) if (s.path && s.signedUrl) links.set(s.path, s.signedUrl);
  }

  const rank = employee?.roleRank ?? 99;
  const isBranchHead = rank <= 1 || (rank === 2 && employee?.outletId === booking.outlet_id);
  const isAccounts = rank <= 1 || (employee?.roleName === "Accounts" && employee.outletId === booking.outlet_id);
  const canAct = rank <= 3 || employee?.roleName === "Sales Consultant" || employee?.roleName === "Team Leader";
  const open = !["delivered", "cancelled"].includes(booking.status);
  const today = todayIst();

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-slate-900">
        {booking.customer_name ?? "Booking"} — {booking.status === "cancelled" ? "cancelled" : activeHold ? "on hold" : booking.status}
      </h2>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Hold</h3>
          {activeHold ? (
            <div className="space-y-2 text-sm">
              <p>
                On hold since {fmtDate(activeHold.held_at)}: {activeHold.reason}
                {activeHold.expected_resume_date ? ` (expected back ${fmtDate(activeHold.expected_resume_date)})` : ""}
              </p>
              {canAct && (
                <ActionForm
                  action={resumeBooking}
                  hidden={{ booking_id: id }}
                  fields={[{ name: "note", placeholder: "Note (optional)", width: "w-64" }]}
                  label="Resume"
                />
              )}
            </div>
          ) : open && booking.status !== "ready_to_invoice" && canAct ? (
            <div className="space-y-1">
              <ActionForm
                action={holdBooking}
                hidden={{ booking_id: id }}
                fields={[
                  { name: "reason", placeholder: "Reason", required: true, width: "w-64" },
                  { name: "expected_resume", placeholder: "Expected back", type: "date", width: "w-36" },
                ]}
                label="Put on hold"
                confirm="Put this booking on hold? Any allotted car is released and the booking leaves the FIFO queue until resumed."
              />
              <p className="text-xs text-slate-500">Releases any allotted car; the booking is skipped by FIFO until resumed.</p>
            </div>
          ) : (
            <p className="text-sm text-slate-400">{open ? "Not on hold." : "Closed."}</p>
          )}
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Cancellation</h3>
          {(cancellations ?? []).map((c) => (
            <div key={c.id} className="mb-3 border-b border-slate-100 pb-2 text-sm">
              <p>
                <b>{c.status === "pending" ? "Requested" : c.status === "approved" ? "Approved" : "Rejected"}</b> ·{" "}
                {cancelReasonLabel(c.reason_category)}: {c.reason}
              </p>
              <p className="text-xs text-slate-500">
                Requested {fmtDate(c.requested_at)}
                {c.decided_at ? ` · decided ${fmtDate(c.decided_at)}` : ""}
                {c.decision_note ? ` · ${c.decision_note}` : ""}
                {c.request_storage_path && links.get(c.request_storage_path) && (
                  <>
                    {" "}
                    ·{" "}
                    <a href={links.get(c.request_storage_path)} target="_blank" rel="noreferrer" className="underline">
                      written request
                    </a>
                  </>
                )}
              </p>
            </div>
          ))}
          {pending && isBranchHead && (
            <div className="space-y-2">
              <ActionForm
                action={decideCancellation}
                hidden={{ booking_id: id, cancellation_id: pending.id, approve: "true" }}
                fields={[{ name: "note", placeholder: "Note (optional)", width: "w-64" }]}
                label="Approve cancellation"
                tone="danger"
                confirm="Approve? The car is released, the booking cancelled, and refunds are raised."
              />
              <ActionForm
                action={decideCancellation}
                hidden={{ booking_id: id, cancellation_id: pending.id, approve: "false" }}
                fields={[{ name: "note", placeholder: "Why reject?", required: true, width: "w-64" }]}
                label="Reject"
                tone="light"
              />
            </div>
          )}
          {pending && !isBranchHead && <p className="text-sm text-amber-700">Waiting for the branch&apos;s Outlet Head.</p>}
          {!pending && open && canAct && (
            <ActionForm
              action={requestCancellation}
              hidden={{ booking_id: id }}
              fields={[
                { name: "reason_category", placeholder: "Reason…", options: CANCEL_REASONS, required: true, width: "w-48" },
                { name: "reason", placeholder: "Customer's reason in their words", required: true, width: "w-72" },
              ]}
              label="Request cancellation"
              tone="danger"
            />
          )}
          {open && !pending && (
            <p className="mt-2 text-xs text-slate-500">
              The consultant can attach the customer&apos;s written request from the app. Once the car is invoiced it is a sales
              return instead.
            </p>
          )}
        </section>
      </div>

      {(refunds ?? []).length > 0 && (
        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Refunds</h3>
          <ul className="space-y-2 text-sm">
            {(refunds ?? []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
                <span>
                  {inr(r.amount)} to {r.payee === "financier" ? `the financier (${r.payee_name})` : `the customer (${r.payee_name ?? ""})`} ·{" "}
                  {r.status === "paid" ? (
                    `paid by cheque ${r.cheque_no} on ${fmtDate(r.paid_on)}`
                  ) : (
                    <span className={r.due_date < today ? "font-semibold text-red-700" : "text-amber-700"}>due {fmtDate(r.due_date)}</span>
                  )}
                </span>
                {r.status === "pending" && isAccounts && (
                  <ActionForm
                    action={markRefundPaid}
                    hidden={{ booking_id: id, refund_id: r.id }}
                    fields={[
                      { name: "cheque_no", placeholder: "Cheque no.", required: true, width: "w-28" },
                      { name: "paid_on", placeholder: "Date", type: "date", required: true, width: "w-36", initial: today },
                      { name: "bank_name", placeholder: "Bank", width: "w-28" },
                    ]}
                    label="Mark paid"
                  />
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500">
            Per the docket terms: the booking amount is returned by cheque within 7 working days; money received from a financier goes back
            to the financier unless it authorises otherwise in writing.
          </p>
        </section>
      )}

      <section className="rounded-md border border-slate-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-900">History</h3>
        <ul className="space-y-1 text-sm">
          {(events ?? []).length === 0 && <li className="text-slate-400">No changes recorded yet.</li>}
          {(events ?? []).map((e) => (
            <li key={e.id}>
              {new Date(e.created_at).toLocaleString("en-IN")} ·{" "}
              {e.kind === "status" ? `${e.status_from ?? "—"} → ${e.status_to}` : EVENT_LABELS[e.kind] ?? e.kind}
              {e.note ? ` — ${e.note}` : ""} · {one(e.employees as Named | Named[] | null)?.name ?? "—"}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
