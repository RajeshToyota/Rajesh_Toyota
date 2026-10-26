-- Phase 6: customers and enquiries — the first step of the lifecycle. An enquiry is captured in our
-- CRM (mobile or dashboard), assigned to a branch and Sales Consultant, and later reconciled with
-- CTDMS (Phase 7 fills crm_sync_status / ctdms_enquiry_no). Quotes and bookings link back to it.

-- ===== Customers: one row per mobile number =====
create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mobile text not null unique check (mobile ~ '^[6-9][0-9]{9}$'),
  alt_phone text,
  email text,
  address text,
  pin text,
  pan text,
  ctdms_customer_code text,
  created_by_employee_id uuid references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_customers_ctdms_customer_code on customers(ctdms_customer_code);
create trigger trg_customers_updated_at before update on customers for each row execute function set_updated_at();

-- ===== Enquiries =====
create table enquiries (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  outlet_id uuid not null references outlets(id),
  assigned_employee_id uuid not null references employees(id),
  created_by_employee_id uuid not null references employees(id),
  purpose_of_visit text not null,
  model_id uuid not null references models(id),
  fuel_type_id uuid references fuel_types(id),
  variant_id uuid references variants(id),
  color_id uuid references colors(id),
  -- Same vocabulary as CTDMS ENQUIRY_MODE_NAME / ENQUIRY_SOURCE_DESC, so Phase 7 can compare.
  mode text not null,
  source_desc text,
  test_drive_given boolean not null default false,
  temperature text not null default 'WRM',
  stage text not null default 'open',
  lost_reason text,
  ctdms_enquiry_no text unique,
  ctdms_status text,
  crm_sync_status text not null default 'pending_entry',
  crm_marked_done_by uuid references employees(id),
  crm_marked_done_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (purpose_of_visit in ('new_purchase', 'test_drive', 'exchange', 'price_enquiry', 'finance_enquiry', 'other')),
  check (mode in ('Walk-in', 'Dealer CAC Call-In', 'Dealer CAC Call-Out', 'TKM Digital', 'Dealer Digital',
                  'Cold Call(visit)', 'UIO Lead (Service)', 'Other')),
  check (temperature in ('HOT', 'WRM', 'CLD')),
  check (stage in ('open', 'quoted', 'booked', 'lost')),
  check (stage <> 'lost' or lost_reason is not null),
  check (crm_sync_status in ('pending_entry', 'marked_done', 'verified', 'mismatch'))
);
create index idx_enquiries_customer_id on enquiries(customer_id);
create index idx_enquiries_outlet_id on enquiries(outlet_id);
create index idx_enquiries_assigned_employee_id on enquiries(assigned_employee_id);
create index idx_enquiries_stage on enquiries(stage);
create index idx_enquiries_crm_sync_status on enquiries(crm_sync_status);
create index idx_enquiries_created_at on enquiries(created_at desc);
create trigger trg_enquiries_updated_at before update on enquiries for each row execute function set_updated_at();

-- ===== Links from quotes and bookings =====
alter table quotes add column enquiry_id uuid references enquiries(id);
alter table bookings add column enquiry_id uuid references enquiries(id);
alter table bookings add column customer_id uuid references customers(id);
create index idx_quotes_enquiry_id on quotes(enquiry_id);
create index idx_bookings_enquiry_id on bookings(enquiry_id);
create index idx_bookings_customer_id on bookings(customer_id);

-- ===== Helpers =====
-- 10-digit Indian mobile from whatever was typed ("+91 98290 63147", "098290-63147"), or null.
create or replace function normalize_mobile(p text)
returns text
language sql
immutable
as $$
  select case
    when d ~ '^[6-9][0-9]{9}$' then d
    when d ~ '^91[6-9][0-9]{9}$' then right(d, 10)
    when d ~ '^0[6-9][0-9]{9}$' then right(d, 10)
  end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) s;
$$;

create or replace function can_access_customer(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_employee_role_rank() <= 2, false)
    or exists (select 1 from enquiries e where e.customer_id = p_customer_id
               and can_access_employee_data(current_employee_id(), e.assigned_employee_id))
    or exists (select 1 from bookings b where b.customer_id = p_customer_id
               and can_access_employee_data(current_employee_id(), b.employee_id));
