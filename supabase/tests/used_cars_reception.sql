-- Used cars & reception (Phase 33):
--   - deal status: offer / asking ≥ 0, "communicated" needs an offer, offered → negotiating, no deal with a
--     reason, reopen (refused while the registration is open elsewhere)
--   - refurbishment set by the office, not the evaluator
--   - inspection: 18 items to finalise, accidental from a finding or red flag, override needs a reason
--   - stock documents (N/A only for Form 35 / NOC / challan), stock-out B2B/B2C, reverts need approve
--   - outside lead: stock-in only after the purchase is approved; lost closes the evaluation
--   - enable exchange on a booking
--   - kiosk tokens T001, T002 per branch per day, returning customer, financier needs finance, exchange
--     creates the evaluation request
--   - CTDMS queue: number entry (edit right), closure request and decision, follow-up, team report
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/used_cars_reception.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000005'),
  ('a0000000-0000-0000-0000-000000000006'), ('a0000000-0000-0000-0000-00000000000e'), ('a0000000-0000-0000-0000-00000000000c');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000006');
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-00000000000e', 'a0000000-0000-0000-0000-00000000000e', 'Jaipur Evaluator',
   '00000000-0000-0000-0001-00000000000f', '00000000-0000-0000-0002-000000000001'),
  ('00000000-0000-0000-0003-00000000000c', 'a0000000-0000-0000-0000-00000000000c', 'Jaipur Reception',
   '00000000-0000-0000-0001-000000000010', '00000000-0000-0000-0002-000000000001');
insert into financiers (id, name) values ('0f000000-0000-0000-0000-000000000033', 'Test Bank 33');

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
create temp table t_ids (k text primary key, id uuid) on commit drop;
grant all on t_ids to authenticated;
create or replace function pg_temp.id(p text) returns uuid language sql as $$ select id from t_ids where k = p $$;
create or replace function pg_temp.ev() returns used_car_evaluations language sql as $$
  select * from used_car_evaluations where id = (select id from t_ids where k = 'ev');
$$;
create or replace function pg_temp.photos(v uuid) returns jsonb language sql as $$
  select jsonb_agg('used-car/' || v || '/' || s || '.jpg') from unnest(array['front', 'back', 'left', 'right']) s;
$$;

insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option)
select '00000000-0000-0000-00bb-000000000331', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005',
       'Late Exchange', v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium'
from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';

set local role authenticated;

-- ===================== Used cars =====================
select pg_temp.as_user('5');
insert into t_ids select 'ev', request_evaluation('{"customer_name": "Walk Seller", "customer_mobile": "9830000001", "reg_no": "RJ14 CD 3301", "model": "Etios"}');
select pg_temp.as_user('e');
select record_evaluation(pg_temp.id('ev'), jsonb_build_object('evaluator_price', 500000, 'photo_paths', pg_temp.photos(pg_temp.id('ev'))));

-- Offers.
select pg_temp.as_user('5');
do $$ begin
  if (pg_temp.ev()).source <> 'walkin' or (pg_temp.ev()).deal_status <> 'pending' then raise exception 'source / deal: %', to_jsonb(pg_temp.ev()); end if;
end $$;
select pg_temp.expect_error(format($f$select set_used_car_offer('%s', null, null, true)$f$, pg_temp.id('ev')), 'Enter the offer before');
select pg_temp.expect_error(format($f$select set_used_car_offer('%s', -1)$f$, pg_temp.id('ev')), 'Prices cannot be negative');
select pg_temp.expect_error(format($f$select set_used_car_offer('%s', 600000)$f$, pg_temp.id('ev')), 'An offer more than 5%');
select set_used_car_offer(pg_temp.id('ev'), 480000);
do $$ begin
  if (pg_temp.ev()).deal_status <> 'pending' then raise exception 'not communicated yet: still pending'; end if;
end $$;
select set_used_car_offer(pg_temp.id('ev'), null, null, true);
do $$ begin
  if (pg_temp.ev()).deal_status <> 'offered' then raise exception 'offered'; end if;
