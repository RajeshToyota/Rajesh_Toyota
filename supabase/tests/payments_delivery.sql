-- Payments, insurance, RTO and delivery:
--   - receipts: who records them, clearing and bounces, the booking-form payment and the finance
--     disbursement as receipts, and the outstanding amount
--   - insurance and RTO, recorded by the back office
--   - the delivery checklist and the delivery gate, including the Business Head override
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/payments_delivery.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000002'), ('a0000000-0000-0000-0000-000000000003'),
  ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000006'),
  ('a0000000-0000-0000-0000-000000000009'), ('a0000000-0000-0000-0000-00000000000b');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000002', '00000000-0000-0000-0003-000000000003',
             '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000006');
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-000000000009', 'a0000000-0000-0000-0000-000000000009', 'Jaipur Accounts',
   '00000000-0000-0000-0001-000000000007', '00000000-0000-0000-0002-000000000001'),
  ('00000000-0000-0000-0003-00000000000b', 'a0000000-0000-0000-0000-00000000000b', 'Jaipur Finance',
   '00000000-0000-0000-0001-000000000008', '00000000-0000-0000-0002-000000000001');

create or replace function pg_temp.as_user(n text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;

-- A booking by SC1 with a Rs 50,000 cheque at booking, invoiced, with a docket ordering Rs 10,000 of accessories.
set local role authenticated;
select pg_temp.as_user('5');
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                      mode_of_purchase, data_consent, payment_instrument_type, payment_instrument_no, payment_amount, payment_date)
select '00000000-0000-0000-00bb-0000000000d1', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005',
       'Delivery Buyer', v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium', 'In House Finance', true,
       'Cheque', '000123', 50000, current_date
from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';

reset role;
-- (The docket trigger prices accessories from its order items; set the total directly here.)
insert into welcome_dockets (booking_id) values ('00000000-0000-0000-00bb-0000000000d1');
update welcome_dockets set accessories_total = 10000 where booking_id = '00000000-0000-0000-00bb-0000000000d1';
select set_config('rt.docket_rpc', 'on', true);
update welcome_dockets set status = 'complete', completed_at = now() where booking_id = '00000000-0000-0000-00bb-0000000000d1';
select set_config('rt.docket_rpc', 'off', true);
insert into vehicles (id, vin, outlet_id, source, status) values
  ('00000000-0000-0000-00cc-0000000000d1', 'MBJUYMM1STE299999', '00000000-0000-0000-0002-000000000001', 'physical', 'billed');
insert into allotments (id, booking_id, vehicle_id, method) values
  ('00000000-0000-0000-00ca-0000000000d1', '00000000-0000-0000-00bb-0000000000d1', '00000000-0000-0000-00cc-0000000000d1', 'manual');
set local role authenticated;

do $$
declare
  a record;
begin
  -- The booking cheque is a pending receipt: nothing counts as paid yet.
  if (select count(*) from payment_receipts where booking_id = '00000000-0000-0000-00bb-0000000000d1'
      and is_booking_amount and mode = 'cheque' and clearance_status = 'pending' and instrument_no = '000123') <> 1 then
    raise exception 'booking-amount receipt missing';
  end if;
  select * into a from booking_account('00000000-0000-0000-00bb-0000000000d1');
  if a.deal_amount <> 2311480 + 10000 or a.cleared <> 0 or a.pending <> 50000 or a.outstanding <> 2321480 then
    raise exception 'account wrong: %', row_to_json(a);
  end if;
  begin
    perform record_payment('00000000-0000-0000-00bb-0000000000d1', 'cash', 1000);
    raise exception 'SC recording a payment: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only Accounts%' then raise; end if;
  end;
  begin
    perform save_delivery_checklist('00000000-0000-0000-00bb-0000000000d1', '{"handover_photo_path": "elsewhere/x.jpg"}');
    raise exception 'photo outside the booking: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Delivery files must be stored%' then raise; end if;
  end;
end $$;

