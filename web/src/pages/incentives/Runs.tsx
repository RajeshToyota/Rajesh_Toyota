import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Stat, Table, Td, fmtDateTime, inputCls, inr, monthIst, rpc, rpcRows, str } from "@/ui";
import { OutletPicker, useOutlets } from "@/pages/ops/shared";
import { HELD, KINDS, firstOfMonth, monthLabel } from "./shared";

type Run = { id: string; month: string; status: string; inputs: { gm_sm_amounts?: Record<string, number> }; calculated_at: string | null; approved_at: string | null; note: string | null };
type Line = {
  id: string;
  employee_id: string;
  employee: string;
  role: string | null;
  outlet: string | null;
  kind: string;
  scheme: string | null;
  basis: Record<string, unknown>;
  gross: number;
  eligible: boolean;
  ineligible_reason: string | null;
  release_now: number;
  held: number;
  held_until: string | null;
  held_released_at: string | null;
};
type Held = { held_until: string; month: string; outlet: string | null; lines: number; amount: number };
type Gate = { employee_id: string; employee: string; outlet: string | null };

const basisText = (kind: string, b: Record<string, unknown>) => {
  if (kind === "ca_retail") return `${b.units} cars × ${inr(b.rate as number)}${Number(b.focus_bonus) ? ` + focus ${inr(b.focus_bonus as number)}` : ""} · ${b.lead_checks} lead checks`;
  if (kind === "tl_team") return `${b.team_members} in team, team incentive ${inr(b.team_ca_incentive as number)}`;
  if (kind === "gm_sm") return `${b.share} ${b.pct}% of TKM ${inr(b.tkm_amount as number)}${Number(b.shared_by) > 1 ? ` ÷ ${b.shared_by}` : ""}`;
  if (kind === "prefinance") return `${b.files} files of ${b.financeable_sales} (${b.penetration_pct}%) × ${inr(b.per_file as number)}${Number(b.shared_by) > 1 ? ` ÷ ${b.shared_by}` : ""}`;
  return "";
};

// Techwheels' payroll incentive engine for one month: calculate, check, approve; later release what was held.
export default function Runs() {
  const [month, setMonth] = useState(monthIst());
  const first = firstOfMonth(month);
  const run = useQuery(async () => (must(await supabase.from("incentive_runs").select("*").eq("month", first).neq("status", "cancelled").maybeSingle()) as Run | null) ?? null, [first]);
  const outlets = useOutlets();
  const canEdit = useRightGate("incentives", "edit");
  const canApprove = useRightGate("incentives", "approve");
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const calc = async () => {
    const gm = Object.fromEntries(Object.entries({ ...Object.fromEntries(Object.entries(run.data?.inputs.gm_sm_amounts ?? {}).map(([k, v]) => [k, String(v)])), ...amounts }).filter(([, v]) => v).map(([k, v]) => [k, Number(v)]));
    await rpc("calculate_incentive_run", { p_month: first, p_inputs: { gm_sm_amounts: gm } });
  };

  return (
    <div>
      <PageHeader
        title="Incentive Runs"
        note="Calculate the month from invoiced cars and the schemes in force, check each line, approve. Held parts are released on TKM settlement or bank payment."
        actions={<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls} />}
      />
      <Loaded q={run}>
        {(r) => (
          <>
            <Card
              title={`${monthLabel(first)}: ${r ? r.status : "not calculated"}`}
              note={r ? `Calculated ${fmtDateTime(r.calculated_at)}${r.approved_at ? ` · approved ${fmtDateTime(r.approved_at)}` : ""}` : "Enter TKM's GM/SM amount per branch (if any), then calculate."}
              aside={
                <div className="flex gap-2">
                  {canEdit && r?.status !== "approved" && <RunButton label={r ? "Recalculate" : "Calculate"} run={calc} />}
                  {canApprove && r?.status === "draft" && <RunButton label="Approve" confirm="Approve this month's incentives?" run={() => rpc("approve_incentive_run", { p_run_id: r.id })} />}
                  {canApprove && r && (
                    <RunButton tone="danger" label="Cancel run" confirm="Cancel this run? It can then be calculated again." run={() => rpc("cancel_incentive_run", { p_run_id: r.id, p_note: "Cancelled to recalculate" })} />
                  )}
                </div>
              }
            >
              {canEdit && r?.status !== "approved" && (
                <div className="flex flex-wrap gap-3 px-3 py-2 text-sm">
                  <span className="text-slate-500">TKM GM/SM incentive:</span>
                  {(outlets.data ?? []).map((o) => (
                    <label key={o.id} className="flex items-center gap-1">
                      <span className="text-slate-600">{o.name.replace("Rajesh Toyota - ", "")}</span>
                      <input
                        type="number"
                        className={`${inputCls} w-28`}
                        value={amounts[o.id] ?? String(r?.inputs.gm_sm_amounts?.[o.id] ?? "")}
                        onChange={(e) => setAmounts((a) => ({ ...a, [o.id]: e.target.value }))}
                        placeholder="₹"
                      />
                    </label>
                  ))}
                </div>
              )}
            </Card>
            {r && <RunLines runId={r.id} />}
            {canEdit && r?.status !== "approved" && <Gates month={first} />}
          </>
        )}
      </Loaded>
      <HeldPanel />
    </div>
  );
}

