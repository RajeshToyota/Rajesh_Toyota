import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, Table, Tabs, Td, fmtDateTime, inr, rpc, str, titleCase } from "@/ui";

type Row = {
  id: string;
  booking_id: string;
  reason_category: string;
  reason: string;
  decided_at: string | null;
  done_at: string | null;
  done_note: string | null;
  revived_at: string | null;
  revive_reason: string | null;
  bookings: { customer_name: string | null; customer_mobile: string | null; ctdms_order_booking_no: string | null; status: string; outlets: { name: string } | null } | null;
  refunds: { amount: number; status: string; payee: string }[];
};

// Techwheels' Cancelled Customers: approved cancellations to work through (CTDMS cancelled, refund
// settled → Done), and Revive for a customer who comes back.
export default function CancelledCustomers() {
  const canEdit = useRightGate("cancelled_customers", "edit");
  const canRevive = useRightGate("cancelled_customers", "approve");
  const [tab, setTab] = useState("new");
  const rows = useQuery(async () => {
    const cols: string =
      "id, booking_id, reason_category, reason, decided_at, done_at, done_note, revived_at, revive_reason, bookings(customer_name, customer_mobile, ctdms_order_booking_no, status, outlets(name)), refunds(amount, status, payee)";
    const all = must(
      await supabase.from("booking_cancellations").select(cols).eq("status", "approved").order("decided_at", { ascending: false }).limit(500),
    ) as unknown as Row[];
    return all.filter((c) => (tab === "new" ? !c.done_at && !c.revived_at : tab === "done" ? !!c.done_at : !!c.revived_at));
  }, [tab]);

  return (
    <div>
      <PageHeader title="Cancelled Customers" note="Mark a cancellation done once CTDMS is cancelled and the refund is handled. Revive brings the booking back (to booked or on hold) while no refund has been paid." />
      <Tabs current={tab} onChange={setTab} tabs={[{ id: "new", label: "New" }, { id: "done", label: "Done" }, { id: "revived", label: "Revived" }]} />
      <Card>
        <Loaded q={rows}>
          {(list) => (
            <Table head={["Customer", "Reason", "Cancelled", "Refunds", ""]}>
              {list.length === 0 ? (
                <EmptyRow cols={5} text="Nothing here." />
              ) : (
                list.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <Link to={`/reports/bookings/${c.booking_id}`} className="text-blue-700 hover:underline">
                        {c.bookings?.customer_name}
                      </Link>
                      <div className="text-xs text-slate-500">
                        {c.bookings?.customer_mobile} · {c.bookings?.ctdms_order_booking_no ?? "no CTDMS order"} · {c.bookings?.outlets?.name}
                      </div>
                    </Td>
                    <Td>
                      {titleCase(c.reason_category)}
                      <div className="text-xs text-slate-500">{c.reason}</div>
                    </Td>
                    <Td muted>
                      {fmtDateTime(c.decided_at)}
                      {c.done_at && <div className="text-xs">Done {fmtDateTime(c.done_at)} {c.done_note}</div>}
                      {c.revived_at && <div className="text-xs">Revived {fmtDateTime(c.revived_at)}: {c.revive_reason}</div>}
                    </Td>
                    <Td>
                      {c.refunds.length === 0
                        ? "—"
                        : c.refunds.map((r, i) => (
                            <div key={i} className="text-xs">
                              {r.payee}: {inr(r.amount)} <Chip tone={r.status === "paid" ? "emerald" : r.status === "pending" ? "amber" : "slate"}>{r.status}</Chip>
                            </div>
                          ))}
                    </Td>
                    <Td>
                      {tab === "new" && (
                        <div className="space-y-1">
                          {canEdit && (
                            <ActionForm
                              tone="light"
                              label="Done"
                              hidden={{}}
                              fields={[{ name: "note", placeholder: "Note", width: "w-36" }]}
                              action={async (fd) => {
                                await rpc("mark_cancellation_done", { p_cancellation_id: c.id, p_note: str(fd, "note") });
                              }}
                            />
                          )}
                          {canRevive && c.bookings?.status === "cancelled" && !c.refunds.some((r) => r.status === "paid") && (
                            <ActionForm
                              label="Revive"
                              hidden={{}}
                              fields={[
                                { name: "target", placeholder: "To", options: [{ id: "active", name: "Booked" }, { id: "hold", name: "On hold" }], required: true, width: "w-28" },
                                { name: "reason", placeholder: "Reason", required: true, width: "w-40" },
                              ]}
                              action={async (fd) => {
                                await rpc("revive_booking", { p_booking_id: c.booking_id, p_reason: str(fd, "reason"), p_target: str(fd, "target") });
                              }}
                            />
                          )}
                        </div>
                      )}
                    </Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
      </Card>
    </div>
  );
}