end $$;
select set_used_car_offer(pg_temp.id('ev'), null, 540000);
do $$ begin
  if (pg_temp.ev()).deal_status <> 'negotiating' then raise exception 'asking above offer: negotiating'; end if;
end $$;

-- Refurbishment: the office, not the evaluator.
select pg_temp.as_user('e');
select pg_temp.expect_error(format($f$select set_used_car_refurbishment('%s', true, 10000, 'Paint')$f$, pg_temp.id('ev')), 'Refurbishment is set by the office');
select pg_temp.as_user('3');
select pg_temp.expect_error(format($f$select set_used_car_refurbishment('%s', true)$f$, pg_temp.id('ev')), 'Enter the estimate and the work');
select set_used_car_refurbishment(pg_temp.id('ev'), true, 25000, 'Bumper paint, new tyres');

-- Inspection: draft, then final with a suspected finding → accidental; override with a reason.
select pg_temp.as_user('e');
select save_used_car_inspection(pg_temp.id('ev'), '{"checklist": {"1": {"finding": "none"}}}');
select pg_temp.expect_error(format($f$select save_used_car_inspection('%s', '{"checklist": {"19": {"finding": "none"}}}')$f$, pg_temp.id('ev')), 'Checklist items are 1 to 18');
select pg_temp.expect_error(format($f$select save_used_car_inspection('%s', '{"red_flags": ["ghost"]}')$f$, pg_temp.id('ev')), 'Unknown red flag');
select pg_temp.expect_error(format($f$select save_used_car_inspection('%s', '{"checklist": {"1": {"finding": "none"}}}', true)$f$, pg_temp.id('ev')),
  'Answer all 18 checklist items');
do $$
declare
  v jsonb := (select jsonb_object_agg(n::text, jsonb_build_object('finding', case n when 3 then 'suspected' else 'none' end)) from generate_series(1, 18) n);
begin
  if not save_used_car_inspection(pg_temp.id('ev'), jsonb_build_object('checklist', v), true) then raise exception 'suspected finding = accidental'; end if;
  if not (pg_temp.ev()).is_accidental then raise exception 'evaluation flagged accidental'; end if;
  perform pg_temp.expect_error(format($f$select save_used_car_inspection('%s', '{}')$f$, pg_temp.id('ev')), 'The inspection is final');
end $$;
select pg_temp.as_user('3');
do $$
declare
  v jsonb := (select jsonb_object_agg(n::text, jsonb_build_object('finding', case n when 3 then 'suspected' else 'none' end)) from generate_series(1, 18) n);
begin
  perform pg_temp.expect_error(format($f$select save_used_car_inspection('%s', %L, true)$f$, pg_temp.id('ev'),
    jsonb_build_object('checklist', v, 'accidental_override', true)), 'Give the reason for overriding');
  if save_used_car_inspection(pg_temp.id('ev'), jsonb_build_object('checklist', v, 'accidental_override', true, 'override_reason', 'Only a bumper respray'), true) then
    raise exception 'override clears accidental';
  end if;
  if (pg_temp.ev()).is_accidental then raise exception 'evaluation not accidental after override'; end if;
end $$;

-- No deal and reopen.
select pg_temp.as_user('5');
select pg_temp.expect_error(format($f$select mark_used_car_no_deal('%s', 'other')$f$, pg_temp.id('ev')), 'Describe the reason');
select mark_used_car_no_deal(pg_temp.id('ev'), 'price_gap');
do $$ begin
  if (pg_temp.ev()).status <> 'rejected' or (pg_temp.ev()).deal_status <> 'no_deal' then raise exception 'no deal'; end if;
end $$;
insert into t_ids select 'ev2', request_evaluation('{"customer_name": "Walk Seller", "reg_no": "RJ14CD 3301", "model": "Etios"}');
select pg_temp.expect_error(format($f$select reopen_used_car_evaluation('%s', 'Customer called back')$f$, pg_temp.id('ev')), 'This registration has another open evaluation');
select close_evaluation(pg_temp.id('ev2'), 'cancelled', 'Duplicate');
select reopen_used_car_evaluation(pg_temp.id('ev'), 'Customer called back');
do $$ begin
  if (pg_temp.ev()).status <> 'evaluated' or (pg_temp.ev()).deal_status <> 'pending' then raise exception 'reopened: %', to_jsonb(pg_temp.ev()); end if;
