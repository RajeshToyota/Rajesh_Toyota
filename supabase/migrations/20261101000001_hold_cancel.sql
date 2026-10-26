-- Phase 13: hold, cancellation and refunds, and a booking history.
--   - booking_events logs every change of a booking's status, plus holds, resumes and the
--     cancellation request and its decision.
--   - A booking can be put on hold (reason, expected resume date). Any allotted car is released, and
--     FIFO skips the booking until it is resumed.
--   - A cancellation is requested with the reason (docket p.8 "Order Cancellation Details") and the
--     customer's written request. The branch's Outlet Head approves or rejects it.
--   - On approval the car is released and the booking cancelled, and refunds are raised as the
--     docket's terms say:
--       - the customer's money comes back by cheque, within 7 working days;
--       - loan money received from a financier goes back to the financier.
--   - Accounts records each refund as paid.
-- Hold and cancellation stop once the car is invoiced: after that it is a sales return, outside this CRM.

-- ===== History =====
create table booking_events (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  kind text not null check (kind in ('status', 'hold', 'resume', 'cancel_requested', 'cancel_approved', 'cancel_rejected')),
  status_from text,
  status_to text,
  note text,
  by_employee_id uuid references employees(id) default current_employee_id(),
  -- clock time, so events within one transaction keep their order
  created_at timestamptz not null default clock_timestamp()
);
create index idx_booking_events_booking on booking_events(booking_id, created_at);
alter table booking_events enable row level security;
create policy booking_events_select on booking_events for select to authenticated using (can_access_booking(booking_id));

create or replace function bookings_log_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.status is distinct from OLD.status then
    insert into booking_events (booking_id, kind, status_from, status_to) values (NEW.id, 'status', OLD.status, NEW.status);
  end if;
  return NEW;
end;
$$;
create trigger trg_bookings_log_status after update of status on bookings
  for each row execute function bookings_log_status();

-- ===== Releasing a car (shared by release_allotment, hold and cancel) =====
create or replace function release_allotment_core(p_allotment_id uuid, p_reason text)
returns void
language plpgsql
set search_path = public
as $$
declare
  a allotments%rowtype;
begin
  select * into a from allotments where id = p_allotment_id and released_at is null for update;
  if a.id is null then
    raise exception 'Allotment not found or already released';
  end if;
  if exists (select 1 from billing_requests where allotment_id = a.id and status in ('pending', 'invoiced')) then
    raise exception 'This car has been sent for billing; pull the billing request back first';
  end if;
  update allotments set released_at = now(), released_by = current_employee_id(), release_reason = btrim(p_reason)
  where id = a.id;
  update vehicles set status = 'available' where id = a.vehicle_id;
  update bookings set status = 'booked' where id = a.booking_id and status = 'allocated';
  -- If CTDMS was never told about the block, there is nothing to undo there.
  if exists (select 1 from ctdms_block_tasks where allotment_id = a.id and action = 'block' and status = 'pending') then
    update ctdms_block_tasks set status = 'cancelled' where allotment_id = a.id and action = 'block' and status = 'pending';
  else
    insert into ctdms_block_tasks (allotment_id, vehicle_id, booking_id, action) values (a.id, a.vehicle_id, a.booking_id, 'unblock');
  end if;
end;
$$;
revoke execute on function release_allotment_core(uuid, text) from public, anon, authenticated;

