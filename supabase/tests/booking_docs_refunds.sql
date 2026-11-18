-- Booking docs, cancelled customers, refunds, excess refunds and hold (Phase 26):
--   - document groups: PAN + any 2 address proofs; company purchase adds GST; staff uploads with
--     Booking Docs: edit are approved at once, others wait; rejecting needs a reason; removal is audited
--   - cancellation keeps the finance case status; revive restores it, voids pending refunds, and is
--     refused once a refund is paid; done stamp
--   - refund bank details validated and hidden from the consultant; NEFT needs them; adjust / waive by the OH
--   - excess refund limited to what was overpaid
--   - hold remarks and the hold list with free cars
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/booking_docs_refunds.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000009');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005');
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-000000000009', 'a0000000-0000-0000-0000-000000000009', 'Jaipur Accounts',
   '00000000-0000-0000-0001-000000000007', '00000000-0000-0000-0002-000000000001');
insert into financiers (id, name) values ('f0000000-0000-0000-0000-000000000001', 'Test Bank');

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
create or replace function pg_temp.grp(b text, g text) returns record language sql as $$
  select (have, complete, missing)::record from required_doc_groups(b::uuid) where grp = g;
$$;

set local role authenticated;
select pg_temp.as_user('5');
insert into bookings (id, outlet_id, employee_id, customer_name, customer_mobile, variant_id, color_id, rto_category_id, insurance_option,
                      is_company_purchase, payment_amount)
select ('00000000-0000-0000-00bb-0000000000d' || n)::uuid, '00000000-0000-0000-0002-000000000001',
       '00000000-0000-0000-0003-000000000005', 'Docs Buyer ' || n, '9829012345', v.id, c.id, '00000000-0000-0000-000b-000000000001',
       'premium', n = 2, 50000
from generate_series(1, 2) n, variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';

-- ===== Document groups =====
do $$
declare
  b1 uuid := '00000000-0000-0000-00bb-0000000000d1';
  d uuid;
begin
  if exists (select 1 from required_doc_groups(b1) where grp = 'gst') then raise exception 'no GST for a private buyer'; end if;
  if not exists (select 1 from required_doc_groups('00000000-0000-0000-00bb-0000000000d2') where grp = 'gst') then
    raise exception 'company purchase needs GST';
  end if;
  -- The consultant (no Booking Docs: edit) uploads: pending, so not counted yet.
  d := add_booking_document(b1, 'pan', b1 || '/kyc/pan.jpg');
  if (select status from booking_documents where id = d) <> 'pending' then raise exception 'consultant upload waits for review'; end if;
  if (select complete from required_doc_groups(b1) where grp = 'pan') then raise exception 'pending PAN does not count'; end if;
  begin
    perform add_booking_document(b1, 'pan', gen_random_uuid() || '/kyc/pan.jpg');
    raise exception 'other folder: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'The file must be stored under this booking%' then raise; end if;
  end;
  begin
    perform review_booking_document(d, true);
    raise exception 'consultant review: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'You need Booking Docs: approve%' then raise; end if;
  end;
end $$;

select pg_temp.as_user('3');  -- Outlet Head: approve right, and their uploads count at once
do $$
declare
  b1 uuid := '00000000-0000-0000-00bb-0000000000d1';
  d uuid;
begin
  begin
    perform review_booking_document((select id from booking_documents where booking_id = b1 and doc_type = 'pan'), false);
    raise exception 'reject without reason: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Give the reason%' then raise; end if;
  end;
  perform review_booking_document((select id from booking_documents where booking_id = b1 and doc_type = 'pan'), true);
  if not (select complete from required_doc_groups(b1) where grp = 'pan') then raise exception 'approved PAN completes the group'; end if;
  perform add_booking_document(b1, 'driving_licence', b1 || '/kyc/dl.jpg');
  if (select complete from required_doc_groups(b1) where grp = 'address') then raise exception 'one address proof is not enough'; end if;
  d := add_booking_document(b1, 'passport', b1 || '/kyc/passport.jpg');
  if not (select complete from required_doc_groups(b1) where grp = 'address') then raise exception 'two address proofs complete it'; end if;
  if remove_booking_document(d, 'Wrong customer') <> b1 || '/kyc/passport.jpg' then raise exception 'removal returns the path'; end if;
  if (select complete from required_doc_groups(b1) where grp = 'address') then raise exception 'removed proof no longer counts'; end if;
  if (select reason from booking_document_removals where booking_id = b1) <> 'Wrong customer' then raise exception 'removal audited'; end if;
  if (select pending_review from booking_docs_board() where booking_id = b1) <> 0 then raise exception 'board pending count'; end if;
