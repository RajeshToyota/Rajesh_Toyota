-- Phase 9: digital Welcome Docket, one per booking. It captures the parts of the paper docket the
-- booking itself doesn't hold:
--   - contact details from the Order Booking Form (p.7)
--   - Registration & Delivery Details (p.25)
--   - the Accessories Order Form (p.13)
--   - the Checklist of Documents (p.21), with photos in the booking-documents bucket
--   - the RTO process acknowledgement (p.24), product interest and the Referral Form (p.38)
--   - customer and Sales Consultant signatures
-- The docket becomes `complete` only through complete_welcome_docket(), which checks every mandatory
-- item; a complete docket is read-only (except its PDF path) until an Outlet Head reopens it.

-- ===== Customer on the booking =====
-- A booking now carries its customer's name and mobile: a booking made from a quote copies them (and
-- the enquiry's customer) from the quote; a direct booking sends them.
alter table bookings add column customer_mobile text;

create or replace function bookings_from_final_quote()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  q quotes%rowtype;
begin
  if NEW.imported_from_ctdms then
    return NEW;
  end if;

  if TG_OP = 'UPDATE' then
    if NEW.dealer_discount is distinct from OLD.dealer_discount
       or NEW.selected_scheme_line_item_ids is distinct from OLD.selected_scheme_line_item_ids then
      raise exception 'A booking''s schemes and dealer discount come from its quote and cannot be changed';
    end if;
    return NEW;
  end if;

  if NEW.quote_id is null then
    NEW.dealer_discount := 0;
    return NEW;
  end if;

  select * into q from quotes where id = NEW.quote_id;
  if q.id is null then
    raise exception 'Quote not found';
  end if;
  if q.current_stage <> 'final' then
    raise exception 'Finalise the quote before booking it';
  end if;

  NEW.variant_id := q.variant_id;
  NEW.color_id := q.color_id;
  NEW.rto_category_id := q.rto_category_id;
  NEW.price_list_type := q.price_list_type;
  NEW.insurance_option := q.insurance_option;
  NEW.include_extended_warranty := q.include_extended_warranty;
  NEW.insurance_plan_id := q.insurance_plan_id;
  NEW.insurance_addon_ids := q.insurance_addon_ids;
  NEW.accessory_ids := q.accessory_ids;
  NEW.vas_product_ids := q.vas_product_ids;
  NEW.selected_scheme_line_item_ids := q.selected_scheme_line_item_ids;
  NEW.dealer_discount := q.dealer_discount;
  NEW.customer_name := coalesce(nullif(btrim(NEW.customer_name), ''), q.customer_name);
  NEW.customer_mobile := coalesce(nullif(btrim(NEW.customer_mobile), ''), q.customer_mobile, q.customer_phone);
  NEW.enquiry_id := coalesce(NEW.enquiry_id, q.enquiry_id);
  if NEW.customer_id is null and NEW.enquiry_id is not null then
    select customer_id into NEW.customer_id from enquiries where id = NEW.enquiry_id;
  end if;
  return NEW;
end;
$$;
revoke execute on function bookings_from_final_quote() from public, anon, authenticated;

-- ===== Welcome dockets =====
create table welcome_dockets (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'complete')),

  -- Order Booking Form (p.7): contact details
  mobile text check (mobile ~ '^[6-9][0-9]{9}$'),
  alt_phone text,
  email text,
  communication_address text,
  address_type text check (address_type in ('residence', 'office')),
  pin text check (pin ~ '^[1-9][0-9]{5}$'),

  -- Registration & Delivery Details (p.25)
  father_or_husband_name text,
  registration_address text,
  hypothecated_to text,
  insurance_coverage text check (insurance_coverage in ('in_house', 'by_party')),
  registration_period text check (registration_period in ('permanent', 'temporary')),
  rto_location text,
  registration_use text check (registration_use in ('private', 'commercial')),
  permit_type text check (permit_type in ('state', 'all_india')),
  special_registration_number text,
  registration_date date,
  delivery_at timestamptz,
  delivery_place text,
  temp_registration_validity_days int check (temp_registration_validity_days > 0),
  rc_days int check (rc_days > 0),
  hsrp_days int check (hsrp_days > 0),

  -- Accessories Order Form (p.13). Clients send [{accessory_id, qty}]; the trigger rebuilds each line
  -- from the accessories master, so names, part numbers and prices are never taken from the client.
  accessory_order_items jsonb not null default '[]' check (jsonb_typeof(accessory_order_items) = 'array'),
  accessories_total numeric not null default 0,
  accessories_advance numeric not null default 0,
  accessories_payment_mode text check (accessories_payment_mode in ('cash', 'card')),

  -- Interest in the docket's Toyota programmes (pp.18, 28–34)
  utrust_interest boolean not null default false,
  tconnect_interest boolean not null default false,
  extended_warranty_interest boolean not null default false,
  smiles_interest boolean not null default false,

  -- Referral Form (p.38): up to two [{name, occupation, phone, address, car_owned}]
  referrals jsonb not null default '[]' check (jsonb_typeof(referrals) = 'array' and jsonb_array_length(referrals) <= 2),

  terms_accepted boolean not null default false,
  rto_terms_accepted boolean not null default false,
  customer_signature_path text,
  consultant_signature_path text,

  pdf_storage_path text,
  completed_at timestamptz,
  completed_by uuid references employees(id),
  reopened_reason text,
  created_by uuid references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_welcome_dockets_status on welcome_dockets(status);
