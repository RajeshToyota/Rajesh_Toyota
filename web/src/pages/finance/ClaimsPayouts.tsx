import { useState } from "react";
import { useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Table, Tabs, Td, inr, inputCls, monthIst, num, rpc, rpcRows, str, todayIst } from "@/ui";

type Claim = {
  financier_id: string;
  financier: string;
  outlet_id: string | null;
  outlet: string;
  files: number;
  total_do: number;
  month_total_do: number;
  bank_payout: number;
  ca_payout: number;
  addon_eligible: boolean;
  addon_payout: number;
  payout_total: number;
  expected_invoice: number;
  taxable: number;
  gst: number;
  claim_id: string | null;
  claim_status: string | null;
  invoice_no: string | null;
  bank_utr: string | null;
  ca_utr: string | null;
};
type Sp = { case_id: string; customer_name: string; employee: string; financier: string; do_value: number; rate_percent: number; amount: number; released: boolean; bank_utr: string | null };

// Techwheels' Claims & Payouts: the month's claim to each bank from verified disbursed cases, its
// invoice and the money received; and the consultants' finance payout, released once the bank pays.
export default function ClaimsPayouts() {
  const [month, setMonth] = useState(monthIst());
  const [tab, setTab] = useState("claims");
  return (
    <div>
      <PageHeader
        title="Claims & Payouts"
        note="Only verified, disbursed in-house cases count. DO = net disbursement, else the DO amount, else the loan. GST is added unless the bank's payout includes it."
        actions={<input type="month" className={inputCls} value={month} onChange={(e) => setMonth(e.target.value)} />}
      />
      <Tabs current={tab} onChange={setTab} tabs={[{ id: "claims", label: "Bank claims" }, { id: "sp", label: "Consultant payout" }]} />
      {tab === "claims" ? <Claims month={`${month}-01`} /> : <SpPayouts month={`${month}-01`} />}
    </div>
  );
}

