-- Employee management:
--   - HR (and the Business Head) adds and edits staff; HR can never touch the top roles or its own role
--   - Outlet Heads see their branch's staff and checklists, but not PAN / Aadhaar / bank details
--   - the employee sees their own private details
--   - onboarding checklist from templates; "CRM login created" ticks itself when the login is linked
--   - a login is linked by confirmed email only
--   - assets are issued and returned; a serial number can't be with two people
--   - offboarding hands work over, moves direct reports up and closes the login
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/employee_management.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000002'), ('a0000000-0000-0000-0000-000000000003'),
  ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000009');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000002', '00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005');
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-000000000009', 'a0000000-0000-0000-0000-000000000009', 'Group HR',
   '00000000-0000-0000-0001-000000000009', '00000000-0000-0000-0002-000000000001');

create or replace function pg_temp.as_user(n text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;
create or replace function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like p_like then
      raise exception 'expected "%", got "%"', p_like, sqlerrm;
    end if;
    return;
  end;
  raise exception 'expected an error like "%": %', p_like, p_sql;
end;
$$;

-- A booking for SC1, to be handed over when SC1 leaves.
set local role authenticated;
select pg_temp.as_user('5');
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                      mode_of_purchase, data_consent, payment_instrument_type, payment_amount)
select '00000000-0000-0000-00bb-0000000000e1', '00000000-0000-0000-0002-000000000001',
       '00000000-0000-0000-0003-000000000005', 'Handover Buyer', v.id, c.id, '00000000-0000-0000-000b-000000000001',
       'premium', 'Cash', true, 'Cash', 25000
from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';

-- ---- HR adds a Sales Consultant; the onboarding checklist starts (CTDMS ID included for sales staff)
select pg_temp.as_user('9');
create temp table t_new as
select save_employee(null, jsonb_build_object(
  'name', 'New Consultant', 'phone', '+91 98290 11111', 'email', 'New.SC@RajeshToyota.com',
  'role_id', '00000000-0000-0000-0001-000000000006', 'outlet_id', '00000000-0000-0000-0002-000000000001',
  'reports_to_employee_id', '00000000-0000-0000-0003-000000000004', 'employee_code', 'RT-101',
  'designation', 'Sales Consultant', 'department', 'sales', 'joining_date', '2026-11-01')) as id;
grant select on t_new to authenticated;
do $$
declare
  v_id uuid := (select id from t_new);
begin
  if (select phone || '|' || email from employees where id = v_id) <> '9829011111|new.sc@rajeshtoyota.com' then
    raise exception 'phone and email should be normalised';
  end if;
  if (select count(*) from employee_tasks where employee_id = v_id and kind = 'onboarding') <> 9 then
    raise exception 'a sales consultant gets all 9 onboarding items, got %', (select count(*) from employee_tasks where employee_id = v_id);
  end if;
end $$;

-- HR cannot create or edit the top roles, or change itself
select pg_temp.expect_error($$select save_employee(null, '{"name":"X","role_id":"00000000-0000-0000-0001-000000000002"}')$$,
                            'Only the Business Head or Admin can give%');
select pg_temp.expect_error($$select save_employee('00000000-0000-0000-0003-000000000002',
  '{"name":"Business Head","email":"bh@rajeshtoyota.com","role_id":"00000000-0000-0000-0001-000000000002"}')$$, 'Only the Business Head or Admin can change%');
select pg_temp.expect_error($$select save_employee('00000000-0000-0000-0003-000000000009',
  '{"name":"Group HR","role_id":"00000000-0000-0000-0001-000000000003","outlet_id":"00000000-0000-0000-0002-000000000001"}')$$,
  'You cannot change your own%');
select pg_temp.expect_error($$select save_employee(null, '{"name":"Dup","role_id":"00000000-0000-0000-0001-000000000006","email":"new.sc@rajeshtoyota.com"}')$$,
                            'Another active employee already has%');
