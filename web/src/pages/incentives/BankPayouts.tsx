import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Table, Tabs, Td, fmtDate, inr, rpc, rpcRows, str, titleCase, todayIst } from "@/ui";

type Payout = {
  id: string;
  kind: string;
  status: string;
  customer_name: string;
  employee: string;
  outlet: string;
  financier: string | null;
  amount: number;
  invoice_no: string | null;
  invoice_date: string | null;
  verified_by: string | null;
  approved_by: string | null;
  paid_on: string | null;
  note: string | null;
  rejected_reason: string | null;
};
type Candidate = { finance_case_id: string; customer_name: string; employee: string; financier: string | null; loan_amount: number | null; status: string };

const tone: Record<string, "amber" | "blue" | "emerald" | "slate" | "red"> = {
  submitted: "amber",
  accounts_verified: "blue",
  gm_approved: "blue",
  paid: "emerald",
  rejected: "slate",
  flagged: "red",
};

// SOP: the bank pays the CA directly on in-house cases. The CA submits the invoice, Accounts verifies,
// the GM approves; any payout taken on an outside loan without telling the company is flagged.
export default function BankPayouts() {
  const [status, setStatus] = useState("");
  const list = useQuery(() => rpcRows<Payout>("bank_payout_list", { p_status: status || null }), [status]);
  const candidates = useQuery(() => rpcRows<Candidate>("bank_payout_candidates"), []);
  const canDesk = useRightGate("bank_payouts", "edit");
  const canApprove = useRightGate("incentives", "approve");

  return (
    <div>
      <PageHeader title="Bank Payouts to CA" note="In-house loans only. Every payout a CA receives is listed here, case by case." />
      <Card title={`Cases to claim (${candidates.data?.length ?? 0})`} note="In-house loans at DO or disbursed with no payout invoice yet.">
        <Loaded q={candidates}>
          {(rows) => (
            <Table head={["Customer", "CA", "Bank", "Loan", "Submit invoice"]}>
              {rows.length === 0 ? (
                <EmptyRow cols={5} text="Nothing to claim." />
              ) : (
                rows.map((c) => (
                  <tr key={c.finance_case_id}>
                    <Td>{c.customer_name}</Td>
                    <Td muted>{c.employee}</Td>
                    <Td muted>{c.financier}</Td>
                    <Td right>{inr(c.loan_amount)}</Td>
                    <Td>
                      <ActionForm
                        label="Submit"
                        hidden={{}}
                        fields={[
                          { name: "amount", placeholder: "Payout ₹", type: "number", required: true, width: "w-28" },
                          { name: "no", placeholder: "Invoice no.", required: true, width: "w-28" },
                          { name: "date", placeholder: "Date", type: "date", initial: todayIst(), required: true, width: "w-36" },
                        ]}
                        action={async (fd) => {
                          await rpc("submit_bank_payout", { p_finance_case_id: c.finance_case_id, p_amount: Number(str(fd, "amount")), p_invoice_no: str(fd, "no"), p_invoice_date: str(fd, "date") });
                        }}
                      />
                    </Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
      </Card>
      <Tabs
        current={status}
        onChange={setStatus}
        tabs={[{ id: "", label: "All" }, ...["submitted", "accounts_verified", "gm_approved", "paid", "flagged", "rejected"].map((s) => ({ id: s, label: titleCase(s) }))]}
      />
      <Card>
        <Loaded q={list}>
          {(rows) => (
            <Table head={["Customer", "CA", "Bank", "Amount", "Invoice", "Status", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={7} text="No payouts." />
              ) : (
                rows.map((p) => (
                  <tr key={p.id}>
                    <Td>
                      {p.customer_name}
                      <div className="text-xs text-slate-500">{p.outlet}</div>
                    </Td>
                    <Td>{p.employee}</Td>
                    <Td muted>{p.kind === "outhouse_flag" ? "Outside loan" : p.financier}</Td>
                    <Td right>{inr(p.amount)}</Td>
                    <Td muted>
                      {p.invoice_no ?? "—"}
                      <div className="text-xs">{fmtDate(p.invoice_date)}</div>
                    </Td>
                    <Td>
                      <Chip tone={tone[p.status]}>{titleCase(p.status)}</Chip>
                      {(p.note || p.rejected_reason) && <div className="max-w-xs text-xs text-slate-500">{p.rejected_reason ?? p.note}</div>}
                      {p.paid_on && <div className="text-xs text-slate-500">Paid {fmtDate(p.paid_on)}</div>}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {p.status === "submitted" && canDesk && <RunButton label="Verify" run={() => rpc("move_bank_payout", { p_id: p.id, p_status: "accounts_verified" })} />}
                        {p.status === "accounts_verified" && canApprove && <RunButton label="Approve" run={() => rpc("move_bank_payout", { p_id: p.id, p_status: "gm_approved" })} />}
                        {p.status === "gm_approved" && canDesk && <RunButton label="Mark paid" run={() => rpc("move_bank_payout", { p_id: p.id, p_status: "paid" })} />}
                        {["submitted", "accounts_verified", "gm_approved"].includes(p.status) && (canDesk || canApprove) && (
                          <ActionForm
                            tone="danger"
                            label="Reject"
                            hidden={{}}
                            fields={[{ name: "why", placeholder: "Why", required: true, width: "w-28" }]}
                            action={async (fd) => {
                              await rpc("move_bank_payout", { p_id: p.id, p_status: "rejected", p_note: str(fd, "why") });
                            }}
                          />
                        )}
                      </div>
                    </Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
      </Card>
      {canDesk && <FlagOuthouse />}
    </div>
  );
}

function FlagOuthouse() {
  const bookings = useQuery(
    async () =>
      (must(await supabase.from("bookings").select("id, customer_name, mode_of_purchase").not("mode_of_purchase", "ilike", "%cash%").order("created_at", { ascending: false }).limit(300)) as {
        id: string;
        customer_name: string;
        mode_of_purchase: string | null;
      }[]).map((b) => ({ id: b.id, name: `${b.customer_name} · ${b.mode_of_purchase ?? ""}` })),
    [],
  );
  return (
    <Card title="Flag a payout on an outside loan" note="A CA taking a payout from a DSA or bank on an outside loan without telling the company. The GM sees every flag.">
      <div className="px-3 py-2">
        <ActionForm
          tone="danger"
          label="Flag"
          hidden={{}}
          fields={[
            { name: "booking", placeholder: "Booking", options: bookings.data ?? [], required: true, width: "w-72" },
            { name: "amount", placeholder: "Amount ₹", type: "number", width: "w-28" },
            { name: "note", placeholder: "What was found", required: true, width: "w-72" },
          ]}
          action={async (fd) => {
            await rpc("flag_outhouse_payout", { p_booking_id: str(fd, "booking"), p_amount: str(fd, "amount") ? Number(str(fd, "amount")) : null, p_note: str(fd, "note") });
          }}
        />
      </div>
    </Card>
  );
}
