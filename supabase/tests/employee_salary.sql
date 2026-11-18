-- Salary type, monthly salary, ESI and PF at onboarding:
--   - only HR / Business Head save it; checks on type, amount, ESIC IP (10 digits) and UAN (12 digits)
--   - the employee sees their own, other staff do not; changes are kept in the history
--   - the "Salary, ESI and PF recorded" checklist item ticks itself
--   - a fixed-salary consultant earns no incentive in the monthly run
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/employee_salary.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000006'),
  ('a0000000-0000-0000-0000-000000000009'), ('a0000000-0000-0000-0000-00000000000a');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000006');
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-000000000009', 'a0000000-0000-0000-0000-000000000009', 'Jaipur Accounts',
   '00000000-0000-0000-0001-000000000007', '00000000-0000-0000-0002-000000000001'),
  ('00000000-0000-0000-0003-00000000000a', 'a0000000-0000-0000-0000-00000000000a', 'Group HR',
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

set local role authenticated;

-- ===== HR records salary at onboarding =====
select pg_temp.as_user('a');
select start_employee_checklist('00000000-0000-0000-0003-000000000005', 'onboarding');
select pg_temp.expect_error($$select save_employee_salary('00000000-0000-0000-0003-000000000005', '{"monthly_salary": "25000"}')$$,
  'Choose the salary type');
select pg_temp.expect_error($$select save_employee_salary('00000000-0000-0000-0003-000000000005', '{"salary_type": "fixed"}')$$,
  'Enter the monthly salary');
select pg_temp.expect_error($$select save_employee_salary('00000000-0000-0000-0003-000000000005',
  '{"salary_type": "fixed", "monthly_salary": "18000", "esi_applicable": "yes", "esi_number": "12345"}')$$, 'The ESIC IP number should be 10 digits');
select pg_temp.expect_error($$select save_employee_salary('00000000-0000-0000-0003-000000000005',
  '{"salary_type": "fixed", "monthly_salary": "18000", "pf_applicable": "yes", "uan_number": "1234"}')$$, 'The UAN should be 12 digits');
select save_employee_salary('00000000-0000-0000-0003-000000000005', '{"salary_type": "fixed", "monthly_salary": "₹18,000",
  "esi_applicable": "yes", "esi_number": "12 3456 7890", "pf_applicable": "yes", "uan_number": "1001 2345 6789", "pf_member_id": "rjjpr12345"}');
do $$ begin
  if (select monthly_salary || '/' || esi_number || '/' || uan_number || '/' || pf_member_id from employee_salary) <> '18000/1234567890/100123456789/RJJPR12345' then
    raise exception 'salary not cleaned: %', (select row_to_json(s) from employee_salary s);
  end if;
  if (select status from employee_tasks where employee_id = '00000000-0000-0000-0003-000000000005' and auto_key = 'salary') <> 'done' then
    raise exception 'checklist item should tick itself';
  end if;
end $$;
-- ESI off clears the number; a change of type is kept in the history
select save_employee_salary('00000000-0000-0000-0003-000000000005', '{"salary_type": "fixed_incentive", "monthly_salary": "18000",
  "esi_applicable": "no", "esi_number": "1234567890", "pf_applicable": "yes", "uan_number": "100123456789"}');
do $$ begin
  if (select esi_number from employee_salary) is not null then raise exception 'ESI number should clear when ESI is off'; end if;
  if (select count(*) from employee_salary_history) <> 2 then raise exception 'history should have 2 rows'; end if;
end $$;
select save_employee_salary('00000000-0000-0000-0003-000000000005', '{"salary_type": "fixed", "monthly_salary": "18000",
  "pf_applicable": "yes", "uan_number": "100123456789"}');

-- ===== Who sees it =====
select pg_temp.as_user('5');
select pg_temp.expect_error($$select save_employee_salary('00000000-0000-0000-0003-000000000005', '{"salary_type": "fixed", "monthly_salary": "99999"}')$$, '');
do $$ begin
  if (select count(*) from employee_salary) <> 1 then raise exception 'SC1 should see their own salary'; end if;
end $$;
select pg_temp.as_user('6');
do $$ begin
  if exists (select 1 from employee_salary) or exists (select 1 from employee_salary_history) then
    raise exception 'SC2 must not see SC1''s salary';
  end if;
end $$;

-- ===== Fixed salary: no incentive =====
reset role;
insert into bookings (id, outlet_id, employee_id, customer_name, imported_from_ctdms, mode_of_purchase, status)
values ('00000000-0000-0000-00bb-000000000091', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005',
        'Salary Test', true, 'Cash', 'ready_to_invoice');
insert into vehicles (id, vin, outlet_id, source, status) values
  ('00000000-0000-0000-00cc-000000000091', 'MBJSAL00000000091', '00000000-0000-0000-0002-000000000001', 'physical', 'billed');
insert into allotments (id, booking_id, vehicle_id, method) values
  ('00000000-0000-0000-00ca-000000000091', '00000000-0000-0000-00bb-000000000091', '00000000-0000-0000-00cc-000000000091', 'manual');
insert into billing_requests (booking_id, vehicle_id, allotment_id, outlet_id, status, invoice_no, invoice_date, invoice_amount)
values ('00000000-0000-0000-00bb-000000000091', '00000000-0000-0000-00cc-000000000091', '00000000-0000-0000-00ca-000000000091',
        '00000000-0000-0000-0002-000000000001', 'invoiced', 'INV-S', (now() at time zone 'Asia/Kolkata')::date, 1500000);
set local role authenticated;
select pg_temp.as_user('9');
select calculate_incentive_run(current_date);
reset role;
do $$ begin
  if (select eligible::text || '/' || ineligible_reason || '/' || release_now from incentive_lines
      where employee_id = '00000000-0000-0000-0003-000000000005') not like 'false/Fixed salary (no incentive)%/0' then
    raise exception 'fixed-salary CA should not be eligible: %', (select row_to_json(l) from incentive_lines l where employee_id = '00000000-0000-0000-0003-000000000005');
  end if;
end $$;

select 'employee_salary: all checks passed';
rollback;