function Claims({ month }: { month: string }) {
  const canEdit = useRightGate("finance_claims", "edit");
  const canApprove = useRightGate("finance_claims", "approve");
  const q = useQuery(() => rpcRows<Claim>("finance_claims_summary", { p_month: month }), [month]);
  return (
    <Card>
      <Loaded q={q}>
        {(rows) => (
          <Table head={["Bank / branch", "Files / DO", "Bank", "CA", "Add-on", "Invoice", "Status", ""]}>
            {rows.length === 0 ? (
              <EmptyRow cols={8} text="No verified disbursements this month." />
            ) : (
              rows.map((c) => (
                <tr key={`${c.financier_id}-${c.outlet_id}`}>
                  <Td>
                    {c.financier}
                    <div className="text-xs text-slate-500">{c.outlet}</div>
                  </Td>
                  <Td right>
                    {c.files} · {inr(c.total_do)}
                  </Td>
                  <Td right>{inr(c.bank_payout)}</Td>
                  <Td right>{inr(c.ca_payout)}</Td>
                  <Td right>
                    {c.addon_eligible ? inr(c.addon_payout) : <span className="text-xs text-slate-400">below target ({inr(c.month_total_do)})</span>}
                  </Td>
                  <Td right>
                    {inr(c.expected_invoice)}
                    <div className="text-xs text-slate-500">
                      {inr(c.taxable)} + GST {inr(c.gst)}
                    </div>
                  </Td>
                  <Td>
                    {c.claim_status ? <Chip tone={c.claim_status === "settled" ? "emerald" : "blue"}>{c.claim_status.replace("_", " ")}</Chip> : <Chip>not generated</Chip>}
                    {c.invoice_no && <div className="text-xs">Inv {c.invoice_no}</div>}
                    {c.bank_utr && <div className="text-xs">UTR {c.bank_utr}</div>}
                    {c.ca_utr && <div className="text-xs">CA UTR {c.ca_utr}</div>}
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      {canEdit && (!c.claim_status || c.claim_status === "generated") && (
                        <RunButton tone="light" label={c.claim_id ? "Refresh" : "Generate"} run={() => rpc("claim_generate", { p_month: month, p_financier_id: c.financier_id, p_outlet_id: c.outlet_id })} />
                      )}
                      {c.claim_id && (
                        <RunButton tone="light" label="Print letter" run={async () => printLetter(c, month)} />
                      )}
                      {canEdit && c.claim_id && (c.claim_status === "generated" || c.claim_status === "invoiced") && (
                        <ActionForm
                          label="Invoice"
                          hidden={{}}
                          fields={[
                            { name: "no", placeholder: "Invoice no.", required: true, width: "w-28" },
                            { name: "date", placeholder: "Date", type: "date", required: true, width: "w-36", initial: todayIst() },
                            { name: "amt", placeholder: "Amount", type: "number", required: true, width: "w-28", initial: String(c.expected_invoice) },
                          ]}
                          action={async (fd) => {
                            await rpc("claim_step", { p_claim_id: c.claim_id, p_step: "invoice", p: { invoice_no: str(fd, "no"), invoice_date: str(fd, "date"), invoice_amount: num(fd, "amt") } });
                          }}
                        />
                      )}
                      {canEdit && c.claim_status === "invoiced" && (
                        <ActionForm label="Bank paid" hidden={{}} fields={[{ name: "utr", placeholder: "UTR", required: true, width: "w-32" }]} action={async (fd) => { await rpc("claim_step", { p_claim_id: c.claim_id, p_step: "bank_received", p: { utr: str(fd, "utr") } }); }} />
                      )}
                      {canEdit && c.claim_status === "bank_received" && (
                        <ActionForm label="CA / add-on paid" hidden={{}} fields={[{ name: "utr", placeholder: "UTR", width: "w-32" }]} action={async (fd) => { await rpc("claim_step", { p_claim_id: c.claim_id, p_step: "settled", p: { utr: str(fd, "utr") } }); }} />
                      )}
                      {canApprove && c.claim_status && c.claim_status !== "generated" && (
                        <RunButton tone="danger" label="Undo step" confirm="Step this claim back?" run={() => rpc("claim_step", { p_claim_id: c.claim_id, p_step: "undo" })} />
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
  );
}

// The claim letter, printed from the browser in the bank's format.
function printLetter(c: Claim, month: string) {
  const m = new Date(month).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>Claim ${c.financier} ${m}</title>
  <style>body{font-family:Arial,sans-serif;margin:40px;font-size:14px}table{border-collapse:collapse;width:100%;margin-top:16px}td,th{border:1px solid #999;padding:6px;text-align:left}td.r{text-align:right}</style>
  </head><body>
  <p>Rajesh Toyota</p><p>To,<br>The Manager<br>${c.financier}${c.outlet_id ? `<br>${c.outlet}` : ""}</p>
  <p><strong>Subject: Payout claim for ${m}${c.invoice_no ? ` — Invoice ${c.invoice_no}` : ""}</strong></p>
  <p>We claim the payout for the loans disbursed through us in ${m}:</p>
  <table><tr><th>Files</th><th>Total DO</th><th>Dealer payout</th><th>CA payout</th><th>Add-on</th><th>Taxable</th><th>GST</th><th>Total</th></tr>
  <tr><td class="r">${c.files}</td><td class="r">${c.total_do.toLocaleString("en-IN")}</td><td class="r">${c.bank_payout.toLocaleString("en-IN")}</td>
  <td class="r">${c.ca_payout.toLocaleString("en-IN")}</td><td class="r">${c.addon_payout.toLocaleString("en-IN")}</td><td class="r">${c.taxable.toLocaleString("en-IN")}</td>
  <td class="r">${c.gst.toLocaleString("en-IN")}</td><td class="r"><strong>${c.expected_invoice.toLocaleString("en-IN")}</strong></td></tr></table>
  <p style="margin-top:48px">Authorised signatory</p>
  <script>window.print()</script></body></html>`);
  w.document.close();
}

function SpPayouts({ month }: { month: string }) {
  const q = useQuery(() => rpcRows<Sp>("finance_sp_payouts", { p_month: month }), [month]);
  return (
    <Card note="Each case counts once; it is released when the bank's payout for that month, bank and branch has arrived.">
      <Loaded q={q}>
        {(rows) => (
          <Table head={["Consultant", "Customer", "Bank", "DO", "Payout", ""]}>
            {rows.length === 0 ? (
              <EmptyRow cols={6} text="No verified disbursements this month." />
            ) : (
              rows.map((r) => (
                <tr key={r.case_id}>
                  <Td>{r.employee}</Td>
                  <Td muted>{r.customer_name}</Td>
                  <Td muted>{r.financier}</Td>
                  <Td right>{inr(r.do_value)}</Td>
                  <Td right>
                    {inr(r.amount)} <span className="text-xs text-slate-400">({r.rate_percent}%)</span>
                  </Td>
                  <Td>{r.released ? <Chip tone="emerald">Released</Chip> : <Chip tone="amber">Waiting for the bank</Chip>}</Td>
                </tr>
              ))
            )}
          </Table>
        )}
      </Loaded>
    </Card>
  );
}
