-- Phase 18: Ops Billing pipeline, PDI and delivery slots (Techwheels' ops-billing, PDI board and
-- delivery scheduler, re-keyed for Rajesh Toyota).
--
-- Every booking sent for billing walks through the same stages before the car leaves:
--   billing      invoice recorded (billing_requests.status = invoiced)                 automatic
--   accounts     nothing outstanding, or Accounts confirms the balance is covered      automatic / Accounts
--   insurance    policy number recorded                                                 automatic
--   rto          temporary or permanent registration number recorded                    automatic
--   accessories  accessories fitted and checked (not needed when none were sold)       Workshop / back office
--   scheme       TKM scheme claim proof filed (not needed when no scheme was given)     Accounts / back office
--   scrap        scrap certificate checked (only when one was used)                      back office
--   pdi          PDI passed on the PDI board                                             PDI Technician
--   gate_pass    issued once every stage above is done                                   back office
-- Stages filled automatically come from the existing tables, so nothing is entered twice. The manual
-- stages are rows in booking_ops_stages. Going back a stage needs a reason and the Outlet Head's
-- approval (Techwheels' booking_stage_reversal_request).
--
-- With ops_config.enabled on, delivery also needs a gate pass (and so every stage). Off (the default),
-- delivery works exactly as before; the boards can be used in parallel to try them out.

-- ===== Settings =====
create table ops_config (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  slot_times text[] not null default array['10:00', '12:00', '14:00', '16:00', '18:00'],
  slot_capacity int not null default 2 check (slot_capacity between 1 and 50),
  updated_by uuid references employees(id),
  updated_at timestamptz not null default now()
);
insert into ops_config default values;

-- A branch can change how many cars it hands over per slot.
create table delivery_slot_capacity (
  outlet_id uuid primary key references outlets(id),
  slot_capacity int not null check (slot_capacity between 1 and 50),
  slot_times text[]
);

-- ===== Modules and rights =====
insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('ops_billing',        'ops', 'Ops Billing',         '/ops-billing',         10, true),
  ('ops_accounts',       'ops', 'Accounts stage',      null,                   11, false),
  ('ops_insurance',      'ops', 'Insurance stage',     null,                   12, false),
  ('ops_rto',            'ops', 'RTO stage',           null,                   13, false),
  ('ops_accessories',    'ops', 'Accessories stage',   null,                   14, false),
  ('ops_scheme',         'ops', 'Scheme stage',        null,                   15, false),
  ('ops_scrap',          'ops', 'Scrap stage',         null,                   16, false),
  ('gate_pass',          'ops', 'Gate Pass',           '/ops-billing/gate-pass', 20, true),
  ('pdi_board',          'ops', 'PDI Board',           '/pdi-board',           30, true),
  ('delivery_scheduler', 'ops', 'Delivery Scheduler',  '/delivery-scheduler',  40, true);

select seed_role_rights('Outlet Head', m, r) from (values
  ('ops_billing', array['view','approve']), ('ops_accounts', array['view','edit']), ('ops_insurance', array['view','edit']),
  ('ops_rto', array['view','edit']), ('ops_accessories', array['view','edit']), ('ops_scheme', array['view','edit']),
  ('ops_scrap', array['view','edit']), ('gate_pass', array['view','create','edit']), ('pdi_board', array['view','create','edit']),
  ('delivery_scheduler', array['view','create','edit'])) x(m, r);
select seed_role_rights('Head Customer Relations', m, r) from (values
  ('ops_billing', array['view']), ('ops_insurance', array['view','edit']), ('ops_rto', array['view','edit']),
  ('ops_accessories', array['view','edit']), ('ops_scrap', array['view','edit']), ('gate_pass', array['view','create']),
  ('pdi_board', array['view','create']), ('delivery_scheduler', array['view','create','edit'])) x(m, r);
select seed_role_rights('Accounts', m, r) from (values
  ('ops_billing', array['view']), ('ops_accounts', array['view','edit']), ('ops_scheme', array['view','edit']),
  ('gate_pass', array['view']), ('delivery_scheduler', array['view'])) x(m, r);
select seed_role_rights('Insurance Executive', m, r) from (values
  ('ops_billing', array['view']), ('ops_insurance', array['view','edit'])) x(m, r);
select seed_role_rights('RTO Executive', m, r) from (values
  ('ops_billing', array['view']), ('ops_rto', array['view','edit'])) x(m, r);
select seed_role_rights('PDI Technician', m, r) from (values
  ('pdi_board', array['view','create','edit']), ('ops_accessories', array['view','edit'])) x(m, r);
select seed_role_rights('Gate Security', m, r) from (values ('gate_pass', array['view','edit'])) x(m, r);
select seed_role_rights('Relationship Manager', m, r) from (values
  ('ops_billing', array['view']), ('delivery_scheduler', array['view','create','edit']), ('pdi_board', array['view'])) x(m, r);
select seed_role_rights(role, 'delivery_scheduler', array['view','create']) from (values ('Team Leader'), ('Sales Consultant')) x(role);

-- The employee works at this branch (or sees every branch).
create or replace function ops_branch_ok(p_outlet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_employee_role_rank() <= 1, false) or current_employee_outlet_id() = p_outlet_id;
$$;

-- Right on a module, at this booking's branch.
create or replace function ops_can(p_module text, p_right text, p_outlet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select has_right(p_module, p_right) and ops_branch_ok(p_outlet_id);
$$;

-- ===== Manual stages =====
create table booking_ops_stages (
  booking_id uuid not null references bookings(id),
  stage text not null check (stage in ('accounts', 'accessories', 'scheme', 'scrap')),
  status text not null check (status in ('done', 'na')),
  note text,
  ref_no text,
  done_by uuid references employees(id),
  done_at timestamptz not null default now(),
  primary key (booking_id, stage)
);
create index idx_booking_ops_stages_done_by on booking_ops_stages(done_by);

create table ops_stage_reversals (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  stage text not null check (stage in ('accounts', 'accessories', 'scheme', 'scrap', 'pdi', 'gate_pass')),
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by uuid references employees(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references employees(id),
  decided_at timestamptz,
  decision_note text
);
create index idx_ops_stage_reversals_booking on ops_stage_reversals(booking_id);
create index idx_ops_stage_reversals_requested_by on ops_stage_reversals(requested_by);
create index idx_ops_stage_reversals_decided_by on ops_stage_reversals(decided_by);
create unique index uq_ops_stage_reversals_pending on ops_stage_reversals(booking_id, stage) where status = 'pending';

-- ===== PDI =====
create table pdi_checklist_items (
  code text primary key,
  section text not null,
  label text not null,
  sort_order int not null default 0,
  is_active boolean not null default true
);
insert into pdi_checklist_items (code, section, label, sort_order) values
  ('ext_paint',      'Exterior', 'Paint, panels and glass free of damage', 10),
  ('ext_lamps',      'Exterior', 'Head, tail, fog and indicator lamps work', 20),
  ('ext_tyres',      'Exterior', 'Tyres, pressure and spare wheel, jack and tools', 30),
  ('int_trim',       'Interior', 'Seats, trim and carpets clean and undamaged', 40),
  ('int_ac',         'Interior', 'AC, heater and blower', 50),
  ('int_infotain',   'Interior', 'Audio, display, Toyota Connect and reversing camera', 60),
  ('int_windows',    'Interior', 'Power windows, mirrors and central locking', 70),
  ('eng_fluids',     'Engine',   'Engine oil, coolant, brake and washer fluid levels', 80),
  ('eng_battery',    'Engine',   'Battery terminals and charge', 90),
  ('eng_leaks',      'Engine',   'No oil, fuel or coolant leaks', 100),
  ('drv_brakes',     'Road test','Brakes and parking brake', 110),
  ('drv_steering',   'Road test','Steering, suspension and no unusual noise', 120),
  ('drv_warning',    'Road test','No warning lights on the cluster', 130),
  ('doc_vin',        'Documents','VIN and engine number match the invoice', 140),
  ('doc_keys',       'Documents','Both keys, owner''s manual and service booklet', 150);

create table pdi_inspections (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  vehicle_id uuid not null references vehicles(id),
  outlet_id uuid not null references outlets(id),
  scheduled_for date not null,
  slot text,
  status text not null default 'scheduled' check (status in ('scheduled', 'passed', 'failed', 'cancelled')),
  results jsonb not null default '{}',
  remarks text,
  photo_paths text[] not null default '{}',
  scheduled_by uuid references employees(id),
  inspected_by uuid references employees(id),
  inspected_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_pdi_inspections_booking on pdi_inspections(booking_id);
create index idx_pdi_inspections_vehicle on pdi_inspections(vehicle_id);
create index idx_pdi_inspections_outlet_date on pdi_inspections(outlet_id, scheduled_for);
create index idx_pdi_inspections_scheduled_by on pdi_inspections(scheduled_by);
create index idx_pdi_inspections_inspected_by on pdi_inspections(inspected_by);
create unique index uq_pdi_inspections_open on pdi_inspections(booking_id) where status = 'scheduled';

-- ===== Gate pass =====
create table gate_passes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  vehicle_id uuid not null references vehicles(id),
  outlet_id uuid not null references outlets(id),
  gate_pass_no text not null unique,
  issued_by uuid references employees(id),
  issued_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text,
  exited_at timestamptz,
  exit_recorded_by uuid references employees(id)
);
create index idx_gate_passes_booking on gate_passes(booking_id);
create index idx_gate_passes_vehicle on gate_passes(vehicle_id);
create index idx_gate_passes_outlet on gate_passes(outlet_id);
create index idx_gate_passes_issued_by on gate_passes(issued_by);
create index idx_gate_passes_exit_by on gate_passes(exit_recorded_by);
create unique index uq_gate_passes_active on gate_passes(booking_id) where voided_at is null;

-- ===== Delivery slots =====
create table delivery_slots (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  outlet_id uuid not null references outlets(id),
  slot_date date not null,
  slot_time text not null,
  status text not null default 'booked' check (status in ('booked', 'cancelled', 'done')),
  note text,
  booked_by uuid references employees(id),
  booked_at timestamptz not null default now(),
  cancelled_reason text
);
create index idx_delivery_slots_booking on delivery_slots(booking_id);
create index idx_delivery_slots_outlet_date on delivery_slots(outlet_id, slot_date);
create index idx_delivery_slots_booked_by on delivery_slots(booked_by);
create unique index uq_delivery_slots_active on delivery_slots(booking_id) where status = 'booked';

-- ===== RLS: reads only; every change goes through the functions below =====
alter table ops_config enable row level security;
alter table delivery_slot_capacity enable row level security;
alter table booking_ops_stages enable row level security;
alter table ops_stage_reversals enable row level security;
alter table pdi_checklist_items enable row level security;
alter table pdi_inspections enable row level security;
alter table gate_passes enable row level security;
alter table delivery_slots enable row level security;

create policy ops_config_select on ops_config for select to authenticated using (true);
create policy delivery_slot_capacity_select on delivery_slot_capacity for select to authenticated using (true);
create policy pdi_checklist_items_select on pdi_checklist_items for select to authenticated using (true);
-- Ops desks (insurance, PDI...) don't see bookings themselves; they see the ops rows of their branch.
create or replace function booking_outlet_id(p_booking_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select outlet_id from bookings where id = p_booking_id;
$$;
revoke execute on function booking_outlet_id(uuid) from public, anon;
grant execute on function booking_outlet_id(uuid) to authenticated;

create policy booking_ops_stages_select on booking_ops_stages for select to authenticated
  using (can_access_booking(booking_id) or ops_can('ops_billing', 'view', booking_outlet_id(booking_id)));
create policy ops_stage_reversals_select on ops_stage_reversals for select to authenticated
  using (can_access_booking(booking_id) or requested_by = current_employee_id()
         or ops_can('ops_billing', 'view', booking_outlet_id(booking_id)));
create policy pdi_inspections_select on pdi_inspections for select to authenticated
  using (can_access_booking(booking_id) or ops_can('pdi_board', 'view', outlet_id));
create policy gate_passes_select on gate_passes for select to authenticated
  using (can_access_booking(booking_id) or ops_can('gate_pass', 'view', outlet_id));
create policy delivery_slots_select on delivery_slots for select to authenticated
  using (can_access_booking(booking_id) or ops_can('delivery_scheduler', 'view', outlet_id));

-- ===== Where each booking stands =====
-- One row per stage for a booking: status is done, na (not needed), pending or blocked (waiting on an
-- earlier step), with a short detail line.
create or replace function ops_stage_status(p_booking_id uuid)
returns table (stage text, status text, detail text, done_at timestamptz, done_by text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  b bookings%rowtype;
  br billing_requests%rowtype;
  v_outstanding numeric;
  v_accessories numeric;
  ins insurance_policies%rowtype;
  rto rto_registrations%rowtype;
  pdi pdi_inspections%rowtype;
  gp gate_passes%rowtype;
  m record;
  v_all_done boolean := true;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null then
    return;
  end if;
  select * into br from billing_requests where booking_id = b.id and status in ('pending', 'invoiced');
  select outstanding into v_outstanding from booking_account(b.id);
  select coalesce(accessories_total, 0) into v_accessories from welcome_dockets where booking_id = b.id;
  select * into ins from insurance_policies where booking_id = b.id;
  select * into rto from rto_registrations where booking_id = b.id;
  -- The PDI that counts: a pass, else the one booked, else the latest result.
  select * into pdi from pdi_inspections where booking_id = b.id and status <> 'cancelled'
  order by status = 'passed' desc, status = 'scheduled' desc, coalesce(inspected_at, created_at) desc limit 1;
  select * into gp from gate_passes where booking_id = b.id and voided_at is null;

  -- billing
  stage := 'billing'; done_at := br.invoiced_at;
  done_by := (select name from employees where id = br.invoiced_by);
  if br.status = 'invoiced' then status := 'done'; detail := 'Invoice ' || br.invoice_no;
  elsif br.status = 'pending' then status := 'pending'; detail := 'Waiting for Accounts to invoice';
  else status := 'blocked'; detail := 'Not sent for billing yet'; end if;
  return next;
  v_all_done := v_all_done and status = 'done';

  -- accounts
  stage := 'accounts';
  select s.* into m from booking_ops_stages s where s.booking_id = b.id and s.stage = 'accounts';
  if coalesce(v_outstanding, 0) <= 0 then
    status := 'done'; detail := 'Fully paid'; done_at := null; done_by := null;
  elsif m.status is not null then
    status := m.status; detail := 'Confirmed by Accounts' || coalesce(': ' || m.note, '');
    done_at := m.done_at; done_by := (select name from employees where id = m.done_by);
  else
    status := 'pending'; detail := 'Outstanding ₹' || to_char(round(v_outstanding), 'FM99,99,99,999'); done_at := null; done_by := null;
  end if;
  return next;
  v_all_done := v_all_done and status in ('done', 'na');

  -- insurance
  stage := 'insurance'; done_at := ins.updated_at; done_by := (select name from employees where id = ins.recorded_by);
  if nullif(btrim(ins.policy_no), '') is not null then status := 'done'; detail := coalesce(ins.insurer_name || ' ', '') || ins.policy_no;
  else status := 'pending'; detail := 'Policy number not recorded'; done_at := null; done_by := null; end if;
  return next;
  v_all_done := v_all_done and status = 'done';

  -- rto
  stage := 'rto'; done_at := rto.updated_at; done_by := (select name from employees where id = rto.recorded_by);
  if coalesce(rto.perm_reg_no, rto.temp_reg_no) is not null then status := 'done'; detail := coalesce(rto.perm_reg_no, rto.temp_reg_no);
  else status := 'pending'; detail := 'Registration number not recorded'; done_at := null; done_by := null; end if;
  return next;
  v_all_done := v_all_done and status = 'done';

  -- accessories, scheme, scrap: manual, or not needed
  for m in
    select x.stage as st,
           case x.stage
             when 'accessories' then coalesce(v_accessories, 0) <= 0 and coalesce(cardinality(b.accessory_ids), 0) = 0
             when 'scheme' then coalesce(cardinality(b.selected_scheme_line_item_ids), 0) = 0
             when 'scrap' then b.scrap_certificate_id is null
           end as not_needed,
           s.status as s_status, s.note, s.ref_no, s.done_at as s_done_at, s.done_by as s_done_by
    from (values ('accessories'), ('scheme'), ('scrap')) x(stage)
    left join booking_ops_stages s on s.booking_id = b.id and s.stage = x.stage
  loop
    stage := m.st; done_at := m.s_done_at; done_by := (select name from employees where id = m.s_done_by);
    if m.s_status is not null then
      status := m.s_status;
      detail := concat_ws(' · ', case when m.s_status = 'na' then 'Not needed' else 'Done' end, m.ref_no, m.note);
    elsif m.not_needed then
      status := 'na'; detail := 'Not needed for this booking'; done_at := null; done_by := null;
    else
      status := 'pending';
      detail := case m.st when 'accessories' then 'Fit and check the accessories sold'
                          when 'scheme' then 'File the TKM scheme claim proof'
                          else 'Check the scrap certificate' end;
      done_at := null; done_by := null;
    end if;
    return next;
    v_all_done := v_all_done and status in ('done', 'na');
  end loop;

  -- pdi
  stage := 'pdi'; done_at := pdi.inspected_at; done_by := (select name from employees where id = pdi.inspected_by);
  if pdi.status = 'passed' then status := 'done'; detail := 'Passed';
  elsif pdi.status = 'failed' then status := 'pending'; detail := 'Failed: ' || coalesce(pdi.remarks, 'see the PDI board') || '. Schedule again';
  elsif pdi.status = 'scheduled' then status := 'pending'; detail := 'Scheduled for ' || to_char(pdi.scheduled_for, 'DD Mon') || coalesce(' ' || pdi.slot, '');
  else status := 'pending'; detail := 'Not scheduled'; done_at := null; done_by := null; end if;
  return next;
  v_all_done := v_all_done and status = 'done';

  -- gate pass
  stage := 'gate_pass'; done_at := gp.issued_at; done_by := (select name from employees where id = gp.issued_by);
  if gp.id is not null then
    status := 'done'; detail := gp.gate_pass_no || case when gp.exited_at is not null then ' · left the yard' else '' end;
  elsif v_all_done then
    status := 'pending'; detail := 'Ready to issue';
  else
    status := 'blocked'; detail := 'Finish the stages above first'; done_at := null; done_by := null;
  end if;
  return next;
end;
$$;

-- Bookings in the ops pipeline (sent for billing, not delivered or cancelled) at the caller's branches,
-- with every stage's status, for the Ops Billing board. p_stage narrows to bookings pending that stage.
create or replace function ops_board(p_stage text default null, p_outlet_id uuid default null)
returns table (
  booking_id uuid, outlet_id uuid, outlet text, customer_name text, customer_mobile text, order_no text,
  consultant text, model text, variant text, color text, vin text, invoice_no text, invoice_date date,
  outstanding numeric, sent_at timestamptz, delivery_slot text, stages jsonb, pending_reversals int
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not has_right('ops_billing', 'view') and not has_right('gate_pass', 'view') then
    raise exception 'You do not have access to Ops Billing';
  end if;
  return query
  select b.id, b.outlet_id, o.name, b.customer_name, coalesce(c.mobile, b.customer_mobile),
         coalesce(b.ctdms_order_booking_no, b.order_booking_no), e.name, mo.name, va.name, co.name, v.vin,
         br.invoice_no, br.invoice_date, (select a.outstanding from booking_account(b.id) a), br.requested_at,
         (select to_char(ds.slot_date, 'DD Mon') || ' ' || ds.slot_time from delivery_slots ds
           where ds.booking_id = b.id and ds.status = 'booked'),
         (select jsonb_object_agg(s.stage, jsonb_build_object('status', s.status, 'detail', s.detail))
            from ops_stage_status(b.id) s),
         (select count(*)::int from ops_stage_reversals r where r.booking_id = b.id and r.status = 'pending')
  from billing_requests br
  join bookings b on b.id = br.booking_id
  join outlets o on o.id = b.outlet_id
  left join customers c on c.id = b.customer_id
  left join employees e on e.id = b.employee_id
  left join variants va on va.id = b.variant_id
  left join models mo on mo.id = va.model_id
  left join colors co on co.id = b.color_id
  left join vehicles v on v.id = br.vehicle_id
  where br.status in ('pending', 'invoiced')
    and b.status not in ('delivered', 'cancelled')
    and ops_branch_ok(b.outlet_id)
    and (p_outlet_id is null or b.outlet_id = p_outlet_id)
    and (p_stage is null or exists (select 1 from ops_stage_status(b.id) s where s.stage = p_stage and s.status = 'pending'))
  order by br.requested_at;
end;
$$;

-- Mark a manual stage done, or not needed (na), with a note and reference (e.g. the claim number).
create or replace function ops_mark_stage(p_booking_id uuid, p_stage text, p_status text, p_note text default null, p_ref_no text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null then raise exception 'Booking not found'; end if;
  if p_stage not in ('accounts', 'accessories', 'scheme', 'scrap') then
    raise exception 'This stage fills itself from its own screen';
  end if;
  if p_status not in ('done', 'na') then raise exception 'Status must be done or na'; end if;
  if not ops_can('ops_' || p_stage, 'edit', b.outlet_id) then
    raise exception 'You cannot update the % stage at this branch', p_stage;
  end if;
  if b.status in ('delivered', 'cancelled') then raise exception 'This booking is closed'; end if;
  if not exists (select 1 from billing_requests where booking_id = b.id and status in ('pending', 'invoiced')) then
    raise exception 'Send the car for billing first';
  end if;
  if p_stage = 'accounts' and nullif(btrim(p_note), '') is null then
    raise exception 'Say how the outstanding amount is covered (e.g. loan DO received)';
  end if;
  if exists (select 1 from booking_ops_stages where booking_id = b.id and stage = p_stage) then
    raise exception 'This stage is already marked; ask for it to be reopened';
  end if;
  insert into booking_ops_stages (booking_id, stage, status, note, ref_no, done_by)
  values (b.id, p_stage, p_status, nullif(btrim(p_note), ''), nullif(btrim(p_ref_no), ''), current_employee_id());
end;
$$;

-- Ask to take a finished stage back (wrong entry, PDI fault found later...). The Outlet Head decides.
create or replace function request_stage_reversal(p_booking_id uuid, p_stage text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not (ops_can('ops_billing', 'view', b.outlet_id) or ops_can('pdi_board', 'edit', b.outlet_id)) then
    raise exception 'Booking not found';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  if b.status in ('delivered', 'cancelled') then raise exception 'This booking is closed'; end if;
  if p_stage in ('accounts', 'accessories', 'scheme', 'scrap')
     and not exists (select 1 from booking_ops_stages where booking_id = b.id and stage = p_stage) then
    raise exception 'That stage has not been marked';
  elsif p_stage = 'pdi' and not exists (select 1 from pdi_inspections where booking_id = b.id and status = 'passed') then
    raise exception 'There is no passed PDI to reopen';
  elsif p_stage = 'gate_pass' and not exists (select 1 from gate_passes where booking_id = b.id and voided_at is null) then
    raise exception 'There is no gate pass to cancel';
  elsif p_stage not in ('accounts', 'accessories', 'scheme', 'scrap', 'pdi', 'gate_pass') then
    raise exception 'This stage is changed from its own screen';
  end if;
  insert into ops_stage_reversals (booking_id, stage, reason, requested_by)
  values (b.id, p_stage, btrim(p_reason), current_employee_id())
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'A request to reopen this stage is already waiting';
end;
$$;

create or replace function decide_stage_reversal(p_reversal_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r ops_stage_reversals%rowtype;
  b bookings%rowtype;
begin
  select * into r from ops_stage_reversals where id = p_reversal_id for update;
  if r.id is null or r.status <> 'pending' then raise exception 'Request not found or already decided'; end if;
  select * into b from bookings where id = r.booking_id;
  if not ops_can('ops_billing', 'approve', b.outlet_id) then
    raise exception 'Only the Outlet Head can approve going back a stage';
  end if;
  if r.requested_by = current_employee_id() and not coalesce(current_employee_role_rank() <= 1, false) then
    raise exception 'Someone else must decide your own request';
  end if;
  update ops_stage_reversals set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = current_employee_id(), decided_at = now(), decision_note = nullif(btrim(p_note), '')
  where id = r.id;
  if not p_approve then return; end if;

  if r.stage in ('accounts', 'accessories', 'scheme', 'scrap') then
    delete from booking_ops_stages where booking_id = r.booking_id and stage = r.stage;
  elsif r.stage = 'pdi' then
    update pdi_inspections set status = 'failed', remarks = 'Reopened: ' || r.reason
    where booking_id = r.booking_id and status = 'passed';
    update deliveries set pdi_done = false where booking_id = r.booking_id and status = 'draft';
  end if;
  -- Any earlier stage going back cancels the gate pass too.
  update gate_passes set voided_at = now(), void_reason = 'Stage reopened (' || r.stage || '): ' || r.reason
  where booking_id = r.booking_id and voided_at is null and exited_at is null;
end;
$$;

-- ===== PDI board =====
create or replace function schedule_pdi(p_booking_id uuid, p_date date, p_slot text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  a allotments%rowtype;
  v vehicles%rowtype;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null then raise exception 'Booking not found'; end if;
  if not ops_can('pdi_board', 'create', b.outlet_id) then
    raise exception 'You cannot schedule PDIs at this branch';
  end if;
  select * into a from allotments where booking_id = b.id and released_at is null;
  if a.id is null then raise exception 'Allot a car to this booking first'; end if;
  select * into v from vehicles where id = a.vehicle_id;
  if v.source <> 'physical' then raise exception 'The car is still in transit'; end if;
  if p_date is null or p_date < (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'Pick today or a later date';
  end if;
  if exists (select 1 from pdi_inspections where booking_id = b.id and status = 'passed') then
    raise exception 'PDI has already passed for this booking';
  end if;
  insert into pdi_inspections (booking_id, vehicle_id, outlet_id, scheduled_for, slot, scheduled_by)
  values (b.id, v.id, b.outlet_id, p_date, nullif(btrim(p_slot), ''), current_employee_id())
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'A PDI is already scheduled for this booking';
end;
$$;

-- Results: { item_code: "ok" | "fail" | "na" } for every active checklist item. Any "fail" fails the PDI.
create or replace function record_pdi_result(p_inspection_id uuid, p_results jsonb, p_remarks text default null, p_photo_paths text[] default '{}')
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  i pdi_inspections%rowtype;
  v_missing text;
  v_bad text;
  v_failed boolean;
begin
  select * into i from pdi_inspections where id = p_inspection_id for update;
  if i.id is null or i.status <> 'scheduled' then raise exception 'PDI not found or already recorded'; end if;
  if not ops_can('pdi_board', 'edit', i.outlet_id) then
    raise exception 'You cannot record PDIs at this branch';
  end if;
  select string_agg(c.label, ', ') into v_missing
  from pdi_checklist_items c where c.is_active and not (p_results ? c.code);
  if v_missing is not null then raise exception 'Check every item: %', v_missing; end if;
  select string_agg(k, ', ') into v_bad from jsonb_object_keys(p_results) k
  where p_results->>k not in ('ok', 'fail', 'na');
  if v_bad is not null then raise exception 'Each item must be ok, fail or na: %', v_bad; end if;
  if exists (select 1 from unnest(p_photo_paths) p where p not like i.booking_id::text || '/pdi/%') then
    raise exception 'PDI photos must be stored with this booking';
  end if;
  v_failed := exists (select 1 from jsonb_each_text(p_results) e where e.value = 'fail');
  if v_failed and nullif(btrim(p_remarks), '') is null then
    raise exception 'Describe what failed';
  end if;
  update pdi_inspections set status = case when v_failed then 'failed' else 'passed' end, results = p_results,
    remarks = nullif(btrim(p_remarks), ''), photo_paths = coalesce(p_photo_paths, '{}'),
    inspected_by = current_employee_id(), inspected_at = now()
  where id = i.id;
  if not v_failed then
    insert into deliveries (booking_id, pdi_done) values (i.booking_id, true)
    on conflict (booking_id) do update set pdi_done = true;
  end if;
  return case when v_failed then 'failed' else 'passed' end;
end;
$$;

create or replace function cancel_pdi(p_inspection_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  i pdi_inspections%rowtype;
begin
  select * into i from pdi_inspections where id = p_inspection_id for update;
  if i.id is null or i.status <> 'scheduled' then raise exception 'PDI not found or already recorded'; end if;
  if not ops_can('pdi_board', 'create', i.outlet_id) then raise exception 'You cannot change PDIs at this branch'; end if;
  update pdi_inspections set status = 'cancelled', remarks = nullif(btrim(p_reason), '') where id = i.id;
end;
$$;

-- PDIs for a day at the caller's branches, plus allotted yard cars still waiting for one.
create or replace function pdi_board(p_date date default null, p_outlet_id uuid default null)
returns table (
  kind text, inspection_id uuid, booking_id uuid, outlet text, customer_name text, model text, variant text, color text,
  vin text, scheduled_for date, slot text, status text, remarks text, inspected_by text, results jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_date date := coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date);
begin
  if not has_right('pdi_board', 'view') then raise exception 'You do not have access to the PDI board'; end if;
  return query
  select 'scheduled', i.id, b.id, o.name, b.customer_name, mo.name, va.name, co.name, v.vin, i.scheduled_for, i.slot,
         i.status, i.remarks, e.name, i.results
  from pdi_inspections i
  join bookings b on b.id = i.booking_id
  join outlets o on o.id = i.outlet_id
  join vehicles v on v.id = i.vehicle_id
  left join variants va on va.id = v.variant_id
  left join models mo on mo.id = va.model_id
  left join colors co on co.id = v.color_id
  left join employees e on e.id = i.inspected_by
  where i.scheduled_for = v_date and i.status <> 'cancelled'
    and ops_branch_ok(i.outlet_id) and (p_outlet_id is null or i.outlet_id = p_outlet_id)
  union all
  select 'waiting', null, b.id, o.name, b.customer_name, mo.name, va.name, co.name, v.vin, null, null,
         case when exists (select 1 from pdi_inspections f where f.booking_id = b.id and f.status = 'failed') then 'failed' else 'not_scheduled' end,
         (select f.remarks from pdi_inspections f where f.booking_id = b.id and f.status = 'failed' order by f.inspected_at desc limit 1),
         null, null
  from allotments a
  join bookings b on b.id = a.booking_id
  join vehicles v on v.id = a.vehicle_id
  join outlets o on o.id = b.outlet_id
  left join variants va on va.id = v.variant_id
  left join models mo on mo.id = va.model_id
  left join colors co on co.id = v.color_id
  where a.released_at is null and v.source = 'physical' and b.status not in ('delivered', 'cancelled')
    and not exists (select 1 from pdi_inspections p where p.booking_id = b.id and p.status in ('scheduled', 'passed'))
    and ops_branch_ok(b.outlet_id) and (p_outlet_id is null or b.outlet_id = p_outlet_id)
  order by 1 desc, 11 nulls last, 5;
end;
$$;

-- ===== Gate pass =====
create or replace function issue_gate_pass(p_booking_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  br billing_requests%rowtype;
  v_open text;
  v_code text;
  v_no text;
begin
  select * into b from bookings where id = p_booking_id for update;
  if b.id is null then raise exception 'Booking not found'; end if;
  if not ops_can('gate_pass', 'create', b.outlet_id) then
    raise exception 'You cannot issue gate passes at this branch';
  end if;
  if exists (select 1 from gate_passes where booking_id = b.id and voided_at is null) then
    raise exception 'A gate pass has already been issued';
  end if;
  select string_agg(s.stage || ' (' || s.detail || ')', '; ') into v_open
  from ops_stage_status(b.id) s where s.stage <> 'gate_pass' and s.status not in ('done', 'na');
  if v_open is not null then raise exception 'Not ready for a gate pass: %', v_open; end if;
  select * into br from billing_requests where booking_id = b.id and status = 'invoiced';
  select coalesce(ctdms_dealer_code, dealer_code, 'RT') into v_code from outlets where id = b.outlet_id;
  v_no := 'GP/' || v_code || '/' || to_char(now() at time zone 'Asia/Kolkata', 'YYMM') || '/' ||
          lpad((select count(*) + 1 from gate_passes g where g.outlet_id = b.outlet_id
                and date_trunc('month', g.issued_at at time zone 'Asia/Kolkata') = date_trunc('month', now() at time zone 'Asia/Kolkata'))::text, 4, '0');
  insert into gate_passes (booking_id, vehicle_id, outlet_id, gate_pass_no, issued_by)
  values (b.id, br.vehicle_id, b.outlet_id, v_no, current_employee_id());
  return v_no;
end;
$$;

-- Security at the gate records the car leaving, after the handover.
create or replace function record_gate_exit(p_gate_pass_no text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  g gate_passes%rowtype;
begin
  select * into g from gate_passes where gate_pass_no = upper(btrim(p_gate_pass_no)) and voided_at is null for update;
  if g.id is null then raise exception 'No valid gate pass with that number'; end if;
  if not ops_can('gate_pass', 'edit', g.outlet_id) then raise exception 'You cannot record exits at this branch'; end if;
  if g.exited_at is not null then raise exception 'This car has already left'; end if;
  if not exists (select 1 from bookings where id = g.booking_id and status = 'delivered') then
    raise exception 'The car has not been handed over yet';
  end if;
  update gate_passes set exited_at = now(), exit_recorded_by = current_employee_id() where id = g.id;
end;
$$;

-- Gate passes issued since a date at the caller's branches, for security and the back office.
create or replace function gate_pass_list(p_since date default null)
returns table (
  id uuid, gate_pass_no text, booking_id uuid, outlet text, customer_name text, model text, variant text, color text,
  vin text, issued_at timestamptz, issued_by text, delivered boolean, exited_at timestamptz, voided_at timestamptz, void_reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not has_right('gate_pass', 'view') then raise exception 'You do not have access to gate passes'; end if;
  return query
  select g.id, g.gate_pass_no, b.id, o.name, b.customer_name, mo.name, va.name, co.name, v.vin, g.issued_at, e.name,
         b.status = 'delivered', g.exited_at, g.voided_at, g.void_reason
  from gate_passes g
  join bookings b on b.id = g.booking_id
  join outlets o on o.id = g.outlet_id
  join vehicles v on v.id = g.vehicle_id
  left join variants va on va.id = v.variant_id
  left join models mo on mo.id = va.model_id
  left join colors co on co.id = v.color_id
  left join employees e on e.id = g.issued_by
  where ops_branch_ok(g.outlet_id)
    and g.issued_at >= coalesce(p_since, (now() at time zone 'Asia/Kolkata')::date - 7)
  order by g.exited_at is not null, g.voided_at is not null, g.issued_at desc;
end;
$$;
revoke execute on function gate_pass_list(date) from public, anon;
grant execute on function gate_pass_list(date) to authenticated;

-- Pending requests to reopen a stage at the caller's branches.
create or replace function ops_reversal_requests()
returns table (id uuid, booking_id uuid, customer_name text, stage text, reason text, requested_by text, requested_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  return query
  select r.id, b.id, b.customer_name, r.stage, r.reason, e.name, r.requested_at
  from ops_stage_reversals r
  join bookings b on b.id = r.booking_id
  left join employees e on e.id = r.requested_by
  where r.status = 'pending' and ops_can('ops_billing', 'view', b.outlet_id)
  order by r.requested_at;
end;
$$;
revoke execute on function ops_reversal_requests() from public, anon;
grant execute on function ops_reversal_requests() to authenticated;

-- ===== Delivery slots =====
create or replace function delivery_slot_settings(p_outlet_id uuid)
returns table (slot_times text[], slot_capacity int)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(d.slot_times, c.slot_times), coalesce(d.slot_capacity, c.slot_capacity)
  from ops_config c left join delivery_slot_capacity d on d.outlet_id = p_outlet_id;
$$;

create or replace function book_delivery_slot(p_booking_id uuid, p_date date, p_time text, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  s record;
  v_used int;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id for update;
  if b.id is null then raise exception 'Booking not found'; end if;
  if not (ops_can('delivery_scheduler', 'create', b.outlet_id)
          or (has_right('delivery_scheduler', 'create') and can_handle_booking(b))) then
    raise exception 'You cannot book delivery slots for this booking';
  end if;
  if b.status in ('delivered', 'cancelled') then raise exception 'This booking is closed'; end if;
  if not exists (select 1 from billing_requests where booking_id = b.id and status in ('pending', 'invoiced')) then
    raise exception 'Send the car for billing before booking the delivery';
  end if;
  if p_date is null or p_date < (now() at time zone 'Asia/Kolkata')::date then raise exception 'Pick today or a later date'; end if;
  select * into s from delivery_slot_settings(b.outlet_id);
  if not (p_time = any(s.slot_times)) then
    raise exception 'Pick one of the slots: %', array_to_string(s.slot_times, ', ');
  end if;
  -- One slot per booking: moving it frees the old one.
  update delivery_slots set status = 'cancelled', cancelled_reason = 'Moved'
  where booking_id = b.id and status = 'booked';
  perform 1 from outlets where id = b.outlet_id for update;  -- one booking at a time per branch
  select count(*) into v_used from delivery_slots
  where outlet_id = b.outlet_id and slot_date = p_date and slot_time = p_time and status = 'booked';
  if v_used >= s.slot_capacity then raise exception 'That slot is full; pick another'; end if;
  insert into delivery_slots (booking_id, outlet_id, slot_date, slot_time, note, booked_by)
  values (b.id, b.outlet_id, p_date, p_time, nullif(btrim(p_note), ''), current_employee_id())
  returning id into v_id;
  update bookings set likely_delivery_date = p_date where id = b.id;
  return v_id;
end;
$$;

create or replace function cancel_delivery_slot(p_slot_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s delivery_slots%rowtype;
  b bookings%rowtype;
begin
  select * into s from delivery_slots where id = p_slot_id for update;
  if s.id is null or s.status <> 'booked' then raise exception 'Slot not found or not booked'; end if;
  select * into b from bookings where id = s.booking_id;
  if not (ops_can('delivery_scheduler', 'edit', s.outlet_id) or (has_right('delivery_scheduler', 'create') and can_handle_booking(b))) then
    raise exception 'You cannot change this slot';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  update delivery_slots set status = 'cancelled', cancelled_reason = btrim(p_reason) where id = s.id;
end;
$$;

-- The calendar: every slot of every day in the range, with what is booked and how ready each car is.
create or replace function delivery_schedule(p_from date, p_to date, p_outlet_id uuid default null)
returns table (
  outlet_id uuid, outlet text, slot_date date, slot_time text, capacity int, slot_id uuid, booking_id uuid,
  customer_name text, customer_mobile text, model text, variant text, consultant text, open_stages int, gate_pass_no text,
  delivered boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not has_right('delivery_scheduler', 'view') then raise exception 'You do not have access to the delivery scheduler'; end if;
  if p_to < p_from or p_to - p_from > 62 then raise exception 'Pick up to two months'; end if;
  return query
  with days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
  branches as (
    select o.id, o.name from outlets o
    where o.is_active and ops_branch_ok(o.id) and (p_outlet_id is null or o.id = p_outlet_id)
  ),
  grid as (
    select br.id as oid, br.name as oname, days.day, t.slot_time, st.slot_capacity
    from branches br cross join days
    cross join lateral delivery_slot_settings(br.id) st
    cross join lateral unnest(st.slot_times) t(slot_time)
  )
  select g.oid, g.oname, g.day, g.slot_time, g.slot_capacity, ds.id, b.id, b.customer_name,
         coalesce(c.mobile, b.customer_mobile), mo.name, va.name, e.name,
         case when b.id is null then null
              else (select count(*)::int from ops_stage_status(b.id) s where s.status not in ('done', 'na')) end,
         gp.gate_pass_no, b.status = 'delivered'
  from grid g
  left join delivery_slots ds on ds.outlet_id = g.oid and ds.slot_date = g.day and ds.slot_time = g.slot_time
                             and ds.status in ('booked', 'done')
  left join bookings b on b.id = ds.booking_id
  left join customers c on c.id = b.customer_id
  left join variants va on va.id = b.variant_id
  left join models mo on mo.id = va.model_id
  left join employees e on e.id = b.employee_id
  left join gate_passes gp on gp.booking_id = b.id and gp.voided_at is null
  order by g.oname, g.day, g.slot_time;
end;
$$;

create or replace function ops_config_update(p_enabled boolean, p_slot_times text[] default null, p_slot_capacity int default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(current_employee_role_rank() <= 1, false) then
    raise exception 'Only the Admin or Business Head can change ops settings';
  end if;
  update ops_config set enabled = p_enabled, slot_times = coalesce(p_slot_times, slot_times),
    slot_capacity = coalesce(p_slot_capacity, slot_capacity), updated_by = current_employee_id(), updated_at = now();
end;
$$;

-- ===== Delivery needs the gate pass once ops is switched on =====
create or replace function delivery_blockers(p_booking_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  d deliveries%rowtype;
  v text[] := '{}';
  v_outstanding numeric;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not (can_handle_booking(b) or is_branch_accounts(b.outlet_id)) then
    raise exception 'Booking not found';
  end if;
  select * into d from deliveries where booking_id = b.id;
  if not exists (select 1 from billing_requests where booking_id = b.id and status = 'invoiced') then
    v := array_append(v, 'The car has not been invoiced');
  end if;
  if not exists (select 1 from insurance_policies where booking_id = b.id and nullif(btrim(policy_no), '') is not null) then
    v := array_append(v, 'Insurance policy number');
  end if;
  if not exists (select 1 from rto_registrations where booking_id = b.id and coalesce(temp_reg_no, perm_reg_no) is not null) then
    v := array_append(v, 'Temporary or permanent registration number');
  end if;
  if not coalesce(d.pdi_done, false) then v := array_append(v, 'PDI done'); end if;
  if not coalesce(d.accessories_fitted, false) then v := array_append(v, 'Accessories fitted and checked'); end if;
  if not coalesce(d.fastag_fitted, false) then v := array_append(v, 'FASTag fitted'); end if;
  if not coalesce(d.documents_explained, false) then v := array_append(v, 'Documents explained'); end if;
  if not coalesce(d.demo_done, false) then v := array_append(v, 'Vehicle demo done'); end if;
  if d.handover_photo_path is null then v := array_append(v, 'Handover photo'); end if;
  if d.customer_signature_path is null then v := array_append(v, 'Customer signature'); end if;
  if (select enabled from ops_config) and not exists (select 1 from gate_passes where booking_id = b.id and voided_at is null) then
    v := array_append(v, 'Gate pass (Ops Billing)');
  end if;
  select outstanding into v_outstanding from booking_account(b.id);
  if v_outstanding > 0 then
    v := array_append(v, 'Outstanding ₹' || to_char(round(v_outstanding), 'FM99,99,99,999'));
  end if;
  return v;
end;
$$;

-- Delivered: the slot is done.
create or replace function delivery_slots_on_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.status = 'delivered' and OLD.status is distinct from 'delivered' then
    update delivery_slots set status = 'done' where booking_id = NEW.id and status = 'booked';
  end if;
  return NEW;
end;
$$;
create trigger trg_bookings_delivery_slot_done after update of status on bookings
  for each row execute function delivery_slots_on_delivery();

-- ===== Insurance and RTO executives record their stage =====
create or replace function can_record_insurance_rto(p_outlet_id uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_branch_back_office(p_outlet_id) or ops_can(p_module, 'edit', p_outlet_id);
$$;

create or replace function save_insurance_policy(p_booking_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not can_record_insurance_rto(b.outlet_id, 'ops_insurance') then
    raise exception 'Only the branch''s back office can record insurance';
  end if;
  if p->>'policy_storage_path' is not null and p->>'policy_storage_path' not like b.id::text || '/insurance/%' then
    raise exception 'The policy file must be stored with this booking';
  end if;
  update insurance_policies set
    insurance_provider_id = coalesce((p->>'insurance_provider_id')::uuid, insurance_provider_id),
    insurer_name = coalesce(nullif(btrim(p->>'insurer_name'), ''), insurer_name),
    policy_no = coalesce(nullif(btrim(p->>'policy_no'), ''), policy_no),
    coverage = coalesce(nullif(btrim(p->>'coverage'), ''), coverage),
    premium = coalesce((p->>'premium')::numeric, premium),
    idv = coalesce((p->>'idv')::numeric, idv),
    start_date = coalesce((p->>'start_date')::date, start_date),
    end_date = coalesce((p->>'end_date')::date, end_date),
    in_house = coalesce((p->>'in_house')::boolean, in_house),
    policy_storage_path = coalesce(p->>'policy_storage_path', policy_storage_path),
    recorded_by = current_employee_id()
  where booking_id = b.id
  returning id into v_id;
  if v_id is not null then
    return v_id;
  end if;

  if nullif(btrim(p->>'policy_no'), '') is null then
    raise exception 'Enter the policy number';
  end if;
  insert into insurance_policies (booking_id, insurance_provider_id, insurer_name, policy_no, coverage, premium, idv,
                                  start_date, end_date, in_house, policy_storage_path, recorded_by)
  values (b.id, (p->>'insurance_provider_id')::uuid, nullif(btrim(p->>'insurer_name'), ''), btrim(p->>'policy_no'),
          nullif(btrim(p->>'coverage'), ''), (p->>'premium')::numeric, (p->>'idv')::numeric, (p->>'start_date')::date,
          (p->>'end_date')::date, coalesce((p->>'in_house')::boolean, true), p->>'policy_storage_path', current_employee_id())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function save_rto_registration(p_booking_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not can_record_insurance_rto(b.outlet_id, 'ops_rto') then
    raise exception 'Only the branch''s back office can record the registration';
  end if;
  if p->>'tax_receipt_storage_path' is not null and p->>'tax_receipt_storage_path' not like b.id::text || '/rto/%' then
    raise exception 'The tax receipt must be stored with this booking';
  end if;
  insert into rto_registrations as r (booking_id, temp_reg_no, temp_reg_date, perm_reg_no, perm_reg_date, hsrp_status,
                                      hsrp_date, rc_status, rc_date, road_tax_amount, tax_receipt_storage_path, notes, recorded_by)
  values (b.id, nullif(upper(btrim(p->>'temp_reg_no')), ''), (p->>'temp_reg_date')::date,
          nullif(upper(btrim(p->>'perm_reg_no')), ''), (p->>'perm_reg_date')::date,
          coalesce(p->>'hsrp_status', 'not_applied'), (p->>'hsrp_date')::date, coalesce(p->>'rc_status', 'pending'),
          (p->>'rc_date')::date, (p->>'road_tax_amount')::numeric, p->>'tax_receipt_storage_path',
          nullif(btrim(p->>'notes'), ''), current_employee_id())
  on conflict (booking_id) do update set
    temp_reg_no = coalesce(excluded.temp_reg_no, r.temp_reg_no),
    temp_reg_date = coalesce(excluded.temp_reg_date, r.temp_reg_date),
    perm_reg_no = coalesce(excluded.perm_reg_no, r.perm_reg_no),
    perm_reg_date = coalesce(excluded.perm_reg_date, r.perm_reg_date),
    hsrp_status = case when p ? 'hsrp_status' then excluded.hsrp_status else r.hsrp_status end,
    hsrp_date = coalesce(excluded.hsrp_date, r.hsrp_date),
    rc_status = case when p ? 'rc_status' then excluded.rc_status else r.rc_status end,
    rc_date = coalesce(excluded.rc_date, r.rc_date),
    road_tax_amount = coalesce(excluded.road_tax_amount, r.road_tax_amount),
    tax_receipt_storage_path = coalesce(excluded.tax_receipt_storage_path, r.tax_receipt_storage_path),
    notes = coalesce(excluded.notes, r.notes),
    recorded_by = excluded.recorded_by
  returning id into v_id;
  return v_id;
end;
$$;

-- ===== Grants =====
revoke execute on function ops_branch_ok(uuid) from public, anon;
revoke execute on function ops_can(text, text, uuid) from public, anon;
revoke execute on function ops_stage_status(uuid) from public, anon;
revoke execute on function ops_board(text, uuid) from public, anon;
revoke execute on function ops_mark_stage(uuid, text, text, text, text) from public, anon;
revoke execute on function request_stage_reversal(uuid, text, text) from public, anon;
revoke execute on function decide_stage_reversal(uuid, boolean, text) from public, anon;
revoke execute on function schedule_pdi(uuid, date, text) from public, anon;
revoke execute on function record_pdi_result(uuid, jsonb, text, text[]) from public, anon;
revoke execute on function cancel_pdi(uuid, text) from public, anon;
revoke execute on function pdi_board(date, uuid) from public, anon;
revoke execute on function issue_gate_pass(uuid) from public, anon;
revoke execute on function record_gate_exit(text) from public, anon;
revoke execute on function delivery_slot_settings(uuid) from public, anon;
revoke execute on function book_delivery_slot(uuid, date, text, text) from public, anon;
revoke execute on function cancel_delivery_slot(uuid, text) from public, anon;
revoke execute on function delivery_schedule(date, date, uuid) from public, anon;
revoke execute on function ops_config_update(boolean, text[], int) from public, anon;
revoke execute on function delivery_slots_on_delivery() from public, anon, authenticated;
revoke execute on function can_record_insurance_rto(uuid, text) from public, anon, authenticated;
grant execute on function ops_branch_ok(uuid) to authenticated;
grant execute on function ops_can(text, text, uuid) to authenticated;
grant execute on function ops_stage_status(uuid) to authenticated;
grant execute on function ops_board(text, uuid) to authenticated;
grant execute on function ops_mark_stage(uuid, text, text, text, text) to authenticated;
grant execute on function request_stage_reversal(uuid, text, text) to authenticated;
grant execute on function decide_stage_reversal(uuid, boolean, text) to authenticated;
grant execute on function schedule_pdi(uuid, date, text) to authenticated;
grant execute on function record_pdi_result(uuid, jsonb, text, text[]) to authenticated;
grant execute on function cancel_pdi(uuid, text) to authenticated;
grant execute on function pdi_board(date, uuid) to authenticated;
grant execute on function issue_gate_pass(uuid) to authenticated;
grant execute on function record_gate_exit(text) to authenticated;
grant execute on function delivery_slot_settings(uuid) to authenticated;
grant execute on function book_delivery_slot(uuid, date, text, text) to authenticated;
grant execute on function cancel_delivery_slot(uuid, text) to authenticated;
grant execute on function delivery_schedule(date, date, uuid) to authenticated;
grant execute on function ops_config_update(boolean, text[], int) to authenticated;