function RunLines({ runId }: { runId: string }) {
  const q = useQuery(() => rpcRows<Line>("incentive_run_lines", { p_run_id: runId }), [runId]);
  return (
    <Loaded q={q}>
      {(lines) => {
        const sum = (f: (l: Line) => number) => lines.reduce((a, l) => a + Number(f(l)), 0);
        return (
          <>
            <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
              <Stat label="Gross" value={inr(sum((l) => (l.eligible ? l.gross : 0)))} note={`${lines.length} lines`} />
              <Stat label="Pay now" value={inr(sum((l) => l.release_now))} />
              <Stat label="Held" value={inr(sum((l) => l.held))} note="TKM settlement / bank payment" />
              <Stat label="Not eligible" value={inr(sum((l) => (l.eligible ? 0 : l.gross)))} tone="amber" note={`${lines.filter((l) => !l.eligible).length} people`} />
            </div>
            <Card title="Lines">
              <Table head={["Employee", "Scheme", "Basis", "Gross", "Pay now", "Held", ""]}>
                {lines.length === 0 ? (
                  <EmptyRow cols={7} text="Nothing earned this month." />
                ) : (
                  lines.map((l) => (
                    <tr key={l.id} className={l.eligible ? "" : "bg-amber-50/50"}>
                      <Td>
                        {l.employee}
                        <div className="text-xs text-slate-500">
                          {l.role} · {l.outlet}
                        </div>
                      </Td>
                      <Td>
                        <Chip>{KINDS[l.kind] ?? l.kind}</Chip>
                      </Td>
                      <Td muted>
                        <span className="text-xs">{basisText(l.kind, l.basis)}</span>
                        {!l.eligible && <div className="text-xs font-medium text-amber-800">{l.ineligible_reason}</div>}
                      </Td>
                      <Td right>{inr(l.gross)}</Td>
                      <Td right>{inr(l.release_now)}</Td>
                      <Td right>
                        {inr(l.held)}
                        {l.held_until && <div className="text-xs text-slate-500">{HELD[l.held_until]}</div>}
                      </Td>
                      <Td>{l.held_released_at && <Chip tone="emerald">Held released</Chip>}</Td>
                    </tr>
                  ))
                )}
              </Table>
            </Card>
          </>
        );
      }}
    </Loaded>
  );
}

