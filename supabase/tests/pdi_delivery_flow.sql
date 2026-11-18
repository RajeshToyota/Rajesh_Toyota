-- PDI flow and delivery bays (Phase 31):
--   - stages: pdi_pending → failed → to_rework → (workshop) pdi_pending → passed → to_move → (delivery bay) to_wash → ready
--   - PDI time inside working hours; rescheduling moves the open PDI
--   - delivery slots on the grid, bays auto-picked and shared up to max_per_bay, full bays refused,
--     past slots only for the Outlet Head; day board and delivered counts
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/pdi_delivery_flow.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000005');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005');

create or replace function pg_temp.as_user(n text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;
create or replace function pg_temp.expect_error(sql text, msg text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if sqlerrm not like msg || '%' then raise exception 'expected "%" but got "%"', msg, sqlerrm; end if;
    return;
  end;
  raise exception 'expected error "%" from: %', msg, sql;
end $$;
create or replace function pg_temp.bk(n int) returns uuid language sql as $$ select ('00000000-0000-0000-00bb-0000000031' || lpad(n::text, 2, '0'))::uuid $$;
create or replace function pg_temp.stage(n int) returns text language sql as $$ select (pdi_stage(pg_temp.bk(n))).stage $$;
create or replace function pg_temp.yard(nm text) returns uuid language sql as $$
  select id from yards where outlet_id = '00000000-0000-0000-0002-000000000001' and name = nm;
$$;
create or replace function pg_temp.all_ok() returns jsonb language sql as $$
  select jsonb_object_agg(code, 'ok') from pdi_checklist_items where is_active;
$$;

-- Five bookings, each with an allotted car in the main yard, sent for billing.
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option, status)
select pg_temp.bk(n), '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Flow Buyer ' || n, v.id, c.id,
       '00000000-0000-0000-000b-000000000001', 'premium', 'ready_to_invoice'
from generate_series(1, 5) n, variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
insert into vehicles (id, vin, outlet_id, source, status, variant_id, color_id, location)
select ('00000000-0000-0000-00cc-0000000031' || lpad(n::text, 2, '0'))::uuid, 'MBJFLW0000000310' || n, '00000000-0000-0000-0002-000000000001',
       'physical', 'allotted', v.id, c.id, 'Main yard'
from generate_series(1, 5) n, variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
insert into allotments (id, booking_id, vehicle_id, method)
select ('00000000-0000-0000-00aa-0000000031' || lpad(n::text, 2, '0'))::uuid, pg_temp.bk(n), ('00000000-0000-0000-00cc-0000000031' || lpad(n::text, 2, '0'))::uuid, 'manual'
from generate_series(1, 5) n;
insert into billing_requests (booking_id, vehicle_id, allotment_id, outlet_id, status)
select pg_temp.bk(n), ('00000000-0000-0000-00cc-0000000031' || lpad(n::text, 2, '0'))::uuid, ('00000000-0000-0000-00aa-0000000031' || lpad(n::text, 2, '0'))::uuid,
       '00000000-0000-0000-0002-000000000001', 'pending'
from generate_series(1, 5) n;

set local role authenticated;
select pg_temp.as_user('3');

-- ===== PDI flow =====
select pg_temp.expect_error($$select schedule_pdi_at(pg_temp.bk(1), current_date + 1, '07:00')$$, 'Pick a time within the branch''s working hours');
select schedule_pdi_at(pg_temp.bk(1), current_date + 1, '10:00');
select schedule_pdi_at(pg_temp.bk(1), current_date + 2, '11:30');   -- moved, not a second PDI
do $$ begin
  if (select count(*) from pdi_inspections where booking_id = pg_temp.bk(1)) <> 1
     or (select slot from pdi_inspections where booking_id = pg_temp.bk(1)) <> '11:30' then raise exception 'reschedule moves the PDI'; end if;
  if pg_temp.stage(1) <> 'pdi_pending' then raise exception 'pending: %', pg_temp.stage(1); end if;
end $$;
select record_pdi_result((select id from pdi_inspections where booking_id = pg_temp.bk(1)),
  pg_temp.all_ok() || '{"ext_paint": "fail"}', 'Scratch on the boot lid');
do $$ begin
  if pg_temp.stage(1) <> 'to_rework' then raise exception 'failed → to_rework: %', pg_temp.stage(1); end if;
end $$;
select pdi_mark_at_location(pg_temp.bk(1), pg_temp.yard('Workshop'), 'Paint touch-up');
do $$ begin
  if pg_temp.stage(1) <> 'pdi_pending' then raise exception 'in the workshop → inspect again: %', pg_temp.stage(1); end if;
end $$;
select schedule_pdi_at(pg_temp.bk(1), current_date, '12:00');
select record_pdi_result((select id from pdi_inspections where booking_id = pg_temp.bk(1) and status = 'scheduled'), pg_temp.all_ok());
do $$ begin
  if pg_temp.stage(1) <> 'to_move' then raise exception 'passed → to_move: %', pg_temp.stage(1); end if;
end $$;
select pg_temp.expect_error($$select pdi_mark_washed(pg_temp.bk(1))$$, 'Wash the car once');
select pdi_mark_at_location(pg_temp.bk(1), pg_temp.yard('Delivery bay'));
do $$ begin
  if pg_temp.stage(1) <> 'to_wash' then raise exception 'at the bay → to_wash: %', pg_temp.stage(1); end if;
end $$;
select pdi_mark_washed(pg_temp.bk(1));
do $$ begin
  if pg_temp.stage(1) <> 'ready' then raise exception 'washed → ready: %', pg_temp.stage(1); end if;
  if (select stage from pdi_flow_board() where booking_id = pg_temp.bk(1)) <> 'ready' then raise exception 'flow board'; end if;
end $$;

-- ===== Delivery bays =====
reset role;
update outlet_hours set day_start = '10:00', day_end = '12:00', slot_minutes = 30, max_per_bay = 2
where outlet_id = '00000000-0000-0000-0002-000000000001';
set local role authenticated;
select pg_temp.as_user('3');
select pg_temp.expect_error($$select book_delivery_bay(pg_temp.bk(1), current_date + 1, '10:15')$$, 'Slots start every 30 minutes from 10:00');
select pg_temp.expect_error($$select book_delivery_bay(pg_temp.bk(1), current_date + 1, '11:45')$$, 'Pick a time between 10:00 and 12:00');
-- Four cars at 10:30: two bays × two each; the fifth is refused.
select book_delivery_bay(pg_temp.bk(n), current_date + 1, '10:30') from generate_series(1, 4) n;
select pg_temp.expect_error($$select book_delivery_bay(pg_temp.bk(5), current_date + 1, '10:30')$$, 'Every bay is full at 10:30');
-- (the 11:00 booking is rolled back with the refused one)
select pg_temp.expect_error($$select book_delivery_bay(pg_temp.bk(5), current_date + 1, '11:00', 1); select book_delivery_bay(pg_temp.bk(5), current_date + 1, '10:30', 1)$$, 'Bay 1 is full at 10:30');
do $$ begin
  if (select count(distinct bay_no) from delivery_slots where slot_date = current_date + 1 and slot_time = '10:30' and status = 'booked') <> 2 then
    raise exception 'two bays used';
  end if;
  if (select slot_end from delivery_slots where booking_id = pg_temp.bk(1) and status = 'booked') <> '11:00' then raise exception 'slot end'; end if;
  if (select count(*) from delivery_day_board('00000000-0000-0000-0002-000000000001', current_date + 1) where booking_id is not null) <> 4 then
    raise exception 'day board shows the bookings';
  end if;
  if (select pdi_stage from delivery_day_board('00000000-0000-0000-0002-000000000001', current_date + 1) where booking_id = pg_temp.bk(1)) <> 'ready' then
    raise exception 'board shows PDI stage';
  end if;
end $$;
-- Past slots only for the Outlet Head.
select book_delivery_bay(pg_temp.bk(5), current_date - 1, '10:00');
select pg_temp.as_user('5');
select pg_temp.expect_error($$select book_delivery_bay(pg_temp.bk(4), current_date - 1, '10:00')$$, 'Only the Outlet Head can record a delivery slot in the past');

-- Delivered counts
reset role;
insert into deliveries (booking_id, status, delivered_at) values (pg_temp.bk(2), 'delivered', now()), (pg_temp.bk(3), 'delivered', now() - interval '40 days');
set local role authenticated;
select pg_temp.as_user('3');
do $$ begin
  if (select ltd from delivered_counts()) < 2 or (select ftd from delivered_counts()) < 1 then raise exception 'delivered counts: %', (select row(d.*) from delivered_counts() d); end if;
end $$;

select 'pdi_delivery_flow: all checks passed';
rollback;