select pg_temp.expect_error($$select save_employee('00000000-0000-0000-0003-000000000004',
  format('{"name":"Jaipur Team Leader","role_id":"00000000-0000-0000-0001-000000000005","reports_to_employee_id":"%s"}', (select id from t_new))::jsonb)$$,
  'That manager reports%');
-- HR edits only through save_employee: a direct update changes nothing
do $$
declare
  n int;
begin
  update employees set auth_user_id = 'a0000000-0000-0000-0000-000000000005' where id = (select id from t_new);
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'HR should not update employees directly'; end if;
end $$;

-- Private details: format checks, then saved
select pg_temp.expect_error($$select save_employee_private((select id from t_new), '{"pan":"ABC123"}')$$, 'The PAN should look like%');
select pg_temp.expect_error($$select save_employee_private((select id from t_new), '{"aadhaar_last4":"1234 5678 9012"}')$$, 'Enter only the last 4%');
select save_employee_private((select id from t_new),
  '{"pan":"abcde1234f","aadhaar_last4":"9012","bank_account_no":"50100123456789","bank_ifsc":"hdfc0001234","bank_name":"HDFC"}');

-- HR sees no customer data
do $$ begin
  if (select count(*) from bookings) <> 0 then raise exception 'HR should not see bookings'; end if;
end $$;

-- ---- The Outlet Head sees the branch's staff and checklist, not the private details, and can't edit
select pg_temp.as_user('3');
do $$ begin
  if not exists (select 1 from employees where id = (select id from t_new)) then raise exception 'OH should see the new consultant'; end if;
  if (select count(*) from employee_tasks where employee_id = (select id from t_new)) <> 9 then raise exception 'OH should see the checklist'; end if;
  if exists (select 1 from employee_private) then raise exception 'OH must not see private details'; end if;
end $$;
select pg_temp.expect_error($$select save_employee((select id from t_new), '{"name":"X","role_id":"00000000-0000-0000-0001-000000000006"}')$$,
                            'Only HR or the Business Head%');
select pg_temp.expect_error($$select issue_asset((select id from t_new), 'sim_card')$$, 'Only HR or the Business Head%');

-- ---- Logins: an unconfirmed sign-up is not linked; the confirmed one is, and ticks the checklist
reset role;
insert into auth.users (id, email) values ('a0000000-0000-0000-0000-000000000008', 'new.sc@rajeshtoyota.com');
do $$ begin
  if (select auth_user_id from employees where id = (select id from t_new)) is not null then
    raise exception 'an unconfirmed email must not be linked';
  end if;
end $$;
update auth.users set email_confirmed_at = now() where id = 'a0000000-0000-0000-0000-000000000008';
do $$ begin
  if (select auth_user_id from employees where id = (select id from t_new)) is distinct from 'a0000000-0000-0000-0000-000000000008' then
    raise exception 'the confirmed login should be linked';
  end if;
  if (select status from employee_tasks where employee_id = (select id from t_new) and auto_key = 'crm_login') <> 'done' then
    raise exception '"CRM login created" should tick itself';
  end if;
end $$;
set local role authenticated;

-- The employee sees their own private details, SC1 sees none
select pg_temp.as_user('8');
do $$ begin
  if (select pan from employee_private) is distinct from 'ABCDE1234F' then raise exception 'the employee should see their own details'; end if;
end $$;
select pg_temp.as_user('5');
do $$ begin
  if exists (select 1 from employee_private) then raise exception 'SC1 must not see others'' details'; end if;
end $$;

-- ---- Assets: issue, refuse a duplicate serial, offboard SC1 with work and a laptop out
select pg_temp.as_user('9');
select issue_asset((select id from t_new), 'sim_card', 'Jio official SIM', '8991000012345');
select pg_temp.expect_error($$select issue_asset('00000000-0000-0000-0003-000000000006', 'sim_card', null, '8991000012345')$$,
                            'That sim card (8991000012345) is already with someone%');
create temp table t_laptop as select issue_asset('00000000-0000-0000-0003-000000000005', 'laptop', 'Dell Latitude', 'DL-77') as id;
grant select on t_laptop to authenticated;

