-- Follow-ups, tasks, reception, test drives and the RM console (Phase 19).
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/rm_leads.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000004'),
  ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000006'),
  ('a0000000-0000-0000-0000-00000000000c'), ('a0000000-0000-0000-0000-00000000000d');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000004',
             '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000006');
-- SC2 reports to the Outlet Head directly here, so SC1's Team Leader does not see SC2's work.
update employees set reports_to_employee_id = '00000000-0000-0000-0003-000000000003' where id = '00000000-0000-0000-0003-000000000006';
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-00000000000c', 'a0000000-0000-0000-0000-00000000000c', 'Jaipur Reception',
   '00000000-0000-0000-0001-000000000010', '00000000-0000-0000-0002-000000000001'),
  ('00000000-0000-0000-0003-00000000000d', 'a0000000-0000-0000-0000-00000000000d', 'Jaipur RM',
   '00000000-0000-0000-0001-00000000000a', '00000000-0000-0000-0002-000000000001');

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

-- ===== Follow-ups =====
select pg_temp.as_user('5');
create temp table t_ids (k text primary key, id uuid) on commit drop;
insert into t_ids select 'enq1', create_enquiry(jsonb_build_object('mobile', '9810000001', 'name', 'Follow Me',
  'model_id', (select id from models where name = 'Fortuner'), 'mode', 'Walk-in', 'purpose_of_visit', 'new_purchase', 'temperature', 'HOT'));
do $$
declare
  v_enq uuid := (select id from t_ids where k = 'enq1');
begin
  if (select next_followup_at from enquiries where id = v_enq) not between now() + interval '23 hours' and now() + interval '25 hours' then
    raise exception 'HOT enquiry should be due tomorrow';
  end if;
  perform pg_temp.expect_error(format($f$select log_followup('%s', 'call', 'connected')$f$, v_enq), 'Set the next follow-up date');
  perform pg_temp.expect_error(format($f$select log_followup('%s', 'call', 'not_interested')$f$, v_enq), 'Say why');
  perform log_followup(v_enq, 'call', 'test_drive_planned', 'Wants a diesel drive', now() + interval '3 days', 'WRM');
  if (select temperature from enquiries where id = v_enq) <> 'WRM' or (select count(*) from enquiry_followups) <> 1 then
    raise exception 'follow-up should update the enquiry';
  end if;
  if not exists (select 1 from my_followups('upcoming') where enquiry_id = v_enq) then raise exception 'SC should see it'; end if;
  if exists (select 1 from my_followups('overdue')) then raise exception 'nothing overdue yet'; end if;
end $$;
select pg_temp.as_user('6');
do $$ begin
  if exists (select 1 from my_followups('all')) then raise exception 'SC2 should not see SC1 enquiries'; end if;
end $$;
select pg_temp.as_user('4');
do $$ begin
  if not exists (select 1 from my_followups('all')) then raise exception 'TL should see the team'; end if;
  if (select logged from followup_compliance(current_date, current_date) where employee = 'Jaipur Sales Consultant 1') <> 1 then
    raise exception 'compliance should count the follow-up';
  end if;
end $$;

-- ===== Tasks =====
select pg_temp.as_user('5');
select create_task('Send brochure', null, now() + interval '1 day', null, 'high', (select id from t_ids where k = 'enq1'));
select pg_temp.expect_error($$select create_task('Not yours', '00000000-0000-0000-0003-000000000006')$$, 'You can only give tasks');
select pg_temp.as_user('4');
select create_task('Call back finance', '00000000-0000-0000-0003-000000000005', now() - interval '1 hour');
select pg_temp.as_user('5');
do $$ begin
  if (select count(*) from my_tasks()) <> 2 or (select count(*) from my_tasks() where overdue) <> 1 then
    raise exception 'SC should have 2 tasks, 1 overdue';
  end if;
  perform complete_task((select id from my_tasks() where title = 'Send brochure'), 'done', 'Sent on WhatsApp');
  if (select count(*) from my_tasks()) <> 1 then raise exception 'done task should leave the open list'; end if;
end $$;

-- ===== Reception =====
select pg_temp.as_user('c');
do $$
declare
  r record;
begin
  select * into r from record_walkin(jsonb_build_object('customer_name', 'New Face', 'mobile', '9820000002',
    'assigned_employee_id', '00000000-0000-0000-0003-000000000006', 'visitors', 3));
  if r.open_enquiry_id is not null then raise exception 'new mobile has no enquiry'; end if;
  insert into t_ids values ('walk1', r.walkin_id);
  -- SC1's customer comes back: the walk-in goes to SC1 with the open enquiry.
  select * into r from record_walkin(jsonb_build_object('customer_name', 'Follow Me', 'mobile', '9810000001',
    'assigned_employee_id', '00000000-0000-0000-0003-000000000006'));
  if r.open_enquiry_id <> (select id from t_ids where k = 'enq1') or r.open_enquiry_owner <> 'Jaipur Sales Consultant 1' then
    raise exception 'returning customer should go back to SC1';
  end if;
  insert into t_ids values ('walk2', r.walkin_id);
  perform pg_temp.expect_error($f$select record_walkin('{"customer_name": "X", "mobile": "12"}')$f$, 'Enter a valid 10-digit');
  if (select count(*) from walkin_register()) <> 2 then raise exception 'register should list both'; end if;
end $$;

select pg_temp.as_user('5');
select pg_temp.expect_error(format($f$select attend_walkin('%s', '{}')$f$, (select id from t_ids where k = 'walk1')), 'This walk-in is with another consultant');
select attend_walkin((select id from t_ids where k = 'walk2'));
select pg_temp.as_user('6');
select attend_walkin((select id from t_ids where k = 'walk1'),
  jsonb_build_object('model_id', (select id from models where name = 'Innova Hycross'), 'temperature', 'HOT'));
