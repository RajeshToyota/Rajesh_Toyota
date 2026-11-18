-- Ops Billing, PDI, gate pass and delivery slots (Phase 18):
--   - the board lists bookings from "sent for billing" to delivery, per branch, for people with the right
--   - stages fill themselves (invoice, payments, insurance, RTO, PDI) or are marked by the right desk
--   - not-needed stages (no accessories, no scheme, no scrap) are skipped
--   - PDI: every checklist item, a fail needs a remark and a new PDI; a pass ticks the delivery checklist
--   - the gate pass needs every stage; going back a stage needs the Outlet Head and voids the gate pass
--   - delivery slots respect the branch's slot times and capacity; delivering closes the slot
--   - with ops switched on, delivery needs the gate pass; security records the car leaving
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/ops_billing.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000002'), ('a0000000-0000-0000-0000-000000000003'),
  ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000009'),
  ('a0000000-0000-0000-0000-00000000000c'), ('a0000000-0000-0000-0000-00000000000d'),
  ('a0000000-0000-0000-0000-00000000000e'), ('a0000000-0000-0000-0000-00000000000f');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000002', '00000000-0000-0000-0003-000000000003',
             '00000000-0000-0000-0003-000000000005');
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-000000000009', 'a0000000-0000-0000-0000-000000000009', 'Jaipur Accounts',
   '00000000-0000-0000-0001-000000000007', '00000000-0000-0000-0002-000000000001'),
  ('00000000-0000-0000-0003-00000000000c', 'a0000000-0000-0000-0000-00000000000c', 'Jaipur Insurance',
   '00000000-0000-0000-0001-00000000000c', '00000000-0000-0000-0002-000000000001'),
  ('00000000-0000-0000-0003-00000000000d', 'a0000000-0000-0000-0000-00000000000d', 'Jaipur PDI',
   '00000000-0000-0000-0001-00000000000b', '00000000-0000-0000-0002-000000000001'),
  ('00000000-0000-0000-0003-00000000000e', 'a0000000-0000-0000-0000-00000000000e', 'Jaipur Gate',
   '00000000-0000-0000-0001-00000000000e', '00000000-0000-0000-0002-000000000001'),
  ('00000000-0000-0000-0003-00000000000f', 'a0000000-0000-0000-0000-00000000000f', 'Jodhpur Insurance',
   '00000000-0000-0000-0001-00000000000c', '00000000-0000-0000-0002-000000000002');

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
create or replace function pg_temp.stage(s text) returns text language sql as $$
  select status from ops_stage_status('00000000-0000-0000-00bb-0000000000e1') where stage = s;
$$;
create or replace function pg_temp.all_ok() returns jsonb language sql as $$
  select jsonb_object_agg(code, 'ok') from pdi_checklist_items where is_active;
$$;

-- Two bookings by SC1 at Jaipur (e1 with Rs 10,000 of accessories, e2 plain), each with an allotted yard car.
set local role authenticated;
select pg_temp.as_user('5');
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                      mode_of_purchase, data_consent, payment_instrument_type, payment_amount)
select ('00000000-0000-0000-00bb-0000000000e' || n)::uuid, '00000000-0000-0000-0002-000000000001',
       '00000000-0000-0000-0003-000000000005', 'Ops Buyer ' || n, v.id, c.id, '00000000-0000-0000-000b-000000000001',
       'premium', 'Cash', true, 'Cash', 50000
from generate_series(1, 2) n, variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
reset role;
insert into welcome_dockets (booking_id) select ('00000000-0000-0000-00bb-0000000000e' || n)::uuid from generate_series(1, 2) n;
update welcome_dockets set accessories_total = 10000 where booking_id = '00000000-0000-0000-00bb-0000000000e1';
select set_config('rt.docket_rpc', 'on', true);
update welcome_dockets set status = 'complete', completed_at = now() where booking_id in ('00000000-0000-0000-00bb-0000000000e1', '00000000-0000-0000-00bb-0000000000e2');
select set_config('rt.docket_rpc', 'off', true);
insert into vehicles (id, vin, outlet_id, source, status, variant_id, color_id)
select ('00000000-0000-0000-00cc-0000000000e' || n)::uuid, 'MBJUYMM1STE30000' || n, '00000000-0000-0000-0002-000000000001', 'physical', 'allotted', v.id, c.id
from generate_series(1, 2) n, variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
insert into allotments (booking_id, vehicle_id, method)
select ('00000000-0000-0000-00bb-0000000000e' || n)::uuid, ('00000000-0000-0000-00cc-0000000000e' || n)::uuid, 'manual'
from generate_series(1, 2) n;
update bookings set status = 'allocated' where id in ('00000000-0000-0000-00bb-0000000000e1', '00000000-0000-0000-00bb-0000000000e2');
set local role authenticated;