do $$
declare
  h record;
begin
  select * into h from employee_handover('00000000-0000-0000-0003-000000000005');
  if h.open_bookings <> 1 or h.assets_out <> 1 then
    raise exception 'handover should show 1 booking and 1 asset, got % / %', h.open_bookings, h.assets_out;
  end if;
end $$;
select pg_temp.expect_error($$select offboard_employee('00000000-0000-0000-0003-000000000005', '2026-11-30', 'Resigned')$$,
                            '% choose who takes them over');
select pg_temp.expect_error($$select offboard_employee('00000000-0000-0000-0003-000000000009', '2026-11-30', 'x', null)$$,
                            'You cannot offboard yourself');
select pg_temp.expect_error($$select offboard_employee('00000000-0000-0000-0003-000000000002', '2026-11-30', 'x', null)$$,
                            'Only the Business Head or Admin can offboard%');

do $$
declare
  r jsonb;
begin
  r := offboard_employee('00000000-0000-0000-0003-000000000005', '2026-11-30', 'Resigned', '00000000-0000-0000-0003-000000000006');
  if (r->>'bookings')::int <> 1 then raise exception 'one booking should move: %', r; end if;
  if (select is_active from employees where id = '00000000-0000-0000-0003-000000000005') then raise exception 'SC1 should be inactive'; end if;
  if (select string_agg(auto_key || '=' || status, ',' order by sort_order) from employee_tasks
      where employee_id = '00000000-0000-0000-0003-000000000005' and auto_key is not null)
     <> 'handover=done,crm_login_off=done,assets_returned=pending' then
    raise exception 'offboarding auto items wrong';
  end if;
  if (select count(*) from employee_tasks where employee_id = '00000000-0000-0000-0003-000000000005' and kind = 'offboarding') <> 6 then
    raise exception 'offboarding checklist should have 6 items';
  end if;
end $$;
select pg_temp.expect_error($$select offboard_employee('00000000-0000-0000-0003-000000000005', '2026-11-30', 'Again', null)$$, '% has already left');

select return_asset((select id from t_laptop), '2026-11-30', 'Good');
do $$ begin
  if (select status from employee_tasks where employee_id = '00000000-0000-0000-0003-000000000005' and auto_key = 'assets_returned') <> 'done' then
    raise exception 'returning the last asset should tick the checklist';
  end if;
end $$;
select pg_temp.expect_error($$select return_asset((select id from t_laptop))$$, 'This asset was already returned%');

-- The booking now belongs to SC2; SC1's login sees nothing
reset role;
do $$ begin
  if (select employee_id from bookings where id = '00000000-0000-0000-00bb-0000000000e1') <> '00000000-0000-0000-0003-000000000006' then
    raise exception 'booking should be with SC2';
  end if;
end $$;
set local role authenticated;
select pg_temp.as_user('5');
do $$ begin
  if exists (select 1 from bookings) or exists (select 1 from employees) then raise exception 'a former employee must see nothing'; end if;
end $$;

-- ---- The Team Leader leaves: SC2 and the new consultant now report to the Outlet Head
select pg_temp.as_user('9');
select offboard_employee('00000000-0000-0000-0003-000000000004', '2026-12-31', 'Moved to another dealership');
reset role;
do $$ begin
  if (select count(*) from employees where reports_to_employee_id = '00000000-0000-0000-0003-000000000003' and role_id = '00000000-0000-0000-0001-000000000006' and is_active) <> 2 then
    raise exception 'the TL''s consultants should report to the Outlet Head';
  end if;
end $$;

-- ---- The Business Head can manage too, including another Business Head's role
set local role authenticated;
select pg_temp.as_user('2');
select save_employee('00000000-0000-0000-0003-000000000009', jsonb_build_object(
  'name', 'Group HR', 'role_id', '00000000-0000-0000-0001-000000000009', 'designation', 'HR Manager'));

reset role;
select 'employee_management: all checks passed' as result;
rollback;
