-- Stock extras (Phase 21): price difference blocks the pool until collected / waived, stock control,
-- transfers between branches, yard log, other dealers' stock against VNA demand, search console.
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/stock_extras.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000005'),
  ('a0000000-0000-0000-0000-000000000007'), ('a0000000-0000-0000-0000-000000000009');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000007');
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-000000000009', 'a0000000-0000-0000-0000-000000000009', 'Jaipur Accounts',
   '00000000-0000-0000-0001-000000000007', '00000000-0000-0000-0002-000000000001');

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

-- A Hyryder (D22U4, ZHJ standard paint) booked a month ago on the private list at Rs 19,99,000; the price
-- went up Rs 25,000 today. A Jaipur yard car of another colour (ZAM).
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                      mode_of_purchase, data_consent, payment_instrument_type, payment_amount, price_list_type, priced_as_of, created_at)
select '00000000-0000-0000-00bb-000000000071', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005',
       'Pricey Buyer', v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium', 'Cash', true, 'Cash', 50000, 'private',
       now() - interval '30 days', now() - interval '30 days'
from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
update pool_config set price_diff_blocks = true;
-- (The pricing trigger stamps priced_as_of at insert; back-date it as if priced a month ago.)
update bookings set priced_as_of = now() - interval '30 days' where id = '00000000-0000-0000-00bb-000000000071';
insert into price_list (variant_id, state, list_type, paint_category, ex_showroom_price, effective_from)
select v.id, p.state, 'private', 'standard', 2024000, current_date
from variants v join price_list p on p.variant_id = v.id and p.list_type = 'private' and p.paint_category = 'standard'
where v.tkm_suffix_code = 'D22U4' limit 1;
insert into vehicles (id, vin, outlet_id, source, status, variant_id, color_id, location)
select '00000000-0000-0000-00cc-000000000071', 'MBJSTX00000000071', '00000000-0000-0000-0002-000000000001', 'physical', 'available', v.id, c.id, 'Main yard'
from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZAM';
-- Fully paid in cash, so only the price difference stands between the booking and a car.
insert into payment_receipts (booking_id, outlet_id, mode, amount, received_on, clearance_status, cleared_on)
values ('00000000-0000-0000-00bb-000000000071', '00000000-0000-0000-0002-000000000001', 'cash', 2400000, current_date, 'cleared', current_date);

do $$
declare
  d record;
begin
  select * into d from booking_price_difference('00000000-0000-0000-00bb-000000000071');
  if d.booked_price <> 1999000 or d.current_price <> 2024000 or d.difference <> 25000 then
    raise exception 'price difference wrong: %', row_to_json(d);
  end if;
  if (pool_booking_completion('00000000-0000-0000-00bb-000000000071')).completed_at is not null then
    raise exception 'an unresolved price difference should stop the booking winning a car';
  end if;
end $$;

set local role authenticated;

-- ===== Price difference: Accounts collects; only the Outlet Head waives =====
select pg_temp.as_user('9');
do $$ begin
  if (select difference from price_diff_list()) <> 25000 then raise exception 'list should show the difference'; end if;
end $$;
select pg_temp.expect_error($$select resolve_price_difference('00000000-0000-0000-00bb-000000000071', 'waived', 'goodwill')$$,
  'Only the Outlet Head can waive');
select resolve_price_difference('00000000-0000-0000-00bb-000000000071', 'collected', 'Receipt 778');
do $$ begin
  if exists (select 1 from price_diff_list()) then raise exception 'resolved difference should leave the open list'; end if;
end $$;
reset role;
do $$ begin
  if (pool_booking_completion('00000000-0000-0000-00bb-000000000071')).completed_at is null then
    raise exception 'once collected the booking can win';
  end if;
end $$;
set local role authenticated;

-- ===== Stock control =====
select pg_temp.as_user('5');
select pg_temp.expect_error($$select set_stock_control('00000000-0000-0000-00cc-000000000071', 'damaged', 'Dent')$$, 'Car not found');
select pg_temp.as_user('3');
select set_stock_control('00000000-0000-0000-00cc-000000000071', 'damaged', 'Dent on the tailgate');
select pg_temp.expect_error($$select set_stock_control('00000000-0000-0000-00cc-000000000071', 'demo', 'x')$$, 'This car is already under stock control');
reset role;
do $$ begin
  if vehicle_allotable((select v from vehicles v where id = '00000000-0000-0000-00cc-000000000071')) then
    raise exception 'a controlled car must not be allotable';
  end if;
