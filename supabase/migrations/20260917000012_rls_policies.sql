-- Row Level Security: multi-outlet visibility + role-gated writes on master data.

-- Helper: rank of the currently authenticated employee's role (lower = more senior). Null if none.
create or replace function current_employee_role_rank()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select r.rank
  from employees e join roles r on r.id = e.role_id
  where e.auth_user_id = auth.uid() and e.is_active
  limit 1;
$$;

-- Admin or Business Head (rank <= 1) may write master/catalog data from the dashboard.
create or replace function is_master_data_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_employee_role_rank() <= 1, false);
$$;

-- ===== Master/catalog/pricing/scheme/RTO/insurance/accessory/VAS data =====
-- Read-only for any authenticated employee; writes restricted to Admin/Business Head.

do $$
declare
  t text;
begin
  for t in select unnest(array[
    'outlets', 'roles',
    'models', 'fuel_types', 'transmissions', 'variants', 'colors', 'variant_colors', 'price_list',
    'schemes', 'scheme_line_items', 'scheme_conditions',
    'rto_categories', 'rto_pricing',
    'insurance_providers', 'insurance_plans', 'insurance_addons', 'idv_slabs',
    'accessories', 'vas_products',
    'tax_config',
    'approval_rules'
  ])
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I_select on %I for select to authenticated using (true)', t, t);
    execute format('create policy %I_write on %I for all to authenticated using (is_master_data_admin()) with check (is_master_data_admin())', t, t);
  end loop;
end $$;

-- ===== employees =====

alter table employees enable row level security;

create policy employees_select on employees
  for select to authenticated
  using (can_access_employee_data(current_employee_id(), id));

create policy employees_write on employees
  for all to authenticated
  using (is_master_data_admin())
  with check (is_master_data_admin());

-- ===== scrap_certificates =====
-- Linked to a quote or booking; visibility follows the linked record's employee via the same rule.

alter table scrap_certificates enable row level security;

create policy scrap_certificates_select on scrap_certificates
  for select to authenticated
  using (
    linked_quote_id is null and linked_booking_id is null
    or exists (select 1 from quotes q where q.id = linked_quote_id and can_access_employee_data(current_employee_id(), q.employee_id))
    or exists (select 1 from bookings b where b.id = linked_booking_id and can_access_employee_data(current_employee_id(), b.employee_id))
  );

create policy scrap_certificates_insert on scrap_certificates
  for insert to authenticated
  with check (true);

create policy scrap_certificates_update on scrap_certificates
  for update to authenticated
  using (
    exists (select 1 from quotes q where q.id = linked_quote_id and can_access_employee_data(current_employee_id(), q.employee_id))
    or exists (select 1 from bookings b where b.id = linked_booking_id and can_access_employee_data(current_employee_id(), b.employee_id))
    or (linked_quote_id is null and linked_booking_id is null)
  );

-- ===== quotes =====

alter table quotes enable row level security;

create policy quotes_select on quotes
  for select to authenticated
  using (can_access_employee_data(current_employee_id(), employee_id));

create policy quotes_insert on quotes
  for insert to authenticated
  with check (employee_id = current_employee_id());

create policy quotes_update on quotes
  for update to authenticated
  using (can_access_employee_data(current_employee_id(), employee_id))
  with check (can_access_employee_data(current_employee_id(), employee_id));

-- ===== bookings =====

alter table bookings enable row level security;

create policy bookings_select on bookings
  for select to authenticated
  using (can_access_employee_data(current_employee_id(), employee_id));

create policy bookings_insert on bookings
  for insert to authenticated
  with check (employee_id = current_employee_id());

create policy bookings_update on bookings
  for update to authenticated
  using (can_access_employee_data(current_employee_id(), employee_id))
  with check (can_access_employee_data(current_employee_id(), employee_id));

-- ===== approvals =====
-- Visible to the requester and to anyone in the approval chain (their manager-chain viewers,
-- plus whoever the request was ultimately assigned to as approver).

alter table approvals enable row level security;

create policy approvals_select on approvals
  for select to authenticated
  using (
    can_access_employee_data(current_employee_id(), requested_by_employee_id)
    or approver_employee_id = current_employee_id()
  );

create policy approvals_insert on approvals
  for insert to authenticated
  with check (requested_by_employee_id = current_employee_id());

create policy approvals_update on approvals
  for update to authenticated
  using (
    can_access_employee_data(current_employee_id(), requested_by_employee_id)
    or approver_employee_id = current_employee_id()
  )
  with check (
    can_access_employee_data(current_employee_id(), requested_by_employee_id)
    or approver_employee_id = current_employee_id()
  );