// The CA gates for the month: digital check-in, leads checked, learning assessment.
function Gates({ month }: { month: string }) {
  const q = useQuery(async () => {
    const people = await rpcRows<Gate & { role: string }>("target_vs_actual", { p_month: month });
    const saved = must(await supabase.from("employee_monthly_compliance").select("employee_id, digital_checkin, lead_checks, assessment_passed").eq("month", month)) as {
      employee_id: string;
      digital_checkin: boolean;
      lead_checks: number | null;
      assessment_passed: boolean;
    }[];
    return people.filter((p) => p.role === "Sales Consultant").map((p) => ({ ...p, saved: saved.find((s) => s.employee_id === p.employee_id) }));
  }, [month]);
  return (
    <Card title="CA gates this month" note="A CA's incentive is paid only with digital check-in, the minimum lead checks and the learning assessment. Leave lead checks empty to count follow-ups logged.">
      <Loaded q={q}>
        {(rows) => (
          <Table head={["Consultant", "Recorded", "Update"]}>
            {rows.length === 0 ? (
              <EmptyRow cols={3} text="No consultants." />
            ) : (
              rows.map((r) => (
                <tr key={r.employee_id}>
                  <Td>{r.employee}</Td>
                  <Td>
                    <div className="flex gap-1">
                      <Chip tone={r.saved?.digital_checkin ? "emerald" : "slate"}>Check-in</Chip>
                      <Chip tone={r.saved?.lead_checks != null ? "blue" : "slate"}>Leads {r.saved?.lead_checks ?? "auto"}</Chip>
                      <Chip tone={r.saved?.assessment_passed ? "emerald" : "slate"}>Assessment</Chip>
                    </div>
                  </Td>
                  <Td>
                    <ActionForm
                      label="Save"
                      hidden={{}}
                      fields={[
                        { name: "checkin", placeholder: "Check-in", options: [{ id: "yes", name: "Checked in" }, { id: "no", name: "No check-in" }], initial: r.saved?.digital_checkin ? "yes" : "", width: "w-32" },
                        { name: "leads", placeholder: "Lead checks", type: "number", initial: r.saved?.lead_checks != null ? String(r.saved.lead_checks) : "", width: "w-24" },
                        { name: "assess", placeholder: "Assessment", options: [{ id: "yes", name: "Passed" }, { id: "no", name: "Not done" }], initial: r.saved?.assessment_passed ? "yes" : "", width: "w-32" },
                      ]}
                      action={async (fd) => {
                        await rpc("save_compliance", {
                          p_month: month,
                          p_employee_id: r.employee_id,
                          p_digital_checkin: str(fd, "checkin") === "yes",
                          p_lead_checks: str(fd, "leads") ? Number(str(fd, "leads")) : null,
                          p_assessment_passed: str(fd, "assess") === "yes",
                        });
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
  );
}

function HeldPanel() {
  const q = useQuery(() => rpcRows<Held>("held_incentives_summary"), []);
  const canApprove = useRightGate("incentives", "approve");
  const [outlet, setOutlet] = useState("");
  if (!q.data?.length) return null;
  return (
    <Card title="Still held" note="Approved incentives waiting for TKM's settlement or the bank's payment.">
      <Table head={["Waiting for", "Month", "Branch", "Lines", "Amount"]}>
        {q.data.map((h) => (
          <tr key={`${h.held_until}-${h.month}-${h.outlet}`}>
            <Td>{HELD[h.held_until]}</Td>
            <Td>{monthLabel(h.month)}</Td>
            <Td muted>{h.outlet ?? "All"}</Td>
            <Td right>{h.lines}</Td>
            <Td right>{inr(h.amount)}</Td>
          </tr>
        ))}
      </Table>
      {canApprove && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2">
          <OutletPicker value={outlet} onChange={setOutlet} />
          <ActionForm
            label="Release"
            hidden={{}}
            fields={[
              { name: "until", placeholder: "Settled by", options: Object.entries(HELD).map(([id, name]) => ({ id, name })), required: true, width: "w-40" },
              { name: "upto", placeholder: "Up to month", type: "date", required: true, width: "w-36" },
              { name: "note", placeholder: "Credit note / UTR", required: true, width: "w-48" },
            ]}
            action={async (fd) => {
              await rpc("release_held_incentives", { p_held_until: str(fd, "until"), p_up_to_month: str(fd, "upto"), p_note: str(fd, "note"), p_outlet_id: outlet || null });
            }}
          />
        </div>
      )}
    </Card>
  );
}
