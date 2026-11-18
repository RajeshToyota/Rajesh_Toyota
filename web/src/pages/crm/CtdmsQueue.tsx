import { useState } from "react";
import { useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Stat, Table, Tabs, Td, fmtDate, fmtDateTime, inputCls, rpc, rpcRows, str, todayIst } from "@/ui";

type Q = { walkin_id: string; visited_at: string; outlet: string; customer_name: string; mobile: string; model: string | null; consultant: string | null; enquiry_id: string; crm_sync_status: string; days_waiting: number; closure_id: string | null; closure_status: string | null; closure_reason: string | null; closure_note: string | null };
type F = { walkin_id: string; visited_at: string; customer_name: string; mobile: string; model: string | null; consultant: string | null; left_reason: string | null; followup_at: string | null; followup_note: string | null; overdue: boolean };
type T = { team_leader: string; consultant: string; model: string; walkins: number; converted: number; ctdms_entered: number; closed: number; with_exchange: number; with_finance: number; conversion_pct: number | null; ctdms_compliance_pct: number | null };

const REASONS = ["not_interested", "bought_elsewhere", "price_issue", "unreachable", "duplicate", "other"].map((id) => ({ id, name: id.replace(/_/g, " ") }));

// Techwheels' green-form queue, for CTDMS: every walk-in that became an enquiry waits here until the
// enquiry has its CTDMS enquiry number (typed in, or matched by the daily CTDMS enquiry report).
export default function CtdmsQueue() {
  const [tab, setTab] = useState("queue");
  return (
    <div>
      <PageHeader title="CTDMS Enquiry Queue" note="Upload the CTDMS enquiry report under CRM sync and matched enquiries leave this queue by themselves." />
      <Tabs current={tab} onChange={setTab} tabs={[{ id: "queue", label: "Awaiting CTDMS no." }, { id: "followups", label: "Left — follow up" }, { id: "report", label: "Team walk-ins" }]} />
      {tab === "queue" ? <Queue /> : tab === "followups" ? <Followups /> : <TeamReport />}
    </div>
  );
}

