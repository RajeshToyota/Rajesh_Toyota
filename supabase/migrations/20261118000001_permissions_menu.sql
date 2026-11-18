-- Phase 17b: module permissions and a database-driven menu (the Techwheels RBAC model).
--   - app_modules: one row per screen / feature ("module"), grouped for the top menu. The web app's
--     route registry (web/src/modules.ts) uses the same keys.
--   - Rights per module: view, create, edit, approve, delete.
--   - role_module_rights: what each role gets. employee_module_overrides: per-person grant or revoke,
--     which beats the role (as Techwheels' employee_permission_rights does).
--   - has_right(module, right): Admin always; otherwise revoke > grant > role. It decides what the menu
--     shows and gates new RPCs. Which *rows* someone sees is still decided by the existing rank,
--     hierarchy and branch rules in RLS, exactly as Techwheels keeps visibility separate from rights.
--   - Access Studio (Admin / Business Head only) edits role rights and personal overrides.
--   - New roles Techwheels has and Rajesh Toyota lacked. Rank 6 keeps them out of every approval and
--     hierarchy check; what they can reach comes from their rights and the phase that uses them.

-- ===== New roles =====
insert into roles (id, name, rank) values
  ('00000000-0000-0000-0001-00000000000a', 'Relationship Manager', 6),
  ('00000000-0000-0000-0001-00000000000b', 'PDI Technician', 6),
  ('00000000-0000-0000-0001-00000000000c', 'Insurance Executive', 6),
  ('00000000-0000-0000-0001-00000000000d', 'RTO Executive', 6),
  ('00000000-0000-0000-0001-00000000000e', 'Gate Security', 6),
  ('00000000-0000-0000-0001-00000000000f', 'Used Car Evaluator', 6),
  ('00000000-0000-0000-0001-000000000010', 'Receptionist', 6)
on conflict (id) do nothing;

-- True when the signed-in employee holds the named role.
create or replace function has_role(p_role_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from employees e join roles r on r.id = e.role_id
    where e.id = current_employee_id() and e.is_active and r.name = p_role_name
  );
$$;

-- ===== Modules and menu =====
create table menu_groups (
  key text primary key,
  title text not null,
  sort_order int not null default 0
);

create table app_modules (
  key text primary key,
  group_key text not null references menu_groups(key),
  label text not null,
  path text,                         -- null: a feature without its own menu entry
  description text,
  sort_order int not null default 0,
  in_menu boolean not null default true,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);
create index idx_app_modules_group on app_modules(group_key);

create table role_module_rights (
  role_id uuid not null references roles(id) on delete cascade,
  module_key text not null references app_modules(key) on delete cascade,
  "right" text not null check ("right" in ('view', 'create', 'edit', 'approve', 'delete')),
  primary key (role_id, module_key, "right")
);
create index idx_role_module_rights_module on role_module_rights(module_key);

create table employee_module_overrides (
  employee_id uuid not null references employees(id) on delete cascade,
  module_key text not null references app_modules(key) on delete cascade,
  "right" text not null check ("right" in ('view', 'create', 'edit', 'approve', 'delete')),
  effect text not null check (effect in ('grant', 'revoke')),
  reason text,
  set_by uuid references employees(id),
  set_at timestamptz not null default now(),
  primary key (employee_id, module_key, "right")
);
create index idx_employee_module_overrides_module on employee_module_overrides(module_key);
create index idx_employee_module_overrides_set_by on employee_module_overrides(set_by);

create table access_audit_log (
  id bigserial primary key,
  actor_employee_id uuid references employees(id),
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index idx_access_audit_actor on access_audit_log(actor_employee_id);

-- Admin (rank 0) has every right; nobody else edits who can do what except the Business Head.
create or replace function can_manage_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_employee_role_rank() <= 1, false);
$$;

create or replace function has_right(p_module text, p_right text default 'view')
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select e.id, e.role_id, r.rank
    from employees e left join roles r on r.id = e.role_id
    where e.auth_user_id = auth.uid() and e.is_active
    limit 1
  )
  select coalesce((
    select case
      when me.rank = 0 then true
      when not exists (select 1 from app_modules m where m.key = p_module and m.is_active) then false
      when exists (select 1 from employee_module_overrides o
                   where o.employee_id = me.id and o.module_key = p_module and o."right" = p_right and o.effect = 'revoke') then false
      when exists (select 1 from employee_module_overrides o
                   where o.employee_id = me.id and o.module_key = p_module and o."right" = p_right and o.effect = 'grant') then true
      else exists (select 1 from role_module_rights rr
                   where rr.role_id = me.role_id and rr.module_key = p_module and rr."right" = p_right)
    end
    from me
  ), false);