create trigger trg_welcome_dockets_updated_at before update on welcome_dockets for each row execute function set_updated_at();

-- Checklist of Documents (p.21). A document type counts as collected once it has a file, or is
-- marked as collected on paper. A type can have several files (e.g. Aadhaar front and back).
create table docket_documents (
  id uuid primary key default gen_random_uuid(),
  docket_id uuid not null references welcome_dockets(id) on delete cascade,
  doc_type text not null check (doc_type in (
    'photo', 'aadhaar', 'pan_or_voter_id', 'passport_or_driving_licence', 'telephone_bill',
    'salary_slips', 'form_16', 'bank_statement', 'it_returns', 'balance_sheet',
    'signature_verification', 'memorandum', 'partnership_deed', 'partner_authority_letter',
    'ncb_certificate', 'employment_letter', 'other')),
  label text,
  storage_path text,
  collected_on_paper boolean not null default false,
  uploaded_by uuid references employees(id) default current_employee_id(),
  created_at timestamptz not null default now(),
  check (storage_path is not null or collected_on_paper)
);
create index idx_docket_documents_docket on docket_documents(docket_id);

create or replace function can_access_booking(p_booking_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  -- Runs with the caller's RLS on bookings, so it covers both the employee line and the back office.
  select exists (select 1 from bookings where id = p_booking_id);
$$;

-- The booking id at the start of a booking-documents object path, or null.
create or replace function storage_booking_id(p_name text)
returns uuid
language sql
immutable
set search_path = public
as $$
  select case when (storage.foldername(p_name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then ((storage.foldername(p_name))[1])::uuid end;
$$;
grant execute on function storage_booking_id(text) to authenticated;

alter table welcome_dockets enable row level security;
create policy welcome_dockets_select on welcome_dockets for select to authenticated using (can_access_booking(booking_id));
create policy welcome_dockets_update on welcome_dockets for update to authenticated
  using (can_access_booking(booking_id)) with check (can_access_booking(booking_id));
-- Dockets are created only by open_welcome_docket().

alter table docket_documents enable row level security;
create policy docket_documents_select on docket_documents for select to authenticated using (
  exists (select 1 from welcome_dockets d where d.id = docket_id)
);
create policy docket_documents_insert on docket_documents for insert to authenticated with check (
  exists (select 1 from welcome_dockets d where d.id = docket_id and d.status = 'draft'
          and (storage_path is null or storage_booking_id(storage_path) = d.booking_id))
);
create policy docket_documents_delete on docket_documents for delete to authenticated using (
  exists (select 1 from welcome_dockets d where d.id = docket_id and d.status = 'draft')
);

-- Rebuilds the accessories order from the master and guards status changes.
create or replace function welcome_dockets_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_model_id uuid;
  v_items jsonb := '[]'::jsonb;
  v_total numeric := 0;
  rec record;
begin
  if TG_OP = 'UPDATE' and coalesce(current_setting('rt.docket_rpc', true), '') <> 'on' then
    if NEW.status is distinct from OLD.status or NEW.completed_at is distinct from OLD.completed_at
       or NEW.completed_by is distinct from OLD.completed_by or NEW.booking_id is distinct from OLD.booking_id then
      raise exception 'A docket is completed or reopened only through the docket screen';
    end if;
    if OLD.status = 'complete' then
      if (to_jsonb(NEW) - 'pdf_storage_path' - 'updated_at') is distinct from (to_jsonb(OLD) - 'pdf_storage_path' - 'updated_at') then
        raise exception 'This Welcome Docket is complete; an Outlet Head must reopen it before it can be changed';
      end if;
      return NEW;
    end if;
  end if;

  if TG_OP = 'INSERT' or NEW.accessory_order_items is distinct from OLD.accessory_order_items then
    select v.model_id into v_model_id from bookings b join variants v on v.id = b.variant_id where b.id = NEW.booking_id;
    for rec in
      select a.id, a.name, a.part_no, a.price, a.model_id, (i->>'qty')::int as qty
      from jsonb_array_elements(NEW.accessory_order_items) i
      left join accessories a on a.id = nullif(i->>'accessory_id', '')::uuid
    loop
      if rec.id is null then
        raise exception 'Unknown accessory in the accessories order';
      end if;
      if rec.model_id is not null and rec.model_id is distinct from v_model_id then
        raise exception 'Accessory % is not for this model', rec.name;
      end if;
      if rec.qty is null or rec.qty < 1 or rec.qty > 20 then
        raise exception 'Quantity for % must be between 1 and 20', rec.name;
      end if;
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'accessory_id', rec.id, 'name', rec.name, 'part_no', rec.part_no, 'qty', rec.qty,
        'price', rec.price, 'amount', rec.price * rec.qty));
      v_total := v_total + rec.price * rec.qty;
    end loop;
    if (select count(distinct e->>'accessory_id') from jsonb_array_elements(v_items) e) <> jsonb_array_length(v_items) then
      raise exception 'Each accessory can appear only once in the order; change its quantity instead';
    end if;
    NEW.accessory_order_items := v_items;
    NEW.accessories_total := v_total;
    -- Accessories T&C 4: 10% advance is paid while placing the order.
    NEW.accessories_advance := ceil(v_total * 0.10);
  end if;
  return NEW;
end;
$$;
create trigger trg_welcome_dockets_00_guard before insert or update on welcome_dockets
  for each row execute function welcome_dockets_guard();

-- Opens (or returns) the booking's docket, filled in from what the booking and customer already know.
create or replace function open_welcome_docket(p_booking_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  c customers%rowtype;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not (
       can_access_employee_data(current_employee_id(), b.employee_id)
       or coalesce(current_employee_role_rank() <= 1, false)
       or (is_crm_back_office() and b.outlet_id = (select outlet_id from employees where id = current_employee_id()))) then
    raise exception 'Booking not found';
  end if;
  if b.status = 'cancelled' then
    raise exception 'This booking is cancelled';
  end if;

  select id into v_id from welcome_dockets where booking_id = b.id;
  if v_id is not null then
    return v_id;
  end if;

  if b.customer_id is not null then
    select * into c from customers where id = b.customer_id;
  end if;

  insert into welcome_dockets (booking_id, mobile, alt_phone, email, communication_address, pin,
                               registration_use, accessory_order_items, created_by)
  values (
    b.id,
    coalesce(c.mobile, case when right(regexp_replace(coalesce(b.customer_mobile, ''), '\D', '', 'g'), 10) ~ '^[6-9][0-9]{9}$'
                            then right(regexp_replace(b.customer_mobile, '\D', '', 'g'), 10) end),
    c.alt_phone, c.email, c.address, case when c.pin ~ '^[1-9][0-9]{5}$' then c.pin end,
    case when b.price_list_type = 'commercial' then 'commercial' else 'private' end,
    coalesce((select jsonb_agg(jsonb_build_object('accessory_id', a, 'qty', 1)) from unnest(b.accessory_ids) a), '[]'::jsonb),
    current_employee_id())
  returning id into v_id;
  return v_id;
end;
$$;

-- What still stops the docket from being complete. Empty means it can be completed.
create or replace function welcome_docket_missing(p_docket_id uuid)
returns text[]
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  d welcome_dockets%rowtype;
  b bookings%rowtype;
  v_missing text[] := '{}';
  v_doc text;
begin
  select * into d from welcome_dockets where id = p_docket_id;
  if d.id is null then
    raise exception 'Welcome Docket not found';
  end if;
  select * into b from bookings where id = d.booking_id;

  if d.mobile is null then v_missing := array_append(v_missing, 'Mobile number'); end if;
  if nullif(btrim(d.communication_address), '') is null then v_missing := array_append(v_missing, 'Communication address'); end if;
  if d.pin is null then v_missing := array_append(v_missing, 'PIN code'); end if;
  if nullif(btrim(d.father_or_husband_name), '') is null then v_missing := array_append(v_missing, 'Father''s / husband''s name'); end if;
  if nullif(btrim(d.registration_address), '') is null then v_missing := array_append(v_missing, 'Registration address'); end if;
  if coalesce(b.mode_of_purchase, '') ~* 'financ' and nullif(btrim(d.hypothecated_to), '') is null then
    v_missing := array_append(v_missing, 'Hypothecated to (financier)');
  end if;
  if d.insurance_coverage is null then v_missing := array_append(v_missing, 'Insurance coverage (in house / by party)'); end if;
  if d.registration_period is null then v_missing := array_append(v_missing, 'Registration: permanent or temporary'); end if;
  if nullif(btrim(d.rto_location), '') is null then v_missing := array_append(v_missing, 'RTO location'); end if;
  if d.registration_use is null then v_missing := array_append(v_missing, 'Registration: private or commercial'); end if;
  if d.registration_use = 'commercial' and d.permit_type is null then v_missing := array_append(v_missing, 'Permit: state or all India'); end if;
  if jsonb_array_length(d.accessory_order_items) > 0 and d.accessories_payment_mode is null then
    v_missing := array_append(v_missing, 'Accessories payment mode');
  end if;
  foreach v_doc in array array['photo', 'aadhaar', 'pan_or_voter_id'] loop
    if not exists (select 1 from docket_documents where docket_id = d.id and doc_type = v_doc) then
      v_missing := array_append(v_missing, case v_doc when 'photo' then 'Document: passport size photograph'
                                            when 'aadhaar' then 'Document: Aadhaar card'
                                            else 'Document: PAN card / Voter ID' end);
    end if;
  end loop;
  if not b.data_consent then v_missing := array_append(v_missing, 'Customer data consent (on the booking)'); end if;
  if not d.terms_accepted then v_missing := array_append(v_missing, 'Customer accepts the order terms & conditions'); end if;
  if not d.rto_terms_accepted then v_missing := array_append(v_missing, 'Customer accepts the RTO process terms'); end if;
  if d.customer_signature_path is null then v_missing := array_append(v_missing, 'Customer signature'); end if;
  if d.consultant_signature_path is null then v_missing := array_append(v_missing, 'Sales Consultant signature'); end if;
  return v_missing;
end;
$$;

create or replace function complete_welcome_docket(p_docket_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_missing text[];
  v_status text;
begin
  select status into v_status from welcome_dockets where id = p_docket_id for update;
  if v_status is null then
    raise exception 'Welcome Docket not found';
  end if;
  if v_status = 'complete' then
    return jsonb_build_object('completed', true, 'missing', '[]'::jsonb);
  end if;
  v_missing := welcome_docket_missing(p_docket_id);
  if cardinality(v_missing) > 0 then
    return jsonb_build_object('completed', false, 'missing', to_jsonb(v_missing));
  end if;

  perform set_config('rt.docket_rpc', 'on', true);
  update welcome_dockets set status = 'complete', completed_at = now(), completed_by = current_employee_id(),
    reopened_reason = null
  where id = p_docket_id;
  perform set_config('rt.docket_rpc', 'off', true);
  return jsonb_build_object('completed', true, 'missing', '[]'::jsonb);
end;
$$;

-- An Outlet Head or above can reopen a complete docket, e.g. to correct the registration address.
create or replace function reopen_welcome_docket(p_docket_id uuid, p_reason text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if coalesce(current_employee_role_rank() > 2, true) then
    raise exception 'Only an Outlet Head or above can reopen a Welcome Docket';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give a reason for reopening';
  end if;
  perform set_config('rt.docket_rpc', 'on', true);
  update welcome_dockets set status = 'draft', completed_at = null, completed_by = null,
    reopened_reason = btrim(p_reason), pdf_storage_path = null
  where id = p_docket_id and status = 'complete';
  perform set_config('rt.docket_rpc', 'off', true);
  if not found then
    raise exception 'Welcome Docket not found or not complete';
  end if;
end;
$$;

revoke execute on function can_access_booking(uuid) from public, anon;
revoke execute on function welcome_dockets_guard() from public, anon, authenticated;
revoke execute on function open_welcome_docket(uuid) from public, anon;
revoke execute on function welcome_docket_missing(uuid) from public, anon;
revoke execute on function complete_welcome_docket(uuid) from public, anon;
revoke execute on function reopen_welcome_docket(uuid, text) from public, anon;
grant execute on function can_access_booking(uuid) to authenticated;
grant execute on function open_welcome_docket(uuid) to authenticated;
grant execute on function welcome_docket_missing(uuid) to authenticated;
grant execute on function complete_welcome_docket(uuid) to authenticated;
grant execute on function reopen_welcome_docket(uuid, text) to authenticated;

-- ===== Storage: booking documents =====
-- Objects live at `<booking_id>/...`: document photos, both docket signatures and the docket PDF.
-- Access follows the booking (so a Team Leader's upload is visible to the consultant and back office).
insert into storage.buckets (id, name, public)
values ('booking-documents', 'booking-documents', false)
on conflict (id) do nothing;

create policy booking_documents_select on storage.objects for select to authenticated using (
  bucket_id = 'booking-documents' and can_access_booking(storage_booking_id(name))
);
create policy booking_documents_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'booking-documents' and can_access_booking(storage_booking_id(name))
);
create policy booking_documents_update on storage.objects for update to authenticated using (
  bucket_id = 'booking-documents' and can_access_booking(storage_booking_id(name))
);
create policy booking_documents_delete on storage.objects for delete to authenticated using (
  bucket_id = 'booking-documents' and can_access_booking(storage_booking_id(name))
);
