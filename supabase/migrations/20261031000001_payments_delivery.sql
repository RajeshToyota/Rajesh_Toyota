-- Phase 12: payments, insurance, RTO and delivery, and the delivery gate.
--   - Payment receipts against a booking. Cash, UPI, card and bank transfers clear at once; cheques
--     and DDs wait until Accounts clears (or bounces) them. The booking-form payment and an
--     in-house finance disbursement become receipts automatically.
--   - The deal amount is the booked on-road price plus the docket's accessories order; outstanding
--     is the deal amount less cleared receipts.
--   - The insurance policy and the RTO registration (temporary / permanent number, HSRP, RC) are
--     recorded by the back office, with the policy and tax receipt on file.
--   - The delivery checklist (PDI, accessories fitted, FASTag, documents explained, demo, handover
--     photo, customer signature) is filled on mobile.
--   - complete_delivery() marks the booking delivered only when: the car is invoiced, the policy
--     number and a registration number are in, the checklist is complete and nothing is
--     outstanding. A Business Head may override the outstanding amount, with a reason.

-- Accounts now works every booking of its branch (receipts), not only the billing queue.
alter policy bookings_select_accounts on bookings using (is_accounts() and outlet_id = current_employee_outlet_id());

-- Back office (rank <= 3) of the booking's branch, or Business Head / Admin anywhere.
create or replace function is_branch_back_office(p_outlet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_employee_role_rank() <= 1, false)
      or (coalesce(current_employee_role_rank() <= 3, false) and current_employee_outlet_id() = p_outlet_id);
$$;

-- Accounts of the branch, or Business Head / Admin anywhere.
create or replace function is_branch_accounts(p_outlet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_employee_role_rank() <= 1, false)
      or (is_accounts() and current_employee_outlet_id() = p_outlet_id);
$$;

-- ===== Payments =====
create sequence payment_receipt_seq;

create table payment_receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_no text not null unique default 'RCPT-' || to_char(now() at time zone 'Asia/Kolkata', 'YYMM') || '-' || lpad(nextval('payment_receipt_seq')::text, 5, '0'),
  booking_id uuid not null references bookings(id),
  outlet_id uuid not null references outlets(id),
  mode text not null check (mode in ('cash', 'cheque', 'dd', 'upi', 'bank_transfer', 'card', 'finance_disbursement', 'exchange', 'scrap', 'other')),
  amount numeric not null check (amount > 0),
  received_on date not null default ((now() at time zone 'Asia/Kolkata')::date),
  instrument_no text,
  bank_name text,
  clearance_status text not null default 'pending' check (clearance_status in ('pending', 'cleared', 'bounced')),
  cleared_on date,
  finance_case_id uuid references finance_cases(id),
  is_booking_amount boolean not null default false,
  notes text,
  recorded_by uuid references employees(id),
  created_at timestamptz not null default now()
);
create index idx_payment_receipts_booking on payment_receipts(booking_id);
create index idx_payment_receipts_pending on payment_receipts(outlet_id) where clearance_status = 'pending';
create unique index uq_payment_receipts_disbursement on payment_receipts(finance_case_id) where mode = 'finance_disbursement';

alter table payment_receipts enable row level security;
create policy payment_receipts_select on payment_receipts for select to authenticated using (can_access_booking(booking_id));

