-- CTDMS daily sync: enquiry report matching / missing / mismatch, creating enquiries from CTDMS,
-- the Done buttons, and the order listing (insert, verify ours, close orders that left the list).
-- Synthetic rows only. Scratch DB, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/ctdms_sync.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000005');
update employees set auth_user_id = 'a0000000-0000-0000-0000-000000000003' where id = '00000000-0000-0000-0003-000000000003';
update employees set auth_user_id = 'a0000000-0000-0000-0000-000000000005' where id = '00000000-0000-0000-0003-000000000005';
update employees set ctdms_name = 'JAIPUR SC TWO' where id = '00000000-0000-0000-0003-000000000006';

create temp table t_ids (k text primary key, id uuid);
grant all on t_ids to authenticated;
insert into t_ids select 'model', id from models where tkm_model_code = 'D22';

-- Our own booking, entered later in CTDMS by its consultant (inserted as the owner; booking
-- pricing is covered elsewhere).
with b as (
  insert into bookings (outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option)
  select '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Test Buyer', v.id, c.id,
         '00000000-0000-0000-000b-000000000001', 'premium'
  from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ'
  returning id)
insert into t_ids select 'b1', id from b;
with b as (
  insert into bookings (outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                        ctdms_order_booking_no)
  select '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Second Buyer', v.id, c.id,
         '00000000-0000-0000-000b-000000000001', 'premium', 'ORD261005555'
  from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ'
  returning id)
insert into t_ids select 'b2', id from b;
-- An order imported earlier that has since been invoiced in CTDMS.
insert into bookings (outlet_id, ctdms_order_booking_no, ctdms_order_status, imported_from_ctdms, status)
values ('00000000-0000-0000-0002-000000000001', 'ORD261007777', 'Booked', true, 'booked'),
       ('00000000-0000-0000-0002-000000000001', 'ORD261007778', 'Accepted', true, 'booked');

do $$
begin
  if (select crm_sync_status from bookings where id = (select id from t_ids where k = 'b1')) <> 'pending_entry'
     or (select crm_sync_status from bookings where id = (select id from t_ids where k = 'b2')) <> 'marked_done'
     or (select crm_sync_status from bookings where ctdms_order_booking_no = 'ORD261007777') <> 'verified' then
    raise exception 'booking crm_sync_status defaults are wrong';
  end if;
end $$;

-- ---- As Jaipur SC1: two enquiries; one is marked as entered in CTDMS
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
insert into t_ids select 'e1', create_enquiry(jsonb_build_object('mobile', '9829063147', 'name', 'Matched Customer',
  'purpose_of_visit', 'new_purchase', 'model_id', (select id from t_ids where k = 'model'), 'mode', 'Walk-in'));
insert into t_ids select 'e2', create_enquiry(jsonb_build_object('mobile', '9000012345', 'name', 'Claimed Customer',
  'purpose_of_visit', 'new_purchase', 'model_id', (select id from t_ids where k = 'model'), 'mode', 'Walk-in'));
select mark_enquiry_entered_in_ctdms((select id from t_ids where k = 'e2'));
select mark_booking_entered_in_ctdms((select id from t_ids where k = 'b1'), 'ord 261009999');

do $$
begin
  if (select ctdms_order_booking_no from bookings where id = (select id from t_ids where k = 'b1')) <> 'ORD261009999' then
    raise exception 'order number should be normalised';
  end if;
  begin
    perform mark_booking_entered_in_ctdms((select id from t_ids where k = 'b1'), '12345');
    raise exception 'bad order number: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Enter the CTDMS order number%' then raise; end if;
  end;
  begin
    perform import_ctdms_enquiry_report('x.xls', (now() at time zone 'Asia/Kolkata')::date, (now() at time zone 'Asia/Kolkata')::date, '[{"enquiry_no":"ENQI1"}]');
    raise exception 'SC upload: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only back-office%' then raise; end if;
  end;
end $$;

-- ---- As the Jaipur Outlet Head (back office): upload the day's enquiry report
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000003', true);
do $$
declare
  s jsonb;
