import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Select, Table, Td, fmtDate, inr, inputCls, rpc, rpcRows, titleCase } from "@/ui";

type Row = {
  case_id: string;
  booking_id: string;
  customer_name: string;
  outlet: string;
  financier: string;
  branch: string | null;
  executive: string | null;
  finance_type: string;
  status: string;
  loan_amount: number | null;
  do_amount: number | null;
  disbursed_amount: number | null;
  net_disbursement_amount: number | null;
  disbursement_month: string | null;
  verified: boolean;
  is_final: boolean;
};

const STATUSES = ["docs_pending", "logged_in", "credit_review", "sanctioned", "do_received", "disbursed", "on_hold", "rejected"].map((s) => ({ id: s, name: titleCase(s) }));

// Techwheels' Finance Cases by Executive: every bank case, filtered, with bulk verification of the
// month's disbursements. A booking can be logged with several banks; ★ marks the final (HPN) bank.
export default function Desk() {
  const canApprove = useRightGate("finance_cases", "approve");
  const [month, setMonth] = useState("");
  const [financier, setFinancier] = useState("");
  const [status, setStatus] = useState("");
  const [verified, setVerified] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const banks = useQuery(async () => must(await supabase.from("financiers").select("id, name").order("name")) as { id: string; name: string }[], []);
  const q = useQuery(
    () =>
      rpcRows<Row>("finance_cases_desk", {
        p_month: month ? `${month}-01` : null,
        p_financier_id: financier || null,
        p_status: status || null,
        p_verified: verified === "" ? null : verified === "yes",
      }),
    [month, financier, status, verified],
  );
  const verifiable = (q.data ?? []).filter((r) => !r.verified && r.status === "disbursed");

  return (
    <div>
      <PageHeader
        title="Finance Desk"
        note="Verify a disbursed case once the amount, month and DO are right: its disbursement details then lock (unverifying needs approval) and it counts in the month's claim."
        actions={
          <>
            <input className={inputCls} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            <Select value={financier} onChange={setFinancier} options={banks.data ?? []} placeholder="All banks" />
            <Select value={status} onChange={setStatus} options={STATUSES} placeholder="Any status" />
            <Select value={verified} onChange={setVerified} options={[{ id: "yes", name: "Verified" }, { id: "no", name: "Not verified" }]} placeholder="Verified?" />
          </>
        }
      />
      {picked.length > 0 && (
        <div className="mb-2">
          <RunButton
            label={`Verify ${picked.length}`}
            run={async () => {
              const errors: string[] = [];
              for (const id of picked) {
                try {
                  await rpc("set_case_verified", { p_case_id: id, p_verified: true }, { refresh: false });
                } catch (e) {
                  errors.push(e instanceof Error ? e.message : String(e));
                }
              }
              setPicked([]);
              q.reload();
              if (errors.length) alert(errors.join("\n"));
            }}
          />
        </div>
      )}
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table
              head={[
                <input
                  key="all"
                  type="checkbox"
                  checked={verifiable.length > 0 && picked.length === verifiable.length}
                  onChange={(e) => setPicked(e.target.checked ? verifiable.map((r) => r.case_id) : [])}
                />,
                "Customer",
                "Bank",
                "Status",
                "Loan / DO",
                "Disbursed",
                "",
              ]}
            >
              {rows.length === 0 ? (
                <EmptyRow cols={7} text="No cases." />
              ) : (
                rows.map((r) => (
                  <tr key={r.case_id}>
                    <Td>
                      {!r.verified && r.status === "disbursed" && (
                        <input type="checkbox" checked={picked.includes(r.case_id)} onChange={() => setPicked(picked.includes(r.case_id) ? picked.filter((x) => x !== r.case_id) : [...picked, r.case_id])} />
                      )}
                    </Td>
                    <Td>
                      <Link to={`/finance/${r.case_id}`} className="text-blue-700 hover:underline">
                        {r.customer_name}
                      </Link>
                      <div className="text-xs text-slate-500">
                        {r.outlet} · {r.executive ?? "unassigned"} · {r.finance_type === "own" ? "own finance" : "in-house"}
                      </div>
                    </Td>
                    <Td>
                      {r.is_final && "★ "}
                      {r.financier}
                      {r.branch && <div className="text-xs text-slate-500">{r.branch}</div>}
                    </Td>
                    <Td>
                      <Chip tone={r.status === "disbursed" ? "emerald" : r.status === "rejected" ? "red" : r.status === "on_hold" ? "amber" : "blue"}>{titleCase(r.status)}</Chip>
                    </Td>
                    <Td right>
                      {inr(r.loan_amount)}
                      <div className="text-xs text-slate-500">DO {inr(r.do_amount)}</div>
                    </Td>
                    <Td right>
                      {inr(r.net_disbursement_amount ?? r.disbursed_amount)}
                      <div className="text-xs text-slate-500">{r.disbursement_month ? fmtDate(r.disbursement_month).slice(3) : ""}</div>
                    </Td>
                    <Td>
                      {r.verified ? (
                        <div className="flex flex-col gap-1">
                          <Chip tone="emerald">Verified</Chip>
                          {canApprove && (
                            <RunButton
                              tone="light"
                              label="Unverify"
                              run={async () => {
                                const reason = window.prompt("Why unverify it?");
                                if (reason) await rpc("set_case_verified", { p_case_id: r.case_id, p_verified: false, p_reason: reason });
                              }}
                            />
                          )}
                        </div>
                      ) : r.status === "disbursed" ? (
                        <RunButton tone="light" label="Verify" run={() => rpc("set_case_verified", { p_case_id: r.case_id, p_verified: true })} />
                      ) : null}
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
