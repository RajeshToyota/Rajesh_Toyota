-- Stock Allotment Pool:
--   - pool size from free cars; FIFO membership by booking date
--   - whoever completes first (DO received, or 70% cleared for cash) wins the oldest car
--   - an earlier booking pushes out a later member; completed and fast-tracked members stay
--   - hold releases the car to the next winner; a resumed booking keeps its booking date
--   - a bounced cheque takes the car back, unless it has gone for billing
--   - a car leaving the yard report is taken back and the winner gets the next one
--   - change car (free car, and a swap with another customer)
--   - switched off, nothing moves; switching on rechecks every pool
--   - VNA demand, and who may do what
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/stock_allotment_pool.sql
begin;
-- Recheck pools at the end of each statement instead of at commit (the test never commits).
set constraints all immediate;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000001'), ('a0000000-0000-0000-0000-000000000003'),
  ('a0000000-0000-0000-0000-000000000005');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000001', '00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005');

update pool_config set enabled = true;

create or replace function pg_temp.as_user(n text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;
create or replace function pg_temp.vin(n int) returns text language sql as $$
  select 'MBJPLMM1STE2' || lpad(n::text, 5, '0');
$$;
create or replace function pg_temp.bk(n int) returns uuid language sql as $$
  select ('00000000-0000-0000-00cc-00000000000' || n)::uuid;
$$;
create or replace function pg_temp.car(n int) returns uuid language sql as $$
  select id from vehicles where vin = pg_temp.vin(n);
$$;
-- Members of the Hyryder V Cafe White pool, e.g. '1,2,3'.
create or replace function pg_temp.members() returns text language sql as $$
  select coalesce(string_agg(right(booking_id::text, 1), ',' order by booking_id), '') from pool_members
  where status = 'active';
$$;
-- Car n's current booking number, or '-'.
create or replace function pg_temp.holder(n int) returns text language sql as $$
  select coalesce((select right(a.booking_id::text, 1) from allotments a where a.vehicle_id = pg_temp.car(n) and a.released_at is null), '-');
$$;
create or replace function pg_temp.add_car(n int, days int) returns void language sql as $$
  insert into vehicles (vin, outlet_id, source, variant_id, color_id, days_since_invoice, ctdms_block_status)
  select pg_temp.vin(n), '00000000-0000-0000-0002-000000000001', 'physical', v.id, c.id, days, 'Free'
  from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
$$;
-- A finance case at DO received, with its stage history, in one statement.
create or replace function pg_temp.give_do(n int) returns void language sql as $$
  with c as (
    insert into finance_cases (booking_id, outlet_id, financier_id, applicant_type, status, do_number, do_amount, do_date)
    values (pg_temp.bk(n), '00000000-0000-0000-0002-000000000001', (select id from financiers where short_name = 'SBI'),
            'salaried', 'do_received', 'DO-' || n, 1000000, current_date)
    returning id)
  insert into finance_case_events (case_id, status_from, status_to) select id, 'sanctioned', 'do_received' from c;
$$;
create or replace function pg_temp.pay(n int, pct numeric, status text default 'cleared') returns void language sql as $$
  insert into payment_receipts (booking_id, outlet_id, mode, amount, clearance_status, cleared_on, notes)
  select pg_temp.bk(n), '00000000-0000-0000-0002-000000000001', 'cheque', round(a.deal_amount * pct / 100, 2), status,
         case when status = 'cleared' then current_date end, 'pay ' || pct
  from booking_account(pg_temp.bk(n)) a;
$$;

-- Five Hyryder V Cafe White bookings at Jaipur by SC1; 1 is the oldest. Booking 6 is older than all,
-- but waits for a discount approval.
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                      mode_of_purchase, data_consent, created_at)
select pg_temp.bk(n), '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Pool Buyer ' || n,
       v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium', 'Cash', true,
       now() - make_interval(days => case when n = 6 then 30 else 10 - n end)
from generate_series(1, 6) n, variants v, colors c
where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
insert into approvals (booking_id, requested_by_employee_id, required_role_id, status, requested_discount_amount)
values (pg_temp.bk(6), '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0001-000000000003', 'pending', 50000);

