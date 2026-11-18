import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import type { AppModule, MenuGroup, Right } from "@/lib/rbac";
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

type Role = { id: string; name: string; rank: number };
type Employee = { id: string; name: string; role_id: string | null; is_active: boolean };
type Effective = { module_key: string; right: Right; allowed: boolean; source: "admin" | "grant" | "revoke" | "role" | "none" };

// Who can do what (Techwheels' Employee Access Studio): rights per role, personal grants and revokes,
// and switching modules on or off. Only the Admin and the Business Head get here.
export default function AccessStudio() {
  const [tab, setTab] = useState("roles");
  const base = useQuery(async () => {
    const [groups, modules, roles, employees] = await Promise.all([
      supabase.from("menu_groups").select("key, title, sort_order").order("sort_order"),
      supabase.from("app_modules").select("key, group_key, label, path, sort_order, in_menu, is_active").order("sort_order"),
      supabase.from("roles").select("id, name, rank").order("rank").order("name"),
      supabase.from("employees").select("id, name, role_id, is_active").eq("is_active", true).order("name"),
    ]);
    return {
      groups: must(groups) as MenuGroup[],
      modules: must(modules) as AppModule[],
      roles: must(roles) as Role[],
      employees: must(employees) as Employee[],
    };
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
            <ModulesTab groups={d.groups} modules={d.modules} />
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

function PeopleTab({ groups, modules, roles, employees }: { groups: MenuGroup[]; modules: AppModule[]; roles: Role[]; employees: Employee[] }) {
  const [employeeId, setEmployeeId] = useState("");
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
        <span className="text-xs text-slate-400">
          Click a cell: <Chip tone="emerald">grant</Chip> → <Chip tone="red">revoke</Chip> → back to the role.
        </span>
      </div>
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
                    <button type="button" onClick={() => cycle(m.key, r, e)} title={e?.source} disabled={e?.source === "admin"}>
                      <Chip tone={tone}>{e?.allowed ? "✓" : "–"}</Chip>
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

function ModulesTab({ groups, modules }: { groups: MenuGroup[]; modules: AppModule[] }) {
  const byGroup = useMemo(() => grouped(groups, modules), [groups, modules]);
  return (
    <Card note="Switch a module off to hide it from everyone except the Admin, e.g. a new phase before go-live.">
      <Table head={["Module", "Menu", "Path", "Status", ""]}>
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
