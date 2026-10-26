-- Pipeline reports:
--   - each person's numbers are what RLS lets them see (a consultant only their own)
--   - period activity: enquiries, test drives, lost (by lost_at), bookings, allotments
--   - snapshot: each open booking in exactly one stage
--   - breakdowns: enquiry source conversion and lost reasons
--   - stock ageing bands with free vs allotted cars
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/pipeline_reports.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000006');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000006');

create or replace function pg_temp.as_user(n text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;

-- SC1: two enquiries (one with a test drive, later lost) and a booking; SC2: one booking.
set local role authenticated;
select pg_temp.as_user('5');
create temp table t_enq as
select create_enquiry(jsonb_build_object('mobile', '9829011001', 'name', 'Pipeline One', 'purpose_of_visit', 'new_purchase',
         'model_id', (select id from models order by name limit 1), 'mode', 'Walk-in', 'test_drive_given', true)) as id
union all
select create_enquiry(jsonb_build_object('mobile', '9829011002', 'name', 'Pipeline Two', 'purpose_of_visit', 'new_purchase',
         'model_id', (select id from models order by name limit 1), 'mode', 'Walk-in'));
grant select on t_enq to authenticated;
select mark_enquiry_lost((select id from t_enq order by id limit 1), 'Bought a competitor brand');

select pg_temp.as_user('5');
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                      mode_of_purchase, data_consent, payment_instrument_type, payment_amount)
select '00000000-0000-0000-00bb-0000000000f1', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005',
       'Pipeline Buyer 1', v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium', 'Cash', true, 'Cash', 25000
from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
select pg_temp.as_user('6');
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                      mode_of_purchase, data_consent, payment_instrument_type, payment_amount)
select '00000000-0000-0000-00bb-0000000000f2', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000006',
       'Pipeline Buyer 2', v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium', 'Cash', true, 'Cash', 25000
from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';

-- A car invoiced by TKM 100 days ago, allotted to SC1's booking
reset role;
insert into vehicles (id, vin, outlet_id, source, variant_id, color_id, tkm_invoice_date, interest_amount, tkm_invoice_amount)
select '00000000-0000-0000-00cc-0000000000f1', 'MBJUYMM1STE277777', '00000000-0000-0000-0002-000000000001', 'physical',
       v.id, c.id, current_date - 100, 12000, 1800000
from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
set local role authenticated;
select pg_temp.as_user('3');
select allot_vehicle('00000000-0000-0000-00bb-0000000000f1', '00000000-0000-0000-00cc-0000000000f1', 'manual');

-- ---- The consultant sees only their own numbers
select pg_temp.as_user('5');
do $$
declare
  r record;
begin
  select count(*) as people, sum(enquiries) enq, sum(test_drives) td, sum(lost) lost, sum(bookings) bk, sum(allotted) al
  into r from pipeline_activity(current_date - 1, current_date + 1);
  if (r.people, r.enq, r.td, r.lost, r.bk, r.al) is distinct from (1::bigint, 2::bigint, 1::bigint, 1::bigint, 1::bigint, 1::bigint) then
    raise exception 'SC1 activity wrong: %', r;
  end if;
  if (select sum(allotted) from pipeline_snapshot()) <> 1 or (select sum(awaiting_car) from pipeline_snapshot()) <> 0 then
    raise exception 'SC1 snapshot should show only the allotted booking';
  end if;
end $$;

-- ---- The Outlet Head sees the branch
select pg_temp.as_user('3');
do $$
declare
  r record;
begin
  select sum(bookings) bk, sum(allotted) al into r from pipeline_activity(current_date - 1, current_date + 1, '00000000-0000-0000-0002-000000000001');
  if (r.bk, r.al) is distinct from (2::bigint, 1::bigint) then raise exception 'branch activity wrong: %', r; end if;
  -- a period with nothing in it
  if exists (select 1 from pipeline_activity(current_date - 40, current_date - 30)) then raise exception 'empty period should be empty'; end if;
  -- another branch
  if exists (select 1 from pipeline_activity(current_date - 1, current_date + 1, '00000000-0000-0000-0002-000000000002')) then
    raise exception 'Jodhpur filter should be empty';
  end if;

  select sum(awaiting_car) aw, sum(allotted) al, sum(open_enquiries) oe into r from pipeline_snapshot();
  if (r.aw, r.al, r.oe) is distinct from (1::bigint, 1::bigint, 1::bigint) then raise exception 'branch snapshot wrong: %', r; end if;

  if (select (total, converted) from pipeline_breakdowns(current_date - 1, current_date + 1) where kind = 'source' and label = 'Walk-in')
     is distinct from (2, 0) then
    raise exception 'source conversion wrong';
  end if;
  if (select total from pipeline_breakdowns(current_date - 1, current_date + 1) where kind = 'lost_reason' and label = 'Bought a competitor brand') <> 1 then
    raise exception 'lost reason missing';
  end if;
  if (select sum(total) from pipeline_breakdowns(current_date - 1, current_date + 1) where kind = 'model') <> 2 then
    raise exception 'bookings by model should total 2';
  end if;

  select * into r from stock_ageing() where age_band = '90+';
  if (r.cars, r.free_cars, r.interest) is distinct from (1, 0, 12000::numeric) then raise exception 'stock ageing wrong: %', r; end if;
end $$;

-- lost_at follows the stage
reset role;
do $$ begin
  if (select count(*) from enquiries where stage = 'lost' and lost_at is null) > 0 then raise exception 'lost_at should be set'; end if;
  update enquiries set stage = 'open', lost_reason = null where stage = 'lost';
  if exists (select 1 from enquiries where lost_at is not null and stage <> 'lost') then raise exception 'reopening should clear lost_at'; end if;
end $$;

select 'pipeline_reports: all checks passed' as result;
rollback;