do $$
begin
  if (select deal_amount from booking_account(pg_temp.bk(1))) <= 0 then
    raise exception 'test bookings need a price';
  end if;
  if pg_temp.members() <> '' then
    raise exception 'no free car, so no pool: %', pg_temp.members();
  end if;
end $$;

-- ---- 1. Two free cars: pool of 3, the three earliest bookings
select pg_temp.add_car(1, 50);
select pg_temp.add_car(2, 10);
do $$
begin
  if pg_temp.members() <> '1,2,3' then
    raise exception '1: members wrong: %', pg_temp.members();
  end if;
  if exists (select 1 from allotments where released_at is null) then
    raise exception '1: nobody has completed, nothing should be allotted';
  end if;
end $$;

-- ---- 2. Booking 3 gets its DO first: it wins the oldest car though 1 and 2 booked earlier
select pg_temp.give_do(3);
do $$
begin
  if pg_temp.holder(1) <> '3' or pg_temp.holder(2) <> '-' then
    raise exception '2: car 1 should go to booking 3 (cars: %, %)', pg_temp.holder(1), pg_temp.holder(2);
  end if;
  if (select method || ':' || win_path from allotments where booking_id = pg_temp.bk(3) and released_at is null) <> 'pool:do'
     or (select status from bookings where id = pg_temp.bk(3)) <> 'allocated'
     or not exists (select 1 from ctdms_block_tasks where booking_id = pg_temp.bk(3) and action = 'block' and status = 'pending') then
    raise exception '2: pool allotment not recorded as expected';
  end if;
  -- One free car left: pool of 2.
  if pg_temp.members() <> '1,2' then
    raise exception '2: members wrong: %', pg_temp.members();
  end if;
end $$;

-- ---- 3. Cash: 69% cleared is not enough; a cheque clearing to 71% wins car 2
select pg_temp.pay(2, 69);
do $$
begin
  if pg_temp.holder(2) <> '-' then
    raise exception '3: 69%% should not win';
  end if;
end $$;
select pg_temp.pay(2, 2, 'pending');
do $$
begin
  if pg_temp.holder(2) <> '-' then
    raise exception '3: an uncleared cheque should not count';
  end if;
end $$;
update payment_receipts set clearance_status = 'cleared', cleared_on = current_date where booking_id = pg_temp.bk(2) and notes = 'pay 2';
do $$
begin
  if pg_temp.holder(2) <> '2' or (select win_path from allotments where booking_id = pg_temp.bk(2) and released_at is null) <> 'cash' then
    raise exception '3: booking 2 should win car 2 on cash';
  end if;
  -- No free cars: the pool empties and booking 1 leaves it.
  if pg_temp.members() <> '' or (select status from pool_members where booking_id = pg_temp.bk(1)) <> 'removed' then
    raise exception '3: members wrong: %', pg_temp.members();
  end if;
end $$;

-- ---- 4. Car 3 arrives: 1 and 4 join. The OH fast-tracks 5, which pushes out 4. Approving 6 (the
-- oldest booking) then pushes out 1, but not the fast-tracked 5.
select pg_temp.add_car(3, 5);
do $$
begin
  if pg_temp.members() <> '1,4' then
    raise exception '4: members wrong: %', pg_temp.members();
  end if;
end $$;

set local role authenticated;
select pg_temp.as_user('5');
do $$
begin
  begin
    perform pool_fast_track(pg_temp.bk(5), 'VIP');
    raise exception 'SC fast-track: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only an Outlet Head%' then raise; end if;
  end;
  if exists (select 1 from pool_overview()) then
    raise exception 'a Sales Consultant should not see the pool overview';
  end if;
end $$;
select pg_temp.as_user('3');
do $$
begin
  begin
    perform pool_fast_track(pg_temp.bk(5), ' ');
    raise exception 'fast-track without reason: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Give the reason%' then raise; end if;
  end;
  perform pool_fast_track(pg_temp.bk(5), 'Corporate customer, promised this month');
  if pg_temp.members() <> '1,5' then
    raise exception '4: after fast-track members wrong: %', pg_temp.members();
  end if;
end $$;
reset role;

