-- Phase 7: daily reconciliation with Toyota's CRM (CTDMS).
--
-- Two uploads, both parsed in the uploader's browser and sent as rows:
--   * Enquiry Survey Report -> import_ctdms_enquiry_report(): matches CTDMS enquiries to ours by
--     enquiry number, then by mobile; writes the CTDMS number back (verified), lists CTDMS
--     enquiries we don't have ("Missing in our CRM"), and flags enquiries someone marked as entered
--     that the report doesn't contain (mismatch).
--   * PO Order Listing (open orders, one branch) -> import_ctdms_order_listing(): upserts CTDMS
--     orders into bookings, verifies bookings we marked as entered, flags ours that are missing,
--     and marks imported orders that left the open list as closed in CTDMS.
-- The "To enter in Toyota CRM" queues are enquiries/bookings whose crm_sync_status is pending_entry
-- or mismatch; staff clear them with mark_enquiry_entered_in_ctdms / mark_booking_entered_in_ctdms
-- and the next upload verifies them.

-- Back office: Admin, Business Head, Outlet Head, Head Customer Relations.
create or replace function is_crm_back_office()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_employee_role_rank() <= 3, false);
$$;

-- ===== Import audit trail =====
create table crm_import_batches (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('enquiry_report', 'order_listing')),
  file_name text,
  dealer_codes text[] not null default '{}',
  report_from date,
  report_to date,
  row_count int not null default 0,
  summary jsonb not null default '{}'::jsonb,
  uploaded_by uuid references employees(id),
  created_at timestamptz not null default now()
);
create index idx_crm_import_batches_kind_created on crm_import_batches(kind, created_at desc);

create table crm_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references crm_import_batches(id) on delete cascade,
  row_no int not null,
  ctdms_no text,
  dealer_code text,
  mobile text,
  data jsonb not null,
  -- matched: linked to an existing enquiry/booking; missing_in_crm: CTDMS has it, we don't;
  -- imported: created in our CRM from this row; inserted / updated: order listing upserts.
  match_status text not null check (match_status in ('matched', 'missing_in_crm', 'imported', 'inserted', 'updated')),
  enquiry_id uuid references enquiries(id),
  booking_id uuid references bookings(id)
);
create index idx_crm_import_rows_batch on crm_import_rows(batch_id, match_status);
create index idx_crm_import_rows_ctdms_no on crm_import_rows(ctdms_no);

alter table crm_import_batches enable row level security;
alter table crm_import_rows enable row level security;
create policy crm_import_batches_select on crm_import_batches for select to authenticated using (is_crm_back_office());
create policy crm_import_rows_select on crm_import_rows for select to authenticated using (is_crm_back_office());
-- Writes only through the import RPCs below.

-- ===== Bookings: CTDMS sync state, like enquiries =====
alter table bookings
  add column crm_sync_status text not null default 'pending_entry'
    check (crm_sync_status in ('pending_entry', 'marked_done', 'verified', 'mismatch')),
  add column crm_marked_done_by uuid references employees(id),
  add column crm_marked_done_at timestamptz;
update bookings set crm_sync_status = 'verified' where imported_from_ctdms;
update bookings set crm_sync_status = 'marked_done'
where not imported_from_ctdms and ctdms_order_booking_no is not null;
create index idx_bookings_crm_sync_status on bookings(crm_sync_status);

-- A consultant who types the CTDMS order number into the booking form has entered it in CTDMS.
create or replace function bookings_default_crm_sync()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if NEW.imported_from_ctdms then
    NEW.crm_sync_status := 'verified';
  elsif NEW.ctdms_order_booking_no is not null and NEW.crm_sync_status = 'pending_entry' then
    NEW.crm_sync_status := 'marked_done';
  end if;
  return NEW;
end;
$$;
create trigger trg_bookings_default_crm_sync before insert on bookings
  for each row execute function bookings_default_crm_sync();

