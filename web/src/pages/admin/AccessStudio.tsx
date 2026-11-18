import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { startPreview, type AppModule, type MenuGroup, type Right } from "@/lib/rbac";
import { useCurrentEmployee } from "@/lib/auth";
import {
  Card,
  Chip,
  EmptyRow,
  ErrorBox,
  Loaded,
  PageHeader,
  RunButton,
  Select,
  Table,
  Tabs,
  Td,
  fmtDateTime,
  rpc,
} from "@/ui";

const RIGHTS: Right[] = ["view", "create", "edit", "approve", "delete"];

type Role = { id: string; name: string; rank: number; department_code: string | null };
type Employee = { id: string; name: string; role_id: string | null; is_active: boolean; outlet_id: string | null };
type Effective = {
  module_key: string;
  right: Right;
  allowed: boolean;
  source: "admin" | "grant" | "revoke" | "role" | "none";
  role_has: boolean;
  override: "grant" | "revoke" | null;
};
type Named = { id: string; name: string };
type Department = { code: string; name: string };
type ModuleRow = AppModule & { own_only: boolean; hierarchy_scope: "all" | "limited"; scope_departments: string[] };
type Base = {
  groups: MenuGroup[];
  modules: ModuleRow[];
  roles: Role[];
  employees: Employee[];
  outlets: Named[];
  financiers: Named[];
  departments: Department[];
};

// Who can do what (Techwheels' Employee Access Studio): rights per role, personal grants and revokes,
// and switching modules on or off. Only the Admin and the Business Head get here.
export default function AccessStudio() {
  const [tab, setTab] = useState("roles");
  const base = useQuery(async () => {
    const [groups, modules, roles, employees, outlets, financiers, departments] = await Promise.all([
      supabase.from("menu_groups").select("key, title, sort_order").order("sort_order"),
      supabase
        .from("app_modules")
        .select("key, group_key, label, path, sort_order, in_menu, is_active, own_only, hierarchy_scope, scope_departments")
        .order("sort_order"),
      supabase.from("roles").select("id, name, rank, department_code").order("rank").order("name"),
      supabase.from("employees").select("id, name, role_id, is_active, outlet_id").eq("is_active", true).order("name"),
      supabase.from("outlets").select("id, name").order("name"),
      supabase.from("financiers").select("id, name").eq("is_active", true).order("name"),
      supabase.from("departments").select("code, name").eq("is_active", true).order("sort_order"),
    ]);
    return {
      groups: must(groups) as MenuGroup[],
      modules: must(modules) as ModuleRow[],
      roles: must(roles) as Role[],
      employees: must(employees) as Employee[],
      outlets: must(outlets) as Named[],
      financiers: must(financiers) as Named[],
      departments: must(departments) as Department[],
    } satisfies Base;
  }, []);

  return (
    <div>
      <PageHeader
        title="Access Studio"
        note="Which screens each role sees and what it may do there. A personal grant or revoke beats the role. Which rows people see still follows their branch and reporting line."
      />
      <Tabs
        current={tab}
        onChange={setTab}
        tabs={[
          { id: "roles", label: "Roles" },
          { id: "people", label: "People" },
          { id: "modules", label: "Modules" },
          { id: "log", label: "Change log" },
        ]}
      />
      <Loaded q={base}>
        {(d) =>
          tab === "roles" ? (
            <RolesTab {...d} />
          ) : tab === "people" ? (
            <PeopleTab {...d} />
          ) : tab === "modules" ? (
            <ModulesTab groups={d.groups} modules={d.modules} departments={d.departments} />
          ) : (
            <LogTab />
          )
        }
      </Loaded>
    </div>
  );
}

function grouped(groups: MenuGroup[], modules: AppModule[]) {
  return groups
    .map((g) => ({ group: g, modules: modules.filter((m) => m.group_key === g.key) }))
    .filter((g) => g.modules.length);
}

