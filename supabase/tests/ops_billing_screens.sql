-- Ops Billing screens (Phase 30):
--   - an approved insurance rework changes the deal and what is due; accessories rework likewise
--   - scheme stage needs a proof per scheme; scrap needs the COD number and the discount is capped
--   - receipts: due before/after, accounting entry blocks cancel, transfer logged, public verify
--   - reopening billing cancels the invoice and frees the car back to allotted; documents cleared
--   - revert delivered restores the car's location and the slot
--   - fitment, counter sale total check, RTO register reconciliation, CTDMS tracker
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/ops_billing_screens.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000009');
update employees set auth_user_id = 'a0000000-0000-0000-0000-000000000003' where id = '00000000-0000-0000-0003-000000000003';
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-000000000009', 'a0000000-0000-0000-0000-000000000009', 'Jaipur Accounts',
   '00000000-0000-0000-0001-000000000007', '00000000-0000-0000-0002-000000000001');

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
create temp table t_val (k text primary key, v numeric);
grant all on t_val to authenticated;
create or replace function pg_temp.bk(n int) returns uuid language sql as $$ select ('00000000-0000-0000-00bb-0000000000f' || n)::uuid $$;

-- Two bookings with an allotted car, invoiced; f1 has a scheme and a Rajesh Toyota scrap certificate.
insert into scrap_certificates (id, source, amount) values ('5c000000-0000-0000-0000-000000000001', 'Rajesh Toyota', 20000);
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option, scrap_certificate_id)
select pg_temp.bk(n), '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Ops2 Buyer ' || n, v.id, c.id,
       '00000000-0000-0000-000b-000000000001', 'premium', case when n = 1 then '5c000000-0000-0000-0000-000000000001'::uuid end
from generate_series(1, 2) n, variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
insert into vehicles (id, vin, outlet_id, source, status, variant_id, color_id, location)
select ('00000000-0000-0000-00cc-0000000000f' || n)::uuid, 'MBJUYMM1STE40000' || n, '00000000-0000-0000-0002-000000000001', 'physical', 'billed', v.id, c.id, 'Main yard'
from generate_series(1, 2) n, variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
insert into allotments (id, booking_id, vehicle_id, method)
select ('00000000-0000-0000-00aa-0000000000f' || n)::uuid, pg_temp.bk(n), ('00000000-0000-0000-00cc-0000000000f' || n)::uuid, 'manual' from generate_series(1, 2) n;
insert into billing_requests (booking_id, vehicle_id, allotment_id, outlet_id, status, invoice_no, invoice_date, invoice_amount, invoiced_at)
select pg_temp.bk(n), ('00000000-0000-0000-00cc-0000000000f' || n)::uuid, ('00000000-0000-0000-00aa-0000000000f' || n)::uuid,
       '00000000-0000-0000-0002-000000000001', 'invoiced', 'INV-F' || n, current_date, 2000000, now()
from generate_series(1, 2) n;
update bookings set status = 'ready_to_invoice' where id in (pg_temp.bk(1), pg_temp.bk(2));
-- A scheme line on f1 (set directly: the quote flow is tested elsewhere).
with s as (insert into schemes (model_id, name, valid_from, valid_to) select model_id, 'Ops Scheme', current_date - 1, current_date + 30
           from variants where tkm_suffix_code = 'D22U4' returning id),
     l as (insert into scheme_line_items (scheme_id, line_type, tkm_share, dealer_share) select id, 'Consumer', 10000, 0 from s returning id)
select id from l \gset line_
set local session_replication_role = replica;  -- fixture only: schemes normally come from the final quote
update bookings set selected_scheme_line_item_ids = array[:'line_id'::uuid] where id = pg_temp.bk(1);
set local session_replication_role = origin;

set local role authenticated;

-- ===== Insurance rework =====
select pg_temp.as_user('3');
do $$
declare
  before numeric := (select deal_amount from booking_account(pg_temp.bk(1)));
  ins numeric := (select (priced_snapshot->>'insurance_amount')::numeric from bookings where id = pg_temp.bk(1));
  r uuid;
