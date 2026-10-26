-- Phase 14: employee management.
--   - A new HR role (recognised by name, like Accounts) manages staff at every branch; the Business
--     Head and Admin can do the same. Outlet Heads see their branch's staff but cannot change them.
--   - The employee record gains code, designation, department, dates, emergency contact and exit details.
--   - Sensitive data (PAN, Aadhaar, bank account) and ID copies are kept apart: only HR, the Business
--     Head / Admin and the employee themselves can read them.
--   - Onboarding and offboarding checklists come from editable templates; some items tick themselves
--     (login linked, work handed over, assets returned).
--   - Company assets (laptop, phone, SIM, ID card, uniform...) are issued and returned against the employee.
--   - Offboarding hands open enquiries, quotes and bookings to a named colleague, moves direct reports to
--     the leaver's manager and closes the login (an inactive employee can see nothing).
--   - Logins: the dashboard invites the employee by email (server side, service key); a user created by
--     hand in Supabase Auth is linked to the employee with the same confirmed email.
-- HR can never create, promote or edit a Business Head or Admin, or change their own role or login.

-- ===== HR role =====
-- Rank 6 keeps HR below every approval and hierarchy check, so it sees no bookings or quotes.
insert into roles (id, name, rank) values ('00000000-0000-0000-0001-000000000009', 'HR', 6)
on conflict (id) do nothing;

create or replace function is_hr()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from employees e join roles r on r.id = e.role_id
    where e.id = current_employee_id() and r.name = 'HR' and e.is_active
  );
$$;

-- HR, Business Head or Admin.
create or replace function can_manage_hr()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_employee_role_rank() <= 1, false) or is_hr();
$$;

-- ===== Employee record =====
alter table employees
  add column employee_code text,
  add column designation text,
  add column department text check (department in
    ('sales', 'customer_relations', 'accounts', 'finance', 'insurance_rto', 'workshop', 'hr_admin', 'management', 'other')),
  add column date_of_birth date,
  add column joining_date date,
  add column emergency_contact_name text,
  add column emergency_contact_phone text,
  add column exit_date date,
  add column exit_reason text,
  add column exited_by_employee_id uuid references employees(id),
  add column login_invited_at timestamptz;
create unique index employees_employee_code_key on employees (upper(employee_code)) where employee_code is not null;
create unique index employees_active_email_key on employees (lower(email)) where email is not null and is_active;
create index idx_employees_exited_by on employees(exited_by_employee_id);

create policy employees_select_hr on employees for select to authenticated using (is_hr());

-- HR may not hand out or touch the top roles, or change its own role, status or login.
create or replace function employees_hr_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := current_employee_id();
  v_new_rank int;
  v_old_rank int;
begin
  -- Migrations and the service key run without an employee; the auth link trigger says so itself.
  if v_actor is null or coalesce(current_employee_role_rank() <= 1, false)
     or coalesce(current_setting('rt.login_link', true), '') = 'on' then
    return NEW;
  end if;
  if TG_OP = 'UPDATE' then
    select rank into v_old_rank from roles where id = OLD.role_id;
    if coalesce(v_old_rank, 99) <= 1 then
      raise exception 'Only the Business Head or Admin can change a Business Head or Admin';
    end if;
  end if;
  select rank into v_new_rank from roles where id = NEW.role_id;
  if coalesce(v_new_rank, 99) <= 1 then
    raise exception 'Only the Business Head or Admin can give someone a Business Head or Admin role';
  end if;
  if TG_OP = 'UPDATE' then
    if OLD.id = v_actor and (NEW.role_id, NEW.is_active, NEW.outlet_id) is distinct from (OLD.role_id, OLD.is_active, OLD.outlet_id) then
      raise exception 'You cannot change your own role, branch or status';
    end if;
    if NEW.auth_user_id is distinct from OLD.auth_user_id then
      raise exception 'Logins are linked by the invitation, not by hand';
    end if;
  elsif NEW.auth_user_id is not null then
    raise exception 'Logins are linked by the invitation, not by hand';
  end if;
  return NEW;
end;
$$;
create trigger trg_employees_hr_guard before insert or update on employees
  for each row execute function employees_hr_guard();