end $$;
set local role authenticated;
select pg_temp.as_user('3');
select clear_stock_control('00000000-0000-0000-00cc-000000000071', 'Repaired');

-- ===== Yard =====
select pg_temp.as_user('3');
select pg_temp.expect_error(format($f$select log_vehicle_movement('00000000-0000-0000-00cc-000000000071', 'battery_check', null)$f$), 'Record the battery voltage');
select log_vehicle_movement('00000000-0000-0000-00cc-000000000071', 'workshop',
  (select id from yards where outlet_id = '00000000-0000-0000-0002-000000000001' and name = 'Workshop'), 'Tailgate repair');
select log_vehicle_movement('00000000-0000-0000-00cc-000000000071', 'battery_check', null, null, null, 12.6);
select pg_temp.expect_error(format($f$select log_vehicle_movement('00000000-0000-0000-00cc-000000000071', 'yard_move', '%s')$f$,
  (select id from yards where outlet_id = '00000000-0000-0000-0002-000000000003' limit 1)), 'Pick a yard of this branch');
do $$ begin
  if (select location from yard_stock() where vin = 'MBJSTX00000000071') <> 'Workshop'
     or (select last_battery_check from yard_stock() where vin = 'MBJSTX00000000071') is null then
    raise exception 'yard should show the workshop and the battery check';
  end if;
end $$;

-- ===== Transfer Jaipur -> Jodhpur =====
select pg_temp.as_user('7');
select request_stock_transfer('00000000-0000-0000-00cc-000000000071', '00000000-0000-0000-0002-000000000002', 'Customer in Jodhpur wants ZAM');
select pg_temp.expect_error($$select move_stock_transfer((select id from stock_transfers), 'approved')$$, 'Only the sending branch''s Outlet Head');
select pg_temp.as_user('3');
select move_stock_transfer((select id from stock_transfers), 'approved');
select pg_temp.expect_error($$select move_stock_transfer((select id from stock_transfers), 'received')$$, 'Only the receiving branch');
select pg_temp.as_user('7');
select move_stock_transfer((select id from stock_transfers), 'received');
reset role;
do $$ begin
  if (select outlet_id from vehicles where id = '00000000-0000-0000-00cc-000000000071') <> '00000000-0000-0000-0002-000000000002' then
    raise exception 'received car should belong to Jodhpur';
  end if;
end $$;
set local role authenticated;

-- ===== Other dealers' stock against VNA demand =====
select pg_temp.as_user('3');
do $$
declare
  r record;
begin
  select * into r from import_other_dealer_stock('Shree Toyota Ajmer', 'AJ01A', 'Ajmer', '9800000000',
    '[{"suffix_code": "d22u4", "color_code": "zhj", "quantity": 2, "offer_note": "Can transfer this week"},
      {"suffix_code": "ZZZ99", "color_code": "XXX"}]');
  if r.loaded <> 2 or r.unmapped <> 1 then raise exception 'import wrong: %', row_to_json(r); end if;
  -- Re-uploading replaces the dealer's list.
  select * into r from import_other_dealer_stock('shree toyota ajmer', null, 'Ajmer', null, '[{"suffix_code": "D22U4", "color_code": "ZHJ"}]');
  if (select count(*) from other_dealer_stock) <> 1 then raise exception 're-upload should replace the list'; end if;
  if not exists (select 1 from vna_other_dealer_matches() where customer_name = 'Pricey Buyer' and dealer_name = 'shree toyota ajmer') then
    raise exception 'the waiting booking should match the Ajmer car';
  end if;
end $$;

-- ===== Search console =====
select pg_temp.as_user('5');
select pg_temp.expect_error($$select * from search_console('ab')$$, 'Type at least 3 characters');
do $$ begin
  if not exists (select 1 from search_console('pricey') where kind = 'booking') then raise exception 'name search failed'; end if;
  if not exists (select 1 from search_console('STX0000000007') where kind = 'vehicle') then raise exception 'VIN search failed'; end if;
  if (select count(*) from vehicle_timeline('00000000-0000-0000-00cc-000000000071') where event like 'Stock control%') <> 2
     or not exists (select 1 from vehicle_timeline('00000000-0000-0000-00cc-000000000071') where event = 'Transfer received') then
    raise exception 'timeline incomplete: %', (select json_agg(t) from vehicle_timeline('00000000-0000-0000-00cc-000000000071') t);
  end if;
end $$;

select 'stock_extras: all checks passed';
rollback;