function Queue() {
  const q = useQuery(() => rpcRows<Q>("walkin_ctdms_queue", {}), []);
  const canEnter = useRightGate("reception_ctdms", "edit");
  const canDecide = useRightGate("reception_ctdms", "approve");
  return (
    <Card>
      <Loaded q={q}>
        {(rows) => (
          <Table head={["Visit", "Customer", "Model / consultant", "Waiting", "CTDMS enquiry no.", "Closure"]}>
            {rows.length === 0 ? (
              <EmptyRow cols={6} text="Every converted walk-in has its CTDMS number." />
            ) : (
              rows.map((r) => (
                <tr key={r.walkin_id}>
                  <Td>{fmtDateTime(r.visited_at)}<div className="text-xs text-slate-500">{r.outlet}</div></Td>
                  <Td>{r.customer_name}<div className="text-xs text-slate-500">{r.mobile}</div></Td>
                  <Td>{r.model ?? "—"}<div className="text-xs text-slate-500">{r.consultant}</div></Td>
                  <Td right><Chip tone={r.days_waiting > 1 ? "red" : r.days_waiting === 1 ? "amber" : "slate"}>{r.days_waiting} d</Chip></Td>
                  <Td>
                    {canEnter && !r.closure_id && (
                      <ActionForm
                        label="Save"
                        hidden={{}}
                        fields={[{ name: "no", placeholder: "CTDMS enquiry no.", required: true, width: "w-40" }]}
                        action={async (fd) => {
                          await rpc("submit_ctdms_enquiry_no", { p_walkin_id: r.walkin_id, p_ctdms_no: str(fd, "no") });
                        }}
                      />
                    )}
                  </Td>
                  <Td>
                    {r.closure_id ? (
                      <div className="flex flex-col gap-1">
                        <span className="text-xs">
                          <Chip tone="amber">Closure asked</Chip> {r.closure_reason?.replace(/_/g, " ")} {r.closure_note && `— ${r.closure_note}`}
                        </span>
                        {canDecide && (
                          <div className="flex gap-1">
                            <RunButton label="Approve" run={() => rpc("decide_walkin_ctdms_closure", { p_closure_id: r.closure_id, p_approve: true })} />
                            <ActionForm
                              tone="danger"
                              label="Reject"
                              hidden={{}}
                              fields={[{ name: "why", placeholder: "Why", required: true, width: "w-28" }]}
                              action={async (fd) => {
                                await rpc("decide_walkin_ctdms_closure", { p_closure_id: r.closure_id, p_approve: false, p_note: str(fd, "why") });
                              }}
                            />
                          </div>
                        )}
                      </div>
                    ) : (
                      <ActionForm
                        tone="light"
                        label="Ask to close"
                        hidden={{}}
                        fields={[
                          { name: "why", placeholder: "Reason", options: REASONS, required: true, width: "w-36" },
                          { name: "note", placeholder: "Note", width: "w-28" },
                        ]}
                        action={async (fd) => {
                          await rpc("request_walkin_ctdms_closure", { p_walkin_id: r.walkin_id, p_reason: str(fd, "why"), p_note: str(fd, "note") });
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

function Followups() {
  const q = useQuery(() => rpcRows<F>("walkin_followups", {}), []);
  return (
    <Card note="Walk-ins of the last 60 days that left without an enquiry.">
      <Loaded q={q}>
        {(rows) => (
          <Table head={["Visit", "Customer", "Why they left", "Follow-up", ""]}>
            {rows.length === 0 ? (
              <EmptyRow cols={5} text="No follow-ups pending." />
            ) : (
              rows.map((r) => (
                <tr key={r.walkin_id}>
                  <Td>{fmtDate(r.visited_at)}<div className="text-xs text-slate-500">{r.model} · {r.consultant}</div></Td>
                  <Td>{r.customer_name}<div className="text-xs text-slate-500">{r.mobile}</div></Td>
                  <Td muted>{r.left_reason}</Td>
                  <Td>
                    {r.followup_at ? <Chip tone={r.overdue ? "red" : "blue"}>{fmtDateTime(r.followup_at)}</Chip> : "—"}
                    {r.followup_note && <div className="text-xs text-slate-500">{r.followup_note}</div>}
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <ActionForm
                        tone="light"
                        label="Set"
                        hidden={{}}
                        fields={[
                          { name: "at", placeholder: "When", type: "datetime-local", required: true, width: "w-44" },
                          { name: "note", placeholder: "Note", width: "w-32" },
                        ]}
                        action={async (fd) => {
                          await rpc("set_walkin_followup", { p_walkin_id: r.walkin_id, p_at: new Date(str(fd, "at")!).toISOString(), p_note: str(fd, "note") });
                        }}
                      />
                      <RunButton tone="light" label="Done" run={() => rpc("set_walkin_followup", { p_walkin_id: r.walkin_id, p_at: null, p_note: null, p_done: true })} />
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

function TeamReport() {
  const today = todayIst();
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const q = useQuery(() => rpcRows<T>("walkin_team_report", { p_from: from, p_to: to }), [from, to]);
  return (
    <>
      <div className="mb-3 flex gap-2">
        <input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <Loaded q={q}>
        {(rows) => {
          const sum = (k: keyof T) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
          const conv = sum("converted");
          return (
            <>
              <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                <Stat label="Walk-ins" value={sum("walkins")} />
                <Stat label="Converted" value={conv} note={sum("walkins") ? `${Math.round((100 * conv) / sum("walkins"))}%` : undefined} />
                <Stat label="CTDMS entered" value={sum("ctdms_entered")} note={conv - sum("closed") > 0 ? `${Math.round((100 * sum("ctdms_entered")) / (conv - sum("closed")))}% compliance` : undefined} />
                <Stat label="Exchange / finance" value={`${sum("with_exchange")} / ${sum("with_finance")}`} />
              </div>
              <Card>
                <Table head={["Team leader", "Consultant", "Model", "Walk-ins", "Converted", "CTDMS no.", "Closed", "Conversion", "Compliance"]}>
                  {rows.length === 0 ? (
                    <EmptyRow cols={9} text="No walk-ins in these dates." />
                  ) : (
                    rows.map((r, i) => (
                      <tr key={i}>
                        <Td>{r.team_leader}</Td>
                        <Td>{r.consultant}</Td>
                        <Td>{r.model}</Td>
                        <Td right>{r.walkins}</Td>
                        <Td right>{r.converted}</Td>
                        <Td right>{r.ctdms_entered}</Td>
                        <Td right>{r.closed}</Td>
                        <Td right>{r.conversion_pct != null ? `${r.conversion_pct}%` : "—"}</Td>
                        <Td right>{r.ctdms_compliance_pct != null ? `${r.ctdms_compliance_pct}%` : "—"}</Td>
                      </tr>
                    ))
                  )}
                </Table>
              </Card>
            </>
          );
        }}
      </Loaded>
    </>
  );
}