-- Orders imported from CTDMS carry no consultant until the Sales Officer is known, so
-- employee-based RLS hid them from everyone. Back office sees all bookings; an Outlet Head
-- or Head Customer Relations sees their own branch's.
create policy bookings_select_back_office on bookings for select to authenticated using (
  coalesce(current_employee_role_rank() <= 1, false)
  or (is_crm_back_office() and outlet_id = (select outlet_id from employees where id = current_employee_id()))
);

-- The sync queues are worked by Head Customer Relations, who has no downline: back office reads
-- every enquiry (and its customer) at their own branch; Business Head and Admin already see all.
create policy enquiries_select_back_office on enquiries for select to authenticated using (
  is_crm_back_office() and outlet_id = (select outlet_id from employees where id = current_employee_id())
);

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
               and can_access_employee_data(current_employee_id(), b.employee_id))
    or (is_crm_back_office() and exists (
          select 1 from enquiries e where e.customer_id = p_customer_id
            and e.outlet_id = (select outlet_id from employees where id = current_employee_id())));
$$;

-- ===== Helpers =====
create or replace function ctdms_text(p jsonb, k text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(btrim(regexp_replace(p->>k, '\s+', ' ', 'g')), '');
$$;

-- CTDMS dates arrive as DD/MM/YYYY text or ISO dates (when the cell is date-formatted).
create or replace function ctdms_date(p text)
returns date
language sql
immutable
set search_path = public
as $$
  select case
    when p ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(p, 'DD/MM/YYYY')
    when p ~ '^\d{4}-\d{2}-\d{2}' then left(p, 10)::date
  end;
$$;

create or replace function ctdms_employee(p_name text)
returns uuid
language sql
stable
set search_path = public
as $$
  select id from employees
  where upper(ctdms_name) = upper(regexp_replace(btrim(p_name), '\s+', ' ', 'g')) and is_active
  order by created_at
  limit 1;
$$;

-- Model from the CTDMS suffix code: the exact variant if catalogued, else the 3-letter model prefix.
-- Early enquiries carry only a model name ("TOYOTA GLANZA"): matched without "TOYOTA", exactly or
-- as the start of exactly one model's name ("INNOVA" is ambiguous and stays unresolved).
create or replace function ctdms_model(p_suffix text, p_model_name text default null)
returns uuid
language sql
stable
set search_path = public
as $$
  with n as (select upper(btrim(regexp_replace(regexp_replace(coalesce(p_model_name, ''), '^\s*TOYOTA\s+', '', 'i'), '\s+', ' ', 'g'))) as name)
  select coalesce(
    (select model_id from variants where tkm_suffix_code = upper(p_suffix)),
    (select id from models where tkm_model_code = upper(left(p_suffix, 3))),
    (select id from models, n where n.name <> '' and upper(models.name) = n.name limit 1),
    (select min(id::text)::uuid from models, n where n.name <> '' and upper(models.name) like n.name || '%'
     having count(*) = 1));
$$;

-- ===== Enquiry Survey Report =====
-- p_rows: [{ enquiry_no, enquiry_date, dealer_code, customer_name, mobile, model_name, grade,
--            suffix_code, color_code, status, mode, source_desc, test_drive, sales_officer }]
create or replace function import_ctdms_enquiry_report(p_file_name text, p_from date, p_to date, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch uuid;
  v_row jsonb;
  v_n int := 0;
  v_enquiry uuid;
  v_mobile text;
  v_no text;
  v_dealer text;
  v_status text;
  v_matched int := 0;
  v_missing int := 0;
  v_mismatch int := 0;
  v_reverified int := 0;
  v_dealers text[];
  v_unknown_staff text[];
begin
  if not is_crm_back_office() then
    raise exception 'Only back-office staff can upload CTDMS reports';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The report has no enquiry rows';
  end if;
  if jsonb_array_length(p_rows) > 20000 then
    raise exception 'Too many rows in one upload';
  end if;

  select array_agg(distinct upper(ctdms_text(r, 'dealer_code'))) into v_dealers
  from jsonb_array_elements(p_rows) r where ctdms_text(r, 'dealer_code') is not null;

  insert into crm_import_batches (kind, file_name, dealer_codes, report_from, report_to, row_count, uploaded_by)
  values ('enquiry_report', p_file_name, coalesce(v_dealers, '{}'), p_from, p_to, jsonb_array_length(p_rows), current_employee_id())
  returning id into v_batch;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    v_no := upper(ctdms_text(v_row, 'enquiry_no'));
    v_mobile := normalize_mobile(v_row->>'mobile');
    v_dealer := upper(ctdms_text(v_row, 'dealer_code'));
    v_status := upper(ctdms_text(v_row, 'status'));
    -- CTDMS repeats an enquiry on more than one survey line; the first one counts.
    if v_no is null or exists (select 1 from crm_import_rows where batch_id = v_batch and ctdms_no = v_no) then
      continue;
    end if;

    -- Already linked by number, else the newest unlinked enquiry for this mobile at that branch.
    select id into v_enquiry from enquiries where ctdms_enquiry_no = v_no;
    if v_enquiry is null and v_mobile is not null then
      select e.id into v_enquiry
      from enquiries e
      join customers c on c.id = e.customer_id
      join outlets o on o.id = e.outlet_id
      where c.mobile = v_mobile and e.ctdms_enquiry_no is null
        and (v_dealer is null or o.ctdms_dealer_code = v_dealer)
      order by (e.stage <> 'lost') desc, e.created_at desc
      limit 1;
    end if;

    if v_enquiry is not null then
      if (select crm_sync_status from enquiries where id = v_enquiry) = 'mismatch' then
        v_reverified := v_reverified + 1;
      end if;
      update enquiries
      set ctdms_enquiry_no = v_no, ctdms_status = v_status, crm_sync_status = 'verified'
      where id = v_enquiry;
      v_matched := v_matched + 1;
    else
      v_missing := v_missing + 1;
    end if;

    insert into crm_import_rows (batch_id, row_no, ctdms_no, dealer_code, mobile, data, match_status, enquiry_id)
    values (v_batch, v_n, v_no, v_dealer, v_mobile, v_row,
            case when v_enquiry is null then 'missing_in_crm' else 'matched' end, v_enquiry);
    v_enquiry := null;
  end loop;

  -- Marked as entered, created inside the report's dates at a branch the report covers, yet absent.
  if p_from is not null and p_to is not null and v_dealers is not null then
    with flagged as (
      update enquiries e set crm_sync_status = 'mismatch'
      from outlets o
      where o.id = e.outlet_id and o.ctdms_dealer_code = any(v_dealers)
        and e.crm_sync_status = 'marked_done'
        and (e.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
        and not exists (select 1 from crm_import_rows r where r.batch_id = v_batch and r.enquiry_id = e.id)
      returning e.id
    )
    select count(*) into v_mismatch from flagged;
  end if;

  select array_agg(distinct so) into v_unknown_staff
  from (select ctdms_text(data, 'sales_officer') so from crm_import_rows where batch_id = v_batch and match_status = 'missing_in_crm') s
  where so is not null and ctdms_employee(so) is null;

  update crm_import_batches set summary = jsonb_build_object(
    'rows', v_n, 'matched', v_matched, 'missing_in_crm', v_missing, 'mismatch', v_mismatch,
    'reverified', v_reverified, 'unknown_sales_officers', coalesce(to_jsonb(v_unknown_staff), '[]'::jsonb))
  where id = v_batch;

  return (select summary || jsonb_build_object('batch_id', id) from crm_import_batches where id = v_batch);
end;
$$;

-- Create our enquiry from a CTDMS row we don't have. Assignee defaults to the row's Sales Officer;
-- model defaults to the row's suffix code. Either can be given when CTDMS's can't be resolved.
create or replace function create_enquiry_from_ctdms(p_row_id uuid, p_assigned_employee_id uuid default null, p_model_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r crm_import_rows%rowtype;
  v_assignee uuid;
  v_outlet uuid;
  v_model uuid;
  v_customer uuid;
  v_enquiry uuid;
  v_status text;
  v_mode text;
  v_date date;
begin
  if not is_crm_back_office() then
    raise exception 'Only back-office staff can create enquiries from CTDMS';
  end if;

  select * into r from crm_import_rows where id = p_row_id for update;
  if r.id is null then
    raise exception 'Import row not found';
  end if;
  if r.match_status <> 'missing_in_crm' then
    raise exception 'This CTDMS enquiry is already in our CRM';
  end if;
  -- Created meanwhile (from another upload's row): link this row to it instead.
  select id into v_enquiry from enquiries where ctdms_enquiry_no = r.ctdms_no;
  if v_enquiry is not null then
    update crm_import_rows set match_status = 'matched', enquiry_id = v_enquiry where id = r.id;
    return v_enquiry;
  end if;
  if r.mobile is null then
    raise exception 'The CTDMS row has no valid mobile number';
  end if;

  v_assignee := coalesce(p_assigned_employee_id, ctdms_employee(ctdms_text(r.data, 'sales_officer')));
  if v_assignee is null then
    raise exception 'Sales Officer "%" is not set up in our CRM; choose who to assign it to', ctdms_text(r.data, 'sales_officer');
  end if;
  v_outlet := coalesce((select id from outlets where ctdms_dealer_code = r.dealer_code),
                       (select outlet_id from employees where id = v_assignee));
  v_model := coalesce(p_model_id, ctdms_model(ctdms_text(r.data, 'suffix_code'), ctdms_text(r.data, 'model_name')));
  if v_model is null then
    raise exception 'Model "%" is not in the catalog; choose the model', coalesce(ctdms_text(r.data, 'suffix_code'), ctdms_text(r.data, 'model_name'));
  end if;

  v_status := upper(ctdms_text(r.data, 'status'));
  v_mode := ctdms_text(r.data, 'mode');
  if v_mode not in ('Walk-in', 'Dealer CAC Call-In', 'Dealer CAC Call-Out', 'TKM Digital', 'Dealer Digital',
                    'Cold Call(visit)', 'UIO Lead (Service)') or v_mode is null then
    v_mode := 'Other';
  end if;
  v_date := ctdms_date(ctdms_text(r.data, 'enquiry_date'));

  insert into customers (name, mobile, created_by_employee_id)
  values (coalesce(initcap(ctdms_text(r.data, 'customer_name')), 'Customer'), r.mobile, current_employee_id())
  on conflict (mobile) do update set name = customers.name
  returning id into v_customer;

  insert into enquiries (customer_id, outlet_id, assigned_employee_id, created_by_employee_id, purpose_of_visit,
                         model_id, variant_id, mode, source_desc, test_drive_given, temperature, stage, lost_reason,
                         ctdms_enquiry_no, ctdms_status, crm_sync_status, notes, created_at)
  values (v_customer, v_outlet, v_assignee, current_employee_id(), 'new_purchase', v_model,
          (select id from variants where tkm_suffix_code = upper(ctdms_text(r.data, 'suffix_code'))),
          v_mode, ctdms_text(r.data, 'source_desc'),
          upper(coalesce(ctdms_text(r.data, 'test_drive'), '')) in ('YES', 'Y'),
          case when v_status in ('HOT', 'WRM', 'CLD') then v_status else 'WRM' end,
          case when v_status in ('ORD', 'SCS') then 'booked' when v_status = 'DRP' then 'lost' else 'open' end,
          case when v_status = 'DRP' then 'Dropped in CTDMS' end,
          r.ctdms_no, v_status, 'verified', 'Created from the CTDMS enquiry report',
          coalesce(v_date::timestamp + interval '12 hours', now()))
  returning id into v_enquiry;

  update crm_import_rows set match_status = 'imported', enquiry_id = v_enquiry where id = r.id;
  return v_enquiry;
end;
$$;

-- "Done" on the To-enter-in-Toyota-CRM queue. The CTDMS enquiry number is optional; the next
-- report upload verifies either way.
create or replace function mark_enquiry_entered_in_ctdms(p_enquiry_id uuid, p_ctdms_enquiry_no text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_no text := upper(nullif(btrim(p_ctdms_enquiry_no), ''));
begin
  if not exists (
    select 1 from enquiries
    where id = p_enquiry_id
      and (is_crm_back_office() or can_access_employee_data(current_employee_id(), assigned_employee_id))
  ) then
    raise exception 'Enquiry not found';
  end if;
  if v_no is not null and exists (select 1 from enquiries where ctdms_enquiry_no = v_no and id <> p_enquiry_id) then
    raise exception 'CTDMS enquiry % is already linked to another enquiry', v_no;
  end if;

  update enquiries
  set crm_sync_status = 'marked_done', crm_marked_done_by = current_employee_id(), crm_marked_done_at = now(),
      ctdms_enquiry_no = coalesce(v_no, ctdms_enquiry_no)
  where id = p_enquiry_id and crm_sync_status in ('pending_entry', 'mismatch');
  if not found then
    raise exception 'This enquiry is already marked as entered in CTDMS';
  end if;
end;
$$;

-- ===== PO Order Listing (open orders of one branch) =====
-- p_rows: [{ order_no, order_date, order_status, model, suffix_code, color_code, vin, customer_code,
--            customer_name, institutional_group_type, organization_name, team_leader, sales_officer,
--            received_amount, icrop_enquiry_no, order_id }]
create or replace function import_ctdms_order_listing(p_file_name text, p_dealer_code text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch uuid;
  v_outlet uuid;
  v_dealer text := upper(btrim(p_dealer_code));
  v_row jsonb;
  v_n int := 0;
  v_no text;
  v_booking bookings%rowtype;
  v_so text;
  v_tl text;
  v_emp uuid;
  v_new uuid;
  v_inserted int := 0;
  v_updated int := 0;
  v_verified int := 0;
  v_closed text[];
  v_mismatch int := 0;
  v_new_staff text[] := '{}';
  v_order_nos text[] := '{}';
  v_open boolean;
begin
  if not is_crm_back_office() then
    raise exception 'Only back-office staff can upload CTDMS reports';
  end if;
  select id into v_outlet from outlets where ctdms_dealer_code = v_dealer;
  if v_outlet is null then
    raise exception 'Dealer code % is not one of our branches', p_dealer_code;
  end if;
  -- An empty list would close every open order, so it is treated as a bad upload.
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The order listing has no orders';
  end if;
  if jsonb_array_length(p_rows) > 20000 then
    raise exception 'Too many rows in one upload';
  end if;

  insert into crm_import_batches (kind, file_name, dealer_codes, row_count, uploaded_by)
  values ('order_listing', p_file_name, array[v_dealer], jsonb_array_length(p_rows), current_employee_id())
  returning id into v_batch;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    v_no := upper(ctdms_text(v_row, 'order_no'));
    if v_no is null then
      continue;
    end if;
    -- An export that also lists invoiced/cancelled orders only updates those, never adds them.
    v_open := lower(coalesce(ctdms_text(v_row, 'order_status'), 'booked')) in ('booked', 'accepted');
    if v_open then
      v_order_nos := v_order_nos || v_no;
    elsif not exists (select 1 from bookings where outlet_id = v_outlet and ctdms_order_booking_no = v_no) then
      continue;
    end if;
    v_so := upper(ctdms_text(v_row, 'sales_officer'));
    v_tl := upper(ctdms_text(v_row, 'team_leader'));

    -- Sales Officers are created on first sight, as the initial load did, reporting to their
    -- Team Leader when that person is known.
    v_emp := ctdms_employee(v_so);
    if v_emp is null and v_so is not null then
      insert into employees (name, role_id, outlet_id, reports_to_employee_id, ctdms_name)
      values (initcap(lower(v_so)), (select id from roles where rank = 5 order by name limit 1), v_outlet,
              ctdms_employee(v_tl), v_so)
      returning id into v_emp;
      v_new_staff := v_new_staff || v_so;
    end if;

    select * into v_booking from bookings where outlet_id = v_outlet and ctdms_order_booking_no = v_no;

    if v_booking.id is null then
      insert into bookings (outlet_id, employee_id, ctdms_order_booking_no, ctdms_order_id, ctdms_order_date,
                            ctdms_order_status, ctdms_customer_code, ctdms_icrop_enquiry_no, ctdms_suffix_code,
                            ctdms_color_code, ctdms_sales_officer, ctdms_team_leader, customer_name,
                            organization_name, institutional_group_type, received_amount, variant_id, color_id,
                            imported_from_ctdms, status, created_at)
      values (v_outlet, v_emp, v_no, ctdms_text(v_row, 'order_id'), ctdms_date(ctdms_text(v_row, 'order_date')),
              ctdms_text(v_row, 'order_status'), ctdms_text(v_row, 'customer_code'), ctdms_text(v_row, 'icrop_enquiry_no'),
              upper(ctdms_text(v_row, 'suffix_code')), upper(ctdms_text(v_row, 'color_code')), v_so, v_tl,
              ctdms_text(v_row, 'customer_name'), ctdms_text(v_row, 'organization_name'),
              ctdms_text(v_row, 'institutional_group_type'),
              nullif(regexp_replace(coalesce(v_row->>'received_amount', ''), '[^0-9.]', '', 'g'), '')::numeric,
              (select id from variants where tkm_suffix_code = upper(ctdms_text(v_row, 'suffix_code'))),
              (select id from colors where tkm_color_code = upper(ctdms_text(v_row, 'color_code'))),
              true, 'booked', coalesce(ctdms_date(ctdms_text(v_row, 'order_date'))::timestamptz, now()))
      returning id into v_new;
      v_inserted := v_inserted + 1;
      insert into crm_import_rows (batch_id, row_no, ctdms_no, dealer_code, data, match_status, booking_id)
      values (v_batch, v_n, v_no, v_dealer, v_row, 'inserted', v_new);
    else
      if not v_booking.imported_from_ctdms and v_booking.crm_sync_status <> 'verified' then
        v_verified := v_verified + 1;
      end if;
      -- CTDMS facts are refreshed; what our CRM owns (variant, colour, consultant) is kept.
      update bookings set
        ctdms_order_id = coalesce(ctdms_text(v_row, 'order_id'), ctdms_order_id),
        ctdms_order_date = coalesce(ctdms_date(ctdms_text(v_row, 'order_date')), ctdms_order_date),
        ctdms_order_status = ctdms_text(v_row, 'order_status'),
        ctdms_customer_code = coalesce(ctdms_text(v_row, 'customer_code'), ctdms_customer_code),
        ctdms_icrop_enquiry_no = coalesce(ctdms_text(v_row, 'icrop_enquiry_no'), ctdms_icrop_enquiry_no),
        ctdms_suffix_code = coalesce(upper(ctdms_text(v_row, 'suffix_code')), ctdms_suffix_code),
        ctdms_color_code = coalesce(upper(ctdms_text(v_row, 'color_code')), ctdms_color_code),
        ctdms_sales_officer = coalesce(v_so, ctdms_sales_officer),
        ctdms_team_leader = coalesce(v_tl, ctdms_team_leader),
        received_amount = coalesce(nullif(regexp_replace(coalesce(v_row->>'received_amount', ''), '[^0-9.]', '', 'g'), '')::numeric, received_amount),
        employee_id = coalesce(employee_id, v_emp),
        crm_sync_status = 'verified'
      where id = v_booking.id;
      v_updated := v_updated + 1;
      insert into crm_import_rows (batch_id, row_no, ctdms_no, dealer_code, data, match_status, booking_id)
      values (v_batch, v_n, v_no, v_dealer, v_row, 'updated', v_booking.id);
    end if;
  end loop;

  -- The listing is the branch's complete open-order list: imported orders missing from it have
  -- been invoiced or cancelled in CTDMS.
  with closed as (
    update bookings set ctdms_order_status = 'Closed in CTDMS'
    where outlet_id = v_outlet and imported_from_ctdms
      and ctdms_order_status in ('Booked', 'Accepted')
      and ctdms_order_booking_no <> all(v_order_nos)
    returning ctdms_order_booking_no
  )
  select array_agg(ctdms_order_booking_no order by ctdms_order_booking_no) into v_closed from closed;

  -- Ours, marked as entered with an order number, but not in CTDMS's open list.
  with flagged as (
    update bookings set crm_sync_status = 'mismatch'
    where outlet_id = v_outlet and not imported_from_ctdms
      and crm_sync_status = 'marked_done' and status not in ('delivered', 'cancelled')
      and ctdms_order_booking_no <> all(v_order_nos)
    returning id
  )
  select count(*) into v_mismatch from flagged;

  update crm_import_batches set summary = jsonb_build_object(
    'rows', v_n, 'inserted', v_inserted, 'updated', v_updated, 'verified', v_verified,
    'mismatch', v_mismatch, 'closed_in_ctdms', coalesce(to_jsonb(v_closed), '[]'::jsonb),
    'new_sales_officers', to_jsonb(v_new_staff))
  where id = v_batch;

  return (select summary || jsonb_build_object('batch_id', id) from crm_import_batches where id = v_batch);
end;
$$;

-- "Done" on the To-book-in-CTDMS queue: the CTDMS order number is required, since that is what
-- the next order listing is matched on.
create or replace function mark_booking_entered_in_ctdms(p_booking_id uuid, p_ctdms_order_no text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_no text := upper(regexp_replace(coalesce(p_ctdms_order_no, ''), '\s', '', 'g'));
  v_outlet uuid;
begin
  if v_no !~ '^ORD[0-9]{6,}$' then
    raise exception 'Enter the CTDMS order number, e.g. ORD261002345';
  end if;
  select outlet_id into v_outlet from bookings
  where id = p_booking_id and not imported_from_ctdms
    and (is_crm_back_office() or can_access_employee_data(current_employee_id(), employee_id));
  if v_outlet is null then
    raise exception 'Booking not found';
  end if;
  if exists (select 1 from bookings where outlet_id = v_outlet and ctdms_order_booking_no = v_no and id <> p_booking_id) then
    raise exception 'Order % is already linked to another booking', v_no;
  end if;

  update bookings
  set ctdms_order_booking_no = v_no, crm_sync_status = 'marked_done',
      crm_marked_done_by = current_employee_id(), crm_marked_done_at = now()
  where id = p_booking_id and crm_sync_status in ('pending_entry', 'mismatch', 'marked_done');
  if not found then
    raise exception 'This booking is already verified in CTDMS';
  end if;
end;
$$;

-- ===== Grants =====
revoke execute on function is_crm_back_office() from public, anon;
revoke execute on function import_ctdms_enquiry_report(text, date, date, jsonb) from public, anon;
revoke execute on function create_enquiry_from_ctdms(uuid, uuid, uuid) from public, anon;
revoke execute on function mark_enquiry_entered_in_ctdms(uuid, text) from public, anon;
revoke execute on function import_ctdms_order_listing(text, text, jsonb) from public, anon;
revoke execute on function mark_booking_entered_in_ctdms(uuid, text) from public, anon;
revoke execute on function bookings_default_crm_sync() from public, anon, authenticated;
revoke execute on function ctdms_employee(text) from public, anon, authenticated;
revoke execute on function ctdms_model(text, text) from public, anon, authenticated;
grant execute on function is_crm_back_office() to authenticated;
grant execute on function import_ctdms_enquiry_report(text, date, date, jsonb) to authenticated;
grant execute on function create_enquiry_from_ctdms(uuid, uuid, uuid) to authenticated;
grant execute on function mark_enquiry_entered_in_ctdms(uuid, text) to authenticated;
grant execute on function import_ctdms_order_listing(text, text, jsonb) to authenticated;
grant execute on function mark_booking_entered_in_ctdms(uuid, text) to authenticated;
