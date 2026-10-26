-- Welcome Docket: opened from a booking, accessories priced from the master, completion only when
-- every mandatory item is in, locked once complete, reopened only by an Outlet Head; documents and
-- storage follow the booking's access. Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/welcome_dockets.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000006');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000006');

create temp table t_ids (k text primary key, id uuid);
grant all on t_ids to authenticated;

with a as (
  insert into accessories (model_id, name, part_no, price)
  select id, 'Test Mud Flaps', 'PZ-TEST-1', 10000 from models where tkm_model_code = 'D22'
  returning id)
insert into t_ids select 'acc', id from a;
with a as (
  insert into accessories (model_id, name, part_no, price)
  select id, 'Other Model Mat', 'PZ-TEST-2', 500 from models where tkm_model_code <> 'D22' limit 1
  returning id)
insert into t_ids select 'acc_other', id from a;

create or replace function pg_temp.as_user(n int) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;

-- ---- SC1: final quote -> booking; the booking takes the quote's customer
set local role authenticated;
select pg_temp.as_user(5);
with q as (
  insert into quotes (outlet_id, employee_id, customer_name, customer_mobile, variant_id, color_id, rto_category_id, insurance_option)
  select '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Docket Buyer', '+91 98290 63147',
         v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium'
  from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ'
  returning id)
insert into t_ids select 'q', id from q;
select finalize_quote((select id from t_ids where k = 'q'));
with b as (
  insert into bookings (quote_id, outlet_id, employee_id, mode_of_purchase, data_consent)
  values ((select id from t_ids where k = 'q'), '00000000-0000-0000-0002-000000000001',
          '00000000-0000-0000-0003-000000000005', 'In House Finance', true)
  returning id)
insert into t_ids select 'b', id from b;

do $$
declare
  b bookings%rowtype;
  d welcome_dockets%rowtype;
  v_id uuid;
  r jsonb;
begin
  select * into b from bookings where id = (select id from t_ids where k = 'b');
  if b.customer_name <> 'Docket Buyer' or b.customer_mobile <> '+91 98290 63147' then
    raise exception 'booking customer not copied: % %', b.customer_name, b.customer_mobile;
  end if;

  v_id := open_welcome_docket(b.id);
  insert into t_ids values ('d', v_id);
  if open_welcome_docket(b.id) <> v_id then
    raise exception 'opening twice must return the same docket';
  end if;
  select * into d from welcome_dockets where id = v_id;
  if d.mobile <> '9829063147' or d.registration_use <> 'private' or d.status <> 'draft' then
    raise exception 'docket prefill wrong: % % %', d.mobile, d.registration_use, d.status;
  end if;

  -- Accessories: prices come from the master, not the client; 10% advance, rounded up.
  update welcome_dockets
  set accessory_order_items = jsonb_build_array(jsonb_build_object('accessory_id', (select id from t_ids where k = 'acc'), 'qty', 2, 'price', 1))
  where id = v_id;
  select * into d from welcome_dockets where id = v_id;
  if d.accessories_total <> 20000 or d.accessories_advance <> 2000 or d.accessory_order_items->0->>'part_no' <> 'PZ-TEST-1' then
    raise exception 'accessories order wrong: % % %', d.accessories_total, d.accessories_advance, d.accessory_order_items;
  end if;
  begin
    update welcome_dockets
    set accessory_order_items = jsonb_build_array(jsonb_build_object('accessory_id', (select id from t_ids where k = 'acc_other'), 'qty', 1))
    where id = v_id;
    raise exception 'other model accessory: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Accessory % is not for this model' then raise; end if;
  end;
  begin
    update welcome_dockets
    set accessory_order_items = jsonb_build_array(
      jsonb_build_object('accessory_id', (select id from t_ids where k = 'acc'), 'qty', 1),
      jsonb_build_object('accessory_id', (select id from t_ids where k = 'acc'), 'qty', 1))
    where id = v_id;
    raise exception 'duplicate accessory: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Each accessory can appear only once%' then raise; end if;
  end;

  -- Not complete yet: the missing list names what's left.
  r := complete_welcome_docket(v_id);
  if (r->>'completed')::boolean or not (r->'missing' ? 'Hypothecated to (financier)') or not (r->'missing' ? 'Customer signature')
     or not (r->'missing' ? 'Document: Aadhaar card') or not (r->'missing' ? 'Accessories payment mode') then
    raise exception 'missing list wrong: %', r;
  end if;

  begin
    update welcome_dockets set status = 'complete' where id = v_id;
    raise exception 'direct completion: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'A docket is completed or reopened only%' then raise; end if;
  end;

  -- Documents must sit under this booking's folder.
  begin
    insert into docket_documents (docket_id, doc_type, storage_path)
    values (v_id, 'aadhaar', gen_random_uuid() || '/aadhaar.jpg');
    raise exception 'document under another booking: expected an error';
  exception when insufficient_privilege then
    null;
  end;
  insert into docket_documents (docket_id, doc_type, storage_path) values
    (v_id, 'photo', b.id || '/docs/photo.jpg'),
    (v_id, 'aadhaar', b.id || '/docs/aadhaar-front.jpg');
  insert into docket_documents (docket_id, doc_type, collected_on_paper) values (v_id, 'pan_or_voter_id', true);

  update welcome_dockets set
    communication_address = '12 Civil Lines, Jaipur', address_type = 'residence', pin = '302006',
    father_or_husband_name = 'R. Buyer', registration_address = '12 Civil Lines, Jaipur',
    hypothecated_to = 'Toyota Financial Services', insurance_coverage = 'in_house', registration_period = 'permanent',
    rto_location = 'Jaipur (RJ14)', accessories_payment_mode = 'card', terms_accepted = true, rto_terms_accepted = true,
    customer_signature_path = b.id || '/signatures/customer.png', consultant_signature_path = b.id || '/signatures/consultant.png',
    referrals = '[{"name": "A Friend", "phone": "9876543210"}]'
  where id = v_id;

  r := complete_welcome_docket(v_id);
  if not (r->>'completed')::boolean then
    raise exception 'docket should complete: %', r;
  end if;

  begin
    update welcome_dockets set rto_location = 'Dausa' where id = v_id;
    raise exception 'editing a complete docket: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This Welcome Docket is complete%' then raise; end if;
  end;
  update welcome_dockets set pdf_storage_path = b.id || '/welcome-docket.pdf' where id = v_id;
  delete from docket_documents where docket_id = v_id;  -- blocked once complete
  if (select count(*) from docket_documents where docket_id = v_id) <> 3 then
    raise exception 'documents of a complete docket must not be deleted';
  end if;

  begin
    perform reopen_welcome_docket(v_id, 'wrong address');
    raise exception 'SC reopening: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only an Outlet Head%' then raise; end if;
  end;

  -- Storage: the consultant can upload under their booking.
  insert into storage.objects (bucket_id, name) values ('booking-documents', b.id || '/docs/photo.jpg');
