import { useState } from "react";
import { useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, Table, Td, inputCls, monthIst, rpc, rpcRows, str } from "@/ui";
import { firstOfMonth } from "./shared";

type Row = {
  employee_id: string;
  employee: string;
  role: string;
  outlet: string | null;
  target_units: number | null;
  retail: number;
  in_house: number;
  cash: number;
  achievement_pct: number | null;
  model_targets: { model: string; model_id: string; target: number; retail: number }[];
};

// Techwheels' employee target settings: a monthly car target per consultant (and per model), against retail.
export default function Targets() {
  const [month, setMonth] = useState(monthIst());
  const q = useQuery(() => rpcRows<Row>("target_vs_actual", { p_month: firstOfMonth(month) }), [month]);
  const canSet = useRightGate("targets", "edit");

  return (
    <div>
      <PageHeader
        title="Targets"
        note="Retail = cars invoiced to the customer in the month, credited to the booking's consultant."
        actions={<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls} />}
      />
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Consultant", "Target", "Retail", "Achieved", "In-house / cash", "By model", canSet ? "Set target" : ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={7} text="No consultants in your view." />
              ) : (
                rows.map((r) => {
                  const pct = r.achievement_pct == null ? null : Number(r.achievement_pct);
                  return (
                    <tr key={r.employee_id}>
                      <Td>
                        {r.employee}
                        <div className="text-xs text-slate-500">
                          {r.role} · {r.outlet}
                        </div>
                      </Td>
                      <Td right>{r.target_units ?? "—"}</Td>
                      <Td right>{r.retail}</Td>
                      <Td>
                        {pct == null ? (
                          <span className="text-slate-400">No target</span>
                        ) : (
                          <div className="w-32">
                            <div className="h-2 rounded bg-slate-100">
                              <div className={`h-2 rounded ${pct >= 100 ? "bg-emerald-500" : pct >= 70 ? "bg-amber-400" : "bg-red-400"}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                            </div>
                            <span className="text-xs text-slate-600">{pct}%</span>
                          </div>
                        )}
                      </Td>
                      <Td muted>
                        {r.in_house} / {r.cash}
                      </Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          {r.model_targets.map((m) => (
                            <Chip key={m.model_id} tone={m.retail >= m.target ? "emerald" : "slate"}>
                              {m.model} {m.retail}/{m.target}
                            </Chip>
                          ))}
                        </div>
                      </Td>
                      <Td>
                        {canSet && (
                          <ActionForm
                            label="Set"
                            hidden={{}}
                            fields={[{ name: "units", placeholder: "Cars", type: "number", initial: r.target_units != null ? String(r.target_units) : "", required: true, width: "w-20" }]}
                            action={async (fd) => {
                              await rpc("set_target", { p_month: firstOfMonth(month), p_employee_id: r.employee_id, p_model_id: null, p_units: Number(str(fd, "units")) });
                            }}
                          />
                        )}
                      </Td>
                    </tr>
                  );
                })
              )}
            </Table>
          )}
        </Loaded>
      </Card>
    </div>
  );
}
