-- Pool extras (Phase 28):
--   - cross-match pair D22U4 (base) ↔ D22BA (upgraded): a D22U4 winner with no D22U4 car takes the D22BA
--     car (upgrade, +adjustment mirrored on the booking); not when a D22BA winner is waiting; released → 0
--   - next in line, average clear time, DO revert, revert from billing, WhatsApp send log, manual-only variant
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/pool_extras.sql
begin;
set constraints all immediate;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000005');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005');
update pool_config set enabled = true;

create or replace function pg_temp.as_user(n text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;
create or replace function pg_temp.bk(n int) returns uuid language sql as $$
  select ('00000000-0000-0000-00dd-00000000000' || n)::uuid;
$$;
create or replace function pg_temp.v(code text) returns uuid language sql as $$ select id from variants where tkm_suffix_code = code $$;
create or replace function pg_temp.zhj() returns uuid language sql as $$ select id from colors where tkm_color_code = 'ZHJ' $$;
create or replace function pg_temp.add_car(p_vin text, code text) returns void language sql as $$
  insert into vehicles (vin, outlet_id, source, variant_id, color_id, days_since_invoice, ctdms_block_status)
  values (p_vin, '00000000-0000-0000-0002-000000000001', 'physical', pg_temp.v(code), pg_temp.zhj(), 20, 'Free');
$$;
create or replace function pg_temp.pay_full(n int) returns void language sql as $$
  insert into payment_receipts (booking_id, outlet_id, mode, amount, clearance_status, cleared_on)
  select pg_temp.bk(n), '00000000-0000-0000-0002-000000000001', 'cash', a.deal_amount, 'cleared', current_date from booking_account(pg_temp.bk(n)) a;
$$;
create or replace function pg_temp.holder(p_vin text) returns uuid language sql as $$
  select a.booking_id from allotments a join vehicles v on v.id = a.vehicle_id where v.vin = p_vin and a.released_at is null;
$$;

-- Bookings: 1 and 2 want D22U4 (base), 3 wants D22BA (upgraded).
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option, created_at)
select pg_temp.bk(n), '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Pair Buyer ' || n,
       pg_temp.v(case when n = 3 then 'D22BA' else 'D22U4' end), pg_temp.zhj(), '00000000-0000-0000-000b-000000000001', 'premium',
       now() - make_interval(days => 10 - n)
from generate_series(1, 3) n;

-- The pair, as the Business Head would set it up.
insert into auth.users (id) values ('a0000000-0000-0000-0000-000000000002');
update employees set auth_user_id = 'a0000000-0000-0000-0000-000000000002' where id = '00000000-0000-0000-0003-000000000002';
set local role authenticated;
select pg_temp.as_user('2');
select pool_pair_save(pg_temp.v('D22U4'), pg_temp.v('D22BA'), 50000, 'Fast charger');
do $$ begin
  begin
    perform pool_pair_save(pg_temp.v('D22U4'), pg_temp.v('D22BB'), 0, 'Again');
    raise exception 'second pair: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'A variant can be in only one active pair%' then raise; end if;
  end;
end $$;
reset role;

-- One D22BA car only. Booking 3 (D22BA) has not paid; booking 1 (D22U4) pays in full.
select pg_temp.add_car('MBJPAXR0000000001', 'D22BA');
select pg_temp.pay_full(1);
do $$ begin
  if pg_temp.holder('MBJPAXR0000000001') <> pg_temp.bk(1) then
    raise exception 'D22U4 winner should take the paired D22BA car: %', pg_temp.holder('MBJPAXR0000000001');
  end if;
  if (select cross_match_kind from allotments where booking_id = pg_temp.bk(1) and released_at is null) <> 'upgrade'
     or (select cross_match_adjustment from bookings where id = pg_temp.bk(1)) <> 50000 then
    raise exception 'upgrade adjustment mirrored on the booking';
  end if;
  if not exists (select 1 from pool_audit_log where event = 'cross_match_allotted' and booking_id = pg_temp.bk(1)) then raise exception 'logged'; end if;
end $$;