begin
  r := request_rework(pg_temp.bk(1), 'insurance', 'self', 0, 'Customer has own policy');
  begin
    perform resolve_rework(r, true);
    raise exception 'OH approving: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only Accounts%' then raise; end if;
  end;
  insert into t_val values ('before', before), ('ins', ins);
end $$;
select pg_temp.as_user('9');
select resolve_rework((select id from ops_reworks where booking_id = pg_temp.bk(1)), true);
do $$ begin
  if (select deal_amount from booking_account(pg_temp.bk(1))) <> (select v from t_val where k = 'before') - (select v from t_val where k = 'ins') then
    raise exception 'self insurance takes the premium off the deal';
  end if;
end $$;

-- ===== Scheme proofs and scrap =====
select pg_temp.as_user('3');
select pg_temp.expect_error($$select ops_mark_stage(pg_temp.bk(1), 'scheme', 'done')$$, 'Upload the claim proof for every scheme first');
insert into scheme_claim_documents (booking_id, scheme_line_item_id, doc_kind, storage_path)
select pg_temp.bk(1), unnest(selected_scheme_line_item_ids), 'claim_proof', pg_temp.bk(1) || '/scheme/proof.pdf' from bookings where id = pg_temp.bk(1);
select ops_mark_stage(pg_temp.bk(1), 'scheme', 'done', null, 'CLM-1');
select pg_temp.expect_error($$select ops_mark_stage(pg_temp.bk(1), 'scrap', 'done')$$, 'Record the scrap COD number first');
select pg_temp.expect_error($$select save_scrap_details(pg_temp.bk(1), '{"cod_no": "COD-1", "certificate_discount": 999999}')$$,
  'The certificate discount cannot be more than the scrap amount quoted');
select save_scrap_details(pg_temp.bk(1), '{"cod_no": "COD-1", "certificate_discount": 5000, "scrap_price": 30000}');
select ops_mark_stage(pg_temp.bk(1), 'scrap', 'done');
do $$ begin
  if (select count(*) from booking_scrap_audit where booking_id = pg_temp.bk(1)) <> 1 then raise exception 'scrap audited'; end if;
end $$;

-- ===== Receipts =====
select pg_temp.as_user('9');
select record_payment(pg_temp.bk(2), 'upi', 100000, current_date, 'UPI-1');
do $$
declare
  r payment_receipts%rowtype;
begin
  select * into r from payment_receipts where booking_id = pg_temp.bk(2);
  if r.due_after <> r.due_before - 100000 then raise exception 'due before/after'; end if;
  if not exists (select 1 from payment_receipt_events where receipt_id = r.id and event = 'created') then raise exception 'creation event'; end if;
  perform set_receipt_accounting_entry(r.id, true);
  begin
    perform cancel_receipt(r.id, 'wrong');
    raise exception 'cancel an entered receipt: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This receipt is entered in the accounts%' then raise; end if;
  end;
  perform set_receipt_accounting_entry(r.id, false);
  perform transfer_receipt(r.id, pg_temp.bk(1), 'Paid against the wrong booking');
  if (select booking_id from payment_receipts where id = r.id) <> pg_temp.bk(1) then raise exception 'transferred'; end if;
  if (select status from verify_receipt(r.receipt_no)) not in ('valid', 'awaiting clearance') then raise exception 'verify'; end if;
  perform cancel_receipt(r.id, 'Duplicate entry');
  if (select status from verify_receipt(r.receipt_no)) <> 'cancelled' then raise exception 'verify shows cancelled'; end if;
  if (select string_agg(event, ',' order by id) from payment_receipt_events where receipt_id = r.id)
     <> 'created,accounting_entry_on,accounting_entry_off,transferred,cancelled' then raise exception 'events in order'; end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from verify_receipt('NO-SUCH')) <> 0 then raise exception 'unknown receipt'; end if;
end $$;
set local role authenticated;