end $$;

-- ===== Cancel with a finance case and money, then revive =====
reset role;
insert into finance_cases (id, booking_id, outlet_id, financier_id, applicant_type, status)
values ('fc000000-0000-0000-0000-000000000001', '00000000-0000-0000-00bb-0000000000d1', '00000000-0000-0000-0002-000000000001',
        'f0000000-0000-0000-0000-000000000001', 'salaried', 'logged_in');
insert into payment_receipts (booking_id, outlet_id, mode, amount, clearance_status, cleared_on)
values ('00000000-0000-0000-00bb-0000000000d1', '00000000-0000-0000-0002-000000000001', 'upi', 50000, 'cleared', current_date);
set local role authenticated;
select pg_temp.as_user('5');
select request_cancellation('00000000-0000-0000-00bb-0000000000d1', 'changed_mind', 'Not now');
select pg_temp.as_user('3');
select decide_cancellation((select id from booking_cancellations where booking_id = '00000000-0000-0000-00bb-0000000000d1'), true);
do $$ begin
  if (select status from finance_cases where id = 'fc000000-0000-0000-0000-000000000001') <> 'rejected' then raise exception 'case rejected on cancel'; end if;
  if (select amount from refunds where booking_id = '00000000-0000-0000-00bb-0000000000d1' and payee = 'customer') <> 50000 then
    raise exception 'customer refund raised';
  end if;
end $$;

-- Bank details: validated; hidden from the consultant.
select pg_temp.expect_error($$select set_refund_bank_details((select id from refunds where booking_id = '00000000-0000-0000-00bb-0000000000d1'),
  'Docs Buyer 1', '12AB', 'HDFC0001234', 'HDFC', '00000000-0000-0000-00bb-0000000000d1/refund/cheque.jpg')$$, 'The account number must be 6 to 20 digits');
select pg_temp.expect_error($$select set_refund_bank_details((select id from refunds where booking_id = '00000000-0000-0000-00bb-0000000000d1'),
  'Docs Buyer 1', '123456789012', 'HDFC1234', 'HDFC', '00000000-0000-0000-00bb-0000000000d1/refund/cheque.jpg')$$, 'The IFSC must look like');
select set_refund_bank_details((select id from refunds where booking_id = '00000000-0000-0000-00bb-0000000000d1'),
  'Docs Buyer 1', '1234 5678 9012', 'hdfc0001234', 'HDFC', '00000000-0000-0000-00bb-0000000000d1/refund/cheque.jpg');
select pg_temp.as_user('5');
do $$ begin
  if exists (select 1 from refund_bank_details) then raise exception 'consultant must not see bank details'; end if;
end $$;

-- Revive: booked again, refund void, finance case back to logged in.
select pg_temp.expect_error($$select revive_booking('00000000-0000-0000-00bb-0000000000d1', 'Customer came back')$$, 'Only the branch''s Outlet Head');
select pg_temp.as_user('3');
select revive_booking('00000000-0000-0000-00bb-0000000000d1', 'Customer came back', 'hold');
do $$ begin
  if (select status from bookings where id = '00000000-0000-0000-00bb-0000000000d1') <> 'booked' then raise exception 'booked again'; end if;
  if not booking_on_hold('00000000-0000-0000-00bb-0000000000d1') then raise exception 'revived on hold'; end if;
  if (select status from refunds where booking_id = '00000000-0000-0000-00bb-0000000000d1') <> 'void' then raise exception 'refund void'; end if;
  if (select status from finance_cases where id = 'fc000000-0000-0000-0000-000000000001') <> 'logged_in' then raise exception 'finance case restored'; end if;
