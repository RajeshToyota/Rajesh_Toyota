-- Finance: several banks per booking, verified lock, claims & payouts (Phase 29):
--   - a booking logged with two financiers; the first DO makes the final (HPN) financier; the pool
--     reads the lead case
--   - going back needs a note; gates still apply when skipping stages
--   - verify needs the disbursement; a verified case is frozen; unverify needs approve + reason
--   - claim: % of DO and per-file rates, add-on only above the target, GST added unless included,
--     per branch when the financier invoices by branch; steps and undo
--   - salesperson payout released only after the bank's UTR
--   - EMI options by CIBIL band; overlapping bands refused
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/finance_claims.sql
begin;
set constraints all immediate;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000002'), ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000005');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000002', '00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005');

create or replace function pg_temp.as_user(n text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;
create or replace function pg_temp.expect_error(sql text, msg text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if sqlerrm not like msg || '%' then raise exception 'expected "%" but got "%"', msg, sqlerrm; end if;
    return;
  end;
  raise exception 'expected error "%" from: %', msg, sql;
end $$;

create temp table t_cases (k text primary key, id uuid);
grant all on t_cases to authenticated;

-- Two financiers: A pays 1% of DO to the dealer, ₹2,000 per file to the CA, add-on 0.5% above ₹20 lakh,
-- GST on top; B pays ₹5,000 per file, GST included, invoiced branch by branch.
insert into financiers (id, name, bank_payout_basis, bank_payout_rate, ca_payout_basis, ca_payout_rate, addon_payout_basis,
                        addon_payout_rate, addon_target_amount, gst_included, invoice_by_branch)
values ('fa000000-0000-0000-0000-00000000000a', 'Bank A', 'percent', 1, 'per_file', 2000, 'percent', 0.5, 2000000, false, false),
       ('fa000000-0000-0000-0000-00000000000b', 'Bank B', 'per_file', 5000, 'percent', 0, 'percent', 0, null, true, true);
insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option)
select ('00000000-0000-0000-00ee-00000000000' || n)::uuid, '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005',
       'Loan Buyer ' || n, v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium'
from generate_series(1, 3) n, variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';

set local role authenticated;
select pg_temp.as_user('3');
do $$
declare
  a uuid;
  b uuid;
  p jsonb := '{"loan_amount": 1500000, "tenure_months": 60, "roi_percent": 9, "do_number": "DO1", "do_amount": 1400000, "do_date": "2026-11-05"}';
begin
  -- Booking 1 with both banks (company applicants need no listed documents in the seed? use own finance to skip docs)
  a := open_finance_case('00000000-0000-0000-00ee-000000000001', 'fa000000-0000-0000-0000-00000000000a', 'salaried', 'in_house');
  b := open_finance_case('00000000-0000-0000-00ee-000000000001', 'fa000000-0000-0000-0000-00000000000b', 'salaried', 'in_house');
  if a = b then raise exception 'two financiers, two cases'; end if;
  insert into t_cases values ('a', a), ('b', b);
end $$;
reset role;
-- Documents for both cases (the checklist), as the consultant would have uploaded.
insert into finance_documents (case_id, doc_type, collected_on_paper)
select c.id, t.id, true from finance_cases c cross join finance_document_types t where c.booking_id = '00000000-0000-0000-00ee-000000000001' and 'salaried' = any(t.required_for);
set local role authenticated;
select pg_temp.as_user('3');
do $$
declare
  a uuid := (select id from t_cases where k = 'a');
  b uuid := (select id from t_cases where k = 'b');
begin
  begin
    perform move_finance_case(a, 'do_received');
    raise exception 'skipping to DO without details: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Enter the sanctioned loan amount%' then raise; end if;
  end;
  perform update_finance_case(a, '{"loan_amount": 1500000, "tenure_months": 60, "roi_percent": 9, "do_number": "DO-A", "do_amount": 1400000, "do_date": "2026-11-05"}');
  perform move_finance_case(a, 'do_received');
  perform move_finance_case(b, 'credit_review');
  if (select final_financier_id from bookings where id = '00000000-0000-0000-00ee-000000000001') <> 'fa000000-0000-0000-0000-00000000000a' then
    raise exception 'first DO is the final financier';
  end if;
  if booking_lead_finance_case_id('00000000-0000-0000-00ee-000000000001') <> a then raise exception 'lead case is the DO case'; end if;
  begin
    perform move_finance_case(a, 'sanctioned');
    raise exception 'going back without a note: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Give the reason%' then raise; end if;
  end;
  perform update_finance_case(a, '{"disbursed_amount": 1400000, "disbursed_date": "2026-11-10", "net_disbursement_amount": 1390000}');
  perform move_finance_case(a, 'disbursed');
  if (select disbursement_month from finance_cases where id = a) <> date '2026-11-01' then raise exception 'disbursement month'; end if;
  perform move_finance_case(b, 'rejected', 'Customer chose Bank A');
end $$;

-- Verified lock
do $$
declare
  a uuid := (select id from t_cases where k = 'a');
begin
  perform set_case_verified(a, true);
  begin
    perform update_finance_case(a, '{"net_disbursement_amount": 1}');
    raise exception 'editing a verified case: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This case is verified%' then raise; end if;
  end;
  begin
    perform move_finance_case(a, 'do_received', 'oops');
    raise exception 'moving a verified case: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This case is verified%' then raise; end if;
  end;
end $$;
select pg_temp.as_user('5');
select pg_temp.expect_error($$select set_case_verified((select id from t_cases where k = 'a'), false, 'x')$$, 'Case not found');

-- Two more verified, disbursed cases straight in (as postgres): Bank A for booking 2 (₹9 lakh), Bank B for booking 3.
reset role;
insert into finance_cases (booking_id, outlet_id, financier_id, applicant_type, status, loan_amount, do_amount, disbursed_amount,
                           disbursed_date, disbursement_month, verified)
values ('00000000-0000-0000-00ee-000000000002', '00000000-0000-0000-0002-000000000001', 'fa000000-0000-0000-0000-00000000000a', 'salaried',
        'disbursed', 900000, 900000, 900000, '2026-11-12', '2026-11-01', true),
       ('00000000-0000-0000-00ee-000000000003', '00000000-0000-0000-0002-000000000001', 'fa000000-0000-0000-0000-00000000000b', 'salaried',
        'disbursed', 800000, 800000, 800000, '2026-11-12', '2026-11-01', true);

-- ===== Claims =====
set local role authenticated;
select pg_temp.as_user('2');
do $$
declare
  r record;
  v_claim uuid;
begin
  -- Bank A: DO 13,90,000 (net) + 9,00,000 = 22,90,000 ≥ 20 lakh target. Bank 1% = 22,900; CA 2 files × 2,000 = 4,000;
  -- add-on 0.5% = 11,450; payout 38,350; + 18% GST = 45,253.
  select * into r from finance_claims_summary('2026-11-15') where financier = 'Bank A';
  if r.files <> 2 or r.total_do <> 2290000 or r.bank_payout <> 22900 or r.ca_payout <> 4000 or not r.addon_eligible
     or r.addon_payout <> 11450 or r.expected_invoice <> 45253 or r.outlet_id is not null then
    raise exception 'Bank A claim wrong: %', r;
  end if;
  -- Bank B: per branch, 1 file × 5,000, GST included: taxable 4,237.29, GST 762.71.
  select * into r from finance_claims_summary('2026-11-15') where financier = 'Bank B';
  if r.outlet_id is null or r.bank_payout <> 5000 or r.expected_invoice <> 5000 or r.taxable <> 4237.29 or r.gst <> 762.71 then
    raise exception 'Bank B claim wrong: %', r;
  end if;

  v_claim := claim_generate('2026-11-01', 'fa000000-0000-0000-0000-00000000000a', null);
  begin
    perform claim_step(v_claim, 'bank_received', '{"utr": "U1"}');
    raise exception 'paid before invoiced: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Raise the invoice first%' then raise; end if;
  end;
  perform claim_step(v_claim, 'invoice', '{"invoice_no": "INV-A-11", "invoice_date": "2026-11-30", "invoice_amount": 45253}');
  -- Salesperson payout held until the bank pays.
  if exists (select 1 from finance_sp_payouts('2026-11-01') where financier = 'Bank A' and released) then raise exception 'held until UTR'; end if;
  perform claim_step(v_claim, 'bank_received', '{"utr": "UTR-A-1"}');
  if (select sum(amount) from finance_sp_payouts('2026-11-01') where financier = 'Bank A' and released) <> round(2290000 * 0.005, 2) then
    raise exception 'salesperson payout 0.5%% of DO released';
  end if;
  perform claim_step(v_claim, 'settled', '{"utr": "UTR-CA-1"}');
  perform claim_step(v_claim, 'undo');
  if (select status from bank_claims where id = v_claim) <> 'bank_received' then raise exception 'undo steps back'; end if;
  -- An invoiced claim stops the month's cases being unverified.
  begin
    perform set_case_verified((select id from t_cases where k = 'a'), false, 'wrong amount');
    raise exception 'unverify under an invoiced claim: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This month''s claim%' then raise; end if;
  end;
end $$;
select pg_temp.as_user('3');
select pg_temp.expect_error($$select claim_step((select id from bank_claims limit 1), 'undo')$$, 'Undoing a step needs Claims & Payouts: approve');

-- ===== EMI options =====
reset role;
insert into financier_emi_terms (financier_id, max_tenure_months, max_ltv_percent, fee_type, fee_value)
values ('fa000000-0000-0000-0000-00000000000a', 84, 90, 'percent', 0.5);
insert into financier_rate_slabs (financier_id, cibil_from, cibil_to, roi_percent) values ('fa000000-0000-0000-0000-00000000000a', 750, 900, 8.75);
do $$ begin
  begin
    insert into financier_rate_slabs (financier_id, cibil_from, cibil_to, roi_percent) values ('fa000000-0000-0000-0000-00000000000a', 700, 760, 9.5);
    raise exception 'overlap: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This CIBIL band overlaps%' then raise; end if;
  end;
  if (select roi_percent from finance_emi_options(2000000, 1500000, 60, 780) where financier = 'Bank A') <> 8.75 then raise exception 'rate by band'; end if;
  if (select within_limits from finance_emi_options(2000000, 1900000, 60, 780) where financier = 'Bank A') then raise exception 'LTV 90%% caps the loan'; end if;
end $$;

select 'finance_claims: all checks passed';
rollback;
