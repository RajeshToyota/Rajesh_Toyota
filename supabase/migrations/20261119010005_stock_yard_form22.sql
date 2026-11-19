-- Phase 27: stock & inventory, yard and Form 22 — Techwheels' stock logic re-keyed for Toyota.
--
-- Stock control becomes a ledger (Techwheels' stock_control): DEDUCT takes a car out of free stock,
-- ADD puts back one the CTDMS report no longer lists (a cancelled billing, a demo car on sale). Each
-- entry has a reason and an optional end date. Free stock = in the report (transit or physical) or
-- added, and not deducted, and not sent to another dealer.
--
-- Dealer transfers (Techwheels' ManageStockTransfers) next to the branch transfers: inward from
-- another Toyota dealer creates the car on receipt and, when it was bought in for a customer, allots
-- it to that booking at once so the pool cannot hand it to anyone else; outward takes the car out of
-- free stock from the moment it is approved.
--
-- Also: transit logistics from the dispatch file, the chassis monitor, search modes, other-dealer
-- matches on nearby suffixes and other colours, stock planning (weighted sales, VNA, open orders),
-- and the yard: capacity, a Delivered yard each car moves to on delivery, Form 22 / CNG documents per
-- car, battery-change cases at 90 days, job cards, receiving cars from transit.

-- ===== Stock control ledger =====
alter table stock_controls drop constraint stock_controls_flag_check;
alter table stock_controls
  add column state text not null default 'deduct' check (state in ('add', 'deduct')),
  add column reason_code text check (reason_code in ('cancelled_billing', 'demo_in_use', 'demo_on_sale', 'management_hold',
                                                     'management_release', 'damage', 'stna', 'other')),
  add column effective_to date;
alter table stock_controls add constraint stock_controls_flag_check
  check (flag in ('blocked', 'demo', 'damaged', 'management_hold', 'added'));
update stock_controls set reason_code = case flag when 'demo' then 'demo_in_use' when 'damaged' then 'damage'
                                                  when 'management_hold' then 'management_hold' else 'other' end
where reason_code is null;

create or replace function stock_control_active(s stock_controls)
returns boolean
language sql
stable
set search_path = public
as $$
  select s.cleared_at is null and (s.effective_to is null or s.effective_to >= (now() at time zone 'Asia/Kolkata')::date);
$$;

create or replace function vehicle_stock_added(p_vehicle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from stock_controls s where s.vehicle_id = p_vehicle_id and s.state = 'add' and stock_control_active(s));
$$;

-- ===== Dealer transfers =====
create table other_dealers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  dealer_code text,
  city text,
  emails text[] not null default '{}' check (cardinality(emails) <= 5),
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table other_dealers enable row level security;
create policy other_dealers_select on other_dealers for select to authenticated using (true);
create policy other_dealers_write on other_dealers for all to authenticated
  using (has_right('stock_transfers', 'approve') or is_master_data_admin())
  with check (has_right('stock_transfers', 'approve') or is_master_data_admin());

alter table stock_transfers drop constraint stock_transfers_status_check;
alter table stock_transfers add constraint stock_transfers_status_check
  check (status in ('requested', 'approved', 'dispatched', 'received', 'ctdms_done', 'rejected', 'cancelled'));
alter table stock_transfers
  alter column vehicle_id drop not null,
  alter column from_outlet_id drop not null,
  alter column to_outlet_id drop not null,
  add column direction text not null default 'branch' check (direction in ('branch', 'inward', 'outward')),
  add column other_dealer_id uuid references other_dealers(id),
  add column transfer_order_no text,
  add column ctdms_order_no text,
  add column booking_id uuid references bookings(id),
  add column inward_vin text check (inward_vin is null or inward_vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  add column inward_variant_id uuid references variants(id),
  add column inward_color_id uuid references colors(id),
  add column dispatched_at timestamptz,
  add column ctdms_done_at timestamptz,
  add constraint stock_transfers_shape check (
    (direction = 'branch' and vehicle_id is not null and from_outlet_id is not null and to_outlet_id is not null and other_dealer_id is null)
    or (direction = 'outward' and vehicle_id is not null and from_outlet_id is not null and other_dealer_id is not null)
    or (direction = 'inward' and to_outlet_id is not null and other_dealer_id is not null and inward_vin is not null
        and inward_variant_id is not null and inward_color_id is not null));
create index idx_stock_transfers_dealer on stock_transfers(other_dealer_id);
create index idx_stock_transfers_booking on stock_transfers(booking_id);
create index idx_stock_transfers_inward_variant on stock_transfers(inward_variant_id);
create index idx_stock_transfers_inward_color on stock_transfers(inward_color_id);

drop policy stock_transfers_select on stock_transfers;
create policy stock_transfers_select on stock_transfers for select to authenticated
  using ((from_outlet_id is not null and ops_can('stock_transfers', 'view', from_outlet_id))
         or (to_outlet_id is not null and ops_can('stock_transfers', 'view', to_outlet_id)));

-- A car is free when it is in the report (or added), not deducted, not allotted, not going to
-- another dealer. Everything that allots (manual, FIFO, CTDMS, pool) asks this.
create or replace function vehicle_allotable(v vehicles)
returns boolean
language sql
stable
set search_path = public
as $$
  select v.status = 'available'
    and ((not v.missing_from_report and coalesce(v.ctdms_order_status, '') <> 'Invoiced') or vehicle_stock_added(v.id))
    and not exists (select 1 from allotments a where a.vehicle_id = v.id and a.released_at is null)
    and not exists (select 1 from stock_controls s where s.vehicle_id = v.id and s.state = 'deduct' and stock_control_active(s))
    and not exists (select 1 from stock_transfers t where t.vehicle_id = v.id and t.direction = 'outward'
                    and t.status not in ('rejected', 'cancelled'));
$$;

-- Put a car under control: DEDUCT (out of free stock) or ADD (back into free stock).
create or replace function set_stock_control_v2(p_vehicle_id uuid, p_state text, p_reason_code text, p_reason text, p_effective_to date default null)
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
  if p_state not in ('add', 'deduct') then raise exception 'Choose add or deduct'; end if;
  if p_reason_code is null then raise exception 'Choose the reason'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  if p_effective_to is not null and p_effective_to < (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'The end date has passed';
  end if;
  if exists (select 1 from allotments a where a.vehicle_id = v.id and a.released_at is null) then
    raise exception 'This car is allotted; release it first';
  end if;
  if p_state = 'add' then
    if not ops_can('stock_control', 'approve', v.outlet_id) then
      raise exception 'Adding a car back to free stock needs Stock Control: approve';
    end if;
    if v.status <> 'available' then raise exception 'Only a car that is not billed can be added back'; end if;
  end if;
  -- An expired entry no longer blocks a new one.
  update stock_controls set cleared_at = now(), cleared_by = current_employee_id(), clear_note = 'Ended'
  where vehicle_id = v.id and cleared_at is null and effective_to is not null and effective_to < (now() at time zone 'Asia/Kolkata')::date;
  insert into stock_controls (vehicle_id, flag, reason, set_by, state, reason_code, effective_to)
  values (v.id,
          case when p_state = 'add' then 'added' when p_reason_code = 'damage' then 'damaged'
               when p_reason_code like 'demo%' then 'demo' when p_reason_code = 'management_hold' then 'management_hold' else 'blocked' end,
          btrim(p_reason), current_employee_id(), p_state, p_reason_code, p_effective_to)
  returning id into v_id;
  perform pool_mark_dirty(v.variant_id, v.color_id);
  return v_id;
exception when unique_violation then
  raise exception 'This car is already under stock control';
end;
$$;

create or replace function request_dealer_transfer(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dir text := p->>'direction';
  v_dealer uuid := (p->>'other_dealer_id')::uuid;
  v vehicles%rowtype;
  v_outlet uuid := nullif(p->>'outlet_id', '')::uuid;
  v_booking bookings%rowtype;
  v_id uuid;
begin
  if v_dir not in ('inward', 'outward') then raise exception 'Choose inward or outward'; end if;
  if not exists (select 1 from other_dealers where id = v_dealer and is_active) then raise exception 'Pick the other dealer'; end if;
  if nullif(btrim(p->>'reason'), '') is null then raise exception 'Give the reason'; end if;
  if v_dir = 'outward' then
    select * into v from vehicles where id = (p->>'vehicle_id')::uuid;
    if v.id is null or not ops_can('stock_transfers', 'create', v.outlet_id) then raise exception 'Car not found'; end if;
    if not vehicle_allotable(v) then raise exception 'Only a free car can be sent to another dealer'; end if;
    insert into stock_transfers (direction, vehicle_id, from_outlet_id, other_dealer_id, transfer_order_no, reason, requested_by)
    values ('outward', v.id, v.outlet_id, v_dealer, nullif(btrim(p->>'transfer_order_no'), ''), btrim(p->>'reason'), current_employee_id())
    returning id into v_id;
    perform pool_mark_dirty(v.variant_id, v.color_id);
  else
    if v_outlet is null or not ops_can('stock_transfers', 'create', v_outlet) then raise exception 'Pick your branch'; end if;
    if nullif(p->>'booking_id', '') is not null then
      select * into v_booking from bookings where id = (p->>'booking_id')::uuid;
      if v_booking.id is null or v_booking.status <> 'booked' then raise exception 'The customer''s booking must be booked and not yet allotted'; end if;
      if v_booking.variant_id <> (p->>'variant_id')::uuid or v_booking.color_id <> (p->>'color_id')::uuid then
        raise exception 'The car does not match the customer''s variant and colour';
      end if;
    end if;
    insert into stock_transfers (direction, to_outlet_id, other_dealer_id, transfer_order_no, ctdms_order_no, reason, requested_by,
                                 booking_id, inward_vin, inward_variant_id, inward_color_id)
    values ('inward', v_outlet, v_dealer, nullif(btrim(p->>'transfer_order_no'), ''), nullif(btrim(p->>'ctdms_order_no'), ''),
            btrim(p->>'reason'), current_employee_id(), v_booking.id, upper(btrim(p->>'vin')), (p->>'variant_id')::uuid, (p->>'color_id')::uuid)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- approved / rejected (branch Outlet Head) → dispatched (outward) or received (inward) → ctdms_done.
create or replace function move_dealer_transfer(p_transfer_id uuid, p_status text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t stock_transfers%rowtype;
  v_outlet uuid;
  v_vehicle uuid;
  v_yard uuid;
  v_dealer text;
begin
  select * into t from stock_transfers where id = p_transfer_id for update;
  if t.id is null or t.direction = 'branch' then raise exception 'Transfer not found'; end if;
  v_outlet := coalesce(t.from_outlet_id, t.to_outlet_id);
  select name into v_dealer from other_dealers where id = t.other_dealer_id;
  if p_status in ('approved', 'rejected') then
    if t.status <> 'requested' then raise exception 'This transfer has been decided'; end if;
    if not ops_can('stock_transfers', 'approve', v_outlet) then raise exception 'Only the branch''s Outlet Head can decide'; end if;
    if p_status = 'rejected' and nullif(btrim(p_note), '') is null then raise exception 'Give the reason'; end if;
    update stock_transfers set status = p_status, decided_by = current_employee_id(), decided_at = now(), decision_note = nullif(btrim(p_note), '')
    where id = t.id;
  elsif p_status = 'dispatched' then
    if t.direction <> 'outward' or t.status <> 'approved' then raise exception 'Only an approved outward transfer can be dispatched'; end if;
    if not ops_can('stock_transfers', 'edit', v_outlet) then raise exception 'You cannot move this branch''s stock'; end if;
    update stock_transfers set status = 'dispatched', dispatched_at = now() where id = t.id;
    update vehicles set location = 'Sent to ' || v_dealer where id = t.vehicle_id;
    insert into vehicle_movements (vehicle_id, kind, movement_type, to_location, note, moved_by)
    values (t.vehicle_id, 'transfer', 'outward', 'Sent to ' || v_dealer, t.reason, current_employee_id());
  elsif p_status = 'received' then
    if t.direction <> 'inward' or t.status <> 'approved' then raise exception 'Only an approved inward transfer can be received'; end if;
    if not ops_can('stock_transfers', 'edit', v_outlet) then raise exception 'You cannot receive for this branch'; end if;
    insert into vehicles (vin, outlet_id, source, variant_id, color_id, location, report_date)
    values (t.inward_vin, t.to_outlet_id, 'physical', t.inward_variant_id, t.inward_color_id, 'Received from ' || v_dealer, current_date)
    on conflict (vin) do update set outlet_id = excluded.outlet_id, source = 'physical', missing_from_report = false,
      status = case when vehicles.status = 'billed' then 'available' else vehicles.status end, location = excluded.location
    returning id into v_vehicle;
    -- The report will not list a car bought in from another dealer until CTDMS catches up: keep it in free stock.
    insert into stock_controls (vehicle_id, flag, reason, set_by, state, reason_code)
    select v_vehicle, 'added', 'Inward transfer from ' || v_dealer, current_employee_id(), 'add', 'other'
    where not exists (select 1 from stock_controls where vehicle_id = v_vehicle and cleared_at is null);
    select id into v_yard from yards where outlet_id = t.to_outlet_id and kind = 'normal' and is_active order by name limit 1;
    insert into vehicle_movements (vehicle_id, kind, movement_type, yard_id, to_location, note, moved_by)
    values (v_vehicle, 'transfer', 'inward', v_yard, 'Received from ' || v_dealer, t.reason, current_employee_id());
    update stock_transfers set status = 'received', vehicle_id = v_vehicle, received_by = current_employee_id(), received_at = now() where id = t.id;
    -- Bought in for a customer: allot before the pool sees the car.
    if t.booking_id is not null and booking_allotable(t.booking_id) then
      perform allot_vehicle_core(t.booking_id, v_vehicle, 'manual', 'Inward transfer for this customer', current_employee_id());
    end if;
  elsif p_status = 'ctdms_done' then
    if t.status not in ('dispatched', 'received') then raise exception 'Mark CTDMS done after the car has moved'; end if;
    if not ops_can('stock_transfers', 'edit', v_outlet) then raise exception 'You cannot change this transfer'; end if;
    update stock_transfers set status = 'ctdms_done', ctdms_done_at = now(), decision_note = coalesce(nullif(btrim(p_note), ''), decision_note) where id = t.id;
  elsif p_status = 'cancelled' then
    if t.status not in ('requested', 'approved') then raise exception 'This transfer is closed'; end if;
    if not (t.requested_by = current_employee_id() or ops_can('stock_transfers', 'approve', v_outlet)) then
      raise exception 'Only the requester or the Outlet Head can cancel';
    end if;
    update stock_transfers set status = 'cancelled', decision_note = nullif(btrim(p_note), '') where id = t.id;
  else
    raise exception 'Unknown status';
  end if;
  if t.vehicle_id is not null then
    perform pool_mark_dirty(v.variant_id, v.color_id) from vehicles v where v.id = t.vehicle_id;
  end if;
end;
$$;

create or replace function dealer_transfer_list(p_open_only boolean default true)
returns table (id uuid, direction text, dealer text, outlet text, vin text, car text, customer_name text, transfer_order_no text,
               ctdms_order_no text, reason text, status text, requested_at timestamptz, decided_at timestamptz,
               dispatched_at timestamptz, received_at timestamptz, ctdms_done_at timestamptz, billed_on date, delivered_on date)
language sql
stable
security invoker
set search_path = public
as $$
  select t.id, t.direction, d.name, o.name, coalesce(v.vin, t.inward_vin),
         concat_ws(' · ', mo.name, va.name, co.name), b.customer_name, t.transfer_order_no, t.ctdms_order_no, t.reason, t.status,
         t.requested_at, t.decided_at, t.dispatched_at, t.received_at, t.ctdms_done_at,
         (select br.invoice_date from billing_requests br where br.vehicle_id = v.id and br.status = 'invoiced' limit 1),
         (select dl.delivered_at::date from allotments a join deliveries dl on dl.booking_id = a.booking_id
          where a.vehicle_id = v.id and dl.status = 'delivered' limit 1)
  from stock_transfers t
  join other_dealers d on d.id = t.other_dealer_id
  join outlets o on o.id = coalesce(t.from_outlet_id, t.to_outlet_id)
  left join vehicles v on v.id = t.vehicle_id
  left join variants va on va.id = coalesce(v.variant_id, t.inward_variant_id)
  left join models mo on mo.id = va.model_id
  left join colors co on co.id = coalesce(v.color_id, t.inward_color_id)
  left join bookings b on b.id = t.booking_id
  where t.direction <> 'branch' and (not p_open_only or t.status in ('requested', 'approved', 'dispatched', 'received'))
  order by t.requested_at desc;
$$;

-- ===== Transit logistics =====
create table vehicle_transit_details (
  vin text primary key check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  tkm_invoice_no text,
  tkm_invoice_date date,
  trailer_no text,
  transporter text,
  current_location text,
  expected_arrival date,
  updated_by uuid references employees(id),
  updated_at timestamptz not null default now()
);
create index idx_vehicle_transit_details_by on vehicle_transit_details(updated_by);
alter table vehicle_transit_details enable row level security;
create policy vehicle_transit_details_select on vehicle_transit_details for select to authenticated using (true);

-- rows: [{vin, tkm_invoice_no, tkm_invoice_date, trailer_no, transporter, current_location, expected_arrival}]
create or replace function import_transit_details(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if not has_right('stock_import', 'create') then raise exception 'You cannot import stock files'; end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r where upper(btrim(r->>'vin')) !~ '^[A-HJ-NPR-Z0-9]{17}$') then
    raise exception 'Every row needs a 17-character VIN; nothing was imported';
  end if;
  insert into vehicle_transit_details (vin, tkm_invoice_no, tkm_invoice_date, trailer_no, transporter, current_location, expected_arrival, updated_by)
  select upper(btrim(r->>'vin')), nullif(btrim(r->>'tkm_invoice_no'), ''), nullif(r->>'tkm_invoice_date', '')::date,
         nullif(btrim(r->>'trailer_no'), ''), nullif(btrim(r->>'transporter'), ''), nullif(btrim(r->>'current_location'), ''),
         nullif(r->>'expected_arrival', '')::date, current_employee_id()
  from jsonb_array_elements(p_rows) r
  on conflict (vin) do update set tkm_invoice_no = coalesce(excluded.tkm_invoice_no, vehicle_transit_details.tkm_invoice_no),
    tkm_invoice_date = coalesce(excluded.tkm_invoice_date, vehicle_transit_details.tkm_invoice_date),
    trailer_no = coalesce(excluded.trailer_no, vehicle_transit_details.trailer_no),
    transporter = coalesce(excluded.transporter, vehicle_transit_details.transporter),
    current_location = coalesce(excluded.current_location, vehicle_transit_details.current_location),
    expected_arrival = coalesce(excluded.expected_arrival, vehicle_transit_details.expected_arrival),
    updated_by = excluded.updated_by, updated_at = now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ===== Chassis monitor =====
create or replace function chassis_monitor(p_outlet_id uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'ready_for_billing', (select count(*) from billing_requests br where br.status = 'pending'
                          and (p_outlet_id is null or br.outlet_id = p_outlet_id) and ops_branch_ok(br.outlet_id)),
    'billed_not_delivered', (select count(*) from billing_requests br join bookings b on b.id = br.booking_id
                             where br.status = 'invoiced' and b.status <> 'delivered'
                               and (p_outlet_id is null or br.outlet_id = p_outlet_id) and ops_branch_ok(br.outlet_id)),
    'outward_still_in_report', (select count(*) from stock_transfers t join vehicles v on v.id = t.vehicle_id
                                where t.direction = 'outward' and t.status in ('dispatched', 'ctdms_done') and not v.missing_from_report
                                  and (p_outlet_id is null or v.outlet_id = p_outlet_id) and ops_branch_ok(v.outlet_id)),
    'controls', coalesce((select jsonb_agg(jsonb_build_object('state', state, 'reason', reason_code, 'cars', n))
                          from (select s.state, s.reason_code, count(*) n from stock_controls s join vehicles v on v.id = s.vehicle_id
                                where stock_control_active(s) and (p_outlet_id is null or v.outlet_id = p_outlet_id) and ops_branch_ok(v.outlet_id)
                                group by 1, 2) x), '[]'),
    'free', (select count(*) from vehicles v where vehicle_allotable(v) and (p_outlet_id is null or v.outlet_id = p_outlet_id) and ops_branch_ok(v.outlet_id)),
    'in_transit', (select count(*) from vehicles v where v.source = 'transit' and v.status <> 'billed' and not v.missing_from_report
                   and (p_outlet_id is null or v.outlet_id = p_outlet_id) and ops_branch_ok(v.outlet_id))
  )
  where has_right('stock_monitor', 'view');
$$;

-- ===== Search modes =====
create or replace function search_console_mode(p_mode text, p_q text)
returns table (kind text, id uuid, title text, subtitle text, status text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_q text := upper(btrim(p_q));
begin
  if not has_right('search_console', 'view') then raise exception 'You do not have access to search'; end if;
  if p_mode = 'variant' then
    if length(v_q) < 3 then raise exception 'Type at least 3 characters'; end if;
    return query
    select 'vehicle', v.id, v.vin, concat_ws(' · ', mo.name, va.name, co.name, o.name, v.location), v.status
    from vehicles v join outlets o on o.id = v.outlet_id
    left join variants va on va.id = v.variant_id left join models mo on mo.id = va.model_id left join colors co on co.id = v.color_id
    where (upper(coalesce(va.tkm_suffix_code, v.ctdms_suffix_code, '')) like v_q || '%' or upper(coalesce(va.name, '')) like '%' || v_q || '%')
      and v.status <> 'billed' and not v.missing_from_report
    order by v.status, v.vin
    limit 200;
    return;
  end if;
  return query
  select * from search_console(p_q) s
  where p_mode is null or p_mode = 'all'
     or (p_mode = 'vin' and s.kind = 'vehicle')
     or (p_mode = 'mobile' and s.kind in ('booking', 'enquiry'))
     or (p_mode = 'ctdms' and s.kind = 'booking');
end;
$$;

-- ===== Other dealers: nearby suffixes and other colours =====
create or replace function vna_other_dealer_matches_wide(p_outlet_id uuid default null)
returns table (booking_id uuid, customer_name text, outlet text, model text, variant text, color text, days_waiting int,
               free_cars int, match_kind text, dealer_name text, dealer_city text, dealer_contact text, offered_variant text,
               offered_color text, quantity int, offer_note text, reported_on date)
language sql
stable
security definer
set search_path = public
as $$
  select d.booking_id, d.customer_name, d.outlet, d.model_name, d.variant_name, d.color_name, d.days_waiting, d.free_cars,
         case when s.variant_id = b.variant_id and s.color_id = b.color_id then 'exact'
              when s.variant_id = b.variant_id then 'other_colour'
              else 'other_suffix' end,
         s.dealer_name, s.city, s.contact, sv.name, sc.name, s.quantity, s.offer_note, s.reported_on
  from pool_vna_demand(p_outlet_id) d
  join bookings b on b.id = d.booking_id
  join variants bv on bv.id = b.variant_id
  join other_dealer_stock s on s.variant_id in (select id from variants where model_id = bv.model_id)
  left join variants sv on sv.id = s.variant_id
  left join colors sc on sc.id = s.color_id
  where has_right('other_dealers', 'view')
  order by d.days_waiting desc,
           case when s.variant_id = b.variant_id and s.color_id = b.color_id then 0 when s.variant_id = b.variant_id then 1 else 2 end,
           s.reported_on desc;
$$;

-- ===== Stock planning =====
create table open_orders (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references outlets(id),
  variant_id uuid not null references variants(id),
  color_id uuid not null references colors(id),
  quantity int not null check (quantity > 0),
  order_ref text,
  ordered_on date not null default current_date,
  expected_on date,
  status text not null default 'open' check (status in ('open', 'received', 'cancelled')),
  created_by uuid references employees(id) default current_employee_id(),
  created_at timestamptz not null default now()
);
create index idx_open_orders_variant_color on open_orders(variant_id, color_id) where status = 'open';
create index idx_open_orders_outlet on open_orders(outlet_id);
create index idx_open_orders_color on open_orders(color_id);
create index idx_open_orders_by on open_orders(created_by);
alter table open_orders enable row level security;
create policy open_orders_select on open_orders for select to authenticated using (has_right('stock_planning', 'view'));
create policy open_orders_write on open_orders for all to authenticated
  using (ops_can('stock_planning', 'edit', outlet_id)) with check (ops_can('stock_planning', 'edit', outlet_id));

-- Techwheels' projected planning, per variant + colour:
--   monthly sales = 0.5 × last 30 days + 0.3 × the 30 before + 0.2 × the 30 before that (bookings)
--   need = max(sales, VNA); order = max(0, need − (free + open orders))
--   ORDER NOW when order > 0; MONITOR when cars are waiting but covered; COVERED otherwise
--   excess = open orders − max(VNA, sales) when positive
create or replace function stock_planning(p_outlet_id uuid default null)
returns table (variant_id uuid, color_id uuid, model text, variant text, suffix text, color text, sales_m1 int, sales_m2 int,
               sales_m3 int, weighted_sales numeric, vna int, free int, open_orders int, need numeric, order_qty int, excess int, status text)
language sql
stable
security definer
set search_path = public
as $$
  with today as (select (now() at time zone 'Asia/Kolkata')::date as d),
  keys as (
    select b.variant_id, b.color_id from bookings b, today
    where b.variant_id is not null and b.color_id is not null and b.created_at >= today.d - 90 and (p_outlet_id is null or b.outlet_id = p_outlet_id)
    union
    select v.variant_id, v.color_id from vehicles v where vehicle_allotable(v) and v.variant_id is not null and (p_outlet_id is null or v.outlet_id = p_outlet_id)
    union
    select o.variant_id, o.color_id from open_orders o where o.status = 'open' and (p_outlet_id is null or o.outlet_id = p_outlet_id)
    union
    select b.variant_id, b.color_id from bookings b where b.status = 'booked' and b.variant_id is not null and (p_outlet_id is null or b.outlet_id = p_outlet_id)
  ),
  calc as (
    select k.variant_id, k.color_id,
      (select count(*)::int from bookings b, today where b.variant_id = k.variant_id and b.color_id = k.color_id and b.status <> 'cancelled'
         and b.created_at::date > today.d - 30 and (p_outlet_id is null or b.outlet_id = p_outlet_id)) m1,
      (select count(*)::int from bookings b, today where b.variant_id = k.variant_id and b.color_id = k.color_id and b.status <> 'cancelled'
         and b.created_at::date > today.d - 60 and b.created_at::date <= today.d - 30 and (p_outlet_id is null or b.outlet_id = p_outlet_id)) m2,
      (select count(*)::int from bookings b, today where b.variant_id = k.variant_id and b.color_id = k.color_id and b.status <> 'cancelled'
         and b.created_at::date > today.d - 90 and b.created_at::date <= today.d - 60 and (p_outlet_id is null or b.outlet_id = p_outlet_id)) m3,
      (select count(*)::int from bookings b where b.variant_id = k.variant_id and b.color_id = k.color_id and b.status = 'booked'
         and not booking_on_hold(b.id) and (p_outlet_id is null or b.outlet_id = p_outlet_id)) vna,
      (select count(*)::int from vehicles v where v.variant_id = k.variant_id and v.color_id = k.color_id and vehicle_allotable(v)
         and (p_outlet_id is null or v.outlet_id = p_outlet_id)) free,
      (select coalesce(sum(o.quantity), 0)::int from open_orders o where o.variant_id = k.variant_id and o.color_id = k.color_id
         and o.status = 'open' and (p_outlet_id is null or o.outlet_id = p_outlet_id)) open_q
    from keys k
  )
  select * from (
  select c.variant_id, c.color_id, mo.name, va.name, va.tkm_suffix_code, co.name, c.m1, c.m2, c.m3,
         round(0.5 * c.m1 + 0.3 * c.m2 + 0.2 * c.m3, 1) ws, c.vna, c.free, c.open_q,
         greatest(round(0.5 * c.m1 + 0.3 * c.m2 + 0.2 * c.m3, 1), c.vna) need,
         greatest(0, ceil(greatest(0.5 * c.m1 + 0.3 * c.m2 + 0.2 * c.m3, c.vna)) - (c.free + c.open_q))::int,
         greatest(0, c.open_q - ceil(greatest(c.vna, 0.5 * c.m1 + 0.3 * c.m2 + 0.2 * c.m3)))::int,
         case when ceil(greatest(0.5 * c.m1 + 0.3 * c.m2 + 0.2 * c.m3, c.vna)) - (c.free + c.open_q) > 0 then 'ORDER NOW'
              when c.vna > c.free then 'MONITOR'
              else 'COVERED' end
  from calc c
  join variants va on va.id = c.variant_id
  left join models mo on mo.id = va.model_id
  join colors co on co.id = c.color_id
  where has_right('stock_planning', 'view')
  ) x(variant_id, color_id, model, variant, suffix, color, sales_m1, sales_m2, sales_m3, weighted_sales, vna, free, open_orders, need, order_qty, excess, status)
  order by x.status = 'COVERED', x.status = 'MONITOR', x.model, x.variant, x.color;
$$;

-- ===== Yard =====
alter table yards
  add column capacity int check (capacity >= 0),
  add column kind text not null default 'normal' check (kind in ('normal', 'workshop', 'delivered'));
update yards set kind = 'workshop' where name = 'Workshop';
insert into yards (outlet_id, name, kind)
select o.id, 'Delivered', 'delivered' from outlets o where o.is_active
on conflict (outlet_id, name) do update set kind = 'delivered';

alter table vehicle_movements drop constraint vehicle_movements_kind_check;
alter table vehicle_movements add constraint vehicle_movements_kind_check
  check (kind in ('yard_move', 'workshop', 'pdi', 'wash', 'battery_check', 'display', 'transfer', 'inward', 'delivered', 'other'));
alter table vehicle_movements
  add column movement_type text check (movement_type in ('inward', 'relocate', 'outward', 'delivered')),
  add column driver_name text,
  add column paper_check boolean,
  add column vehicle_out_date date,
  add column job_card_no text;

-- A delivered car moves to the branch's Delivered yard by itself.
create or replace function bookings_delivered_to_yard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vehicle uuid;
  v_outlet uuid;
  v_yard uuid;
begin
  if NEW.status = 'delivered' and OLD.status is distinct from 'delivered' then
    select a.vehicle_id, v.outlet_id into v_vehicle, v_outlet
    from allotments a join vehicles v on v.id = a.vehicle_id where a.booking_id = NEW.id and a.released_at is null limit 1;
    if v_vehicle is not null then
      select id into v_yard from yards where outlet_id = v_outlet and kind = 'delivered' limit 1;
      insert into vehicle_movements (vehicle_id, kind, movement_type, yard_id, from_location, to_location, moved_by)
      select v_vehicle, 'delivered', 'delivered', v_yard, location, 'Delivered', current_employee_id() from vehicles where id = v_vehicle;
      update vehicles set location = 'Delivered' where id = v_vehicle;
    end if;
  end if;
  return NEW;
end;
$$;
create trigger trg_bookings_delivered_to_yard after update of status on bookings
  for each row execute function bookings_delivered_to_yard();

-- Receive a car the transit report listed: it is now physically here.
create or replace function receive_from_transit(p_vehicle_id uuid, p_yard_id uuid, p_driver text default null, p_paper_check boolean default null,
                                                p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v vehicles%rowtype;
  y yards%rowtype;
begin
  select * into v from vehicles where id = p_vehicle_id for update;
  if v.id is null or not ops_can('vehicle_location', 'edit', v.outlet_id) then raise exception 'Car not found'; end if;
  if v.source <> 'transit' then raise exception 'This car is not in transit'; end if;
  select * into y from yards where id = p_yard_id and is_active;
  if y.id is null or y.outlet_id <> v.outlet_id then raise exception 'Pick a yard of this branch'; end if;
  update vehicles set source = 'physical', location = y.name where id = v.id;
  insert into vehicle_movements (vehicle_id, kind, movement_type, yard_id, from_location, to_location, driver_name, paper_check, note, moved_by)
  values (v.id, 'inward', 'inward', y.id, 'In transit', y.name, nullif(btrim(p_driver), ''), p_paper_check, nullif(btrim(p_note), ''), current_employee_id());
end;
$$;

-- Form 22 and the CNG form, one each per car.
create table vehicle_documents (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id),
  doc_type text not null check (doc_type in ('form_22', 'cng_form')),
  storage_path text not null,
  uploaded_by uuid references employees(id),
  uploaded_at timestamptz not null default now(),
  unique (vehicle_id, doc_type)
);
create index idx_vehicle_documents_by on vehicle_documents(uploaded_by);
alter table vehicle_documents enable row level security;
create policy vehicle_documents_select on vehicle_documents for select to authenticated using (has_right('vehicle_location', 'view'));

insert into storage.buckets (id, name, public) values ('vehicle-documents', 'vehicle-documents', false) on conflict (id) do nothing;
create policy vehicle_documents_obj_select on storage.objects for select to authenticated
  using (bucket_id = 'vehicle-documents' and has_right('vehicle_location', 'view'));
create policy vehicle_documents_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'vehicle-documents' and has_right('vehicle_location', 'edit'));

create or replace function vehicle_needs_cng(p_vehicle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from vehicles v join variants va on va.id = v.variant_id join fuel_types f on f.id = va.fuel_type_id
                 where v.id = p_vehicle_id and f.name ilike '%cng%');
$$;

create or replace function set_vehicle_document(p_vehicle_id uuid, p_doc_type text, p_storage_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v vehicles%rowtype;
begin
  select * into v from vehicles where id = p_vehicle_id;
  if v.id is null or not ops_can('vehicle_location', 'edit', v.outlet_id) then raise exception 'Car not found'; end if;
  if p_doc_type = 'cng_form' and not vehicle_needs_cng(v.id) then raise exception 'This car is not a CNG car'; end if;
  if (storage.foldername(p_storage_path))[1] is distinct from v.id::text then raise exception 'Store the file under the car''s folder'; end if;
  insert into vehicle_documents (vehicle_id, doc_type, storage_path, uploaded_by)
  values (v.id, p_doc_type, p_storage_path, current_employee_id())
  on conflict (vehicle_id, doc_type) do update set storage_path = excluded.storage_path, uploaded_by = excluded.uploaded_by, uploaded_at = now();
end;
$$;

-- Cars (not yet delivered) still missing Form 22, or the CNG form on a CNG car.
create or replace function form22_pending(p_outlet_id uuid default null)
returns table (vehicle_id uuid, vin text, car text, outlet text, status text, customer_name text, needs_cng boolean,
               has_form22 boolean, has_cng boolean)
language sql
stable
security definer
set search_path = public
as $$
  select v.id, v.vin, concat_ws(' · ', mo.name, va.name, co.name), o.name, v.status,
         (select b.customer_name from allotments a join bookings b on b.id = a.booking_id where a.vehicle_id = v.id and a.released_at is null limit 1),
         vehicle_needs_cng(v.id),
         exists (select 1 from vehicle_documents d where d.vehicle_id = v.id and d.doc_type = 'form_22'),
         exists (select 1 from vehicle_documents d where d.vehicle_id = v.id and d.doc_type = 'cng_form')
  from vehicles v
  join outlets o on o.id = v.outlet_id
  left join variants va on va.id = v.variant_id
  left join models mo on mo.id = va.model_id
  left join colors co on co.id = v.color_id
  where has_right('vehicle_location', 'view') and ops_branch_ok(v.outlet_id) and (p_outlet_id is null or v.outlet_id = p_outlet_id)
    and coalesce(v.location, '') <> 'Delivered'
    and (not v.missing_from_report or v.status <> 'available')
    and (not exists (select 1 from vehicle_documents d where d.vehicle_id = v.id and d.doc_type = 'form_22')
         or (vehicle_needs_cng(v.id) and not exists (select 1 from vehicle_documents d where d.vehicle_id = v.id and d.doc_type = 'cng_form')))
  order by v.status desc, v.tkm_invoice_date nulls last;
$$;

-- Battery change: an allotted car not yet invoiced whose TKM invoice is 90+ days old needs a new
-- battery approved by TKM before delivery.
create table battery_change_cases (
  vehicle_id uuid primary key references vehicles(id),
  status text not null default 'pending' check (status in ('pending', 'approval_mail_sent', 'approval_received', 'done')),
  note text,
  updated_by uuid references employees(id),
  updated_at timestamptz not null default now()
);
create index idx_battery_change_cases_by on battery_change_cases(updated_by);
alter table battery_change_cases enable row level security;
create policy battery_change_cases_select on battery_change_cases for select to authenticated using (has_right('vehicle_location', 'view'));

create or replace function battery_change_list(p_outlet_id uuid default null)
returns table (vehicle_id uuid, vin text, car text, outlet text, customer_name text, tkm_invoice_date date, age_days int, status text, note text)
language sql
stable
security definer
set search_path = public
as $$
  select v.id, v.vin, concat_ws(' · ', mo.name, va.name, co.name), o.name, b.customer_name, v.tkm_invoice_date,
         ((now() at time zone 'Asia/Kolkata')::date - v.tkm_invoice_date)::int, coalesce(c.status, 'pending'), c.note
  from vehicles v
  join allotments a on a.vehicle_id = v.id and a.released_at is null
  join bookings b on b.id = a.booking_id
  join outlets o on o.id = v.outlet_id
  left join variants va on va.id = v.variant_id
  left join models mo on mo.id = va.model_id
  left join colors co on co.id = v.color_id
  left join battery_change_cases c on c.vehicle_id = v.id
  where has_right('vehicle_location', 'view') and ops_branch_ok(v.outlet_id) and (p_outlet_id is null or v.outlet_id = p_outlet_id)
    and v.status = 'allotted' and v.tkm_invoice_date <= (now() at time zone 'Asia/Kolkata')::date - 90
    and not exists (select 1 from billing_requests br where br.vehicle_id = v.id and br.status = 'invoiced')
  order by v.tkm_invoice_date;
$$;

create or replace function set_battery_change_status(p_vehicle_id uuid, p_status text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v vehicles%rowtype;
begin
  select * into v from vehicles where id = p_vehicle_id;
  if v.id is null or not ops_can('vehicle_location', 'edit', v.outlet_id) then raise exception 'Car not found'; end if;
  if p_status not in ('pending', 'approval_mail_sent', 'approval_received', 'done') then raise exception 'Unknown status'; end if;
  insert into battery_change_cases (vehicle_id, status, note, updated_by) values (v.id, p_status, nullif(btrim(p_note), ''), current_employee_id())
  on conflict (vehicle_id) do update set status = excluded.status, note = coalesce(excluded.note, battery_change_cases.note),
    updated_by = excluded.updated_by, updated_at = now();
end;
$$;

-- Job cards opened on a stock car (Techwheels' JC open / close tracking).
create table vehicle_job_cards (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id),
  jc_no text,
  opened_on date not null default ((now() at time zone 'Asia/Kolkata')::date),
  closed_on date,
  no_action_required boolean not null default false,
  note text,
  opened_by uuid references employees(id),
  closed_by uuid references employees(id),
  check (closed_on is null or closed_on >= opened_on)
);
create unique index uq_vehicle_job_cards_open on vehicle_job_cards(vehicle_id) where closed_on is null and not no_action_required;
create index idx_vehicle_job_cards_opened_by on vehicle_job_cards(opened_by);
create index idx_vehicle_job_cards_closed_by on vehicle_job_cards(closed_by);
alter table vehicle_job_cards enable row level security;
create policy vehicle_job_cards_select on vehicle_job_cards for select to authenticated using (has_right('vehicle_location', 'view'));

create or replace function open_job_card(p_vehicle_id uuid, p_jc_no text, p_note text default null)
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
  if v.id is null or not ops_can('vehicle_location', 'edit', v.outlet_id) then raise exception 'Car not found'; end if;
  if nullif(btrim(p_jc_no), '') is null then raise exception 'Enter the job card number'; end if;
  insert into vehicle_job_cards (vehicle_id, jc_no, note, opened_by) values (v.id, btrim(p_jc_no), nullif(btrim(p_note), ''), current_employee_id())
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'This car already has an open job card';
end;
$$;

create or replace function close_job_card(p_job_card_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  j vehicle_job_cards%rowtype;
begin
  select * into j from vehicle_job_cards where id = p_job_card_id for update;
  if j.id is null or not exists (select 1 from vehicles v where v.id = j.vehicle_id and ops_can('vehicle_location', 'edit', v.outlet_id)) then
    raise exception 'Job card not found';
  end if;
  if j.closed_on is not null then raise exception 'This job card is closed'; end if;
  update vehicle_job_cards set closed_on = (now() at time zone 'Asia/Kolkata')::date, closed_by = current_employee_id(),
    note = coalesce(nullif(btrim(p_note), ''), note) where id = j.id;
end;
$$;

-- Yard overview: cars per yard against capacity, plus the cars with no yard.
create or replace function yard_overview(p_outlet_id uuid default null)
returns table (outlet text, yard_id uuid, yard text, kind text, capacity int, cars int, allotted int)
language sql
stable
security definer
set search_path = public
as $$
  select o.name, y.id, y.name, y.kind, y.capacity,
         (select count(*)::int from vehicles v where v.outlet_id = y.outlet_id and v.location = y.name and v.source = 'physical'
            and (y.kind = 'delivered' or (v.status <> 'billed' or not exists (select 1 from gate_passes g where g.vehicle_id = v.id and g.exited_at is not null)))),
         (select count(*)::int from vehicles v where v.outlet_id = y.outlet_id and v.location = y.name and v.status = 'allotted')
  from yards y join outlets o on o.id = y.outlet_id
  where y.is_active and has_right('vehicle_location', 'view') and ops_branch_ok(y.outlet_id) and (p_outlet_id is null or y.outlet_id = p_outlet_id)
  union all
  select o.name, null, 'No yard location', 'none', null,
         count(*)::int, count(*) filter (where v.status = 'allotted')::int
  from vehicles v join outlets o on o.id = v.outlet_id
  where v.source = 'physical' and v.status <> 'billed' and not v.missing_from_report and has_right('vehicle_location', 'view')
    and ops_branch_ok(v.outlet_id) and (p_outlet_id is null or v.outlet_id = p_outlet_id)
    and not exists (select 1 from yards y where y.outlet_id = v.outlet_id and y.name = v.location)
  group by o.name
  order by 1, 4, 3;
$$;

create or replace function set_yard_capacity(p_yard_id uuid, p_capacity int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from yards y where y.id = p_yard_id and ops_can('vehicle_location', 'approve', y.outlet_id)) then
    raise exception 'Only the branch''s Outlet Head can set yard capacity';
  end if;
  update yards set capacity = p_capacity where id = p_yard_id;
end;
$$;

-- ===== Pool: a car added back to free stock is not taken away for leaving the report =====
create or replace function pool_recompute(p_variant_id uuid, p_color_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  cfg pool_config%rowtype;
  m pool_members%rowtype;
  a allotments%rowtype;
  v vehicles%rowtype;
  b bookings%rowtype;
  c record;
  v_reason text;
  v_free int;
  v_target int;
  v_protected int;
  v_slots int;
  v_wanted uuid[];
  v_winner pool_members%rowtype;
  v_vehicle uuid;
  v_allotment uuid;
  v_joined int := 0;
  v_bumped int := 0;
  v_removed int := 0;
  v_released int := 0;
  v_allotted int := 0;
  v_guard int := 0;
begin
  select * into cfg from pool_config;
  if p_variant_id is null or p_color_id is null or not cfg.enabled then
    return jsonb_build_object('skipped', true);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pool:' || p_variant_id::text || ':' || p_color_id::text, 0));
  -- Our own changes below must not queue this key again.
  perform set_config('pool.busy', 'on', true);

  -- 1. Winners holding a car: still entitled to it?
  for m in select * from pool_members where variant_id = p_variant_id and color_id = p_color_id and status = 'allotted' for update loop
    a := null;
    select * into a from allotments where booking_id = m.booking_id and released_at is null;
    if a.id is null or a.method <> 'pool' then
      -- Released elsewhere (hold, cancellation, a manager) or allotted outside the pool.
      if a.id is null and booking_allotable(m.booking_id) then
        update pool_members set status = 'active', fast_tracked = false, removed_reason = null where id = m.id;
      else
        update pool_members set status = 'removed', completed_at = null, win_path = null,
          removed_reason = case when a.id is null then 'Car released and booking no longer eligible' else 'Allotted outside the pool' end
        where id = m.id;
        v_removed := v_removed + 1;
      end if;
      continue;
    end if;
    -- Once the car has gone for billing it stays.
    continue when exists (select 1 from billing_requests where allotment_id = a.id and status in ('pending', 'invoiced'));

    select * into v from vehicles where id = a.vehicle_id;
    select * into b from bookings where id = m.booking_id;
    c := pool_booking_completion(b.id);
    v_reason := case
      when v.missing_from_report and v.source = 'physical' and not vehicle_stock_added(v.id) then 'Car left the physical stock report'
      when v.ctdms_order_status = 'Invoiced' and v.ctdms_order_no is distinct from b.ctdms_order_booking_no
        then 'Car invoiced in CTDMS for another order'
      when booking_on_hold(b.id) or b.status <> 'allocated' or coalesce(b.ctdms_order_status, '') = 'Closed in CTDMS'
        then 'Booking no longer eligible'
      when c.completed_at is null then
        case m.win_path when 'do' then 'DO no longer in place' else 'Cleared payment fell below ' || cfg.cash_payment_percentage || '%' end
    end;
    continue when v_reason is null;

    perform release_allotment_core(a.id, 'Pool: ' || v_reason);
    v_released := v_released + 1;
    perform pool_log('released', b.id, v.id, p_variant_id, p_color_id, jsonb_build_object('reason', v_reason));
    if booking_allotable(b.id) then
      update pool_members set status = 'active', completed_at = c.completed_at, win_path = c.win_path where id = m.id;
      if c.completed_at is null then
        perform pool_log('completion_unbanked', b.id, null, p_variant_id, p_color_id, jsonb_build_object('was', m.win_path));
      end if;
    else
      update pool_members set status = 'removed', completed_at = null, win_path = null, removed_reason = v_reason where id = m.id;
      v_removed := v_removed + 1;
    end if;
  end loop;

  -- 2. Members who can no longer take a car leave the pool.
  for m in
    select pm.* from pool_members pm join bookings bk on bk.id = pm.booking_id
    where pm.variant_id = p_variant_id and pm.color_id = p_color_id and pm.status = 'active'
      and (not booking_allotable(pm.booking_id) or bk.variant_id is distinct from pm.variant_id or bk.color_id is distinct from pm.color_id)
    for update of pm
  loop
    update pool_members set status = 'removed', completed_at = null, win_path = null, fast_tracked = false,
      removed_reason = 'No longer eligible' where id = m.id;
    perform pool_log('removed_ineligible', m.booking_id, null, p_variant_id, p_color_id);
    v_removed := v_removed + 1;
  end loop;

  -- 3. Bank (or unbank) completions.
  for m in select * from pool_members where variant_id = p_variant_id and color_id = p_color_id and status = 'active' for update loop
    c := pool_booking_completion(m.booking_id);
    if c.completed_at is distinct from m.completed_at or c.win_path is distinct from m.win_path then
      update pool_members set completed_at = c.completed_at, win_path = c.win_path where id = m.id;
      perform pool_log(case when c.completed_at is null then 'completion_unbanked' else 'completion_banked' end,
                       m.booking_id, null, p_variant_id, p_color_id,
                       jsonb_build_object('win_path', coalesce(c.win_path, m.win_path), 'completed_at', c.completed_at));
    end if;
  end loop;

  loop
    v_guard := v_guard + 1;
    exit when v_guard > 1000;

    -- 4 + 5. FIFO membership: keep members who completed or were fast-tracked; fill the other
    -- places with the earliest-booked eligible bookings, pushing out later members.
    v_free := pool_free_count(p_variant_id, p_color_id);
    v_target := pool_target_size(v_free);
    select count(*) into v_protected from pool_members
    where variant_id = p_variant_id and color_id = p_color_id and status = 'active' and (completed_at is not null or fast_tracked);
    v_slots := greatest(v_target - v_protected, 0);

    select coalesce(array_agg(x.id), '{}') into v_wanted from (
      select bk.id from bookings bk
      where bk.variant_id = p_variant_id and bk.color_id = p_color_id and booking_allotable(bk.id)
        and not exists (select 1 from pool_members pm where pm.booking_id = bk.id and pm.status = 'active'
                        and (pm.completed_at is not null or pm.fast_tracked))
      order by booking_order_date(bk), bk.created_at, bk.id
      limit v_slots
    ) x;

    for m in
      select * from pool_members
      where variant_id = p_variant_id and color_id = p_color_id and status = 'active'
        and completed_at is null and not fast_tracked and booking_id <> all(v_wanted)
      for update
    loop
      update pool_members set status = 'removed', removed_reason = 'Pushed out by an earlier booking or fewer free cars' where id = m.id;
      perform pool_log('pool_bump', m.booking_id, null, p_variant_id, p_color_id,
                       jsonb_build_object('free_cars', v_free, 'pool_size', v_target));
      v_bumped := v_bumped + 1;
    end loop;

    for b in
      select bk.* from bookings bk
      where bk.id = any(v_wanted)
        and not exists (select 1 from pool_members pm where pm.booking_id = bk.id and pm.status = 'active')
    loop
      c := pool_booking_completion(b.id);
      insert into pool_members (booking_id, variant_id, color_id, booking_date, status, completed_at, win_path)
      values (b.id, p_variant_id, p_color_id, booking_order_date(b), 'active', c.completed_at, c.win_path)
      on conflict (booking_id) do update set variant_id = excluded.variant_id, color_id = excluded.color_id,
        booking_date = excluded.booking_date, status = 'active', joined_at = now(), completed_at = excluded.completed_at,
        win_path = excluded.win_path, fast_tracked = false, fast_track_reason = null, removed_reason = null;
      perform pool_log('pool_join', b.id, null, p_variant_id, p_color_id,
                       jsonb_build_object('booking_date', booking_order_date(b), 'completed', c.completed_at is not null));
      v_joined := v_joined + 1;
    end loop;

    -- 6. The first winner takes the oldest free car.
    select pm.* into v_winner from pool_members pm join bookings bk on bk.id = pm.booking_id
    where pm.variant_id = p_variant_id and pm.color_id = p_color_id and pm.status = 'active' and pm.completed_at is not null
    order by pm.completed_at, pm.booking_date, bk.created_at, pm.id
    limit 1
    for update of pm skip locked;
    exit when v_winner.id is null;

    select v2.id into v_vehicle from vehicles v2
    where v2.variant_id = p_variant_id and v2.color_id = p_color_id and pool_vehicle_free(v2)
    order by (v2.source = 'physical') desc, v2.days_since_invoice desc nulls last, v2.vin
    limit 1
    for update skip locked;
    exit when v_vehicle is null;

    v_allotment := allot_vehicle_core(v_winner.booking_id, v_vehicle, 'pool', null, null, v_winner.win_path);
    update pool_members set status = 'allotted' where id = v_winner.id;
    perform pool_log('allotted', v_winner.booking_id, v_vehicle, p_variant_id, p_color_id,
                     jsonb_build_object('win_path', v_winner.win_path, 'completed_at', v_winner.completed_at,
                                        'allotment_id', v_allotment));
    v_allotted := v_allotted + 1;
    v_winner := null;
    v_vehicle := null;
  end loop;

  perform set_config('pool.busy', 'off', true);
  return jsonb_build_object('joined', v_joined, 'bumped', v_bumped, 'removed', v_removed, 'released', v_released,
                            'allotted', v_allotted, 'free_cars', pool_free_count(p_variant_id, p_color_id));
end;
$$;

-- ===== Grants =====
do $$
declare f text;
begin
  foreach f in array array[
    'stock_control_active(stock_controls)', 'vehicle_stock_added(uuid)', 'set_stock_control_v2(uuid, text, text, text, date)',
    'request_dealer_transfer(jsonb)', 'move_dealer_transfer(uuid, text, text)', 'dealer_transfer_list(boolean)',
    'import_transit_details(jsonb)', 'chassis_monitor(uuid)', 'search_console_mode(text, text)',
    'vna_other_dealer_matches_wide(uuid)', 'stock_planning(uuid)', 'receive_from_transit(uuid, uuid, text, boolean, text)',
    'vehicle_needs_cng(uuid)', 'set_vehicle_document(uuid, text, text)', 'form22_pending(uuid)', 'battery_change_list(uuid)',
    'set_battery_change_status(uuid, text, text)', 'open_job_card(uuid, text, text)', 'close_job_card(uuid, text)',
    'yard_overview(uuid)', 'set_yard_capacity(uuid, int)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke execute on function bookings_delivered_to_yard() from public, anon, authenticated;

-- ===== Menu =====
insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('dealer_transfers', 'stock', 'Dealer Transfers', '/stock/dealer-transfers', 125, true),
  ('stock_monitor',    'stock', 'Chassis Monitor',  '/stock/monitor',          130, true),
  ('stock_planning',   'stock', 'Stock Planning',   '/stock/planning',         135, true);
select seed_role_rights('Outlet Head', 'dealer_transfers', array['view', 'create', 'edit', 'approve']);
select seed_role_rights('Outlet Head', 'stock_transfers', array['view', 'create', 'edit', 'approve']);
select seed_role_rights('Outlet Head', 'stock_monitor', array['view']);
select seed_role_rights('Outlet Head', 'stock_planning', array['view', 'edit']);
select seed_role_rights('Outlet Head', 'stock_control', array['view', 'edit', 'approve']);
select seed_role_rights('Outlet Head', 'vehicle_location', array['view', 'edit', 'approve']);
select seed_role_rights('Accounts', 'stock_monitor', array['view']);
select seed_role_rights('Head Customer Relations', 'stock_monitor', array['view']);
select seed_role_rights('PDI Technician', 'vehicle_location', array['view', 'edit']);
select seed_role_rights('RTO Executive', 'vehicle_location', array['view', 'edit']);
