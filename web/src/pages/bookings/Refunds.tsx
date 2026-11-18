import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Table, Tabs, Td, fmtDate, inr, num, rpc, str, todayIst } from "@/ui";

type Refund = {
  id: string;
  booking_id: string;
  outlet_id: string;
  payee: string;
  payee_name: string | null;
  amount: number;
  original_amount: number | null;
  adjust_reason: string | null;
  waive_reason: string | null;
  due_date: string;
  status: string;
  payment_mode: string | null;
  payment_reference: string | null;
  paid_on: string | null;
  bookings: { customer_name: string | null; customer_mobile: string | null } | null;
  refund_bank_details: { account_holder: string; account_number: string; ifsc: string; bank_name: string | null; cancelled_cheque_path: string } | null;
};
type Excess = {
  id: string;
  booking_id: string;
  amount: number;
  reason: string;
  account_holder: string;
  account_number: string;
  ifsc: string;
  bank_name: string | null;
  cancelled_cheque_path: string;
  status: string;
  payment_mode: string | null;
  payment_reference: string | null;
  paid_on: string | null;
  requested_at: string;
  bookings: { customer_name: string | null } | null;
};

const MODES = [
  { id: "neft", name: "NEFT" },
  { id: "rtgs", name: "RTGS" },
  { id: "imps", name: "IMPS" },
  { id: "upi", name: "UPI" },
  { id: "cheque", name: "Cheque" },
];

async function openFile(path: string) {
  const { data } = await supabase.storage.from("booking-documents").createSignedUrl(path, 600);
  if (data?.signedUrl) window.open(data.signedUrl, "_blank");
}

