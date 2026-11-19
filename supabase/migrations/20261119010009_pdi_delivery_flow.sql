-- Phase 31: PDI and delivery — Techwheels' PDI flow, scheduler and delivery bays.
--   PDI flow (Techwheels' _pdi_state), derived from the PDI and the car's yard moves (Phase 27):
--     no_vehicle → pdi_pending → to_rework (failed: take the car to the workshop yard, then inspect
--     again) → to_move (passed: move it to the branch's delivery bay) → to_wash → ready.
--   PDI scheduler: a time inside the branch's working hours; reschedule; one open PDI per booking.
--   Delivery: bays per branch on a grid of slot_minutes (default 20) inside working hours; a slot is
--     on the grid; a bay is picked (or chosen) and shared by up to max_per_bay cars; a past slot can be
--     recorded by someone with Delivery Scheduler: approve (to log a delivery that already happened).
--     Existing slots move to bay 1. A day board (bays × times) with each car's readiness, and FTD /
--     MTD / LTD delivered counts.

create table outlet_hours (
  outlet_id uuid primary key references outlets(id),
  day_start time not null default '09:30',
  day_end time not null default '19:00',
  slot_minutes int not null default 20 check (slot_minutes between 5 and 240),
  max_per_bay int not null default 3 check (max_per_bay between 1 and 10),
  check (day_end > day_start)
);
insert into outlet_hours (outlet_id) select id from outlets where is_active on conflict do nothing;

create table delivery_bays (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references outlets(id),
  bay_no int not null check (bay_no >= 1),
  name text not null,
  is_active boolean not null default true,
  unique (outlet_id, bay_no)
);
insert into delivery_bays (outlet_id, bay_no, name)
select o.id, n, 'Bay ' || n from outlets o cross join generate_series(1, 2) n where o.is_active;

alter table delivery_slots add column bay_no int, add column slot_end text;
update delivery_slots set bay_no = 1 where bay_no is null;

alter table yards drop constraint yards_kind_check;
alter table yards add constraint yards_kind_check check (kind in ('normal', 'workshop', 'delivered', 'delivery_bay'));
update yards set kind = 'delivery_bay' where name = 'Delivery bay';

alter table outlet_hours enable row level security;
alter table delivery_bays enable row level security;
create policy outlet_hours_select on outlet_hours for select to authenticated using (true);
create policy outlet_hours_write on outlet_hours for all to authenticated
  using (ops_can('delivery_scheduler', 'approve', outlet_id)) with check (ops_can('delivery_scheduler', 'approve', outlet_id));
create policy delivery_bays_select on delivery_bays for select to authenticated using (true);
create policy delivery_bays_write on delivery_bays for all to authenticated
  using (ops_can('delivery_scheduler', 'approve', outlet_id)) with check (ops_can('delivery_scheduler', 'approve', outlet_id));

-- ===== PDI flow =====
create or replace function pdi_stage(p_booking_id uuid, out stage text, out detail text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v vehicles%rowtype;
  pass pdi_inspections%rowtype;
  last pdi_inspections%rowtype;
  v_kind text;
begin
  select * into b from bookings where id = p_booking_id;
  select v2.* into v from allotments a join vehicles v2 on v2.id = a.vehicle_id where a.booking_id = b.id and a.released_at is null;
  if v.id is null then stage := 'no_vehicle'; detail := 'No car allotted'; return; end if;
  select y.kind into v_kind from yards y where y.outlet_id = v.outlet_id and y.name = v.location;
  select * into pass from pdi_inspections where booking_id = b.id and status = 'passed' order by inspected_at desc limit 1;
  if pass.id is not null then
    if coalesce(v_kind, '') not in ('delivery_bay', 'delivered') then
      stage := 'to_move'; detail := 'PDI passed; move the car to the delivery bay (now: ' || coalesce(v.location, 'not recorded') || ')'; return;
    end if;
    if not exists (select 1 from vehicle_movements m where m.vehicle_id = v.id and m.kind = 'wash' and m.moved_at >= pass.inspected_at) then
      stage := 'to_wash'; detail := 'At the delivery bay; wash it'; return;
    end if;
    stage := 'ready'; detail := 'Ready for delivery'; return;
  end if;
  select * into last from pdi_inspections where booking_id = b.id and status <> 'cancelled' order by created_at desc limit 1;
  if last.status = 'failed' and coalesce(v_kind, '') <> 'workshop' then
    stage := 'to_rework'; detail := 'PDI failed (' || coalesce(last.remarks, '') || '); take the car to the workshop'; return;
  end if;
  stage := 'pdi_pending';
  detail := case when last.status = 'scheduled' then 'PDI on ' || to_char(last.scheduled_for, 'DD Mon') || coalesce(' ' || last.slot, '')
                 when last.status = 'failed' then 'In the workshop; schedule the PDI again'
                 else 'Schedule the PDI' end;
end;
$$;

-- Move the car for the PDI flow (to the workshop, to the delivery bay).
create or replace function pdi_mark_at_location(p_booking_id uuid, p_yard_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v vehicles%rowtype;
  y yards%rowtype;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not ops_can('pdi_board', 'edit', b.outlet_id) then raise exception 'Booking not found'; end if;
  select v2.* into v from allotments a join vehicles v2 on v2.id = a.vehicle_id where a.booking_id = b.id and a.released_at is null;
  if v.id is null then raise exception 'No car allotted'; end if;
  select * into y from yards where id = p_yard_id and is_active;
  if y.id is null or y.outlet_id <> v.outlet_id then raise exception 'Pick a yard of the car''s branch'; end if;
  insert into vehicle_movements (vehicle_id, kind, movement_type, yard_id, from_location, to_location, note, moved_by)
  values (v.id, case y.kind when 'workshop' then 'workshop' else 'yard_move' end, 'relocate', y.id, v.location, y.name,
          nullif(btrim(p_note), ''), current_employee_id());
  update vehicles set location = y.name where id = v.id;
end;
$$;

create or replace function pdi_mark_washed(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v vehicles%rowtype;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not ops_can('pdi_board', 'edit', b.outlet_id) then raise exception 'Booking not found'; end if;
  select v2.* into v from allotments a join vehicles v2 on v2.id = a.vehicle_id where a.booking_id = b.id and a.released_at is null;
  if v.id is null then raise exception 'No car allotted'; end if;
  if (pdi_stage(b.id)).stage <> 'to_wash' then raise exception 'Wash the car once it has passed PDI and is at the delivery bay'; end if;
  insert into vehicle_movements (vehicle_id, kind, from_location, to_location, moved_by)
  values (v.id, 'wash', v.location, v.location, current_employee_id());
end;
$$;

create or replace function pdi_time_ok(p_outlet_id uuid, p_time text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_time ~ '^[0-2][0-9]:[0-5][0-9]$' and p_time::time >= h.day_start and p_time::time < h.day_end
  from outlet_hours h where h.outlet_id = p_outlet_id;
$$;

-- Schedule (or move) a PDI at a time inside the branch's working hours.
create or replace function schedule_pdi_at(p_booking_id uuid, p_date date, p_time text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_open pdi_inspections%rowtype;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null then raise exception 'Booking not found'; end if;
  if not coalesce(pdi_time_ok(b.outlet_id, p_time), false) then
    raise exception 'Pick a time within the branch''s working hours';
  end if;
  select * into v_open from pdi_inspections where booking_id = b.id and status = 'scheduled' for update;
  if v_open.id is not null then
    if not ops_can('pdi_board', 'create', b.outlet_id) then raise exception 'You cannot schedule PDIs at this branch'; end if;
    if p_date < (now() at time zone 'Asia/Kolkata')::date then raise exception 'Pick today or a later date'; end if;
    update pdi_inspections set scheduled_for = p_date, slot = p_time where id = v_open.id;
    return v_open.id;
  end if;
  return schedule_pdi(p_booking_id, p_date, p_time);
end;
$$;

-- The PDI flow board: every allotted car not yet delivered, at its stage.
create or replace function pdi_flow_board(p_outlet_id uuid default null)
returns table (booking_id uuid, customer_name text, outlet_id uuid, outlet text, car text, vin text, location text, stage text, detail text,
               inspection_id uuid, scheduled_for date, slot text)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.customer_name, b.outlet_id, o.name, concat_ws(' · ', mo.name, va.name, co.name), v.vin, v.location,
         (pdi_stage(b.id)).stage, (pdi_stage(b.id)).detail, i.id, i.scheduled_for, i.slot
  from allotments a
  join bookings b on b.id = a.booking_id
  join vehicles v on v.id = a.vehicle_id
  join outlets o on o.id = b.outlet_id
  left join variants va on va.id = v.variant_id left join models mo on mo.id = va.model_id left join colors co on co.id = v.color_id
  left join pdi_inspections i on i.booking_id = b.id and i.status = 'scheduled'
  where a.released_at is null and v.source = 'physical' and b.status not in ('delivered', 'cancelled')
    and has_right('pdi_board', 'view') and ops_branch_ok(b.outlet_id) and (p_outlet_id is null or b.outlet_id = p_outlet_id)
  order by array_position(array['to_rework', 'pdi_pending', 'to_move', 'to_wash', 'ready'], (pdi_stage(b.id)).stage), b.customer_name;
$$;

-- ===== Delivery bays =====
create or replace function book_delivery_bay(p_booking_id uuid, p_date date, p_time text, p_bay_no int default null, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  h outlet_hours%rowtype;
  v_min int;
  v_bay int;
  v_used int;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id for update;
  if b.id is null then raise exception 'Booking not found'; end if;
  if not (ops_can('delivery_scheduler', 'create', b.outlet_id)
          or (has_right('delivery_scheduler', 'create') and can_handle_booking(b))) then
    raise exception 'You cannot book delivery slots for this booking';
  end if;
  if b.status = 'cancelled' then raise exception 'This booking is cancelled'; end if;
  if not exists (select 1 from billing_requests where booking_id = b.id and status in ('pending', 'invoiced')) then
    raise exception 'Send the car for billing before booking the delivery';
  end if;
  if p_date is null then raise exception 'Pick the date'; end if;
  if p_date < (now() at time zone 'Asia/Kolkata')::date and not ops_can('delivery_scheduler', 'approve', b.outlet_id) then
    raise exception 'Only the Outlet Head can record a delivery slot in the past';
  end if;
  select * into h from outlet_hours where outlet_id = b.outlet_id;
  if h.outlet_id is null then raise exception 'Set the branch''s working hours first'; end if;
  if p_time !~ '^[0-2][0-9]:[0-5][0-9]$' or p_time::time < h.day_start or p_time::time + make_interval(mins => h.slot_minutes) > h.day_end then
    raise exception 'Pick a time between % and % (the slot must end by closing)', to_char(h.day_start, 'HH24:MI'), to_char(h.day_end, 'HH24:MI');
  end if;
  v_min := extract(epoch from (p_time::time - h.day_start))::int / 60;
  if v_min % h.slot_minutes <> 0 then
    raise exception 'Slots start every % minutes from %', h.slot_minutes, to_char(h.day_start, 'HH24:MI');
  end if;

  update delivery_slots set status = 'cancelled', cancelled_reason = 'Moved' where booking_id = b.id and status = 'booked';
  perform 1 from outlets where id = b.outlet_id for update;  -- one booking at a time per branch
  if p_bay_no is not null then
    if not exists (select 1 from delivery_bays where outlet_id = b.outlet_id and bay_no = p_bay_no and is_active) then
      raise exception 'No such bay';
    end if;
    select count(*) into v_used from delivery_slots
    where outlet_id = b.outlet_id and slot_date = p_date and slot_time = p_time and bay_no = p_bay_no and status in ('booked', 'done');
    if v_used >= h.max_per_bay then raise exception 'Bay % is full at %', p_bay_no, p_time; end if;
    v_bay := p_bay_no;
  else
    select db.bay_no into v_bay from delivery_bays db
    where db.outlet_id = b.outlet_id and db.is_active
      and (select count(*) from delivery_slots s where s.outlet_id = b.outlet_id and s.slot_date = p_date and s.slot_time = p_time
           and s.bay_no = db.bay_no and s.status in ('booked', 'done')) < h.max_per_bay
    order by (select count(*) from delivery_slots s where s.outlet_id = b.outlet_id and s.slot_date = p_date and s.slot_time = p_time
              and s.bay_no = db.bay_no and s.status in ('booked', 'done')), db.bay_no
    limit 1;
    if v_bay is null then raise exception 'Every bay is full at %; pick another time', p_time; end if;
  end if;
  insert into delivery_slots (booking_id, outlet_id, slot_date, slot_time, slot_end, bay_no, note, booked_by)
  values (b.id, b.outlet_id, p_date, p_time, to_char(p_time::time + make_interval(mins => h.slot_minutes), 'HH24:MI'), v_bay,
          nullif(btrim(p_note), ''), current_employee_id())
  returning id into v_id;
  update bookings set likely_delivery_date = p_date where id = b.id;
  return v_id;
end;
$$;

-- One day: every bay × time of a branch, with what is booked and how ready each car is.
create or replace function delivery_day_board(p_outlet_id uuid, p_date date)
returns table (slot_time text, bay_no int, bay text, slot_id uuid, booking_id uuid, customer_name text, customer_mobile text,
               car text, consultant text, open_stages int, pdi_stage text, gate_pass_no text, delivered boolean,
               last_wa_sent timestamptz, wa_slot_changed boolean)
language sql
stable
security definer
set search_path = public
as $$
  with h as (select * from outlet_hours where outlet_id = p_outlet_id),
  times as (
    select to_char(t, 'HH24:MI') as slot_time
    from h, generate_series(('2000-01-01'::date + h.day_start), ('2000-01-01'::date + h.day_end) - make_interval(mins => h.slot_minutes),
                            make_interval(mins => h.slot_minutes)) t
  ),
  grid as (
    select t.slot_time, db.bay_no, db.name from times t cross join delivery_bays db where db.outlet_id = p_outlet_id and db.is_active
  )
  select g.slot_time, g.bay_no, g.name, s.id, b.id, b.customer_name, b.customer_mobile,
         concat_ws(' · ', mo.name, va.name, co.name), e.name,
         case when b.id is null then null else (select count(*)::int from ops_stage_status(b.id) x where x.status not in ('done', 'na')) end,
         case when b.id is null then null else (pdi_stage(b.id)).stage end,
         gp.gate_pass_no, b.status = 'delivered', w.sent_at,
         w.sent_at is not null and w.slot_ref is distinct from (to_char(s.slot_date, 'YYYY-MM-DD') || ' ' || s.slot_time)
  from grid g
  left join delivery_slots s on s.outlet_id = p_outlet_id and s.slot_date = p_date and s.slot_time = g.slot_time and s.bay_no = g.bay_no
                             and s.status in ('booked', 'done')
  left join bookings b on b.id = s.booking_id
  left join variants va on va.id = b.variant_id left join models mo on mo.id = va.model_id left join colors co on co.id = b.color_id
  left join employees e on e.id = b.employee_id
  left join gate_passes gp on gp.booking_id = b.id and gp.voided_at is null
  left join lateral (select l.sent_at, l.slot_ref from whatsapp_send_log l where l.booking_id = b.id and l.context = 'delivery'
                     order by l.sent_at desc limit 1) w on true
  where has_right('delivery_scheduler', 'view') and ops_branch_ok(p_outlet_id)
  order by g.slot_time, g.bay_no, b.customer_name;
$$;

create or replace function delivered_counts(p_outlet_id uuid default null)
returns table (ftd int, mtd int, ltd int)
language sql
stable
security definer
set search_path = public
as $$
  with d as (
    select (dl.delivered_at at time zone 'Asia/Kolkata')::date as day
    from deliveries dl join bookings b on b.id = dl.booking_id
    where dl.status = 'delivered' and ops_branch_ok(b.outlet_id) and (p_outlet_id is null or b.outlet_id = p_outlet_id)
  ), t as (select (now() at time zone 'Asia/Kolkata')::date as today)
  select count(*) filter (where day = t.today)::int,
         count(*) filter (where date_trunc('month', day) = date_trunc('month', t.today))::int,
         count(*)::int
  from d, t
  where has_right('delivery_scheduler', 'view');
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'pdi_stage(uuid)', 'pdi_mark_at_location(uuid, uuid, text)', 'pdi_mark_washed(uuid)', 'pdi_time_ok(uuid, text)',
    'schedule_pdi_at(uuid, date, text)', 'pdi_flow_board(uuid)', 'book_delivery_bay(uuid, date, text, int, text)',
    'delivery_day_board(uuid, date)', 'delivered_counts(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- The Outlet Head sets hours and bays and may record a past slot.
select seed_role_rights('Outlet Head', 'delivery_scheduler', array['approve']);
