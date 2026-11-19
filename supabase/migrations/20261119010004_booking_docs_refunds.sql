-- Phase 26: Booking Docs, Cancelled Customers, Booking Refunds, Excess Refunds, Hold Customers —
-- Techwheels' logic on top of Rajesh Toyota's Welcome Docket, finance documents and refund engine.
--
-- Booking documents
--   - booking_documents: every other document a booking needs (KYC, RTO forms, invoice, insurance,
--     accessories bill, scheme proofs), each pending / approved / rejected. Staff uploads by someone
--     with Booking Docs: edit are approved at once (Techwheels' approve_staff_uploaded_document).
--   - Docket and finance documents still live in their own tables and count towards the groups.
--   - required_doc_groups(booking): Techwheels' rmDocumentGroups rules, re-keyed for Toyota:
--     PAN; address proof (any 2); GST for company purchases; exchange RC + insurance; finance
--     documents of the live case (own finance = DO only); BH registration set; scheme proofs
--     (corporate ID, loyalty RC, own scrappage certificate); RTO forms once invoiced.
--   - Removing a document keeps an audit row.
-- Cancelled customers
--   - Cancellations get a "done" stamp (CTDMS cancelled, refund handled) for the New / Done tabs.
--   - revive_booking(): back to booked or on hold, pending refunds voided, finance cases restored to
--     where they were; refused once any refund is paid.
-- Refunds
--   - The automatic financier / customer refunds stay. Added: customer bank details (account no.
--     6–20 digits, IFSC AAAA0XXXXXX, cancelled cheque) kept apart from the refund row and visible only
--     to Accounts and Refunds: view; payment by cheque, NEFT, RTGS, IMPS or UPI with its reference;
--     an amount correction with a reason, and "no refund" — both by the Outlet Head.
--   - excess_refunds: money received above the deal amount, several per booking.
-- Hold
--   - Remarks on a hold, appended with who and when; hold_list() shows free cars of the same
--     variant (same colour / other colours) next to each held booking.

-- ===== Booking documents =====
create table booking_document_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null,
  grp text not null check (grp in ('kyc', 'finance', 'rto', 'delivery', 'scheme', 'exchange', 'other')),
  sort_order int not null default 0,
  is_active boolean not null default true
);
insert into booking_document_types (code, label, grp, sort_order) values
  ('pan', 'PAN card', 'kyc', 10),
  ('aadhaar_front', 'Aadhaar (front)', 'kyc', 20),
  ('aadhaar_back', 'Aadhaar (back)', 'kyc', 21),
  ('driving_licence', 'Driving licence', 'kyc', 30),
  ('passport', 'Passport', 'kyc', 40),
  ('voter_id', 'Voter ID', 'kyc', 50),
  ('electricity_bill', 'Electricity bill', 'kyc', 60),
  ('rent_agreement', 'Rent agreement', 'kyc', 70),
  ('gst_certificate', 'GST certificate', 'kyc', 80),
  ('company_authority', 'Company authority letter / board resolution', 'kyc', 90),
  ('do_letter', 'Delivery order (DO)', 'finance', 100),
  ('form_20', 'Form 20', 'rto', 200),
  ('form_21', 'Form 21 (sale certificate)', 'rto', 210),
  ('form_22', 'Form 22 (roadworthiness)', 'rto', 220),
  ('cng_form', 'CNG fitment form', 'rto', 230),
  ('parking_affidavit', 'Parking affidavit', 'rto', 240),
  ('form_60', 'Form 60', 'rto', 250),
  ('second_address_proof', 'Second address proof', 'rto', 260),
  ('official_id_card', 'Official ID card (BH)', 'rto', 270),
  ('bh_employer_certificate', 'Employer certificate (BH)', 'rto', 280),
  ('rto_receipt', 'RTO receipt', 'rto', 290),
  ('invoice_pdf', 'Vehicle invoice', 'delivery', 300),
  ('insurance_pdf', 'Insurance policy', 'delivery', 310),
  ('accessories_bill', 'Accessories bill', 'delivery', 320),
  ('exchange_rc', 'Exchange car RC', 'exchange', 400),
  ('exchange_insurance', 'Exchange car insurance', 'exchange', 410),
  ('corporate_id', 'Corporate ID / employer letter', 'scheme', 500),
  ('loyalty_rc', 'RC of the Toyota already owned (loyalty)', 'scheme', 510),
  ('loyalty_relation_proof', 'Relationship proof (loyalty)', 'scheme', 520),
  ('scrappage_certificate', 'Scrappage certificate', 'scheme', 530),
  ('other', 'Other', 'other', 900);

