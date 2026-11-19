-- Phase 23: Access Studio depth — the rest of Techwheels' RBAC logic on top of Phase 17b.
--   - departments become a master table; roles belong to a department.
--   - An employee can hold extra roles (employee_role_assignments), each limited to one outlet or
--     global, as Techwheels' employee_assignments. Their rights add to the primary role's.
--   - Right 'all' is a wildcard that matches every right (Techwheels' ALL).
--   - Edit and delete need view as well; create and approve are "functional" rights that stand on
--     their own (Techwheels' canAccessRight). Ticking edit/delete for a role adds view.
--   - Per-module visibility settings: own_only (people see only their own records) and a limited
--     department scope, used by can_see_employee_record(), Techwheels' visibility_core_pass.
--   - Reporting hierarchy: every manager change is logged with its reason (reporting_hierarchy_history),
--     a dedicated reassign RPC checks cycles and visibility, and a month can be frozen as a snapshot
--     (payroll and Team Leader incentives read who reported to whom in that month).
--   - Finance executives can be limited to some financiers (employee_financier_scope, used in Phase 29).
--   - Who may manage access is now a right (access_studio: edit), not only the Admin / Business Head rank.

-- ===== Departments =====
create table departments (
  code text primary key,
  name text not null,
  sort_order int not null default 0,
  is_active boolean not null default true
);
insert into departments (code, name, sort_order) values
  ('sales', 'Sales', 10),
  ('customer_relations', 'Customer Relations', 20),
  ('accounts', 'Accounts', 30),
  ('finance', 'Finance', 40),
  ('insurance_rto', 'Insurance & RTO', 50),
  ('workshop', 'Workshop / PDI', 60),
  ('hr_admin', 'HR & Admin', 70),
  ('management', 'Management', 80),
  ('other', 'Other', 90);

alter table employees drop constraint if exists employees_department_check;
alter table employees add constraint employees_department_fkey foreign key (department) references departments(code);

alter table roles add column department_code text references departments(code);
update roles set department_code = case name
  when 'Admin' then 'management'
  when 'Business Head' then 'management'
  when 'Outlet Head' then 'management'
  when 'Head Customer Relations' then 'customer_relations'
  when 'Team Leader' then 'sales'
  when 'Sales Consultant' then 'sales'
  when 'Accounts' then 'accounts'
  when 'Finance Executive' then 'finance'
  when 'HR' then 'hr_admin'
  when 'Relationship Manager' then 'customer_relations'
  when 'PDI Technician' then 'workshop'
  when 'Insurance Executive' then 'insurance_rto'
  when 'RTO Executive' then 'insurance_rto'
  when 'Gate Security' then 'hr_admin'
  when 'Used Car Evaluator' then 'sales'
  when 'Receptionist' then 'customer_relations'
end;

alter table departments enable row level security;
create policy departments_select on departments for select to authenticated using (true);

-- ===== Right 'all' (wildcard) =====
alter table role_module_rights drop constraint role_module_rights_right_check;
alter table role_module_rights add constraint role_module_rights_right_check
  check ("right" in ('view', 'create', 'edit', 'approve', 'delete', 'all'));
alter table employee_module_overrides drop constraint employee_module_overrides_right_check;
alter table employee_module_overrides add constraint employee_module_overrides_right_check
  check ("right" in ('view', 'create', 'edit', 'approve', 'delete', 'all'));

-- ===== Extra roles =====
create table employee_role_assignments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  role_id uuid not null references roles(id),
  outlet_id uuid references outlets(id),     -- null with is_global: every outlet
  is_global boolean not null default false,
  assigned_by uuid references employees(id),
  assigned_at timestamptz not null default now(),
  check (is_global or outlet_id is not null),
  check (not (is_global and outlet_id is not null))
);
create unique index employee_role_assignments_key
  on employee_role_assignments (employee_id, role_id, coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index idx_employee_role_assignments_role on employee_role_assignments(role_id);
create index idx_employee_role_assignments_outlet on employee_role_assignments(outlet_id);
create index idx_employee_role_assignments_by on employee_role_assignments(assigned_by);
alter table employee_role_assignments enable row level security;
create policy employee_role_assignments_select on employee_role_assignments for select to authenticated
  using (employee_id = current_employee_id() or can_access_employee_data(current_employee_id(), employee_id));

-- ===== Module visibility settings =====
alter table app_modules
  add column own_only boolean not null default false,
  add column hierarchy_scope text not null default 'all' check (hierarchy_scope in ('all', 'limited')),
  add column scope_departments text[] not null default '{}',
  add constraint app_modules_limited_scope check (hierarchy_scope = 'all' or cardinality(scope_departments) > 0);

-- ===== The rights engine =====
-- Why one employee has (or lacks) one right on one module:
--   admin  — rank 0, everything
--   revoke — a personal revoke (of this right or 'all')
--   grant  — a personal grant
--   role   — the primary role or any extra role gives it
--   none
create or replace function employee_right_source(p_employee_id uuid, p_module text, p_right text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select e.id, e.role_id, r.rank
    from employees e left join roles r on r.id = e.role_id
    where e.id = p_employee_id and e.is_active
  )
  select coalesce((
    select case
      when me.rank = 0 then 'admin'
      when not exists (select 1 from app_modules m where m.key = p_module and m.is_active) then 'none'
      when exists (select 1 from employee_module_overrides o
                   where o.employee_id = me.id and o.module_key = p_module and o."right" in (p_right, 'all') and o.effect = 'revoke') then 'revoke'
      when exists (select 1 from employee_module_overrides o
                   where o.employee_id = me.id and o.module_key = p_module and o."right" in (p_right, 'all') and o.effect = 'grant') then 'grant'
      when exists (select 1 from role_module_rights rr
                   where rr.module_key = p_module and rr."right" in (p_right, 'all')
                     and (rr.role_id = me.role_id
                          or rr.role_id in (select a.role_id from employee_role_assignments a where a.employee_id = me.id))) then 'role'
      else 'none'
    end
    from me
  ), 'none');
$$;

-- Edit and delete also need view; view, create and approve stand on their own.
create or replace function employee_has_right(p_employee_id uuid, p_module text, p_right text default 'view')
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select employee_right_source(p_employee_id, p_module, p_right) in ('admin', 'grant', 'role')
     and (p_right not in ('edit', 'delete')
          or employee_right_source(p_employee_id, p_module, 'view') in ('admin', 'grant', 'role'));
$$;

create or replace function has_right(p_module text, p_right text default 'view')
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select employee_has_right(current_employee_id(), p_module, p_right);
$$;

create or replace function my_rights()
returns table (module_key text, "right" text)
language sql
stable
security definer
set search_path = public
as $$
  select m.key, x.r
  from app_modules m
  cross join (values ('view'), ('create'), ('edit'), ('approve'), ('delete')) x(r)
  where m.is_active and employee_has_right(current_employee_id(), m.key, x.r);
$$;

-- Access is managed by the Admin, the Business Head, or anyone given Access Studio: edit.
create or replace function can_manage_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_employee_role_rank() <= 1, false)
      or employee_right_source(current_employee_id(), 'access_studio', 'edit') in ('grant', 'role');
$$;

-- What one employee ends up with, and why, for the Access Studio matrix: the role baseline,
-- the personal override, and the effective result (with the view rule applied).
drop function if exists employee_effective_rights(uuid);
create or replace function employee_effective_rights(p_employee_id uuid)
returns table (module_key text, "right" text, allowed boolean, source text, role_has boolean, override text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role uuid;
begin
  if not can_manage_access() and p_employee_id is distinct from current_employee_id() then
    raise exception 'Only the Admin or Business Head can see other people''s access';
  end if;
  select role_id into v_role from employees where id = p_employee_id;
  return query
  select m.key, x.r,
         employee_has_right(p_employee_id, m.key, x.r),
         employee_right_source(p_employee_id, m.key, x.r),
         exists (select 1 from role_module_rights rr
                 where rr.module_key = m.key and rr."right" in (x.r, 'all')
                   and (rr.role_id = v_role
                        or rr.role_id in (select a.role_id from employee_role_assignments a where a.employee_id = p_employee_id))),
         (select o.effect from employee_module_overrides o
          where o.employee_id = p_employee_id and o.module_key = m.key and o."right" = x.r)
  from app_modules m
  cross join (values ('view'), ('create'), ('edit'), ('approve'), ('delete')) x(r)
  order by m.group_key, m.sort_order, m.key, x.r;
end;
$$;

-- Role rights: ticking edit or delete adds view; taking view away takes edit and delete with it.
create or replace function set_role_right(p_role_id uuid, p_module text, p_right text, p_on boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not can_manage_access() then
    raise exception 'Only the Admin or Business Head can change access';
  end if;
  if (select rank from roles where id = p_role_id) <= 1 and not coalesce(current_employee_role_rank() = 0, false) then
    raise exception 'Only the Admin can change the Admin and Business Head roles';
  end if;
  if p_right not in ('view', 'create', 'edit', 'approve', 'delete', 'all') then
    raise exception 'Unknown right %', p_right;
  end if;
  if p_on then
    insert into role_module_rights (role_id, module_key, "right") values (p_role_id, p_module, p_right)
    on conflict do nothing;
    if p_right in ('edit', 'delete') then
      insert into role_module_rights (role_id, module_key, "right") values (p_role_id, p_module, 'view')
      on conflict do nothing;
    end if;
  else
    delete from role_module_rights where role_id = p_role_id and module_key = p_module
      and ("right" = p_right or (p_right = 'view' and "right" in ('edit', 'delete')));
  end if;
  perform access_log('role_right', jsonb_build_object('role_id', p_role_id, 'module', p_module, 'right', p_right, 'on', p_on));
end;
$$;

-- ===== Roles of one employee =====
-- p_roles: [{role_id, outlet_id | null, is_global}], first entry = primary role (employees.role_id,
-- whose scope is the employee's own outlet). Active staff must keep at least one role.
create or replace function set_employee_roles(p_employee_id uuid, p_roles jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary uuid;
  r jsonb;
  v_rank int;
  v_my_rank int := current_employee_role_rank();
  i int := 0;
begin
  if not can_manage_access() then
    raise exception 'Only the Admin or Business Head can change access';
  end if;
  if p_employee_id = current_employee_id() then
    raise exception 'You cannot change your own access';
  end if;
  if not exists (select 1 from employees where id = p_employee_id) then
    raise exception 'Unknown employee';
  end if;
  if jsonb_typeof(p_roles) <> 'array' or jsonb_array_length(p_roles) = 0 then
    raise exception 'An employee must keep at least one role';
  end if;

  for r in select * from jsonb_array_elements(p_roles) loop
    select rank into v_rank from roles where id = (r->>'role_id')::uuid;
    if v_rank is null then raise exception 'Unknown role'; end if;
    if v_rank <= 1 and coalesce(v_my_rank, 99) <> 0 then
      raise exception 'Only the Admin can give the Admin or Business Head role';
    end if;
  end loop;

  v_primary := (p_roles->0->>'role_id')::uuid;
  update employees set role_id = v_primary where id = p_employee_id;

  delete from employee_role_assignments where employee_id = p_employee_id;
  for r in select * from jsonb_array_elements(p_roles) loop
    i := i + 1;
    continue when i = 1;
    insert into employee_role_assignments (employee_id, role_id, outlet_id, is_global, assigned_by)
    values (p_employee_id, (r->>'role_id')::uuid,
            case when coalesce((r->>'is_global')::boolean, false) then null else nullif(r->>'outlet_id', '')::uuid end,
            coalesce((r->>'is_global')::boolean, false), current_employee_id())
    on conflict do nothing;
  end loop;
  perform access_log('employee_roles', jsonb_build_object('employee_id', p_employee_id, 'roles', p_roles));
end;
$$;

-- Per-module visibility settings (own only / limited departments).
create or replace function set_module_visibility(p_module text, p_own_only boolean, p_scope text, p_departments text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not can_manage_access() then
    raise exception 'Only the Admin or Business Head can change modules';
  end if;
  if p_scope = 'limited' and coalesce(cardinality(p_departments), 0) = 0 then
    raise exception 'A limited scope needs at least one department';
  end if;
  update app_modules
     set own_only = p_own_only, hierarchy_scope = p_scope,
         scope_departments = case when p_scope = 'limited' then p_departments else '{}' end, updated_at = now()
   where key = p_module;
  if not found then raise exception 'Unknown module %', p_module; end if;
  perform access_log('module_visibility',
    jsonb_build_object('module', p_module, 'own_only', p_own_only, 'scope', p_scope, 'departments', p_departments));
end;
$$;

-- May the signed-in employee see a record that belongs to p_target (the consultant on a booking, the
-- employee on a payroll line…) in this module? Techwheels' visibility_core_pass:
--   1. needs view on the module
--   2. own_only modules: own records only
--   3. limited scope: the target must be in one of the module's departments
--   4. then the usual reach: self, own team (hierarchy), own outlet for Outlet Heads, everything for
--      rank 0–1, or an extra role held globally / at the target's outlet.
create or replace function can_see_employee_record(p_module text, p_target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with me as (select current_employee_id() as id, current_employee_role_rank() as rank),
       m as (select * from app_modules where key = p_module),
       t as (select id, outlet_id, department from employees where id = p_target)
  select coalesce((
    select case
      when me.id is null then false
      when me.rank = 0 then true
      when not has_right(p_module, 'view') then false
      when m.own_only then me.id = p_target
      when m.hierarchy_scope = 'limited' and coalesce(t.department, '') <> all (m.scope_departments) then false
      when can_access_employee_data(me.id, p_target) then true
      else exists (select 1 from employee_role_assignments a
                   where a.employee_id = me.id and (a.is_global or a.outlet_id = t.outlet_id))
    end
    from me, m left join t on true
  ), false);
$$;

-- ===== Reporting hierarchy =====
create table reporting_hierarchy_history (
  id bigserial primary key,
  employee_id uuid not null references employees(id) on delete cascade,
  manager_id uuid references employees(id),
  previous_manager_id uuid references employees(id),
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  reason text,
  changed_by uuid references employees(id)
);
create index idx_rh_history_employee on reporting_hierarchy_history(employee_id, effective_from);
create index idx_rh_history_manager on reporting_hierarchy_history(manager_id);
create index idx_rh_history_prev on reporting_hierarchy_history(previous_manager_id);
create index idx_rh_history_by on reporting_hierarchy_history(changed_by);

-- Today's hierarchy is the starting point of the history.
insert into reporting_hierarchy_history (employee_id, manager_id, effective_from, reason)
select id, reports_to_employee_id, created_at, 'Starting hierarchy' from employees;

-- Every change of manager, from any path (HR save, leaver handover, reassign), is logged. The reason
-- comes from the session setting app.hierarchy_reason when the caller sets one.
create or replace function reporting_hierarchy_log_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE' and NEW.reports_to_employee_id is not distinct from OLD.reports_to_employee_id then
    return NEW;
  end if;
  update reporting_hierarchy_history set effective_to = now()
   where employee_id = NEW.id and effective_to is null;
  insert into reporting_hierarchy_history (employee_id, manager_id, previous_manager_id, reason, changed_by)
  values (NEW.id, NEW.reports_to_employee_id,
          case when TG_OP = 'UPDATE' then OLD.reports_to_employee_id end,
          coalesce(nullif(current_setting('app.hierarchy_reason', true), ''),
                   case when TG_OP = 'INSERT' then 'Joined' else 'Updated on the employee record' end),
          current_employee_id());
  return NEW;
end;
$$;
create trigger trg_employees_hierarchy_log
  after insert or update of reports_to_employee_id on employees
  for each row execute function reporting_hierarchy_log_change();

create or replace function reassign_manager(p_employee_id uuid, p_manager_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := current_employee_id();
begin
  if not has_right('reporting_hierarchy', 'edit') then
    raise exception 'You need Reporting Hierarchy: edit to change managers';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'Give a reason for the change';
  end if;
  if not exists (select 1 from employees where id = p_employee_id and is_active) then
    raise exception 'The employee is not active';
  end if;
  if p_manager_id is not null and not exists (select 1 from employees where id = p_manager_id and is_active) then
    raise exception 'The new manager is not active';
  end if;
  if p_manager_id = p_employee_id then
    raise exception 'An employee cannot report to themselves';
  end if;
  if (select r.rank from employees e join roles r on r.id = e.role_id where e.id = p_employee_id) = 0 then
    raise exception 'The Admin does not report to anyone';
  end if;
  if coalesce(current_employee_role_rank(), 99) > 1 and not is_hr() then
    if not can_access_employee_data(v_me, p_employee_id)
       or (p_manager_id is not null and not can_access_employee_data(v_me, p_manager_id)) then
      raise exception 'You can only move people you can see, to managers you can see';
    end if;
  end if;
  -- The new manager must not report (directly or not) to the employee.
  if p_manager_id is not null and exists (
    with recursive chain(id) as (
      select p_manager_id
      union
      select e.reports_to_employee_id from employees e join chain c on e.id = c.id where e.reports_to_employee_id is not null
    )
    select 1 from chain where id = p_employee_id
  ) then
    raise exception 'That would make a loop: the new manager reports to this employee';
  end if;

  perform set_config('app.hierarchy_reason', trim(p_reason), true);
  update employees set reports_to_employee_id = p_manager_id where id = p_employee_id;
  perform set_config('app.hierarchy_reason', '', true);
end;
$$;

-- Who did this employee report to at a moment in time.
create or replace function manager_at(p_employee_id uuid, p_at timestamptz)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select manager_id from reporting_hierarchy_history
  where employee_id = p_employee_id and effective_from <= p_at and (effective_to is null or effective_to > p_at)
  order by effective_from desc limit 1;
$$;

-- A month's hierarchy, frozen (the payroll and Team Leader incentive runs read this).
create table reporting_hierarchy_snapshots (
  month date not null check (month = date_trunc('month', month)::date),
  employee_id uuid not null references employees(id) on delete cascade,
  manager_id uuid references employees(id),
  role_id uuid references roles(id),
  outlet_id uuid references outlets(id),
  saved_by uuid references employees(id),
  saved_at timestamptz not null default now(),
  primary key (month, employee_id)
);
create index idx_rh_snap_manager on reporting_hierarchy_snapshots(manager_id);
create index idx_rh_snap_employee on reporting_hierarchy_snapshots(employee_id);
create index idx_rh_snap_role on reporting_hierarchy_snapshots(role_id);
create index idx_rh_snap_outlet on reporting_hierarchy_snapshots(outlet_id);
create index idx_rh_snap_by on reporting_hierarchy_snapshots(saved_by);

create or replace function save_hierarchy_snapshot(p_month date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_end timestamptz := ((v_month + interval '1 month') - interval '1 second')::timestamptz;
  n int;
begin
  if not has_right('reporting_hierarchy', 'edit') then
    raise exception 'You need Reporting Hierarchy: edit to save a snapshot';
  end if;
  delete from reporting_hierarchy_snapshots where month = v_month;
  insert into reporting_hierarchy_snapshots (month, employee_id, manager_id, role_id, outlet_id, saved_by)
  select v_month, e.id, coalesce(manager_at(e.id, least(v_end, now())), e.reports_to_employee_id), e.role_id, e.outlet_id, current_employee_id()
  from employees e
  where e.is_active or e.exit_date >= v_month;
  get diagnostics n = row_count;
  return n;
end;
$$;

alter table reporting_hierarchy_history enable row level security;
alter table reporting_hierarchy_snapshots enable row level security;
create policy rh_history_select on reporting_hierarchy_history for select to authenticated
  using (has_right('reporting_hierarchy', 'view') and can_access_employee_data(current_employee_id(), employee_id));
create policy rh_snap_select on reporting_hierarchy_snapshots for select to authenticated
  using (has_right('reporting_hierarchy', 'view') and can_access_employee_data(current_employee_id(), employee_id));

-- ===== Financier scope for finance executives =====
create table employee_financier_scope (
  employee_id uuid not null references employees(id) on delete cascade,
  financier_id uuid not null references financiers(id) on delete cascade,
  set_by uuid references employees(id),
  set_at timestamptz not null default now(),
  primary key (employee_id, financier_id)
);
create index idx_emp_fin_scope_financier on employee_financier_scope(financier_id);
create index idx_emp_fin_scope_by on employee_financier_scope(set_by);
alter table employee_financier_scope enable row level security;
create policy emp_fin_scope_select on employee_financier_scope for select to authenticated
  using (employee_id = current_employee_id() or can_manage_access() or has_right('finance_cases', 'approve'));

create or replace function set_employee_financier_scope(p_employee_id uuid, p_financier_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not can_manage_access() then
    raise exception 'Only the Admin or Business Head can change access';
  end if;
  delete from employee_financier_scope where employee_id = p_employee_id;
  insert into employee_financier_scope (employee_id, financier_id, set_by)
  select p_employee_id, f, current_employee_id() from unnest(coalesce(p_financier_ids, '{}')) f
  on conflict do nothing;
  perform access_log('financier_scope', jsonb_build_object('employee_id', p_employee_id, 'financiers', p_financier_ids));
end;
$$;

-- True when the employee may work this financier's cases: no scope set means every financier.
create or replace function employee_can_work_financier(p_employee_id uuid, p_financier_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (select 1 from employee_financier_scope where employee_id = p_employee_id)
      or exists (select 1 from employee_financier_scope where employee_id = p_employee_id and financier_id = p_financier_id);
$$;

-- ===== Department master writes =====
create or replace function save_department(p_code text, p_name text, p_sort int, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not has_right('departments', 'edit') then
    raise exception 'You need Departments: edit';
  end if;
  if p_code !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'Code must be lower-case letters, digits and _';
  end if;
  insert into departments (code, name, sort_order, is_active) values (p_code, trim(p_name), coalesce(p_sort, 0), coalesce(p_is_active, true))
  on conflict (code) do update set name = excluded.name, sort_order = excluded.sort_order, is_active = excluded.is_active;
end;
$$;

create or replace function set_role_department(p_role_id uuid, p_department text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not has_right('departments', 'edit') then
    raise exception 'You need Departments: edit';
  end if;
  update roles set department_code = p_department where id = p_role_id;
end;
$$;

-- ===== Grants =====
revoke execute on function employee_right_source(uuid, text, text) from public, anon, authenticated;
revoke execute on function employee_has_right(uuid, text, text) from public, anon, authenticated;
revoke execute on function employee_effective_rights(uuid) from public, anon;
revoke execute on function set_role_right(uuid, text, text, boolean) from public, anon;
revoke execute on function set_employee_roles(uuid, jsonb) from public, anon;
revoke execute on function set_module_visibility(text, boolean, text, text[]) from public, anon;
revoke execute on function can_see_employee_record(text, uuid) from public, anon;
revoke execute on function reporting_hierarchy_log_change() from public, anon, authenticated;
revoke execute on function reassign_manager(uuid, uuid, text) from public, anon;
revoke execute on function manager_at(uuid, timestamptz) from public, anon;
revoke execute on function save_hierarchy_snapshot(date) from public, anon;
revoke execute on function set_employee_financier_scope(uuid, uuid[]) from public, anon;
revoke execute on function employee_can_work_financier(uuid, uuid) from public, anon;
revoke execute on function save_department(text, text, int, boolean) from public, anon;
revoke execute on function set_role_department(uuid, text) from public, anon;
grant execute on function employee_effective_rights(uuid) to authenticated;
grant execute on function set_role_right(uuid, text, text, boolean) to authenticated;
grant execute on function set_employee_roles(uuid, jsonb) to authenticated;
grant execute on function set_module_visibility(text, boolean, text, text[]) to authenticated;
grant execute on function can_see_employee_record(text, uuid) to authenticated;
grant execute on function reassign_manager(uuid, uuid, text) to authenticated;
grant execute on function manager_at(uuid, timestamptz) to authenticated;
grant execute on function save_hierarchy_snapshot(date) to authenticated;
grant execute on function set_employee_financier_scope(uuid, uuid[]) to authenticated;
grant execute on function employee_can_work_financier(uuid, uuid) to authenticated;
grant execute on function save_department(text, text, int, boolean) to authenticated;
grant execute on function set_role_department(uuid, text) to authenticated;

-- ===== Menu =====
insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('departments',         'admin', 'Departments',         '/admin/departments',         20, true),
  ('reporting_hierarchy', 'admin', 'Reporting Hierarchy', '/admin/reporting-hierarchy', 30, true);
select seed_role_rights('HR', 'departments', array['view', 'edit']);
select seed_role_rights('HR', 'reporting_hierarchy', array['view', 'edit']);
select seed_role_rights('Outlet Head', 'reporting_hierarchy', array['view']);