-- ===== Sensitive personal data =====
create table employee_private (
  employee_id uuid primary key references employees(id),
  pan text check (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  -- Only the last four digits; the full number stays on the uploaded copy.
  aadhaar_last4 text check (aadhaar_last4 ~ '^[0-9]{4}$'),
  bank_account_name text,
  bank_account_no text check (bank_account_no ~ '^[0-9]{6,18}$'),
  bank_ifsc text check (bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_name text,
  personal_email text,
  current_address text,
  permanent_address text,
  updated_by_employee_id uuid references employees(id) default current_employee_id(),
  updated_at timestamptz not null default now()
);
create index idx_employee_private_updated_by on employee_private(updated_by_employee_id);
create trigger trg_employee_private_updated_at before update on employee_private for each row execute function set_updated_at();
alter table employee_private enable row level security;
create policy employee_private_select on employee_private for select to authenticated
  using (can_manage_hr() or employee_id = current_employee_id());
-- Written only through save_employee_private().

create table employee_documents (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  kind text not null check (kind in
    ('photo', 'pan', 'aadhaar', 'bank_proof', 'resume', 'education', 'offer_letter', 'appointment_letter',
     'previous_relieving', 'relieving_letter', 'other')),
  storage_path text not null unique,
  note text,
  uploaded_by_employee_id uuid references employees(id) default current_employee_id(),
  uploaded_at timestamptz not null default now()
);
create index idx_employee_documents_employee on employee_documents(employee_id);
create index idx_employee_documents_uploaded_by on employee_documents(uploaded_by_employee_id);
alter table employee_documents enable row level security;
create policy employee_documents_select on employee_documents for select to authenticated
  using (can_manage_hr() or employee_id = current_employee_id());
create policy employee_documents_insert on employee_documents for insert to authenticated
  with check (can_manage_hr() and storage_booking_id(storage_path) = employee_id);
create policy employee_documents_delete on employee_documents for delete to authenticated using (can_manage_hr());

-- Objects live at `<employee_id>/...` (storage_booking_id() just reads the leading uuid folder).
insert into storage.buckets (id, name, public)
values ('employee-documents', 'employee-documents', false)
on conflict (id) do nothing;

create policy employee_documents_obj_select on storage.objects for select to authenticated using (
  bucket_id = 'employee-documents' and (can_manage_hr() or storage_booking_id(name) = current_employee_id())
);
create policy employee_documents_obj_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'employee-documents' and can_manage_hr() and storage_booking_id(name) is not null
);
create policy employee_documents_obj_update on storage.objects for update to authenticated using (
  bucket_id = 'employee-documents' and can_manage_hr()
);
create policy employee_documents_obj_delete on storage.objects for delete to authenticated using (
  bucket_id = 'employee-documents' and can_manage_hr()
);

-- ===== Checklists =====
create table hr_task_templates (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('onboarding', 'offboarding')),
  title text not null,
  sort_order int not null default 0,
  -- Only for the sales line (Outlet Head to Sales Consultant), e.g. the CTDMS ID.
  sales_staff_only boolean not null default false,
  -- Ticked by the system: crm_login (login linked), handover (offboarding hand-over done),
  -- crm_login_off (login closed), assets_returned (nothing left with the employee).
  auto_key text check (auto_key in ('crm_login', 'handover', 'crm_login_off', 'assets_returned')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_hr_task_templates_updated_at before update on hr_task_templates for each row execute function set_updated_at();
alter table hr_task_templates enable row level security;
create policy hr_task_templates_select on hr_task_templates for select to authenticated using (true);
create policy hr_task_templates_insert on hr_task_templates for insert to authenticated with check (can_manage_hr());
create policy hr_task_templates_update on hr_task_templates for update to authenticated using (can_manage_hr()) with check (can_manage_hr());

insert into hr_task_templates (kind, title, sort_order, sales_staff_only, auto_key) values
  ('onboarding', 'Documents collected (photo, PAN, Aadhaar, bank proof, résumé)', 10, false, null),
  ('onboarding', 'Offer / appointment letter signed', 20, false, null),
  ('onboarding', 'Bank details recorded for salary', 30, false, null),
  ('onboarding', 'CRM login created', 40, false, 'crm_login'),
  ('onboarding', 'CTDMS ID created', 50, true, null),
  ('onboarding', 'SIM card issued', 60, false, null),
  ('onboarding', 'Laptop / phone issued (if applicable)', 70, false, null),
  ('onboarding', 'ID card and uniform issued', 80, false, null),
  ('onboarding', 'Induction and product training done', 90, false, null),
  ('offboarding', 'Open enquiries, quotes and bookings handed over', 10, false, 'handover'),
  ('offboarding', 'CRM login closed', 20, false, 'crm_login_off'),
  ('offboarding', 'All company assets returned', 30, false, 'assets_returned'),
  ('offboarding', 'CTDMS ID deactivated', 40, true, null),
  ('offboarding', 'Full and final settlement done', 50, false, null),
  ('offboarding', 'Relieving / experience letter issued', 60, false, null);

create table employee_tasks (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  template_id uuid references hr_task_templates(id),
  kind text not null check (kind in ('onboarding', 'offboarding')),
  title text not null,
  sort_order int not null default 0,
  auto_key text,
  status text not null default 'pending' check (status in ('pending', 'done', 'not_applicable')),
  note text,
  done_by_employee_id uuid references employees(id),
  done_at timestamptz,
  created_at timestamptz not null default now(),
  unique (employee_id, template_id)
);
create index idx_employee_tasks_employee on employee_tasks(employee_id, kind, sort_order);
create index idx_employee_tasks_template on employee_tasks(template_id);
create index idx_employee_tasks_done_by on employee_tasks(done_by_employee_id);
alter table employee_tasks enable row level security;
create policy employee_tasks_select on employee_tasks for select to authenticated
  using (can_manage_hr() or can_access_employee_data(current_employee_id(), employee_id));

-- ===== Company assets =====
create table employee_assets (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  asset_type text not null check (asset_type in
    ('laptop', 'mobile_phone', 'sim_card', 'tablet', 'id_card', 'uniform', 'vehicle', 'other')),
  description text,
  serial_no text,
  issued_on date not null default current_date,
  issued_by_employee_id uuid references employees(id) default current_employee_id(),
  returned_on date,
  return_condition text,
  returned_to_employee_id uuid references employees(id),
  note text,
  created_at timestamptz not null default now(),
  check (returned_on is null or returned_on >= issued_on)
);
create index idx_employee_assets_employee on employee_assets(employee_id) where returned_on is null;
create index idx_employee_assets_employee_all on employee_assets(employee_id);
create index idx_employee_assets_issued_by on employee_assets(issued_by_employee_id);
create index idx_employee_assets_returned_to on employee_assets(returned_to_employee_id);
alter table employee_assets enable row level security;
create policy employee_assets_select on employee_assets for select to authenticated
  using (can_manage_hr() or can_access_employee_data(current_employee_id(), employee_id));

-- ===== Helpers =====
create or replace function hr_require_manager()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not can_manage_hr() then
    raise exception 'Only HR or the Business Head can manage employees';
  end if;
end;
$$;

create or replace function hr_tick_auto(p_employee_id uuid, p_auto_key text)
returns void
language sql
security definer
set search_path = public
as $$
  update employee_tasks set status = 'done', done_at = now(), done_by_employee_id = current_employee_id()
  where employee_id = p_employee_id and auto_key = p_auto_key and status = 'pending';
$$;

-- Adds the missing checklist items for an employee from the active templates; returns how many.
create or replace function start_employee_checklist(p_employee_id uuid, p_kind text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rank int;
  v_count int;
begin
  perform hr_require_manager();
  if p_kind not in ('onboarding', 'offboarding') then
    raise exception 'Unknown checklist %', p_kind;
  end if;
  select r.rank into v_rank from employees e left join roles r on r.id = e.role_id where e.id = p_employee_id;
  if not found then
    raise exception 'Employee not found';
  end if;
  insert into employee_tasks (employee_id, template_id, kind, title, sort_order, auto_key)
  select p_employee_id, t.id, t.kind, t.title, t.sort_order, t.auto_key
  from hr_task_templates t
  where t.kind = p_kind and t.is_active
    and (not t.sales_staff_only or coalesce(v_rank between 2 and 5, false))
  on conflict (employee_id, template_id) do nothing;
  get diagnostics v_count = row_count;

  -- Items already true when the checklist starts.
  if p_kind = 'onboarding' and exists (select 1 from employees where id = p_employee_id and auth_user_id is not null) then
    perform hr_tick_auto(p_employee_id, 'crm_login');
  end if;
  return v_count;
end;
$$;

-- ===== Create / edit an employee =====
-- p: name, phone, email, role_id, outlet_id, reports_to_employee_id, employee_code, designation, department,
-- date_of_birth, joining_date, emergency_contact_name, emergency_contact_phone, ctdms_name.
-- A new employee starts with the onboarding checklist. Returns the employee id.
create or replace function save_employee(p_employee_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := p_employee_id;
  v_name text := nullif(btrim(p->>'name'), '');
  v_phone text := nullif(btrim(coalesce(p->>'phone', '')), '');
  v_email text := lower(nullif(btrim(coalesce(p->>'email', '')), ''));
  v_emergency text := nullif(btrim(coalesce(p->>'emergency_contact_phone', '')), '');
  v_role uuid := nullif(p->>'role_id', '')::uuid;
  v_outlet uuid := nullif(p->>'outlet_id', '')::uuid;
  v_manager uuid := nullif(p->>'reports_to_employee_id', '')::uuid;
begin
  perform hr_require_manager();
  if v_name is null then
    raise exception 'Give the employee''s name';
  end if;
  if v_role is null or not exists (select 1 from roles where id = v_role) then
    raise exception 'Choose a role';
  end if;
  if v_phone is not null then
    v_phone := normalize_mobile(v_phone);
    if v_phone is null then
      raise exception 'The mobile number should be 10 digits starting 6-9';
    end if;
  end if;
  if v_emergency is not null then
    v_emergency := normalize_mobile(v_emergency);
    if v_emergency is null then
      raise exception 'The emergency contact number should be 10 digits starting 6-9';
    end if;
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'The email address does not look right';
  end if;
  if v_email is not null and exists (
    select 1 from employees where lower(email) = v_email and is_active and id is distinct from v_id
  ) then
    raise exception 'Another active employee already has the email %', v_email;
  end if;
  if v_manager is not null then
    if v_manager = v_id then
      raise exception 'An employee cannot report to themselves';
    end if;
    if not exists (select 1 from employees where id = v_manager and is_active) then
      raise exception 'The manager must be an active employee';
    end if;
    if v_id is not null and exists (
      with recursive chain as (
        select id, reports_to_employee_id from employees where id = v_manager
        union
        select e.id, e.reports_to_employee_id from employees e join chain c on e.id = c.reports_to_employee_id
      )
      select 1 from chain where id = v_id
    ) then
      raise exception 'That manager reports (directly or not) to this employee';
    end if;
  end if;

  if v_id is null then
    insert into employees (name, phone, email, role_id, outlet_id, reports_to_employee_id, employee_code, designation,
                           department, date_of_birth, joining_date, emergency_contact_name, emergency_contact_phone, ctdms_name)
    values (v_name, v_phone, v_email, v_role, v_outlet, v_manager, nullif(btrim(coalesce(p->>'employee_code', '')), ''),
            nullif(btrim(coalesce(p->>'designation', '')), ''), nullif(p->>'department', ''),
            nullif(p->>'date_of_birth', '')::date, nullif(p->>'joining_date', '')::date,
            nullif(btrim(coalesce(p->>'emergency_contact_name', '')), ''), v_emergency,
            nullif(btrim(coalesce(p->>'ctdms_name', '')), ''))
    returning id into v_id;
    perform start_employee_checklist(v_id, 'onboarding');
  else
    if not exists (select 1 from employees where id = v_id) then
      raise exception 'Employee not found';
    end if;
    -- A login is tied to its email: change it only before the login exists.
    if exists (select 1 from employees where id = v_id and auth_user_id is not null and lower(coalesce(email, '')) is distinct from coalesce(v_email, '')) then
      raise exception 'This employee already has a login; their email cannot be changed here';
    end if;
    update employees set
      name = v_name, phone = v_phone, email = v_email, role_id = v_role, outlet_id = v_outlet,
      reports_to_employee_id = v_manager,
      employee_code = nullif(btrim(coalesce(p->>'employee_code', '')), ''),
      designation = nullif(btrim(coalesce(p->>'designation', '')), ''),
      department = nullif(p->>'department', ''),
      date_of_birth = nullif(p->>'date_of_birth', '')::date,
      joining_date = nullif(p->>'joining_date', '')::date,
      emergency_contact_name = nullif(btrim(coalesce(p->>'emergency_contact_name', '')), ''),
      emergency_contact_phone = v_emergency,
      ctdms_name = nullif(btrim(coalesce(p->>'ctdms_name', '')), '')
    where id = v_id;
  end if;
  return v_id;
end;
$$;

-- p: pan, aadhaar_last4, bank_account_name, bank_account_no, bank_ifsc, bank_name, personal_email,
-- current_address, permanent_address. Blank clears a field.
create or replace function save_employee_private(p_employee_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pan text := upper(nullif(regexp_replace(coalesce(p->>'pan', ''), '\s', '', 'g'), ''));
  v_aadhaar text := nullif(regexp_replace(coalesce(p->>'aadhaar_last4', ''), '\D', '', 'g'), '');
  v_account text := nullif(regexp_replace(coalesce(p->>'bank_account_no', ''), '\s', '', 'g'), '');
  v_ifsc text := upper(nullif(regexp_replace(coalesce(p->>'bank_ifsc', ''), '\s', '', 'g'), ''));
begin
  perform hr_require_manager();
  if not exists (select 1 from employees where id = p_employee_id) then
    raise exception 'Employee not found';
  end if;
  if v_pan is not null and v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then
    raise exception 'The PAN should look like ABCDE1234F';
  end if;
  if v_aadhaar is not null and length(v_aadhaar) <> 4 then
    raise exception 'Enter only the last 4 digits of the Aadhaar number';
  end if;
  if v_account is not null and v_account !~ '^[0-9]{6,18}$' then
    raise exception 'The bank account number should be 6-18 digits';
  end if;
  if v_ifsc is not null and v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
    raise exception 'The IFSC should look like HDFC0001234';
  end if;
  insert into employee_private as ep (employee_id, pan, aadhaar_last4, bank_account_name, bank_account_no, bank_ifsc, bank_name,
                                      personal_email, current_address, permanent_address)
  values (p_employee_id, v_pan, v_aadhaar, nullif(btrim(coalesce(p->>'bank_account_name', '')), ''), v_account, v_ifsc,
          nullif(btrim(coalesce(p->>'bank_name', '')), ''), lower(nullif(btrim(coalesce(p->>'personal_email', '')), '')),
          nullif(btrim(coalesce(p->>'current_address', '')), ''), nullif(btrim(coalesce(p->>'permanent_address', '')), ''))
  on conflict (employee_id) do update set
    pan = excluded.pan, aadhaar_last4 = excluded.aadhaar_last4, bank_account_name = excluded.bank_account_name,
    bank_account_no = excluded.bank_account_no, bank_ifsc = excluded.bank_ifsc, bank_name = excluded.bank_name,
    personal_email = excluded.personal_email, current_address = excluded.current_address,
    permanent_address = excluded.permanent_address, updated_by_employee_id = current_employee_id();
end;
$$;

create or replace function set_employee_task(p_task_id uuid, p_status text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform hr_require_manager();
  if p_status not in ('pending', 'done', 'not_applicable') then
    raise exception 'Unknown status %', p_status;
  end if;
  update employee_tasks set
    status = p_status,
    note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note),
    done_at = case when p_status = 'pending' then null else now() end,
    done_by_employee_id = case when p_status = 'pending' then null else current_employee_id() end
  where id = p_task_id;
  if not found then
    raise exception 'Checklist item not found';
  end if;
end;
$$;

-- ===== Assets =====
create or replace function issue_asset(p_employee_id uuid, p_asset_type text, p_description text default null,
                                       p_serial_no text default null, p_issued_on date default null, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform hr_require_manager();
  if not exists (select 1 from employees where id = p_employee_id and is_active) then
    raise exception 'Assets can be issued only to an active employee';
  end if;
  if nullif(btrim(coalesce(p_serial_no, '')), '') is not null and exists (
    select 1 from employee_assets
    where returned_on is null and asset_type = p_asset_type and upper(serial_no) = upper(btrim(p_serial_no))
  ) then
    raise exception 'That % (%) is already with someone; record its return first', replace(p_asset_type, '_', ' '), btrim(p_serial_no);
  end if;
  insert into employee_assets (employee_id, asset_type, description, serial_no, issued_on, note)
  values (p_employee_id, p_asset_type, nullif(btrim(coalesce(p_description, '')), ''), nullif(btrim(coalesce(p_serial_no, '')), ''),
          coalesce(p_issued_on, current_date), nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function return_asset(p_asset_id uuid, p_returned_on date default null, p_condition text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a employee_assets;
begin
  perform hr_require_manager();
  select * into a from employee_assets where id = p_asset_id for update;
  if not found then
    raise exception 'Asset not found';
  end if;
  if a.returned_on is not null then
    raise exception 'This asset was already returned on %', to_char(a.returned_on, 'DD Mon YYYY');
  end if;
  if coalesce(p_returned_on, current_date) < a.issued_on then
    raise exception 'The return date is before the issue date';
  end if;
  update employee_assets set
    returned_on = coalesce(p_returned_on, current_date),
    return_condition = nullif(btrim(coalesce(p_condition, '')), ''),
    returned_to_employee_id = current_employee_id()
  where id = p_asset_id;
  if not exists (select 1 from employee_assets where employee_id = a.employee_id and returned_on is null) then
    perform hr_tick_auto(a.employee_id, 'assets_returned');
  end if;
end;
$$;

-- ===== Offboarding =====
-- What an employee still holds: open enquiries, unbooked quotes, open bookings, direct reports and assets.
create or replace function employee_handover(p_employee_id uuid)
returns table (open_enquiries int, open_quotes int, open_bookings int, direct_reports int, assets_out int)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform hr_require_manager();
  return query select
    (select count(*)::int from enquiries where assigned_employee_id = p_employee_id and stage in ('open', 'quoted')),
    (select count(*)::int from quotes q where q.employee_id = p_employee_id and q.status in ('draft', 'sent')
       and not exists (select 1 from bookings b where b.quote_id = q.id)),
    (select count(*)::int from bookings where employee_id = p_employee_id and status not in ('delivered', 'cancelled')),
    (select count(*)::int from employees where reports_to_employee_id = p_employee_id and is_active),
    (select count(*)::int from employee_assets where employee_id = p_employee_id and returned_on is null);
end;
$$;

-- Hands the open work to p_handover_to, moves direct reports to the leaver's own manager, records the
-- exit and closes the login. Assets still out stay on the offboarding checklist until returned.
create or replace function offboard_employee(p_employee_id uuid, p_exit_date date, p_reason text, p_handover_to uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e employees;
  v_rank int;
  h record;
  v_enq int;
  v_quotes int;
  v_bookings int;
  v_reports int;
begin
  perform hr_require_manager();
  select * into e from employees where id = p_employee_id for update;
  if not found then
    raise exception 'Employee not found';
  end if;
  if not e.is_active then
    raise exception '% has already left', e.name;
  end if;
  if e.id = current_employee_id() then
    raise exception 'You cannot offboard yourself';
  end if;
  select rank into v_rank from roles where id = e.role_id;
  if coalesce(v_rank, 99) <= 1 and not coalesce(current_employee_role_rank() <= 1, false) then
    raise exception 'Only the Business Head or Admin can offboard a Business Head or Admin';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Give the reason for leaving';
  end if;
  if p_exit_date is null then
    raise exception 'Give the last working day';
  end if;

  select * into h from employee_handover(p_employee_id);
  if h.open_enquiries + h.open_quotes + h.open_bookings > 0 then
    if p_handover_to is null then
      raise exception '% has % open enquiries, % quotes and % bookings: choose who takes them over',
        e.name, h.open_enquiries, h.open_quotes, h.open_bookings;
    end if;
    if p_handover_to = p_employee_id or not exists (select 1 from employees where id = p_handover_to and is_active) then
      raise exception 'Hand the work over to another active employee';
    end if;
  end if;

  update enquiries set assigned_employee_id = p_handover_to
  where assigned_employee_id = p_employee_id and stage in ('open', 'quoted');
  get diagnostics v_enq = row_count;
  update quotes q set employee_id = p_handover_to
  where q.employee_id = p_employee_id and q.status in ('draft', 'sent')
    and not exists (select 1 from bookings b where b.quote_id = q.id);
  get diagnostics v_quotes = row_count;
  update bookings set employee_id = p_handover_to
  where employee_id = p_employee_id and status not in ('delivered', 'cancelled');
  get diagnostics v_bookings = row_count;
  update employees set reports_to_employee_id = e.reports_to_employee_id
  where reports_to_employee_id = p_employee_id and is_active;
  get diagnostics v_reports = row_count;

  update employees set
    is_active = false, exit_date = p_exit_date, exit_reason = btrim(p_reason), exited_by_employee_id = current_employee_id()
  where id = p_employee_id;

  perform start_employee_checklist(p_employee_id, 'offboarding');
  perform hr_tick_auto(p_employee_id, 'handover');
  perform hr_tick_auto(p_employee_id, 'crm_login_off');
  if h.assets_out = 0 then
    perform hr_tick_auto(p_employee_id, 'assets_returned');
  end if;

  return jsonb_build_object('enquiries', v_enq, 'quotes', v_quotes, 'bookings', v_bookings,
                            'direct_reports', v_reports, 'assets_out', h.assets_out);
end;
$$;

-- ===== Logins =====
-- The dashboard records the invite (the invite itself goes out with the service key, server side).
create or replace function mark_login_invited(p_employee_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform hr_require_manager();
  update employees set login_invited_at = now() where id = p_employee_id and is_active;
  if not found then
    raise exception 'Only an active employee can be invited';
  end if;
end;
$$;

-- A user created by hand in Supabase Auth is linked to the one active employee with that email,
-- once the email is confirmed (so nobody can claim an employee by signing up with their address).
create or replace function link_employee_login()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.email is not null and NEW.email_confirmed_at is not null
     and not exists (select 1 from public.employees where auth_user_id = NEW.id) then
    perform set_config('rt.login_link', 'on', true);
    update public.employees set auth_user_id = NEW.id
    where auth_user_id is null and is_active and lower(email) = lower(NEW.email);
    perform set_config('rt.login_link', '', true);
  end if;
  return NEW;
end;
$$;
create trigger trg_auth_users_link_employee
  after insert or update of email, email_confirmed_at on auth.users
  for each row execute function link_employee_login();

-- Ticks "CRM login created" once a login is linked.
create or replace function employees_login_linked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.auth_user_id is not null and OLD.auth_user_id is null then
    perform hr_tick_auto(NEW.id, 'crm_login');
  end if;
  return NEW;
end;
$$;
create trigger trg_employees_login_linked after update of auth_user_id on employees
  for each row execute function employees_login_linked();

-- ===== Grants =====
revoke execute on function employees_hr_guard() from public, anon, authenticated;
revoke execute on function link_employee_login() from public, anon, authenticated;
revoke execute on function employees_login_linked() from public, anon, authenticated;
revoke execute on function hr_tick_auto(uuid, text) from public, anon, authenticated;
revoke execute on function hr_require_manager() from public, anon, authenticated;
revoke execute on function is_hr() from public, anon;
revoke execute on function can_manage_hr() from public, anon;
revoke execute on function start_employee_checklist(uuid, text) from public, anon;
revoke execute on function save_employee(uuid, jsonb) from public, anon;
revoke execute on function save_employee_private(uuid, jsonb) from public, anon;
revoke execute on function set_employee_task(uuid, text, text) from public, anon;
revoke execute on function issue_asset(uuid, text, text, text, date, text) from public, anon;
revoke execute on function return_asset(uuid, date, text) from public, anon;
revoke execute on function employee_handover(uuid) from public, anon;
revoke execute on function offboard_employee(uuid, date, text, uuid) from public, anon;
revoke execute on function mark_login_invited(uuid) from public, anon;
grant execute on function is_hr() to authenticated;
grant execute on function can_manage_hr() to authenticated;
grant execute on function start_employee_checklist(uuid, text) to authenticated;
grant execute on function save_employee(uuid, jsonb) to authenticated;
grant execute on function save_employee_private(uuid, jsonb) to authenticated;
grant execute on function set_employee_task(uuid, text, text) to authenticated;
grant execute on function issue_asset(uuid, text, text, text, date, text) to authenticated;
grant execute on function return_asset(uuid, date, text) to authenticated;
grant execute on function employee_handover(uuid) to authenticated;
grant execute on function offboard_employee(uuid, date, text, uuid) to authenticated;
grant execute on function mark_login_invited(uuid) to authenticated;