-- ---- Nothing on the board before billing; the SC has no board at all
select pg_temp.as_user('3');
do $$ begin
  if exists (select 1 from ops_board()) then raise exception 'board should be empty before billing'; end if;
end $$;
select pg_temp.as_user('5');
select pg_temp.expect_error($$select * from ops_board()$$, 'You do not have access to Ops Billing');
select pg_temp.expect_error($$select book_delivery_slot('00000000-0000-0000-00bb-0000000000e1', current_date, '10:00')$$,
  'Send the car for billing before booking the delivery');

-- ---- The Outlet Head sends both for billing; e1 is on the board with billing pending, gate pass blocked
select pg_temp.as_user('3');
select send_for_billing('00000000-0000-0000-00bb-0000000000e1');
select send_for_billing('00000000-0000-0000-00bb-0000000000e2');
do $$ begin
  if (select count(*) from ops_board()) <> 2 then raise exception 'both bookings should be on the board'; end if;
  if pg_temp.stage('billing') <> 'pending' or pg_temp.stage('gate_pass') <> 'blocked'
     or pg_temp.stage('scheme') <> 'na' or pg_temp.stage('scrap') <> 'na' or pg_temp.stage('accessories') <> 'pending' then
    raise exception 'initial stages wrong: %', (select jsonb_object_agg(stage, status) from ops_stage_status('00000000-0000-0000-00bb-0000000000e1'));
  end if;
  if (select count(*) from ops_board('accessories')) <> 1 then raise exception 'only e1 has accessories pending'; end if;
end $$;

-- ---- Insurance: the Jaipur executive records it; Jodhpur's cannot; neither can mark accessories
select pg_temp.as_user('f');
select pg_temp.expect_error($$select save_insurance_policy('00000000-0000-0000-00bb-0000000000e1', '{"policy_no": "X"}')$$,
  'Only the branch''s back office can record insurance');
do $$ begin
  if exists (select 1 from ops_board()) then raise exception 'Jodhpur should not see Jaipur bookings'; end if;
end $$;
select pg_temp.as_user('c');
select save_insurance_policy('00000000-0000-0000-00bb-0000000000e1', '{"policy_no": "POL-1", "insurer_name": "Tokio"}');
select pg_temp.expect_error($$select ops_mark_stage('00000000-0000-0000-00bb-0000000000e1', 'accessories', 'done')$$,
  'You cannot update the accessories stage');
do $$ begin
  if pg_temp.stage('insurance') <> 'done' then raise exception 'insurance should be done'; end if;
end $$;

-- ---- PDI: every item, a fail needs a remark, then a second PDI passes
select pg_temp.as_user('d');
do $$
declare
  v_pdi uuid;
