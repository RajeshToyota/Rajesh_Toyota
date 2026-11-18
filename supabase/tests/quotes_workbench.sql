-- Quotes workbench (Phase 25):
--   - quote_workbench tabs: drafts, approve, proceed, bookings
--   - a fleet quote for 3 cars: book one, expand to the other two (same group, payment split, priced each)
--   - billing lock: once invoiced, only the Admin can change the quote
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/quotes_workbench.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000001'), ('a0000000-0000-0000-0000-000000000004'),
  ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000006');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000001', '00000000-0000-0000-0003-000000000004',
             '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000006');

create temp table t_ids (k text primary key, id uuid);
grant all on t_ids to authenticated;

create or replace function pg_temp.as_user(n int) returns void language sql as $$
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

set local role authenticated;
select pg_temp.as_user(5);

with q as (
  insert into quotes (outlet_id, employee_id, customer_name, customer_mobile, variant_id, color_id, rto_category_id, insurance_option,
                      quantity, source, exchange_interest)
  select '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Fleet Buyer Ltd', '9829011111', v.id, c.id,
         '00000000-0000-0000-000b-000000000001', 'premium', 3, 'web', true
  from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ'
  returning id)
insert into t_ids select 'q', id from q;

do $$
begin
  if not exists (select 1 from quote_workbench('drafts') where quote_id = (select id from t_ids where k = 'q')) then
    raise exception 'a basic quote is a draft';
  end if;
  if not (can_edit_quote((select id from t_ids where k = 'q'))->>'editable')::boolean then raise exception 'editable at basic'; end if;
  perform finalize_quote((select id from t_ids where k = 'q'));
  if not exists (select 1 from quote_workbench('proceed') where quote_id = (select id from t_ids where k = 'q') and quantity = 3) then
    raise exception 'a final quote with no booking is in proceed';
  end if;
end $$;

-- Book the first car, then the rest of the fleet.
with b as (
  insert into bookings (quote_id, outlet_id, employee_id, variant_id, color_id, rto_category_id, payment_amount, pan_number, status)
  select q.id, q.outlet_id, q.employee_id, q.variant_id, q.color_id, q.rto_category_id, 300000, 'ABCDE1234F', 'booked'
  from quotes q where q.id = (select id from t_ids where k = 'q')
  returning id)
insert into t_ids select 'b1', id from b;

select pg_temp.as_user(6);  -- another consultant cannot expand it
select pg_temp.expect_error($$select expand_booking_to_fleet((select id from t_ids where k = 'b1'))$$, 'Booking not found');
select pg_temp.as_user(5);
do $$
declare
  n int;
begin
  n := expand_booking_to_fleet((select id from t_ids where k = 'b1'));
  if n <> 2 then raise exception 'should create 2 more bookings, got %', n; end if;
  if (select count(*) from bookings where booking_group_id = (select id from t_ids where k = 'b1')) <> 3 then raise exception 'group of 3'; end if;
  if exists (select 1 from bookings where booking_group_id = (select id from t_ids where k = 'b1') and payment_amount <> 100000) then
    raise exception 'payment split evenly';
  end if;
  if exists (select 1 from bookings where booking_group_id = (select id from t_ids where k = 'b1')
             and (total_amount is null or pan_number <> 'ABCDE1234F' or customer_name <> 'Fleet Buyer Ltd')) then
    raise exception 'each car priced and carries the customer';
  end if;
  if (select array_agg(fleet_unit_no order by fleet_unit_no) from bookings where booking_group_id = (select id from t_ids where k = 'b1')) <> array[1, 2, 3] then
    raise exception 'unit numbers 1..3';
  end if;
  if exists (select 1 from quote_workbench('proceed') where quote_id = (select id from t_ids where k = 'q')) then
    raise exception 'fully booked fleet leaves proceed';
  end if;
  if (select bookings from quote_workbench('bookings') where quote_id = (select id from t_ids where k = 'q')) <> 3 then
    raise exception 'bookings tab counts the fleet';
  end if;
end $$;
select pg_temp.expect_error($$select expand_booking_to_fleet((select id from t_ids where k = 'b1'))$$, 'All 3 bookings of this fleet already exist');

-- ---- Billing lock (the invoice is faked directly; billing has its own tests)
reset role;
set local session_replication_role = replica;
insert into billing_requests (booking_id, vehicle_id, allotment_id, outlet_id, status, invoice_no)
select id, gen_random_uuid(), gen_random_uuid(), outlet_id, 'invoiced', 'INV-1' from bookings where id = (select id from t_ids where k = 'b1');
set local session_replication_role = origin;
set local role authenticated;
select pg_temp.as_user(5);
select pg_temp.expect_error($$update quotes set customer_name = 'Changed' where id = (select id from t_ids where k = 'q')$$,
  'The car has been invoiced; only the Admin can change this quote');
do $$ begin
  if (can_edit_quote((select id from t_ids where k = 'q'))->>'editable')::boolean then raise exception 'billed quote not editable'; end if;
end $$;
update quotes set status = 'sent' where id = (select id from t_ids where k = 'q');  -- status is not locked
select pg_temp.as_user(1);
update quotes set customer_name = 'Fleet Buyer Pvt Ltd' where id = (select id from t_ids where k = 'q');

-- ---- The web builder's preview prices exactly as the saved quote
select pg_temp.as_user(5);
do $$
declare
  q quotes%rowtype;
begin
  select * into q from quotes where id = (select id from t_ids where k = 'q');
  if (preview_quote_price(jsonb_build_object('variant_id', q.variant_id, 'color_id', q.color_id, 'outlet_id', q.outlet_id,
        'rto_category_id', q.rto_category_id, 'insurance_option', q.insurance_option))->>'total_amount')::numeric <> q.total_amount then
    raise exception 'preview should match the quote';
  end if;
end $$;

select 'quotes_workbench: all checks passed';
rollback;
