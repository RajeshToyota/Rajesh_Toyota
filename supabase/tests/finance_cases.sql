-- Finance cases:
--   - who can open a case, collect documents, change terms and move stages
--   - the stage order and what each stage needs (documents for login, terms for sanction, DO, disbursement)
--   - the EMI, rejection and a fresh case after it
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/finance_cases.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000005'),
  ('a0000000-0000-0000-0000-000000000006'), ('a0000000-0000-0000-0000-00000000000b'),
  ('a0000000-0000-0000-0000-00000000000c');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000006');
-- Finance Executives at Jaipur (b) and Jodhpur (c).
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-00000000000b', 'a0000000-0000-0000-0000-00000000000b', 'Jaipur Finance',
   '00000000-0000-0000-0001-000000000008', '00000000-0000-0000-0002-000000000001'),
  ('00000000-0000-0000-0003-00000000000c', 'a0000000-0000-0000-0000-00000000000c', 'Jodhpur Finance',
   '00000000-0000-0000-0001-000000000008', '00000000-0000-0000-0002-000000000002');

insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                      mode_of_purchase, data_consent)
select '00000000-0000-0000-00bb-0000000000f1', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005',
       'Finance Buyer', v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium', 'In House Finance', true
from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';

create temp table t_ids (k text primary key, id uuid);
grant all on t_ids to authenticated;

