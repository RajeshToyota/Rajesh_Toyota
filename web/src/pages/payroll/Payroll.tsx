import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Select, Table, Tabs, Td, inputCls, inr, monthIst, num, rpc, rpcRows, str } from "@/ui";

type Emp = { id: string; name: string; employee_code: string | null; role_id: string | null; roles: { name: string } | null };
type Salary = { employee_id: string; monthly_salary: number; salary_type: string; pay_components: string | null; payment_type: string; bank_account_no: string | null; bank_ifsc: string | null };
type Entry = {
  employee_id: string;
  pay_components: string;
  base_salary: number;
  leave_days: number;
  leave_deduction: number;
  incentive_release: number;
  car_payout: number;
  model_bonus: number;
  above_target: number;
  finance_payout: number;
  used_car_payout: number;
  accessories_payout: number;
  advance_deduction: number;
  gross_payout: number;
  net_payable: number;
  car_sales_locked: boolean;
  finance_locked: boolean;
  used_car_locked: boolean;
  accessories_locked: boolean;
  override_notes: string | null;
  basis: Record<string, unknown>;
};

const COMPONENTS = [
  { id: "base", name: "Base only" },
  { id: "variable", name: "Variable only" },
  { id: "both", name: "Base + variable" },
  { id: "base_finance", name: "Base + finance" },
];

function useEmployees() {
  return useQuery(async () => must(await supabase.from("employees").select("id, name, employee_code, role_id, roles(name)").eq("is_active", true).order("name")) as unknown as Emp[], []);
}

// Techwheels' Payroll Management: salary set-up, attendance, advances, incentive rules, processing
// with locks and overrides, the bank file and salary slips.
export default function Payroll() {
  const [tab, setTab] = useState("process");
  const [month, setMonth] = useState(monthIst());
  return (
    <div>
      <PageHeader
        title="Payroll"
        note="Net = base − leave beyond the paid allowance + incentive (released by the approved incentive run) + car, model, above-target, finance, used-car and accessories payouts − advance."
        actions={<input type="month" className={inputCls} value={month} onChange={(e) => setMonth(e.target.value)} />}
      />
      <Tabs
        current={tab}
        onChange={setTab}
        tabs={[
          { id: "process", label: "Processing" },
          { id: "salary", label: "Salary set-up" },
          { id: "attendance", label: "Attendance" },
          { id: "advances", label: "Advances" },
          { id: "rules", label: "Incentive rules" },
          { id: "slips", label: "Salary slips" },
        ]}
      />
      {tab === "process" ? (
        <Processing month={`${month}-01`} />
      ) : tab === "salary" ? (
        <SalarySetup />
      ) : tab === "attendance" ? (
        <Attendance month={`${month}-01`} />
      ) : tab === "advances" ? (
        <Advances month={`${month}-01`} />
      ) : tab === "rules" ? (
        <Rules month={`${month}-01`} />
      ) : (
        <Slips month={`${month}-01`} />
      )}
    </div>
  );
}

