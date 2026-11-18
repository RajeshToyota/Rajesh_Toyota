import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, EmptyRow, Loaded, PageHeader, RunButton, Table, Tabs, Td, fmtDateTime, inputCls, monthIst, rpc, str } from "@/ui";

type Emp = { id: string; name: string; reports_to_employee_id: string | null; outlet_id: string | null; roles: { name: string } | null; outlets: { name: string } | null };
type History = { id: number; employee_id: string; manager_id: string | null; previous_manager_id: string | null; effective_from: string; reason: string | null; changed_by: string | null };

// Who reports to whom (Techwheels' Reporting Hierarchy): move people with a reason, see every change,
// and freeze a month for payroll and Team Leader incentives.
export default function ReportingHierarchy() {
  const canEdit = useRightGate("reporting_hierarchy", "edit");
  const [tab, setTab] = useState("tree");
  const [filter, setFilter] = useState("");
  const emps = useQuery(
    async () =>
      must(
        await supabase
          .from("employees")
          .select("id, name, reports_to_employee_id, outlet_id, roles(name), outlets(name)")
          .eq("is_active", true)
          .order("name"),
      ) as unknown as Emp[],
    [],
  );
  const history = useQuery(
    async () =>
      must(
        await supabase
          .from("reporting_hierarchy_history")
          .select("id, employee_id, manager_id, previous_manager_id, effective_from, reason, changed_by")
          .order("effective_from", { ascending: false })
          .limit(300),
      ) as History[],
    [],
  );
  const names = useMemo(() => new Map((emps.data ?? []).map((e) => [e.id, e.name])), [emps.data]);

  return (
    <div>
      <PageHeader
        title="Reporting Hierarchy"
        note="A manager change needs a reason and is kept in the history. A person cannot be moved under someone who reports to them."
        actions={
          canEdit && (
            <RunButton
              tone="light"
              label={`Freeze ${monthIst()}`}
              run={async () => {
                const n = await rpc<number>("save_hierarchy_snapshot", { p_month: `${monthIst()}-01` });
                alert(`Saved the hierarchy for ${n} people.`);
              }}
            />
          )
        }
      />
      <Tabs current={tab} onChange={setTab} tabs={[{ id: "tree", label: "People" }, { id: "history", label: "History" }]} />
      {tab === "tree" ? (
        <Loaded q={emps}>
          {(rows) => {
            const shown = rows.filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
            const managers = rows.map((e) => ({ id: e.id, name: `${e.name} · ${e.roles?.name ?? ""}` }));
            return (
              <Card aside={<input className={inputCls} placeholder="Search name" value={filter} onChange={(e) => setFilter(e.target.value)} />}>
                <Table head={["Employee", "Role", "Branch", "Reports to", "Team", ""]}>
                  {shown.length === 0 ? (
                    <EmptyRow cols={6} text="Nobody matches." />
                  ) : (
                    shown.map((e) => (
                      <tr key={e.id}>
                        <Td>{e.name}</Td>
                        <Td muted>{e.roles?.name}</Td>
                        <Td muted>{e.outlets?.name ?? "All"}</Td>
                        <Td>{e.reports_to_employee_id ? names.get(e.reports_to_employee_id) ?? "—" : "—"}</Td>
                        <Td right>{rows.filter((x) => x.reports_to_employee_id === e.id).length || ""}</Td>
                        <Td>
                          {canEdit && (
                            <ActionForm
                              tone="light"
                              label="Move"
                              hidden={{}}
                              fields={[
                                { name: "manager", placeholder: "New manager", options: managers.filter((m) => m.id !== e.id), required: true, width: "w-52" },
                                { name: "reason", placeholder: "Reason", required: true, width: "w-44" },
                              ]}
                              action={async (fd) => {
                                await rpc("reassign_manager", { p_employee_id: e.id, p_manager_id: str(fd, "manager"), p_reason: str(fd, "reason") });
                              }}
                            />
                          )}
                        </Td>
                      </tr>
                    ))
                  )}
                </Table>
              </Card>
            );
          }}
        </Loaded>
      ) : (
        <Loaded q={history}>
          {(rows) => (
            <Card>
              <Table head={["When", "Employee", "From", "To", "Reason", "By"]}>
                {rows.length === 0 ? (
                  <EmptyRow cols={6} text="No changes yet." />
                ) : (
                  rows.map((h) => (
                    <tr key={h.id}>
                      <Td muted>{fmtDateTime(h.effective_from)}</Td>
                      <Td>{names.get(h.employee_id) ?? "—"}</Td>
                      <Td muted>{h.previous_manager_id ? names.get(h.previous_manager_id) ?? "—" : "—"}</Td>
                      <Td>{h.manager_id ? names.get(h.manager_id) ?? "—" : "—"}</Td>
                      <Td>{h.reason}</Td>
                      <Td muted>{h.changed_by ? names.get(h.changed_by) ?? "—" : "System"}</Td>
                    </tr>
                  ))
                )}
              </Table>
            </Card>
          )}
        </Loaded>
      )}
    </div>
  );
}
