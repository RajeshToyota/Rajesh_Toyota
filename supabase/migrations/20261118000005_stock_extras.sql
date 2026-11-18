-- Phase 21: stock extras (Techwheels' SAP price difference, stock transfers, vehicle location / yard,
-- stock control, other dealers' stock and search console), re-keyed for Toyota.
--
--   Price difference  a booking priced on an older price list than today's cannot win a car in the pool
--                     until the difference is collected or waived by the Outlet Head (finishes the
--                     "not built" item of Phase 16).
--   Stock control     block a car (or flag it demo / damaged / management hold): it cannot be allotted.
--   Transfers         moving a car between branches: requested, approved by the sending branch, received.
--   Yard log          every movement of a car (yard, workshop, PDI bay, wash, battery check) and where it is now.
--   Other dealers     stock other Toyota dealers offer, uploaded from their lists and matched to VNA demand.
--   Search console    one search box for VIN, mobile, order number or name, and a timeline per car / booking.
-- In-transit cars need nothing new: the CTDMS Transit stock PDF (Phase 9 import) already brings them in.

-- ===== Modules and rights =====
insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('price_diff',       'stock', 'Price Difference', '/stock/price-diff',      35, true),
  ('stock_control',    'stock', 'Stock Control',    '/stock/control',        115, true),
  ('stock_transfers',  'stock', 'Stock Transfers',  '/stock/transfers',      120, true),
  ('vehicle_location', 'stock', 'Yard & Location',  '/stock/yard',           125, true),
  ('other_dealers',    'stock', 'Other Dealers',    '/stock/other-dealers',  130, true),
  ('search_console',   'sales', 'Search Console',   '/search',                50, true);

select seed_role_rights(r, m, x) from (values
  ('Outlet Head', 'price_diff', array['view','approve']), ('Outlet Head', 'stock_control', array['view','edit']),
  ('Outlet Head', 'stock_transfers', array['view','create','approve','edit']), ('Outlet Head', 'vehicle_location', array['view','edit']),
  ('Outlet Head', 'other_dealers', array['view','create']), ('Outlet Head', 'search_console', array['view']),
  ('Head Customer Relations', 'price_diff', array['view']), ('Head Customer Relations', 'stock_transfers', array['view','create']),
  ('Head Customer Relations', 'vehicle_location', array['view','edit']), ('Head Customer Relations', 'other_dealers', array['view','create']),
  ('Head Customer Relations', 'search_console', array['view']),
  ('Team Leader', 'search_console', array['view']), ('Team Leader', 'other_dealers', array['view']),
  ('Sales Consultant', 'search_console', array['view']),
  ('Accounts', 'price_diff', array['view','edit']), ('Accounts', 'search_console', array['view']),
  ('PDI Technician', 'vehicle_location', array['view','edit']), ('Gate Security', 'vehicle_location', array['view','edit']),
  ('Relationship Manager', 'search_console', array['view']), ('Relationship Manager', 'price_diff', array['view'])
) v(r, m, x);

-- ===== Price difference =====
-- Off until switched on deliberately: the pool may already be live, and turning this on can take a car
-- back from a winner whose price has risen since booking.
alter table pool_config add column price_diff_blocks boolean not null default false;

create table booking_price_diff_resolutions (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  difference numeric not null,
  resolution text not null check (resolution in ('collected', 'waived')),
  note text,
  resolved_by uuid references employees(id),
  resolved_at timestamptz not null default now()
);
create index idx_price_diff_res_booking on booking_price_diff_resolutions(booking_id);
create index idx_price_diff_res_resolved_by on booking_price_diff_resolutions(resolved_by);
alter table booking_price_diff_resolutions enable row level security;
create policy price_diff_res_select on booking_price_diff_resolutions for select to authenticated using (can_access_booking(booking_id));

-- The ex-showroom price that applied on a date to a variant and colour: the colour's own row, else the row
-- for its paint category (standard / pearl white / dual tone), on the booking's list (private, commercial, CSD).
create or replace function ex_showroom_on(p_variant_id uuid, p_color_id uuid, p_on date, p_list_type text default null)
returns numeric
language sql
stable
set search_path = public
as $$
  select p.ex_showroom_price
  from price_list p
  where p.variant_id = p_variant_id
    and p.effective_from <= p_on and (p.effective_to is null or p.effective_to >= p_on)
    and (p_list_type is null or p.list_type = p_list_type)
  order by p.color_id = p_color_id desc nulls last,
           p.paint_category = (select c.paint_category from colors c where c.id = p_color_id) desc nulls last,
           p.effective_from desc, p.ex_showroom_price
  limit 1;
$$;

-- Price on the date the booking was priced vs today. Positive: the price went up since.
create or replace function booking_price_difference(p_booking_id uuid, out booked_price numeric, out current_price numeric,
                                                    out difference numeric, out resolved numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or b.variant_id is null then return; end if;
  booked_price := ex_showroom_on(b.variant_id, b.color_id, coalesce(b.priced_as_of, b.created_at)::date, b.price_list_type);
  current_price := ex_showroom_on(b.variant_id, b.color_id, (now() at time zone 'Asia/Kolkata')::date, b.price_list_type);
  difference := coalesce(current_price - booked_price, 0);
  select max(r.difference) into resolved from booking_price_diff_resolutions r where r.booking_id = b.id;
end;
$$;

create or replace function price_diff_blocked(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select price_diff_blocks from pool_config), false)
     and coalesce((select d.difference > 0 and coalesce(d.resolved, 0) < d.difference from booking_price_difference(p_booking_id) d), false);
$$;

-- The pool's completion test, now also waiting on an unresolved price difference.
create or replace function pool_booking_completion(p_booking_id uuid, out completed_at timestamptz, out win_path text)
language plpgsql
stable
set search_path = public
as $$
declare
  c finance_cases%rowtype;
  v_deal numeric;
  v_pct numeric;
begin
  if price_diff_blocked(p_booking_id) then
    return;
  end if;
  select * into c from finance_cases where booking_id = p_booking_id and status <> 'rejected';
  if c.id is not null then
    if c.status in ('do_received', 'disbursed') then
      select min(e.created_at) into completed_at from finance_case_events e where e.case_id = c.id and e.status_to = 'do_received';
      completed_at := coalesce(completed_at, c.updated_at);
      win_path := 'do';
    end if;
    return;
  end if;

  select cash_payment_percentage into v_pct from pool_config;
  select a.deal_amount into v_deal from booking_account(p_booking_id) a;
  if coalesce(v_deal, 0) <= 0 then
    return;
  end if;
  select x.t into completed_at from (
    select greatest(r.created_at, r.cleared_on::timestamp at time zone 'Asia/Kolkata') as t,
           sum(r.amount) over (order by r.cleared_on, r.created_at, r.id) as running
    from payment_receipts r
    where r.booking_id = p_booking_id and r.clearance_status = 'cleared'
  ) x
  where x.running >= v_deal * v_pct / 100
  order by x.running
  limit 1;
  if completed_at is not null then
    win_path := 'cash';
  end if;
end;
$$;

create or replace function resolve_price_difference(p_booking_id uuid, p_resolution text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  d record;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null then raise exception 'Booking not found'; end if;
  if p_resolution = 'waived' and not ops_can('price_diff', 'approve', b.outlet_id) then
    raise exception 'Only the Outlet Head can waive a price difference';
  end if;
  if p_resolution = 'collected' and not (ops_can('price_diff', 'edit', b.outlet_id) or ops_can('price_diff', 'approve', b.outlet_id)) then
    raise exception 'Only Accounts or the Outlet Head can mark the difference collected';
  end if;
  if p_resolution not in ('collected', 'waived') then raise exception 'Resolution must be collected or waived'; end if;
  select * into d from booking_price_difference(b.id);
  if coalesce(d.difference, 0) <= 0 then raise exception 'There is no price difference on this booking'; end if;
  if p_resolution = 'waived' and nullif(btrim(p_note), '') is null then raise exception 'Give the reason for waiving'; end if;
  insert into booking_price_diff_resolutions (booking_id, difference, resolution, note, resolved_by)
  values (b.id, d.difference, p_resolution, nullif(btrim(p_note), ''), current_employee_id());
  perform pool_mark_booking_dirty(b.id);
end;
$$;

-- Open bookings whose price has gone up since they were priced, for the caller's branches.
create or replace function price_diff_list(p_outlet_id uuid default null, p_open_only boolean default true)
returns table (booking_id uuid, customer_name text, order_no text, outlet text, consultant text, model text, variant text,
               color text, priced_on date, booked_price numeric, current_price numeric, difference numeric,
               resolved numeric, last_resolution text, in_pool boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not has_right('price_diff', 'view') then raise exception 'You do not have access to price differences'; end if;
  return query
  select b.id, b.customer_name, coalesce(b.ctdms_order_booking_no, b.order_booking_no), o.name, e.name, mo.name, va.name, co.name,
         coalesce(b.priced_as_of, b.created_at)::date, d.booked_price, d.current_price, d.difference, d.resolved,
         (select r.resolution || coalesce(': ' || r.note, '') from booking_price_diff_resolutions r where r.booking_id = b.id order by r.resolved_at desc limit 1),
         exists (select 1 from pool_members pm where pm.booking_id = b.id and pm.status in ('active', 'allotted'))
  from bookings b
  cross join lateral booking_price_difference(b.id) d
  join outlets o on o.id = b.outlet_id
  left join employees e on e.id = b.employee_id
  left join variants va on va.id = b.variant_id
  left join models mo on mo.id = va.model_id
  left join colors co on co.id = b.color_id
  where b.status in ('booked', 'allocated') and d.difference > 0
    and (not p_open_only or coalesce(d.resolved, 0) < d.difference)
    and ops_branch_ok(b.outlet_id) and (p_outlet_id is null or b.outlet_id = p_outlet_id)
  order by d.difference desc;
end;
$$;

-- Switch the price-difference rule on or off (Admin / Business Head), logged in the pool audit.
create or replace function set_price_diff_blocks(p_on boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(current_employee_role_rank() <= 1, false) then
    raise exception 'Only the Admin or Business Head can change this';
  end if;
  update pool_config set price_diff_blocks = p_on, updated_by = current_employee_id(), updated_at = now();
  perform pool_log('config_change', null, null, null, null, jsonb_build_object('price_diff_blocks', p_on));
end;
$$;

-- ===== Stock control =====
create table stock_controls (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id),
  flag text not null check (flag in ('blocked', 'demo', 'damaged', 'management_hold')),
  reason text not null,
  set_by uuid references employees(id),
  set_at timestamptz not null default now(),
  cleared_by uuid references employees(id),
  cleared_at timestamptz,
  clear_note text
);
create unique index uq_stock_controls_active on stock_controls(vehicle_id) where cleared_at is null;
create index idx_stock_controls_vehicle on stock_controls(vehicle_id);
create index idx_stock_controls_set_by on stock_controls(set_by);
create index idx_stock_controls_cleared_by on stock_controls(cleared_by);
alter table stock_controls enable row level security;
create policy stock_controls_select on stock_controls for select to authenticated using (true);

-- A car under stock control is not free to allot (manual, FIFO, CTDMS or pool).
create or replace function vehicle_allotable(v vehicles)
returns boolean
language sql
stable
set search_path = public
as $$
  select v.status = 'available' and not v.missing_from_report and coalesce(v.ctdms_order_status, '') <> 'Invoiced'
    and not exists (select 1 from allotments a where a.vehicle_id = v.id and a.released_at is null)
    and not exists (select 1 from stock_controls s where s.vehicle_id = v.id and s.cleared_at is null);
$$;

create or replace function set_stock_control(p_vehicle_id uuid, p_flag text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v vehicles%rowtype;
  v_id uuid;
begin
  select * into v from vehicles where id = p_vehicle_id;
  if v.id is null or not ops_can('stock_control', 'edit', v.outlet_id) then raise exception 'Car not found'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  if exists (select 1 from allotments a where a.vehicle_id = v.id and a.released_at is null) then
    raise exception 'This car is allotted; release it first';
  end if;
  insert into stock_controls (vehicle_id, flag, reason, set_by) values (v.id, p_flag, btrim(p_reason), current_employee_id())
  returning id into v_id;
  perform pool_mark_dirty(v.variant_id, v.color_id);
  return v_id;
exception when unique_violation then
  raise exception 'This car is already under stock control';
end;
$$;

create or replace function clear_stock_control(p_vehicle_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v vehicles%rowtype;
begin
  select * into v from vehicles where id = p_vehicle_id;
  if v.id is null or not ops_can('stock_control', 'edit', v.outlet_id) then raise exception 'Car not found'; end if;
  update stock_controls set cleared_at = now(), cleared_by = current_employee_id(), clear_note = nullif(btrim(p_note), '')
  where vehicle_id = v.id and cleared_at is null;
  if not found then raise exception 'This car is not under stock control'; end if;
  perform pool_mark_dirty(v.variant_id, v.color_id);
end;
$$;

-- ===== Stock transfers =====
create table stock_transfers (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id),
  from_outlet_id uuid not null references outlets(id),
  to_outlet_id uuid not null references outlets(id),
  reason text not null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'received', 'rejected', 'cancelled')),
  requested_by uuid references employees(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references employees(id),
  decided_at timestamptz,
  decision_note text,
  received_by uuid references employees(id),
  received_at timestamptz,
  check (from_outlet_id <> to_outlet_id)
);
create unique index uq_stock_transfers_open on stock_transfers(vehicle_id) where status in ('requested', 'approved');
create index idx_stock_transfers_vehicle on stock_transfers(vehicle_id);
create index idx_stock_transfers_from on stock_transfers(from_outlet_id);
create index idx_stock_transfers_to on stock_transfers(to_outlet_id);
create index idx_stock_transfers_requested_by on stock_transfers(requested_by);
create index idx_stock_transfers_decided_by on stock_transfers(decided_by);
create index idx_stock_transfers_received_by on stock_transfers(received_by);
alter table stock_transfers enable row level security;
create policy stock_transfers_select on stock_transfers for select to authenticated
  using (ops_can('stock_transfers', 'view', from_outlet_id) or ops_can('stock_transfers', 'view', to_outlet_id));

-- Any branch may ask for a car another branch holds (for its customer), or send one of its own.
create or replace function request_stock_transfer(p_vehicle_id uuid, p_to_outlet_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v vehicles%rowtype;
  v_id uuid;
begin
  select * into v from vehicles where id = p_vehicle_id;
  if v.id is null then raise exception 'Car not found'; end if;
  if not (ops_can('stock_transfers', 'create', v.outlet_id) or ops_can('stock_transfers', 'create', p_to_outlet_id)) then
    raise exception 'You cannot request transfers for these branches';
  end if;
  if v.outlet_id = p_to_outlet_id then raise exception 'The car is already at that branch'; end if;
  if v.status = 'billed' then raise exception 'This car has been invoiced'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  insert into stock_transfers (vehicle_id, from_outlet_id, to_outlet_id, reason, requested_by)
  values (v.id, v.outlet_id, p_to_outlet_id, btrim(p_reason), current_employee_id())
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'A transfer of this car is already open';
end;
$$;

-- The sending branch approves or rejects; the receiving branch confirms the car arrived.
create or replace function move_stock_transfer(p_transfer_id uuid, p_status text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t stock_transfers%rowtype;
  v_to text;
begin
  select * into t from stock_transfers where id = p_transfer_id for update;
  if t.id is null then raise exception 'Transfer not found'; end if;
  if p_status in ('approved', 'rejected') then
    if t.status <> 'requested' then raise exception 'This transfer has been decided'; end if;
    if not ops_can('stock_transfers', 'approve', t.from_outlet_id) then raise exception 'Only the sending branch''s Outlet Head can decide'; end if;
    if p_status = 'rejected' and nullif(btrim(p_note), '') is null then raise exception 'Give the reason'; end if;
    update stock_transfers set status = p_status, decided_by = current_employee_id(), decided_at = now(), decision_note = nullif(btrim(p_note), '')
    where id = t.id;
    if p_status = 'approved' then
      select name into v_to from outlets where id = t.to_outlet_id;
      update vehicles set location = 'In transfer to ' || v_to where id = t.vehicle_id;
    end if;
  elsif p_status = 'received' then
    if t.status <> 'approved' then raise exception 'Only an approved transfer can be received'; end if;
    if not ops_can('stock_transfers', 'edit', t.to_outlet_id) then raise exception 'Only the receiving branch can confirm arrival'; end if;
    update stock_transfers set status = 'received', received_by = current_employee_id(), received_at = now() where id = t.id;
    update vehicles set outlet_id = t.to_outlet_id, location = 'Received from transfer' where id = t.vehicle_id;
    insert into vehicle_movements (vehicle_id, kind, to_location, note, moved_by)
    values (t.vehicle_id, 'transfer', 'Received from transfer', t.reason, current_employee_id());
  elsif p_status = 'cancelled' then
    if t.status not in ('requested', 'approved') then raise exception 'This transfer is closed'; end if;
    if not (t.requested_by = current_employee_id() or ops_can('stock_transfers', 'approve', t.from_outlet_id)) then
      raise exception 'Only the requester or the sending branch can cancel';
    end if;
    update stock_transfers set status = 'cancelled', decision_note = nullif(btrim(p_note), '') where id = t.id;
  else
    raise exception 'Unknown status';
  end if;
end;
$$;

create or replace function stock_transfer_list(p_open_only boolean default true)
returns table (id uuid, vehicle_id uuid, vin text, car text, from_outlet text, to_outlet text, from_outlet_id uuid, to_outlet_id uuid,
               reason text, status text, requested_by text, requested_at timestamptz, decided_by text, decision_note text, received_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select t.id, v.id, v.vin, concat_ws(' · ', mo.name, va.name, co.name), fo.name, tt.name, t.from_outlet_id, t.to_outlet_id, t.reason,
         t.status, rq.name, t.requested_at, dc.name, t.decision_note, t.received_at
  from stock_transfers t
  join vehicles v on v.id = t.vehicle_id
  join outlets fo on fo.id = t.from_outlet_id
  join outlets tt on tt.id = t.to_outlet_id
  left join variants va on va.id = v.variant_id
  left join models mo on mo.id = va.model_id
  left join colors co on co.id = v.color_id
  left join employees rq on rq.id = t.requested_by
  left join employees dc on dc.id = t.decided_by
  where not p_open_only or t.status in ('requested', 'approved')
  order by t.requested_at desc;
$$;

-- ===== Yard and vehicle location =====
create table yards (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references outlets(id),
  name text not null,
  is_active boolean not null default true,
  unique (outlet_id, name)
);
alter table yards enable row level security;
create policy yards_select on yards for select to authenticated using (true);
insert into yards (outlet_id, name)
select o.id, y from outlets o cross join unnest(array['Showroom floor', 'Main yard', 'Workshop', 'PDI bay', 'Delivery bay']) y
where o.is_active;

create table vehicle_movements (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id),
  kind text not null check (kind in ('yard_move', 'workshop', 'pdi', 'wash', 'battery_check', 'display', 'transfer', 'other')),
  yard_id uuid references yards(id),
  from_location text,
  to_location text,
  odometer_km int,
  battery_voltage numeric,
  note text,
  moved_by uuid references employees(id),
  moved_at timestamptz not null default now()
);
create index idx_vehicle_movements_vehicle on vehicle_movements(vehicle_id, moved_at);
create index idx_vehicle_movements_yard on vehicle_movements(yard_id);
create index idx_vehicle_movements_moved_by on vehicle_movements(moved_by);
alter table vehicle_movements enable row level security;
create policy vehicle_movements_select on vehicle_movements for select to authenticated using (true);

create or replace function log_vehicle_movement(p_vehicle_id uuid, p_kind text, p_yard_id uuid default null, p_note text default null,
                                                p_odometer_km int default null, p_battery_voltage numeric default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v vehicles%rowtype;
  y yards%rowtype;
  v_id uuid;
begin
  select * into v from vehicles where id = p_vehicle_id;
  if v.id is null or not ops_can('vehicle_location', 'edit', v.outlet_id) then raise exception 'Car not found'; end if;
  if v.source <> 'physical' then raise exception 'This car is still in transit'; end if;
  if p_yard_id is not null then
    select * into y from yards where id = p_yard_id and is_active;
    if y.id is null or y.outlet_id <> v.outlet_id then raise exception 'Pick a yard of this branch'; end if;
  end if;
  if p_kind = 'battery_check' and p_battery_voltage is null then raise exception 'Record the battery voltage'; end if;
  insert into vehicle_movements (vehicle_id, kind, yard_id, from_location, to_location, odometer_km, battery_voltage, note, moved_by)
  values (v.id, p_kind, y.id, v.location, coalesce(y.name, v.location), p_odometer_km, p_battery_voltage, nullif(btrim(p_note), ''),
          current_employee_id())
  returning id into v_id;
  if y.id is not null then
    update vehicles set location = y.name where id = v.id;
  end if;
  return v_id;
end;
$$;

-- Physical cars at the caller's branches, where each one is and when it was last touched.
create or replace function yard_stock(p_outlet_id uuid default null)
returns table (vehicle_id uuid, vin text, car text, outlet text, outlet_id uuid, status text, location text, last_kind text,
               last_moved_at timestamptz, days_since_move int, last_battery_check timestamptz, control text, customer_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not has_right('vehicle_location', 'view') then raise exception 'You do not have access to the yard'; end if;
  return query
  select v.id, v.vin, concat_ws(' · ', mo.name, va.name, co.name), o.name, v.outlet_id, v.status, v.location, lm.kind, lm.moved_at,
         (current_date - coalesce(lm.moved_at, v.first_seen_at)::date)::int,
         (select max(m.moved_at) from vehicle_movements m where m.vehicle_id = v.id and m.kind = 'battery_check'),
         (select s.flag from stock_controls s where s.vehicle_id = v.id and s.cleared_at is null),
         (select b.customer_name from allotments a join bookings b on b.id = a.booking_id where a.vehicle_id = v.id and a.released_at is null)
  from vehicles v
  join outlets o on o.id = v.outlet_id
  left join variants va on va.id = v.variant_id
  left join models mo on mo.id = va.model_id
  left join colors co on co.id = v.color_id
  left join lateral (select m.kind, m.moved_at from vehicle_movements m where m.vehicle_id = v.id order by m.moved_at desc limit 1) lm on true
  where v.source = 'physical' and v.status <> 'billed' and not v.missing_from_report
    and ops_branch_ok(v.outlet_id) and (p_outlet_id is null or v.outlet_id = p_outlet_id)
  order by o.name, v.location nulls first, v.vin;
end;
$$;

-- ===== Other Toyota dealers' stock =====
create table other_dealer_stock (
  id uuid primary key default gen_random_uuid(),
  dealer_name text not null,
  dealer_code text,
  city text,
  contact text,
  suffix_code text,
  color_code text,
  variant_id uuid references variants(id),
  color_id uuid references colors(id),
  vin text,
  quantity int not null default 1 check (quantity > 0),
  offer_note text,
  reported_on date not null default current_date,
  uploaded_by uuid references employees(id),
  uploaded_at timestamptz not null default now()
);
create index idx_other_dealer_stock_variant_color on other_dealer_stock(variant_id, color_id);
create index idx_other_dealer_stock_color on other_dealer_stock(color_id);
create index idx_other_dealer_stock_uploaded_by on other_dealer_stock(uploaded_by);
alter table other_dealer_stock enable row level security;
create policy other_dealer_stock_select on other_dealer_stock for select to authenticated using (has_right('other_dealers', 'view'));

-- Replace one dealer's list. rows: [{suffix_code, color_code, vin, quantity, offer_note}], codes as in CTDMS.
create or replace function import_other_dealer_stock(p_dealer_name text, p_dealer_code text, p_city text, p_contact text, p_rows jsonb)
returns table (loaded int, unmapped int)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_loaded int;
  v_unmapped int;
begin
  if not has_right('other_dealers', 'create') then raise exception 'You cannot upload other dealers'' stock'; end if;
  if nullif(btrim(p_dealer_name), '') is null then raise exception 'Enter the dealer''s name'; end if;
  delete from other_dealer_stock where upper(dealer_name) = upper(btrim(p_dealer_name));
  insert into other_dealer_stock (dealer_name, dealer_code, city, contact, suffix_code, color_code, variant_id, color_id, vin,
                                  quantity, offer_note, uploaded_by)
  select btrim(p_dealer_name), nullif(btrim(p_dealer_code), ''), nullif(btrim(p_city), ''), nullif(btrim(p_contact), ''),
         upper(btrim(r->>'suffix_code')), upper(btrim(r->>'color_code')),
         (select va.id from variants va where upper(va.tkm_suffix_code) = upper(btrim(r->>'suffix_code')) limit 1),
         (select c.id from colors c where upper(c.tkm_color_code) = upper(btrim(r->>'color_code')) limit 1),
         nullif(upper(btrim(r->>'vin')), ''), coalesce(nullif(r->>'quantity', '')::int, 1), nullif(btrim(r->>'offer_note'), ''),
         current_employee_id()
  from jsonb_array_elements(p_rows) r
  where nullif(btrim(r->>'suffix_code'), '') is not null;
  get diagnostics v_loaded = row_count;
  select count(*) into v_unmapped from other_dealer_stock
  where upper(dealer_name) = upper(btrim(p_dealer_name)) and (variant_id is null or color_id is null);
  return query select v_loaded, v_unmapped;
end;
$$;

-- VNA demand (bookings waiting beyond free stock) matched to what other dealers offer.
create or replace function vna_other_dealer_matches(p_outlet_id uuid default null)
returns table (booking_id uuid, customer_name text, outlet text, model text, variant text, color text, days_waiting int,
               queue_position int, free_cars int, dealer_name text, dealer_city text, dealer_contact text, quantity int,
               offer_note text, reported_on date)
language sql
stable
security definer
set search_path = public
as $$
  select d.booking_id, d.customer_name, d.outlet, d.model_name, d.variant_name, d.color_name, d.days_waiting, d.queue_position,
         d.free_cars, s.dealer_name, s.city, s.contact, s.quantity, s.offer_note, s.reported_on
  from pool_vna_demand(p_outlet_id) d
  join bookings b on b.id = d.booking_id
  join other_dealer_stock s on s.variant_id = b.variant_id and s.color_id = b.color_id
  where has_right('other_dealers', 'view')
  order by d.days_waiting desc, s.reported_on desc;
$$;

-- ===== Search console =====
create or replace function search_console(p_q text)
returns table (kind text, id uuid, title text, subtitle text, status text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_q text := upper(btrim(p_q));
  v_mobile text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
begin
  if not has_right('search_console', 'view') then raise exception 'You do not have access to search'; end if;
  if length(v_q) < 3 then raise exception 'Type at least 3 characters'; end if;
  return query
  select 'booking', b.id, b.customer_name,
         concat_ws(' · ', coalesce(b.ctdms_order_booking_no, b.order_booking_no), coalesce(c.mobile, b.customer_mobile), mo.name, o.name),
         b.status
  from bookings b
  join outlets o on o.id = b.outlet_id
  left join customers c on c.id = b.customer_id
  left join variants va on va.id = b.variant_id
  left join models mo on mo.id = va.model_id
  where (upper(b.customer_name) like '%' || v_q || '%'
         or upper(coalesce(b.ctdms_order_booking_no, '')) like '%' || v_q || '%'
         or upper(coalesce(b.order_booking_no, '')) like '%' || v_q || '%'
         or (length(v_mobile) >= 6 and coalesce(c.mobile, b.customer_mobile, '') like '%' || v_mobile || '%'))
    and (can_access_employee_data(current_employee_id(), b.employee_id) or ops_branch_ok(b.outlet_id) and is_crm_back_office()
         or b.rm_employee_id = current_employee_id() or (is_accounts() and b.outlet_id = current_employee_outlet_id()))
  union all
  select 'vehicle', v.id, v.vin, concat_ws(' · ', mo.name, va.name, co.name, o.name, v.location), v.status
  from vehicles v
  join outlets o on o.id = v.outlet_id
  left join variants va on va.id = v.variant_id
  left join models mo on mo.id = va.model_id
  left join colors co on co.id = v.color_id
  where (v.vin like '%' || v_q || '%' or upper(coalesce(v.engine_no, '')) like '%' || v_q || '%')
  union all
  select 'enquiry', e.id, c.name, concat_ws(' · ', c.mobile, mo.name, emp.name), e.stage
  from enquiries e
  join customers c on c.id = e.customer_id
  left join models mo on mo.id = e.model_id
  left join employees emp on emp.id = e.assigned_employee_id
  where (upper(c.name) like '%' || v_q || '%' or (length(v_mobile) >= 6 and c.mobile like '%' || v_mobile || '%'))
    and (can_access_employee_data(current_employee_id(), e.assigned_employee_id) or (is_crm_back_office() and ops_branch_ok(e.outlet_id)))
  limit 100;
end;
$$;

-- Everything that happened to a car, oldest first.
create or replace function vehicle_timeline(p_vehicle_id uuid)
returns table (at timestamptz, event text, detail text, by_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not has_right('search_console', 'view') then raise exception 'You do not have access to search'; end if;
  return query
  select * from (
    select v.first_seen_at, 'First seen in CTDMS stock', concat_ws(' · ', v.source, v.billing_desc), null::text from vehicles v where v.id = p_vehicle_id
    union all
    select a.allotted_at, 'Allotted (' || a.method || ')', b.customer_name, e.name
    from allotments a join bookings b on b.id = a.booking_id left join employees e on e.id = a.allotted_by where a.vehicle_id = p_vehicle_id
    union all
    select a.released_at, 'Allotment released', a.release_reason, e.name
    from allotments a left join employees e on e.id = a.released_by where a.vehicle_id = p_vehicle_id and a.released_at is not null
    union all
    select r.requested_at, 'Sent for billing', null, e.name from billing_requests r left join employees e on e.id = r.requested_by where r.vehicle_id = p_vehicle_id
    union all
    select r.invoiced_at, 'Invoiced', r.invoice_no, e.name from billing_requests r left join employees e on e.id = r.invoiced_by where r.vehicle_id = p_vehicle_id and r.invoiced_at is not null
    union all
    select m.moved_at, 'Moved: ' || m.kind, concat_ws(' → ', m.from_location, m.to_location) || coalesce(' · ' || m.note, ''), e.name
    from vehicle_movements m left join employees e on e.id = m.moved_by where m.vehicle_id = p_vehicle_id
    union all
    select s.set_at, 'Stock control: ' || s.flag, s.reason, e.name from stock_controls s left join employees e on e.id = s.set_by where s.vehicle_id = p_vehicle_id
    union all
    select s.cleared_at, 'Stock control cleared', s.clear_note, e.name from stock_controls s left join employees e on e.id = s.cleared_by where s.vehicle_id = p_vehicle_id and s.cleared_at is not null
    union all
    select t.requested_at, 'Transfer ' || t.status, concat_ws(' → ', fo.name, tt.name) || ' · ' || t.reason, e.name
    from stock_transfers t join outlets fo on fo.id = t.from_outlet_id join outlets tt on tt.id = t.to_outlet_id
    left join employees e on e.id = t.requested_by where t.vehicle_id = p_vehicle_id
    union all
    select i.inspected_at, 'PDI ' || i.status, i.remarks, e.name from pdi_inspections i left join employees e on e.id = i.inspected_by where i.vehicle_id = p_vehicle_id and i.inspected_at is not null
    union all
    select g.issued_at, 'Gate pass ' || g.gate_pass_no, case when g.voided_at is not null then 'Cancelled' end, e.name from gate_passes g left join employees e on e.id = g.issued_by where g.vehicle_id = p_vehicle_id
    union all
    select g.exited_at, 'Left the yard', g.gate_pass_no, e.name from gate_passes g left join employees e on e.id = g.exit_recorded_by where g.vehicle_id = p_vehicle_id and g.exited_at is not null
    union all
    select p.created_at, 'Pool: ' || p.event, p.details::text, e.name from pool_audit_log p left join employees e on e.id = p.by_employee_id where p.vehicle_id = p_vehicle_id
  ) x(at, event, detail, by_name)
  where x.at is not null
  order by x.at;
end;
$$;

-- ===== Grants =====
do $$
declare
  f text;
begin
  foreach f in array array[
    'booking_price_difference(uuid)', 'resolve_price_difference(uuid, text, text)', 'set_price_diff_blocks(boolean)', 'price_diff_list(uuid, boolean)',
    'set_stock_control(uuid, text, text)', 'clear_stock_control(uuid, text)', 'request_stock_transfer(uuid, uuid, text)',
    'move_stock_transfer(uuid, text, text)', 'stock_transfer_list(boolean)', 'log_vehicle_movement(uuid, text, uuid, text, int, numeric)',
    'yard_stock(uuid)', 'import_other_dealer_stock(text, text, text, text, jsonb)', 'vna_other_dealer_matches(uuid)',
    'search_console(text)', 'vehicle_timeline(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke execute on function ex_showroom_on(uuid, uuid, date, text) from public, anon;
grant execute on function ex_showroom_on(uuid, uuid, date, text) to authenticated;
revoke execute on function price_diff_blocked(uuid) from public, anon, authenticated;
revoke execute on function vehicle_allotable(vehicles) from public, anon, authenticated;
revoke execute on function pool_booking_completion(uuid) from public, anon, authenticated;