function RolesTab({ groups, modules, roles }: { groups: MenuGroup[]; modules: AppModule[]; roles: Role[] }) {
  const me = useCurrentEmployee();
  const editable = roles.filter((r) => r.rank > 0);
  const [roleId, setRoleId] = useState(editable.find((r) => r.rank > 1)?.id ?? "");
  const role = roles.find((r) => r.id === roleId);
  const locked = !role || (role.rank <= 1 && me?.roleRank !== 0);
  const rights = useQuery(async () => {
    if (!roleId) return new Set<string>();
    const rows = must(await supabase.from("role_module_rights").select("module_key, right").eq("role_id", roleId)) as {
      module_key: string;
      right: string;
    }[];
    return new Set(rows.map((r) => `${r.module_key}:${r.right}`));
  }, [roleId]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className="text-slate-500">Role</span>
        <Select value={roleId} onChange={setRoleId} options={editable.map((r) => ({ id: r.id, name: r.name }))} />
        {locked && role && <Chip tone="amber">Only the Admin can change this role</Chip>}
      </div>
      <Loaded q={rights}>
        {(have) => (
          <RightsMatrix
            groups={grouped(groups, modules)}
            cell={(m, r) => {
              const on = have.has(`${m.key}:${r}`);
              return (
                <input
                  type="checkbox"
                  aria-label={`${m.label} ${r}`}
                  checked={on}
                  disabled={locked}
                  onChange={() => rpc("set_role_right", { p_role_id: roleId, p_module: m.key, p_right: r, p_on: !on }).catch((e) => alert(e.message))}
                />
              );
            }}
          />
        )}
      </Loaded>
    </div>
  );
}

