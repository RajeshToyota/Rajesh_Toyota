-- Payroll (Phase 32):
--   - leave beyond the 4 paid days is deducted from base (salary types with base only)
--   - EMI schedule remainder on the last instalment; custom must add up
--   - per-car flat (a car from another dealer counts half), VIN flat replaces the model bonus,
--     model bonus reduced by a negative margin, above-target slab, min-cars gate
--   - category lock keeps amounts on recalculation; unlock needs approve; override needs a reason
--   - lock & finalise caps the advance at what was earned and carries the rest
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/payroll.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values ('a0000000-0000-0000-0000-000000000002'), ('a0000000-0000-0000-0000-000000000009');
update employees set auth_user_id = 'a0000000-0000-0000-0000-000000000002' where id = '00000000-0000-0000-0003-000000000002';
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-000000000009', 'a0000000-0000-0000-0000-000000000009', 'HR Person',
   '00000000-0000-0000-0001-000000000009', '00000000-0000-0000-0002-000000000001');

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
create or replace function pg_temp.e(f text) returns numeric language sql as $$
  select (to_jsonb(p) ->> f)::numeric from payroll_entries p
  where p.month = '2026-11-01' and p.employee_id = '00000000-0000-0000-0003-000000000005';
$$;

-- SC1 (both): ₹30,000 base. SC2 (fixed): ₹24,000 base only.
insert into employee_salary (employee_id, salary_type, monthly_salary, pay_components) values
  ('00000000-0000-0000-0003-000000000005', 'fixed_incentive', 30000, 'both'),
  ('00000000-0000-0000-0003-000000000006', 'fixed', 24000, 'base');
insert into payroll_attendance (employee_id, month, present_days, leave_days) values
  ('00000000-0000-0000-0003-000000000005', '2026-11-01', 24, 6),
  ('00000000-0000-0000-0003-000000000006', '2026-11-01', 28, 2);

-- Three cars invoiced in November by SC1; car 3 came from another dealer. Car 2 sold at a loss of ₹3,000.
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option)
select ('00000000-0000-0000-00bb-00000000032' || n)::uuid, '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005',
       'Pay Buyer ' || n, v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium'
from generate_series(1, 3) n, variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
set local session_replication_role = replica;   -- fixture: margins set directly
update bookings set priced_snapshot = coalesce(priced_snapshot, '{}') || jsonb_build_object('dealer_margin', case right(id::text, 1) when '2' then -3000 else 20000 end)
where id::text like '00000000-0000-0000-00bb-00000000032%';
set local session_replication_role = origin;
insert into vehicles (id, vin, outlet_id, source, status, variant_id, color_id)
select ('00000000-0000-0000-00cc-00000000032' || n)::uuid, 'MBJPXY0000000032' || n, '00000000-0000-0000-0002-000000000001', 'physical', 'billed', v.id, c.id
from generate_series(1, 3) n, variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
insert into allotments (id, booking_id, vehicle_id, method)
select ('00000000-0000-0000-00aa-00000000032' || n)::uuid, ('00000000-0000-0000-00bb-00000000032' || n)::uuid, ('00000000-0000-0000-00cc-00000000032' || n)::uuid, 'manual'
from generate_series(1, 3) n;
insert into billing_requests (booking_id, vehicle_id, allotment_id, outlet_id, status, invoice_no, invoice_date)
select ('00000000-0000-0000-00bb-00000000032' || n)::uuid, ('00000000-0000-0000-00cc-00000000032' || n)::uuid, ('00000000-0000-0000-00aa-00000000032' || n)::uuid,
       '00000000-0000-0000-0002-000000000001', 'invoiced', 'INV-P' || n, '2026-11-10'
from generate_series(1, 3) n;
insert into other_dealers (id, name) values ('0d000000-0000-0000-0000-000000000032', 'Other Dealer');
insert into stock_transfers (direction, vehicle_id, to_outlet_id, other_dealer_id, reason, status, inward_vin, inward_variant_id, inward_color_id)
select 'inward', '00000000-0000-0000-00cc-000000000323', '00000000-0000-0000-0002-000000000001', '0d000000-0000-0000-0000-000000000032', 'test', 'received',
       'MBJPXY00000000323', variant_id, color_id from vehicles where id = '00000000-0000-0000-00cc-000000000323';

-- Rules for Sales Consultants: ₹1,000 a car, model bonus, ₹500 above target; target 1 car.
insert into payroll_incentive_rules (role_id, rule_type, amount, valid_from) values
  ('00000000-0000-0000-0001-000000000006', 'per_car_flat', 1000, '2026-11-01'),
  ('00000000-0000-0000-0001-000000000006', 'model_bonus_margin', null, '2026-11-01'),
  ('00000000-0000-0000-0001-000000000006', 'above_target_slab', 500, '2026-11-01');
-- SC1's own VIN rule for car 1 (replaces its model bonus).
insert into payroll_incentive_rules (employee_id, rule_type, amount, vin, valid_from) values
  ('00000000-0000-0000-0003-000000000005', 'vin_flat', 7000, 'MBJPXY00000000321', '2026-11-01');