function Processing({ month }: { month: string }) {
  const canEdit = useRightGate("payroll", "edit");
  const canApprove = useRightGate("payroll", "approve");
  const emps = useEmployees();
  const run = useQuery(async () => (must(await supabase.from("payroll_runs").select("status, calculated_at, locked_at").eq("month", month).maybeSingle()) as { status: string; calculated_at: string | null } | null), [month]);
  const q = useQuery(async () => must(await supabase.from("payroll_entries").select("*").eq("month", month)) as Entry[], [month]);
  const name = (id: string) => emps.data?.find((e) => e.id === id)?.name ?? id;
  const locked = run.data?.status === "locked";

  async function exportBank(type: "NEFT" | "DCR") {
    const rows = await rpcRows<{ employee_code: string | null; employee: string; account_no: string | null; ifsc: string | null; amount: number }>("payroll_bank_export", { p_month: month, p_payment_type: type });
    const csv = ["Employee code,Name,Account,IFSC,Amount", ...rows.map((r) => [r.employee_code ?? "", r.employee, r.account_no ?? "", r.ifsc ?? "", r.amount].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `payroll-${month.slice(0, 7)}-${type}.csv`;
    a.click();
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {run.data && <Chip tone={locked ? "emerald" : "amber"}>{locked ? "Locked" : "Draft"}</Chip>}
        {canEdit && !locked && <RunButton label={run.data ? "Recalculate" : "Calculate"} run={() => rpc("calculate_payroll", { p_month: month })} />}
        {canApprove && run.data && !locked && <RunButton tone="danger" label="Lock & finalise" confirm="Apply advances and lock this month?" run={() => rpc("lock_payroll", { p_month: month })} />}
        <RunButton tone="light" label="NEFT file" run={() => exportBank("NEFT")} />
        <RunButton tone="light" label="DCR file" run={() => exportBank("DCR")} />
      </div>
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Employee", "Base", "Leave", "Incentive", "Cars", "Model", "Above target", "Finance", "Used car", "Accessories", "Advance", "Net", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={13} text="Not calculated yet." />
              ) : (
                rows.map((e) => (
                  <tr key={e.employee_id}>
                    <Td>
                      {name(e.employee_id)}
                      <div className="text-xs text-slate-500">{COMPONENTS.find((c) => c.id === e.pay_components)?.name}</div>
                    </Td>
                    <Td right>{inr(e.base_salary)}</Td>
                    <Td right>{e.leave_deduction ? `−${inr(e.leave_deduction)}` : ""}<div className="text-xs text-slate-400">{e.leave_days} days</div></Td>
                    <Td right>{inr(e.incentive_release)}</Td>
                    <Td right>{inr(e.car_payout)} {e.car_sales_locked && "🔒"}<div className="text-xs text-slate-400">{String(e.basis?.cars ?? 0)} cars</div></Td>
                    <Td right>{inr(e.model_bonus)}</Td>
                    <Td right>{inr(e.above_target)}</Td>
                    <Td right>{inr(e.finance_payout)} {e.finance_locked && "🔒"}</Td>
                    <Td right>{inr(e.used_car_payout)} {e.used_car_locked && "🔒"}</Td>
                    <Td right>{inr(e.accessories_payout)} {e.accessories_locked && "🔒"}</Td>
                    <Td right>{e.advance_deduction ? `−${inr(e.advance_deduction)}` : ""}</Td>
                    <Td right className="font-semibold">{inr(e.net_payable)}</Td>
                    <Td>
                      {!locked && (
                        <div className="flex flex-col gap-1">
                          {(["car_sales", "finance", "used_car", "accessories"] as const).map((c) => {
                            const isLocked = e[`${c}_locked` as keyof Entry] as boolean;
                            return (
                              <button
                                key={c}
                                type="button"
                                className="text-left text-xs text-slate-600 underline decoration-dotted"
                                onClick={() => rpc("set_payroll_lock", { p_month: month, p_employee_id: e.employee_id, p_category: c, p_locked: !isLocked }).then(() => q.reload()).catch((err) => alert(err.message))}
                              >
                                {isLocked ? "Unlock" : "Lock"} {c.replace("_", " ")}
                              </button>
                            );
                          })}
                          {canApprove && (
                            <ActionForm
                              tone="light"
                              label="Override"
                              hidden={{}}
                              fields={[
                                { name: "f", placeholder: "Which", options: [{ id: "above_target", name: "Above target" }, { id: "model_bonus", name: "Model bonus" }], required: true, width: "w-28" },
                                { name: "amt", placeholder: "Amount", type: "number", required: true, width: "w-20" },
                                { name: "why", placeholder: "Reason", required: true, width: "w-28" },
                              ]}
                              action={async (fd) => {
                                await rpc("payroll_override", { p_month: month, p_employee_id: e.employee_id, p_field: str(fd, "f"), p_amount: num(fd, "amt"), p_note: str(fd, "why") });
                                q.reload();
                              }}
                            />
                          )}
                          {e.override_notes && <span className="text-xs text-slate-500">{e.override_notes}</span>}
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

function SalarySetup() {
  const canEdit = useRightGate("payroll", "edit");
  const emps = useEmployees();
  const q = useQuery(async () => must(await supabase.from("employee_salary").select("employee_id, monthly_salary, salary_type, pay_components, payment_type, bank_account_no, bank_ifsc")) as Salary[], []);
  return (
    <Card note="The monthly salary itself is set on the employee's HR record. Here: which parts of pay apply, and where it is paid.">
      <Loaded q={q}>
        {(rows) => (
          <Table head={["Employee", "Monthly", "Pay", "Paid by", "Account", ""]}>
            {rows.length === 0 ? <EmptyRow cols={6} text="No salaries recorded on HR records yet." /> : rows.map((s) => (
              <tr key={s.employee_id}>
                <Td>{emps.data?.find((e) => e.id === s.employee_id)?.name}</Td>
                <Td right>{inr(s.monthly_salary)}</Td>
                <Td>{COMPONENTS.find((c) => c.id === s.pay_components)?.name}</Td>
                <Td>{s.payment_type}</Td>
                <Td muted>{s.bank_account_no ? `${s.bank_account_no} · ${s.bank_ifsc}` : "—"}</Td>
                <Td>
                  {canEdit && (
                    <ActionForm
                      tone="light"
                      label="Save"
                      hidden={{}}
                      fields={[
                        { name: "comp", placeholder: "Pay", options: COMPONENTS, width: "w-36", initial: s.pay_components ?? "" },
                        { name: "type", placeholder: "Paid by", options: [{ id: "NEFT", name: "NEFT" }, { id: "DCR", name: "DCR" }], width: "w-24", initial: s.payment_type },
                        { name: "acc", placeholder: "Account no.", width: "w-32", initial: s.bank_account_no ?? "" },
                        { name: "ifsc", placeholder: "IFSC", width: "w-28", initial: s.bank_ifsc ?? "" },
                      ]}
                      action={async (fd) => {
                        must(
                          await supabase
                            .from("employee_salary")
                            .update({ pay_components: str(fd, "comp"), payment_type: str(fd, "type"), bank_account_no: str(fd, "acc"), bank_ifsc: str(fd, "ifsc")?.toUpperCase() ?? null })
                            .eq("employee_id", s.employee_id),
                        );
                        q.reload();
                      }}
                    />
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Loaded>
    </Card>
  );
}

function Attendance({ month }: { month: string }) {
  const canEdit = useRightGate("payroll", "edit");
  const emps = useEmployees();
  const q = useQuery(async () => must(await supabase.from("payroll_attendance").select("employee_id, present_days, leave_days").eq("month", month)) as { employee_id: string; present_days: number; leave_days: number }[], [month]);
  const cfg = useQuery(async () => must(await supabase.from("payroll_config").select("paid_leave_allowance").single()) as { paid_leave_allowance: number }, []);
  return (
    <Card note={`Half days count as 0.5. ${cfg.data?.paid_leave_allowance ?? 4} paid leaves a month; leave beyond them is deducted from base.`}>
      <Loaded q={emps}>
        {(list) => (
          <Table head={["Employee", "Present", "Leave", ""]}>
            {list.map((e) => {
              const a = q.data?.find((x) => x.employee_id === e.id);
              return (
                <tr key={e.id}>
                  <Td>{e.name}</Td>
                  <Td right>{a?.present_days ?? "—"}</Td>
                  <Td right>{a?.leave_days ?? "—"}</Td>
                  <Td>
                    {canEdit && (
                      <ActionForm
                        tone="light"
                        label="Save"
                        hidden={{}}
                        fields={[
                          { name: "p", placeholder: "Present", type: "number", required: true, width: "w-20", initial: a ? String(a.present_days) : "" },
                          { name: "l", placeholder: "Leave", type: "number", width: "w-20", initial: a ? String(a.leave_days) : "" },
                        ]}
                        action={async (fd) => {
                          must(await supabase.from("payroll_attendance").upsert({ employee_id: e.id, month, present_days: num(fd, "p"), leave_days: num(fd, "l") ?? 0 }));
                          q.reload();
                        }}
                      />
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Loaded>
    </Card>
  );
}

type Advance = { id: string; employee_id: string; total_amount: number; recovered_amount: number; deduction_type: string; start_month: string; status: string; reason: string | null; payroll_advance_deductions: { month: string; amount: number; applied_amount: number | null }[] };

function Advances({ month }: { month: string }) {
  const canEdit = useRightGate("payroll", "edit");
  const emps = useEmployees();
  const q = useQuery(async () => must(await supabase.from("payroll_advances").select("id, employee_id, total_amount, recovered_amount, deduction_type, start_month, status, reason, payroll_advance_deductions(month, amount, applied_amount)").order("created_at", { ascending: false })) as Advance[], []);
  return (
    <>
      {canEdit && (
        <Card title="New advance" note="EMI splits evenly with the remainder on the last instalment; a custom schedule (comma-separated) must add up to the total. Recovery never exceeds what the person earns that month; the rest moves on.">
          <div className="px-3 py-2">
            <ActionForm
              label="Give advance"
              hidden={{}}
              fields={[
                { name: "emp", placeholder: "Employee", options: (emps.data ?? []).map((e) => ({ id: e.id, name: e.name })), required: true, width: "w-48" },
                { name: "total", placeholder: "Amount", type: "number", required: true, width: "w-28" },
                { name: "type", placeholder: "Recovery", options: [{ id: "lump", name: "Lump sum" }, { id: "emi", name: "EMI" }, { id: "custom", name: "Custom" }], required: true, width: "w-28" },
                { name: "months", placeholder: "EMIs", type: "number", width: "w-20" },
                { name: "custom", placeholder: "e.g. 5000,3000,2000", width: "w-40" },
                { name: "reason", placeholder: "Reason", width: "w-36" },
              ]}
              action={async (fd) => {
                await rpc("create_advance", {
                  p_employee_id: str(fd, "emp"),
                  p_total: num(fd, "total"),
                  p_type: str(fd, "type"),
                  p_start_month: month,
                  p_months: num(fd, "months"),
                  p_custom: str(fd, "custom") ? str(fd, "custom")!.split(",").map((x) => Number(x.trim())) : null,
                  p_reason: str(fd, "reason"),
                });
                q.reload();
              }}
            />
          </div>
        </Card>
      )}
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Employee", "Advance", "Recovered", "Schedule", "Status"]}>
              {rows.length === 0 ? <EmptyRow cols={5} text="No advances." /> : rows.map((a) => (
                <tr key={a.id}>
                  <Td>{emps.data?.find((e) => e.id === a.employee_id)?.name}<div className="text-xs text-slate-500">{a.reason}</div></Td>
                  <Td right>{inr(a.total_amount)}</Td>
                  <Td right>{inr(a.recovered_amount)}</Td>
                  <Td muted>
                    {a.payroll_advance_deductions
                      .sort((x, y) => x.month.localeCompare(y.month))
                      .map((d) => `${d.month.slice(0, 7)}: ${inr(d.amount)}${d.applied_amount != null ? ` (took ${inr(d.applied_amount)})` : ""}`)
                      .join(" · ")}
                  </Td>
                  <Td><Chip tone={a.status === "closed" ? "emerald" : a.status === "partial" ? "blue" : "amber"}>{a.status}</Chip></Td>
                </tr>
              ))}
            </Table>
          )}
        </Loaded>
      </Card>
    </>
  );
}

type Rule = { id: string; role_id: string | null; employee_id: string | null; rule_type: string; amount: number | null; percent: number | null; slab_from: number | null; slab_to: number | null; vin: string | null; valid_from: string; valid_to: string | null; is_active: boolean };

const RULES = [
  { id: "per_car_flat", name: "Per car (₹)" },
  { id: "ev_share_slab", name: "EV share slab: extra per car (₹) from EV % ≥ slab" },
  { id: "min_cars", name: "Minimum cars for bonuses (amount = cars)" },
  { id: "vin_flat", name: "VIN flat (₹, replaces model bonus)" },
  { id: "model_bonus_margin", name: "Model bonus (from the bonus table, less a negative margin)" },
  { id: "above_target_slab", name: "Above target, per car (₹)" },
  { id: "do_percent", name: "Finance: % of DO (after the bank pays)" },
  { id: "inhouse_finance_flat", name: "Finance: per in-house case (₹)" },
  { id: "used_car_slab", name: "Used cars: per car (₹) for a count range" },
  { id: "accessories_percent", name: "Accessories: % after GST above a per-car threshold (amount = threshold)" },
];

function Rules({ month }: { month: string }) {
  const canEdit = useRightGate("payroll", "edit");
  const emps = useEmployees();
  const roles = useQuery(async () => must(await supabase.from("roles").select("id, name").order("rank")) as { id: string; name: string }[], []);
  const models = useQuery(async () => must(await supabase.from("models").select("id, name").eq("is_active", true).order("name")) as { id: string; name: string }[], []);
  const q = useQuery(async () => must(await supabase.from("payroll_incentive_rules").select("*").order("rule_type")) as Rule[], []);
  const bonus = useQuery(async () => must(await supabase.from("dealer_model_bonus").select("id, bonus_per_car, models(name)").eq("month", month)) as unknown as { id: string; bonus_per_car: number; models: { name: string } | null }[], [month]);
  const who = (r: Rule) => (r.employee_id ? emps.data?.find((e) => e.id === r.employee_id)?.name : roles.data?.find((x) => x.id === r.role_id)?.name);
  return (
    <>
      {canEdit && (
        <Card title="New rule" note="A rule for one employee beats the same rule for their role. Cars count on the invoice date; a car bought in from another dealer counts half.">
          <div className="px-3 py-2">
            <ActionForm
              label="Add rule"
              hidden={{}}
              fields={[
                { name: "for", placeholder: "Role or employee", options: [...(roles.data ?? []).map((r) => ({ id: `r:${r.id}`, name: `Role: ${r.name}` })), ...(emps.data ?? []).map((e) => ({ id: `e:${e.id}`, name: e.name }))], required: true, width: "w-48" },
                { name: "type", placeholder: "Rule", options: RULES, required: true, width: "w-64" },
                { name: "amount", placeholder: "Amount", type: "number", width: "w-24" },
                { name: "percent", placeholder: "%", type: "number", width: "w-16" },
                { name: "from", placeholder: "Slab from", type: "number", width: "w-20" },
                { name: "to", placeholder: "Slab to", type: "number", width: "w-20" },
                { name: "vin", placeholder: "VIN", width: "w-40" },
              ]}
              action={async (fd) => {
                const f = str(fd, "for")!;
                must(
                  await supabase.from("payroll_incentive_rules").insert({
                    role_id: f.startsWith("r:") ? f.slice(2) : null,
                    employee_id: f.startsWith("e:") ? f.slice(2) : null,
                    rule_type: str(fd, "type"),
                    amount: num(fd, "amount"),
                    percent: num(fd, "percent"),
                    slab_from: num(fd, "from"),
                    slab_to: num(fd, "to"),
                    vin: str(fd, "vin")?.toUpperCase() ?? null,
                    valid_from: month,
                  }),
                );
                q.reload();
              }}
            />
          </div>
        </Card>
      )}
      <Card title="Rules">
        <Loaded q={q}>
          {(rows) => (
            <Table head={["For", "Rule", "Amount / %", "Slab", "From", ""]}>
              {rows.length === 0 ? <EmptyRow cols={6} text="No rules." /> : rows.map((r) => (
                <tr key={r.id} className={r.is_active ? "" : "opacity-50"}>
                  <Td>{who(r)}</Td>
                  <Td>{RULES.find((x) => x.id === r.rule_type)?.name}{r.vin && <div className="font-mono text-xs">{r.vin}</div>}</Td>
                  <Td right>{r.amount != null ? inr(r.amount) : ""}{r.percent != null ? ` ${r.percent}%` : ""}</Td>
                  <Td muted>{r.slab_from != null ? `${r.slab_from}–${r.slab_to ?? "…"}` : ""}</Td>
                  <Td muted>{r.valid_from.slice(0, 7)}{r.valid_to ? ` to ${r.valid_to.slice(0, 7)}` : ""}</Td>
                  <Td>{canEdit && r.is_active && <RunButton tone="light" label="End" run={async () => { must(await supabase.from("payroll_incentive_rules").update({ valid_to: month, is_active: false }).eq("id", r.id)); q.reload(); }} />}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Loaded>
      </Card>
      <Card title="Model bonus this month" note="Per car invoiced; reduced by any loss on the car (the bonus never goes below zero).">
        <div className="px-3 py-2 text-sm">
          {(bonus.data ?? []).map((b) => <Chip key={b.id}>{b.models?.name}: {inr(b.bonus_per_car)}</Chip>)}
          {canEdit && (
            <ActionForm
              tone="light"
              label="Set"
              hidden={{}}
              fields={[
                { name: "model", placeholder: "Model", options: models.data ?? [], required: true, width: "w-40" },
                { name: "amt", placeholder: "Per car", type: "number", required: true, width: "w-24" },
              ]}
              action={async (fd) => {
                must(await supabase.from("dealer_model_bonus").upsert({ month, model_id: str(fd, "model"), fuel_type_id: null, bonus_per_car: num(fd, "amt") }, { onConflict: "month,model_id,fuel_type_id" }));
                bonus.reload();
              }}
            />
          )}
        </div>
      </Card>
    </>
  );
}

function Slips({ month }: { month: string }) {
  const emps = useEmployees();
  const q = useQuery(async () => must(await supabase.from("payroll_entries").select("*").eq("month", month)) as Entry[], [month]);
  const [who, setWho] = useState("");
  function print(entries: Entry[]) {
    const label = new Date(month).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
    const row = (k: string, v: number, minus = false) => (v ? `<tr><td>${k}</td><td style="text-align:right">${minus ? "−" : ""}${Math.round(v).toLocaleString("en-IN")}</td></tr>` : "");
    const slips = entries
      .map((e) => {
        const emp = emps.data?.find((x) => x.id === e.employee_id);
        return `<div style="page-break-after:always"><h2>Rajesh Toyota — Salary slip, ${label}</h2><p>${emp?.name ?? ""} ${emp?.employee_code ? `(${emp.employee_code})` : ""} · ${emp?.roles?.name ?? ""}</p>
        <table border="1" cellpadding="6" style="border-collapse:collapse;min-width:360px">
        ${row("Base salary", e.base_salary)}${row("Incentive", e.incentive_release)}${row("Car payout", e.car_payout)}${row("Model bonus", e.model_bonus)}
        ${row("Above target", e.above_target)}${row("Finance payout", e.finance_payout)}${row("Used car", e.used_car_payout)}${row("Accessories", e.accessories_payout)}
        ${row(`Leave (${e.leave_days} days)`, e.leave_deduction, true)}${row("Advance recovery", e.advance_deduction, true)}
        <tr><td><b>Net payable</b></td><td style="text-align:right"><b>${Math.round(e.net_payable).toLocaleString("en-IN")}</b></td></tr></table></div>`;
      })
      .join("");
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>Salary slips ${label}</title><style>body{font-family:Arial,sans-serif;margin:32px;font-size:14px}</style></head><body>${slips}<script>window.print()</script></body></html>`);
    w.document.close();
  }
  return (
    <Card title="Salary slips">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Select value={who} onChange={setWho} placeholder="Everyone (consolidated)" options={(q.data ?? []).map((e) => ({ id: e.employee_id, name: emps.data?.find((x) => x.id === e.employee_id)?.name ?? e.employee_id }))} />
        <RunButton label="Print" disabled={!q.data?.length} run={async () => print((q.data ?? []).filter((e) => !who || e.employee_id === who))} />
      </div>
    </Card>
  );
}
