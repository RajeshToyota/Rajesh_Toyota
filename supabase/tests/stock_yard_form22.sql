-- Stock, yard and Form 22 (Phase 27):
--   - ADD puts a car that left the report back into free stock (Outlet Head only); DEDUCT takes one out;
--     an ended entry stops counting
--   - inward dealer transfer: car created on receipt and allotted to the customer it was bought for;
--     outward: out of free stock once requested
--   - transit import, receive from transit, delivered car moves to the Delivered yard
--   - Form 22 pending, battery change at 90 days, job cards, yard overview, planning, chassis monitor
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/stock_yard_form22.sql
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
create or replace function pg_temp.free(p_vin text) returns boolean language sql security definer as $$
  select vehicle_allotable(v) from vehicles v where v.vin = p_vin;
$$;

-- Cars: A left the report (cancelled billing), B in the yard, C in transit, D old allotted car.
insert into vehicles (id, vin, outlet_id, source, status, variant_id, color_id, location, missing_from_report, tkm_invoice_date)
select ('00000000-0000-0000-00cc-0000000027a' || n)::uuid, 'MBJSTX0000000027' || n, '00000000-0000-0000-0002-000000000001',
       case n when 3 then 'transit' else 'physical' end, 'available', v.id, c.id,
       case n when 3 then null else 'Main yard' end, n = 1, current_date - case n when 4 then 100 else 10 end
from generate_series(1, 4) n, variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option, status)
select ('00000000-0000-0000-00bb-0000000027b' || n)::uuid, '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005',
       'Stock Buyer ' || n, v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium', 'booked'
from generate_series(1, 3) n, variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
insert into other_dealers (id, name, city) values ('0d000000-0000-0000-0000-000000000001', 'Other Toyota Ajmer', 'Ajmer');

set local role authenticated;

-- ===== ADD / DEDUCT =====
select pg_temp.as_user('5');
select pg_temp.expect_error($$select set_stock_control_v2('00000000-0000-0000-00cc-0000000027a1', 'add', 'cancelled_billing', 'Billing cancelled')$$, 'Car not found');
select pg_temp.as_user('3');
do $$ begin
  if pg_temp.free('MBJSTX00000000271') then raise exception 'a car missing from the report is not free'; end if;
  perform set_stock_control_v2('00000000-0000-0000-00cc-0000000027a1', 'add', 'cancelled_billing', 'Billing cancelled, car in yard');
  if not pg_temp.free('MBJSTX00000000271') then raise exception 'ADD makes it free'; end if;
  perform set_stock_control_v2('00000000-0000-0000-00cc-0000000027a2', 'deduct', 'damage', 'Dent on door', current_date + 5);
  if pg_temp.free('MBJSTX00000000272') then raise exception 'DEDUCT takes it out'; end if;
end $$;
-- An ended deduct no longer counts.
reset role;
update stock_controls set effective_to = current_date - 1 where vehicle_id = '00000000-0000-0000-00cc-0000000027a2';
set local role authenticated;
select pg_temp.as_user('3');
do $$ begin
  if not pg_temp.free('MBJSTX00000000272') then raise exception 'ended deduct'; end if;
  if (chassis_monitor()->>'free')::int < 2 then raise exception 'monitor counts free cars: %', chassis_monitor(); end if;
end $$;

-- ===== Dealer transfers =====
do $$
declare
  t uuid;
  v uuid;
begin
  -- Outward: out of free stock from the request on.
  t := request_dealer_transfer(jsonb_build_object('direction', 'outward', 'other_dealer_id', '0d000000-0000-0000-0000-000000000001',
        'vehicle_id', '00000000-0000-0000-00cc-0000000027a2', 'reason', 'Ajmer needs it'));
  if pg_temp.free('MBJSTX00000000272') then raise exception 'outward car is not free'; end if;
  perform move_dealer_transfer(t, 'approved');
  perform move_dealer_transfer(t, 'dispatched');
  if (select location from vehicles where vin = 'MBJSTX00000000272') <> 'Sent to Other Toyota Ajmer' then raise exception 'location after dispatch'; end if;
  if (chassis_monitor()->>'outward_still_in_report')::int <> 1 then raise exception 'monitor flags the outward car still in the report'; end if;

  -- Inward for booking b2: allotted to that booking on receipt.
  t := request_dealer_transfer(jsonb_build_object('direction', 'inward', 'other_dealer_id', '0d000000-0000-0000-0000-000000000001',
        'outlet_id', '00000000-0000-0000-0002-000000000001', 'vin', 'MBJSTX00000000279', 'booking_id', '00000000-0000-0000-00bb-0000000027b2',
        'variant_id', (select variant_id from bookings where id = '00000000-0000-0000-00bb-0000000027b2'),
        'color_id', (select color_id from bookings where id = '00000000-0000-0000-00bb-0000000027b2'), 'reason', 'For Stock Buyer 2'));
  perform move_dealer_transfer(t, 'approved');
  perform move_dealer_transfer(t, 'received');
  select vehicle_id into v from stock_transfers where id = t;
  if (select booking_id from allotments where vehicle_id = v and released_at is null) <> '00000000-0000-0000-00bb-0000000027b2' then
    raise exception 'inward car should go to the customer it was bought for';
  end if;
  if (select status from dealer_transfer_list(true) where id = t) <> 'received' then raise exception 'listed as received'; end if;
  perform move_dealer_transfer(t, 'ctdms_done');
