-- Phase 10: stock, allotment and billing.
--   - The CTDMS Stock Statement (Transit and Physical Stock PDFs, parsed in the dashboard) is
--     imported into `vehicles`, one row per VIN. A transit car becomes physical when it shows up
--     in the physical report.
--   - Our CRM decides allotment: FIFO by earliest booking date, oldest stock first, same variant
--     and colour; or a manual allotment or swap, with a reason when it doesn't match. Every
--     allot/release adds a "Block / Unblock in CTDMS" to-do, and each stock upload lists where
--     CTDMS disagrees.
--   - "Send for billing" needs the car in the yard (physical) and a complete Welcome Docket. A new
--     Accounts role records the invoice, and the car becomes billed.
-- Who can do what:
--   - Allot, release, swap and send for billing: Outlet Head and above. An Outlet Head acts on
--     bookings or cars of their own branch; stock is shared across the group's branches.
--   - Back office (rank <= 3) imports stock and works the CTDMS to-do.
--   - Accounts records invoices for its branch.

-- ===== Accounts role =====
-- Rank 6 keeps Accounts below every approval and hierarchy check; it is recognised by name.
insert into roles (id, name, rank) values ('00000000-0000-0000-0001-000000000007', 'Accounts', 6)
on conflict (id) do nothing;

create or replace function is_accounts()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from employees e join roles r on r.id = e.role_id
    where e.id = current_employee_id() and r.name = 'Accounts' and e.is_active
  );
$$;

create or replace function current_employee_outlet_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select outlet_id from employees where id = current_employee_id();
$$;