begin
  s := import_ctdms_enquiry_report('17092026_Enquiry_Survey_Report.xls', (now() at time zone 'Asia/Kolkata')::date, (now() at time zone 'Asia/Kolkata')::date, jsonb_build_array(
    jsonb_build_object('enquiry_no', 'ENQI260000001', 'enquiry_date', to_char((now() at time zone 'Asia/Kolkata')::date, 'DD/MM/YYYY'), 'dealer_code', 'JP05A',
      'customer_name', 'MR MATCHED', 'mobile', '9829063147', 'suffix_code', 'D22U4', 'status', 'HOT', 'mode', 'Walk-in',
      'sales_officer', 'SOMEONE'),
    jsonb_build_object('enquiry_no', 'ENQC260000002', 'enquiry_date', to_char((now() at time zone 'Asia/Kolkata')::date, 'DD/MM/YYYY'), 'dealer_code', 'JP05A',
      'customer_name', 'MR  NEW   PERSON', 'mobile', '9111111111', 'suffix_code', 'D22U4', 'status', 'ORD',
      'mode', 'TKM Digital', 'source_desc', 'TKM- Aggregator', 'test_drive', 'YES', 'sales_officer', 'UNKNOWN OFFICER'),
    -- CTDMS repeats an enquiry on a second survey line: counted once.
    jsonb_build_object('enquiry_no', 'ENQC260000002', 'dealer_code', 'JP05A', 'mobile', '9111111111', 'status', 'ORD'),
    jsonb_build_object('enquiry_no', 'ENQI260000003', 'enquiry_date', to_char((now() at time zone 'Asia/Kolkata')::date, 'DD/MM/YYYY'), 'dealer_code', 'JP05A',
      'customer_name', 'MR DROP', 'mobile', '9222222222', 'suffix_code', 'XYZ99', 'status', 'DRP', 'mode', 'Strange Mode',
      'sales_officer', 'JAIPUR SC TWO')));
  if (s->>'matched')::int <> 1 or (s->>'missing_in_crm')::int <> 2 or (s->>'mismatch')::int <> 1
     or s->'unknown_sales_officers' <> '["UNKNOWN OFFICER"]'::jsonb then
    raise exception 'enquiry report summary wrong: %', s;
  end if;
  if (select ctdms_enquiry_no || '/' || crm_sync_status || '/' || ctdms_status from enquiries where id = (select id from t_ids where k = 'e1'))
     <> 'ENQI260000001/verified/HOT' then
    raise exception 'e1 should be verified with its CTDMS number';
  end if;
  if (select crm_sync_status from enquiries where id = (select id from t_ids where k = 'e2')) <> 'mismatch' then
    raise exception 'e2 was marked entered but is not in the report: expected mismatch';
  end if;

  -- Missing in our CRM: unknown officer needs an assignee; unknown suffix needs a model.
  begin
    perform create_enquiry_from_ctdms((select id from crm_import_rows where ctdms_no = 'ENQC260000002'));
    raise exception 'unknown officer: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Sales Officer "UNKNOWN OFFICER"%' then raise; end if;
  end;
  insert into t_ids select 'e3', create_enquiry_from_ctdms((select id from crm_import_rows where ctdms_no = 'ENQC260000002'),
    '00000000-0000-0000-0003-000000000006');
  begin
    perform create_enquiry_from_ctdms((select id from crm_import_rows where ctdms_no = 'ENQI260000003'));
    raise exception 'unknown model: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Model "XYZ99"%' then raise; end if;
  end;
  insert into t_ids select 'e4', create_enquiry_from_ctdms((select id from crm_import_rows where ctdms_no = 'ENQI260000003'),
    null, (select id from t_ids where k = 'model'));
end $$;

do $$
begin
  if (select stage || '/' || crm_sync_status || '/' || mode || '/' || test_drive_given::text || '/' || c.name
      from enquiries e join customers c on c.id = e.customer_id where e.id = (select id from t_ids where k = 'e3'))
     <> 'booked/verified/TKM Digital/true/Mr New Person' then
    raise exception 'e3 fields wrong';
  end if;
  if (select stage || '/' || lost_reason || '/' || mode || '/' || assigned_employee_id::text from enquiries where id = (select id from t_ids where k = 'e4'))
     <> 'lost/Dropped in CTDMS/Other/00000000-0000-0000-0003-000000000006' then
    raise exception 'e4 fields wrong';
  end if;
  if (select count(*) from crm_import_rows where match_status = 'imported') <> 2 then
    raise exception 'imported rows should be marked';
  end if;
end $$;

-- The mismatched enquiry is entered again with its number; the next report verifies it.
select mark_enquiry_entered_in_ctdms((select id from t_ids where k = 'e2'), 'enqi260000009');
do $$
declare
  s jsonb;
