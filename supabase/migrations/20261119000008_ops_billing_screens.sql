-- Phase 30: Ops Billing — the rest of Techwheels' ten Ops Billing screens on RT's stage pipeline.
--   Accounts / Insurance / Accessories rework: a request (insurance: self-insured or add-ons; accessories:
--     reduce or add) with an amount, approved by Accounts; the revised amount replaces the deal's figure
--     and so the amount due (booking_account).
--   Accessories: per-item fitment checklist; accessories added after delivery; counter sales to people
--     without a booking.
--   Schemes: claim proof per selected scheme line (and an MSME certificate); the stage is done only
--     when every line has its proof.
--   Scrap: supplier master, COD number, date, price, and a certificate discount between 0 and the
--     quoted scrap amount, audited; the stage needs the COD number.
--   RTO: registration type (normal / BH / transfer), special number and its amount; the register
--     reconciliation upload; expected in-house payout per case from the bank's rates.
--   Payment receipts: an accounting-entry flag, cancel and transfer to another booking (each an
--     event), the amount due before and after each receipt, and a public verification by number.
--   Reversals: a request may also reopen billing (the invoice is cancelled, refused after the car
--     left) and name booking documents to clear.
--   Delivered: revert with a reason; the car goes back to where it stood and the slot is kept.
--   CTDMS order tracker: bookings whose CTDMS order number or date is missing, with the lag.

-- ===== Rework =====
alter table bookings
  add column revised_insurance_amount numeric check (revised_insurance_amount >= 0),
  add column revised_accessories_amount numeric check (revised_accessories_amount >= 0);

create table ops_reworks (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  stage text not null check (stage in ('insurance', 'accessories')),
  kind text not null check ((stage = 'insurance' and kind in ('self', 'add_ons')) or (stage = 'accessories' and kind in ('reduce', 'add_ons'))),
  amount numeric not null check (amount >= 0),     -- the new total for that part of the deal (0 = self-insured / none)
  remarks text not null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected')),
  requested_by uuid references employees(id) default current_employee_id(),
  requested_at timestamptz not null default now(),
  resolved_by uuid references employees(id),
  resolved_at timestamptz,
  resolution_note text
);
create unique index uq_ops_reworks_open on ops_reworks(booking_id, stage) where status = 'requested';
create index idx_ops_reworks_requested_by on ops_reworks(requested_by);
create index idx_ops_reworks_resolved_by on ops_reworks(resolved_by);
alter table ops_reworks enable row level security;
create policy ops_reworks_select on ops_reworks for select to authenticated using (can_access_booking(booking_id));

create or replace function request_rework(p_booking_id uuid, p_stage text, p_kind text, p_amount numeric, p_remarks text)
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
  if b.id is null or not ops_can('ops_' || p_stage, 'edit', b.outlet_id) then raise exception 'Booking not found'; end if;
  if b.status in ('delivered', 'cancelled') then raise exception 'This booking is closed'; end if;
  if nullif(btrim(p_remarks), '') is null then raise exception 'Say what changes'; end if;
  insert into ops_reworks (booking_id, stage, kind, amount, remarks) values (b.id, p_stage, p_kind, p_amount, btrim(p_remarks))
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'A rework for this stage is already waiting for Accounts';
end;
$$;