create or replace function payment_mode_clears_at_once(p_mode text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_mode in ('cash', 'upi', 'bank_transfer', 'card', 'finance_disbursement', 'exchange', 'scrap');
$$;

-- What the customer owes on a booking. Bounced receipts count for nothing; pending ones are shown
-- separately and are not counted as paid.
create or replace function booking_account(p_booking_id uuid)
returns table (deal_amount numeric, vehicle_amount numeric, accessories_amount numeric, cleared numeric, pending numeric, outstanding numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select d.vehicle + d.accessories, d.vehicle, d.accessories, d.cleared, d.pending,
         d.vehicle + d.accessories - d.cleared
  from (
    select coalesce(b.total_amount, 0) as vehicle,
           coalesce((select accessories_total from welcome_dockets w where w.booking_id = b.id), 0) as accessories,
           coalesce((select sum(amount) from payment_receipts r where r.booking_id = b.id and r.clearance_status = 'cleared'), 0) as cleared,
           coalesce((select sum(amount) from payment_receipts r where r.booking_id = b.id and r.clearance_status = 'pending'), 0) as pending
    from bookings b where b.id = p_booking_id
  ) d;
$$;

-- Open bookings (allotted or further, not yet delivered) with what is still owed, for the
-- payments desk. Runs with the caller's access.
create or replace function outstanding_bookings()
returns table (booking_id uuid, customer_name text, ctdms_order_no text, status text, outlet text,
               deal_amount numeric, cleared numeric, pending numeric, outstanding numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select b.id, b.customer_name, b.ctdms_order_booking_no, b.status, o.name, a.deal_amount, a.cleared, a.pending, a.outstanding
  from bookings b
  join outlets o on o.id = b.outlet_id
  cross join lateral booking_account(b.id) a
  where b.status in ('allocated', 'ready_to_invoice')
  order by a.outstanding desc;
$$;

create or replace function record_payment(
  p_booking_id uuid, p_mode text, p_amount numeric, p_received_on date default null,
  p_instrument_no text default null, p_bank_name text default null, p_notes text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not is_branch_accounts(b.outlet_id) then
    raise exception 'Only Accounts of the booking''s branch can record payments';
  end if;
  if b.status = 'cancelled' then
    raise exception 'This booking is cancelled';
  end if;
  if p_mode = 'finance_disbursement' then
    raise exception 'Finance disbursements are recorded from the finance case';
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'Enter the amount received';
  end if;
  if p_received_on > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'The receipt date cannot be in the future';
  end if;
  if p_mode in ('cheque', 'dd') and nullif(btrim(p_instrument_no), '') is null then
    raise exception 'Enter the cheque / DD number';
  end if;

  insert into payment_receipts (booking_id, outlet_id, mode, amount, received_on, instrument_no, bank_name, notes,
                                clearance_status, cleared_on, recorded_by)
  values (b.id, b.outlet_id, p_mode, p_amount, coalesce(p_received_on, (now() at time zone 'Asia/Kolkata')::date),
          nullif(btrim(p_instrument_no), ''), nullif(btrim(p_bank_name), ''), nullif(btrim(p_notes), ''),
          case when payment_mode_clears_at_once(p_mode) then 'cleared' else 'pending' end,
          case when payment_mode_clears_at_once(p_mode) then coalesce(p_received_on, (now() at time zone 'Asia/Kolkata')::date) end,
          current_employee_id())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function set_payment_clearance(p_receipt_id uuid, p_status text, p_on date default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r payment_receipts%rowtype;
begin
  select * into r from payment_receipts where id = p_receipt_id for update;
  if r.id is null or not is_branch_accounts(r.outlet_id) then
    raise exception 'Only Accounts of the branch can clear receipts';
  end if;
  if p_status not in ('cleared', 'bounced') then
    raise exception 'A receipt is either cleared or bounced';
  end if;
  if r.clearance_status <> 'pending' then
    raise exception 'This receipt is already %', r.clearance_status;
  end if;
  update payment_receipts set clearance_status = p_status,
    cleared_on = coalesce(p_on, (now() at time zone 'Asia/Kolkata')::date)
  where id = r.id;
end;
$$;

-- The booking-form payment becomes the first receipt.
create or replace function bookings_booking_amount_receipt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text;
  t text := lower(coalesce(NEW.payment_instrument_type, ''));
begin
  if NEW.imported_from_ctdms or coalesce(NEW.payment_amount, 0) <= 0 then
    return NEW;
  end if;
  v_mode := case
    when t ~ 'cash' then 'cash'
    when t ~ 'cheque|chq|check' then 'cheque'
    when t ~ '\mdd\M|demand|draft|pay ?order' then 'dd'
    when t ~ 'upi|gpay|phonepe|paytm' then 'upi'
    when t ~ 'neft|rtgs|imps|transfer' then 'bank_transfer'
    when t ~ 'card' then 'card'
    else 'other' end;
  insert into payment_receipts (booking_id, outlet_id, mode, amount, received_on, instrument_no, bank_name,
                                clearance_status, cleared_on, is_booking_amount, notes, recorded_by)
  values (NEW.id, NEW.outlet_id, v_mode, NEW.payment_amount,
          coalesce(NEW.payment_date, (now() at time zone 'Asia/Kolkata')::date), NEW.payment_instrument_no, NEW.payment_bank_name,
          case when payment_mode_clears_at_once(v_mode) then 'cleared' else 'pending' end,
          case when payment_mode_clears_at_once(v_mode) then coalesce(NEW.payment_date, (now() at time zone 'Asia/Kolkata')::date) end,
          true, 'Booking amount', NEW.employee_id);
  return NEW;
end;
$$;
create trigger trg_bookings_booking_amount_receipt after insert on bookings
  for each row execute function bookings_booking_amount_receipt();

-- An in-house finance disbursement is money received from the financier.
create or replace function finance_cases_disbursement_receipt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.status = 'disbursed' and OLD.status is distinct from 'disbursed' and NEW.finance_type = 'in_house'
     and coalesce(NEW.disbursed_amount, 0) > 0 then
    insert into payment_receipts (booking_id, outlet_id, mode, amount, received_on, clearance_status, cleared_on,
                                  finance_case_id, notes, recorded_by)
    values (NEW.booking_id, NEW.outlet_id, 'finance_disbursement', NEW.disbursed_amount, NEW.disbursed_date, 'cleared',
            NEW.disbursed_date, NEW.id, 'Disbursed by ' || (select name from financiers where id = NEW.financier_id),
            current_employee_id())
    on conflict do nothing;
  end if;
  return NEW;
end;
$$;
create trigger trg_finance_cases_disbursement_receipt after update of status on finance_cases
  for each row execute function finance_cases_disbursement_receipt();

-- ===== Insurance =====
create table insurance_policies (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings(id),
  insurance_provider_id uuid references insurance_providers(id),
  insurer_name text,
  policy_no text not null,
  coverage text,
  premium numeric check (premium >= 0),
  idv numeric check (idv >= 0),
  start_date date,
  end_date date,
  in_house boolean not null default true,
  policy_storage_path text,
  recorded_by uuid references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (insurance_provider_id is not null or nullif(btrim(insurer_name), '') is not null)
);
create trigger trg_insurance_policies_updated_at before update on insurance_policies for each row execute function set_updated_at();
alter table insurance_policies enable row level security;
create policy insurance_policies_select on insurance_policies for select to authenticated using (can_access_booking(booking_id));

-- ===== RTO =====
create table rto_registrations (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings(id),
  temp_reg_no text,
  temp_reg_date date,
  perm_reg_no text,
  perm_reg_date date,
  hsrp_status text not null default 'not_applied' check (hsrp_status in ('not_applied', 'applied', 'received', 'fitted')),
  hsrp_date date,
  rc_status text not null default 'pending' check (rc_status in ('pending', 'received', 'handed_over')),
  rc_date date,
  road_tax_amount numeric check (road_tax_amount >= 0),
  tax_receipt_storage_path text,
  notes text,
  recorded_by uuid references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_rto_registrations_updated_at before update on rto_registrations for each row execute function set_updated_at();
alter table rto_registrations enable row level security;
create policy rto_registrations_select on rto_registrations for select to authenticated using (can_access_booking(booking_id));

-- Only the given (non-null) fields change.
create or replace function save_insurance_policy(p_booking_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not is_branch_back_office(b.outlet_id) then
    raise exception 'Only the branch''s back office can record insurance';
  end if;
  if p->>'policy_storage_path' is not null and p->>'policy_storage_path' not like b.id::text || '/insurance/%' then
    raise exception 'The policy file must be stored with this booking';
  end if;
  update insurance_policies set
    insurance_provider_id = coalesce((p->>'insurance_provider_id')::uuid, insurance_provider_id),
    insurer_name = coalesce(nullif(btrim(p->>'insurer_name'), ''), insurer_name),
    policy_no = coalesce(nullif(btrim(p->>'policy_no'), ''), policy_no),
    coverage = coalesce(nullif(btrim(p->>'coverage'), ''), coverage),
    premium = coalesce((p->>'premium')::numeric, premium),
    idv = coalesce((p->>'idv')::numeric, idv),
    start_date = coalesce((p->>'start_date')::date, start_date),
    end_date = coalesce((p->>'end_date')::date, end_date),
    in_house = coalesce((p->>'in_house')::boolean, in_house),
    policy_storage_path = coalesce(p->>'policy_storage_path', policy_storage_path),
    recorded_by = current_employee_id()
  where booking_id = b.id
  returning id into v_id;
  if v_id is not null then
    return v_id;
  end if;

  if nullif(btrim(p->>'policy_no'), '') is null then
    raise exception 'Enter the policy number';
  end if;
  insert into insurance_policies (booking_id, insurance_provider_id, insurer_name, policy_no, coverage, premium, idv,
                                  start_date, end_date, in_house, policy_storage_path, recorded_by)
  values (b.id, (p->>'insurance_provider_id')::uuid, nullif(btrim(p->>'insurer_name'), ''), btrim(p->>'policy_no'),
          nullif(btrim(p->>'coverage'), ''), (p->>'premium')::numeric, (p->>'idv')::numeric, (p->>'start_date')::date,
          (p->>'end_date')::date, coalesce((p->>'in_house')::boolean, true), p->>'policy_storage_path', current_employee_id())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function save_rto_registration(p_booking_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not is_branch_back_office(b.outlet_id) then
    raise exception 'Only the branch''s back office can record the registration';
  end if;
  if p->>'tax_receipt_storage_path' is not null and p->>'tax_receipt_storage_path' not like b.id::text || '/rto/%' then
    raise exception 'The tax receipt must be stored with this booking';
  end if;
  insert into rto_registrations as r (booking_id, temp_reg_no, temp_reg_date, perm_reg_no, perm_reg_date, hsrp_status,
                                      hsrp_date, rc_status, rc_date, road_tax_amount, tax_receipt_storage_path, notes, recorded_by)
  values (b.id, nullif(upper(btrim(p->>'temp_reg_no')), ''), (p->>'temp_reg_date')::date,
          nullif(upper(btrim(p->>'perm_reg_no')), ''), (p->>'perm_reg_date')::date,
          coalesce(p->>'hsrp_status', 'not_applied'), (p->>'hsrp_date')::date, coalesce(p->>'rc_status', 'pending'),
          (p->>'rc_date')::date, (p->>'road_tax_amount')::numeric, p->>'tax_receipt_storage_path',
          nullif(btrim(p->>'notes'), ''), current_employee_id())
  on conflict (booking_id) do update set
    temp_reg_no = coalesce(excluded.temp_reg_no, r.temp_reg_no),
    temp_reg_date = coalesce(excluded.temp_reg_date, r.temp_reg_date),
    perm_reg_no = coalesce(excluded.perm_reg_no, r.perm_reg_no),
    perm_reg_date = coalesce(excluded.perm_reg_date, r.perm_reg_date),
    hsrp_status = case when p ? 'hsrp_status' then excluded.hsrp_status else r.hsrp_status end,
    hsrp_date = coalesce(excluded.hsrp_date, r.hsrp_date),
    rc_status = case when p ? 'rc_status' then excluded.rc_status else r.rc_status end,
    rc_date = coalesce(excluded.rc_date, r.rc_date),
    road_tax_amount = coalesce(excluded.road_tax_amount, r.road_tax_amount),
    tax_receipt_storage_path = coalesce(excluded.tax_receipt_storage_path, r.tax_receipt_storage_path),
    notes = coalesce(excluded.notes, r.notes),
    recorded_by = excluded.recorded_by
  returning id into v_id;
  return v_id;
end;
$$;

-- ===== Delivery =====
create table deliveries (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings(id),
  status text not null default 'draft' check (status in ('draft', 'delivered')),
  pdi_done boolean not null default false,
  accessories_fitted boolean not null default false,
  fastag_fitted boolean not null default false,
  documents_explained boolean not null default false,
  demo_done boolean not null default false,
  handover_photo_path text,
  customer_signature_path text,
  delivered_at timestamptz,
  delivered_by uuid references employees(id),
  outstanding_at_delivery numeric,
  override_reason text,
  override_by uuid references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_deliveries_updated_at before update on deliveries for each row execute function set_updated_at();
alter table deliveries enable row level security;
create policy deliveries_select on deliveries for select to authenticated using (can_access_booking(booking_id));

-- Whoever can work the booking (its consultant line, back office of the branch) fills the checklist.
create or replace function can_handle_booking(b bookings)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select can_access_employee_data(current_employee_id(), b.employee_id) or is_branch_back_office(b.outlet_id);
$$;

create or replace function save_delivery_checklist(p_booking_id uuid, p jsonb)
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
  if exists (select 1 from deliveries where booking_id = b.id and status = 'delivered') then
    raise exception 'This car has been delivered';
  end if;
  if (p->>'handover_photo_path' is not null and p->>'handover_photo_path' not like b.id::text || '/delivery/%')
     or (p->>'customer_signature_path' is not null and p->>'customer_signature_path' not like b.id::text || '/delivery/%') then
    raise exception 'Delivery files must be stored with this booking';
  end if;
  insert into deliveries as d (booking_id, pdi_done, accessories_fitted, fastag_fitted, documents_explained, demo_done,
                               handover_photo_path, customer_signature_path)
  values (b.id, coalesce((p->>'pdi_done')::boolean, false), coalesce((p->>'accessories_fitted')::boolean, false),
          coalesce((p->>'fastag_fitted')::boolean, false), coalesce((p->>'documents_explained')::boolean, false),
          coalesce((p->>'demo_done')::boolean, false), p->>'handover_photo_path', p->>'customer_signature_path')
  on conflict (booking_id) do update set
    pdi_done = case when p ? 'pdi_done' then excluded.pdi_done else d.pdi_done end,
    accessories_fitted = case when p ? 'accessories_fitted' then excluded.accessories_fitted else d.accessories_fitted end,
    fastag_fitted = case when p ? 'fastag_fitted' then excluded.fastag_fitted else d.fastag_fitted end,
    documents_explained = case when p ? 'documents_explained' then excluded.documents_explained else d.documents_explained end,
    demo_done = case when p ? 'demo_done' then excluded.demo_done else d.demo_done end,
    handover_photo_path = coalesce(excluded.handover_photo_path, d.handover_photo_path),
    customer_signature_path = coalesce(excluded.customer_signature_path, d.customer_signature_path);
end;
$$;

-- What still stops the car being delivered (the outstanding amount listed last, as it can be overridden).
create or replace function delivery_blockers(p_booking_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  d deliveries%rowtype;
  v text[] := '{}';
  v_outstanding numeric;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not (can_handle_booking(b) or is_branch_accounts(b.outlet_id)) then
    raise exception 'Booking not found';
  end if;
  select * into d from deliveries where booking_id = b.id;
  if not exists (select 1 from billing_requests where booking_id = b.id and status = 'invoiced') then
    v := array_append(v, 'The car has not been invoiced');
  end if;
  if not exists (select 1 from insurance_policies where booking_id = b.id and nullif(btrim(policy_no), '') is not null) then
    v := array_append(v, 'Insurance policy number');
  end if;
  if not exists (select 1 from rto_registrations where booking_id = b.id and coalesce(temp_reg_no, perm_reg_no) is not null) then
    v := array_append(v, 'Temporary or permanent registration number');
  end if;
  if not coalesce(d.pdi_done, false) then v := array_append(v, 'PDI done'); end if;
  if not coalesce(d.accessories_fitted, false) then v := array_append(v, 'Accessories fitted and checked'); end if;
  if not coalesce(d.fastag_fitted, false) then v := array_append(v, 'FASTag fitted'); end if;
  if not coalesce(d.documents_explained, false) then v := array_append(v, 'Documents explained'); end if;
  if not coalesce(d.demo_done, false) then v := array_append(v, 'Vehicle demo done'); end if;
  if d.handover_photo_path is null then v := array_append(v, 'Handover photo'); end if;
  if d.customer_signature_path is null then v := array_append(v, 'Customer signature'); end if;
  select outstanding into v_outstanding from booking_account(b.id);
  if v_outstanding > 0 then
    v := array_append(v, 'Outstanding ₹' || to_char(round(v_outstanding), 'FM99,99,99,999'));
  end if;
  return v;
end;
$$;

create or replace function complete_delivery(p_booking_id uuid, p_override_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_blockers text[];
  v_outstanding numeric;
  v_override boolean;
begin
  select * into b from bookings where id = p_booking_id for update;
  if b.id is null or not can_handle_booking(b) then
    raise exception 'Booking not found';
  end if;
  if b.status = 'delivered' then
    raise exception 'This car has already been delivered';
  end if;
  v_blockers := delivery_blockers(b.id);
  select outstanding into v_outstanding from booking_account(b.id);
  v_override := v_outstanding > 0 and nullif(btrim(p_override_reason), '') is not null and coalesce(current_employee_role_rank() <= 1, false);
  if v_override then
    v_blockers := array(select x from unnest(v_blockers) x where x not like 'Outstanding%');
  end if;
  if cardinality(v_blockers) > 0 then
    raise exception 'Not ready for delivery: %', array_to_string(v_blockers, '; ');
  end if;

  update deliveries set status = 'delivered', delivered_at = now(), delivered_by = current_employee_id(),
    outstanding_at_delivery = v_outstanding,
    override_reason = case when v_override then btrim(p_override_reason) end,
    override_by = case when v_override then current_employee_id() end
  where booking_id = b.id;
  update bookings set status = 'delivered' where id = b.id;
end;
$$;

revoke execute on function is_branch_back_office(uuid) from public, anon;
revoke execute on function is_branch_accounts(uuid) from public, anon;
revoke execute on function booking_account(uuid) from public, anon;
revoke execute on function outstanding_bookings() from public, anon;
revoke execute on function record_payment(uuid, text, numeric, date, text, text, text) from public, anon;
revoke execute on function set_payment_clearance(uuid, text, date) from public, anon;
revoke execute on function bookings_booking_amount_receipt() from public, anon, authenticated;
revoke execute on function finance_cases_disbursement_receipt() from public, anon, authenticated;
revoke execute on function save_insurance_policy(uuid, jsonb) from public, anon;
revoke execute on function save_rto_registration(uuid, jsonb) from public, anon;
revoke execute on function can_handle_booking(bookings) from public, anon, authenticated;
revoke execute on function save_delivery_checklist(uuid, jsonb) from public, anon;
revoke execute on function delivery_blockers(uuid) from public, anon;
revoke execute on function complete_delivery(uuid, text) from public, anon;
grant execute on function is_branch_back_office(uuid) to authenticated;
grant execute on function is_branch_accounts(uuid) to authenticated;
grant execute on function booking_account(uuid) to authenticated;
grant execute on function outstanding_bookings() to authenticated;
grant execute on function record_payment(uuid, text, numeric, date, text, text, text) to authenticated;
grant execute on function set_payment_clearance(uuid, text, date) to authenticated;
grant execute on function save_insurance_policy(uuid, jsonb) to authenticated;
grant execute on function save_rto_registration(uuid, jsonb) to authenticated;
grant execute on function save_delivery_checklist(uuid, jsonb) to authenticated;
grant execute on function delivery_blockers(uuid) to authenticated;
grant execute on function complete_delivery(uuid, text) to authenticated;