end $$;

-- Hold remark and list
select add_hold_remark('00000000-0000-0000-00bb-0000000000d1', 'Will confirm on Monday');
do $$ begin
  if (select last_remark from hold_list() where booking_id = '00000000-0000-0000-00bb-0000000000d1') <> 'Will confirm on Monday' then
    raise exception 'hold list shows the last remark';
  end if;
end $$;
select resume_booking('00000000-0000-0000-00bb-0000000000d1', 'ok');

-- Cancel again; Accounts pays by NEFT; then reviving is refused.
select pg_temp.as_user('5');
select request_cancellation('00000000-0000-0000-00bb-0000000000d1', 'changed_mind', 'Final');
select pg_temp.as_user('3');
select decide_cancellation((select id from booking_cancellations where booking_id = '00000000-0000-0000-00bb-0000000000d1' and status = 'pending'), true);
select adjust_refund((select id from refunds where booking_id = '00000000-0000-0000-00bb-0000000000d1' and status = 'pending'), 45000, 'Cancellation charge 5,000');
do $$ begin
  if (select original_amount from refunds where booking_id = '00000000-0000-0000-00bb-0000000000d1' and status = 'pending') <> 50000 then
    raise exception 'original amount kept';
  end if;
end $$;
select pg_temp.as_user('9');
select pg_temp.expect_error($$select pay_refund((select id from refunds where booking_id = '00000000-0000-0000-00bb-0000000000d1' and status = 'pending'),
  'neft', 'UTR123', current_date)$$, 'Record the customer''s bank details');
reset role;
insert into refund_bank_details (refund_id, account_holder, account_number, ifsc, cancelled_cheque_path)
select id, 'Docs Buyer 1', '123456789012', 'HDFC0001234', '00000000-0000-0000-00bb-0000000000d1/refund/c.jpg'
from refunds where booking_id = '00000000-0000-0000-00bb-0000000000d1' and status = 'pending';
set local role authenticated;
select pg_temp.as_user('9');
select pay_refund((select id from refunds where booking_id = '00000000-0000-0000-00bb-0000000000d1' and status = 'pending'), 'neft', 'UTR123', current_date);
select mark_cancellation_done((select id from booking_cancellations where booking_id = '00000000-0000-0000-00bb-0000000000d1' and status = 'approved' and revived_at is null));
select pg_temp.as_user('3');
select pg_temp.expect_error($$select revive_booking('00000000-0000-0000-00bb-0000000000d1', 'again')$$, 'A refund has been paid');

-- ===== Excess refund =====
reset role;
insert into payment_receipts (booking_id, outlet_id, mode, amount, clearance_status, cleared_on)
select id, outlet_id, 'bank_transfer', total_amount + 20000, 'cleared', current_date from bookings where id = '00000000-0000-0000-00bb-0000000000d2';
set local role authenticated;
select pg_temp.as_user('5');
select pg_temp.expect_error($$select request_excess_refund('00000000-0000-0000-00bb-0000000000d2', 25000, 'Paid twice', 'Docs Buyer 2',
  '123456789012', 'HDFC0001234', 'HDFC', '00000000-0000-0000-00bb-0000000000d2/refund/c.jpg')$$, 'Only ₹20000 has been received above');
select request_excess_refund('00000000-0000-0000-00bb-0000000000d2', 15000, 'Paid twice', 'Docs Buyer 2',
  '123456789012', 'HDFC0001234', 'HDFC', '00000000-0000-0000-00bb-0000000000d2/refund/c.jpg');
select pg_temp.expect_error($$select request_excess_refund('00000000-0000-0000-00bb-0000000000d2', 10000, 'Again', 'Docs Buyer 2',
  '123456789012', 'HDFC0001234', 'HDFC', '00000000-0000-0000-00bb-0000000000d2/refund/c.jpg')$$, 'Only ₹20000 has been received above the deal amount (₹15000 already');
select pg_temp.as_user('9');
select pay_excess_refund((select id from excess_refunds limit 1), 'imps', 'IMPS9', current_date);

select 'booking_docs_refunds: all checks passed';
rollback;