create or replace function pg_temp.as_user(n text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;

set local role authenticated;

-- ---- SC2 can't see SC1's booking, so can't open a case for it
select pg_temp.as_user('6');
do $$
begin
  begin
    perform open_finance_case('00000000-0000-0000-00bb-0000000000f1', (select id from financiers where short_name = 'SBI'), 'salaried');
    raise exception 'SC2 opening: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Booking not found%' then raise; end if;
  end;
end $$;

-- ---- SC1 opens the case and collects documents, but can't change terms or stages
select pg_temp.as_user('5');
do $$
declare
  v_id uuid;
begin
  v_id := open_finance_case('00000000-0000-0000-00bb-0000000000f1', (select id from financiers where short_name = 'SBI'), 'salaried');
  insert into t_ids values ('c1', v_id);
  if open_finance_case('00000000-0000-0000-00bb-0000000000f1', (select id from financiers where short_name = 'HDFC'), 'salaried') <> v_id then
    raise exception 'a booking has one live case';
  end if;
  if (select count(*) from finance_case_events where case_id = v_id) <> 1 then
    raise exception 'opening should be logged';
  end if;
  if cardinality(finance_missing_documents(v_id)) <> 7 then
    raise exception 'salaried checklist should need 7 documents: %', finance_missing_documents(v_id);
  end if;

  insert into finance_documents (case_id, doc_type, storage_path) values
    (v_id, 'pan', '00000000-0000-0000-00bb-0000000000f1/finance/pan.jpg'),
    (v_id, 'aadhaar', '00000000-0000-0000-00bb-0000000000f1/finance/aadhaar.jpg');
  insert into finance_documents (case_id, doc_type, collected_on_paper) values
    (v_id, 'photo', true), (v_id, 'address_proof', true), (v_id, 'salary_slips', true), (v_id, 'form_16', true);
  begin
    insert into finance_documents (case_id, doc_type, storage_path) values (v_id, 'bank_statement', 'elsewhere/finance/x.jpg');
    raise exception 'document outside the booking folder: expected an error';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform update_finance_case(v_id, '{"loan_amount": 1500000}');
    raise exception 'SC changing terms: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only the branch''s Finance Executive%' then raise; end if;
  end;
  begin
    perform move_finance_case(v_id, 'logged_in');
    raise exception 'SC moving: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only the branch''s Finance Executive%' then raise; end if;
  end;
end $$;

-- ---- Jodhpur's Finance Executive sees nothing of Jaipur's case
select pg_temp.as_user('c');
do $$
begin
  if exists (select 1 from finance_cases) or exists (select 1 from bookings) then
    raise exception 'Jodhpur finance must not see Jaipur cases';
  end if;
  begin
    perform move_finance_case((select id from t_ids where k = 'c1'), 'logged_in');
    raise exception 'Jodhpur finance moving: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Only the branch''s Finance Executive%' then raise; end if;
  end;
end $$;

-- ---- Jaipur's Finance Executive works the case through
select pg_temp.as_user('b');
do $$
declare
  v_id uuid := (select id from t_ids where k = 'c1');
  c finance_cases%rowtype;
begin
  if (select customer_name from bookings where id = '00000000-0000-0000-00bb-0000000000f1') <> 'Finance Buyer' then
    raise exception 'Finance Executive should see the branch''s booking';
  end if;
  begin
    perform move_finance_case(v_id, 'logged_in');
    raise exception 'login without bank statement: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Documents still needed before login: Last 6 months bank statement%' then raise; end if;
  end;
  insert into finance_documents (case_id, doc_type, storage_path)
  values (v_id, 'bank_statement', '00000000-0000-0000-00bb-0000000000f1/finance/bank.pdf');

  begin
    perform move_finance_case(v_id, 'sanctioned');
    raise exception 'skipping login: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'A case moves one stage at a time%' then raise; end if;
  end;
  perform move_finance_case(v_id, 'logged_in', 'Logged in with SBI Civil Lines');
  begin
    perform move_finance_case(v_id, 'sanctioned');
    raise exception 'sanction without terms: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Enter the sanctioned loan amount%' then raise; end if;
  end;

  -- 15,00,000 for 60 months at 9% -> EMI 31,138.
  perform update_finance_case(v_id, '{"loan_amount": 1500000, "tenure_months": 60, "roi_percent": 9, "processing_fee": 5000, "application_no": "SBI-77"}');
  select * into c from finance_cases where id = v_id;
  if c.emi <> 31138 or c.login_date is null or c.application_no <> 'SBI-77' then
    raise exception 'terms wrong: emi % login % app %', c.emi, c.login_date, c.application_no;
  end if;
  perform move_finance_case(v_id, 'sanctioned');
  begin
    perform move_finance_case(v_id, 'do_received');
    raise exception 'DO stage without DO: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Enter the DO number%' then raise; end if;
  end;
  perform update_finance_case(v_id, jsonb_build_object('do_number', 'DO-123', 'do_amount', 1500000, 'do_date', current_date));
  perform move_finance_case(v_id, 'do_received');
  perform update_finance_case(v_id, jsonb_build_object('disbursed_amount', 1495000, 'disbursed_date', current_date));
  perform move_finance_case(v_id, 'disbursed');

  select * into c from finance_cases where id = v_id;
  if c.status <> 'disbursed' or c.sanction_date is null
     or (select count(*) from finance_case_events where case_id = v_id) <> 5 then
    raise exception 'case history wrong: % %', c.status, (select count(*) from finance_case_events where case_id = v_id);
  end if;
  begin
    perform update_finance_case(v_id, '{"loan_amount": 1}');
    raise exception 'editing a closed case: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This case is closed%' then raise; end if;
  end;
end $$;

-- ---- A rejected case closes; a new case can then be opened with another financier
reset role;
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                      mode_of_purchase, data_consent)
select '00000000-0000-0000-00bb-0000000000f2', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005',
       'Second Finance Buyer', v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium', 'In House Finance', true
from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
set local role authenticated;
select pg_temp.as_user('3');
do $$
declare
  v_first uuid;
  v_second uuid;
begin
  v_first := open_finance_case('00000000-0000-0000-00bb-0000000000f2', (select id from financiers where short_name = 'AU'), 'company');
  begin
    perform move_finance_case(v_first, 'rejected');
    raise exception 'rejection without reason: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Give the reason%' then raise; end if;
  end;
  perform move_finance_case(v_first, 'rejected', 'CIBIL score too low');
  v_second := open_finance_case('00000000-0000-0000-00bb-0000000000f2', (select id from financiers where short_name = 'TFS'), 'company');
  if v_second = v_first or (select status from finance_cases where id = v_first) <> 'rejected'
     or (select rejection_reason from finance_cases where id = v_first) <> 'CIBIL score too low' then
    raise exception 'rejected case should stay, with a new case opened';
  end if;
  if cardinality(finance_missing_documents(v_second)) <> 8 then
    raise exception 'company checklist should need 8 documents: %', finance_missing_documents(v_second);
  end if;
end $$;

reset role;
select 'finance_cases tests passed' as result;
rollback;