end $$;
select accept_used_car_offer(pg_temp.id('ev'), 500000);
do $$ begin
  if (pg_temp.ev()).deal_status <> 'deal_done' then raise exception 'deal done'; end if;
end $$;

-- Stock-in, documents, stock-out and reverts.
select pg_temp.as_user('e');
insert into t_ids select 'car', procure_used_car(pg_temp.id('ev'));
select pg_temp.expect_error(format($f$select set_used_car_document('%s', 'pan', null, true)$f$, pg_temp.id('car')), 'Only Form 35, NOC and challan');
select pg_temp.expect_error(format($f$select set_used_car_document('%s', 'pan', 'elsewhere/pan.pdf')$f$, pg_temp.id('car')), 'Upload the document with this car');
select set_used_car_document(pg_temp.id('car'), 'noc', null, true);
select set_used_car_document(pg_temp.id('car'), 'pan', 'used-car-stock/' || pg_temp.id('car') || '/pan.pdf');
do $$ begin
  if (select count(*) filter (where done) || '/' || count(*) from used_car_document_status(pg_temp.id('car'))) <> '2/9' then raise exception 'document slots'; end if;
end $$;
select pg_temp.expect_error(format($f$select update_used_car('%s', '{"status": "sold", "sold_price": 560000, "buyer_name": "Dealer X"}')$f$, pg_temp.id('car')),
  'Say whether the sale is B2B or B2C');
select update_used_car(pg_temp.id('car'), '{"status": "sold", "sold_price": 560000, "buyer_name": "Dealer X", "sale_type": "B2B"}');
select pg_temp.expect_error(format($f$select revert_used_car_stock_out('%s', 'Buyer backed out')$f$, pg_temp.id('car')), 'Reverting a sale needs');
select pg_temp.as_user('3');
select revert_used_car_stock_out(pg_temp.id('car'), 'Buyer backed out');
select revert_used_car_stock_in(pg_temp.id('car'), 'Bought in by mistake');
do $$ begin
  if exists (select 1 from used_car_vehicles where id = pg_temp.id('car')) then raise exception 'stock-in reverted'; end if;
  if (pg_temp.ev()).status <> 'accepted' or (select count(*) from used_car_stock_events) <> 2 then raise exception 'back to deal done, 2 events'; end if;
end $$;

-- Outside car: stock-in only after the purchase is approved.
select pg_temp.as_user('5');
insert into t_ids select 'lead', create_outside_lead('{"lead_source": "broker", "seller_name": "Broker B", "seller_mobile": "9830000002",
  "reg_no": "rj45 ef 3302", "model": "Fortuner", "mfg_year": 2021, "expected_price": 2800000}');
insert into t_ids select 'oev', evaluation_id from used_car_outside_leads where id = pg_temp.id('lead');
select pg_temp.as_user('e');
select record_evaluation(pg_temp.id('oev'), jsonb_build_object('evaluator_price', 2700000, 'photo_paths', pg_temp.photos(pg_temp.id('oev'))));
do $$ begin
  if (select status from used_car_outside_leads where id = pg_temp.id('lead')) <> 'evaluated' then raise exception 'lead evaluated'; end if;
end $$;
select accept_used_car_offer(pg_temp.id('oev'), 2700000);
select pg_temp.expect_error(format($f$select procure_used_car('%s')$f$, pg_temp.id('oev')), 'The purchase of this outside car must be approved first');
select pg_temp.as_user('5');
select pg_temp.expect_error(format($f$select approve_outside_purchase('%s', 2650000)$f$, pg_temp.id('lead')), 'Approving a purchase needs');
select pg_temp.as_user('3');
select approve_outside_purchase(pg_temp.id('lead'), 2650000);
select pg_temp.as_user('e');
select procure_used_car(pg_temp.id('oev'));
do $$ begin
  if (select status from used_car_outside_leads where id = pg_temp.id('lead')) <> 'purchased' then raise exception 'lead purchased'; end if;
  if (select procurement_price from used_car_vehicles where evaluation_id = pg_temp.id('oev')) <> 2650000 then raise exception 'approved price bought'; end if;