$$;

-- Everything the signed-in employee may do, for the web app's menu and buttons (one call at sign-in).
create or replace function my_rights()
returns table (module_key text, "right" text)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select e.id, e.role_id, r.rank
    from employees e left join roles r on r.id = e.role_id
    where e.auth_user_id = auth.uid() and e.is_active
    limit 1
  ),
  candidates as (
    select m.key, x.r
    from app_modules m cross join (values ('view'), ('create'), ('edit'), ('approve'), ('delete')) x(r)
    where m.is_active
  )
  select c.key, c.r
  from candidates c, me
  where me.rank = 0
     or (
       not exists (select 1 from employee_module_overrides o
                   where o.employee_id = me.id and o.module_key = c.key and o."right" = c.r and o.effect = 'revoke')
       and (
         exists (select 1 from employee_module_overrides o
                 where o.employee_id = me.id and o.module_key = c.key and o."right" = c.r and o.effect = 'grant')
         or exists (select 1 from role_module_rights rr
                    where rr.role_id = me.role_id and rr.module_key = c.key and rr."right" = c.r)
       )
     );
$$;

-- ===== RLS =====
alter table menu_groups enable row level security;
alter table app_modules enable row level security;
alter table role_module_rights enable row level security;
alter table employee_module_overrides enable row level security;
alter table access_audit_log enable row level security;

create policy menu_groups_select on menu_groups for select to authenticated using (true);
create policy app_modules_select on app_modules for select to authenticated using (true);
create policy role_module_rights_select on role_module_rights for select to authenticated using (true);
create policy employee_module_overrides_select on employee_module_overrides for select to authenticated
  using (can_manage_access() or employee_id = current_employee_id());
create policy access_audit_log_select on access_audit_log for select to authenticated using (can_manage_access());
-- All writes go through the Access Studio RPCs below.