-- ---- Accounts clears the cheque and records a bounced one
select pg_temp.as_user('9');
do $$
declare
  v_cheque uuid;
begin
  perform set_payment_clearance((select id from payment_receipts where is_booking_amount and booking_id = '00000000-0000-0000-00bb-0000000000d1'), 'cleared');
  begin
    perform record_payment('00000000-0000-0000-00bb-0000000000d1', 'cheque', 100000);
    raise exception 'cheque without number: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Enter the cheque%' then raise; end if;
  end;
  v_cheque := record_payment('00000000-0000-0000-00bb-0000000000d1', 'cheque', 100000, current_date, '000456', 'SBI');
  perform set_payment_clearance(v_cheque, 'bounced');
  begin
    perform set_payment_clearance(v_cheque, 'cleared');
    raise exception 'clearing a bounced cheque: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This receipt is already bounced%' then raise; end if;
  end;
  perform record_payment('00000000-0000-0000-00bb-0000000000d1', 'upi', 171480, current_date, 'UTR123');
  if (select outstanding from booking_account('00000000-0000-0000-00bb-0000000000d1')) <> 2100000 then
    raise exception 'outstanding after receipts wrong: %', (select outstanding from booking_account('00000000-0000-0000-00bb-0000000000d1'));
  end if;
  if (select count(*) from bookings) <> 1 then
    raise exception 'Accounts should see its branch''s bookings';
  end if;
end $$;

-- ---- The finance disbursement (Rs 20,00,000) becomes a cleared receipt
select pg_temp.as_user('b');
do $$
declare
  v_case uuid;
begin
  v_case := open_finance_case('00000000-0000-0000-00bb-0000000000d1', (select id from financiers where short_name = 'SBI'), 'salaried');
  insert into finance_documents (case_id, doc_type, collected_on_paper)
  select v_case, t.id, true from finance_document_types t where 'salaried' = any(t.required_for);
  perform move_finance_case(v_case, 'logged_in');
  perform update_finance_case(v_case, '{"loan_amount": 2000000, "tenure_months": 60, "roi_percent": 9}');
  perform move_finance_case(v_case, 'sanctioned');
  perform update_finance_case(v_case, jsonb_build_object('do_number', 'DO-9', 'do_amount', 2000000, 'do_date', current_date));
  perform move_finance_case(v_case, 'do_received');
  perform update_finance_case(v_case, jsonb_build_object('disbursed_amount', 2000000, 'disbursed_date', current_date));
  perform move_finance_case(v_case, 'disbursed');
end $$;
select pg_temp.as_user('9');
do $$
begin
  if (select count(*) from payment_receipts where mode = 'finance_disbursement' and clearance_status = 'cleared' and amount = 2000000) <> 1
     or (select outstanding from booking_account('00000000-0000-0000-00bb-0000000000d1')) <> 100000 then
    raise exception 'disbursement receipt wrong: outstanding %', (select outstanding from booking_account('00000000-0000-0000-00bb-0000000000d1'));
  end if;
end $$;

-- ---- The consultant fills the checklist; the gate lists what is missing
select pg_temp.as_user('5');
do $$
declare
  v text[];
begin
  begin
    perform save_insurance_policy('00000000-0000-0000-00bb-0000000000d1', '{"policy_no": "P1", "insurer_name": "X"}');
    raise exception 'SC recording insurance: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only the branch''s back office%' then raise; end if;
  end;
  perform save_delivery_checklist('00000000-0000-0000-00bb-0000000000d1', jsonb_build_object(
    'pdi_done', true, 'accessories_fitted', true, 'fastag_fitted', true, 'documents_explained', true,
    'handover_photo_path', '00000000-0000-0000-00bb-0000000000d1/delivery/handover.jpg',
    'customer_signature_path', '00000000-0000-0000-00bb-0000000000d1/delivery/signature.png'));
  perform save_delivery_checklist('00000000-0000-0000-00bb-0000000000d1', '{"demo_done": true}');
  v := delivery_blockers('00000000-0000-0000-00bb-0000000000d1');
  if v <> array['The car has not been invoiced', 'Insurance policy number', 'Temporary or permanent registration number', 'Outstanding ₹1,00,000'] then
    raise exception 'blockers wrong: %', v;
  end if;
  begin
    perform complete_delivery('00000000-0000-0000-00bb-0000000000d1');
    raise exception 'delivery not ready: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Not ready for delivery: The car has not been invoiced%' then raise; end if;
  end;
