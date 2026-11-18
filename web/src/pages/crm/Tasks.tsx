import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@/lib/query";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, RunButton, Table, Tabs, Td, fmtDateTime, rpc, rpcRows, str } from "@/ui";
import { localDateTime, toIso, useConsultants } from "./shared";

type Task = {
  id: string;
  title: string;
  detail: string | null;
  due_at: string | null;
  priority: string;
  status: string;
  assigned_to: string;
  created_by: string | null;
  enquiry_id: string | null;
  booking_id: string | null;
  customer_name: string | null;
  done_at: string | null;
  done_note: string | null;
  overdue: boolean;
};

export default function Tasks() {
  const [status, setStatus] = useState("open");
  const [who, setWho] = useState("");
  const q = useQuery(() => rpcRows<Task>("my_tasks", { p_status: status, p_employee_id: who || null }), [status, who]);
  const people = useConsultants();

  return (
    <div>
      <PageHeader
        title="Tasks"
        note="To-dos for you and your team. Tasks tied to a booking also show on its RM page."
        actions={
          <select value={who} onChange={(e) => setWho(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
            <option value="">My tasks</option>
            {(people.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        }
      />
      <Card title="New task">
        <div className="px-3 py-2">
          <ActionForm
            label="Add"
            hidden={{}}
            fields={[
              { name: "title", placeholder: "What needs doing", required: true, width: "w-72" },
              { name: "due", placeholder: "Due", type: "datetime-local", initial: localDateTime(new Date(Date.now() + 86_400_000)), width: "w-44" },
              { name: "to", placeholder: "For me", options: (people.data ?? []).map((p) => ({ id: p.id, name: p.name })), width: "w-44" },
              { name: "priority", placeholder: "Priority", options: [{ id: "high", name: "High" }, { id: "normal", name: "Normal" }, { id: "low", name: "Low" }], width: "w-28" },
            ]}
            action={async (fd) => {
              await rpc("create_task", {
                p_title: str(fd, "title"),
                p_assigned_to: str(fd, "to"),
                p_due_at: toIso(str(fd, "due")),
                p_priority: str(fd, "priority") ?? "normal",
              });
            }}
          />
        </div>
      </Card>
      <Tabs current={status} onChange={setStatus} tabs={[{ id: "open", label: "Open" }, { id: "done", label: "Done" }, { id: "all", label: "All" }]} />
      <Card>
        <Loaded q={q}>
          {(rows) => (
            <Table head={["Task", "Due", "For", "About", ""]}>
              {rows.length === 0 ? (
                <EmptyRow cols={5} text="No tasks here." />
              ) : (
                rows.map((t) => (
                  <tr key={t.id}>
                    <Td>
                      <span className="font-medium">{t.title}</span> {t.priority === "high" && <Chip tone="red">High</Chip>}
                      {t.detail && <div className="text-xs text-slate-500">{t.detail}</div>}
                      {t.done_note && <div className="text-xs text-emerald-700">{t.done_note}</div>}
                    </Td>
                    <Td>
                      <span className={t.overdue ? "font-medium text-red-700" : "text-slate-600"}>{fmtDateTime(t.due_at)}</span>
                    </Td>
                    <Td muted>
                      {t.assigned_to}
                      {t.created_by && t.created_by !== t.assigned_to && <div className="text-xs">from {t.created_by}</div>}
                    </Td>
                    <Td>
                      {t.booking_id ? (
                        <Link to={`/rm/booking/${t.booking_id}`} className="hover:underline">
                          {t.customer_name}
                        </Link>
                      ) : (
                        <span className="text-slate-600">{t.customer_name ?? "—"}</span>
                      )}
                    </Td>
                    <Td>
                      {t.status === "open" ? (
                        <div className="flex gap-1">
                          <ActionForm
                            label="Done"
                            hidden={{}}
                            fields={[{ name: "note", placeholder: "Note", width: "w-32" }]}
                            action={async (fd) => {
                              await rpc("complete_task", { p_task_id: t.id, p_status: "done", p_note: str(fd, "note") });
                            }}
                          />
                          <RunButton tone="light" label="Drop" run={() => rpc("complete_task", { p_task_id: t.id, p_status: "cancelled" })} />
                        </div>
                      ) : (
                        <Chip tone={t.status === "done" ? "emerald" : "slate"}>{t.status}</Chip>
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
