-- Targets and incentives (Phase 20), with the dealership's SOP numbers:
--   - CA: slab rate per invoiced car, gates (digital check-in, 5 lead checks, assessment), 75% now / 25% at TKM settlement
--   - TL: 10% of the team's eligible CA incentive
--   - GM / SM: TKM's amount split 60 : 40, 75% now
--   - Pre-finance: 3 in-house files of 4 financeable sales = 75% penetration -> Rs 300 + 15 x Rs 30 = Rs 750 a file,
--     all held until the bank pays
--   - approval by someone else; held amounts released on settlement
--   - targets vs retail; bank payouts to the CA verified by Accounts and approved by the GM
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/targets_incentives.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000002'), ('a0000000-0000-0000-0000-000000000003'),
  ('a0000000-0000-0000-0000-000000000004'), ('a0000000-0000-0000-0000-000000000005'),
  ('a0000000-0000-0000-0000-000000000009'), ('a0000000-0000-0000-0000-00000000000b');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000002', '00000000-0000-0000-0003-000000000003',
             '00000000-0000-0000-0003-000000000004', '00000000-0000-0000-0003-000000000005');
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-000000000009', 'a0000000-0000-0000-0000-000000000009', 'Jaipur Accounts',
   '00000000-0000-0000-0001-000000000007', '00000000-0000-0000-0002-000000000001'),
  ('00000000-0000-0000-0003-00000000000b', 'a0000000-0000-0000-0000-00000000000b', 'Jaipur Finance',
   '00000000-0000-0000-0001-000000000008', '00000000-0000-0000-0002-000000000001');

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

-- Six cars invoiced this month at Jaipur: SC1 sold 5 (3 in-house loans at DO, 1 cash, 1 own finance), SC2 sold 1 (cash).
insert into bookings (id, outlet_id, employee_id, customer_name, imported_from_ctdms, mode_of_purchase, variant_id, status)
select ('00000000-0000-0000-00bb-0000000000' || lpad(n::text, 2, '0'))::uuid, '00000000-0000-0000-0002-000000000001',
       case when n <= 5 then '00000000-0000-0000-0003-000000000005'::uuid else '00000000-0000-0000-0003-000000000006'::uuid end,
       'Retail ' || n, true,
       case when n in (4, 6) then 'Cash' when n = 5 then 'Own Finance' else 'In House Finance' end,
       (select id from variants where tkm_suffix_code = 'D22U4'), 'ready_to_invoice'