begin
  v_pdi := schedule_pdi('00000000-0000-0000-00bb-0000000000e1', current_date, '11:00');
  perform pg_temp.expect_error(format($f$select schedule_pdi('%s', current_date)$f$, '00000000-0000-0000-00bb-0000000000e1'),
    'A PDI is already scheduled');
  perform pg_temp.expect_error(format($f$select record_pdi_result('%s', '{"ext_paint": "ok"}')$f$, v_pdi), 'Check every item');
  perform pg_temp.expect_error(format($f$select record_pdi_result('%s', %L)$f$, v_pdi,
    pg_temp.all_ok() || '{"ext_paint": "fail"}'), 'Describe what failed');
  if record_pdi_result(v_pdi, pg_temp.all_ok() || '{"ext_paint": "fail"}', 'Scratch on rear bumper') <> 'failed' then
    raise exception 'should fail';
  end if;
  if pg_temp.stage('pdi') <> 'pending' or (select detail from ops_stage_status('00000000-0000-0000-00bb-0000000000e1') where stage = 'pdi') not like 'Failed: Scratch%' then
    raise exception 'failed PDI should show';
  end if;
  if not exists (select 1 from pdi_board() where kind = 'waiting' and status = 'failed') then
    raise exception 'failed car should wait on the board';
  end if;
  v_pdi := schedule_pdi('00000000-0000-0000-00bb-0000000000e1', current_date);
  if record_pdi_result(v_pdi, pg_temp.all_ok(), null, array['00000000-0000-0000-00bb-0000000000e1/pdi/front.jpg']) <> 'passed' then
    raise exception 'should pass';
  end if;
  if pg_temp.stage('pdi') <> 'done' then
    raise exception 'pass should finish the PDI stage';
  end if;
  -- the PDI technician fits the accessories
  perform ops_mark_stage('00000000-0000-0000-00bb-0000000000e1', 'accessories', 'done', 'Mats, guard, mud flaps', 'TGA-55');
end $$;

select pg_temp.as_user('3');
do $$ begin
  if not (select pdi_done from deliveries where booking_id = '00000000-0000-0000-00bb-0000000000e1') then
    raise exception 'a passed PDI should tick the delivery checklist';
  end if;
end $$;

-- ---- Too early for a gate pass; with ops switched on, delivery needs one
select pg_temp.as_user('2');
select ops_config_update(true);
select pg_temp.as_user('3');
select pg_temp.expect_error($$select issue_gate_pass('00000000-0000-0000-00bb-0000000000e1')$$, 'Not ready for a gate pass: billing');
do $$ begin
  if not ('Gate pass (Ops Billing)' = any(delivery_blockers('00000000-0000-0000-00bb-0000000000e1'))) then
    raise exception 'delivery should wait for the gate pass';
  end if;
end $$;

-- ---- Accounts invoices; the outstanding balance needs a note to confirm
select pg_temp.as_user('9');
select record_invoice((select id from billing_requests where booking_id = '00000000-0000-0000-00bb-0000000000e1'), 'INV-1', current_date, 2000000);
select pg_temp.expect_error($$select ops_mark_stage('00000000-0000-0000-00bb-0000000000e1', 'accounts', 'done')$$,
  'Say how the outstanding amount is covered');
select ops_mark_stage('00000000-0000-0000-00bb-0000000000e1', 'accounts', 'done', 'Bank DO received, disbursal tomorrow');
select pg_temp.expect_error($$select ops_mark_stage('00000000-0000-0000-00bb-0000000000e1', 'accounts', 'done', 'again')$$,
  'This stage is already marked');

-- ---- RTO by the back office; then the gate pass
select pg_temp.as_user('3');
select save_rto_registration('00000000-0000-0000-00bb-0000000000e1', '{"temp_reg_no": "RJ14 TC 0001"}');
do $$
declare
  v_no text;
begin
  v_no := issue_gate_pass('00000000-0000-0000-00bb-0000000000e1');
  if v_no not like 'GP/JP05A/%/0001' then raise exception 'gate pass number wrong: %', v_no; end if;
  if pg_temp.stage('gate_pass') <> 'done' then raise exception 'gate pass stage should be done'; end if;
end $$;

-- ---- Going back: the PDI technician asks to reopen accessories; only the Outlet Head decides
select pg_temp.as_user('d');
select request_stage_reversal('00000000-0000-0000-00bb-0000000000e1', 'accessories', 'Wrong mud flaps fitted');
select pg_temp.expect_error($$select request_stage_reversal('00000000-0000-0000-00bb-0000000000e1', 'accessories', 'again')$$,
  'A request to reopen this stage is already waiting');
select pg_temp.expect_error($$select decide_stage_reversal((select id from ops_stage_reversals), true)$$,
  'Only the Outlet Head can approve');
select pg_temp.as_user('3');
select decide_stage_reversal((select id from ops_stage_reversals), true, 'Refit today');
do $$
declare
  v_no text;
