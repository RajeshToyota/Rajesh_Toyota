-- Hold, cancellation and refunds:
--   - a hold releases the car and keeps the booking out of FIFO until it is resumed
--   - a cancellation needs the branch's Outlet Head
--   - approval releases everything and raises refunds: the customer's money by cheque within 7
--     working days, the loan money to the financier
--   - Accounts pays refunds
--   - nothing is held or cancelled once the car is invoiced
--   - every step is in the booking history
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/hold_cancel.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000005'),
  ('a0000000-0000-0000-0000-000000000007'), ('a0000000-0000-0000-0000-000000000009');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000007');
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-000000000009', 'a0000000-0000-0000-0000-000000000009', 'Jaipur Accounts',
   '00000000-0000-0000-0001-000000000007', '00000000-0000-0000-0002-000000000001');

create or replace function pg_temp.as_user(n text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;

-- Two bookings by SC1: h1 (cash Rs 50,000 at booking) and h2 (invoiced later). A matching yard car for h1.
set local role authenticated;
select pg_temp.as_user('5');
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                      mode_of_purchase, data_consent, payment_instrument_type, payment_amount)
select ('00000000-0000-0000-00bb-0000000000a' || n)::uuid, '00000000-0000-0000-0002-000000000001',
       '00000000-0000-0000-0003-000000000005', 'Hold Buyer ' || n, v.id, c.id, '00000000-0000-0000-000b-000000000001',
       'premium', 'In House Finance', true, 'Cash', 50000
from generate_series(1, 2) n, variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
reset role;
insert into vehicles (id, vin, outlet_id, source, variant_id, color_id)
select '00000000-0000-0000-00cc-0000000000a1', 'MBJUYMM1STE288888', '00000000-0000-0000-0002-000000000001', 'physical', v.id, c.id
from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
set local role authenticated;

-- ---- The Outlet Head allots the car to h1; the consultant puts h1 on hold, which frees the car
select pg_temp.as_user('3');
select allot_vehicle('00000000-0000-0000-00bb-0000000000a1', '00000000-0000-0000-00cc-0000000000a1', 'manual');
select pg_temp.as_user('5');
do $$
begin
  begin
    perform hold_booking('00000000-0000-0000-00bb-0000000000a1', '  ');
    raise exception 'hold without reason: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Give the reason%' then raise; end if;
  end;
  perform hold_booking('00000000-0000-0000-00bb-0000000000a1', 'Customer travelling abroad', current_date + 20);
  if (select status from vehicles where id = '00000000-0000-0000-00cc-0000000000a1') <> 'available'
     or (select status from bookings where id = '00000000-0000-0000-00bb-0000000000a1') <> 'booked' then
    raise exception 'hold should release the car';
  end if;
  begin
    perform hold_booking('00000000-0000-0000-00bb-0000000000a1', 'again');
    raise exception 'double hold: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This booking is already on hold%' then raise; end if;
  end;
end $$;

-- FIFO now offers the car to h2, not the held h1; after resuming, h1 (older) is offered first again.
select pg_temp.as_user('3');
do $$
begin
  if (select string_agg(right(booking_id::text, 2), ',') from propose_fifo_allotments()) <> 'a2' then
    raise exception 'held booking must be skipped: %', (select string_agg(right(booking_id::text, 2), ',') from propose_fifo_allotments());
  end if;
end $$;
select pg_temp.as_user('5');
select resume_booking('00000000-0000-0000-00bb-0000000000a1', 'Back in town');
select pg_temp.as_user('3');
do $$
begin
  if (select string_agg(right(booking_id::text, 2), ',') from propose_fifo_allotments()) <> 'a1' then
    raise exception 'resumed booking should be offered again';
  end if;
  if (select string_agg(kind || coalesce(':' || status_to, ''), ',' order by created_at)
      from booking_events where booking_id = '00000000-0000-0000-00bb-0000000000a1')
     <> 'status:allocated,status:booked,hold,resume' then
    raise exception 'history wrong: %', (select string_agg(kind || coalesce(':' || status_to, ''), ',' order by created_at)
      from booking_events where booking_id = '00000000-0000-0000-00bb-0000000000a1');
  end if;
  perform allot_vehicle('00000000-0000-0000-00bb-0000000000a1', '00000000-0000-0000-00cc-0000000000a1', 'fifo');
end $$;

-- ---- h1 also has Rs 4,00,000 disbursed by SBI; then the customer cancels
reset role;
insert into finance_cases (id, booking_id, outlet_id, financier_id, applicant_type, status, disbursed_amount, disbursed_date)
select '00000000-0000-0000-00fc-0000000000a1', '00000000-0000-0000-00bb-0000000000a1', '00000000-0000-0000-0002-000000000001',
       id, 'salaried', 'disbursed', 400000, current_date from financiers where short_name = 'SBI';