async function uploadCheque(bookingId: string, file: File) {
  const path = `${bookingId}/refund/cheque-${Date.now()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
  const { error } = await supabase.storage.from("booking-documents").upload(path, file);
  if (error) throw new Error(error.message);
  return path;
}

// Techwheels' Booking Refunds: cancellation refunds (raised automatically: financier money back to
// the financier, the rest to the customer within 7 working days) and excess-amount refunds.
export default function Refunds() {
  const [tab, setTab] = useState("cancellation");
  return (
    <div>
      <PageHeader title="Booking Refunds" note="A transfer to the customer needs their bank details and a cancelled cheque. The Outlet Head can correct an amount or decide no refund is due." />
      <Tabs current={tab} onChange={setTab} tabs={[{ id: "cancellation", label: "Cancellation refunds" }, { id: "excess", label: "Excess amount" }, { id: "paid", label: "Paid" }]} />
      {tab === "excess" ? <ExcessTab /> : <CancellationTab paid={tab === "paid"} />}
    </div>
  );
}

function CancellationTab({ paid }: { paid: boolean }) {
  const canApprove = useRightGate("refunds", "approve");
  const rows = useQuery(async () => {
    const q = supabase
      .from("refunds")
      .select("id, booking_id, outlet_id, payee, payee_name, amount, original_amount, adjust_reason, waive_reason, due_date, status, payment_mode, payment_reference, paid_on, bookings(customer_name, customer_mobile), refund_bank_details(account_holder, account_number, ifsc, bank_name, cancelled_cheque_path)")
      .order("due_date");
    return must(await (paid ? q.in("status", ["paid", "waived"]) : q.eq("status", "pending"))) as unknown as Refund[];
  }, [paid]);
  const today = todayIst();

  return (
    <Card>
      <Loaded q={rows}>
        {(list) => (
          <Table head={["Payee", "Amount", "Due", "Bank details", paid ? "Paid" : "Pay"]}>
            {list.length === 0 ? (
              <EmptyRow cols={5} text={paid ? "No refunds paid yet." : "No refunds waiting."} />
            ) : (
              list.map((r) => (
                <tr key={r.id}>
                  <Td>
                    {r.payee_name}
                    <div className="text-xs text-slate-500">
                      {r.payee === "financier" ? "Financier" : "Customer"} · {r.bookings?.customer_name}
                    </div>
                  </Td>
                  <Td right>
                    {inr(r.amount)}
                    {r.original_amount != null && (
                      <div className="text-xs text-slate-500">
                        was {inr(r.original_amount)}: {r.adjust_reason}
                      </div>
                    )}
                    {!paid && canApprove && (
                      <ActionForm
                        tone="light"
                        label="Change"
                        hidden={{}}
                        fields={[
                          { name: "amount", placeholder: "Amount (0 = none)", type: "number", required: true, width: "w-28" },
                          { name: "reason", placeholder: "Reason", required: true, width: "w-32" },
                        ]}
                        action={async (fd) => {
                          await rpc("adjust_refund", { p_refund_id: r.id, p_amount: num(fd, "amount"), p_reason: str(fd, "reason") });
                        }}
                      />
                    )}
                  </Td>
                  <Td>{r.status === "pending" && r.due_date < today ? <Chip tone="red">{fmtDate(r.due_date)}</Chip> : fmtDate(r.due_date)}</Td>
                  <Td>
                    {r.payee === "financier" ? (
                      <span className="text-xs text-slate-400">Paid back to the financier</span>
                    ) : r.refund_bank_details ? (
                      <div className="text-xs">
                        {r.refund_bank_details.account_holder} · {r.refund_bank_details.account_number} · {r.refund_bank_details.ifsc}
                        <button type="button" className="ml-1 text-blue-700 hover:underline" onClick={() => openFile(r.refund_bank_details!.cancelled_cheque_path)}>
                          cheque
                        </button>
                      </div>
                    ) : null}
                    {r.payee === "customer" && !paid && <BankDetailsForm refund={r} />}
                  </Td>
                  <Td>
                    {paid ? (
                      <span className="text-xs">
                        {r.status === "waived" ? `No refund: ${r.waive_reason}` : `${r.payment_mode?.toUpperCase()} ${r.payment_reference} · ${fmtDate(r.paid_on)}`}
                      </span>
                    ) : (
                      <ActionForm
                        label="Paid"
                        hidden={{}}
                        fields={[
                          { name: "mode", placeholder: "Mode", options: MODES, required: true, width: "w-24" },
                          { name: "ref", placeholder: "UTR / cheque no.", required: true, width: "w-32" },
                          { name: "on", placeholder: "Date", type: "date", required: true, width: "w-36", initial: today },
                        ]}
                        action={async (fd) => {
                          await rpc("pay_refund", { p_refund_id: r.id, p_mode: str(fd, "mode"), p_reference: str(fd, "ref"), p_paid_on: str(fd, "on") });
                        }}
                      />
                    )}
                  </Td>
                </tr>
              ))
            )}
          </Table>
        )}
      </Loaded>
    </Card>
  );
}

function BankDetailsForm({ refund }: { refund: Refund }) {
  const [file, setFile] = useState<File | null>(null);
  return (
    <div className="mt-1 space-y-1">
      <input type="file" accept="image/*,application/pdf" className="text-xs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <ActionForm
        tone="light"
        label={refund.refund_bank_details ? "Update" : "Save details"}
        hidden={{}}
        fields={[
          { name: "holder", placeholder: "Account holder", required: true, width: "w-32", initial: refund.refund_bank_details?.account_holder ?? refund.payee_name ?? "" },
          { name: "account", placeholder: "Account no.", required: true, width: "w-32" },
          { name: "ifsc", placeholder: "IFSC", required: true, width: "w-24" },
          { name: "bank", placeholder: "Bank", width: "w-24" },
        ]}
        action={async (fd) => {
          if (!file && !refund.refund_bank_details) throw new Error("Attach the cancelled cheque");
          const path = file ? await uploadCheque(refund.booking_id, file) : refund.refund_bank_details!.cancelled_cheque_path;
          await rpc("set_refund_bank_details", {
            p_refund_id: refund.id,
            p_holder: str(fd, "holder"),
            p_account: str(fd, "account"),
            p_ifsc: str(fd, "ifsc"),
            p_bank: str(fd, "bank"),
            p_cheque_path: path,
          });
        }}
      />
    </div>
  );
}

function ExcessTab() {
  const rows = useQuery(
    async () =>
      must(
        await supabase
          .from("excess_refunds")
          .select("id, booking_id, amount, reason, account_holder, account_number, ifsc, bank_name, cancelled_cheque_path, status, payment_mode, payment_reference, paid_on, requested_at, bookings(customer_name)")
          .order("requested_at", { ascending: false }),
      ) as unknown as Excess[],
    [],
  );
  const today = todayIst();
  return (
    <>
      <NewExcess />
      <Card title="Excess-amount refunds">
        <Loaded q={rows}>
          {(list) => (
            <Table head={["Customer", "Amount", "Bank details", "Status", ""]}>
              {list.length === 0 ? (
                <EmptyRow cols={5} text="No excess-amount refunds." />
              ) : (
                list.map((x) => (
                  <tr key={x.id}>
                    <Td>
                      {x.bookings?.customer_name}
                      <div className="text-xs text-slate-500">{x.reason}</div>
                    </Td>
                    <Td right>{inr(x.amount)}</Td>
                    <Td>
                      <span className="text-xs">
                        {x.account_holder} · {x.account_number} · {x.ifsc}
                        <button type="button" className="ml-1 text-blue-700 hover:underline" onClick={() => openFile(x.cancelled_cheque_path)}>
                          cheque
                        </button>
                      </span>
                    </Td>
                    <Td>
                      <Chip tone={x.status === "paid" ? "emerald" : x.status === "pending" ? "amber" : "slate"}>{x.status}</Chip>
                      {x.paid_on && <div className="text-xs">{`${x.payment_mode?.toUpperCase()} ${x.payment_reference} · ${fmtDate(x.paid_on)}`}</div>}
                    </Td>
                    <Td>
                      {x.status === "pending" && (
                        <div className="space-y-1">
                          <ActionForm
                            label="Paid"
                            hidden={{}}
                            fields={[
                              { name: "mode", placeholder: "Mode", options: MODES, required: true, width: "w-24" },
                              { name: "ref", placeholder: "UTR / cheque no.", required: true, width: "w-32" },
                              { name: "on", placeholder: "Date", type: "date", required: true, width: "w-36", initial: today },
                            ]}
                            action={async (fd) => {
                              await rpc("pay_excess_refund", { p_id: x.id, p_mode: str(fd, "mode"), p_reference: str(fd, "ref"), p_paid_on: str(fd, "on") });
                            }}
                          />
                          <RunButton
                            tone="danger"
                            label="Void"
                            run={async () => {
                              const reason = window.prompt("Why void it?");
                              if (reason) await rpc("void_excess_refund", { p_id: x.id, p_reason: reason });
                            }}
                          />
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
    </>
  );
}

function NewExcess() {
  const [search, setSearch] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const matches = useQuery(async () => {
    const safe = search.replace(/[,()%*]/g, " ").trim();
    if (safe.length < 3) return [] as { id: string; customer_name: string | null; customer_mobile: string | null; ctdms_order_booking_no: string | null }[];
    return must(
      await supabase
        .from("bookings")
        .select("id, customer_name, customer_mobile, ctdms_order_booking_no")
        .neq("status", "cancelled")
        .or(`customer_name.ilike.%${safe}%,customer_mobile.ilike.%${safe}%,ctdms_order_booking_no.ilike.%${safe}%`)
        .limit(8),
    ) as { id: string; customer_name: string | null; customer_mobile: string | null; ctdms_order_booking_no: string | null }[];
  }, [search]);
  return (
    <Card title="Raise an excess-amount refund" note="Only what was received above the deal amount can be refunded.">
      <div className="space-y-2 px-3 py-2 text-sm">
        <input className="rounded-md border border-slate-300 px-2 py-1 text-sm" placeholder="Customer, mobile or order no." value={search} onChange={(e) => setSearch(e.target.value)} />
        <input type="file" accept="image/*,application/pdf" className="ml-2 text-xs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {(matches.data ?? []).map((b) => (
          <div key={b.id} className="flex flex-wrap items-center gap-2">
            <span>
              {b.customer_name} <span className="text-xs text-slate-500">{b.customer_mobile} {b.ctdms_order_booking_no}</span>
            </span>
            <ActionForm
              label="Raise"
              hidden={{}}
              fields={[
                { name: "amount", placeholder: "Amount", type: "number", required: true, width: "w-24" },
                { name: "reason", placeholder: "Reason", required: true, width: "w-32" },
                { name: "holder", placeholder: "Account holder", required: true, width: "w-32" },
                { name: "account", placeholder: "Account no.", required: true, width: "w-32" },
                { name: "ifsc", placeholder: "IFSC", required: true, width: "w-24" },
                { name: "bank", placeholder: "Bank", width: "w-24" },
              ]}
              action={async (fd) => {
                if (!file) throw new Error("Attach the cancelled cheque");
                const path = await uploadCheque(b.id, file);
                await rpc("request_excess_refund", {
                  p_booking_id: b.id,
                  p_amount: num(fd, "amount"),
                  p_reason: str(fd, "reason"),
                  p_holder: str(fd, "holder"),
                  p_account: str(fd, "account"),
                  p_ifsc: str(fd, "ifsc"),
                  p_bank: str(fd, "bank"),
                  p_cheque_path: path,
                });
                setSearch("");
              }}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}