end $$;

-- ===== Transit, receive, yard, delivery =====
select import_transit_details('[{"vin": "MBJSTX00000000273", "transporter": "ABC Logistics", "trailer_no": "RJ14 GA 1234", "expected_arrival": "2026-12-01"}]');
select pg_temp.expect_error($$select import_transit_details('[{"vin": "BAD"}]')$$, 'Every row needs a 17-character VIN');
select receive_from_transit('00000000-0000-0000-00cc-0000000027a3', (select id from yards where outlet_id = '00000000-0000-0000-0002-000000000001' and name = 'Main yard'), 'Ramesh', true);
do $$ begin
  if (select source from vehicles where vin = 'MBJSTX00000000273') <> 'physical' then raise exception 'received car is physical'; end if;
  if (select movement_type from vehicle_movements where vehicle_id = '00000000-0000-0000-00cc-0000000027a3') <> 'inward' then raise exception 'inward logged'; end if;
  if (select cars from yard_overview('00000000-0000-0000-0002-000000000001') where yard = 'Main yard') < 3 then raise exception 'yard overview counts'; end if;
end $$;

-- Battery: car D allotted, invoice 100 days old.
select allot_vehicle('00000000-0000-0000-00bb-0000000027b1', '00000000-0000-0000-00cc-0000000027a4', 'manual');
do $$ begin
  if not exists (select 1 from battery_change_list() where vin = 'MBJSTX00000000274') then raise exception '90+ day allotted car needs a battery case'; end if;
  if exists (select 1 from battery_change_list() where vin = 'MBJSTX00000000279') then raise exception 'a new car does not'; end if;
  perform set_battery_change_status('00000000-0000-0000-00cc-0000000027a4', 'approval_mail_sent', 'Mailed TKM');
  if (select status from battery_change_list() where vin = 'MBJSTX00000000274') <> 'approval_mail_sent' then raise exception 'battery status'; end if;
end $$;

-- Job card
select open_job_card('00000000-0000-0000-00cc-0000000027a4', 'JC-101');
select pg_temp.expect_error($$select open_job_card('00000000-0000-0000-00cc-0000000027a4', 'JC-102')$$, 'This car already has an open job card');
select close_job_card((select id from vehicle_job_cards where jc_no = 'JC-101'));

-- Form 22
do $$ begin
  if not exists (select 1 from form22_pending() where vin = 'MBJSTX00000000274' and not has_form22) then raise exception 'form 22 pending'; end if;
  perform set_vehicle_document('00000000-0000-0000-00cc-0000000027a4', 'form_22', '00000000-0000-0000-00cc-0000000027a4/form22.pdf');
  if exists (select 1 from form22_pending() where vin = 'MBJSTX00000000274') then raise exception 'uploaded form 22 clears it'; end if;
  begin
    perform set_vehicle_document('00000000-0000-0000-00cc-0000000027a4', 'cng_form', '00000000-0000-0000-00cc-0000000027a4/cng.pdf');
    raise exception 'cng on a non-CNG car: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This car is not a CNG car%' then raise; end if;
  end;
end $$;

-- Delivery moves the car to the Delivered yard.
reset role;
update bookings set status = 'delivered' where id = '00000000-0000-0000-00bb-0000000027b1';
do $$ begin
  if (select location from vehicles where vin = 'MBJSTX00000000274') <> 'Delivered' then raise exception 'delivered car moves to the Delivered yard'; end if;
  if not exists (select 1 from vehicle_movements where vehicle_id = '00000000-0000-0000-00cc-0000000027a4' and movement_type = 'delivered') then
    raise exception 'delivery movement logged';
  end if;
end $$;
set local role authenticated;
select pg_temp.as_user('3');

-- ===== Planning =====
insert into open_orders (outlet_id, variant_id, color_id, quantity)
select '00000000-0000-0000-0002-000000000001', variant_id, color_id, 1 from bookings where id = '00000000-0000-0000-00bb-0000000027b3';
do $$
declare
  p record;
begin
  select * into p from stock_planning('00000000-0000-0000-0002-000000000001') sp
  where sp.variant_id = (select variant_id from bookings where id = '00000000-0000-0000-00bb-0000000027b3')
    and sp.color_id = (select color_id from bookings where id = '00000000-0000-0000-00bb-0000000027b3');
  -- Bookings this month: 3 here (+ any seed) → weighted ≥ 1.5; open order 1.
  if p.sales_m1 < 3 or p.open_orders <> 1 or p.weighted_sales <> round(0.5 * p.sales_m1 + 0.3 * p.sales_m2 + 0.2 * p.sales_m3, 1) then
    raise exception 'planning numbers: %', p;
  end if;
  if p.order_qty <> greatest(0, ceil(greatest(p.weighted_sales, p.vna)) - (p.free + p.open_orders)) then raise exception 'order qty: %', p; end if;
end $$;

-- ===== Search by variant =====
do $$ begin
  if not exists (select 1 from search_console_mode('variant', 'D22U4')) then raise exception 'variant search'; end if;
end $$;

select 'stock_yard_form22: all checks passed';
rollback;
