-- Enquiry capture: mobile normalisation + customer dedupe, assignment rules, RLS visibility, and
-- stage following quotes. Runs as the Phase 0 seed hierarchy (Jaipur SC1 / SC2 -> Team Leader ->
-- Outlet Head) inside a transaction that is rolled back. Scratch DB only:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/enquiries.sql
begin;

-- Local Postgres has no Supabase default grants; give the API role what Supabase gives it.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- Link seed employees to auth users so auth.uid() resolves them.
insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000006'), ('a0000000-0000-0000-0000-000000000004');
update employees set auth_user_id = 'a0000000-0000-0000-0000-000000000005' where id = '00000000-0000-0000-0003-000000000005';
update employees set auth_user_id = 'a0000000-0000-0000-0000-000000000006' where id = '00000000-0000-0000-0003-000000000006';
update employees set auth_user_id = 'a0000000-0000-0000-0000-000000000004' where id = '00000000-0000-0000-0003-000000000004';

create temp table t_ids (k text primary key, id uuid);
grant all on t_ids to authenticated;
insert into t_ids select 'model', id from models where tkm_model_code = 'D22';

-- ---- As Jaipur Sales Consultant 1
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);

insert into t_ids select 'e1', create_enquiry(jsonb_build_object(
  'mobile', '+91 98290 63147', 'name', 'Vinod Sharma', 'purpose_of_visit', 'new_purchase',
  'model_id', (select id from t_ids where k = 'model'), 'mode', 'Walk-in', 'temperature', 'HOT'));
insert into t_ids select 'e2', create_enquiry(jsonb_build_object(
  'mobile', '098290-63147', 'name', 'V. Sharma (typo)', 'purpose_of_visit', 'test_drive',
  'model_id', (select id from t_ids where k = 'model'), 'mode', 'Dealer CAC Call-In'));

do $$
begin
  if (select count(*) from customers where mobile = '9829063147') <> 1 then
    raise exception 'dedupe: expected one customer for both spellings of the number';
  end if;
  if (select name from customers where mobile = '9829063147') <> 'Vinod Sharma' then
    raise exception 'dedupe: the existing customer name must be kept';
  end if;
  if (select count(*) from enquiries) <> 2 then
    raise exception 'SC1 should see exactly their 2 enquiries, sees %', (select count(*) from enquiries);
  end if;
  if jsonb_array_length(find_customer('9829063147')->'open_enquiries') <> 2 then
    raise exception 'find_customer should list both open enquiries';
  end if;

  begin
    perform create_enquiry(jsonb_build_object('mobile', '12345', 'name', 'X', 'purpose_of_visit', 'other',
      'model_id', (select id from t_ids where k = 'model'), 'mode', 'Walk-in'));
    raise exception 'bad mobile: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Enter a valid 10-digit mobile%' then raise; end if;
  end;

  begin
    perform create_enquiry(jsonb_build_object('mobile', '9000011111', 'name', 'Y', 'purpose_of_visit', 'other',
      'model_id', (select id from t_ids where k = 'model'), 'mode', 'Walk-in',
      'assigned_employee_id', '00000000-0000-0000-0003-000000000006'));
    raise exception 'SC assigning to SC: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only a Team Leader%' then raise; end if;
  end;
end $$;

-- ---- As Jaipur Sales Consultant 2: cannot see SC1's enquiries or their customer
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000006', true);
do $$
begin
  if (select count(*) from enquiries) <> 0 or (select count(*) from customers) <> 0 then
    raise exception 'SC2 must not see SC1''s enquiries/customers';
  end if;
  -- ...but find_customer still warns that the number is already being handled.
  if (find_customer('9829063147')->'open_enquiries'->0->>'mine')::boolean then
    raise exception 'find_customer: SC1''s enquiry must not be flagged as SC2''s';
  end if;
end $$;

-- ---- As the Jaipur Team Leader: sees the team, can assign and reassign
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000004', true);
do $$
begin
  if (select count(*) from enquiries) <> 2 then
    raise exception 'TL should see the team''s enquiries';
  end if;
  perform create_enquiry(jsonb_build_object('mobile', '9414000000', 'name', 'Asha Meena', 'purpose_of_visit', 'exchange',
    'model_id', (select id from t_ids where k = 'model'), 'mode', 'TKM Digital', 'source_desc', 'TKM- Aggregator',
    'assigned_employee_id', '00000000-0000-0000-0003-000000000006'));
  perform reassign_enquiry((select id from t_ids where k = 'e2'), '00000000-0000-0000-0003-000000000006');
end $$;

-- ---- Back as SC1: the reassigned enquiry is gone from their list; they can close their own
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
do $$
begin
  if (select count(*) from enquiries) <> 1 then
    raise exception 'SC1 should now see 1 enquiry, sees %', (select count(*) from enquiries);
  end if;
  begin
    perform mark_enquiry_lost((select id from t_ids where k = 'e2'), 'Bought elsewhere');
    raise exception 'closing someone else''s enquiry: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Enquiry not found%' then raise; end if;
  end;
end $$;

-- ---- A quote from the enquiry moves it to "quoted" (as the database owner; quote pricing is
-- covered by price_list_pricing.sql)
reset role;
insert into quotes (outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option, enquiry_id)
select '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Vinod Sharma', v.id, c.id,
       '00000000-0000-0000-000b-000000000001', 'premium', (select id from t_ids where k = 'e1')
from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
do $$
begin
  if (select stage from enquiries where id = (select id from t_ids where k = 'e1')) <> 'quoted' then
    raise exception 'quote insert should move the enquiry to quoted';
  end if;
  raise notice 'enquiries: all checks passed';
end $$;

rollback;
