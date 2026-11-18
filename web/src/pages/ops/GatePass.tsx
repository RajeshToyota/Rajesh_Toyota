import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Table, Td, fmtDate, fmtDateTime, inr, inputCls, rpc, rpcRows, str } from "@/ui";
import { carLine } from "./shared";

type Pass = {
  id: string;
  gate_pass_no: string;
  booking_id: string;
  outlet: string;
  customer_name: string;
  model: string | null;
  variant: string | null;
  color: string | null;
  vin: string;
  issued_at: string;
  issued_by: string | null;
  delivered: boolean;
  exited_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
};

// The security desk: gate passes issued, and recording each car as it leaves after the handover.
export default function GatePass() {
  const [since, setSince] = useState(() => new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  const q = useQuery(() => rpcRows<Pass>("gate_pass_list", { p_since: since }), [since]);
  const canExit = useRightGate("gate_pass", "edit");

  return (
    <div>
      <PageHeader
        title="Gate Pass"
        note="A car leaves the yard only with a valid gate pass, after it has been handed over."
        actions={
          <label className="flex items-center gap-2 text-sm text-slate-500">
            Since <input type="date" value={since} onChange={(e) => setSince(e.target.value)} className={inputCls} />
          </label>
        }
      />
      {canExit && (
        <Card title="Record a car leaving">
          <div className="px-3 py-2">
            <ActionForm
              label="Let it out"
              hidden={{}}
              fields={[{ name: "no", placeholder: "Gate pass number, e.g. GP/JP05A/2611/0001", required: true, width: "w-80" }]}
              action={async (fd) => {
                await rpc("record_gate_exit", { p_gate_pass_no: str(fd, "no") });
              }}
            />
          </div>
        </Card>
      )}
      <Card title="Gate passes">
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Gate pass", "Customer", "Car", "Issued", "Status", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={6} text="No gate passes in this period." />
              ) : (
                rows.map((g) => (
                  <tr key={g.id} className={g.voided_at ? "opacity-50" : ""}>
                    <Td>
                      <span className="font-mono">{g.gate_pass_no}</span>
                    </Td>
                    <Td>
                      <Link to={`/reports/bookings/${g.booking_id}`} className="hover:underline">
                        {g.customer_name}
                      </Link>
                      <div className="text-xs text-slate-500">{g.outlet}</div>
                    </Td>
                    <Td>
                      {carLine(g)}
                      <div className="font-mono text-xs text-slate-500">{g.vin}</div>
                    </Td>
                    <Td muted>
                      {fmtDateTime(g.issued_at)}
                      <div className="text-xs">{g.issued_by}</div>
                    </Td>
                    <Td>
                      {g.voided_at ? (
                        <Chip>Cancelled: {g.void_reason}</Chip>
                      ) : g.exited_at ? (
                        <Chip tone="emerald">Left {fmtDateTime(g.exited_at)}</Chip>
                      ) : g.delivered ? (
                        <Chip tone="blue">Handed over, at the gate</Chip>
                      ) : (
                        <Chip tone="amber">Waiting for handover</Chip>
                      )}
                    </Td>
                    <Td>
                      {!g.voided_at && (
                        <div className="flex flex-col gap-1">
                          <RunButton tone="light" label="Gate pass" run={() => printPass(g, "gate")} />
                          <RunButton tone="light" label="No dues" run={() => printPass(g, "nodues")} />
                          {canExit && g.delivered && !g.exited_at && (
                            <ActionForm
                              tone="danger"
                              label="Revert delivery"
                              hidden={{}}
                              fields={[{ name: "why", placeholder: "Reason", required: true, width: "w-32" }]}
                              action={async (fd) => {
                                await rpc("revert_delivered", { p_booking_id: g.booking_id, p_reason: str(fd, "why") });
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

// The printed gate pass, or the No-Dues certificate with what was paid (Techwheels' gate-pass and
// no-dues PDFs), opened in a new window for the browser's print.
async function printPass(g: Pass, kind: "gate" | "nodues") {
  const [due] = await rpcRows<{ deal_amount: number; do_amount: number; other_cleared: number; due: number }>("booking_due", { p_booking_id: g.booking_id });
  if (kind === "nodues" && due && due.due > 0) {
    throw new Error(`₹${Math.round(due.due).toLocaleString("en-IN")} is still due; no No-Dues certificate yet`);
  }
  const w = window.open("", "_blank");
  if (!w) return;
  const car = carLine(g);
  const body =
    kind === "gate"
      ? `<h2>Gate Pass ${g.gate_pass_no}</h2><p>Customer: <b>${g.customer_name}</b></p><p>Car: ${car}<br>VIN: ${g.vin}</p>
         <p>Issued ${fmtDateTime(g.issued_at)} by ${g.issued_by ?? ""}</p><p style="margin-top:60px">Security ________ &nbsp;&nbsp; Customer ________</p>`
      : `<h2>No-Dues Certificate</h2><p>This is to certify that <b>${g.customer_name}</b> has paid in full for ${car} (VIN ${g.vin}).</p>
         <table border="1" cellpadding="6" style="border-collapse:collapse"><tr><td>Deal amount</td><td>${inr(due?.deal_amount)}</td></tr>
         <tr><td>Loan (DO)</td><td>${inr(due?.do_amount)}</td></tr><tr><td>Paid by the customer</td><td>${inr(due?.other_cleared)}</td></tr>
         <tr><td>Due</td><td>${inr(due?.due)}</td></tr></table><p>Date: ${fmtDate(new Date().toISOString())}</p><p style="margin-top:60px">Accounts ________</p>`;
  w.document.write(`<!doctype html><html><head><title>${kind === "gate" ? g.gate_pass_no : "No dues"}</title>
    <style>body{font-family:Arial,sans-serif;margin:40px;font-size:14px}</style></head><body><p>Rajesh Toyota · ${g.outlet}</p>${body}<script>window.print()</script></body></html>`);
  w.document.close();
}