create table booking_documents (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  doc_type text not null references booking_document_types(code),
  storage_path text not null,
  provided_by text not null default 'staff' check (provided_by in ('staff', 'customer')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  rejection_reason text,
  uploaded_by uuid references employees(id) default current_employee_id(),
  uploaded_at timestamptz not null default now(),
  reviewed_by uuid references employees(id),
  reviewed_at timestamptz,
  check (status <> 'rejected' or rejection_reason is not null)
);
create index idx_booking_documents_booking on booking_documents(booking_id, doc_type);
create index idx_booking_documents_type on booking_documents(doc_type);
create index idx_booking_documents_uploaded_by on booking_documents(uploaded_by);
create index idx_booking_documents_reviewed_by on booking_documents(reviewed_by);
create index idx_booking_documents_pending on booking_documents(status) where status = 'pending';

create table booking_document_removals (
  id bigserial primary key,
  booking_id uuid not null references bookings(id),
  doc_type text not null,
  storage_path text,
  reason text not null,
  removed_by uuid references employees(id),
  removed_at timestamptz not null default now()
);
create index idx_booking_doc_removals_booking on booking_document_removals(booking_id);
create index idx_booking_doc_removals_by on booking_document_removals(removed_by);

alter table booking_document_types enable row level security;
alter table booking_documents enable row level security;
alter table booking_document_removals enable row level security;
create policy booking_document_types_select on booking_document_types for select to authenticated using (true);
create policy booking_document_types_write on booking_document_types for all to authenticated
  using (is_master_data_admin()) with check (is_master_data_admin());
create policy booking_documents_select on booking_documents for select to authenticated using (can_access_booking(booking_id));
create policy booking_doc_removals_select on booking_document_removals for select to authenticated using (can_access_booking(booking_id));
-- Writes go through the RPCs below.

-- Does the booking have this document, from any source (booking documents, the Welcome Docket,
-- the finance file)? Approved booking documents only.
create or replace function booking_has_doc(p_booking_id uuid, p_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from booking_documents where booking_id = p_booking_id and doc_type = p_code and status = 'approved')
      or exists (
        select 1 from docket_documents dd join welcome_dockets w on w.id = dd.docket_id
        where w.booking_id = p_booking_id and dd.doc_type = case p_code
          when 'pan' then 'pan_or_voter_id'
          when 'voter_id' then 'pan_or_voter_id'
          when 'aadhaar_front' then 'aadhaar'
          when 'aadhaar_back' then 'aadhaar'
          when 'passport' then 'passport_or_driving_licence'
          when 'driving_licence' then 'passport_or_driving_licence'
          when 'electricity_bill' then 'telephone_bill'
          else '-' end)
      or (p_code = 'insurance_pdf' and exists (select 1 from insurance_policies where booking_id = p_booking_id and policy_storage_path is not null));
$$;

-- The document groups a booking needs and how far along each is (Techwheels' requiredDocGroups).
create or replace function required_doc_groups(p_booking_id uuid)
returns table (grp text, label text, needed int, have int, complete boolean, doc_types text[], missing text[])
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  b bookings%rowtype;
  v_case finance_cases%rowtype;
  v_exchange boolean;
  v_invoiced boolean;
  v_is_cng boolean;
  v_cats text[];
  v_scrap_self boolean;
  v_missing text[];
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not can_access_booking(b.id) then
    raise exception 'Booking not found';
  end if;
  select * into v_case from finance_cases where booking_id = b.id and status <> 'rejected' order by created_at desc limit 1;
  v_exchange := coalesce((select exchange_interest from quotes where id = b.quote_id), false)
                or exists (select 1 from used_car_evaluations e where e.booking_id = b.id and e.status not in ('cancelled', 'rejected'));
  v_invoiced := exists (select 1 from billing_requests where booking_id = b.id and status = 'invoiced');
  v_is_cng := exists (select 1 from variants v join fuel_types f on f.id = v.fuel_type_id where v.id = b.variant_id and f.name ilike '%cng%');
  select coalesce(array_agg(distinct sm.category), '{}') into v_cats
  from scheme_line_items sli join scheme_master sm on sm.code = sli.scheme_master_code
  where sli.id = any (b.selected_scheme_line_item_ids);
  v_scrap_self := exists (select 1 from scrap_certificates s where s.id = b.scrap_certificate_id and s.source = 'Self');

  return query
  with g(grp, label, mode, types) as (
    values
      ('pan', 'PAN', 'all', array['pan']),
      ('address', 'Address proof (any 2)', 'any2', array['aadhaar_front', 'driving_licence', 'passport', 'voter_id', 'electricity_bill', 'rent_agreement']),
      ('gst', 'GST certificate and authority', case when b.is_company_purchase then 'all' end, array['gst_certificate', 'company_authority']),
      ('exchange', 'Exchange car RC and insurance', case when v_exchange or 'exchange' = any (v_cats) then 'all' end, array['exchange_rc', 'exchange_insurance']),
      ('finance_do', 'Delivery order', case when v_case.id is not null and v_case.finance_type = 'own' then 'all' end, array['do_letter']),
      ('bh', 'BH registration set', case when upper(coalesce(b.pricing_extras->>'rto_type', '')) = 'BH' then 'all' end,
        array['official_id_card', 'bh_employer_certificate', 'second_address_proof']),
      ('corporate', 'Corporate proof', case when 'corporate' = any (v_cats) then 'all' end, array['corporate_id']),
      ('loyalty', 'Loyalty proof', case when 'loyalty' = any (v_cats) then 'all' end, array['loyalty_rc']),
      ('scrappage', 'Scrappage certificate', case when v_scrap_self or 'scrappage' = any (v_cats) then 'all' end, array['scrappage_certificate']),
      ('rto', 'RTO forms', case when v_invoiced then 'all' end,
        case when v_is_cng then array['form_20', 'form_21', 'form_22', 'cng_form'] else array['form_20', 'form_21', 'form_22'] end),
      ('delivery', 'Invoice and insurance', case when v_invoiced then 'all' end, array['invoice_pdf', 'insurance_pdf'])
  ),
  scored as (
    select g.grp, g.label, g.mode, g.types,
           (select count(*)::int from unnest(g.types) t where booking_has_doc(b.id, t)) as have,
           (select coalesce(array_agg(t), '{}') from unnest(g.types) t where not booking_has_doc(b.id, t)) as missing
    from g where g.mode is not null
  )
  select s.grp, s.label,
         case s.mode when 'any2' then 2 else cardinality(s.types) end,
         s.have,
         s.have >= case s.mode when 'any2' then 2 else cardinality(s.types) end,
         s.types,
         case when s.have >= case s.mode when 'any2' then 2 else cardinality(s.types) end then '{}'::text[] else s.missing end
  from scored s;

  -- The live in-house finance case's own checklist (Phase 9).
  if v_case.id is not null and v_case.finance_type = 'in_house' then
    v_missing := coalesce(finance_missing_documents(v_case.id), '{}');
    grp := 'finance'; label := 'Finance documents'; needed := null; have := null;
    complete := cardinality(v_missing) = 0; doc_types := '{}'; missing := v_missing;
    return next;
  end if;
end;
$$;

-- Upload (record) a document already put in the booking-documents bucket under <booking_id>/.
create or replace function add_booking_document(p_booking_id uuid, p_doc_type text, p_storage_path text, p_provided_by text default 'staff')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_auto boolean;
begin
  if not can_access_booking(p_booking_id) then
    raise exception 'Booking not found';
  end if;
  if storage_booking_id(p_storage_path) is distinct from p_booking_id then
    raise exception 'The file must be stored under this booking';
  end if;
  if not exists (select 1 from booking_document_types where code = p_doc_type and is_active) then
    raise exception 'Unknown document type %', p_doc_type;
  end if;
  v_auto := coalesce(p_provided_by, 'staff') = 'staff' and has_right('booking_docs', 'edit');
  insert into booking_documents (booking_id, doc_type, storage_path, provided_by, status, reviewed_by, reviewed_at)
  values (p_booking_id, p_doc_type, p_storage_path, coalesce(p_provided_by, 'staff'),
          case when v_auto then 'approved' else 'pending' end,
          case when v_auto then current_employee_id() end, case when v_auto then now() end)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function review_booking_document(p_document_id uuid, p_approve boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  d booking_documents%rowtype;
begin
  select * into d from booking_documents where id = p_document_id for update;
  if d.id is null or not can_access_booking(d.booking_id) then
    raise exception 'Document not found';
  end if;
  if not has_right('booking_docs', 'approve') then
    raise exception 'You need Booking Docs: approve to review documents';
  end if;
  if not p_approve and nullif(btrim(p_reason), '') is null then
    raise exception 'Give the reason for rejecting the document';
  end if;
  update booking_documents set status = case when p_approve then 'approved' else 'rejected' end,
    rejection_reason = case when p_approve then null else btrim(p_reason) end,
    reviewed_by = current_employee_id(), reviewed_at = now()
  where id = d.id;
end;
$$;

create or replace function remove_booking_document(p_document_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  d booking_documents%rowtype;
begin
  select * into d from booking_documents where id = p_document_id for update;
  if d.id is null or not can_access_booking(d.booking_id) then
    raise exception 'Document not found';
  end if;
  if not (has_right('booking_docs', 'edit') or has_right('booking_docs', 'delete')) then
    raise exception 'You need Booking Docs: edit or delete to remove documents';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give the reason for removing the document';
  end if;
  insert into booking_document_removals (booking_id, doc_type, storage_path, reason, removed_by)
  values (d.booking_id, d.doc_type, d.storage_path, btrim(p_reason), current_employee_id());
  delete from booking_documents where id = d.id;
  return d.storage_path;  -- the caller deletes the file from storage
end;
$$;

-- The Booking Docs desk: open bookings with how many groups are complete.
create or replace function booking_docs_board(p_search text default null, p_only_pending boolean default false)
returns table (booking_id uuid, customer_name text, customer_mobile text, ctdms_order_no text, outlet text, consultant text,
               status text, groups int, complete int, pending_review int)
language sql
stable
security invoker
set search_path = public
as $$
  select b.id, b.customer_name, b.customer_mobile, b.ctdms_order_booking_no, o.name, e.name, b.status,
         (select count(*)::int from required_doc_groups(b.id)),
         (select count(*)::int from required_doc_groups(b.id) g where g.complete),
         (select count(*)::int from booking_documents d where d.booking_id = b.id and d.status = 'pending')
  from bookings b join outlets o on o.id = b.outlet_id join employees e on e.id = b.employee_id
  where b.status not in ('cancelled', 'delivered')
    and (p_search is null or p_search = '' or b.customer_name ilike '%' || p_search || '%'
         or coalesce(b.customer_mobile, '') like '%' || p_search || '%' or coalesce(b.ctdms_order_booking_no, '') ilike '%' || p_search || '%')
    and (not p_only_pending or exists (select 1 from booking_documents d where d.booking_id = b.id and d.status = 'pending'))
  order by b.created_at desc
  limit 300;
$$;

-- ===== Cancelled customers =====
alter table booking_cancellations
  add column finance_snapshot jsonb,
  add column done_at timestamptz,
  add column done_by uuid references employees(id),
  add column done_note text,
  add column revived_at timestamptz,
  add column revived_by uuid references employees(id),
  add column revive_reason text;
create index idx_booking_cancellations_done_by on booking_cancellations(done_by);
create index idx_booking_cancellations_revived_by on booking_cancellations(revived_by);

alter table refunds drop constraint refunds_status_check;
alter table refunds add constraint refunds_status_check check (status in ('pending', 'paid', 'void', 'waived'));
alter table refunds
  add column payment_mode text check (payment_mode in ('cheque', 'neft', 'rtgs', 'imps', 'upi')),
  add column payment_reference text,
  add column original_amount numeric,
  add column adjust_reason text,
  add column adjusted_by uuid references employees(id),
  add column waive_reason text;
create index idx_refunds_adjusted_by on refunds(adjusted_by);

-- decide_cancellation as in 20261101000001, now remembering where the finance cases were so a
-- revived booking gets them back.
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
  update booking_cancellations set finance_snapshot = (
    select jsonb_agg(jsonb_build_object('id', id, 'status', status)) from finance_cases
    where booking_id = b.id and status not in ('disbursed', 'rejected'))
  where id = c.id;
  update finance_cases set status = 'rejected', rejection_reason = 'Booking cancelled'
  where booking_id = b.id and status not in ('disbursed', 'rejected');

  update booking_cancellations set status = 'approved', decided_by = current_employee_id(), decided_at = now(),
    decision_note = nullif(btrim(p_note), '') where id = c.id;
  update bookings set status = 'cancelled' where id = b.id;
  insert into booking_events (booking_id, kind, note) values (b.id, 'cancel_approved', nullif(btrim(p_note), ''));

  -- Money received from a financier goes back to that financier; the rest to the customer.
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

create or replace function can_decide_for_outlet(p_outlet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_employee_role_rank() <= 1, false)
      or (coalesce(current_employee_role_rank() = 2, false) and current_employee_outlet_id() = p_outlet_id);
$$;

create or replace function mark_cancellation_done(p_cancellation_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c booking_cancellations%rowtype;
begin
  select * into c from booking_cancellations where id = p_cancellation_id for update;
  if c.id is null or not can_access_booking(c.booking_id) then
    raise exception 'Cancellation not found';
  end if;
  if not has_right('cancelled_customers', 'edit') then
    raise exception 'You need Cancelled Customers: edit';
  end if;
  if c.status <> 'approved' or c.revived_at is not null then
    raise exception 'Only an approved cancellation can be marked done';
  end if;
  update booking_cancellations set done_at = coalesce(done_at, now()), done_by = current_employee_id(), done_note = nullif(btrim(p_note), '')
  where id = c.id;
end;
$$;

-- Bring a cancelled booking back (Techwheels' revive_cancelled_booking_v1), to booked or on hold.
create or replace function revive_booking(p_booking_id uuid, p_reason text, p_target text default 'active')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  c booking_cancellations%rowtype;
  f jsonb;
begin
  select * into b from bookings where id = p_booking_id for update;
  if b.id is null or not can_access_booking(b.id) then
    raise exception 'Booking not found';
  end if;
  if not (can_decide_for_outlet(b.outlet_id) or has_right('cancelled_customers', 'approve')) then
    raise exception 'Only the branch''s Outlet Head can revive a booking';
  end if;
  if b.status <> 'cancelled' then
    raise exception 'This booking is not cancelled';
  end if;
  if p_target not in ('active', 'hold') then
    raise exception 'Revive to active or hold';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give the reason for reviving the booking';
  end if;
  if exists (select 1 from refunds where booking_id = b.id and status = 'paid') then
    raise exception 'A refund has been paid on this booking; take a new booking instead';
  end if;
  select * into c from booking_cancellations where booking_id = b.id and status = 'approved' and revived_at is null
  order by decided_at desc limit 1;

  update refunds set status = 'void' where booking_id = b.id and status = 'pending';
  update bookings set status = 'booked' where id = b.id;
  if c.id is not null then
    update booking_cancellations set revived_at = now(), revived_by = current_employee_id(), revive_reason = btrim(p_reason)
    where id = c.id;
    -- Finance cases go back where they were, unless another case has been opened since.
    for f in select * from jsonb_array_elements(coalesce(c.finance_snapshot, '[]')) loop
      if not exists (select 1 from finance_cases where booking_id = b.id and status <> 'rejected') then
        update finance_cases set status = f->>'status', rejection_reason = null
        where id = (f->>'id')::uuid and status = 'rejected' and rejection_reason = 'Booking cancelled';
      end if;
    end loop;
  end if;
  if p_target = 'hold' then
    insert into booking_holds (booking_id, reason, held_by) values (b.id, 'Revived on hold: ' || btrim(p_reason), current_employee_id());
  end if;
  insert into booking_events (booking_id, kind, note) values (b.id, 'status', 'Revived (' || p_target || '): ' || btrim(p_reason));
end;
$$;

-- ===== Refund bank details and payment =====
create table refund_bank_details (
  refund_id uuid primary key references refunds(id) on delete cascade,
  account_holder text not null,
  account_number text not null check (account_number ~ '^[0-9]{6,20}$'),
  ifsc text not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_name text,
  cancelled_cheque_path text not null,
  updated_by uuid references employees(id),
  updated_at timestamptz not null default now()
);
create index idx_refund_bank_details_by on refund_bank_details(updated_by);
alter table refund_bank_details enable row level security;
create policy refund_bank_details_select on refund_bank_details for select to authenticated using (
  exists (select 1 from refunds r where r.id = refund_id and (is_branch_accounts(r.outlet_id) or has_right('refunds', 'view')))
);

create or replace function set_refund_bank_details(p_refund_id uuid, p_holder text, p_account text, p_ifsc text, p_bank text, p_cheque_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r refunds%rowtype;
begin
  select * into r from refunds where id = p_refund_id;
  if r.id is null or not can_access_booking(r.booking_id) then
    raise exception 'Refund not found';
  end if;
  if r.payee <> 'customer' then
    raise exception 'Bank details are needed only for refunds to the customer';
  end if;
  if r.status <> 'pending' then
    raise exception 'This refund is %', r.status;
  end if;
  if regexp_replace(coalesce(p_account, ''), '\s', '', 'g') !~ '^[0-9]{6,20}$' then
    raise exception 'The account number must be 6 to 20 digits';
  end if;
  if upper(btrim(coalesce(p_ifsc, ''))) !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
    raise exception 'The IFSC must look like ABCD0123456';
  end if;
  if nullif(btrim(p_holder), '') is null or nullif(btrim(p_cheque_path), '') is null then
    raise exception 'Enter the account holder and attach the cancelled cheque';
  end if;
  if storage_booking_id(p_cheque_path) is distinct from r.booking_id then
    raise exception 'The cancelled cheque must be stored under this booking';
  end if;
  insert into refund_bank_details (refund_id, account_holder, account_number, ifsc, bank_name, cancelled_cheque_path, updated_by)
  values (r.id, btrim(p_holder), regexp_replace(p_account, '\s', '', 'g'), upper(btrim(p_ifsc)), nullif(btrim(p_bank), ''), p_cheque_path, current_employee_id())
  on conflict (refund_id) do update set account_holder = excluded.account_holder, account_number = excluded.account_number,
    ifsc = excluded.ifsc, bank_name = excluded.bank_name, cancelled_cheque_path = excluded.cancelled_cheque_path,
    updated_by = excluded.updated_by, updated_at = now();
end;
$$;

-- Pay a refund by cheque or bank transfer. A transfer to the customer needs their bank details.
create or replace function pay_refund(p_refund_id uuid, p_mode text, p_reference text, p_paid_on date, p_bank_name text default null)
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
  if r.status <> 'pending' then
    raise exception 'This refund is %', r.status;
  end if;
  if p_mode not in ('cheque', 'neft', 'rtgs', 'imps', 'upi') then
    raise exception 'Pay by cheque, NEFT, RTGS, IMPS or UPI';
  end if;
  if nullif(btrim(p_reference), '') is null or p_paid_on is null then
    raise exception 'Enter the % and the date', case when p_mode = 'cheque' then 'cheque number' else 'UTR / reference' end;
  end if;
  if p_paid_on > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'The refund date cannot be in the future';
  end if;
  if p_mode <> 'cheque' and r.payee = 'customer' and not exists (select 1 from refund_bank_details where refund_id = r.id) then
    raise exception 'Record the customer''s bank details and cancelled cheque first';
  end if;
  update refunds set status = 'paid', payment_mode = p_mode, payment_reference = btrim(p_reference),
    cheque_no = case when p_mode = 'cheque' then btrim(p_reference) end, paid_on = p_paid_on,
    bank_name = nullif(btrim(p_bank_name), ''), paid_by = current_employee_id()
  where id = r.id;
end;
$$;

-- Correct the amount (with a reason) or decide that no refund is paid — the Outlet Head's call.
create or replace function adjust_refund(p_refund_id uuid, p_amount numeric, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r refunds%rowtype;
begin
  select * into r from refunds where id = p_refund_id for update;
  if r.id is null or not can_decide_for_outlet(r.outlet_id) then
    raise exception 'Only the branch''s Outlet Head can change a refund';
  end if;
  if r.status <> 'pending' then
    raise exception 'This refund is %', r.status;
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give the reason';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'Enter the amount to refund (0 for no refund)';
  end if;
  if p_amount = 0 then
    update refunds set status = 'waived', waive_reason = btrim(p_reason), adjusted_by = current_employee_id() where id = r.id;
  else
    update refunds set original_amount = coalesce(original_amount, amount), amount = p_amount, adjust_reason = btrim(p_reason),
      adjusted_by = current_employee_id() where id = r.id;
  end if;
end;
$$;

-- ===== Excess refunds =====
create table excess_refunds (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  outlet_id uuid not null references outlets(id),
  amount numeric not null check (amount > 0),
  reason text not null,
  account_holder text not null,
  account_number text not null check (account_number ~ '^[0-9]{6,20}$'),
  ifsc text not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_name text,
  cancelled_cheque_path text not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'void')),
  payment_mode text check (payment_mode in ('cheque', 'neft', 'rtgs', 'imps', 'upi')),
  payment_reference text,
  paid_on date,
  paid_by uuid references employees(id),
  requested_by uuid references employees(id),
  requested_at timestamptz not null default now()
);
create index idx_excess_refunds_booking on excess_refunds(booking_id);
create index idx_excess_refunds_outlet on excess_refunds(outlet_id) where status = 'pending';
create index idx_excess_refunds_paid_by on excess_refunds(paid_by);
create index idx_excess_refunds_requested_by on excess_refunds(requested_by);
alter table excess_refunds enable row level security;
create policy excess_refunds_select on excess_refunds for select to authenticated using (
  can_access_booking(booking_id) and (is_branch_accounts(outlet_id) or has_right('refunds', 'view') or requested_by = current_employee_id())
);

-- Money received above the deal amount goes back to the customer. Several requests per booking are
-- fine, but together they cannot exceed what was overpaid.
create or replace function request_excess_refund(p_booking_id uuid, p_amount numeric, p_reason text, p_holder text,
                                                 p_account text, p_ifsc text, p_bank text, p_cheque_path text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_excess numeric;
  v_open numeric;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not can_access_booking(b.id) then
    raise exception 'Booking not found';
  end if;
  if b.status = 'cancelled' then
    raise exception 'This booking is cancelled; its refund is raised with the cancellation';
  end if;
  select -outstanding into v_excess from booking_account(b.id);
  select coalesce(sum(amount), 0) into v_open from excess_refunds where booking_id = b.id and status <> 'void';
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'Enter the amount';
  end if;
  if p_amount > coalesce(v_excess, 0) - v_open then
    raise exception 'Only ₹% has been received above the deal amount (₹% already requested)', round(greatest(coalesce(v_excess, 0), 0)), round(v_open);
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give the reason';
  end if;
  if regexp_replace(coalesce(p_account, ''), '\s', '', 'g') !~ '^[0-9]{6,20}$' then
    raise exception 'The account number must be 6 to 20 digits';
  end if;
  if upper(btrim(coalesce(p_ifsc, ''))) !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
    raise exception 'The IFSC must look like ABCD0123456';
  end if;
  if storage_booking_id(p_cheque_path) is distinct from b.id then
    raise exception 'Attach the cancelled cheque under this booking';
  end if;
  insert into excess_refunds (booking_id, outlet_id, amount, reason, account_holder, account_number, ifsc, bank_name, cancelled_cheque_path, requested_by)
  values (b.id, b.outlet_id, p_amount, btrim(p_reason), btrim(p_holder), regexp_replace(p_account, '\s', '', 'g'), upper(btrim(p_ifsc)),
          nullif(btrim(p_bank), ''), p_cheque_path, current_employee_id())
  returning id into v_id;
  insert into booking_events (booking_id, kind, note) values (b.id, 'status', 'Excess refund requested: ₹' || p_amount);
  return v_id;
end;
$$;

create or replace function pay_excess_refund(p_id uuid, p_mode text, p_reference text, p_paid_on date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  x excess_refunds%rowtype;
begin
  select * into x from excess_refunds where id = p_id for update;
  if x.id is null or not is_branch_accounts(x.outlet_id) then
    raise exception 'Only Accounts of the branch can record refunds';
  end if;
  if x.status <> 'pending' then
    raise exception 'This refund is %', x.status;
  end if;
  if p_mode not in ('cheque', 'neft', 'rtgs', 'imps', 'upi') or nullif(btrim(p_reference), '') is null or p_paid_on is null then
    raise exception 'Enter how it was paid, the reference and the date';
  end if;
  if p_paid_on > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'The refund date cannot be in the future';
  end if;
  update excess_refunds set status = 'paid', payment_mode = p_mode, payment_reference = btrim(p_reference), paid_on = p_paid_on,
    paid_by = current_employee_id() where id = x.id;
end;
$$;

create or replace function void_excess_refund(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  x excess_refunds%rowtype;
begin
  select * into x from excess_refunds where id = p_id for update;
  if x.id is null or not (can_decide_for_outlet(x.outlet_id) or is_branch_accounts(x.outlet_id)) then
    raise exception 'Refund not found';
  end if;
  if x.status <> 'pending' then
    raise exception 'This refund is %', x.status;
  end if;
  update excess_refunds set status = 'void', reason = reason || ' — void: ' || coalesce(nullif(btrim(p_reason), ''), 'no reason') where id = x.id;
end;
$$;

-- ===== Hold remarks and the hold list =====
create table booking_hold_remarks (
  id bigserial primary key,
  hold_id uuid not null references booking_holds(id) on delete cascade,
  remark text not null,
  added_by uuid references employees(id),
  added_at timestamptz not null default now()
);
create index idx_booking_hold_remarks_hold on booking_hold_remarks(hold_id);
create index idx_booking_hold_remarks_by on booking_hold_remarks(added_by);
alter table booking_hold_remarks enable row level security;
create policy booking_hold_remarks_select on booking_hold_remarks for select to authenticated
  using (exists (select 1 from booking_holds h where h.id = hold_id and can_access_booking(h.booking_id)));

create or replace function add_hold_remark(p_booking_id uuid, p_remark text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold uuid;
begin
  if not can_access_booking(p_booking_id) then
    raise exception 'Booking not found';
  end if;
  select id into v_hold from booking_holds where booking_id = p_booking_id and resumed_at is null;
  if v_hold is null then
    raise exception 'This booking is not on hold';
  end if;
  if nullif(btrim(p_remark), '') is null then
    raise exception 'Write the remark';
  end if;
  insert into booking_hold_remarks (hold_id, remark, added_by) values (v_hold, btrim(p_remark), current_employee_id());
end;
$$;

create or replace function hold_list()
returns table (booking_id uuid, customer_name text, customer_mobile text, ctdms_order_no text, outlet text, consultant text,
               car text, colour text, reason text, held_at timestamptz, expected_resume_date date, held_by text,
               last_remark text, last_remark_at timestamptz, free_same_colour int, free_other_colours int)
language sql
stable
security invoker
set search_path = public
as $$
  select b.id, b.customer_name, b.customer_mobile, b.ctdms_order_booking_no, o.name, e.name,
         trim(coalesce(m.name, '') || ' ' || v.name), c.name, h.reason, h.held_at, h.expected_resume_date, hb.name,
         r.remark, r.added_at,
         (select count(*)::int from vehicles x where x.variant_id = b.variant_id and x.color_id = b.color_id and x.status = 'available'
            and not exists (select 1 from stock_controls sc where sc.vehicle_id = x.id and sc.cleared_at is null)),
         (select count(*)::int from vehicles x where x.variant_id = b.variant_id and x.color_id <> b.color_id and x.status = 'available'
            and not exists (select 1 from stock_controls sc where sc.vehicle_id = x.id and sc.cleared_at is null))
  from booking_holds h
  join bookings b on b.id = h.booking_id
  join outlets o on o.id = b.outlet_id
  join employees e on e.id = b.employee_id
  join variants v on v.id = b.variant_id
  left join models m on m.id = v.model_id
  join colors c on c.id = b.color_id
  left join employees hb on hb.id = h.held_by
  left join lateral (select remark, added_at from booking_hold_remarks where hold_id = h.id order by added_at desc limit 1) r on true
  where h.resumed_at is null
  order by h.held_at;
$$;

-- ===== Grants =====
revoke execute on function booking_has_doc(uuid, text) from public, anon;
revoke execute on function required_doc_groups(uuid) from public, anon;
revoke execute on function add_booking_document(uuid, text, text, text) from public, anon;
revoke execute on function review_booking_document(uuid, boolean, text) from public, anon;
revoke execute on function remove_booking_document(uuid, text) from public, anon;
revoke execute on function booking_docs_board(text, boolean) from public, anon;
revoke execute on function can_decide_for_outlet(uuid) from public, anon;
revoke execute on function mark_cancellation_done(uuid, text) from public, anon;
revoke execute on function revive_booking(uuid, text, text) from public, anon;
revoke execute on function set_refund_bank_details(uuid, text, text, text, text, text) from public, anon;
revoke execute on function pay_refund(uuid, text, text, date, text) from public, anon;
revoke execute on function adjust_refund(uuid, numeric, text) from public, anon;
revoke execute on function request_excess_refund(uuid, numeric, text, text, text, text, text, text) from public, anon;
revoke execute on function pay_excess_refund(uuid, text, text, date) from public, anon;
revoke execute on function void_excess_refund(uuid, text) from public, anon;
revoke execute on function add_hold_remark(uuid, text) from public, anon;
revoke execute on function hold_list() from public, anon;
grant execute on function booking_has_doc(uuid, text) to authenticated;
grant execute on function required_doc_groups(uuid) to authenticated;
grant execute on function add_booking_document(uuid, text, text, text) to authenticated;
grant execute on function review_booking_document(uuid, boolean, text) to authenticated;
grant execute on function remove_booking_document(uuid, text) to authenticated;
grant execute on function booking_docs_board(text, boolean) to authenticated;
grant execute on function can_decide_for_outlet(uuid) to authenticated;
grant execute on function mark_cancellation_done(uuid, text) to authenticated;
grant execute on function revive_booking(uuid, text, text) to authenticated;
grant execute on function set_refund_bank_details(uuid, text, text, text, text, text) to authenticated;
grant execute on function pay_refund(uuid, text, text, date, text) to authenticated;
grant execute on function adjust_refund(uuid, numeric, text) to authenticated;
grant execute on function request_excess_refund(uuid, numeric, text, text, text, text, text, text) to authenticated;
grant execute on function pay_excess_refund(uuid, text, text, date) to authenticated;
grant execute on function void_excess_refund(uuid, text) to authenticated;
grant execute on function add_hold_remark(uuid, text) to authenticated;
grant execute on function hold_list() to authenticated;

-- ===== Menu =====
insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('booking_docs',        'stock', 'Booking Docs',        '/booking-docs',        85, true),
  ('cancelled_customers', 'stock', 'Cancelled Customers', '/cancelled-customers', 92, true),
  ('refunds',             'stock', 'Booking Refunds',     '/refunds',             94, true),
  ('hold_customers',      'stock', 'Hold Customers',      '/hold-customers',      96, true);
select seed_role_rights('Outlet Head', 'booking_docs', array['view', 'create', 'edit', 'approve', 'delete']);
select seed_role_rights('Head Customer Relations', 'booking_docs', array['view', 'create', 'edit', 'approve']);
select seed_role_rights('Relationship Manager', 'booking_docs', array['view', 'create', 'edit']);
select seed_role_rights('Team Leader', 'booking_docs', array['view', 'create']);
select seed_role_rights('Sales Consultant', 'booking_docs', array['view', 'create']);
select seed_role_rights('Finance Executive', 'booking_docs', array['view', 'create']);
select seed_role_rights('RTO Executive', 'booking_docs', array['view', 'create', 'edit']);
select seed_role_rights('Insurance Executive', 'booking_docs', array['view', 'create', 'edit']);
select seed_role_rights('Accounts', 'booking_docs', array['view']);
select seed_role_rights('Outlet Head', 'cancelled_customers', array['view', 'edit', 'approve']);
select seed_role_rights('Head Customer Relations', 'cancelled_customers', array['view', 'edit']);
select seed_role_rights('Accounts', 'cancelled_customers', array['view', 'edit']);
select seed_role_rights('Outlet Head', 'refunds', array['view', 'approve']);
select seed_role_rights('Accounts', 'refunds', array['view', 'edit']);
select seed_role_rights('Outlet Head', 'hold_customers', array['view', 'edit', 'approve']);
select seed_role_rights('Head Customer Relations', 'hold_customers', array['view', 'edit']);
select seed_role_rights('Team Leader', 'hold_customers', array['view']);