-- Accounts approves (the revised amount now counts) or rejects.
create or replace function resolve_rework(p_rework_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r ops_reworks%rowtype;
  b bookings%rowtype;
begin
  select * into r from ops_reworks where id = p_rework_id for update;
  if r.id is null or r.status <> 'requested' then raise exception 'Rework not found or already decided'; end if;
  select * into b from bookings where id = r.booking_id;
  if not is_branch_accounts(b.outlet_id) then raise exception 'Only Accounts of the branch can approve a rework'; end if;
  if not p_approve and nullif(btrim(p_note), '') is null then raise exception 'Give the reason'; end if;
  update ops_reworks set status = case when p_approve then 'approved' else 'rejected' end, resolved_by = current_employee_id(),
    resolved_at = now(), resolution_note = nullif(btrim(p_note), '') where id = r.id;
  if p_approve then
    if r.stage = 'insurance' then
      update bookings set revised_insurance_amount = r.amount where id = b.id;
    else
      update bookings set revised_accessories_amount = r.amount where id = b.id;
    end if;
  end if;
end;
$$;

-- ===== Accessories =====
create table accessory_fitments (
  booking_id uuid not null references bookings(id),
  item_key text not null,            -- accessory id, or a docket order line
  label text not null,
  fitted boolean not null default false,
  fitted_by uuid references employees(id),
  fitted_at timestamptz,
  primary key (booking_id, item_key)
);
create index idx_accessory_fitments_by on accessory_fitments(fitted_by);
alter table accessory_fitments enable row level security;
create policy accessory_fitments_select on accessory_fitments for select to authenticated using (can_access_booking(booking_id));

-- items: [{item_key, label, fitted}]
create or replace function save_accessory_fitment(p_booking_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  i jsonb;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not ops_can('ops_accessories', 'edit', b.outlet_id) then raise exception 'Booking not found'; end if;
  for i in select * from jsonb_array_elements(p_items) loop
    insert into accessory_fitments (booking_id, item_key, label, fitted, fitted_by, fitted_at)
    values (b.id, i->>'item_key', i->>'label', coalesce((i->>'fitted')::boolean, false),
            case when coalesce((i->>'fitted')::boolean, false) then current_employee_id() end,
            case when coalesce((i->>'fitted')::boolean, false) then now() end)
    on conflict (booking_id, item_key) do update set label = excluded.label, fitted = excluded.fitted,
      fitted_by = case when excluded.fitted and not accessory_fitments.fitted then excluded.fitted_by when excluded.fitted then accessory_fitments.fitted_by end,
      fitted_at = case when excluded.fitted and not accessory_fitments.fitted then excluded.fitted_at when excluded.fitted then accessory_fitments.fitted_at end;
  end loop;
end;
$$;

create table post_delivery_accessories (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  accessory_id uuid references accessories(id),
  name text not null,
  quantity int not null default 1 check (quantity > 0),
  unit_price numeric not null check (unit_price >= 0),
  added_by uuid references employees(id) default current_employee_id(),
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references employees(id)
);
create index idx_pda_booking on post_delivery_accessories(booking_id);
create index idx_pda_accessory on post_delivery_accessories(accessory_id);
create index idx_pda_added_by on post_delivery_accessories(added_by);
create index idx_pda_removed_by on post_delivery_accessories(removed_by);
alter table post_delivery_accessories enable row level security;
create policy pda_select on post_delivery_accessories for select to authenticated using (can_access_booking(booking_id));
create policy pda_insert on post_delivery_accessories for insert to authenticated
  with check (exists (select 1 from bookings b where b.id = booking_id and b.status = 'delivered' and ops_can('ops_accessories', 'edit', b.outlet_id)));
create policy pda_update on post_delivery_accessories for update to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and ops_can('ops_accessories', 'edit', b.outlet_id)));

create table counter_accessory_sales (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references outlets(id),
  customer_name text not null,
  customer_mobile text check (customer_mobile is null or customer_mobile ~ '^[6-9][0-9]{9}$'),
  vehicle_reg_no text,
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),   -- [{name, qty, price}]
  total numeric not null check (total > 0),
  payment_mode text not null check (payment_mode in ('cash', 'upi', 'card', 'bank_transfer')),
  payment_reference text,
  sold_by uuid references employees(id) default current_employee_id(),
  sold_at timestamptz not null default now()
);
create index idx_counter_sales_outlet on counter_accessory_sales(outlet_id, sold_at);
create index idx_counter_sales_by on counter_accessory_sales(sold_by);
alter table counter_accessory_sales enable row level security;
create policy counter_sales_select on counter_accessory_sales for select to authenticated using (ops_can('ops_accessories', 'view', outlet_id));
create policy counter_sales_insert on counter_accessory_sales for insert to authenticated
  with check (ops_can('ops_accessories', 'edit', outlet_id) and total = (
    select coalesce(sum((i->>'qty')::numeric * (i->>'price')::numeric), 0) from jsonb_array_elements(items) i));

-- ===== Scheme claim proofs =====
create table scheme_claim_documents (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  scheme_line_item_id uuid references scheme_line_items(id),
  doc_kind text not null check (doc_kind in ('claim_proof', 'msme_certificate')),
  storage_path text not null,
  uploaded_by uuid references employees(id) default current_employee_id(),
  uploaded_at timestamptz not null default now(),
  check (doc_kind = 'msme_certificate' or scheme_line_item_id is not null)
);
create index idx_scheme_claim_docs_booking on scheme_claim_documents(booking_id);
create index idx_scheme_claim_docs_line on scheme_claim_documents(scheme_line_item_id);
create index idx_scheme_claim_docs_by on scheme_claim_documents(uploaded_by);
alter table scheme_claim_documents enable row level security;
create policy scheme_claim_docs_select on scheme_claim_documents for select to authenticated using (can_access_booking(booking_id));
create policy scheme_claim_docs_insert on scheme_claim_documents for insert to authenticated
  with check (storage_booking_id(storage_path) = booking_id
              and exists (select 1 from bookings b where b.id = booking_id and ops_can('ops_scheme', 'edit', b.outlet_id)));

-- Selected customer-facing scheme lines and whether their proof is in.
create or replace function scheme_claim_status(p_booking_id uuid)
returns table (scheme_line_item_id uuid, line text, amount numeric, has_proof boolean)
language sql
stable
security definer
set search_path = public
as $$
  select sli.id, sli.line_type, sli.tkm_share + sli.dealer_share,
         exists (select 1 from scheme_claim_documents d where d.booking_id = b.id and d.scheme_line_item_id = sli.id)
  from bookings b join scheme_line_items sli on sli.id = any (b.selected_scheme_line_item_ids)
  where b.id = p_booking_id and sli.is_customer_facing and can_access_booking(b.id)
  order by sli.line_type;