end $$;

-- ---- Back office records insurance and the TR; the invoice is recorded
select pg_temp.as_user('3');
do $$
begin
  perform save_insurance_policy('00000000-0000-0000-00bb-0000000000d1', jsonb_build_object(
    'insurance_provider_id', (select id from insurance_providers limit 1), 'policy_no', 'POL-778', 'premium', 60402, 'idv', 1900000,
    'start_date', current_date, 'policy_storage_path', '00000000-0000-0000-00bb-0000000000d1/insurance/policy.pdf'));
  perform save_insurance_policy('00000000-0000-0000-00bb-0000000000d1', '{"coverage": "Comprehensive + zero dep"}');
  if (select policy_no || '|' || coverage from insurance_policies) <> 'POL-778|Comprehensive + zero dep' then
    raise exception 'insurance update should keep earlier fields';
  end if;
  perform save_rto_registration('00000000-0000-0000-00bb-0000000000d1', '{"temp_reg_no": "rj14 tc 1234", "temp_reg_date": "2026-10-20"}');
  perform save_rto_registration('00000000-0000-0000-00bb-0000000000d1', '{"hsrp_status": "applied"}');
  if (select temp_reg_no || '|' || hsrp_status from rto_registrations) <> 'RJ14 TC 1234|applied' then
    raise exception 'RTO update wrong';
  end if;
end $$;
reset role;
insert into billing_requests (booking_id, vehicle_id, allotment_id, outlet_id, status, invoice_no, invoice_date, invoice_amount)
values ('00000000-0000-0000-00bb-0000000000d1', '00000000-0000-0000-00cc-0000000000d1', '00000000-0000-0000-00ca-0000000000d1',
        '00000000-0000-0000-0002-000000000001', 'invoiced', 'INV-9', current_date, 1984000);
set local role authenticated;

-- ---- Only the outstanding Rs 1,00,000 is left: the SC can't deliver; an override needs a Business Head
select pg_temp.as_user('5');
do $$
begin
  begin
    perform complete_delivery('00000000-0000-0000-00bb-0000000000d1', 'Customer will pay tomorrow');
    raise exception 'SC override: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Not ready for delivery: Outstanding ₹1,00,000%' then raise; end if;
  end;
end $$;
select pg_temp.as_user('2');
do $$
declare
  d deliveries%rowtype;
begin
  perform complete_delivery('00000000-0000-0000-00bb-0000000000d1', 'Corporate customer, cheque with accounts');
  select * into d from deliveries where booking_id = '00000000-0000-0000-00bb-0000000000d1';
  if d.status <> 'delivered' or d.outstanding_at_delivery <> 100000 or d.override_by is null
     or (select status from bookings where id = '00000000-0000-0000-00bb-0000000000d1') <> 'delivered' then
    raise exception 'delivery not recorded: %', row_to_json(d);
  end if;
  begin
    perform save_delivery_checklist('00000000-0000-0000-00bb-0000000000d1', '{"pdi_done": false}');
    raise exception 'editing after delivery: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This car has been delivered%' then raise; end if;
  end;
end $$;

-- ---- SC2 sees none of it
select pg_temp.as_user('6');
do $$
begin
  if exists (select 1 from payment_receipts) or exists (select 1 from deliveries) or exists (select 1 from insurance_policies) then
    raise exception 'SC2 must not see SC1''s payments or delivery';
  end if;
end $$;

reset role;
select 'payments_delivery tests passed' as result;
rollback;