update approvals set status = 'approved' where booking_id = pg_temp.bk(6);
do $$
begin
  if pg_temp.members() <> '5,6' then
    raise exception '4: after approval members wrong: %', pg_temp.members();
  end if;
  if (select string_agg(event, ',' order by created_at) from pool_audit_log where booking_id = pg_temp.bk(1)) not like '%pool_bump' then
    raise exception '4: booking 1 should have been pushed out';
  end if;
end $$;

-- ---- 5. Booking 5 gets its DO and car 3; 6 leaves the empty pool. Booking 3 goes on hold: car 1 is
-- freed, 1 and 4 join, and 1 pays in full and takes it. Booking 3 resumes and, on the next car,
-- re-enters with its original date ahead of 4 and wins it with the DO it already has.
select pg_temp.give_do(5);
do $$
begin
  if pg_temp.holder(3) <> '5' or pg_temp.members() <> '' then
    raise exception '5: car 3 should go to booking 5 (members %)', pg_temp.members();
  end if;
end $$;

set local role authenticated;
select pg_temp.as_user('3');
select pool_member_hold(pg_temp.bk(3), 'Customer travelling');
reset role;
do $$
begin
  if pg_temp.holder(1) <> '-' or pg_temp.members() <> '1,6' then
    raise exception '5: after hold car 1 should be free and 1, 6 in the pool (holder %, members %)', pg_temp.holder(1), pg_temp.members();
  end if;
end $$;
select pg_temp.pay(1, 100);
do $$
begin
  if pg_temp.holder(1) <> '1' then
    raise exception '5: car 1 should go to booking 1';
  end if;
end $$;

set local role authenticated;
select pg_temp.as_user('3');
select resume_booking(pg_temp.bk(3), 'Back');
reset role;
select pg_temp.add_car(4, 1);
do $$
begin
  if pg_temp.holder(4) <> '3' then
    raise exception '5: resumed booking 3 should win car 4 (holder %, members %)', pg_temp.holder(4), pg_temp.members();
  end if;
end $$;

-- ---- 6. Billing locks a car in: booking 1's cheque bouncing doesn't take car 1 back once billed.
-- Booking 2's cheque bouncing does take car 2 back.
insert into billing_requests (booking_id, vehicle_id, allotment_id, outlet_id)
select a.booking_id, a.vehicle_id, a.id, '00000000-0000-0000-0002-000000000001' from allotments a
where a.booking_id = pg_temp.bk(1) and a.released_at is null;
update payment_receipts set clearance_status = 'bounced' where booking_id = pg_temp.bk(1);
update payment_receipts set clearance_status = 'bounced' where booking_id = pg_temp.bk(2) and notes = 'pay 2';
do $$
begin
  if pg_temp.holder(1) <> '1' then
    raise exception '6: a car sent for billing must stay';
  end if;
  if pg_temp.holder(2) <> '-' or (select status from vehicles where id = pg_temp.car(2)) <> 'available' then
    raise exception '6: booking 2 should lose car 2';
  end if;
  if (select status || ':' || coalesce(completed_at::text, 'open') from pool_members where booking_id = pg_temp.bk(2)) <> 'active:open' then
    raise exception '6: booking 2 should be back in the pool, not completed';
  end if;
end $$;

-- ---- 7. Car 4 leaves the yard report: booking 3 loses it and, still holding its DO, takes car 2.
update vehicles set missing_from_report = true where id = pg_temp.car(4);
do $$
begin
  if pg_temp.holder(4) <> '-' or pg_temp.holder(2) <> '3' then
    raise exception '7: booking 3 should move from car 4 to car 2 (cars: %, %)', pg_temp.holder(4), pg_temp.holder(2);
  end if;
end $$;

-- ---- 8. Change car: booking 3 asks for car 5 (free); then takes car 2 back from booking 2, who
-- gets car 5 in return.
select pg_temp.add_car(5, 3);
select pg_temp.pay(2, 2);
do $$
begin
  if pg_temp.holder(5) <> '2' then
    raise exception '8: booking 2 should win car 5 (holder %)', pg_temp.holder(5);
  end if;
end $$;
select pg_temp.add_car(7, 2);
set local role authenticated;
select pg_temp.as_user('3');
do $$
declare
  r jsonb;