-- A D22BA winner waiting blocks the cross-match: booking 3 completes, a second D22BA car arrives,
-- booking 2 (D22U4) also completes — the new car goes to its own variant's winner.
select pg_temp.pay_full(3);
select pg_temp.pay_full(2);
select pg_temp.add_car('MBJPAXR0000000002', 'D22BA');
do $$ begin
  if pg_temp.holder('MBJPAXR0000000002') <> pg_temp.bk(3) then
    raise exception 'own-variant winner first: %', pg_temp.holder('MBJPAXR0000000002');
  end if;
  if exists (select 1 from allotments where booking_id = pg_temp.bk(2) and released_at is null) then raise exception 'booking 2 waits'; end if;
end $$;

-- Next in line: D22U4 has no free car and booking 2 waits.
set local role authenticated;
select pg_temp.as_user('3');
do $$ begin
  if not exists (select 1 from pool_next_in_line() where booking_id = pg_temp.bk(2) and queue_position = 1) then
    raise exception 'booking 2 is next in line';
  end if;
  if (select allotments from pool_avg_clear_time(1)) < 2 then raise exception 'clear time counts allotments'; end if;
end $$;

-- Hold booking 1: the car goes back, the adjustment comes off the booking.
select pg_temp.as_user('5');
select hold_booking(pg_temp.bk(1), 'Customer abroad');
reset role;
do $$ begin
  if (select cross_match_adjustment from bookings where id = pg_temp.bk(1)) <> 0 then raise exception 'released car clears the adjustment'; end if;
  if pg_temp.holder('MBJPAXR0000000001') <> pg_temp.bk(2) then raise exception 'freed car to booking 2: %', pg_temp.holder('MBJPAXR0000000001'); end if;
end $$;

-- Revert from billing: booking 3 sent for billing, then back to the pool.
-- (The billing request is made directly: send_for_billing's own checks have their own tests.)
insert into billing_requests (booking_id, vehicle_id, allotment_id, outlet_id, status)
select a.booking_id, a.vehicle_id, a.id, '00000000-0000-0000-0002-000000000001', 'pending'
from allotments a where a.booking_id = pg_temp.bk(3) and a.released_at is null;
update bookings set status = 'ready_to_invoice' where id = pg_temp.bk(3);
set local role authenticated;
select pg_temp.as_user('3');
do $$ begin
  perform pool_revert_from_billing(pg_temp.bk(3), 'allotted', 'Wrong invoice address');
  if exists (select 1 from billing_requests where booking_id = pg_temp.bk(3) and status = 'pending') then raise exception 'billing request cancelled'; end if;
  if (select status from bookings where id = pg_temp.bk(3)) <> 'allocated' then raise exception 'back to allotted'; end if;
end $$;

-- DO revert on a booking with a DO.
reset role;
insert into finance_cases (booking_id, outlet_id, financier_id, applicant_type, status, do_number, do_amount, do_date)
values (pg_temp.bk(3), '00000000-0000-0000-0002-000000000001', (select id from financiers limit 1), 'salaried', 'do_received', 'DO-9', 900000, current_date);
set local role authenticated;
select pg_temp.as_user('3');
select pool_revert_do(pg_temp.bk(3), 'Bank cancelled the DO');
reset role;
do $$ begin
  if (select status from finance_cases where booking_id = pg_temp.bk(3)) <> 'sanctioned' then raise exception 'DO withdrawn'; end if;
  if not exists (select 1 from pool_audit_log where event = 'do_reverted' and booking_id = pg_temp.bk(3)) then raise exception 'DO revert logged'; end if;
end $$;

-- Manual-only: a D22BB car never enters the pool.
update variants set pool_manual_only = true where tkm_suffix_code = 'D22BB';
select pg_temp.add_car('MBJPAXR0000000003', 'D22BB');
do $$ begin
  if pool_free_count(pg_temp.v('D22BB'), pg_temp.zhj()) <> 0 then raise exception 'manual-only stock is not pool stock'; end if;
end $$;

-- WhatsApp log
set local role authenticated;
select pg_temp.as_user('5');
insert into whatsapp_send_log (context, booking_id, slot_ref) values ('delivery', pg_temp.bk(2), '2026-12-01 10:00');
do $$ begin
  if (select slot_ref from whatsapp_last_sent('delivery', array[pg_temp.bk(2)])) <> '2026-12-01 10:00' then raise exception 'last send'; end if;
end $$;

select 'pool_extras: all checks passed';
rollback;