$$;

-- ===== RLS =====
alter table customers enable row level security;
create policy customers_select on customers for select to authenticated using (can_access_customer(id));
create policy customers_update on customers for update to authenticated
  using (can_access_customer(id)) with check (can_access_customer(id));
-- Inserts only via create_enquiry(), which dedupes on mobile.

alter table enquiries enable row level security;
create policy enquiries_select on enquiries for select to authenticated
  using (can_access_employee_data(current_employee_id(), assigned_employee_id));
-- Notes / temperature / test-drive edits by whoever can see it. Assignment and stage moves go
-- through reassign_enquiry() / mark_enquiry_lost() and the quote/booking triggers.
create policy enquiries_update on enquiries for update to authenticated
  using (can_access_employee_data(current_employee_id(), assigned_employee_id))
  with check (can_access_employee_data(current_employee_id(), assigned_employee_id));

-- ===== create_enquiry =====
-- p: { mobile, name, email?, alt_phone?, address?, pin?, purpose_of_visit, model_id, fuel_type_id?,
--      variant_id?, color_id?, mode, source_desc?, test_drive_given?, temperature?, notes?,
--      assigned_employee_id? }
-- The enquiry's branch is the assignee's branch. Assigning to someone else needs Team Leader rank
-- or above and that person in the caller's visibility.
create or replace function create_enquiry(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := current_employee_id();
  v_rank int := current_employee_role_rank();
  v_assignee uuid := coalesce(nullif(p->>'assigned_employee_id', '')::uuid, v_caller);
  v_outlet uuid;
  v_mobile text := normalize_mobile(p->>'mobile');
  v_name text := nullif(btrim(p->>'name'), '');
  v_customer uuid;
  v_enquiry uuid;
begin
  if v_caller is null then
    raise exception 'Not signed in as an employee';
  end if;
  if v_mobile is null then
    raise exception 'Enter a valid 10-digit mobile number';
  end if;
  if v_name is null then
    raise exception 'Customer name is required';
  end if;
  if v_assignee <> v_caller and (v_rank is null or v_rank > 4 or not can_access_employee_data(v_caller, v_assignee)) then
    raise exception 'Only a Team Leader or above can assign an enquiry to someone in their team';
  end if;

  select outlet_id into v_outlet from employees where id = v_assignee and is_active;
  if v_outlet is null then
    raise exception 'The assigned employee has no branch';
  end if;

  insert into customers (name, mobile, email, alt_phone, address, pin, created_by_employee_id)
  values (v_name, v_mobile, nullif(p->>'email', ''), nullif(p->>'alt_phone', ''), nullif(p->>'address', ''),
          nullif(p->>'pin', ''), v_caller)
  on conflict (mobile) do update set
    email = coalesce(customers.email, excluded.email),
    alt_phone = coalesce(customers.alt_phone, excluded.alt_phone),
    address = coalesce(customers.address, excluded.address),
    pin = coalesce(customers.pin, excluded.pin)
  returning id into v_customer;

  insert into enquiries (customer_id, outlet_id, assigned_employee_id, created_by_employee_id, purpose_of_visit,
                         model_id, fuel_type_id, variant_id, color_id, mode, source_desc, test_drive_given,
                         temperature, notes)
  values (v_customer, v_outlet, v_assignee, v_caller, p->>'purpose_of_visit',
          (p->>'model_id')::uuid, nullif(p->>'fuel_type_id', '')::uuid, nullif(p->>'variant_id', '')::uuid,
          nullif(p->>'color_id', '')::uuid, p->>'mode', nullif(p->>'source_desc', ''),
          coalesce((p->>'test_drive_given')::boolean, false), coalesce(nullif(p->>'temperature', ''), 'WRM'),
          nullif(p->>'notes', ''))
  returning id into v_enquiry;

  return v_enquiry;
end;
$$;

-- Who is this number? Name plus every open enquiry for it, whoever owns it, so a consultant sees
-- "already being handled by X at Y" before creating a duplicate. Only the owner's name and branch
-- are revealed for enquiries outside the caller's visibility.
create or replace function find_customer(p_mobile text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_mobile text := normalize_mobile(p_mobile);
  v_customer customers%rowtype;
begin
  if current_employee_id() is null then
    raise exception 'Not signed in as an employee';
  end if;
  if v_mobile is null then
    return null;
  end if;

  select * into v_customer from customers where mobile = v_mobile;
  if v_customer.id is null then
    return jsonb_build_object('mobile', v_mobile, 'customer', null, 'open_enquiries', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'mobile', v_mobile,
    'customer', jsonb_build_object('id', v_customer.id, 'name', v_customer.name),
    'open_enquiries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'created_at', e.created_at, 'stage', e.stage, 'model', m.name,
        'assigned_to', emp.name, 'outlet', o.name,
        'mine', can_access_employee_data(current_employee_id(), e.assigned_employee_id))
        order by e.created_at desc)
      from enquiries e
      join models m on m.id = e.model_id
      join employees emp on emp.id = e.assigned_employee_id
      join outlets o on o.id = e.outlet_id
      where e.customer_id = v_customer.id and e.stage in ('open', 'quoted')
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function reassign_enquiry(p_enquiry_id uuid, p_employee_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := current_employee_id();
  v_rank int := current_employee_role_rank();
  v_current uuid;
  v_outlet uuid;
begin
  select assigned_employee_id into v_current from enquiries where id = p_enquiry_id;
  if v_current is null then
    raise exception 'Enquiry not found';
  end if;
  if v_rank is null or v_rank > 4
     or not can_access_employee_data(v_caller, v_current)
     or not can_access_employee_data(v_caller, p_employee_id) then
    raise exception 'Only a Team Leader or above can reassign, and only within their team';
  end if;

  select outlet_id into v_outlet from employees where id = p_employee_id and is_active;
  if v_outlet is null then
    raise exception 'The new assignee has no branch';
  end if;

  update enquiries set assigned_employee_id = p_employee_id, outlet_id = v_outlet where id = p_enquiry_id;
end;
$$;

create or replace function mark_enquiry_lost(p_enquiry_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(btrim(p_reason), '') is null then
    raise exception 'A reason is required';
  end if;
  update enquiries set stage = 'lost', lost_reason = btrim(p_reason)
  where id = p_enquiry_id and stage <> 'booked'
    and can_access_employee_data(current_employee_id(), assigned_employee_id);
  if not found then
    raise exception 'Enquiry not found, already booked, or not yours to close';
  end if;
end;
$$;

-- ===== Stage follows the pipeline =====
create or replace function enquiries_follow_quote()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.enquiry_id is not null then
    update enquiries set stage = 'quoted' where id = NEW.enquiry_id and stage = 'open';
  end if;
  return NEW;
end;
$$;
create trigger trg_quotes_enquiry_stage after insert on quotes
  for each row execute function enquiries_follow_quote();

create or replace function enquiries_follow_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.enquiry_id is not null then
    update enquiries set stage = 'booked' where id = NEW.enquiry_id and stage in ('open', 'quoted');
    if NEW.customer_id is null then
      update bookings set customer_id = (select customer_id from enquiries where id = NEW.enquiry_id)
      where id = NEW.id;
    end if;
  end if;
  return NEW;
end;
$$;
create trigger trg_bookings_enquiry_stage after insert on bookings
  for each row execute function enquiries_follow_booking();

-- ===== Grants (see 20260918000001: revoke from anon explicitly) =====
revoke execute on function create_enquiry(jsonb) from public, anon;
revoke execute on function find_customer(text) from public, anon;
revoke execute on function reassign_enquiry(uuid, uuid) from public, anon;
revoke execute on function mark_enquiry_lost(uuid, text) from public, anon;
revoke execute on function can_access_customer(uuid) from public, anon;
revoke execute on function enquiries_follow_quote() from public, anon;
revoke execute on function enquiries_follow_booking() from public, anon;
grant execute on function create_enquiry(jsonb) to authenticated;
grant execute on function find_customer(text) to authenticated;
grant execute on function reassign_enquiry(uuid, uuid) to authenticated;
grant execute on function mark_enquiry_lost(uuid, text) to authenticated;
grant execute on function can_access_customer(uuid) to authenticated;