-- ===== Reopen billing =====
reset role;
insert into booking_documents (booking_id, doc_type, storage_path, status) values (pg_temp.bk(2), 'invoice_pdf', pg_temp.bk(2) || '/docs/inv.pdf', 'approved');
set local role authenticated;
select pg_temp.as_user('9');
select request_stage_reversal_v2(pg_temp.bk(2), 'billing', 'Wrong customer name on the invoice', array['invoice_pdf']);
select pg_temp.as_user('3');
select decide_stage_reversal((select id from ops_stage_reversals where booking_id = pg_temp.bk(2) and stage = 'billing'), true);
reset role;
do $$ begin
  if exists (select 1 from billing_requests where booking_id = pg_temp.bk(2) and status = 'invoiced') then raise exception 'invoice cancelled'; end if;
  if (select status from vehicles where id = '00000000-0000-0000-00cc-0000000000f2') <> 'allotted' then raise exception 'car allotted again'; end if;
  if (select status from bookings where id = pg_temp.bk(2)) <> 'allocated' then raise exception 'booking back to allocated'; end if;
  if exists (select 1 from booking_documents where booking_id = pg_temp.bk(2) and doc_type = 'invoice_pdf') then raise exception 'document cleared'; end if;
end $$;

-- ===== Revert delivered =====
update bookings set status = 'delivered' where id = pg_temp.bk(1);   -- moves the car to the Delivered yard (Phase 27)
insert into deliveries (booking_id, status, delivered_at) values (pg_temp.bk(1), 'delivered', now());
set local role authenticated;
select pg_temp.as_user('3');
select revert_delivered(pg_temp.bk(1), 'Customer refused: scratch on bumper');
reset role;
do $$ begin
  if (select status from bookings where id = pg_temp.bk(1)) <> 'ready_to_invoice' then raise exception 'booking back before delivery'; end if;
  if (select location from vehicles where id = '00000000-0000-0000-00cc-0000000000f1') <> 'Main yard' then raise exception 'car back where it stood'; end if;
  if (select status from deliveries where booking_id = pg_temp.bk(1)) <> 'draft' then raise exception 'delivery reopened'; end if;
  if not exists (select 1 from delivery_reversals where booking_id = pg_temp.bk(1)) then raise exception 'reversal kept'; end if;
end $$;
set local role authenticated;
select pg_temp.as_user('3');

-- ===== Fitment, counter sale, RTO, tracker =====
select save_accessory_fitment(pg_temp.bk(1), '[{"item_key": "mats", "label": "Floor mats", "fitted": true}, {"item_key": "film", "label": "Sun film", "fitted": false}]');
do $$ begin
  if (select count(*) from accessory_fitments where booking_id = pg_temp.bk(1) and fitted) <> 1 then raise exception 'fitment'; end if;
end $$;
select pg_temp.expect_error($$insert into counter_accessory_sales (outlet_id, customer_name, items, total, payment_mode)
  values ('00000000-0000-0000-0002-000000000001', 'Walk-in', '[{"name": "Mats", "qty": 2, "price": 1500}]', 2000, 'cash')$$, 'new row violates row-level security');
insert into counter_accessory_sales (outlet_id, customer_name, items, total, payment_mode)
values ('00000000-0000-0000-0002-000000000001', 'Walk-in', '[{"name": "Mats", "qty": 2, "price": 1500}]', 3000, 'cash');
select save_rto_registration(pg_temp.bk(1), '{"perm_reg_no": "rj14 cd 4321"}');
do $$ begin
  if (select match_basis from rto_reconcile('[{"reg_no": "RJ-14-CD-4321", "owner_name": "Ops2 Buyer"}]')) <> 'registration'
     or not (select name_match from rto_reconcile('[{"reg_no": "RJ14CD4321", "owner_name": "OPS2 B"}]')) then
    raise exception 'RTO reconciliation';
  end if;
  if (select match_basis from rto_reconcile('[{"vin": "MBJUYMM1STE400002", "owner_name": "X"}]')) <> 'vin' then raise exception 'match by VIN'; end if;
  if not exists (select 1 from ctdms_order_tracker() where booking_id = pg_temp.bk(2)) then raise exception 'missing CTDMS order no.'; end if;
end $$;

select 'ops_billing_screens: all checks passed';
rollback;