end $$;

-- ---- SC2 sees neither the docket, its documents nor its files, and cannot open it
select pg_temp.as_user(6);
do $$
declare
  v_booking uuid := (select id from t_ids where k = 'b');
begin
  if exists (select 1 from welcome_dockets) or exists (select 1 from docket_documents)
     or exists (select 1 from storage.objects where bucket_id = 'booking-documents') then
    raise exception 'SC2 must not see SC1''s docket';
  end if;
  begin
    perform open_welcome_docket(v_booking);
    raise exception 'SC2 opening: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Booking not found%' then raise; end if;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('booking-documents', v_booking || '/docs/x.jpg');
    raise exception 'SC2 upload: expected an error';
  exception when insufficient_privilege then
    null;
  end;
end $$;

-- ---- The Outlet Head reopens it with a reason
select pg_temp.as_user(3);
do $$
declare
  d welcome_dockets%rowtype;
begin
  perform reopen_welcome_docket((select id from t_ids where k = 'd'), 'Registration address changed');
  select * into d from welcome_dockets where id = (select id from t_ids where k = 'd');
  if d.status <> 'draft' or d.reopened_reason <> 'Registration address changed' or d.pdf_storage_path is not null then
    raise exception 'reopen wrong: % % %', d.status, d.reopened_reason, d.pdf_storage_path;
  end if;
  update welcome_dockets set rto_location = 'Jaipur (RJ45)' where id = d.id;
end $$;

-- ---- A direct booking keeps the customer it was sent with and gets no dealer discount
select pg_temp.as_user(5);
do $$
declare
  b bookings%rowtype;
begin
  insert into bookings (outlet_id, employee_id, customer_name, customer_mobile, variant_id, color_id, rto_category_id,
                        insurance_option, mode_of_purchase, data_consent)
  select '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Walk In', '9414000000',
         v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium', 'Cash', true
  from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ'
  returning * into b;
  if b.customer_name <> 'Walk In' or b.customer_mobile <> '9414000000' or b.dealer_discount <> 0 then
    raise exception 'direct booking customer wrong: % %', b.customer_name, b.customer_mobile;
  end if;
  if (select mobile from welcome_dockets where id = open_welcome_docket(b.id)) <> '9414000000' then
    raise exception 'direct booking docket prefill wrong';
  end if;
end $$;

reset role;
select 'welcome_dockets tests passed' as result;
rollback;