create or replace function release_allotment(p_allotment_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a allotments%rowtype;
begin
  select * into a from allotments where id = p_allotment_id and released_at is null;
  if a.id is null then
    raise exception 'Allotment not found or already released';
  end if;
  if not can_manage_stock(array[(select outlet_id from bookings where id = a.booking_id),
                                (select outlet_id from vehicles where id = a.vehicle_id)]) then
    raise exception 'Only an Outlet Head or above can release an allotment';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give a reason for releasing the car';
  end if;
  perform release_allotment_core(a.id, p_reason);
end;
$$;

-- ===== Hold =====
create table booking_holds (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  reason text not null,
  expected_resume_date date,
  held_by uuid references employees(id),
  held_at timestamptz not null default now(),
  resumed_at timestamptz,
  resumed_by uuid references employees(id),
  resume_note text
);
create unique index uq_booking_holds_active on booking_holds(booking_id) where resumed_at is null;
alter table booking_holds enable row level security;
create policy booking_holds_select on booking_holds for select to authenticated using (can_access_booking(booking_id));

create or replace function booking_on_hold(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from booking_holds where booking_id = p_booking_id and resumed_at is null);
$$;

-- A booking on hold does not take a car (otherwise as in 20261029000001).
create or replace function booking_allotable(p_booking_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from bookings b
    where b.id = p_booking_id and b.status = 'booked' and b.variant_id is not null and b.color_id is not null
      and coalesce(b.ctdms_order_status, '') <> 'Closed in CTDMS'
      and not exists (select 1 from allotments a where a.booking_id = b.id and a.released_at is null)
      and not exists (select 1 from booking_holds h where h.booking_id = b.id and h.resumed_at is null)
      and coalesce((select status from approvals where booking_id = b.id order by created_at desc limit 1), 'approved') = 'approved'
  );
$$;

create or replace function hold_booking(p_booking_id uuid, p_reason text, p_expected_resume date default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_allotment uuid;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id for update;
  if b.id is null or not can_handle_booking(b) then
    raise exception 'Booking not found';
  end if;
  if b.status in ('delivered', 'cancelled') then
    raise exception 'This booking is %', b.status;
  end if;
  if b.status = 'ready_to_invoice' then
    raise exception 'This car has been sent for billing; pull the billing request back first';
  end if;
  if booking_on_hold(b.id) then
    raise exception 'This booking is already on hold';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give the reason for the hold';
  end if;
  if p_expected_resume is not null and p_expected_resume < (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'The expected resume date has passed';
  end if;

  select id into v_allotment from allotments where booking_id = b.id and released_at is null;
  if v_allotment is not null then
    perform release_allotment_core(v_allotment, 'On hold: ' || btrim(p_reason));
  end if;
  insert into booking_holds (booking_id, reason, expected_resume_date, held_by)
  values (b.id, btrim(p_reason), p_expected_resume, current_employee_id())
  returning id into v_id;
  insert into booking_events (booking_id, kind, note)
  values (b.id, 'hold', btrim(p_reason) || coalesce(' (expected back ' || to_char(p_expected_resume, 'DD Mon YYYY') || ')', '')
                         || case when v_allotment is not null then '; allotted car released' else '' end);
  return v_id;
end;
$$;

create or replace function resume_booking(p_booking_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not can_handle_booking(b) then
    raise exception 'Booking not found';
  end if;
  update booking_holds set resumed_at = now(), resumed_by = current_employee_id(), resume_note = nullif(btrim(p_note), '')
  where booking_id = b.id and resumed_at is null;
  if not found then
    raise exception 'This booking is not on hold';
  end if;
  insert into booking_events (booking_id, kind, note) values (b.id, 'resume', nullif(btrim(p_note), ''));
end;
$$;

-- ===== Cancellation =====
create table booking_cancellations (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  reason_category text not null check (reason_category in (
    'finance_not_approved', 'bought_elsewhere', 'delivery_delay', 'price', 'changed_mind', 'personal', 'other')),
  reason text not null,
  request_storage_path text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by uuid references employees(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references employees(id),
  decided_at timestamptz,
  decision_note text
);
create unique index uq_booking_cancellations_pending on booking_cancellations(booking_id) where status = 'pending';
alter table booking_cancellations enable row level security;
create policy booking_cancellations_select on booking_cancellations for select to authenticated using (can_access_booking(booking_id));

create table refunds (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  cancellation_id uuid not null references booking_cancellations(id),
  outlet_id uuid not null references outlets(id),
  payee text not null check (payee in ('customer', 'financier')),
  payee_name text,
  amount numeric not null check (amount > 0),
  due_date date not null,
  status text not null default 'pending' check (status in ('pending', 'paid')),
  cheque_no text,
  paid_on date,
  bank_name text,
  paid_by uuid references employees(id),
  created_at timestamptz not null default now()
);
create index idx_refunds_pending on refunds(outlet_id) where status = 'pending';
alter table refunds enable row level security;
create policy refunds_select on refunds for select to authenticated using (can_access_booking(booking_id));

-- n working days (Monday to Saturday) after a date.
create or replace function add_working_days(p_from date, p_days int)
returns date
language plpgsql
immutable
set search_path = public
as $$
declare
  d date := p_from;
  n int := 0;
begin
  while n < p_days loop
    d := d + 1;
    if extract(isodow from d) <> 7 then
      n := n + 1;
    end if;
  end loop;
  return d;
end;
$$;

create or replace function request_cancellation(p_booking_id uuid, p_reason_category text, p_reason text, p_request_path text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id for update;
  if b.id is null or not can_handle_booking(b) then
    raise exception 'Booking not found';
  end if;
  if b.status in ('delivered', 'cancelled') then
    raise exception 'This booking is %', b.status;
  end if;
  if exists (select 1 from billing_requests where booking_id = b.id and status = 'invoiced') then
    raise exception 'This car has been invoiced; a cancellation now is a sales return, handled by Accounts';
  end if;
  if exists (select 1 from booking_cancellations where booking_id = b.id and status = 'pending') then
    raise exception 'A cancellation is already waiting for approval';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give the customer''s reason for cancelling';
  end if;
  if p_request_path is not null and p_request_path not like b.id::text || '/cancellation/%' then
    raise exception 'The written request must be stored with this booking';
  end if;
  insert into booking_cancellations (booking_id, reason_category, reason, request_storage_path, requested_by)
  values (b.id, p_reason_category, btrim(p_reason), p_request_path, current_employee_id())
  returning id into v_id;
  insert into booking_events (booking_id, kind, note) values (b.id, 'cancel_requested', btrim(p_reason));
  return v_id;
end;
$$;

create or replace function decide_cancellation(p_cancellation_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c booking_cancellations%rowtype;
  b bookings%rowtype;
  v_allotment uuid;
  v_customer numeric;
  v_due date := add_working_days((now() at time zone 'Asia/Kolkata')::date, 7);
  r record;
begin
  select * into c from booking_cancellations where id = p_cancellation_id for update;
  if c.id is null or c.status <> 'pending' then
    raise exception 'Cancellation request not found or already decided';
  end if;
  select * into b from bookings where id = c.booking_id for update;
  if not (coalesce(current_employee_role_rank() <= 1, false)
          or (coalesce(current_employee_role_rank() = 2, false) and current_employee_outlet_id() = b.outlet_id)) then
    raise exception 'Only the branch''s Outlet Head or above can decide a cancellation';
  end if;

  if not p_approve then
    if nullif(btrim(p_note), '') is null then
      raise exception 'Give the reason for rejecting the cancellation';
    end if;
    update booking_cancellations set status = 'rejected', decided_by = current_employee_id(), decided_at = now(),
      decision_note = btrim(p_note) where id = c.id;
    insert into booking_events (booking_id, kind, note) values (b.id, 'cancel_rejected', btrim(p_note));
    return;
  end if;

  if exists (select 1 from billing_requests where booking_id = b.id and status = 'invoiced') then
    raise exception 'This car has been invoiced; a cancellation now is a sales return, handled by Accounts';
  end if;
  update billing_requests set status = 'cancelled', cancel_reason = 'Booking cancelled' where booking_id = b.id and status = 'pending';
  select id into v_allotment from allotments where booking_id = b.id and released_at is null;
  if v_allotment is not null then
    perform release_allotment_core(v_allotment, 'Booking cancelled');
  end if;
  update booking_holds set resumed_at = now(), resumed_by = current_employee_id(), resume_note = 'Booking cancelled'
  where booking_id = b.id and resumed_at is null;
  update finance_cases set status = 'rejected', rejection_reason = 'Booking cancelled'
  where booking_id = b.id and status not in ('disbursed', 'rejected');

  update booking_cancellations set status = 'approved', decided_by = current_employee_id(), decided_at = now(),
    decision_note = nullif(btrim(p_note), '') where id = c.id;
  update bookings set status = 'cancelled' where id = b.id;
  insert into booking_events (booking_id, kind, note) values (b.id, 'cancel_approved', nullif(btrim(p_note), ''));

  -- Money received from a financier goes back to that financier; the rest to the customer by cheque.
  for r in
    select f.name, sum(p.amount) as amount from payment_receipts p
    join finance_cases fc on fc.id = p.finance_case_id join financiers f on f.id = fc.financier_id
    where p.booking_id = b.id and p.mode = 'finance_disbursement' and p.clearance_status = 'cleared'
    group by f.name
  loop
    insert into refunds (booking_id, cancellation_id, outlet_id, payee, payee_name, amount, due_date)
    values (b.id, c.id, b.outlet_id, 'financier', r.name, r.amount, v_due);
  end loop;
  select coalesce(sum(amount), 0) into v_customer from payment_receipts
  where booking_id = b.id and mode <> 'finance_disbursement' and clearance_status = 'cleared';
  if v_customer > 0 then
    insert into refunds (booking_id, cancellation_id, outlet_id, payee, payee_name, amount, due_date)
    values (b.id, c.id, b.outlet_id, 'customer', b.customer_name, v_customer, v_due);
  end if;
end;
$$;

create or replace function mark_refund_paid(p_refund_id uuid, p_cheque_no text, p_paid_on date, p_bank_name text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r refunds%rowtype;
begin
  select * into r from refunds where id = p_refund_id for update;
  if r.id is null or not is_branch_accounts(r.outlet_id) then
    raise exception 'Only Accounts of the branch can record refunds';
  end if;
  if r.status = 'paid' then
    raise exception 'This refund is already paid';
  end if;
  if nullif(btrim(p_cheque_no), '') is null or p_paid_on is null then
    raise exception 'Enter the cheque number and date';
  end if;
  if p_paid_on > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'The refund date cannot be in the future';
  end if;
  update refunds set status = 'paid', cheque_no = btrim(p_cheque_no), paid_on = p_paid_on,
    bank_name = nullif(btrim(p_bank_name), ''), paid_by = current_employee_id()
  where id = r.id;
end;
$$;

revoke execute on function bookings_log_status() from public, anon, authenticated;
revoke execute on function booking_on_hold(uuid) from public, anon;
revoke execute on function hold_booking(uuid, text, date) from public, anon;
revoke execute on function resume_booking(uuid, text) from public, anon;
revoke execute on function request_cancellation(uuid, text, text, text) from public, anon;
revoke execute on function decide_cancellation(uuid, boolean, text) from public, anon;
revoke execute on function mark_refund_paid(uuid, text, date, text) from public, anon;
grant execute on function booking_on_hold(uuid) to authenticated;
grant execute on function hold_booking(uuid, text, date) to authenticated;
grant execute on function resume_booking(uuid, text) to authenticated;
grant execute on function request_cancellation(uuid, text, text, text) to authenticated;
grant execute on function decide_cancellation(uuid, boolean, text) to authenticated;
grant execute on function mark_refund_paid(uuid, text, date, text) to authenticated;
grant execute on function add_working_days(date, int) to authenticated;