end $$;
select pg_temp.as_user('5');
insert into t_ids select 'lead2', create_outside_lead('{"seller_name": "Online", "reg_no": "RJ45 EF 3303", "model": "Glanza"}');
select mark_outside_lead_lost(pg_temp.id('lead2'), 'sold_elsewhere');
do $$ begin
  if (select e.status from used_car_evaluations e join used_car_outside_leads l on l.evaluation_id = e.id where l.id = pg_temp.id('lead2')) <> 'rejected' then
    raise exception 'lost lead closes the evaluation';
  end if;
end $$;

-- Enable exchange on a booking that had none.
select enable_exchange('booking', '00000000-0000-0000-00bb-000000000331', '{"reg_no": "RJ14 GH 3304", "model": "Liva"}');
select pg_temp.expect_error($$select enable_exchange('booking', '00000000-0000-0000-00bb-000000000331', '{"reg_no": "RJ14 GH 3305", "model": "Liva"}')$$,
  'This booking already has an exchange evaluation');
do $$ begin
  if (select count(*) from exchange_business('booking') where id in (select id from used_car_evaluations where booking_id = '00000000-0000-0000-00bb-000000000331')) <> 1
     or exists (select 1 from exchange_business('enable') where kind = 'booking' and id = '00000000-0000-0000-00bb-000000000331') then
    raise exception 'exchange business tabs';
  end if;
end $$;

-- ===================== Reception =====================
select pg_temp.as_user('c');
do $$
declare
  r record;
begin
  select * into r from kiosk_create_walkin(jsonb_build_object('customer_name', 'Kiosk One', 'mobile', '98300 00010',
    'assigned_employee_id', '00000000-0000-0000-0003-000000000005', 'fuel_types', jsonb_build_array('Petrol', 'EV'), 'finance_required', true,
    'financier_id', '0f000000-0000-0000-0000-000000000033'));
  if r.token_no <> 'T001' or r.visit_no <> 1 then raise exception 'first token %', to_jsonb(r); end if;
  insert into t_ids values ('w1', r.walkin_id);
  perform pg_temp.expect_error($f$select kiosk_create_walkin('{"customer_name": "X", "mobile": "9830000011", "finance_required": false, "financier_id": "0f000000-0000-0000-0000-000000000033"}')$f$,
    'Pick a financier only when finance is needed');
  perform pg_temp.expect_error($f$select kiosk_create_walkin('{"customer_name": "X", "mobile": "9830000011", "fuel_types": ["Gas"]}')$f$, 'Fuel types must be');
  perform pg_temp.expect_error($f$select kiosk_create_walkin('{"customer_name": "X", "mobile": "9830000011", "has_exchange": true}')$f$,
    'Enter the exchange car''s registration number');
  select * into r from kiosk_create_walkin(jsonb_build_object('customer_name', 'Kiosk Two', 'mobile', '9830000012', 'has_exchange', true,
    'exchange_reg_no', 'rj14 kk 3306', 'exchange_model', 'Corolla'));
  if r.token_no <> 'T002' then raise exception 'second token %', r.token_no; end if;
  insert into t_ids values ('w2', r.walkin_id);
  select * into r from kiosk_create_walkin(jsonb_build_object('customer_name', 'Kiosk One', 'mobile', '9830000010'));
  if r.token_no <> 'T003' or r.visit_no <> 2 then raise exception 'returning visit %', to_jsonb(r); end if;
  insert into t_ids values ('w3', r.walkin_id);
  if (select visits from kiosk_detect_returning('9830000010')) <> 2 then raise exception 'returning detection'; end if;
end $$;
reset role;
do $$ begin
  if (select source || '/' || reg_no from used_car_evaluations where walkin_id = pg_temp.id('w2')) <> 'walkin/RJ14 KK 3306' then
    raise exception 'exchange at the kiosk creates the evaluation request';
  end if;