select pg_temp.as_user('3');
do $$ begin
  if (select status from showroom_walkins where id = (select id from t_ids where k = 'walk1')) <> 'converted'
     or (select e.assigned_employee_id from enquiries e join showroom_walkins w on w.enquiry_id = e.id where w.id = (select id from t_ids where k = 'walk1'))
        <> '00000000-0000-0000-0003-000000000006' then
    raise exception 'walk-in should become SC2''s enquiry';
  end if;
  if (select walkins || '/' || converted || '/' || visitors from walkin_conversion(current_date, current_date)) <> '2/2/4' then
    raise exception 'conversion wrong: %', (select row_to_json(w) from walkin_conversion(current_date, current_date) w);
  end if;
end $$;

-- ===== Test drives =====
select pg_temp.as_user('3');
insert into t_ids select 'car', save_test_drive_vehicle(null, jsonb_build_object('reg_no', 'rj14 td 0001',
  'variant_id', (select id from variants where tkm_suffix_code = 'D22U4'), 'odometer_km', 1200));
select pg_temp.as_user('5');
insert into t_ids select 'td1', schedule_test_drive((select id from t_ids where k = 'car'), now() + interval '1 hour', (select id from t_ids where k = 'enq1'));
select pg_temp.as_user('6');
select pg_temp.expect_error(format($f$select schedule_test_drive('%s', now() + interval '75 minutes', null, 'Walk Up', '9840000004')$f$,
  (select id from t_ids where k = 'car')), 'The car is already booked at');
select schedule_test_drive((select id from t_ids where k = 'car'), now() + interval '2 hours', null, 'Walk Up', '9840000004');
select pg_temp.as_user('5');
select pg_temp.expect_error(format($f$select start_test_drive('%s', '', 1200)$f$, (select id from t_ids where k = 'td1')), 'Record the customer''s driving licence');
select start_test_drive((select id from t_ids where k = 'td1'), 'rj1420100001234', 1200);
select pg_temp.expect_error(format($f$select end_test_drive('%s', 1100)$f$, (select id from t_ids where k = 'td1')), 'The closing reading must be at least');
select end_test_drive((select id from t_ids where k = 'td1'), 1212, 5, 'Loved the ride');
do $$ begin
  if not (select test_drive_given from enquiries where id = (select id from t_ids where k = 'enq1')) then
    raise exception 'finishing a drive should mark the enquiry';
  end if;
  if (select odometer_km from test_drive_vehicles) <> 1212 then raise exception 'odometer should move'; end if;
end $$;

-- ===== RM console =====
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                      mode_of_purchase, data_consent, payment_instrument_type, payment_amount)
select '00000000-0000-0000-00bb-0000000000f1', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005',
       'RM Buyer', v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium', 'Cash', true, 'Cash', 50000
from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
select pg_temp.expect_error($$select * from rm_pipeline()$$, 'You do not have access to the RM console');
select pg_temp.as_user('d');
do $$ begin
  if exists (select 1 from bookings) then raise exception 'RM sees nothing before assignment'; end if;
end $$;
select pg_temp.expect_error($$select rm_assign_booking('00000000-0000-0000-00bb-0000000000f1', '00000000-0000-0000-0003-00000000000d')$$, 'Booking not found');
select pg_temp.as_user('3');
select pg_temp.expect_error($$select rm_assign_booking('00000000-0000-0000-00bb-0000000000f1', '00000000-0000-0000-0003-000000000005')$$,
  'Pick a Relationship Manager');
select rm_assign_booking('00000000-0000-0000-00bb-0000000000f1', '00000000-0000-0000-0003-00000000000d');
do $$ begin
  if (select count(*) from rm_pipeline(null, 'none')) <> 0 then raise exception 'no unassigned bookings left'; end if;
  if (select open_bookings from rm_candidates('00000000-0000-0000-0002-000000000001') where name = 'Jaipur RM') <> 1 then
    raise exception 'RM load should count the booking';
  end if;
end $$;
select pg_temp.as_user('d');
do $$
declare
  v_req uuid;
  d jsonb;
begin
  if (select bucket from rm_pipeline() where booking_id = '00000000-0000-0000-00bb-0000000000f1') <> 'docket' then
    raise exception 'new booking should wait on the docket';
  end if;
  if (select bookings from rm_pipeline_counts() where bucket = 'docket') <> 1 then raise exception 'counts wrong'; end if;
  if not exists (select 1 from bookings) then raise exception 'RM should see the assigned booking'; end if;
  perform add_booking_note('00000000-0000-0000-00bb-0000000000f1', 'Welcome call done', 'call');
  v_req := raise_customer_request('00000000-0000-0000-00bb-0000000000f1', 'delivery_date', 'Wants delivery before Diwali');
  perform pg_temp.expect_error(format($f$select update_customer_request('%s', 'done')$f$, v_req), 'Say what was done');
  perform update_customer_request(v_req, 'in_progress');
  perform create_task('Confirm delivery date with yard', null, now() + interval '1 day', null, 'normal', null,
                      '00000000-0000-0000-00bb-0000000000f1');
  d := rm_booking_detail('00000000-0000-0000-00bb-0000000000f1');
  if jsonb_array_length(d->'notes') <> 1 or jsonb_array_length(d->'requests') <> 1 or jsonb_array_length(d->'tasks') <> 1
     or d->'booking'->>'bucket' <> 'docket' then
    raise exception 'booking 360 wrong: %', d;
  end if;
  if (select open_requests from rm_pipeline() where booking_id = '00000000-0000-0000-00bb-0000000000f1') <> 1 then
    raise exception 'pipeline should count open requests';
  end if;
end $$;

select 'rm_leads: all checks passed';
rollback;