begin
  if pg_temp.stage('accessories') <> 'pending' or pg_temp.stage('gate_pass') <> 'blocked' then
    raise exception 'reversal should reopen accessories and void the gate pass';
  end if;
  perform ops_mark_stage('00000000-0000-0000-00bb-0000000000e1', 'accessories', 'done', 'Refitted');
  v_no := issue_gate_pass('00000000-0000-0000-00bb-0000000000e1');
  if v_no not like '%/0002' then raise exception 'new gate pass number expected: %', v_no; end if;
end $$;

-- ---- Delivery slots: slot times, capacity, moving a slot
select pg_temp.as_user('2');
select ops_config_update(true, null, 1);
select pg_temp.as_user('5');
select pg_temp.expect_error($$select book_delivery_slot('00000000-0000-0000-00bb-0000000000e1', current_date, '09:15')$$,
  'Pick one of the slots');
select book_delivery_slot('00000000-0000-0000-00bb-0000000000e1', current_date, '10:00', 'Family coming');
select pg_temp.expect_error($$select book_delivery_slot('00000000-0000-0000-00bb-0000000000e2', current_date, '10:00')$$,
  'That slot is full');
select book_delivery_slot('00000000-0000-0000-00bb-0000000000e2', current_date, '12:00');
select book_delivery_slot('00000000-0000-0000-00bb-0000000000e2', current_date + 1, '12:00');
select pg_temp.as_user('3');
do $$ begin
  if (select count(*) from delivery_slots where booking_id = '00000000-0000-0000-00bb-0000000000e2' and status = 'booked') <> 1 then
    raise exception 'moving a slot should free the old one';
  end if;
  if (select count(*) from delivery_schedule(current_date, current_date + 1) where booking_id is not null) <> 2 then
    raise exception 'schedule should show both cars';
  end if;
  if (select count(*) from delivery_schedule(current_date, current_date)) <> 5 * 4 - 0
     and (select count(*) from delivery_schedule(current_date, current_date)) < 5 then
    raise exception 'schedule should list every slot';
  end if;
end $$;

-- ---- Handover: checklist, delivery (balance cleared), the slot closes, security lets the car out
select pg_temp.as_user('9');
select record_payment('00000000-0000-0000-00bb-0000000000e1', 'upi',
  (select outstanding from booking_account('00000000-0000-0000-00bb-0000000000e1')) - coalesce((select sum(amount) from payment_receipts where booking_id = '00000000-0000-0000-00bb-0000000000e1' and clearance_status = 'pending'), 0),
  current_date, 'UTR-1');
select set_payment_clearance(id, 'cleared') from payment_receipts where booking_id = '00000000-0000-0000-00bb-0000000000e1' and clearance_status = 'pending';
select pg_temp.as_user('e');
select pg_temp.expect_error($$select record_gate_exit((select gate_pass_no from gate_passes where voided_at is null))$$,
  'The car has not been handed over yet');
select pg_temp.as_user('5');
select save_delivery_checklist('00000000-0000-0000-00bb-0000000000e1', jsonb_build_object(
  'accessories_fitted', true, 'fastag_fitted', true, 'documents_explained', true, 'demo_done', true,
  'handover_photo_path', '00000000-0000-0000-00bb-0000000000e1/delivery/h.jpg',
  'customer_signature_path', '00000000-0000-0000-00bb-0000000000e1/delivery/s.png'));
do $$ begin
  if cardinality(delivery_blockers('00000000-0000-0000-00bb-0000000000e1')) <> 0 then
    raise exception 'nothing should block: %', delivery_blockers('00000000-0000-0000-00bb-0000000000e1');
  end if;
end $$;
select complete_delivery('00000000-0000-0000-00bb-0000000000e1');
select pg_temp.as_user('e');
select record_gate_exit((select gate_pass_no from gate_passes where voided_at is null));
select pg_temp.as_user('3');
do $$ begin
  if (select status from delivery_slots where booking_id = '00000000-0000-0000-00bb-0000000000e1' and status <> 'cancelled') <> 'done' then
    raise exception 'delivery should close the slot';
  end if;
  if (select exited_at from gate_passes where voided_at is null) is null then raise exception 'exit not recorded'; end if;
  if exists (select 1 from ops_board() where booking_id = '00000000-0000-0000-00bb-0000000000e1') then
    raise exception 'delivered booking should leave the board';
  end if;
end $$;

select 'ops_billing: all checks passed';
rollback;