end $$;
set local role authenticated;

-- Consultants attend: two become enquiries, one leaves.
select pg_temp.as_user('5');
select attend_walkin(pg_temp.id('w1'), jsonb_build_object('model_id', (select id from models where name = 'Innova Hycross'), 'temperature', 'HOT'));
select attend_walkin(pg_temp.id('w2'), jsonb_build_object('model_id', (select id from models where name = 'Innova Hycross'), 'temperature', 'WRM'));
select close_walkin(pg_temp.id('w3'), 'Only browsing');

-- CTDMS queue.
select pg_temp.as_user('c');
do $$ begin
  if (select count(*) from walkin_ctdms_queue()) <> 2 then raise exception 'queue: 2 converted walk-ins'; end if;
  perform pg_temp.expect_error(format($f$select submit_ctdms_enquiry_no('%s', 'ENQ-3301')$f$, pg_temp.id('w1')), 'Entering CTDMS numbers needs');
end $$;
select pg_temp.as_user('3');
select pg_temp.expect_error(format($f$select submit_ctdms_enquiry_no('%s', 'x')$f$, pg_temp.id('w1')), 'Enter the CTDMS enquiry number');
select submit_ctdms_enquiry_no(pg_temp.id('w1'), 'enq-3301');
select pg_temp.as_user('5');
select pg_temp.expect_error(format($f$select request_walkin_ctdms_closure('%s', 'other')$f$, pg_temp.id('w2')), 'Pick the reason');
insert into t_ids select 'cl', request_walkin_ctdms_closure(pg_temp.id('w2'), 'not_interested');
select pg_temp.expect_error(format($f$select request_walkin_ctdms_closure('%s', 'duplicate')$f$, pg_temp.id('w2')), 'A closure is already requested');
select pg_temp.expect_error(format($f$select decide_walkin_ctdms_closure('%s', true)$f$, pg_temp.id('cl')), 'Deciding closures needs');
select pg_temp.as_user('3');
select pg_temp.expect_error(format($f$select decide_walkin_ctdms_closure('%s', false)$f$, pg_temp.id('cl')), 'Give the reason for rejecting');
select decide_walkin_ctdms_closure(pg_temp.id('cl'), true);
do $$ begin
  if exists (select 1 from walkin_ctdms_queue()) then raise exception 'queue empty after number + closure'; end if;
  if (select e.stage from enquiries e join showroom_walkins w on w.enquiry_id = e.id where w.id = pg_temp.id('w2')) <> 'lost' then
    raise exception 'approved closure closes the enquiry';
  end if;
  if (select ctdms_enquiry_no from walkin_register_v2() where id = pg_temp.id('w1')) <> 'ENQ-3301' then raise exception 'register shows the number'; end if;
end $$;

-- Follow-up for the walk-in that left.
select pg_temp.expect_error(format($f$select set_walkin_followup('%s', now() + interval '1 day')$f$, pg_temp.id('w1')), 'Follow-ups are for walk-ins that left');
select set_walkin_followup(pg_temp.id('w3'), now() - interval '1 hour', 'Call about the new Hycross');
do $$ begin
  if not (select overdue from walkin_followups() where walkin_id = pg_temp.id('w3')) then raise exception 'overdue follow-up'; end if;
end $$;
select set_walkin_followup(pg_temp.id('w3'), null, null, true);
do $$ begin
  if exists (select 1 from walkin_followups()) then raise exception 'done follow-up leaves the list'; end if;
  -- SC1's walk-ins: 2 converted, 1 with the number, 1 closed → compliance 100%.
  if (select sum(walkins) || '/' || sum(converted) || '/' || sum(ctdms_entered) || '/' || sum(closed) || '/' || max(ctdms_compliance_pct)
      from walkin_team_report(current_date, current_date) where consultant = 'Jaipur Sales Consultant 1') is distinct from '2/2/1/1/100.0' then
    raise exception 'team report: %', (select jsonb_agg(r) from walkin_team_report(current_date, current_date) r);
  end if;
end $$;

select 'used_cars_reception: all checks passed';
rollback;