$$;

-- ===== Scrap =====
create table scrap_suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  phone text,
  is_active boolean not null default true
);
alter table scrap_suppliers enable row level security;
create policy scrap_suppliers_select on scrap_suppliers for select to authenticated using (true);
create policy scrap_suppliers_write on scrap_suppliers for all to authenticated
  using (has_right('ops_scrap', 'edit')) with check (has_right('ops_scrap', 'edit'));

create table booking_scrap_details (
  booking_id uuid primary key references bookings(id),
  supplier_id uuid references scrap_suppliers(id),
  cod_no text,
  scrap_date date,
  scrap_price numeric check (scrap_price >= 0),
  certificate_discount numeric not null default 0 check (certificate_discount >= 0),
  updated_by uuid references employees(id),
  updated_at timestamptz not null default now()
);
create index idx_booking_scrap_supplier on booking_scrap_details(supplier_id);
create index idx_booking_scrap_by on booking_scrap_details(updated_by);
create table booking_scrap_audit (
  id bigserial primary key,
  booking_id uuid not null references bookings(id),
  before jsonb,
  after jsonb not null,
  by_employee_id uuid references employees(id),
  at timestamptz not null default now()
);
create index idx_booking_scrap_audit_booking on booking_scrap_audit(booking_id);
create index idx_booking_scrap_audit_by on booking_scrap_audit(by_employee_id);
alter table booking_scrap_details enable row level security;
alter table booking_scrap_audit enable row level security;
create policy booking_scrap_select on booking_scrap_details for select to authenticated using (can_access_booking(booking_id));
create policy booking_scrap_audit_select on booking_scrap_audit for select to authenticated using (can_access_booking(booking_id));

