import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { useRightGate } from "@/lib/rbac";
import { ActionForm, Card, Chip, EmptyRow, Loaded, PageHeader, Select, Table, Td, num, rpc, str } from "@/ui";

type Department = { code: string; name: string; sort_order: number; is_active: boolean };
type Role = { id: string; name: string; rank: number; department_code: string | null };

// Departments and which department each role belongs to (Techwheels' RBAC departments). A module's
// "limited" visibility scope in the Access Studio picks departments from this list.
export default function Departments() {
  const canEdit = useRightGate("departments", "edit");
  const data = useQuery(async () => {
    const [d, r] = await Promise.all([
      supabase.from("departments").select("code, name, sort_order, is_active").order("sort_order"),
      supabase.from("roles").select("id, name, rank, department_code").order("rank").order("name"),
    ]);
    return { departments: must(d) as Department[], roles: must(r) as Role[] };
  }, []);

  return (
    <div>
      <PageHeader title="Departments" note="Staff and roles belong to a department." />
      <Loaded q={data}>
        {({ departments, roles }) => (
          <>
            <Card title="Departments">
              <Table head={["Code", "Name", "Order", "Status", ""]}>
                {departments.length === 0 ? (
                  <EmptyRow cols={5} text="No departments." />
                ) : (
                  departments.map((d) => (
                    <tr key={d.code}>
                      <Td muted>{d.code}</Td>
                      <Td>{d.name}</Td>
                      <Td muted>{d.sort_order}</Td>
                      <Td>{d.is_active ? <Chip tone="emerald">Active</Chip> : <Chip>Off</Chip>}</Td>
                      <Td>
                        {canEdit && (
                          <ActionForm
                            tone="light"
                            label={d.is_active ? "Switch off" : "Switch on"}
                            hidden={{}}
                            action={async () => {
                              await rpc("save_department", { p_code: d.code, p_name: d.name, p_sort: d.sort_order, p_is_active: !d.is_active });
                            }}
                          />
                        )}
                      </Td>
                    </tr>
                  ))
                )}
              </Table>
              {canEdit && (
                <div className="border-t border-slate-100 px-3 py-2">
                  <ActionForm
                    label="Add / rename"
                    hidden={{}}
                    fields={[
                      { name: "code", placeholder: "code (e.g. marketing)", required: true, width: "w-44" },
                      { name: "name", placeholder: "Name", required: true, width: "w-44" },
                      { name: "sort", placeholder: "Order", type: "number", width: "w-20" },
                    ]}
                    action={async (fd) => {
                      await rpc("save_department", { p_code: str(fd, "code"), p_name: str(fd, "name"), p_sort: num(fd, "sort"), p_is_active: true });
                    }}
                  />
                </div>
              )}
            </Card>
            <Card title="Roles">
              <Table head={["Role", "Rank", "Department"]}>
                {roles.map((r) => (
                  <tr key={r.id}>
                    <Td>{r.name}</Td>
                    <Td muted>{r.rank}</Td>
                    <Td>
                      <Select
                        value={r.department_code ?? ""}
                        placeholder="—"
                        onChange={(v) => {
                          if (!canEdit) return;
                          rpc("set_role_department", { p_role_id: r.id, p_department: v || null }).catch((e) => alert(e.message));
                        }}
                        options={departments.map((d) => ({ id: d.code, name: d.name }))}
                      />
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </>
        )}
      </Loaded>
    </div>
  );
}