insert into payment_receipts (booking_id, outlet_id, mode, amount, clearance_status, cleared_on, finance_case_id)
values ('00000000-0000-0000-00bb-0000000000a1', '00000000-0000-0000-0002-000000000001', 'finance_disbursement', 400000,
        'cleared', current_date, '00000000-0000-0000-00fc-0000000000a1');
set local role authenticated;

select pg_temp.as_user('5');
do $$
declare
  v_id uuid;
begin
  begin
    perform request_cancellation('00000000-0000-0000-00bb-0000000000a1', 'bought_elsewhere', 'Got a better deal', 'elsewhere/letter.jpg');
    raise exception 'letter outside the booking: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'The written request must be stored%' then raise; end if;
  end;
  v_id := request_cancellation('00000000-0000-0000-00bb-0000000000a1', 'bought_elsewhere', 'Got a better deal',
                               '00000000-0000-0000-00bb-0000000000a1/cancellation/letter.jpg');
  begin
    perform decide_cancellation(v_id, true);
    raise exception 'SC approving: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only the branch''s Outlet Head%' then raise; end if;
  end;
end $$;

-- The Jodhpur Outlet Head can't decide a Jaipur cancellation; Jaipur's can.
select pg_temp.as_user('7');
do $$
begin
  begin
    perform decide_cancellation((select id from booking_cancellations limit 1), true);
    raise exception 'other branch OH: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only the branch''s Outlet Head%' and sqlerrm not like 'Cancellation request not found%' then raise; end if;
  end;
end $$;
select pg_temp.as_user('3');
do $$
declare
  v_due date;
begin
  perform decide_cancellation((select id from booking_cancellations where booking_id = '00000000-0000-0000-00bb-0000000000a1'), true,
                              'Approved after call with customer');
  if (select status from bookings where id = '00000000-0000-0000-00bb-0000000000a1') <> 'cancelled'
     or (select status from vehicles where id = '00000000-0000-0000-00cc-0000000000a1') <> 'available' then
    raise exception 'cancellation should release the car and cancel the booking';
  end if;
  v_due := add_working_days(current_date, 7);
  if (select string_agg(payee || ':' || amount::int || ':' || coalesce(payee_name, ''), ',' order by payee)
      from refunds where booking_id = '00000000-0000-0000-00bb-0000000000a1') <> 'customer:50000:Hold Buyer 1,financier:400000:State Bank of India'
     or exists (select 1 from refunds where due_date <> v_due) then
    raise exception 'refunds wrong: %', (select string_agg(payee || ':' || amount || ':' || due_date, ',') from refunds);
  end if;
  -- 7 working days skip Sundays: Monday 2 Nov 2026 + 7 = Tuesday 10 Nov.
  if add_working_days('2026-11-02', 7) <> '2026-11-10' then
    raise exception 'working days wrong';
  end if;
  begin
    perform hold_booking('00000000-0000-0000-00bb-0000000000a1', 'x');
    raise exception 'hold after cancel: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This booking is cancelled%' then raise; end if;
  end;
end $$;

-- ---- Accounts pays the customer's refund
select pg_temp.as_user('9');
do $$
begin
  begin
    perform mark_refund_paid((select id from refunds where payee = 'customer'), '', current_date);
    raise exception 'refund without cheque: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Enter the cheque number%' then raise; end if;
  end;
  perform mark_refund_paid((select id from refunds where payee = 'customer'), '778899', current_date, 'HDFC');
  if (select status from refunds where payee = 'customer') <> 'paid' then
    raise exception 'refund not paid';
  end if;
end $$;

-- ---- An invoiced car can't be held or cancelled
reset role;
insert into allotments (id, booking_id, vehicle_id, method) values
  ('00000000-0000-0000-00ca-0000000000a2', '00000000-0000-0000-00bb-0000000000a2', '00000000-0000-0000-00cc-0000000000a1', 'manual');
update bookings set status = 'ready_to_invoice' where id = '00000000-0000-0000-00bb-0000000000a2';
insert into billing_requests (booking_id, vehicle_id, allotment_id, outlet_id, status, invoice_no, invoice_date, invoice_amount)
values ('00000000-0000-0000-00bb-0000000000a2', '00000000-0000-0000-00cc-0000000000a1', '00000000-0000-0000-00ca-0000000000a2',
        '00000000-0000-0000-0002-000000000001', 'invoiced', 'INV-A2', current_date, 1984000);
set local role authenticated;
select pg_temp.as_user('5');
do $$
begin
  begin
    perform hold_booking('00000000-0000-0000-00bb-0000000000a2', 'x');
    raise exception 'hold after billing: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This car has been sent for billing%' then raise; end if;
  end;
  begin
    perform request_cancellation('00000000-0000-0000-00bb-0000000000a2', 'other', 'x');
    raise exception 'cancel after invoice: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This car has been invoiced%' then raise; end if;
  end;
end $$;

reset role;
select 'hold_cancel tests passed' as result;
rollback;