-- Outlet Head and above; an Outlet Head only for the given branches.
create or replace function can_manage_stock(p_outlet_ids uuid[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_employee_role_rank() <= 1, false)
      or (coalesce(current_employee_role_rank() = 2, false) and current_employee_outlet_id() = any(p_outlet_ids));
$$;

-- ===== Vehicles =====
create table stock_import_batches (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references outlets(id),
  source text not null check (source in ('transit', 'physical')),
  report_date date,
  file_name text,
  summary jsonb,
  imported_by uuid references employees(id),
  created_at timestamptz not null default now()
);

create table vehicles (
  id uuid primary key default gen_random_uuid(),
  vin text not null unique check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  vin_raw text,
  outlet_id uuid not null references outlets(id),
  source text not null check (source in ('transit', 'physical')),
  status text not null default 'available' check (status in ('available', 'allotted', 'billed')),
  variant_id uuid references variants(id),
  color_id uuid references colors(id),
  engine_no text,
  key_no text,
  ctdms_model text,
  ctdms_grade text,
  ctdms_suffix_code text,
  ext_color_desc text,
  int_color_desc text,
  days_since_invoice int,
  tkm_invoice_amount numeric,
  interest_amount numeric,
  tkm_invoice_date date,
  billing_desc text,
  pds_done boolean,
  location text,
  ctdms_block_status text,
  ctdms_customer_name text,
  ctdms_sales_officer text,
  ctdms_order_no text,
  ctdms_order_date date,
  ctdms_order_status text,
  ctdms_block_ageing int,
  ctdms_amount_received numeric,
  ctdms_finance_company text,
  ctdms_likely_delivery date,
  report_date date,
  missing_from_report boolean not null default false,
  last_batch_id uuid references stock_import_batches(id),
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_vehicles_match on vehicles(variant_id, color_id) where status = 'available';
create index idx_vehicles_outlet on vehicles(outlet_id);
create index idx_vehicles_ctdms_order_no on vehicles(ctdms_order_no);
create trigger trg_vehicles_updated_at before update on vehicles for each row execute function set_updated_at();

-- How CTDMS colour descriptions map to our colours when the name alone doesn't decide it.
-- A mapping without a variant applies to every variant.
create table stock_color_mappings (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  variant_id uuid references variants(id),
  color_id uuid not null references colors(id),
  created_by uuid references employees(id),
  created_at timestamptz not null default now()
);
create unique index uq_stock_color_mappings on stock_color_mappings(upper(description), coalesce(variant_id, '00000000-0000-0000-0000-000000000000'));

create table allotments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  vehicle_id uuid not null references vehicles(id),
  method text not null check (method in ('fifo', 'manual', 'ctdms')),
  override_reason text,
  allotted_by uuid references employees(id),
  allotted_at timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid references employees(id),
  release_reason text
);
create unique index uq_allotments_active_vehicle on allotments(vehicle_id) where released_at is null;
create unique index uq_allotments_active_booking on allotments(booking_id) where released_at is null;
create index idx_allotments_booking on allotments(booking_id);

create table ctdms_block_tasks (
  id uuid primary key default gen_random_uuid(),
  allotment_id uuid not null references allotments(id),
  vehicle_id uuid not null references vehicles(id),
  booking_id uuid not null references bookings(id),
  action text not null check (action in ('block', 'unblock')),
  status text not null default 'pending' check (status in ('pending', 'done', 'cancelled')),
  done_by uuid references employees(id),
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_ctdms_block_tasks_pending on ctdms_block_tasks(status) where status = 'pending';

create table billing_requests (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  vehicle_id uuid not null references vehicles(id),
  allotment_id uuid not null references allotments(id),
  outlet_id uuid not null references outlets(id),
  status text not null default 'pending' check (status in ('pending', 'invoiced', 'cancelled')),
  requested_by uuid references employees(id),
  requested_at timestamptz not null default now(),
  invoice_no text,
  invoice_date date,
  invoice_amount numeric check (invoice_amount > 0),
  invoiced_by uuid references employees(id),
  invoiced_at timestamptz,
  cancel_reason text
);
create unique index uq_billing_requests_open on billing_requests(booking_id) where status in ('pending', 'invoiced');
create index idx_billing_requests_outlet on billing_requests(outlet_id, status);

-- ===== Read access (all writes go through the functions below) =====
alter table stock_import_batches enable row level security;
alter table vehicles enable row level security;
alter table stock_color_mappings enable row level security;
alter table allotments enable row level security;
alter table ctdms_block_tasks enable row level security;
alter table billing_requests enable row level security;

-- Back office and above see every branch's stock (it is shared across the group); everyone else
-- sees their own branch's.
create policy vehicles_select on vehicles for select to authenticated using (
  coalesce(current_employee_role_rank() <= 3, false) or outlet_id = current_employee_outlet_id()
);
create policy allotments_select on allotments for select to authenticated using (
  exists (select 1 from vehicles v where v.id = vehicle_id) or can_access_booking(booking_id)
);
create policy stock_import_batches_select on stock_import_batches for select to authenticated using (
  coalesce(current_employee_role_rank() <= 3, false)
);
create policy stock_color_mappings_select on stock_color_mappings for select to authenticated using (true);
create policy ctdms_block_tasks_select on ctdms_block_tasks for select to authenticated using (
  coalesce(current_employee_role_rank() <= 3, false)
);
create policy billing_requests_select on billing_requests for select to authenticated using (
  coalesce(current_employee_role_rank() <= 3, false)
  or (is_accounts() and outlet_id = current_employee_outlet_id())
  or can_access_booking(booking_id)
);
-- Accounts reads the bookings in its branch's billing queue. The check bypasses billing_requests'
-- own policy, which itself looks at bookings.
create or replace function accounts_can_see_booking(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_accounts() and exists (
    select 1 from billing_requests r where r.booking_id = p_booking_id and r.outlet_id = current_employee_outlet_id()
  );
$$;
create policy bookings_select_accounts on bookings for select to authenticated using (accounts_can_see_booking(id));

-- ===== Code mapping =====
create or replace function stock_norm(p text)
returns text
language sql
immutable
set search_path = public
as $$
  select btrim(regexp_replace(regexp_replace(upper(coalesce(p, '')), '\s*\([^)]*\)\s*$', ''), '\s+', ' ', 'g'));
$$;

-- CTDMS shortens some colour names: "GF" = Glass Flake, "A.BLACK" = Attitude Black,
-- "WHITEPEARL" = Platinum White Pearl; "X DUAL TONE" is the two-tone version of X.
create or replace function stock_color_id(p_variant_id uuid, p_description text)
returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  v_desc text := stock_norm(p_description);
  v_expanded text;
  v_id uuid;
  v_count int;
begin
  if v_desc = '' then
    return null;
  end if;

  select color_id into v_id from stock_color_mappings
  where upper(description) = v_desc and (variant_id = p_variant_id or variant_id is null)
  order by variant_id nulls last limit 1;
  if v_id is not null then
    return v_id;
  end if;

  v_expanded := regexp_replace(v_desc, '\mGF$', 'GLASS FLAKE');
  v_expanded := regexp_replace(v_expanded, '\mA\.\s*BLACK\M', 'ATTITUDE BLACK');
  v_expanded := regexp_replace(v_expanded, '^WHITEPEARL\M', 'PLATINUM WHITE PEARL');

  -- Candidates: the variant's colours (every colour when the variant is unknown).
  -- 1. Exact name.
  select c.id into v_id from colors c
  where (p_variant_id is null or c.id in (select color_id from variant_colors where variant_id = p_variant_id))
    and stock_norm(c.name) in (v_desc, v_expanded)
  order by c.is_dual_tone, c.name limit 1;
  if v_id is not null then
    return v_id;
  end if;

  -- 2. "CAFE WHITE DUAL TONE" -> the variant's one two-tone colour starting "Cafe White".
  if v_desc ~ ' DUAL TONE$' then
    select count(*), min(c.id::text)::uuid into v_count, v_id from colors c
    where (p_variant_id is null or c.id in (select color_id from variant_colors where variant_id = p_variant_id))
      and (c.is_dual_tone or stock_norm(c.name) like '% & %')
      and stock_norm(c.name) like regexp_replace(v_desc, ' DUAL TONE$', '') || ' &%';
    return case when v_count = 1 then v_id end;
  end if;

  -- 3. "ATTITUDE BLACK" -> the variant's one single-tone colour starting with it ("Attitude Black Mica").
  select count(*), min(c.id::text)::uuid into v_count, v_id from colors c
  where (p_variant_id is null or c.id in (select color_id from variant_colors where variant_id = p_variant_id))
    and not c.is_dual_tone and stock_norm(c.name) not like '% & %' and stock_norm(c.name) like v_expanded || '%';
  return case when v_count = 1 then v_id end;
end;
$$;

-- Re-resolves variant and colour for vehicles that are still available (after a mapping or a
-- master-data change). Allotted and billed cars keep what they were allotted as.
create or replace function remap_stock_vehicles()
returns int
language plpgsql
set search_path = public
as $$
declare
  v_count int;
begin
  update vehicles v set variant_id = coalesce(x.variant_id, v.variant_id),
                        color_id = coalesce(stock_color_id(coalesce(x.variant_id, v.variant_id), v.ext_color_desc), v.color_id)
  from (
    select v2.id, (select id from variants where tkm_suffix_code = v2.ctdms_suffix_code limit 1) as variant_id
    from vehicles v2 where v2.status = 'available' and (v2.variant_id is null or v2.color_id is null)
  ) x
  where x.id = v.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ===== Import =====
create or replace function import_stock_statement(
  p_outlet_id uuid, p_source text, p_report_date date, p_file_name text, p_rows jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch uuid;
  v_rows int := 0;
  v_inserted int := 0;
  v_moved int := 0;
  v_missing int := 0;
  v_back int := 0;
  r jsonb;
  v_vin text;
  v_variant uuid;
  v_color uuid;
  v_existing vehicles%rowtype;
begin
  if not (coalesce(current_employee_role_rank() <= 1, false)
          or (coalesce(current_employee_role_rank() <= 3, false) and current_employee_outlet_id() = p_outlet_id)) then
    raise exception 'Only back office of this branch can import its stock';
  end if;
  if p_source not in ('transit', 'physical') then
    raise exception 'Unknown stock source %', p_source;
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The report has no vehicles';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'Too many rows for one stock statement';
  end if;

  insert into stock_import_batches (outlet_id, source, report_date, file_name, imported_by)
  values (p_outlet_id, p_source, p_report_date, p_file_name, current_employee_id())
  returning id into v_batch;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_vin := upper(btrim(split_part(coalesce(r->>'vin', ''), '~', 1)));
    if v_vin !~ '^[A-HJ-NPR-Z0-9]{17}$' then
      continue;
    end if;
    v_rows := v_rows + 1;
    select id into v_variant from variants where tkm_suffix_code = upper(btrim(r->>'suffix_code')) limit 1;
    v_color := stock_color_id(v_variant, r->>'ext_color');
    select * into v_existing from vehicles where vin = v_vin;

    if v_existing.id is null then
      v_inserted := v_inserted + 1;
    elsif v_existing.source = 'transit' and p_source = 'physical' then
      v_moved := v_moved + 1;
    end if;
    if v_existing.id is not null and v_existing.missing_from_report then
      v_back := v_back + 1;
    end if;

    insert into vehicles as v (
      vin, vin_raw, outlet_id, source, variant_id, color_id, engine_no, key_no, ctdms_model, ctdms_grade,
      ctdms_suffix_code, ext_color_desc, int_color_desc, days_since_invoice, tkm_invoice_amount, interest_amount,
      tkm_invoice_date, billing_desc, pds_done, location, ctdms_block_status, ctdms_customer_name,
      ctdms_sales_officer, ctdms_order_no, ctdms_order_date, ctdms_order_status, ctdms_block_ageing,
      ctdms_amount_received, ctdms_finance_company, ctdms_likely_delivery, report_date, missing_from_report,
      last_batch_id)
    values (
      v_vin, r->>'vin_raw', p_outlet_id, p_source, v_variant, v_color, r->>'engine_no', r->>'key_no', r->>'model',
      r->>'grade', upper(btrim(r->>'suffix_code')), r->>'ext_color', r->>'int_color',
      (r->>'days_since_invoice')::int, (r->>'invoice_amount')::numeric, (r->>'interest_amount')::numeric,
      p_report_date - (r->>'days_since_invoice')::int, r->>'billing_desc', (r->>'pds_done')::boolean, r->>'location',
      r->>'block_status', r->>'customer_name', r->>'sales_officer', r->>'order_no', (r->>'order_date')::date,
      r->>'order_status', (r->>'block_ageing')::int, (r->>'amount_received')::numeric, r->>'finance_company',
      (r->>'likely_delivery')::date, p_report_date, false, v_batch)
    on conflict (vin) do update set
      vin_raw = excluded.vin_raw,
      outlet_id = excluded.outlet_id,
      -- A car never goes back from the yard to transit.
      source = case when v.source = 'physical' then 'physical' else excluded.source end,
      variant_id = case when v.status = 'available' then coalesce(excluded.variant_id, v.variant_id) else v.variant_id end,
      color_id = case when v.status = 'available' then coalesce(excluded.color_id, v.color_id) else v.color_id end,
      engine_no = excluded.engine_no, key_no = coalesce(excluded.key_no, v.key_no), ctdms_model = excluded.ctdms_model,
      ctdms_grade = excluded.ctdms_grade, ctdms_suffix_code = excluded.ctdms_suffix_code,
      ext_color_desc = excluded.ext_color_desc, int_color_desc = excluded.int_color_desc,
      days_since_invoice = excluded.days_since_invoice, tkm_invoice_amount = excluded.tkm_invoice_amount,
      interest_amount = excluded.interest_amount, tkm_invoice_date = coalesce(excluded.tkm_invoice_date, v.tkm_invoice_date),
      billing_desc = excluded.billing_desc, pds_done = excluded.pds_done, location = coalesce(excluded.location, v.location),
      ctdms_block_status = excluded.ctdms_block_status, ctdms_customer_name = excluded.ctdms_customer_name,
      ctdms_sales_officer = excluded.ctdms_sales_officer, ctdms_order_no = excluded.ctdms_order_no,
      ctdms_order_date = excluded.ctdms_order_date, ctdms_order_status = excluded.ctdms_order_status,
      ctdms_block_ageing = excluded.ctdms_block_ageing, ctdms_amount_received = excluded.ctdms_amount_received,
      ctdms_finance_company = excluded.ctdms_finance_company, ctdms_likely_delivery = excluded.ctdms_likely_delivery,
      report_date = excluded.report_date, missing_from_report = false, last_batch_id = excluded.last_batch_id;
  end loop;

  -- Cars of this branch last seen in this kind of report but not in this one have left it: a
  -- transit car usually turns up in the physical report next; a yard car has been invoiced or
  -- moved in CTDMS. A billed car leaving the report is expected.
  with gone as (
    update vehicles set missing_from_report = true
    where outlet_id = p_outlet_id and source = p_source and status <> 'billed' and not missing_from_report
      and last_batch_id is distinct from v_batch
    returning 1)
  select count(*) into v_missing from gone;

  update stock_import_batches set summary = jsonb_build_object(
    'rows', v_rows, 'inserted', v_inserted, 'updated', v_rows - v_inserted, 'moved_to_physical', v_moved,
    'missing_from_report', v_missing, 'back_in_report', v_back,
    'unmapped_variants', coalesce((select jsonb_agg(distinct ctdms_suffix_code) from vehicles where last_batch_id = v_batch and variant_id is null), '[]'::jsonb),
    'unmapped_colors', coalesce((select jsonb_agg(distinct coalesce(ctdms_suffix_code, '') || ' ' || ext_color_desc) from vehicles
                                 where last_batch_id = v_batch and variant_id is not null and color_id is null), '[]'::jsonb),
    'ctdms_allotments_to_confirm', (select count(*) from propose_ctdms_allotments(p_outlet_id))
  ) where id = v_batch;

  return (select summary from stock_import_batches where id = v_batch);
end;
$$;

create or replace function map_stock_color(p_description text, p_variant_id uuid, p_color_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(current_employee_role_rank() <= 3, false) then
    raise exception 'Only back office can map stock colours';
  end if;
  if not exists (select 1 from colors where id = p_color_id) then
    raise exception 'Unknown colour';
  end if;
  insert into stock_color_mappings (description, variant_id, color_id, created_by)
  values (stock_norm(p_description), p_variant_id, p_color_id, current_employee_id())
  on conflict (upper(description), coalesce(variant_id, '00000000-0000-0000-0000-000000000000'))
  do update set color_id = excluded.color_id, created_by = excluded.created_by, created_at = now();
  return remap_stock_vehicles();
end;
$$;

-- ===== Eligibility =====
-- A booking can take a car while it is booked (not on to billing, not cancelled), still open in
-- CTDMS, and any approval its discount needed has been given.
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
      and coalesce((select status from approvals where booking_id = b.id order by created_at desc limit 1), 'approved') = 'approved'
  );
$$;

create or replace function booking_order_date(b bookings)
returns date
language sql
stable
set search_path = public
as $$
  select coalesce(b.ctdms_order_date, (b.created_at at time zone 'Asia/Kolkata')::date);
$$;

-- A car can be allotted while it is available with us, still in the latest report, and not
-- already invoiced in CTDMS (a car CTDMS invoiced is sold, whatever our records say).
create or replace function vehicle_allotable(v vehicles)
returns boolean
language sql
stable
set search_path = public
as $$
  select v.status = 'available' and not v.missing_from_report and coalesce(v.ctdms_order_status, '') <> 'Invoiced'
    and not exists (select 1 from allotments a where a.vehicle_id = v.id and a.released_at is null);
$$;

-- FIFO: the earliest booking gets the oldest matching car (same variant and colour). Proposals
-- only; nothing is allotted until allot_vehicle() is called for each.
create or replace function propose_fifo_allotments(p_outlet_id uuid default null)
returns table (booking_id uuid, vehicle_id uuid, booking_date date, customer_name text, ctdms_order_no text,
               booking_outlet text, vin text, vehicle_source text, days_since_invoice int, variant_name text, color_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b record;
  v_vehicle uuid;
  v_taken uuid[] := '{}';
begin
  if not coalesce(current_employee_role_rank() <= 3, false) then
    raise exception 'Only back office can see allotment proposals';
  end if;
  for b in
    select bk.*, booking_order_date(bk) as order_date from bookings bk
    where booking_allotable(bk.id) and (p_outlet_id is null or bk.outlet_id = p_outlet_id)
    order by booking_order_date(bk), bk.created_at, bk.id
  loop
    select v.id into v_vehicle from vehicles v
    where vehicle_allotable(v) and v.variant_id = b.variant_id and v.color_id = b.color_id and v.id <> all(v_taken)
    order by (v.source = 'physical') desc, v.days_since_invoice desc nulls last, v.vin
    limit 1;
    continue when v_vehicle is null;
    v_taken := v_taken || v_vehicle;
    return query
      select b.id, v.id, b.order_date, b.customer_name, b.ctdms_order_booking_no, o.name, v.vin, v.source,
             v.days_since_invoice, va.name, c.name
      from vehicles v join variants va on va.id = v.variant_id join colors c on c.id = v.color_id
      join outlets o on o.id = b.outlet_id
      where v.id = v_vehicle;
  end loop;
end;
$$;

-- CTDMS already has these cars blocked for an order we know: propose allotting them to it.
create or replace function propose_ctdms_allotments(p_outlet_id uuid default null)
returns table (booking_id uuid, vehicle_id uuid, ctdms_order_no text, customer_name text, vin text, matches_booking boolean)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, v.id, v.ctdms_order_no, b.customer_name, v.vin,
         (v.variant_id = b.variant_id and v.color_id = b.color_id)
  from vehicles v
  join bookings b on b.ctdms_order_booking_no = v.ctdms_order_no
  where vehicle_allotable(v) and v.ctdms_block_status in ('Blocked', 'Alloted')
    and booking_allotable(b.id) and (p_outlet_id is null or v.outlet_id = p_outlet_id)
    and coalesce(current_employee_role_rank() <= 3, false);
$$;

-- Bookings that could take this car, matching ones first (for manual allotment and swaps).
create or replace function allotment_candidates(p_vehicle_id uuid)
returns table (booking_id uuid, customer_name text, ctdms_order_no text, booking_date date, outlet text,
               variant_name text, color_name text, matches boolean)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.customer_name, b.ctdms_order_booking_no, booking_order_date(b), o.name, va.name, c.name,
         (b.variant_id = v.variant_id and b.color_id = v.color_id)
  from vehicles v, bookings b
  join outlets o on o.id = b.outlet_id
  left join variants va on va.id = b.variant_id
  left join colors c on c.id = b.color_id
  where v.id = p_vehicle_id and vehicle_allotable(v) and booking_allotable(b.id)
    and coalesce(current_employee_role_rank() <= 3, false)
    and (b.variant_id = v.variant_id or (select model_id from variants where id = b.variant_id) = (select model_id from variants where id = v.variant_id))
  order by (b.variant_id = v.variant_id and b.color_id = v.color_id) desc, booking_order_date(b), b.created_at;
$$;

-- ===== Allot / release / swap =====
create or replace function allot_vehicle(p_booking_id uuid, p_vehicle_id uuid, p_method text default 'manual', p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v vehicles%rowtype;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id for update;
  select * into v from vehicles where id = p_vehicle_id for update;
  if b.id is null or v.id is null then
    raise exception 'Booking or vehicle not found';
  end if;
  if not can_manage_stock(array[b.outlet_id, v.outlet_id]) then
    raise exception 'Only an Outlet Head or above can allot cars';
  end if;
  if p_method not in ('fifo', 'manual', 'ctdms') then
    raise exception 'Unknown allotment method %', p_method;
  end if;
  if not booking_allotable(b.id) then
    raise exception 'This booking cannot take a car (already allotted, not booked, closed in CTDMS or awaiting approval)';
  end if;
  if not vehicle_allotable(v) then
    raise exception 'This car is not available (allotted, billed, missing from the latest report or invoiced in CTDMS)';
  end if;
  if (v.variant_id is distinct from b.variant_id or v.color_id is distinct from b.color_id) then
    if p_method = 'fifo' or nullif(btrim(p_reason), '') is null then
      raise exception 'This car does not match the booking''s variant and colour; give a reason to allot it anyway';
    end if;
  end if;

  insert into allotments (booking_id, vehicle_id, method, override_reason, allotted_by)
  values (b.id, v.id, p_method, nullif(btrim(p_reason), ''), current_employee_id())
  returning id into v_id;
  update vehicles set status = 'allotted' where id = v.id;
  update bookings set status = 'allocated' where id = b.id;
  -- A car CTDMS already has blocked for this order needs nothing done there.
  if not (p_method = 'ctdms' or (v.ctdms_block_status in ('Blocked', 'Alloted') and v.ctdms_order_no = b.ctdms_order_booking_no)) then
    insert into ctdms_block_tasks (allotment_id, vehicle_id, booking_id, action) values (v_id, v.id, b.id, 'block');
  end if;
  return v_id;
end;
$$;

create or replace function release_allotment(p_allotment_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a allotments%rowtype;
  v vehicles%rowtype;
  b bookings%rowtype;
begin
  select * into a from allotments where id = p_allotment_id and released_at is null for update;
  if a.id is null then
    raise exception 'Allotment not found or already released';
  end if;
  select * into v from vehicles where id = a.vehicle_id for update;
  select * into b from bookings where id = a.booking_id for update;
  if not can_manage_stock(array[b.outlet_id, v.outlet_id]) then
    raise exception 'Only an Outlet Head or above can release an allotment';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give a reason for releasing the car';
  end if;
  if exists (select 1 from billing_requests where allotment_id = a.id and status in ('pending', 'invoiced')) then
    raise exception 'This car has been sent for billing; cancel the billing request first';
  end if;

  update allotments set released_at = now(), released_by = current_employee_id(), release_reason = btrim(p_reason)
  where id = a.id;
  update vehicles set status = 'available' where id = v.id;
  update bookings set status = 'booked' where id = b.id and status = 'allocated';
  -- If CTDMS was never told about the block, there is nothing to undo there.
  if exists (select 1 from ctdms_block_tasks where allotment_id = a.id and action = 'block' and status = 'pending') then
    update ctdms_block_tasks set status = 'cancelled' where allotment_id = a.id and action = 'block' and status = 'pending';
  else
    insert into ctdms_block_tasks (allotment_id, vehicle_id, booking_id, action) values (a.id, v.id, b.id, 'unblock');
  end if;
end;
$$;

-- Gives a car to a different customer: the current booking goes back to the queue.
create or replace function swap_vehicle_customer(p_vehicle_id uuid, p_new_booking_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current uuid;
begin
  select id into v_current from allotments where vehicle_id = p_vehicle_id and released_at is null;
  if v_current is null then
    raise exception 'This car is not allotted';
  end if;
  perform release_allotment(v_current, coalesce(nullif(btrim(p_reason), ''), 'Swapped') || ' (car given to another customer)');
  return allot_vehicle(p_new_booking_id, p_vehicle_id, 'manual', p_reason);
end;
$$;

create or replace function mark_block_task_done(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(current_employee_role_rank() <= 3, false) then
    raise exception 'Only back office can work the CTDMS to-do';
  end if;
  update ctdms_block_tasks set status = 'done', done_by = current_employee_id(), done_at = now()
  where id = p_task_id and status = 'pending';
  if not found then
    raise exception 'To-do not found or already done';
  end if;
end;
$$;

-- ===== Billing =====
create or replace function send_for_billing(p_booking_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  a allotments%rowtype;
  v vehicles%rowtype;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id for update;
  if b.id is null then
    raise exception 'Booking not found';
  end if;
  select * into a from allotments where booking_id = b.id and released_at is null;
  if a.id is null then
    raise exception 'Allot a car to this booking first';
  end if;
  select * into v from vehicles where id = a.vehicle_id;
  if not can_manage_stock(array[b.outlet_id, v.outlet_id]) then
    raise exception 'Only an Outlet Head or above can send a car for billing';
  end if;
  if v.source <> 'physical' then
    raise exception 'This car is still in transit; it can be billed once it is in the yard';
  end if;
  if v.missing_from_report then
    raise exception 'This car is missing from the latest physical stock report; check it in CTDMS first';
  end if;
  if not exists (select 1 from welcome_dockets where booking_id = b.id and status = 'complete') then
    raise exception 'The Welcome Docket must be complete before billing';
  end if;
  if exists (select 1 from billing_requests where booking_id = b.id and status in ('pending', 'invoiced')) then
    raise exception 'This booking has already been sent for billing';
  end if;

  insert into billing_requests (booking_id, vehicle_id, allotment_id, outlet_id, requested_by)
  values (b.id, v.id, a.id, v.outlet_id, current_employee_id())
  returning id into v_id;
  update bookings set status = 'ready_to_invoice' where id = b.id;
  return v_id;
end;
$$;

create or replace function cancel_billing_request(p_request_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r billing_requests%rowtype;
begin
  select * into r from billing_requests where id = p_request_id for update;
  if r.id is null or r.status <> 'pending' then
    raise exception 'Billing request not found or already invoiced';
  end if;
  if not can_manage_stock(array[r.outlet_id, (select outlet_id from bookings where id = r.booking_id)]) then
    raise exception 'Only an Outlet Head or above can cancel a billing request';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give a reason';
  end if;
  update billing_requests set status = 'cancelled', cancel_reason = btrim(p_reason) where id = r.id;
  update bookings set status = 'allocated' where id = r.booking_id and status = 'ready_to_invoice';
end;
$$;

create or replace function record_invoice(p_request_id uuid, p_invoice_no text, p_invoice_date date, p_invoice_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r billing_requests%rowtype;
begin
  select * into r from billing_requests where id = p_request_id for update;
  if r.id is null or r.status <> 'pending' then
    raise exception 'Billing request not found or already invoiced';
  end if;
  if not (coalesce(current_employee_role_rank() <= 1, false) or (is_accounts() and current_employee_outlet_id() = r.outlet_id)) then
    raise exception 'Only Accounts of this branch can record the invoice';
  end if;
  if nullif(btrim(p_invoice_no), '') is null or p_invoice_date is null or coalesce(p_invoice_amount, 0) <= 0 then
    raise exception 'Enter the invoice number, date and amount';
  end if;
  if p_invoice_date > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'The invoice date cannot be in the future';
  end if;
  update billing_requests set status = 'invoiced', invoice_no = btrim(p_invoice_no), invoice_date = p_invoice_date,
    invoice_amount = p_invoice_amount, invoiced_by = current_employee_id(), invoiced_at = now()
  where id = r.id;
  update vehicles set status = 'billed' where id = r.vehicle_id;
end;
$$;

-- ===== Where CTDMS disagrees with us =====
create or replace function stock_ctdms_mismatches(p_outlet_id uuid default null)
returns table (kind text, vehicle_id uuid, vin text, ctdms_block_status text, ctdms_order_no text,
               booking_id uuid, booking_order_no text, customer_name text)
language sql
stable
security definer
set search_path = public
as $$
  with active as (
    select a.*, b.ctdms_order_booking_no, b.customer_name from allotments a join bookings b on b.id = a.booking_id
    where a.released_at is null
  )
  select * from (
    -- Blocked in CTDMS, free with us.
    select 'blocked_in_ctdms_only' as kind, v.id as vehicle_id, v.vin, v.ctdms_block_status, v.ctdms_order_no,
           null::uuid as booking_id, null::text as booking_order_no, v.ctdms_customer_name as customer_name
    from vehicles v
    where vehicle_allotable(v) and v.ctdms_block_status in ('Blocked', 'Alloted')
    union all
    -- Invoiced in CTDMS but not billed with us: sold outside this CRM, or the invoice is still to be recorded.
    select 'invoiced_in_ctdms', v.id, v.vin, v.ctdms_block_status, v.ctdms_order_no, a.booking_id,
           a.ctdms_order_booking_no, coalesce(a.customer_name, v.ctdms_customer_name)
    from vehicles v left join active a on a.vehicle_id = v.id
    where v.status <> 'billed' and not v.missing_from_report and v.ctdms_order_status = 'Invoiced'
    union all
    -- Allotted with us, still free in CTDMS although the block was marked done.
    select 'free_in_ctdms', v.id, v.vin, v.ctdms_block_status, v.ctdms_order_no, a.booking_id, a.ctdms_order_booking_no, a.customer_name
    from active a join vehicles v on v.id = a.vehicle_id
    where v.ctdms_block_status = 'Free' and v.status = 'allotted'
      and not exists (select 1 from ctdms_block_tasks t where t.allotment_id = a.id and t.status = 'pending')
      and v.report_date >= coalesce((select max(done_at)::date from ctdms_block_tasks t where t.allotment_id = a.id),
                                    a.allotted_at::date)
    union all
    -- Blocked in CTDMS for a different order than ours.
    select 'different_order', v.id, v.vin, v.ctdms_block_status, v.ctdms_order_no, a.booking_id, a.ctdms_order_booking_no, a.customer_name
    from active a join vehicles v on v.id = a.vehicle_id
    where v.ctdms_order_no is not null and a.ctdms_order_booking_no is not null and v.ctdms_order_no <> a.ctdms_order_booking_no
    union all
    -- Allotted with us but gone from the latest report.
    select 'missing_from_report', v.id, v.vin, v.ctdms_block_status, v.ctdms_order_no, a.booking_id, a.ctdms_order_booking_no, a.customer_name
    from active a join vehicles v on v.id = a.vehicle_id
    where v.missing_from_report and v.status <> 'billed'
  ) m
  where coalesce(current_employee_role_rank() <= 3, false)
    and (p_outlet_id is null or exists (select 1 from vehicles x where x.id = m.vehicle_id and x.outlet_id = p_outlet_id));
$$;

-- ===== Grants =====
revoke execute on function accounts_can_see_booking(uuid) from public, anon;
grant execute on function accounts_can_see_booking(uuid) to authenticated;
revoke execute on function is_accounts() from public, anon;
revoke execute on function current_employee_outlet_id() from public, anon;
revoke execute on function can_manage_stock(uuid[]) from public, anon;
revoke execute on function stock_color_id(uuid, text) from public, anon, authenticated;
revoke execute on function remap_stock_vehicles() from public, anon, authenticated;
revoke execute on function booking_allotable(uuid) from public, anon, authenticated;
revoke execute on function booking_order_date(bookings) from public, anon;
revoke execute on function vehicle_allotable(vehicles) from public, anon, authenticated;
revoke execute on function import_stock_statement(uuid, text, date, text, jsonb) from public, anon;
revoke execute on function map_stock_color(text, uuid, uuid) from public, anon;
revoke execute on function propose_fifo_allotments(uuid) from public, anon;
revoke execute on function propose_ctdms_allotments(uuid) from public, anon;
revoke execute on function allotment_candidates(uuid) from public, anon;
revoke execute on function allot_vehicle(uuid, uuid, text, text) from public, anon;
revoke execute on function release_allotment(uuid, text) from public, anon;
revoke execute on function swap_vehicle_customer(uuid, uuid, text) from public, anon;
revoke execute on function mark_block_task_done(uuid) from public, anon;
revoke execute on function send_for_billing(uuid) from public, anon;
revoke execute on function cancel_billing_request(uuid, text) from public, anon;
revoke execute on function record_invoice(uuid, text, date, numeric) from public, anon;
revoke execute on function stock_ctdms_mismatches(uuid) from public, anon;
grant execute on function is_accounts() to authenticated;
grant execute on function current_employee_outlet_id() to authenticated;
grant execute on function can_manage_stock(uuid[]) to authenticated;
grant execute on function booking_order_date(bookings) to authenticated;
grant execute on function import_stock_statement(uuid, text, date, text, jsonb) to authenticated;
grant execute on function map_stock_color(text, uuid, uuid) to authenticated;
grant execute on function propose_fifo_allotments(uuid) to authenticated;
grant execute on function propose_ctdms_allotments(uuid) to authenticated;
grant execute on function allotment_candidates(uuid) to authenticated;
grant execute on function allot_vehicle(uuid, uuid, text, text) to authenticated;
grant execute on function release_allotment(uuid, text) to authenticated;
grant execute on function swap_vehicle_customer(uuid, uuid, text) to authenticated;
grant execute on function mark_block_task_done(uuid) to authenticated;
grant execute on function send_for_billing(uuid) to authenticated;
grant execute on function cancel_billing_request(uuid, text) to authenticated;
grant execute on function record_invoice(uuid, text, date, numeric) to authenticated;
grant execute on function stock_ctdms_mismatches(uuid) to authenticated;
