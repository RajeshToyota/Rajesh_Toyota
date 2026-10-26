-- Stock, allotment and billing:
--   - stock import (colour mapping, transit -> physical, missing cars)
--   - FIFO and CTDMS-blocked proposals
--   - allot / swap / release with the CTDMS to-do
--   - send for billing (yard car + complete docket)
--   - Accounts recording the invoice
--   - who may do each step
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/stock_allotment.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000005'),
  ('a0000000-0000-0000-0000-000000000007'), ('a0000000-0000-0000-0000-000000000009'),
  ('a0000000-0000-0000-0000-00000000000a');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000007');
-- Accounts at Jaipur (9) and at Jodhpur (a).
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-000000000009', 'a0000000-0000-0000-0000-000000000009', 'Jaipur Accounts',
   '00000000-0000-0000-0001-000000000007', '00000000-0000-0000-0002-000000000001'),
  ('00000000-0000-0000-0003-00000000000a', 'a0000000-0000-0000-0000-00000000000a', 'Jodhpur Accounts',
   '00000000-0000-0000-0001-000000000007', '00000000-0000-0000-0002-000000000002');

create temp table t_ids (k text primary key, id uuid);
grant all on t_ids to authenticated;

-- Four Hyryder V (D22U4) Cafe White bookings by SC1. b1 is the oldest; b3 is CTDMS order ORD-T-3.
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                      mode_of_purchase, data_consent, ctdms_order_booking_no, created_at)
select ('00000000-0000-0000-00bb-00000000000' || n)::uuid, '00000000-0000-0000-0002-000000000001',
       '00000000-0000-0000-0003-000000000005', 'Stock Buyer ' || n, v.id, c.id, '00000000-0000-0000-000b-000000000001',
       'premium', 'Cash', true, case when n = 3 then 'ORD-T-3' end, now() - make_interval(days => 10 - n)
from generate_series(1, 4) n, variants v, colors c
where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';