function PeopleTab({ groups, modules, roles, employees, outlets, financiers }: Base) {
  const [employeeId, setEmployeeId] = useState("");
  const person = employees.find((e) => e.id === employeeId);
  const roleName = (id: string | null) => roles.find((r) => r.id === id)?.name ?? "No role";
  const effective = useQuery(async () => {
    if (!employeeId) return null;
    const rows = must(await supabase.rpc("employee_effective_rights", { p_employee_id: employeeId })) as Effective[];
    return new Map(rows.map((r) => [`${r.module_key}:${r.right}`, r]));
  }, [employeeId]);

  // Click: role decides → grant → revoke → back to the role.
  function cycle(moduleKey: string, right: Right, current: Effective | undefined) {
    const next = current?.source === "grant" ? "revoke" : current?.source === "revoke" ? null : "grant";
    const reason = next ? window.prompt(`Reason for the ${next}?`) ?? "" : null;
    if (next && reason === "") return;
    rpc("set_employee_override", { p_employee_id: employeeId, p_module: moduleKey, p_right: right, p_effect: next, p_reason: reason }).catch((e) =>
      alert(e.message),
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-500">Employee</span>
        <Select
          value={employeeId}
          onChange={setEmployeeId}
          placeholder="Pick someone"
          options={employees.map((e) => ({ id: e.id, name: `${e.name} · ${roleName(e.role_id)}` }))}
        />
        {person && (
          <RunButton tone="light" label="Preview as this person" run={() => startPreview(person.id, person.name)} />
        )}
        <span className="text-xs text-slate-400">
          Click a cell: <Chip tone="emerald">grant</Chip> → <Chip tone="red">revoke</Chip> → back to the role. A dot means the role gives it.
        </span>
      </div>
      {person && <EmployeeRoles key={person.id} employee={person} roles={roles} outlets={outlets} />}
      {person && <FinancierScope key={`f-${person.id}`} employeeId={person.id} financiers={financiers} />}
      {!employeeId ? (
        <p className="py-6 text-center text-sm text-slate-400">Pick an employee to see what they can do and why.</p>
      ) : (
        <Loaded q={effective}>
          {(map) =>
            map && (
              <RightsMatrix
                groups={grouped(groups, modules)}
                cell={(m, r) => {
                  const e = map.get(`${m.key}:${r}`);
                  const tone = e?.source === "grant" ? "emerald" : e?.source === "revoke" ? "red" : e?.allowed ? "blue" : "slate";
                  return (
                    <button
                      type="button"
                      onClick={() => cycle(m.key, r, e)}
                      title={`role: ${e?.role_has ? "yes" : "no"} · override: ${e?.override ?? "none"} · result: ${e?.allowed ? "allowed" : "not allowed"}`}
                      disabled={e?.source === "admin"}
                    >
                      <Chip tone={tone}>{e?.allowed ? "✓" : "–"}</Chip>
                      {e?.role_has && <span className="ml-0.5 text-slate-400">•</span>}
                    </button>
                  );
                }}
              />
            )
          }
        </Loaded>
      )}
    </div>
  );
}

function RightsMatrix({
  groups,
  cell,
}: {
  groups: { group: MenuGroup; modules: AppModule[] }[];
  cell: (m: AppModule, r: Right) => React.ReactNode;
}) {
  return (
    <Card>
      <Table head={["Module", ...RIGHTS]}>
        {groups.map(({ group, modules }) => [
          <tr key={group.key} className="bg-slate-50">
            <td colSpan={RIGHTS.length + 1} className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {group.title}
            </td>
          </tr>,
          ...modules.map((m) => (
            <tr key={m.key} className={m.is_active ? "" : "opacity-50"}>
              <Td>
                {m.label}
                {!m.is_active && <span className="ml-2 text-xs text-slate-400">(off)</span>}
              </Td>
              {RIGHTS.map((r) => (
                <Td key={r}>{cell(m, r)}</Td>
              ))}
            </tr>
          )),
        ])}
      </Table>
    </Card>
  );
}

function ModulesTab({ groups, modules, departments }: { groups: MenuGroup[]; modules: ModuleRow[]; departments: Department[] }) {
  const byGroup = useMemo(() => grouped(groups, modules) as { group: MenuGroup; modules: ModuleRow[] }[], [groups, modules]);
  return (
    <Card note="Switch a module off to hide it from everyone except the Admin, e.g. a new phase before go-live. Visibility: 'own only' shows people only their own records; a limited scope only records of staff in the chosen departments.">
      <Table head={["Module", "Menu", "Path", "Status", "Visibility", ""]}>
        {byGroup.flatMap(({ group, modules }) =>
          modules.map((m) => (
            <tr key={m.key}>
              <Td>
                {m.label}
                <div className="text-xs text-slate-400">{m.key}</div>
              </Td>
              <Td muted>{group.title}</Td>
              <Td muted>{m.path ?? "—"}</Td>
              <Td>{m.is_active ? <Chip tone="emerald">On</Chip> : <Chip>Off</Chip>}</Td>
              <Td>
                <Visibility module={m} departments={departments} />
              </Td>
              <Td>
                <RunButton
                  tone="light"
                  label={m.is_active ? "Switch off" : "Switch on"}
                  run={() => rpc("set_module", { p_module: m.key, p_is_active: !m.is_active })}
                />
              </Td>
            </tr>
          )),
        )}
      </Table>
    </Card>
  );
}

function LogTab() {
  const log = useQuery(async () => {
    const rows = must(
      await supabase
        .from("access_audit_log")
        .select("id, action, detail, created_at, employees(name)")
        .order("created_at", { ascending: false })
        .limit(200),
    );
    return rows as unknown as { id: number; action: string; detail: Record<string, unknown>; created_at: string; employees: { name: string } | null }[];
  }, []);
  if (log.error) return <ErrorBox message={log.error} />;
  return (
    <Card>
      <Table head={["When", "Who", "Change"]}>
        {(log.data ?? []).length === 0 ? (
          <EmptyRow cols={3} text="No access changes yet." />
        ) : (
          log.data!.map((l) => (
            <tr key={l.id}>
              <Td muted>{fmtDateTime(l.created_at)}</Td>
              <Td>{l.employees?.name ?? "—"}</Td>
              <Td>
                <span className="font-medium">{l.action.replace("_", " ")}</span>{" "}
                <span className="text-xs text-slate-500">
                  {Object.entries(l.detail)
                    .filter(([, v]) => v !== null && v !== "")
                    .map(([k, v]) => `${k}: ${String(v)}`)
                    .join(" · ")}
                </span>
              </Td>
            </tr>
          ))
        )}
      </Table>
    </Card>
  );
}

// Extra roles, each for one branch or every branch (Techwheels' employee_assignments). The first row
// is the primary role, which follows the employee's own branch.
function EmployeeRoles({ employee, roles, outlets }: { employee: Employee; roles: Role[]; outlets: Named[] }) {
  type Row = { role_id: string; outlet_id: string; is_global: boolean };
  const extra = useQuery(
    async () =>
      must(
        await supabase.from("employee_role_assignments").select("role_id, outlet_id, is_global").eq("employee_id", employee.id),
      ) as { role_id: string; outlet_id: string | null; is_global: boolean }[],
    [employee.id],
  );
  const [rows, setRows] = useState<Row[] | null>(null);
  const current: Row[] =
    rows ??
    [
      { role_id: employee.role_id ?? "", outlet_id: "", is_global: false },
      ...(extra.data ?? []).map((a) => ({ role_id: a.role_id, outlet_id: a.outlet_id ?? "", is_global: a.is_global })),
    ];
  const set = (i: number, patch: Partial<Row>) => setRows(current.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const roleOptions = roles.map((r) => ({ id: r.id, name: r.name }));
  const scopeOptions = [{ id: "*", name: "Every branch" }, ...outlets];

  return (
    <Card title="Roles" note="Rights from every role add up. The first role is the primary one (it decides rank and approvals).">
      <div className="space-y-2 px-3 py-2 text-sm">
        {current.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Select value={r.role_id} onChange={(v) => set(i, { role_id: v })} options={roleOptions} placeholder="Role" />
            {i === 0 ? (
              <span className="text-xs text-slate-500">Primary · own branch</span>
            ) : (
              <>
                <Select
                  value={r.is_global ? "*" : r.outlet_id}
                  onChange={(v) => set(i, v === "*" ? { is_global: true, outlet_id: "" } : { is_global: false, outlet_id: v })}
                  options={scopeOptions}
                  placeholder="Branch"
                />
                <button type="button" className="text-xs text-red-600" onClick={() => setRows(current.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </>
            )}
          </div>
        ))}
        <div className="flex gap-2">
          <RunButton tone="light" label="Add role" run={async () => setRows([...current, { role_id: "", outlet_id: "", is_global: true }])} />
          <RunButton
            label="Save roles"
            disabled={!rows}
            run={async () => {
              if (current.some((r, i) => !r.role_id || (i > 0 && !r.is_global && !r.outlet_id))) throw new Error("Pick a role and branch on every row");
              await rpc("set_employee_roles", { p_employee_id: employee.id, p_roles: current });
              setRows(null);
            }}
          />
        </div>
      </div>
    </Card>
  );
}

// Finance executives can be limited to some financiers; none ticked means every financier.
function FinancierScope({ employeeId, financiers }: { employeeId: string; financiers: Named[] }) {
  const scope = useQuery(
    async () =>
      new Set(
        (must(await supabase.from("employee_financier_scope").select("financier_id").eq("employee_id", employeeId)) as { financier_id: string }[]).map(
          (r) => r.financier_id,
        ),
      ),
    [employeeId],
  );
  if (!financiers.length) return null;
  return (
    <Card title="Financiers" note="For finance executives: which financiers' cases they work. None ticked = all.">
      <Loaded q={scope}>
        {(have) => (
          <div className="flex flex-wrap gap-3 px-3 py-2 text-sm">
            {financiers.map((f) => (
              <label key={f.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={have.has(f.id)}
                  onChange={() => {
                    const next = new Set(have);
                    if (next.has(f.id)) next.delete(f.id);
                    else next.add(f.id);
                    rpc("set_employee_financier_scope", { p_employee_id: employeeId, p_financier_ids: [...next] }).catch((e) => alert(e.message));
                  }}
                />
                {f.name}
              </label>
            ))}
          </div>
        )}
      </Loaded>
    </Card>
  );
}

function Visibility({ module: m, departments }: { module: ModuleRow; departments: Department[] }) {
  const [open, setOpen] = useState(false);
  const [ownOnly, setOwnOnly] = useState(m.own_only);
  const [limited, setLimited] = useState(m.hierarchy_scope === "limited");
  const [deps, setDeps] = useState<string[]>(m.scope_departments);
  const label = m.own_only ? "Own only" : m.hierarchy_scope === "limited" ? `Only ${m.scope_departments.join(", ")}` : "Team / branch";
  if (!open)
    return (
      <button type="button" className="text-xs text-slate-600 underline decoration-dotted" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  return (
    <div className="space-y-1 text-xs">
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={ownOnly} onChange={(e) => setOwnOnly(e.target.checked)} /> Own records only
      </label>
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={limited} onChange={(e) => setLimited(e.target.checked)} /> Limit to departments
      </label>
      {limited && (
        <div className="flex flex-wrap gap-2">
          {departments.map((d) => (
            <label key={d.code} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={deps.includes(d.code)}
                onChange={() => setDeps(deps.includes(d.code) ? deps.filter((x) => x !== d.code) : [...deps, d.code])}
              />
              {d.name}
            </label>
          ))}
        </div>
      )}
      <RunButton
        label="Save"
        run={async () => {
          await rpc("set_module_visibility", {
            p_module: m.key,
            p_own_only: ownOnly,
            p_scope: limited ? "limited" : "all",
            p_departments: limited ? deps : null,
          });
          setOpen(false);
        }}
      />
    </div>
  );
}