begin
  r := pool_change_vehicle(pg_temp.bk(3), pg_temp.car(7), 'Customer wants the car with the dashcam fitted');
  if r->>'status' <> 'changed' or pg_temp.holder(7) <> '3' then
    raise exception '8: change to a free car failed: %', r;
  end if;
end $$;
reset role;
do $$
begin
  -- Car 2 is free again and nobody has completed, so it stays free.
  if pg_temp.holder(2) <> '-' then
    raise exception '8: car 2 should be free';
  end if;
end $$;
set local role authenticated;
select pg_temp.as_user('3');
do $$
declare
  r jsonb;
begin
  r := pool_change_vehicle(pg_temp.bk(3), pg_temp.car(5), 'Swap');
  if r->>'status' <> 'needs_replacement' or (r->>'other_booking_id')::uuid <> pg_temp.bk(2) or pg_temp.holder(5) <> '2' then
    raise exception '8: taking another customer''s car should ask for a replacement: %', r;
  end if;
  r := pool_change_vehicle(pg_temp.bk(3), pg_temp.car(5), 'Swap', pg_temp.car(7));
  if r->>'status' <> 'swapped' or pg_temp.holder(5) <> '3' or pg_temp.holder(7) <> '2' then
    raise exception '8: swap failed: % (5: %, 7: %)', r, pg_temp.holder(5), pg_temp.holder(7);
  end if;
  begin
    perform pool_change_vehicle(pg_temp.bk(1), pg_temp.car(2), 'x');
    raise exception 'change a billed car: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This car has been sent for billing%' then raise; end if;
  end;
end $$;
reset role;

-- ---- 9. VNA: free car 2, pool of 2 (4 and 6). Waiting: 6, 4 (positions 1-2 of 1 free) -> 4 is VNA.
do $$
begin
  if pg_temp.members() <> '4,6' then
    raise exception '9: members wrong: %', pg_temp.members();
  end if;
end $$;
set local role authenticated;
select pg_temp.as_user('3');
do $$
begin
  if (select string_agg(right(booking_id::text, 1), ',') from pool_vna_demand()) <> '4' then
    raise exception '9: VNA wrong: %', (select string_agg(right(booking_id::text, 1) || '@' || queue_position, ',') from pool_vna_demand());
  end if;
  if (select string_agg(right(booking_id::text, 1), ',' order by booking_id) from pool_finance_queue()) <> '4,6'
     or (select free_cars from pool_overview() limit 1) <> 1 or (select pool_size from pool_overview() limit 1) <> 2 then
    raise exception '9: finance queue / overview wrong';
  end if;
  if (select count(*) from pool_detail((select variant_id from pool_members limit 1), (select color_id from pool_members limit 1))) <> 6 then
    raise exception '9: pool detail should list 4 allotted (1, 2, 3, 5) and 2 members (4, 6): %',
      (select string_agg(right(booking_id::text, 1) || ':' || place, ',') from pool_detail((select variant_id from pool_members limit 1), (select color_id from pool_members limit 1)));
  end if;
end $$;
reset role;

-- ---- 10. Switched off nothing moves; switching back on rechecks every pool.
update pool_config set enabled = false;
select pg_temp.give_do(6);
do $$
begin
  if pg_temp.holder(2) <> '-' then
    raise exception '10: the pool is off, nothing should be allotted';
  end if;
end $$;
set local role authenticated;
select pg_temp.as_user('3');
do $$
begin
  begin
    perform pool_config_update(true, null, null, null);
    raise exception 'OH switching the pool on: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only a Business Head%' then raise; end if;
  end;
end $$;
select pg_temp.as_user('1');
do $$
declare
  r jsonb;
begin
  r := pool_config_update(true, null, null, null);
  if (r->>'allotted')::int <> 1 or pg_temp.holder(2) <> '6' then
    raise exception '10: switching on should allot car 2 to booking 6: %', r;
  end if;
  if not exists (select 1 from pool_audit_search() where event = 'config_change') then
    raise exception '10: config change not logged';
  end if;
end $$;
reset role;

do $$
begin
  if exists (select 1 from pool_audit_log where event = 'engine_error') then
    raise exception 'engine errors: %', (select string_agg(details->>'error', '; ') from pool_audit_log where event = 'engine_error');
  end if;
end $$;

select 'stock_allotment_pool tests passed' as result;
rollback;