create or replace function pg_temp.as_user(n text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;
create or replace function pg_temp.vin(n int) returns text language sql as $$
  select 'MBJUYMM1STE2' || lpad(n::text, 5, '0');
$$;
create or replace function pg_temp.row(n int, days int, extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('vin', pg_temp.vin(n) || '~0826', 'vin_raw', pg_temp.vin(n) || '~0826', 'suffix_code', 'D22U4',
    'ext_color', 'CAFE WHITE', 'model', 'URBAN CRUISER HYRYDER', 'days_since_invoice', days, 'invoice_amount', 1917485.03,
    'block_status', 'Free', 'pds_done', true) || extra;
$$;

set local role authenticated;

-- ---- A Sales Consultant can neither import nor allot
select pg_temp.as_user('5');
do $$
begin
  begin
    perform import_stock_statement('00000000-0000-0000-0002-000000000001', 'physical', current_date, 'x.pdf',
                                   jsonb_build_array(pg_temp.row(1, 50)));
    raise exception 'SC import: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only back office%' then raise; end if;
  end;
end $$;

-- ---- The Outlet Head imports: cars 1 (50 days) and 2 (10 days) in the yard, 4 blocked in CTDMS for
-- ORD-T-3, 5 with a colour CTDMS spells differently, 6 invoiced in CTDMS; car 3 in transit.
select pg_temp.as_user('3');
do $$
declare
  r jsonb;
begin
  r := import_stock_statement('00000000-0000-0000-0002-000000000001', 'physical', current_date, 'physical.pdf', jsonb_build_array(
    pg_temp.row(1, 50), pg_temp.row(2, 10),
    pg_temp.row(4, 30, '{"block_status": "Blocked", "order_no": "ORD-T-3", "order_status": "Booked"}'),
    pg_temp.row(5, 40, '{"ext_color": "CAFE WHITE DUAL TONE"}'),
    pg_temp.row(6, 60, '{"block_status": "Alloted", "order_no": "ORD-ELSEWHERE", "order_status": "Invoiced"}'),
    pg_temp.row(7, 5, '{"ext_color": "MYSTERY BLUE"}'),
    '{"vin": "NOT-A-VIN"}'::jsonb));
  if (r->>'rows')::int <> 6 or (r->>'inserted')::int <> 6 or r->'unmapped_colors' <> '["D22U4 MYSTERY BLUE"]'::jsonb
     or (r->>'ctdms_allotments_to_confirm')::int <> 1 then
    raise exception 'physical import summary wrong: %', r;
  end if;
  r := import_stock_statement('00000000-0000-0000-0002-000000000001', 'transit', current_date, 'transit.pdf',
                              jsonb_build_array(pg_temp.row(3, 2)));
  if (r->>'inserted')::int <> 1 then
    raise exception 'transit import summary wrong: %', r;
  end if;

  if (select c.name from vehicles v join colors c on c.id = v.color_id where v.vin = pg_temp.vin(5)) <> 'Cafe White & Midnight Black' then
    raise exception 'dual tone colour not mapped';
  end if;
  if (select tkm_invoice_date from vehicles where vin = pg_temp.vin(1)) <> current_date - 50 then
    raise exception 'invoice date not derived from days since invoice';
  end if;

  -- Map the unknown colour by hand; the car picks it up.
  if map_stock_color('Mystery Blue', null, (select id from colors where name = 'Speedy Blue')) <> 1
     or (select c.name from vehicles v join colors c on c.id = v.color_id where v.vin = pg_temp.vin(7)) <> 'Speedy Blue' then
    raise exception 'manual colour mapping not applied';
  end if;
end $$;

-- ---- Proposals: CTDMS already blocked car 4 for b3; FIFO gives b1 the oldest yard car (1), b2 the next (2)
do $$
declare
  p record;
begin
  select * into p from propose_ctdms_allotments() limit 1;
  if p.booking_id <> '00000000-0000-0000-00bb-000000000003' or p.vin <> pg_temp.vin(4) or not p.matches_booking then
    raise exception 'CTDMS proposal wrong: %', row_to_json(p);
  end if;
  perform allot_vehicle(p.booking_id, p.vehicle_id, 'ctdms');

  -- Yard cars before transit; car 5 is two-tone and car 6 invoiced in CTDMS, so neither is proposed.
  if (select string_agg(right(vin, 2) || '>' || right(booking_id::text, 1), ',' order by booking_date) from propose_fifo_allotments())
     <> '01>1,02>2,03>4' then
    raise exception 'FIFO proposals wrong: %', (select string_agg(right(vin, 2) || '>' || right(booking_id::text, 1), ',') from propose_fifo_allotments());
  end if;
  -- Confirm the first two; b4 stays open for the swap below.
  for p in select * from propose_fifo_allotments() where booking_id <> '00000000-0000-0000-00bb-000000000004' loop
    perform allot_vehicle(p.booking_id, p.vehicle_id, 'fifo');
  end loop;

  if (select status from bookings where id = '00000000-0000-0000-00bb-000000000001') <> 'allocated' then
    raise exception 'booking not allocated';
  end if;
  -- Block to-dos for the FIFO cars, none for the car CTDMS already has blocked for this order.
  if (select string_agg(right(v.vin, 2), ',' order by v.vin) from ctdms_block_tasks t join vehicles v on v.id = t.vehicle_id
      where t.status = 'pending' and t.action = 'block') <> '01,02' then
    raise exception 'block to-dos wrong';
  end if;
  if exists (select 1 from stock_ctdms_mismatches() where kind = 'blocked_in_ctdms_only') then
    raise exception 'car 4 is allotted with us now: no mismatch expected';
  end if;
  if not exists (select 1 from stock_ctdms_mismatches() where kind = 'invoiced_in_ctdms' and vin = pg_temp.vin(6)) then
    raise exception 'car invoiced in CTDMS should be listed';
  end if;

  -- A two-tone car for a single-tone booking needs a reason; an invoiced-in-CTDMS car can't be allotted.
  begin
    perform allot_vehicle('00000000-0000-0000-00bb-000000000004', (select id from vehicles where vin = pg_temp.vin(5)), 'manual');
    raise exception 'mismatched allotment without reason: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This car does not match%' then raise; end if;
  end;
  begin
    perform allot_vehicle('00000000-0000-0000-00bb-000000000004', (select id from vehicles where vin = pg_temp.vin(6)), 'manual', 'x');
    raise exception 'invoiced car: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This car is not available%' then raise; end if;
  end;

  -- Swap car 2 from b2 to b4: b2 goes back to the queue; its block was never done, so it is cancelled.
  perform swap_vehicle_customer((select id from vehicles where vin = pg_temp.vin(2)), '00000000-0000-0000-00bb-000000000004',
                                'Customer 4 paid in full first');
  if (select status from bookings where id = '00000000-0000-0000-00bb-000000000002') <> 'booked'
     or (select b.customer_name from allotments a join bookings b on b.id = a.booking_id join vehicles v on v.id = a.vehicle_id
         where v.vin = pg_temp.vin(2) and a.released_at is null) <> 'Stock Buyer 4' then
    raise exception 'swap wrong';
  end if;
  if (select string_agg(t.action || ':' || t.status || ':' || right(t.booking_id::text, 1), ',' order by t.created_at, t.action desc)
      from ctdms_block_tasks t join vehicles v on v.id = t.vehicle_id where v.vin = pg_temp.vin(2)) <> 'block:cancelled:2,block:pending:4' then
    raise exception 'swap to-dos wrong: %', (select string_agg(t.action || ':' || t.status || ':' || right(t.booking_id::text, 1), ',')
      from ctdms_block_tasks t join vehicles v on v.id = t.vehicle_id where v.vin = pg_temp.vin(2));
  end if;

  -- Car 3 (transit) for b2.
  perform allot_vehicle('00000000-0000-0000-00bb-000000000002', (select id from vehicles where vin = pg_temp.vin(3)), 'manual');
end $$;

-- ---- The Jodhpur Outlet Head can't touch Jaipur bookings or cars
select pg_temp.as_user('7');
do $$
begin
  begin
    perform release_allotment((select id from allotments where booking_id = '00000000-0000-0000-00bb-000000000001' and released_at is null), 'x');
    raise exception 'Jodhpur OH release: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only an Outlet Head%' and sqlerrm not like 'Allotment not found%' then raise; end if;
  end;
end $$;

-- ---- Billing
select pg_temp.as_user('3');
do $$
begin
  begin
    perform send_for_billing('00000000-0000-0000-00bb-000000000001');
    raise exception 'billing without docket: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'The Welcome Docket must be complete%' then raise; end if;
  end;
  begin
    perform send_for_billing('00000000-0000-0000-00bb-000000000002');
    raise exception 'billing a transit car: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This car is still in transit%' then raise; end if;
  end;
end $$;

reset role;
insert into welcome_dockets (booking_id, status, completed_at) values ('00000000-0000-0000-00bb-000000000001', 'complete', now());
set local role authenticated;
select pg_temp.as_user('3');
do $$
begin
  insert into t_ids values ('br1', send_for_billing('00000000-0000-0000-00bb-000000000001'));
  if (select status from bookings where id = '00000000-0000-0000-00bb-000000000001') <> 'ready_to_invoice' then
    raise exception 'booking not ready to invoice';
  end if;
  begin
    perform release_allotment((select id from allotments where booking_id = '00000000-0000-0000-00bb-000000000001' and released_at is null), 'x');
    raise exception 'release after billing: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This car has been sent for billing%' then raise; end if;
  end;
  begin
    perform record_invoice((select id from t_ids where k = 'br1'), 'INV-1', current_date, 2311480);
    raise exception 'OH recording an invoice: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only Accounts%' then raise; end if;
  end;
end $$;

-- Jodhpur Accounts sees nothing of Jaipur's queue and can't invoice it.
select pg_temp.as_user('a');
do $$
begin
  if exists (select 1 from billing_requests) or exists (select 1 from bookings) then
    raise exception 'Jodhpur Accounts must not see Jaipur billing';
  end if;
  begin
    perform record_invoice((select id from t_ids where k = 'br1'), 'INV-1', current_date, 2311480);
    raise exception 'Jodhpur Accounts invoicing: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only Accounts%' then raise; end if;
  end;
end $$;

-- Jaipur Accounts sees the request and its booking, and records the invoice.
select pg_temp.as_user('9');
do $$
begin
  if (select count(*) from billing_requests) <> 1 or (select customer_name from bookings) <> 'Stock Buyer 1' then
    raise exception 'Jaipur Accounts should see exactly its billing queue';
  end if;
  begin
    perform record_invoice((select id from t_ids where k = 'br1'), 'INV-1', current_date + 1, 2311480);
    raise exception 'future invoice date: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'The invoice date cannot be in the future%' then raise; end if;
  end;
  perform record_invoice((select id from t_ids where k = 'br1'), 'INV-1', current_date, 2311480);
  if (select status from vehicles where vin = pg_temp.vin(1)) <> 'billed' then
    raise exception 'car not billed';
  end if;
  -- Accounts is never senior enough to approve anything.
  if current_employee_role_rank() <> 6 then
    raise exception 'Accounts rank should be 6';
  end if;
end $$;

-- ---- Next day's reports: car 3 arrives in the yard; car 2 is gone from the physical report
select pg_temp.as_user('3');
do $$
declare
  r jsonb;
begin
  r := import_stock_statement('00000000-0000-0000-0002-000000000001', 'physical', current_date, 'physical2.pdf', jsonb_build_array(
    pg_temp.row(1, 51), pg_temp.row(3, 3), pg_temp.row(4, 31), pg_temp.row(5, 41), pg_temp.row(6, 61), pg_temp.row(7, 6)));
  if (r->>'moved_to_physical')::int <> 1 or (r->>'missing_from_report')::int <> 1 then
    raise exception 'second import summary wrong: %', r;
  end if;
  if (select source from vehicles where vin = pg_temp.vin(3)) <> 'physical'
     or not (select missing_from_report from vehicles where vin = pg_temp.vin(2)) then
    raise exception 'transit -> physical / missing car not recorded';
  end if;
  if not exists (select 1 from stock_ctdms_mismatches() where kind = 'missing_from_report' and vin = pg_temp.vin(2)) then
    raise exception 'allotted car missing from the report should be listed';
  end if;

  -- Releasing car 3 after its block was done in CTDMS needs an unblock there.
  perform mark_block_task_done((select t.id from ctdms_block_tasks t join vehicles v on v.id = t.vehicle_id
                                where v.vin = pg_temp.vin(3) and t.status = 'pending'));
  perform release_allotment((select a.id from allotments a join vehicles v on v.id = a.vehicle_id
                             where v.vin = pg_temp.vin(3) and a.released_at is null), 'Customer changed colour');
  if not exists (select 1 from ctdms_block_tasks t join vehicles v on v.id = t.vehicle_id
                 where v.vin = pg_temp.vin(3) and t.action = 'unblock' and t.status = 'pending') then
    raise exception 'unblock to-do missing';
  end if;
  if (select status from vehicles where vin = pg_temp.vin(3)) <> 'available'
     or (select status from bookings where id = '00000000-0000-0000-00bb-000000000002') <> 'booked' then
    raise exception 'release wrong';
  end if;
end $$;

-- ---- A Sales Consultant sees their branch's stock but no CTDMS to-do or proposals
select pg_temp.as_user('5');
do $$
begin
  if (select count(*) from vehicles) <> 7 or exists (select 1 from ctdms_block_tasks) then
    raise exception 'SC stock visibility wrong';
  end if;
  begin
    perform propose_fifo_allotments();
    raise exception 'SC proposals: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only back office%' then raise; end if;
  end;
end $$;

reset role;
select 'stock_allotment tests passed' as result;
rollback;