from generate_series(1, 6) n;
insert into vehicles (id, vin, outlet_id, source, status)
select ('00000000-0000-0000-00cc-0000000000' || lpad(n::text, 2, '0'))::uuid, 'MBJUNC00000000' || lpad(n::text, 3, '0'), '00000000-0000-0000-0002-000000000001', 'physical', 'billed'
from generate_series(1, 6) n;
insert into allotments (id, booking_id, vehicle_id, method)
select ('00000000-0000-0000-00ca-0000000000' || lpad(n::text, 2, '0'))::uuid, ('00000000-0000-0000-00bb-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('00000000-0000-0000-00cc-0000000000' || lpad(n::text, 2, '0'))::uuid, 'manual'
from generate_series(1, 6) n;
insert into billing_requests (booking_id, vehicle_id, allotment_id, outlet_id, status, invoice_no, invoice_date, invoice_amount)
select ('00000000-0000-0000-00bb-0000000000' || lpad(n::text, 2, '0'))::uuid, ('00000000-0000-0000-00cc-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('00000000-0000-0000-00ca-0000000000' || lpad(n::text, 2, '0'))::uuid, '00000000-0000-0000-0002-000000000001', 'invoiced',
       'INV-' || n, (now() at time zone 'Asia/Kolkata')::date, 2000000
from generate_series(1, 6) n;
insert into finance_cases (id, booking_id, outlet_id, financier_id, finance_type, applicant_type, status)
select ('00000000-0000-0000-00fc-0000000000' || lpad(n::text, 2, '0'))::uuid, ('00000000-0000-0000-00bb-0000000000' || lpad(n::text, 2, '0'))::uuid,
       '00000000-0000-0000-0002-000000000001', (select id from financiers where short_name = 'SBI'),
       case when n = 5 then 'own' else 'in_house' end, 'salaried', 'do_received'
from generate_series(1, 5) n where n <> 4;

set local role authenticated;

-- ===== Targets =====
select pg_temp.as_user('5');
select pg_temp.expect_error($$select set_target(current_date, '00000000-0000-0000-0003-000000000005', null, 10)$$, 'You cannot set targets');
select pg_temp.as_user('3');
select set_target(current_date, '00000000-0000-0000-0003-000000000005', null, 10);
select set_target(current_date, '00000000-0000-0000-0003-000000000005', null, 8);
select set_target(current_date, '00000000-0000-0000-0003-000000000005', (select model_id from variants where tkm_suffix_code = 'D22U4'), 4);
do $$
declare
  r record;
begin
  select * into r from target_vs_actual(current_date) where employee = 'Jaipur Sales Consultant 1';
  if r.target_units <> 8 or r.retail <> 5 or r.in_house <> 3 or r.cash <> 1 or r.achievement_pct <> 62.5 then
    raise exception 'target vs actual wrong: %', row_to_json(r);
  end if;
  if (r.model_targets->0->>'retail')::int <> 5 then raise exception 'model target retail wrong: %', r.model_targets; end if;
end $$;

-- ===== Gates for SC1 only =====
select pg_temp.as_user('9');
select save_compliance(current_date, '00000000-0000-0000-0003-000000000005', true, 6, true);

-- ===== Run =====
select pg_temp.as_user('5');
select pg_temp.expect_error($$select calculate_incentive_run(current_date)$$, 'You cannot calculate incentives');
select pg_temp.as_user('9');
select calculate_incentive_run(current_date, jsonb_build_object('gm_sm_amounts', jsonb_build_object('00000000-0000-0000-0002-000000000001', 100000)));
do $$
declare
  v_run uuid := (select id from incentive_runs where status = 'draft');
  l record;
begin
  -- SC1: 5 cars reach the 5-car slab of Rs 1,500
  select * into l from incentive_run_lines(v_run) where employee = 'Jaipur Sales Consultant 1';
  if l.gross <> 7500 or not l.eligible or l.release_now <> 5625 or l.held <> 1875 or l.held_until <> 'tkm_settlement' then
    raise exception 'SC1 line wrong: %', row_to_json(l);
  end if;
  -- SC2: 1 car, no gates met
  select * into l from incentive_run_lines(v_run) where employee = 'Jaipur Sales Consultant 2';
  if l.gross <> 1000 or l.eligible or l.release_now <> 0 or l.ineligible_reason not like 'No digital check-in%' then
    raise exception 'SC2 line wrong: %', row_to_json(l);
  end if;
  -- TL: 10% of SC1's eligible 7,500
  select * into l from incentive_run_lines(v_run) where employee = 'Jaipur Team Leader';
  if l.gross <> 750 then raise exception 'TL line wrong: %', row_to_json(l); end if;
  -- GM 60,000 / SM 40,000
  if (select gross from incentive_run_lines(v_run) where employee = 'Business Head') <> 60000
     or (select gross from incentive_run_lines(v_run) where employee = 'Jaipur Outlet Head') <> 40000
     or (select release_now from incentive_run_lines(v_run) where employee = 'Jaipur Outlet Head') <> 30000 then
    raise exception 'GM/SM split wrong';
  end if;
  -- Pre-finance: 3 files x Rs 750, all held for the bank
  select * into l from incentive_run_lines(v_run) where employee = 'Jaipur Finance';
  if l.gross <> 2250 or l.release_now <> 0 or l.held <> 2250 or l.held_until <> 'bank_payment'
     or (l.basis->>'penetration_pct')::numeric <> 75 or (l.basis->>'per_file')::numeric <> 750 then
    raise exception 'pre-finance line wrong: %', row_to_json(l);
  end if;
end $$;
-- Recalculating a draft replaces its lines
select calculate_incentive_run(current_date, jsonb_build_object('gm_sm_amounts', jsonb_build_object('00000000-0000-0000-0002-000000000001', 100000)));
do $$ begin
  if (select count(*) from incentive_runs) <> 1 or (select count(*) from incentive_lines) <> 6 then
    raise exception 'recalculation should replace, not add: % lines', (select count(*) from incentive_lines);
  end if;
end $$;
select pg_temp.expect_error($$select approve_incentive_run((select id from incentive_runs))$$, 'Only the Business Head');

-- ===== Approve, then release what TKM settled =====
select pg_temp.as_user('2');
select approve_incentive_run((select id from incentive_runs), 'November payout');
select pg_temp.expect_error($$select calculate_incentive_run(current_date)$$, 'This month is approved');
select pg_temp.expect_error($$select release_held_incentives('tkm_settlement', current_date, '')$$, 'Note the settlement');
do $$ begin
  if release_held_incentives('tkm_settlement', current_date, 'TKM CN 4411') <> 4 then
    raise exception 'TKM settlement should release SC1, TL, GM and SM held parts';
  end if;
  if (select count(*) from held_incentives_summary()) <> 1 or (select held_until from held_incentives_summary()) <> 'bank_payment' then
    raise exception 'only the bank-held pre-finance amount should remain';
  end if;
end $$;

-- ===== The CA sees their own =====
select pg_temp.as_user('5');
do $$ begin
  if (select gross from my_incentive() where kind = 'ca_retail') <> 7500 then raise exception 'my incentive wrong'; end if;
  if exists (select 1 from incentive_lines where employee_id <> current_employee_id()) then
    raise exception 'SC should only see their own lines';
  end if;
end $$;

-- ===== Bank payout to the CA =====
select pg_temp.as_user('5');
do $$
declare
  v_id uuid;
begin
  if (select count(*) from bank_payout_candidates()) <> 3 then raise exception 'SC1 has 3 in-house cases to claim'; end if;
  perform pg_temp.expect_error($f$select submit_bank_payout('00000000-0000-0000-00fc-000000000005', 5000, 'X', current_date)$f$,
    'Bank payouts are only for in-house');
  v_id := submit_bank_payout('00000000-0000-0000-00fc-000000000001', 8000, 'CA-INV-1', current_date);
  perform pg_temp.expect_error($f$select submit_bank_payout('00000000-0000-0000-00fc-000000000001', 8000, 'CA-INV-2', current_date)$f$,
    'A payout invoice for this case is already in');
  perform pg_temp.expect_error(format($f$select move_bank_payout('%s', 'accounts_verified')$f$, v_id), 'Only Accounts can verify');
end $$;
select pg_temp.as_user('9');
select move_bank_payout((select id from bank_payouts), 'accounts_verified');
select pg_temp.expect_error($$select move_bank_payout((select id from bank_payouts), 'gm_approved')$$, 'Only the GM can approve');
select flag_outhouse_payout('00000000-0000-0000-00bb-000000000005', 6000, 'DSA paid the CA directly on an own-finance loan');
select pg_temp.as_user('2');
select move_bank_payout((select id from bank_payouts where kind = 'in_house'), 'gm_approved');
select pg_temp.as_user('9');
select move_bank_payout((select id from bank_payouts where kind = 'in_house'), 'paid');
do $$ begin
  if (select status from bank_payout_list() where kind = 'in_house') <> 'paid'
     or (select status from bank_payout_list() where kind = 'outhouse_flag') <> 'flagged' then
    raise exception 'payout statuses wrong';
  end if;
end $$;

select 'targets_incentives: all checks passed';
rollback;
