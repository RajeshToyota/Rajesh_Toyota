-- Outlets, roles, employees, and the self-referencing manager hierarchy.

create table outlets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  dealer_code text,
  city text,
  state text,
  address text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_outlets_updated_at
  before update on outlets
  for each row execute function set_updated_at();

-- rank: lower = more senior. Used for approval routing & RLS scope decisions.
create table roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  rank int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_roles_updated_at
  before update on roles
  for each row execute function set_updated_at();

create table employees (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users(id),
  name text not null,
  phone text,
  email text,
  role_id uuid references roles(id),
  outlet_id uuid references outlets(id),
  reports_to_employee_id uuid references employees(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_employees_auth_user_id on employees(auth_user_id);
create index idx_employees_reports_to on employees(reports_to_employee_id);
create index idx_employees_outlet_id on employees(outlet_id);
create index idx_employees_role_id on employees(role_id);

create trigger trg_employees_updated_at
  before update on employees
  for each row execute function set_updated_at();

-- Helper: the employee row for the currently authenticated user. Used throughout RLS policies.
create or replace function current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from employees where auth_user_id = auth.uid() and is_active limit 1;
$$;

-- Helper: recursively walk reports_to_employee_id to decide whether `viewer` can see `target`'s data.
-- A viewer can access target if: viewer == target, or target reports (directly/transitively) to viewer,
-- or viewer's role has org-wide scope (rank <= 1, i.e. Business Head / Admin) and target shares no
-- outlet restriction, or viewer is an Outlet Head (or more senior) at the same outlet as target.
create or replace function can_access_employee_data(viewer_employee_id uuid, target_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  viewer_rank int;
  viewer_outlet uuid;
  target_outlet uuid;
  is_in_chain boolean;
begin
  if viewer_employee_id is null or target_employee_id is null then
    return false;
  end if;

  if viewer_employee_id = target_employee_id then
    return true;
  end if;

  select r.rank, e.outlet_id into viewer_rank, viewer_outlet
  from employees e join roles r on r.id = e.role_id
  where e.id = viewer_employee_id;

  select outlet_id into target_outlet from employees where id = target_employee_id;

  if viewer_rank is null then
    return false;
  end if;

  -- Business Head / Admin: org-wide read access.
  if viewer_rank <= 1 then
    return true;
  end if;

  -- Outlet Head (or more senior, excluding org-wide already handled above): same-outlet access.
  if viewer_rank <= 2 and viewer_outlet is not null and viewer_outlet = target_outlet then
    return true;
  end if;

  -- Otherwise: is target in viewer's downline (recursive walk up target's manager chain)?
  with recursive chain as (
    select id, reports_to_employee_id from employees where id = target_employee_id
    union all
    select e.id, e.reports_to_employee_id
    from employees e
    join chain c on e.id = c.reports_to_employee_id
  )
  select exists(select 1 from chain where reports_to_employee_id = viewer_employee_id or id = viewer_employee_id and id <> target_employee_id)
  into is_in_chain;

  return coalesce(is_in_chain, false);
end;
$$;