begin
  s := import_ctdms_enquiry_report('next.xls', (now() at time zone 'Asia/Kolkata')::date, (now() at time zone 'Asia/Kolkata')::date, jsonb_build_array(
    jsonb_build_object('enquiry_no', 'ENQI260000009', 'dealer_code', 'JP05A', 'mobile', '9000012345', 'status', 'WRM')));
  if (s->>'matched')::int <> 1 or (select crm_sync_status from enquiries where id = (select id from t_ids where k = 'e2')) <> 'verified' then
    raise exception 'e2 should now be verified: %', s;
  end if;
end $$;

-- ---- Order listing for Jaipur
do $$
declare
  s jsonb;
begin
  s := import_ctdms_order_listing('24102026_PO_Order_Listing.xls', 'jp05a', jsonb_build_array(
    jsonb_build_object('order_no', 'ORD261009999', 'order_date', '24/10/2026', 'order_status', 'Accepted', 'order_id', '9500001',
      'customer_code', 'I26999999', 'suffix_code', 'D22U4', 'color_code', 'ZHJ', 'sales_officer', 'SOMEONE ELSE',
      'received_amount', '25,000.00'),
    jsonb_build_object('order_no', 'ORD261008888', 'order_date', '23/10/2026', 'order_status', 'Booked', 'order_id', '9500002',
      'customer_name', 'NEW ORDER CUSTOMER', 'suffix_code', 'D22U4', 'color_code', 'ZHJ', 'sales_officer', 'BRAND NEW OFFICER',
      'team_leader', 'JAIPUR SC TWO', 'received_amount', '11000'),
    -- An all-statuses export: invoiced orders update ours but are never added.
    jsonb_build_object('order_no', 'ORD261007778', 'order_status', 'Invoiced'),
    jsonb_build_object('order_no', 'ORD261006666', 'order_status', 'Invoiced', 'sales_officer', 'NOT CREATED')));
  if (s->>'inserted')::int <> 1 or (s->>'updated')::int <> 2 or (s->>'verified')::int <> 1 or (s->>'mismatch')::int <> 1
     or s->'closed_in_ctdms' <> '["ORD261007777"]'::jsonb or s->'new_sales_officers' <> '["SOMEONE ELSE", "BRAND NEW OFFICER"]'::jsonb then
    raise exception 'order listing summary wrong: %', s;
  end if;
  if (select crm_sync_status || '/' || ctdms_order_status || '/' || received_amount::text || '/' || employee_id::text
      from bookings where id = (select id from t_ids where k = 'b1'))
     <> 'verified/Accepted/25000.00/00000000-0000-0000-0003-000000000005' then
    raise exception 'our booking should be verified, keeping its consultant';
  end if;
  if (select crm_sync_status from bookings where id = (select id from t_ids where k = 'b2')) <> 'mismatch' then
    raise exception 'b2 is not in the open list: expected mismatch';
  end if;
  if (select ctdms_order_status from bookings where ctdms_order_booking_no = 'ORD261007777') <> 'Closed in CTDMS'
     or (select ctdms_order_status from bookings where ctdms_order_booking_no = 'ORD261007778') <> 'Invoiced'
     or exists (select 1 from bookings where ctdms_order_booking_no = 'ORD261006666') then
    raise exception 'closed / invoiced orders handled wrongly';
  end if;
  if (select e.name || '/' || tl.id::text from bookings b join employees e on e.id = b.employee_id
      join employees tl on tl.id = e.reports_to_employee_id where b.ctdms_order_booking_no = 'ORD261008888')
     <> 'Brand New Officer/00000000-0000-0000-0003-000000000006' then
    raise exception 'new order should create its Sales Officer under the named Team Leader';
  end if;
  begin
    perform import_ctdms_order_listing('empty.xls', 'JP05A', '[]');
    raise exception 'empty listing: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'The order listing has no orders%' then raise; end if;
  end;
  begin
    perform import_ctdms_order_listing('x.xls', 'ZZ99Z', '[{"order_no":"ORD1"}]');
    raise exception 'unknown dealer: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Dealer code ZZ99Z%' then raise; end if;
  end;
  if (select count(*) from crm_import_batches) <> 3 then
    raise exception 'back office should see the 3 batches';
  end if;
end $$;

-- ---- SC1 sees no import data
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
do $$
begin
  if (select count(*) from crm_import_batches) <> 0 or (select count(*) from crm_import_rows) <> 0 then
    raise exception 'consultants must not see import batches';
  end if;
  raise notice 'ctdms_sync: all checks passed';
end $$;

rollback;