-- ===== Access Studio =====
create or replace function access_log(p_action text, p_detail jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into access_audit_log (actor_employee_id, action, detail) values (current_employee_id(), p_action, p_detail);
$$;

-- Turn one right on or off for a role.
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
  if p_on then
    insert into role_module_rights (role_id, module_key, "right") values (p_role_id, p_module, p_right)
    on conflict do nothing;
  else
    delete from role_module_rights where role_id = p_role_id and module_key = p_module and "right" = p_right;
  end if;
  perform access_log('role_right', jsonb_build_object('role_id', p_role_id, 'module', p_module, 'right', p_right, 'on', p_on));
end;
$$;

-- Give (grant) or take away (revoke) one right from one person, whatever their role says;
-- p_effect null removes the override so the role decides again.
create or replace function set_employee_override(p_employee_id uuid, p_module text, p_right text, p_effect text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not can_manage_access() then
    raise exception 'Only the Admin or Business Head can change access';
  end if;
  if p_employee_id = current_employee_id() then
    raise exception 'You cannot change your own access';
  end if;
  if p_effect is null then
    delete from employee_module_overrides where employee_id = p_employee_id and module_key = p_module and "right" = p_right;
  else
    if p_effect not in ('grant', 'revoke') then
      raise exception 'Effect must be grant or revoke';
    end if;
    insert into employee_module_overrides (employee_id, module_key, "right", effect, reason, set_by)
    values (p_employee_id, p_module, p_right, p_effect, nullif(trim(p_reason), ''), current_employee_id())
    on conflict (employee_id, module_key, "right")
      do update set effect = excluded.effect, reason = excluded.reason, set_by = excluded.set_by, set_at = now();
  end if;
  perform access_log('employee_override',
    jsonb_build_object('employee_id', p_employee_id, 'module', p_module, 'right', p_right, 'effect', p_effect, 'reason', p_reason));
end;
$$;

-- Show or hide a module for everyone (e.g. a phase not switched on yet) and rename it in the menu.
create or replace function set_module(p_module text, p_is_active boolean, p_label text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not can_manage_access() then
    raise exception 'Only the Admin or Business Head can change modules';
  end if;
  update app_modules
     set is_active = p_is_active, label = coalesce(nullif(trim(p_label), ''), label), updated_at = now()
   where key = p_module;
  if not found then raise exception 'Unknown module %', p_module; end if;
  perform access_log('module', jsonb_build_object('module', p_module, 'is_active', p_is_active, 'label', p_label));
end;
$$;

-- What one employee ends up with, and why (role / grant / revoke), for the Access Studio.
create or replace function employee_effective_rights(p_employee_id uuid)
returns table (module_key text, "right" text, allowed boolean, source text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role uuid;
  v_rank int;
begin
  if not can_manage_access() and p_employee_id is distinct from current_employee_id() then
    raise exception 'Only the Admin or Business Head can see other people''s access';
  end if;
  select e.role_id, r.rank into v_role, v_rank from employees e left join roles r on r.id = e.role_id where e.id = p_employee_id;
  return query
  select m.key, x.r,
         case when v_rank = 0 then true
              when o.effect = 'revoke' then false
              when o.effect = 'grant' then true
              else rr.role_id is not null end,
         case when v_rank = 0 then 'admin'
              when o.effect is not null then o.effect
              when rr.role_id is not null then 'role'
              else 'none' end
  from app_modules m
  cross join (values ('view'), ('create'), ('edit'), ('approve'), ('delete')) x(r)
  left join employee_module_overrides o on o.employee_id = p_employee_id and o.module_key = m.key and o."right" = x.r
  left join role_module_rights rr on rr.role_id = v_role and rr.module_key = m.key and rr."right" = x.r
  order by m.group_key, m.sort_order, m.key, x.r;
end;
$$;

revoke execute on function access_log(text, jsonb) from public, anon, authenticated;
revoke execute on function has_role(text) from public, anon;
revoke execute on function can_manage_access() from public, anon;
revoke execute on function has_right(text, text) from public, anon;
revoke execute on function my_rights() from public, anon;
revoke execute on function set_role_right(uuid, text, text, boolean) from public, anon;
revoke execute on function set_employee_override(uuid, text, text, text, text) from public, anon;
revoke execute on function set_module(text, boolean, text) from public, anon;
revoke execute on function employee_effective_rights(uuid) from public, anon;
grant execute on function has_role(text) to authenticated;
grant execute on function can_manage_access() to authenticated;
grant execute on function has_right(text, text) to authenticated;
grant execute on function my_rights() to authenticated;
grant execute on function set_role_right(uuid, text, text, boolean) to authenticated;
grant execute on function set_employee_override(uuid, text, text, text, text) to authenticated;
grant execute on function set_module(text, boolean, text) to authenticated;
grant execute on function employee_effective_rights(uuid) to authenticated;

-- ===== Seed: the menu as it is today =====
insert into menu_groups (key, title, sort_order) values
  ('sales', 'Sales', 10),
  ('crm', 'CRM', 15),
  ('stock', 'Stock', 20),
  ('ops', 'Ops & Delivery', 25),
  ('people', 'People', 30),
  ('reporting', 'Reporting', 40),
  ('masters', 'Masters', 50),
  ('admin', 'Admin', 60);

insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('enquiries',          'sales',     'Enquiries',            '/enquiries',            10, true),
  ('enquiries_new',      'sales',     'New Enquiry',          '/enquiries/new',        20, true),
  ('crm_sync',           'sales',     'CTDMS Sync',           '/crm-sync',             30, true),
  ('finance_cases',      'sales',     'Finance Cases',        '/finance',              40, true),
  ('stock_free',         'stock',     'Free Stock',           '/stock',                10, true),
  ('stock_pool',         'stock',     'Allotment Pool',       '/stock/pool',           20, true),
  ('stock_pool_config',  'stock',     'Pool Settings',        '/stock/pool/config',    25, false),
  ('stock_finance_queue','stock',     'Finance Queue',        '/stock/finance-queue',  30, true),
  ('stock_vna',          'stock',     'VNA Demand',           '/stock/vna',            40, true),
  ('stock_match',        'stock',     'Match & Allot',        '/stock/match',          50, true),
  ('stock_allotted',     'stock',     'Allotted',             '/stock/allotted',       60, true),
  ('stock_billing',      'stock',     'Billing',              '/stock/billing',        70, true),
  ('payments',           'stock',     'Payments',             '/payments',             80, true),
  ('cancellations',      'stock',     'Hold & Cancellations', '/cancellations',        90, true),
  ('stock_ctdms',        'stock',     'CTDMS To-do',          '/stock/ctdms',         100, true),
  ('stock_import',       'stock',     'Import Stock',         '/stock/import',        110, true),
  ('hr',                 'people',    'Employees',            '/hr',                   10, true),
  ('hr_new',             'people',    'Add Employee',         '/hr/new',               20, true),
  ('pipeline',           'reporting', 'Pipeline',             '/',                     10, true),
  ('rpt_consultants',    'reporting', 'Consultants',          '/reports/consultants',  20, true),
  ('rpt_sources',        'reporting', 'Sources & Reasons',    '/reports/sources',      30, true),
  ('rpt_stock_ageing',   'reporting', 'Stock Ageing',         '/reports/stock-ageing', 40, true),
  ('rpt_quotes',         'reporting', 'Quotes',               '/reports/quotes',       50, true),
  ('rpt_bookings',       'reporting', 'Bookings',             '/reports/bookings',     60, true),
  ('rpt_approvals',      'reporting', 'Approvals',            '/reports/approvals',    70, true),
  ('rpt_margin',         'reporting', 'Margin Summary',       '/reports/margin',       80, true),
  ('masters',            'masters',   'Master Data',          null,                    10, false),
  ('access_studio',      'admin',     'Access Studio',        '/admin/access',         10, true);

-- ===== Seed: role rights that match what each role can already do =====
-- (role name, module, rights) — Admin needs none: rank 0 has everything.
with grants(role_name, module_key, rights) as (values
  -- Business Head: everything.
  ('Business Head', '*', array['view','create','edit','approve','delete']),
  -- Outlet Head: runs the branch.
  ('Outlet Head', 'enquiries', array['view','create','edit']), ('Outlet Head', 'enquiries_new', array['view','create']),
  ('Outlet Head', 'crm_sync', array['view','create','edit']), ('Outlet Head', 'finance_cases', array['view','edit']),
  ('Outlet Head', 'stock_free', array['view']), ('Outlet Head', 'stock_pool', array['view','edit','approve']),
  ('Outlet Head', 'stock_finance_queue', array['view','approve']), ('Outlet Head', 'stock_vna', array['view']),
  ('Outlet Head', 'stock_match', array['view','create']), ('Outlet Head', 'stock_allotted', array['view','edit']),
  ('Outlet Head', 'stock_billing', array['view']), ('Outlet Head', 'payments', array['view']),
  ('Outlet Head', 'cancellations', array['view','approve']), ('Outlet Head', 'stock_ctdms', array['view','edit']),
  ('Outlet Head', 'stock_import', array['view','create']), ('Outlet Head', 'hr', array['view']),
  ('Outlet Head', 'pipeline', array['view']), ('Outlet Head', 'rpt_consultants', array['view']),
  ('Outlet Head', 'rpt_sources', array['view']), ('Outlet Head', 'rpt_stock_ageing', array['view']),
  ('Outlet Head', 'rpt_quotes', array['view']), ('Outlet Head', 'rpt_bookings', array['view','edit']),
  ('Outlet Head', 'rpt_approvals', array['view','approve']), ('Outlet Head', 'rpt_margin', array['view']),
  ('Outlet Head', 'masters', array['view']),
  -- Head Customer Relations: CRM back office.
  ('Head Customer Relations', 'enquiries', array['view','create','edit']), ('Head Customer Relations', 'enquiries_new', array['view','create']),
  ('Head Customer Relations', 'crm_sync', array['view','create','edit']), ('Head Customer Relations', 'finance_cases', array['view']),
  ('Head Customer Relations', 'stock_free', array['view']), ('Head Customer Relations', 'stock_pool', array['view']),
  ('Head Customer Relations', 'stock_finance_queue', array['view']), ('Head Customer Relations', 'stock_vna', array['view']),
  ('Head Customer Relations', 'stock_allotted', array['view']), ('Head Customer Relations', 'payments', array['view']),
  ('Head Customer Relations', 'cancellations', array['view']), ('Head Customer Relations', 'pipeline', array['view']),
  ('Head Customer Relations', 'rpt_consultants', array['view']), ('Head Customer Relations', 'rpt_sources', array['view']),
  ('Head Customer Relations', 'rpt_quotes', array['view']), ('Head Customer Relations', 'rpt_bookings', array['view','edit']),
  ('Head Customer Relations', 'rpt_approvals', array['view','approve']),
  -- Team Leader and Sales Consultant: their own line.
  ('Team Leader', 'enquiries', array['view','create','edit']), ('Team Leader', 'enquiries_new', array['view','create']),
  ('Team Leader', 'finance_cases', array['view']), ('Team Leader', 'stock_free', array['view']),
  ('Team Leader', 'stock_pool', array['view']), ('Team Leader', 'stock_vna', array['view']),
  ('Team Leader', 'pipeline', array['view']), ('Team Leader', 'rpt_consultants', array['view']),
  ('Team Leader', 'rpt_quotes', array['view']), ('Team Leader', 'rpt_bookings', array['view']),
  ('Team Leader', 'rpt_approvals', array['view','approve']),
  ('Sales Consultant', 'enquiries', array['view','create','edit']), ('Sales Consultant', 'enquiries_new', array['view','create']),
  ('Sales Consultant', 'stock_free', array['view']), ('Sales Consultant', 'pipeline', array['view']),
  ('Sales Consultant', 'rpt_quotes', array['view']), ('Sales Consultant', 'rpt_bookings', array['view']),
  -- Accounts: invoices, receipts, refunds.
  ('Accounts', 'stock_allotted', array['view']), ('Accounts', 'stock_billing', array['view','edit']),
  ('Accounts', 'payments', array['view','edit']), ('Accounts', 'cancellations', array['view','edit']),
  ('Accounts', 'rpt_bookings', array['view','edit']), ('Accounts', 'rpt_stock_ageing', array['view']),
  -- Finance Executive: loan cases.
  ('Finance Executive', 'finance_cases', array['view','edit']), ('Finance Executive', 'stock_finance_queue', array['view']),
  ('Finance Executive', 'rpt_bookings', array['view']),
  -- HR: staff.
  ('HR', 'hr', array['view','create','edit']), ('HR', 'hr_new', array['view','create'])
)
insert into role_module_rights (role_id, module_key, "right")
select r.id, m.key, x
from grants g
join roles r on r.name = g.role_name
join app_modules m on (g.module_key = '*' or m.key = g.module_key)
cross join unnest(g.rights) x
on conflict do nothing;

-- ===== Seeding helpers for later phases =====
-- The Business Head gets every right on every module, including ones later phases add.
create or replace function app_modules_grant_business_head()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into role_module_rights (role_id, module_key, "right")
  select r.id, NEW.key, x from roles r cross join unnest(array['view','create','edit','approve','delete']) x
  where r.name = 'Business Head'
  on conflict do nothing;
  return NEW;
end;
$$;
create trigger trg_app_modules_business_head after insert on app_modules
  for each row execute function app_modules_grant_business_head();

-- Migrations use this to give a role rights on a module by name.
create or replace function seed_role_rights(p_role_name text, p_module text, p_rights text[])
returns void
language sql
security definer
set search_path = public
as $$
  insert into role_module_rights (role_id, module_key, "right")
  select r.id, p_module, x from roles r cross join unnest(p_rights) x where r.name = p_role_name
  on conflict do nothing;
$$;
revoke execute on function app_modules_grant_business_head() from public, anon, authenticated;
revoke execute on function seed_role_rights(text, text, text[]) from public, anon, authenticated;