create or replace function save_scrap_details(p_booking_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_quoted numeric;
  v_before jsonb;
  v_disc numeric := coalesce((p->>'certificate_discount')::numeric, 0);
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not ops_can('ops_scrap', 'edit', b.outlet_id) then raise exception 'Booking not found'; end if;
  v_quoted := coalesce((b.priced_snapshot->>'scrap_amount')::numeric, 0);
  if v_disc < 0 then raise exception 'The certificate discount cannot be negative'; end if;
  if v_disc > v_quoted then
    raise exception 'The certificate discount cannot be more than the scrap amount quoted (₹%)', round(v_quoted);
  end if;
  select to_jsonb(d) into v_before from booking_scrap_details d where d.booking_id = b.id;
  insert into booking_scrap_details (booking_id, supplier_id, cod_no, scrap_date, scrap_price, certificate_discount, updated_by)
  values (b.id, nullif(p->>'supplier_id', '')::uuid, nullif(btrim(p->>'cod_no'), ''), nullif(p->>'scrap_date', '')::date,
          nullif(p->>'scrap_price', '')::numeric, v_disc, current_employee_id())
  on conflict (booking_id) do update set supplier_id = excluded.supplier_id, cod_no = excluded.cod_no, scrap_date = excluded.scrap_date,
    scrap_price = excluded.scrap_price, certificate_discount = excluded.certificate_discount, updated_by = excluded.updated_by, updated_at = now();
  insert into booking_scrap_audit (booking_id, before, after, by_employee_id)
  select b.id, v_before, to_jsonb(d), current_employee_id() from booking_scrap_details d where d.booking_id = b.id;
end;
$$;

-- ===== RTO =====
alter table rto_registrations
  add column rto_type text not null default 'NORMAL' check (rto_type in ('NORMAL', 'BH', 'TRANSFER')),
  add column special_number text,
  add column special_number_amount numeric check (special_number_amount >= 0);

-- Registration numbers are kept upper case with single spaces (as save_rto_registration already does).
create or replace function rto_registrations_normalise()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  NEW.temp_reg_no := nullif(upper(regexp_replace(btrim(coalesce(NEW.temp_reg_no, '')), '\s+', ' ', 'g')), '');
  NEW.perm_reg_no := nullif(upper(regexp_replace(btrim(coalesce(NEW.perm_reg_no, '')), '\s+', ' ', 'g')), '');
  return NEW;
end;
$$;
create trigger trg_rto_registrations_normalise before insert or update on rto_registrations
  for each row execute function rto_registrations_normalise();

create or replace function set_rto_extras(p_booking_id uuid, p_rto_type text, p_special_number text, p_special_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not ops_can('ops_rto', 'edit', b.outlet_id) then raise exception 'Booking not found'; end if;
  if p_rto_type not in ('NORMAL', 'BH', 'TRANSFER') then raise exception 'Registration type must be normal, BH or transfer'; end if;
  if nullif(btrim(p_special_number), '') is not null and coalesce(p_special_amount, 0) <= 0 then
    raise exception 'Enter what the special number costs';
  end if;
  insert into rto_registrations (booking_id, rto_type, special_number, special_number_amount, recorded_by)
  values (b.id, p_rto_type, nullif(upper(btrim(p_special_number)), ''), p_special_amount, current_employee_id())
  on conflict (booking_id) do update set rto_type = excluded.rto_type, special_number = excluded.special_number,
    special_number_amount = excluded.special_number_amount;
end;
$$;

-- The RTO's register (rows: [{reg_no, vin, owner_name}]) against our bookings: matched by registration
-- or VIN, and whether the owner's name agrees.
create or replace function rto_reconcile(p_rows jsonb)
returns table (reg_no text, vin text, owner_name text, booking_id uuid, customer_name text, match_basis text, name_match boolean, rto_status text)
language sql
stable
security definer
set search_path = public
as $$
  with rows as (
    select upper(regexp_replace(coalesce(r->>'reg_no', ''), '[^A-Za-z0-9]', '', 'g')) as reg, upper(btrim(coalesce(r->>'vin', ''))) as vin,
           btrim(coalesce(r->>'owner_name', '')) as owner
    from jsonb_array_elements(p_rows) r
  )
  select r.reg, r.vin, r.owner, b.id, b.customer_name,
         case when rr.id is not null then 'registration' when v.id is not null then 'vin' else 'not found' end,
         case when b.id is null then null
              else upper(split_part(btrim(b.customer_name), ' ', 1)) = upper(split_part(r.owner, ' ', 1)) end,
         case when b.id is null then null when coalesce(x.perm_reg_no, x.temp_reg_no) is not null then 'recorded' else 'not recorded' end
  from rows r
  left join rto_registrations rr on r.reg <> '' and r.reg in (regexp_replace(coalesce(rr.perm_reg_no, ''), '[^A-Z0-9]', '', 'g'),
                                                              regexp_replace(coalesce(rr.temp_reg_no, ''), '[^A-Z0-9]', '', 'g'))
  left join vehicles v on rr.id is null and r.vin <> '' and v.vin = r.vin
  left join allotments a on v.id is not null and a.vehicle_id = v.id and a.released_at is null
  left join bookings b on b.id = coalesce(rr.booking_id, a.booking_id)
  left join rto_registrations x on x.booking_id = b.id
  where has_right('ops_rto', 'view');
$$;

-- Expected bank payout per in-house case whose registration is done (Techwheels' in-house RTO payout).
create or replace function inhouse_payout_expected(p_month date)
returns table (case_id uuid, customer_name text, financier text, do_value numeric, bank_payout numeric, ca_payout numeric, reg_no text)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, b.customer_name, f.name, coalesce(c.net_disbursement_amount, c.do_amount, c.loan_amount, 0),
         case f.bank_payout_basis when 'percent' then round(coalesce(c.net_disbursement_amount, c.do_amount, c.loan_amount, 0) * f.bank_payout_rate / 100, 2) else f.bank_payout_rate end,
         case f.ca_payout_basis when 'percent' then round(coalesce(c.net_disbursement_amount, c.do_amount, c.loan_amount, 0) * f.ca_payout_rate / 100, 2) else f.ca_payout_rate end,
         coalesce(r.perm_reg_no, r.temp_reg_no)
  from finance_cases c join bookings b on b.id = c.booking_id join financiers f on f.id = c.financier_id
  join rto_registrations r on r.booking_id = b.id and coalesce(r.perm_reg_no, r.temp_reg_no) is not null
  where c.finance_type = 'in_house' and c.status in ('do_received', 'disbursed')
    and date_trunc('month', coalesce(r.perm_reg_date, r.temp_reg_date, r.updated_at::date)) = date_trunc('month', p_month)
    and ops_can('ops_rto', 'view', b.outlet_id)
  order by f.name, b.customer_name;
$$;

-- ===== Payment receipts =====
alter table payment_receipts drop constraint payment_receipts_clearance_status_check;
alter table payment_receipts add constraint payment_receipts_clearance_status_check
  check (clearance_status in ('pending', 'cleared', 'bounced', 'cancelled'));
alter table payment_receipts
  add column accounting_entry boolean not null default false,
  add column due_before numeric,
  add column due_after numeric,
  add column cancelled_at timestamptz,
  add column cancelled_by uuid references employees(id),
  add column cancel_reason text,
  add column transferred_from_booking_id uuid references bookings(id);
create index idx_payment_receipts_cancelled_by on payment_receipts(cancelled_by);
create index idx_payment_receipts_transferred_from on payment_receipts(transferred_from_booking_id);

create table payment_receipt_events (
  id bigserial primary key,
  receipt_id uuid not null references payment_receipts(id),
  event text not null check (event in ('created', 'accounting_entry_on', 'accounting_entry_off', 'cancelled', 'transferred')),
  detail jsonb not null default '{}',
  by_employee_id uuid references employees(id) default current_employee_id(),
  at timestamptz not null default now()
);
create index idx_receipt_events_receipt on payment_receipt_events(receipt_id);
create index idx_receipt_events_by on payment_receipt_events(by_employee_id);
alter table payment_receipt_events enable row level security;
create policy receipt_events_select on payment_receipt_events for select to authenticated
  using (exists (select 1 from payment_receipts r where r.id = receipt_id and can_access_booking(r.booking_id)));

-- Every receipt notes what was due before and after it, and its creation.
create or replace function payment_receipts_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_due numeric;
begin
  select a.deal_amount - a.cleared - a.pending into v_due from booking_account(NEW.booking_id) a;
  NEW.due_before := v_due;
  NEW.due_after := v_due - NEW.amount;
  return NEW;
end;
$$;
create trigger trg_payment_receipts_snapshot before insert on payment_receipts
  for each row execute function payment_receipts_snapshot();

create or replace function payment_receipts_created_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into payment_receipt_events (receipt_id, event, detail) values (NEW.id, 'created', jsonb_build_object('amount', NEW.amount, 'mode', NEW.mode));
  return NEW;
end;
$$;
create trigger trg_payment_receipts_created_event after insert on payment_receipts
  for each row execute function payment_receipts_created_event();

create or replace function set_receipt_accounting_entry(p_receipt_id uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r payment_receipts%rowtype;
begin
  select * into r from payment_receipts where id = p_receipt_id for update;
  if r.id is null or not is_branch_accounts(r.outlet_id) then raise exception 'Only Accounts of the branch can do this'; end if;
  update payment_receipts set accounting_entry = p_on where id = r.id;
  insert into payment_receipt_events (receipt_id, event) values (r.id, case when p_on then 'accounting_entry_on' else 'accounting_entry_off' end);
end;
$$;

create or replace function cancel_receipt(p_receipt_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r payment_receipts%rowtype;
begin
  select * into r from payment_receipts where id = p_receipt_id for update;
  if r.id is null or not is_branch_accounts(r.outlet_id) then raise exception 'Only Accounts of the branch can do this'; end if;
  if r.clearance_status = 'cancelled' then raise exception 'Already cancelled'; end if;
  if r.mode = 'finance_disbursement' then raise exception 'A disbursement receipt follows its finance case'; end if;
  if r.accounting_entry then raise exception 'This receipt is entered in the accounts; take it out there first'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  update payment_receipts set clearance_status = 'cancelled', cancelled_at = now(), cancelled_by = current_employee_id(),
    cancel_reason = btrim(p_reason) where id = r.id;
  insert into payment_receipt_events (receipt_id, event, detail) values (r.id, 'cancelled', jsonb_build_object('reason', btrim(p_reason)));
end;
$$;

-- Move a receipt to another booking (money paid against the wrong booking).
create or replace function transfer_receipt(p_receipt_id uuid, p_to_booking_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r payment_receipts%rowtype;
  t bookings%rowtype;
begin
  select * into r from payment_receipts where id = p_receipt_id for update;
  if r.id is null or not is_branch_accounts(r.outlet_id) then raise exception 'Only Accounts of the branch can do this'; end if;
  select * into t from bookings where id = p_to_booking_id;
  if t.id is null or t.id = r.booking_id then raise exception 'Pick the other booking'; end if;
  if t.status = 'cancelled' then raise exception 'That booking is cancelled'; end if;
  if not is_branch_accounts(t.outlet_id) then raise exception 'That booking is at another branch'; end if;
  if r.clearance_status = 'cancelled' or r.mode = 'finance_disbursement' then raise exception 'This receipt cannot be moved'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  update payment_receipts set booking_id = t.id, transferred_from_booking_id = r.booking_id where id = r.id;
  insert into payment_receipt_events (receipt_id, event, detail)
  values (r.id, 'transferred', jsonb_build_object('from', r.booking_id, 'to', t.id, 'reason', btrim(p_reason)));
  perform pool_mark_booking_dirty(r.booking_id);
  perform pool_mark_booking_dirty(t.id);
end;
$$;

-- Public check of a printed receipt (the QR on it): number, date, amount and whether it stands.
create or replace function verify_receipt(p_receipt_no text)
returns table (receipt_no text, received_on date, amount numeric, status text)
language sql
stable
security definer
set search_path = public
as $$
  select r.receipt_no, r.received_on, r.amount,
         case r.clearance_status when 'cleared' then 'valid' when 'pending' then 'awaiting clearance'
                                 when 'bounced' then 'bounced' else 'cancelled' end
  from payment_receipts r where r.receipt_no = upper(btrim(p_receipt_no));
$$;

-- ===== Delivered: revert =====
create table delivery_reversals (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  reason text not null,
  snapshot jsonb not null,
  reverted_by uuid references employees(id) default current_employee_id(),
  reverted_at timestamptz not null default now()
);
create index idx_delivery_reversals_booking on delivery_reversals(booking_id);
create index idx_delivery_reversals_by on delivery_reversals(reverted_by);
alter table delivery_reversals enable row level security;
create policy delivery_reversals_select on delivery_reversals for select to authenticated using (can_access_booking(booking_id));

create or replace function revert_delivered(p_booking_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  d deliveries%rowtype;
  v_vehicle uuid;
  v_back text;
begin
  select * into b from bookings where id = p_booking_id for update;
  if b.id is null or not ops_can('gate_pass', 'edit', b.outlet_id) then raise exception 'Booking not found'; end if;
  if b.status <> 'delivered' then raise exception 'This booking is not delivered'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  select * into d from deliveries where booking_id = b.id;
  insert into delivery_reversals (booking_id, reason, snapshot) values (b.id, btrim(p_reason), coalesce(to_jsonb(d), '{}'));
  update deliveries set status = 'draft', delivered_at = null, delivered_by = null where booking_id = b.id;
  update bookings set status = 'ready_to_invoice' where id = b.id;
  update delivery_slots set status = 'booked' where booking_id = b.id and status = 'done'
    and id = (select id from delivery_slots where booking_id = b.id and status = 'done' order by slot_date desc limit 1);
  -- The car goes back to where it stood before it was moved to the Delivered yard.
  select a.vehicle_id into v_vehicle from allotments a where a.booking_id = b.id and a.released_at is null;
  if v_vehicle is not null then
    select m.from_location into v_back from vehicle_movements m where m.vehicle_id = v_vehicle and m.movement_type = 'delivered'
    order by m.moved_at desc limit 1;
    insert into vehicle_movements (vehicle_id, kind, movement_type, from_location, to_location, note, moved_by)
    values (v_vehicle, 'yard_move', 'relocate', 'Delivered', v_back, 'Delivery reverted: ' || btrim(p_reason), current_employee_id());
    update vehicles set location = v_back where id = v_vehicle;
  end if;
  insert into booking_events (booking_id, kind, note) values (b.id, 'status', 'Delivery reverted: ' || btrim(p_reason));
end;
$$;

-- ===== Gate pass: what is still due =====
create or replace function booking_due(p_booking_id uuid)
returns table (deal_amount numeric, do_amount numeric, other_cleared numeric, due numeric)
language sql
stable
security definer
set search_path = public
as $$
  select a.deal_amount,
         coalesce((select sum(r.amount) from payment_receipts r where r.booking_id = p_booking_id and r.mode = 'finance_disbursement' and r.clearance_status = 'cleared'), 0),
         coalesce((select sum(r.amount) from payment_receipts r where r.booking_id = p_booking_id and r.mode <> 'finance_disbursement' and r.clearance_status = 'cleared'), 0),
         a.outstanding
  from booking_account(p_booking_id) a
  where can_access_booking(p_booking_id);
$$;

-- ===== CTDMS order tracker =====
create or replace function ctdms_order_tracker(p_outlet_id uuid default null)
returns table (booking_id uuid, customer_name text, outlet text, consultant text, status text, booked_on date, lag_days int,
               missing text)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.customer_name, o.name, e.name, b.status, b.created_at::date,
         ((now() at time zone 'Asia/Kolkata')::date - b.created_at::date)::int,
         concat_ws(', ', case when b.ctdms_order_booking_no is null then 'order no.' end, case when b.ctdms_order_date is null then 'order date' end)
  from bookings b join outlets o on o.id = b.outlet_id left join employees e on e.id = b.employee_id
  where b.status in ('booked', 'allocated', 'ready_to_invoice') and not b.imported_from_ctdms
    and (b.ctdms_order_booking_no is null or b.ctdms_order_date is null)
    and ops_branch_ok(b.outlet_id) and has_right('ops_billing', 'view') and (p_outlet_id is null or b.outlet_id = p_outlet_id)
  order by b.created_at;
$$;

-- ===== Reversals: reopen billing, clear documents =====
alter table ops_stage_reversals drop constraint ops_stage_reversals_stage_check;
alter table ops_stage_reversals add constraint ops_stage_reversals_stage_check
  check (stage in ('accounts', 'accessories', 'scheme', 'scrap', 'pdi', 'gate_pass', 'billing'));
alter table ops_stage_reversals add column documents_to_clear text[] not null default '{}';

-- ===== Latest definitions, extended =====
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
    -- Phase 30: an approved insurance rework replaces the quoted premium; an accessories rework the docket's total.
    select coalesce(b.total_amount, 0)
             - case when b.revised_insurance_amount is not null
                    then coalesce((b.priced_snapshot->>'insurance_amount')::numeric, 0) - b.revised_insurance_amount else 0 end as vehicle,
           coalesce(b.revised_accessories_amount, (select accessories_total from welcome_dockets w where w.booking_id = b.id), 0) as accessories,
           coalesce((select sum(amount) from payment_receipts r where r.booking_id = b.id and r.clearance_status = 'cleared'), 0) as cleared,
           coalesce((select sum(amount) from payment_receipts r where r.booking_id = b.id and r.clearance_status = 'pending'), 0) as pending
    from bookings b where b.id = p_booking_id
  ) d;
$$;

create or replace function ops_mark_stage(p_booking_id uuid, p_stage text, p_status text, p_note text default null, p_ref_no text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null then raise exception 'Booking not found'; end if;
  if p_stage not in ('accounts', 'accessories', 'scheme', 'scrap') then
    raise exception 'This stage fills itself from its own screen';
  end if;
  if p_status not in ('done', 'na') then raise exception 'Status must be done or na'; end if;
  if not ops_can('ops_' || p_stage, 'edit', b.outlet_id) then
    raise exception 'You cannot update the % stage at this branch', p_stage;
  end if;
  if b.status in ('delivered', 'cancelled') then raise exception 'This booking is closed'; end if;
  if not exists (select 1 from billing_requests where booking_id = b.id and status in ('pending', 'invoiced')) then
    raise exception 'Send the car for billing first';
  end if;
  if p_stage = 'accounts' and nullif(btrim(p_note), '') is null then
    raise exception 'Say how the outstanding amount is covered (e.g. loan DO received)';
  end if;
  if exists (select 1 from booking_ops_stages where booking_id = b.id and stage = p_stage) then
    raise exception 'This stage is already marked; ask for it to be reopened';
  end if;
  -- Phase 30: the scheme claim needs a proof per scheme; scrap needs the COD number.
  if p_stage = 'scheme' and p_status = 'done' and exists (select 1 from scheme_claim_status(b.id) s where not s.has_proof) then
    raise exception 'Upload the claim proof for every scheme first';
  end if;
  if p_stage = 'scrap' and p_status = 'done' and not exists (select 1 from booking_scrap_details d where d.booking_id = b.id and d.cod_no is not null) then
    raise exception 'Record the scrap COD number first';
  end if;
  insert into booking_ops_stages (booking_id, stage, status, note, ref_no, done_by)
  values (b.id, p_stage, p_status, nullif(btrim(p_note), ''), nullif(btrim(p_ref_no), ''), current_employee_id());
end;
$$;

create or replace function decide_stage_reversal(p_reversal_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r ops_stage_reversals%rowtype;
  b bookings%rowtype;
begin
  select * into r from ops_stage_reversals where id = p_reversal_id for update;
  if r.id is null or r.status <> 'pending' then raise exception 'Request not found or already decided'; end if;
  select * into b from bookings where id = r.booking_id;
  if not ops_can('ops_billing', 'approve', b.outlet_id) then
    raise exception 'Only the Outlet Head can approve going back a stage';
  end if;
  if r.requested_by = current_employee_id() and not coalesce(current_employee_role_rank() <= 1, false) then
    raise exception 'Someone else must decide your own request';
  end if;
  update ops_stage_reversals set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = current_employee_id(), decided_at = now(), decision_note = nullif(btrim(p_note), '')
  where id = r.id;
  if not p_approve then return; end if;

  if r.stage in ('accounts', 'accessories', 'scheme', 'scrap') then
    delete from booking_ops_stages where booking_id = r.booking_id and stage = r.stage;
  elsif r.stage = 'pdi' then
    update pdi_inspections set status = 'failed', remarks = 'Reopened: ' || r.reason
    where booking_id = r.booking_id and status = 'passed';
    update deliveries set pdi_done = false where booking_id = r.booking_id and status = 'draft';
  end if;
  -- Phase 30: reopening billing cancels the invoice (the car is allotted again); named documents are cleared.
  if r.stage = 'billing' then
    if exists (select 1 from gate_passes where booking_id = r.booking_id and exited_at is not null) then
      raise exception 'The car has left the yard; the invoice cannot be reopened';
    end if;
    update vehicles set status = 'allotted' where id in (select vehicle_id from billing_requests where booking_id = r.booking_id and status = 'invoiced');
    update billing_requests set status = 'cancelled', cancel_reason = 'Billing reopened: ' || r.reason
    where booking_id = r.booking_id and status in ('pending', 'invoiced');
    update bookings set status = 'allocated' where id = r.booking_id and status = 'ready_to_invoice';
    delete from booking_ops_stages where booking_id = r.booking_id and stage = 'accounts';
  end if;
  if cardinality(r.documents_to_clear) > 0 then
    insert into booking_document_removals (booking_id, doc_type, storage_path, reason, removed_by)
    select d.booking_id, d.doc_type, d.storage_path, 'Cleared by stage reversal: ' || r.reason, current_employee_id()
    from booking_documents d where d.booking_id = r.booking_id and d.doc_type = any (r.documents_to_clear);
    delete from booking_documents where booking_id = r.booking_id and doc_type = any (r.documents_to_clear);
  end if;
  -- Any earlier stage going back cancels the gate pass too.
  update gate_passes set voided_at = now(), void_reason = 'Stage reopened (' || r.stage || '): ' || r.reason
  where booking_id = r.booking_id and voided_at is null and exited_at is null;
end;
$$;

-- Ask to reopen a stage, including billing, and name documents to clear with it.
create or replace function request_stage_reversal_v2(p_booking_id uuid, p_stage text, p_reason text, p_documents text[] default '{}')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_id uuid;
begin
  if p_stage = 'billing' then
    select * into b from bookings where id = p_booking_id;
    if b.id is null or not ops_can('ops_billing', 'view', b.outlet_id) then raise exception 'Booking not found'; end if;
    if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
    if not exists (select 1 from billing_requests where booking_id = b.id and status = 'invoiced') then
      raise exception 'There is no invoice to reopen';
    end if;
    if exists (select 1 from gate_passes where booking_id = b.id and exited_at is not null) then
      raise exception 'The car has left the yard; the invoice cannot be reopened';
    end if;
    begin
      insert into ops_stage_reversals (booking_id, stage, reason, requested_by, documents_to_clear)
      values (b.id, 'billing', btrim(p_reason), current_employee_id(), coalesce(p_documents, '{}'))
      returning id into v_id;
    exception when unique_violation then
      raise exception 'A request to reopen this stage is already waiting';
    end;
  else
    v_id := request_stage_reversal(p_booking_id, p_stage, p_reason);
    update ops_stage_reversals set documents_to_clear = coalesce(p_documents, '{}') where id = v_id;
  end if;
  return v_id;
end;
$$;

-- ===== Grants =====
do $$
declare f text;
begin
  foreach f in array array[
    'request_rework(uuid, text, text, numeric, text)', 'resolve_rework(uuid, boolean, text)', 'save_accessory_fitment(uuid, jsonb)',
    'scheme_claim_status(uuid)', 'save_scrap_details(uuid, jsonb)', 'rto_reconcile(jsonb)', 'inhouse_payout_expected(date)',
    'set_receipt_accounting_entry(uuid, boolean)', 'cancel_receipt(uuid, text)', 'transfer_receipt(uuid, uuid, text)',
    'revert_delivered(uuid, text)', 'set_rto_extras(uuid, text, text, numeric)', 'booking_due(uuid)', 'ctdms_order_tracker(uuid)', 'request_stage_reversal_v2(uuid, text, text, text[])'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke execute on function verify_receipt(text) from public;
grant execute on function verify_receipt(text) to anon, authenticated;
revoke execute on function rto_registrations_normalise() from public, anon, authenticated;
revoke execute on function payment_receipts_snapshot() from public, anon, authenticated;
revoke execute on function payment_receipts_created_event() from public, anon, authenticated;

-- ===== Menu: one screen per stage =====
update app_modules set path = '/ops-billing/accounts', in_menu = true, label = 'Ops Billing: Accounts' where key = 'ops_accounts';
update app_modules set path = '/ops-billing/insurance', in_menu = true, label = 'Ops Billing: Insurance' where key = 'ops_insurance';
update app_modules set path = '/ops-billing/rto', in_menu = true, label = 'Ops Billing: RTO' where key = 'ops_rto';
update app_modules set path = '/ops-billing/accessories', in_menu = true, label = 'Ops Billing: Accessories' where key = 'ops_accessories';
update app_modules set path = '/ops-billing/schemes', in_menu = true, label = 'Ops Billing: Schemes' where key = 'ops_scheme';
update app_modules set path = '/ops-billing/scrap', in_menu = true, label = 'Ops Billing: Scrap' where key = 'ops_scrap';
update app_modules set label = 'Ops Billing: Stage Status' where key = 'ops_billing';
update app_modules set label = 'Ops Billing: Gate Pass' where key = 'gate_pass';
insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('ops_crm_billing', 'ops', 'Ops Billing: CRM Billing',      '/ops-billing/crm-billing', 11, true),
  ('ops_receipts',    'ops', 'Ops Billing: Payment Receipts', '/ops-billing/receipts',    19, true);
select seed_role_rights('Outlet Head', 'ops_crm_billing', array['view', 'edit']);
select seed_role_rights('Outlet Head', 'ops_receipts', array['view']);
select seed_role_rights('Accounts', 'ops_crm_billing', array['view', 'edit']);
select seed_role_rights('Accounts', 'ops_receipts', array['view', 'edit']);
select seed_role_rights('Accounts', 'ops_accounts', array['view', 'edit']);
select seed_role_rights('Accounts', 'ops_billing', array['view']);
select seed_role_rights('Insurance Executive', 'ops_insurance', array['view', 'edit']);
select seed_role_rights('RTO Executive', 'ops_rto', array['view', 'edit']);
select seed_role_rights('Head Customer Relations', 'ops_crm_billing', array['view']);