insert into dealer_model_bonus (month, model_id, bonus_per_car) select '2026-11-01', model_id, 5000 from variants where tkm_suffix_code = 'D22U4';
insert into employee_monthly_targets (month, employee_id, target_units) values ('2026-11-01', '00000000-0000-0000-0003-000000000005', 1);

set local role authenticated;
select pg_temp.as_user('2');

-- Advances: EMI remainder; custom must add up.
do $$ begin
  if payroll_advance_schedule(10000, 'emi', 3, null) <> array[3333, 3333, 3334]::numeric[] then raise exception 'EMI remainder on the last'; end if;
  begin
    perform payroll_advance_schedule(10000, 'custom', null, array[4000, 4000]::numeric[]);
    raise exception 'custom total: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'The instalments add up to 8000%' then raise; end if;
  end;
end $$;
-- SC2 took ₹30,000 lump in November: more than the month's pay.
select create_advance('00000000-0000-0000-0003-000000000006', 30000, 'lump', '2026-11-01', null, null, 'Medical');

select calculate_payroll('2026-11-01');
do $$
declare
  sc2 payroll_entries%rowtype;
begin
  -- Leave: 6 − 4 = 2 days × 30,000 / 30.
  if pg_temp.e('leave_deduction') <> 2000 then raise exception 'leave deduction %', pg_temp.e('leave_deduction'); end if;
  -- Cars: 1 + 1 + 0.5 = 2.5 × 1,000.
  if pg_temp.e('car_payout') <> 2500 then raise exception 'car payout %', pg_temp.e('car_payout'); end if;
  -- Model: car 1 VIN 7,000; car 2 bonus 5,000 − 3,000 loss = 2,000; car 3 5,000.
  if pg_temp.e('model_bonus') <> 14000 then raise exception 'model bonus %', pg_temp.e('model_bonus'); end if;
  -- Above target: (3 − 1 VIN car − target 1) × 500.
  if pg_temp.e('above_target') <> 500 then raise exception 'above target %', pg_temp.e('above_target'); end if;
  select * into sc2 from payroll_entries where month = '2026-11-01' and employee_id = '00000000-0000-0000-0003-000000000006';
  if sc2.leave_deduction <> 0 or sc2.car_payout <> 0 or sc2.advance_deduction <> 30000 then raise exception 'SC2: %', to_jsonb(sc2); end if;
end $$;

-- Lock the car payout, change a rule, recalculate: the locked amount stays.
select set_payroll_lock('2026-11-01', '00000000-0000-0000-0003-000000000005', 'car_sales', true);
reset role;
update payroll_incentive_rules set amount = 2000 where rule_type = 'per_car_flat';
set local role authenticated;
select pg_temp.as_user('2');
select calculate_payroll('2026-11-01');
do $$ begin
  if pg_temp.e('car_payout') <> 2500 then raise exception 'locked car payout kept: %', pg_temp.e('car_payout'); end if;
end $$;
select pg_temp.expect_error($$select payroll_override('2026-11-01', '00000000-0000-0000-0003-000000000005', 'above_target', 900, ' ')$$, 'Give the reason');
select payroll_override('2026-11-01', '00000000-0000-0000-0003-000000000005', 'above_target', 900, 'Exceptional month');
select calculate_payroll('2026-11-01');
do $$ begin
  if pg_temp.e('above_target') <> 900 then raise exception 'override survives recalculation'; end if;
end $$;

-- Min-cars gate: with a minimum of 5 cars, no model bonus or above target.
reset role;
insert into payroll_incentive_rules (role_id, rule_type, amount, valid_from) values ('00000000-0000-0000-0001-000000000006', 'min_cars', 5, '2026-11-01');
update payroll_entries set car_sales_locked = false;
update payroll_entries set override_notes = null;
set local role authenticated;
select pg_temp.as_user('2');
select calculate_payroll('2026-11-01');
do $$ begin
  if pg_temp.e('model_bonus') <> 0 or pg_temp.e('above_target') <> 0 then raise exception 'min-cars gate'; end if;
end $$;

select pg_temp.as_user('9');   -- HR can calculate but not lock
select pg_temp.expect_error($$select lock_payroll('2026-11-01')$$, 'Locking needs Payroll: approve');
select pg_temp.as_user('2');
-- Lock & finalise: SC2 earned 24,000; the advance takes 24,000, 6,000 moves to December.
select lock_payroll('2026-11-01');
do $$ begin
  if (select advance_deduction from payroll_entries where month = '2026-11-01' and employee_id = '00000000-0000-0000-0003-000000000006') <> 24000 then
    raise exception 'advance capped at earnings';
  end if;
  if (select amount from payroll_advance_deductions where month = '2026-12-01') <> 6000 then raise exception 'shortfall carried'; end if;
  if (select status from payroll_advances) <> 'partial' then raise exception 'advance partly recovered'; end if;
  if (select net_payable from payroll_entries where month = '2026-11-01' and employee_id = '00000000-0000-0000-0003-000000000006') <> 0 then
    raise exception 'net after advance';
  end if;
end $$;
select pg_temp.expect_error($$select calculate_payroll('2026-11-01')$$, 'This month is locked');

select 'payroll: all checks passed';
rollback;
