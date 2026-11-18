-- Phase 29: Finance — Banks, Finance Cases (several banks per booking), Claims & Payouts, with
-- Techwheels' logic.
--
-- Banks (financiers): contacts, payout portal, payout rates (bank, CA, add-on; each a % of DO or a
-- fixed amount per file), the add-on target and its period, whether the payout includes GST, whether
-- the bank is invoiced branch by branch, the claim-letter format; branches; EMI terms and CIBIL rate
-- slabs (no overlapping bands); a round-robin pool that hands new cases to finance executives.
--
-- Finance cases: a booking can be logged with several financiers at once, at most one live case per
-- financier. Status moves freely (banks reverse decisions), but reaching a stage still needs what RT
-- always required (documents before login, terms before sanction, DO details before DO received,
-- the disbursement before disbursed), and going back or on hold needs a note. The first case to reach
-- DO received becomes the booking's final (HPN) financier. booking_lead_finance_case_id() picks the
-- case every single-case screen shows: the most advanced live one.
--
-- Verified lock (Techwheels' finance_set_case_verified): a verified case's disbursement fields are
-- frozen from every path; unverifying needs Finance Cases: approve; each verify / unverify is logged
-- with a snapshot.
--
-- Claims & Payouts (Techwheels' finance_claims_payouts): verified, disbursed cases of a month grouped
-- by financier and branch (or all branches); DO = net disbursement, else DO amount, else loan;
-- payout = % of total DO or files × rate; the add-on only when the month's DO reaches the target;
-- expected invoice = payout, plus 18% GST unless included. One claim row per month + financier
-- (+ branch): generated → invoice → bank UTR → CA / add-on UTR, undo by the approver.
--
-- Salesperson finance payout: a share of DO (0.5% by default) per in-house case, released only once
-- the bank's payout for that month, financier and branch has arrived; one row per case.

-- ===== Banks =====
alter table financiers
  add column executive_name text,
  add column executive_mobile text,
  add column manager_name text,
  add column manager_mobile text,
  add column payout_portal_url text,
  add column payout_portal_username text,
  add column bank_payout_basis text not null default 'percent' check (bank_payout_basis in ('percent', 'per_file')),
  add column bank_payout_rate numeric not null default 0 check (bank_payout_rate >= 0),
  add column ca_payout_basis text not null default 'percent' check (ca_payout_basis in ('percent', 'per_file')),
  add column ca_payout_rate numeric not null default 0 check (ca_payout_rate >= 0),
  add column addon_payout_basis text not null default 'percent' check (addon_payout_basis in ('percent', 'per_file')),
  add column addon_payout_rate numeric not null default 0 check (addon_payout_rate >= 0),
  add column addon_target_amount numeric check (addon_target_amount >= 0),
  add column target_period text not null default 'monthly' check (target_period in ('monthly', 'quarterly')),
  add column gst_included boolean not null default false,
  add column invoice_by_branch boolean not null default false,
  add column letter_format text not null default 'generic' check (letter_format in ('generic', 'claim_letter', 'tax_invoice'));

create table financier_branches (
  id uuid primary key default gen_random_uuid(),
  financier_id uuid not null references financiers(id) on delete cascade,
  name text not null,
  city text,
  contact_name text,
  contact_mobile text,
  is_active boolean not null default true,
  unique (financier_id, name)
);

create table financier_emi_terms (
  id uuid primary key default gen_random_uuid(),
  financier_id uuid not null references financiers(id) on delete cascade,
  vehicle_class text not null default 'car',
  max_tenure_months int not null check (max_tenure_months between 12 and 120),
  max_ltv_percent numeric not null check (max_ltv_percent > 0 and max_ltv_percent <= 100),
  fee_type text not null default 'nil' check (fee_type in ('nil', 'flat', 'percent')),
  fee_value numeric not null default 0 check (fee_value >= 0),
  fee_min numeric,
  fee_max numeric,
  valid_from date not null default current_date,
  valid_to date,
  check (fee_type <> 'percent' or fee_value <= 10),
  check (valid_to is null or valid_to >= valid_from)
);
create index idx_financier_emi_terms_financier on financier_emi_terms(financier_id);

create table financier_rate_slabs (
  id uuid primary key default gen_random_uuid(),
  financier_id uuid not null references financiers(id) on delete cascade,
  is_no_score boolean not null default false,
  cibil_from int check (cibil_from between 300 and 900),
  cibil_to int check (cibil_to between 300 and 900),
  roi_percent numeric not null check (roi_percent > 0 and roi_percent <= 30),
  roi_above_5yr_percent numeric check (roi_above_5yr_percent > 0 and roi_above_5yr_percent <= 30),
  max_tenure_months int check (max_tenure_months between 12 and 120),
  max_ltv_percent numeric check (max_ltv_percent > 0 and max_ltv_percent <= 100),
  check (is_no_score or (cibil_from is not null and cibil_to is not null and cibil_to >= cibil_from)),
  check (not is_no_score or (cibil_from is null and cibil_to is null))
);
create index idx_financier_rate_slabs_financier on financier_rate_slabs(financier_id);

-- Bands of one financier never overlap, and there is at most one no-score slab.
create or replace function financier_rate_slabs_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1 from financier_rate_slabs s
    where s.financier_id = NEW.financier_id and s.id <> NEW.id
      and ((NEW.is_no_score and s.is_no_score)
           or (not NEW.is_no_score and not s.is_no_score and s.cibil_from <= NEW.cibil_to and NEW.cibil_from <= s.cibil_to))
  ) then
    raise exception 'This CIBIL band overlaps another band of the same financier';
  end if;
  return NEW;
end;
$$;
create trigger trg_financier_rate_slabs_guard before insert or update on financier_rate_slabs
  for each row execute function financier_rate_slabs_guard();

-- What each financier would offer: rate by CIBIL band, the tenure and LTV caps, fee and EMI.
create or replace function finance_emi_options(p_vehicle_price numeric, p_loan numeric, p_months int, p_cibil int default null)
returns table (financier_id uuid, financier text, roi_percent numeric, max_tenure_months int, max_ltv_percent numeric,
               loan_allowed numeric, fee numeric, emi numeric, within_limits boolean)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.name, r.roi,
         least(t.max_tenure_months, coalesce(s.max_tenure_months, t.max_tenure_months)),
         least(t.max_ltv_percent, coalesce(s.max_ltv_percent, t.max_ltv_percent)),
         round(p_vehicle_price * least(t.max_ltv_percent, coalesce(s.max_ltv_percent, t.max_ltv_percent)) / 100),
         case t.fee_type when 'nil' then 0 when 'flat' then t.fee_value
              else greatest(coalesce(t.fee_min, 0), least(coalesce(t.fee_max, 1e12), round(p_loan * t.fee_value / 100))) end,
         finance_emi(p_loan, r.roi, p_months),
         p_months <= least(t.max_tenure_months, coalesce(s.max_tenure_months, t.max_tenure_months))
           and p_loan <= round(p_vehicle_price * least(t.max_ltv_percent, coalesce(s.max_ltv_percent, t.max_ltv_percent)) / 100)
  from financiers f
  join lateral (select * from financier_emi_terms t where t.financier_id = f.id and t.valid_from <= current_date
                and (t.valid_to is null or t.valid_to >= current_date) order by t.valid_from desc limit 1) t on true
  join lateral (select * from financier_rate_slabs s where s.financier_id = f.id
                and ((p_cibil is null and s.is_no_score) or (p_cibil between s.cibil_from and s.cibil_to)) limit 1) s on true
  cross join lateral (select case when p_months > 60 then coalesce(s.roi_above_5yr_percent, s.roi_percent) else s.roi_percent end as roi) r
  where f.is_active
  order by finance_emi(p_loan, r.roi, p_months);
$$;

-- Round robin: a new case goes to the executive of the branch who was given one longest ago, among
-- those allowed to work that financier.
create table finance_assign_pool (
  employee_id uuid primary key references employees(id) on delete cascade,
  outlet_id uuid not null references outlets(id),
  is_active boolean not null default true,
  last_assigned_at timestamptz
);
create index idx_finance_assign_pool_outlet on finance_assign_pool(outlet_id);

-- ===== Finance cases =====
alter table finance_cases drop constraint finance_cases_status_check;
alter table finance_cases add constraint finance_cases_status_check
  check (status in ('docs_pending', 'logged_in', 'credit_review', 'sanctioned', 'do_received', 'disbursed', 'rejected', 'on_hold'));
drop index uq_finance_cases_active;
create unique index uq_finance_cases_active_financier on finance_cases(booking_id, financier_id) where status <> 'rejected';
create index idx_finance_cases_booking on finance_cases(booking_id);

alter table finance_cases
  add column branch_id uuid references financier_branches(id),
  add column assigned_to uuid references employees(id),
  add column loan_account_no text,
  add column net_disbursement_amount numeric check (net_disbursement_amount > 0),
  add column disbursement_month date check (disbursement_month = date_trunc('month', disbursement_month)::date),
  add column verified boolean not null default false,
  add column verified_by uuid references employees(id),
  add column verified_at timestamptz,
  add column cibil_score int check (cibil_score between 300 and 900);
create index idx_finance_cases_branch on finance_cases(branch_id);
create index idx_finance_cases_assigned on finance_cases(assigned_to);
create index idx_finance_cases_verified_by on finance_cases(verified_by);
create index idx_finance_cases_month on finance_cases(disbursement_month) where verified;

alter table bookings add column final_financier_id uuid references financiers(id);
create index idx_bookings_final_financier on bookings(final_financier_id);

-- The case a single-case screen shows: the most advanced live one (then the newest).
create or replace function finance_status_rank(p_status text)
returns int
language sql
immutable
set search_path = public
as $$
  select case p_status when 'disbursed' then 7 when 'do_received' then 6 when 'sanctioned' then 5 when 'credit_review' then 4
                       when 'logged_in' then 3 when 'docs_pending' then 2 when 'on_hold' then 1 else 0 end;
$$;

create or replace function booking_lead_finance_case_id(p_booking_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from finance_cases where booking_id = p_booking_id and status <> 'rejected'
  order by finance_status_rank(status) desc, created_at desc limit 1;
$$;

-- What a case needs to stand at a stage (and every stage before it).
create or replace function finance_case_gate(c finance_cases, p_status text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_missing text[];
  r int := finance_status_rank(p_status);
begin
  if r >= 3 then
    v_missing := finance_missing_documents(c.id);
    if cardinality(v_missing) > 0 then
      return 'Documents still needed before login: ' || array_to_string(v_missing, '; ');
    end if;
  end if;
  if r >= 5 and (c.loan_amount is null or c.tenure_months is null or c.roi_percent is null) then
    return 'Enter the sanctioned loan amount, tenure and rate first';
  end if;
  if r >= 6 and (c.do_number is null or c.do_amount is null or c.do_date is null) then
    return 'Enter the DO number, amount and date first';
  end if;
  if r >= 7 and (c.disbursed_amount is null or c.disbursed_date is null) then
    return 'Enter the disbursed amount and date first';
  end if;
  return null;
end;
$$;

-- Open a case with a financier. Idempotent per booking + financier; a finance executive limited to
-- some financiers cannot open others; the case goes to the next executive of the branch.
create or replace function open_finance_case(
  p_booking_id uuid, p_financier_id uuid, p_applicant_type text, p_finance_type text default 'in_house'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_id uuid;
  v_exec uuid;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not (
       can_access_employee_data(current_employee_id(), b.employee_id)
       or can_work_finance(b.outlet_id)
       or coalesce(current_employee_role_rank() <= 3, false) and b.outlet_id = current_employee_outlet_id()) then
    raise exception 'Booking not found';
  end if;
  if b.status = 'cancelled' then
    raise exception 'This booking is cancelled';
  end if;
  if not exists (select 1 from financiers where id = p_financier_id and is_active) then
    raise exception 'Choose a financier';
  end if;
  if is_finance_executive() and not employee_can_work_financier(current_employee_id(), p_financier_id) then
    raise exception 'You do not work this financier''s cases';
  end if;
  select id into v_id from finance_cases where booking_id = b.id and financier_id = p_financier_id and status <> 'rejected';
  if v_id is not null then
    return v_id;
  end if;

  select p.employee_id into v_exec from finance_assign_pool p join employees e on e.id = p.employee_id
  where p.outlet_id = b.outlet_id and p.is_active and e.is_active and employee_can_work_financier(p.employee_id, p_financier_id)
  order by p.last_assigned_at nulls first, e.name
  limit 1
  for update of p;
  if v_exec is not null then
    update finance_assign_pool set last_assigned_at = clock_timestamp() where employee_id = v_exec;
  end if;

  insert into finance_cases (booking_id, outlet_id, financier_id, finance_type, applicant_type, created_by, assigned_to)
  values (b.id, b.outlet_id, p_financier_id, coalesce(p_finance_type, 'in_house'), p_applicant_type, current_employee_id(),
          coalesce(v_exec, case when is_finance_executive() then current_employee_id() end))
  returning id into v_id;
  insert into finance_case_events (case_id, status_to, note, by_employee_id)
  values (v_id, 'docs_pending', 'Case opened', current_employee_id());
  return v_id;
end;
$$;

-- Terms, DO and disbursement details. Only the given (non-null) fields change; the EMI is worked out.
-- A verified case's disbursement fields are frozen by trigger.
create or replace function update_finance_case(p_case_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c finance_cases%rowtype;
begin
  select * into c from finance_cases where id = p_case_id for update;
  if c.id is null or not can_work_finance(c.outlet_id) then
    raise exception 'Only the branch''s Finance Executive or Outlet Head can change a finance case';
  end if;
  if c.status = 'rejected' then
    raise exception 'This case is closed';
  end if;
  if p ? 'financier_id' and (p->>'financier_id')::uuid is distinct from c.financier_id then
    raise exception 'Open a new case for another financier';
  end if;

  update finance_cases set
    finance_type = coalesce(p->>'finance_type', finance_type),
    applicant_type = coalesce(p->>'applicant_type', applicant_type),
    branch_id = coalesce((p->>'branch_id')::uuid, branch_id),
    application_no = coalesce(nullif(btrim(p->>'application_no'), ''), application_no),
    login_date = coalesce((p->>'login_date')::date, login_date),
    cibil_score = coalesce((p->>'cibil_score')::int, cibil_score),
    loan_amount = coalesce((p->>'loan_amount')::numeric, loan_amount),
    tenure_months = coalesce((p->>'tenure_months')::int, tenure_months),
    roi_percent = coalesce((p->>'roi_percent')::numeric, roi_percent),
    advance_emis = coalesce((p->>'advance_emis')::int, advance_emis),
    processing_fee = coalesce((p->>'processing_fee')::numeric, processing_fee),
    sanction_date = coalesce((p->>'sanction_date')::date, sanction_date),
    do_number = coalesce(nullif(btrim(p->>'do_number'), ''), do_number),
    do_amount = coalesce((p->>'do_amount')::numeric, do_amount),
    do_date = coalesce((p->>'do_date')::date, do_date),
    disbursed_amount = coalesce((p->>'disbursed_amount')::numeric, disbursed_amount),
    disbursed_date = coalesce((p->>'disbursed_date')::date, disbursed_date),
    net_disbursement_amount = coalesce((p->>'net_disbursement_amount')::numeric, net_disbursement_amount),
    disbursement_month = coalesce(date_trunc('month', (p->>'disbursement_month')::date)::date, disbursement_month),
    loan_account_no = coalesce(nullif(btrim(p->>'loan_account_no'), ''), loan_account_no),
    notes = coalesce(p->>'notes', notes)
  where id = c.id;
  update finance_cases set emi = finance_emi(loan_amount, roi_percent, tenure_months) where id = c.id;
end;
$$;

-- Move a case to any status (banks reverse decisions). Reaching a stage needs what that stage
-- needs; going back, on hold or rejected needs a note; a verified case does not move.
create or replace function move_finance_case(p_case_id uuid, p_status text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c finance_cases%rowtype;
  v_gate text;
begin
  select * into c from finance_cases where id = p_case_id for update;
  if c.id is null or not can_work_finance(c.outlet_id) then
    raise exception 'Only the branch''s Finance Executive or Outlet Head can move a finance case';
  end if;
  if c.verified then
    raise exception 'This case is verified; unverify it first';
  end if;
  if p_status = c.status then
    raise exception 'The case is already %', p_status;
  end if;
  if p_status not in ('docs_pending', 'logged_in', 'credit_review', 'sanctioned', 'do_received', 'disbursed', 'rejected', 'on_hold') then
    raise exception 'Unknown status %', p_status;
  end if;
  if (p_status in ('rejected', 'on_hold') or finance_status_rank(p_status) < finance_status_rank(c.status) or c.status = 'rejected')
     and nullif(btrim(p_note), '') is null then
    raise exception 'Give the reason';
  end if;
  if c.status = 'rejected' and exists (select 1 from finance_cases where booking_id = c.booking_id and financier_id = c.financier_id
                                       and status <> 'rejected' and id <> c.id) then
    raise exception 'Another case with this financier is open';
  end if;
  if p_status not in ('rejected', 'on_hold') then
    v_gate := finance_case_gate(c, p_status);
    if v_gate is not null then
      raise exception '%', v_gate;
    end if;
  end if;

  update finance_cases set status = p_status,
    rejection_reason = case when p_status = 'rejected' then btrim(p_note) else null end,
    login_date = case when finance_status_rank(p_status) >= 3 then coalesce(login_date, (now() at time zone 'Asia/Kolkata')::date) else login_date end,
    sanction_date = case when finance_status_rank(p_status) >= 5 then coalesce(sanction_date, (now() at time zone 'Asia/Kolkata')::date) else sanction_date end,
    disbursement_month = case when p_status = 'disbursed' then coalesce(disbursement_month, date_trunc('month', disbursed_date)::date) else disbursement_month end
  where id = c.id;

  -- The first DO decides the hypothecation (HPN) financier.
  if p_status = 'do_received' then
    update bookings set final_financier_id = c.financier_id where id = c.booking_id and final_financier_id is null;
  elsif c.status in ('do_received', 'disbursed') and finance_status_rank(p_status) < 6 then
    update bookings b set final_financier_id = (
      select f.financier_id from finance_cases f where f.booking_id = c.booking_id and f.status in ('do_received', 'disbursed')
      order by f.do_date nulls last, f.created_at limit 1)
    where b.id = c.booking_id and b.final_financier_id = c.financier_id;
  end if;

  insert into finance_case_events (case_id, status_from, status_to, note, by_employee_id)
  values (c.id, c.status, p_status, nullif(btrim(p_note), ''), current_employee_id());
end;
$$;

-- ===== Verified lock =====
create table finance_case_verification_log (
  id bigserial primary key,
  case_id uuid not null references finance_cases(id),
  action text not null check (action in ('verify', 'unverify')),
  snapshot jsonb not null,
  reason text,
  by_employee_id uuid references employees(id),
  at timestamptz not null default now()
);
create index idx_fc_verification_log_case on finance_case_verification_log(case_id);
create index idx_fc_verification_log_by on finance_case_verification_log(by_employee_id);

create or replace function finance_cases_verified_lock()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if OLD.verified and NEW.verified and coalesce(current_setting('finance.unlock', true), '') <> 'on'
     and (NEW.disbursed_amount, NEW.disbursed_date, NEW.disbursement_month, NEW.financier_id, NEW.branch_id, NEW.do_amount,
          NEW.net_disbursement_amount, NEW.loan_account_no, NEW.status)
         is distinct from
         (OLD.disbursed_amount, OLD.disbursed_date, OLD.disbursement_month, OLD.financier_id, OLD.branch_id, OLD.do_amount,
          OLD.net_disbursement_amount, OLD.loan_account_no, OLD.status) then
    raise exception 'This case is verified; its disbursement details are locked';
  end if;
  return NEW;
end;
$$;
create trigger trg_finance_cases_verified_lock before update on finance_cases
  for each row execute function finance_cases_verified_lock();

create or replace function set_case_verified(p_case_id uuid, p_verified boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c finance_cases%rowtype;
begin
  select * into c from finance_cases where id = p_case_id for update;
  if c.id is null or not can_work_finance(c.outlet_id) then raise exception 'Case not found'; end if;
  if p_verified then
    if c.verified then raise exception 'Already verified'; end if;
    if c.status <> 'disbursed' or c.disbursed_amount is null or c.disbursement_month is null or c.do_amount is null then
      raise exception 'Verify a disbursed case with its amount, month and DO';
    end if;
  else
    if not c.verified then raise exception 'Not verified'; end if;
    if not (has_right('finance_cases', 'approve') or coalesce(current_employee_role_rank() <= 1, false)) then
      raise exception 'Unverifying needs Finance Cases: approve';
    end if;
    if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
    if exists (select 1 from bank_claims bc where bc.month = c.disbursement_month and bc.financier_id = c.financier_id and bc.status <> 'generated') then
      raise exception 'This month''s claim for the financier is already invoiced; undo the claim first';
    end if;
  end if;
  update finance_cases set verified = p_verified, verified_by = case when p_verified then current_employee_id() end,
    verified_at = case when p_verified then now() end
  where id = c.id;
  insert into finance_case_verification_log (case_id, action, snapshot, reason, by_employee_id)
  values (c.id, case when p_verified then 'verify' else 'unverify' end, to_jsonb(c), nullif(btrim(p_reason), ''), current_employee_id());
end;
$$;

-- The desk: cases filtered by month, branch, type, executive, financier and verified.
create or replace function finance_cases_desk(p_month date default null, p_outlet_id uuid default null, p_financier_id uuid default null,
                                              p_executive_id uuid default null, p_verified boolean default null, p_status text default null)
returns table (case_id uuid, booking_id uuid, customer_name text, outlet text, financier text, branch text, executive text,
               finance_type text, status text, loan_amount numeric, do_amount numeric, disbursed_amount numeric,
               net_disbursement_amount numeric, disbursement_month date, verified boolean, is_final boolean, updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, b.id, b.customer_name, o.name, f.name, fb.name, e.name, c.finance_type, c.status, c.loan_amount, c.do_amount,
         c.disbursed_amount, c.net_disbursement_amount, c.disbursement_month, c.verified, b.final_financier_id = c.financier_id, c.updated_at
  from finance_cases c
  join bookings b on b.id = c.booking_id
  join outlets o on o.id = c.outlet_id
  join financiers f on f.id = c.financier_id
  left join financier_branches fb on fb.id = c.branch_id
  left join employees e on e.id = c.assigned_to
  where (can_work_finance(c.outlet_id) or can_access_employee_data(current_employee_id(), b.employee_id))
    and (not is_finance_executive() or employee_can_work_financier(current_employee_id(), c.financier_id))
    and (p_month is null or c.disbursement_month = date_trunc('month', p_month)::date)
    and (p_outlet_id is null or c.outlet_id = p_outlet_id)
    and (p_financier_id is null or c.financier_id = p_financier_id)
    and (p_executive_id is null or c.assigned_to = p_executive_id)
    and (p_verified is null or c.verified = p_verified)
    and (p_status is null or c.status = p_status)
  order by c.updated_at desc
  limit 500;
$$;

-- ===== Claims & payouts =====
create table bank_claims (
  id uuid primary key default gen_random_uuid(),
  month date not null check (month = date_trunc('month', month)::date),
  financier_id uuid not null references financiers(id),
  outlet_id uuid references outlets(id),          -- null: all branches
  status text not null default 'generated' check (status in ('generated', 'invoiced', 'bank_received', 'settled')),
  files int not null,
  total_do numeric not null,
  bank_payout numeric not null,
  ca_payout numeric not null,
  addon_payout numeric not null,
  expected_invoice numeric not null,
  invoice_no text,
  invoice_date date,
  invoice_amount numeric,
  bank_utr text,
  bank_received_on date,
  ca_utr text,
  ca_received_on date,
  generated_by uuid references employees(id),
  generated_at timestamptz not null default now(),
  updated_by uuid references employees(id),
  updated_at timestamptz not null default now()
);
create unique index uq_bank_claims_key on bank_claims(month, financier_id, coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index idx_bank_claims_financier on bank_claims(financier_id);
create index idx_bank_claims_outlet on bank_claims(outlet_id);
create index idx_bank_claims_generated_by on bank_claims(generated_by);
create index idx_bank_claims_updated_by on bank_claims(updated_by);

create table finance_config (
  id boolean primary key default true check (id),
  sp_payout_percent numeric not null default 0.5 check (sp_payout_percent >= 0 and sp_payout_percent <= 5),
  gst_percent numeric not null default 18
);
insert into finance_config (id) values (true);

-- The month's claim per financier (and branch, for financiers invoiced branch by branch), from
-- verified disbursed cases.
create or replace function finance_claims_summary(p_month date)
returns table (financier_id uuid, financier text, outlet_id uuid, outlet text, files int, total_do numeric, month_total_do numeric,
               bank_payout numeric, ca_payout numeric, addon_eligible boolean, addon_payout numeric, payout_total numeric,
               expected_invoice numeric, taxable numeric, gst numeric, claim_id uuid, claim_status text, invoice_no text, bank_utr text, ca_utr text)
language sql
stable
security definer
set search_path = public
as $$
  with m as (select date_trunc('month', p_month)::date as d),
  cases as (
    select c.*, f.invoice_by_branch, coalesce(c.net_disbursement_amount, c.do_amount, c.loan_amount, 0) as do_value
    from finance_cases c join financiers f on f.id = c.financier_id, m
    where c.verified and c.status = 'disbursed' and c.disbursement_month = m.d and c.finance_type = 'in_house'
  ),
  grp as (
    select financier_id, case when invoice_by_branch then outlet_id end as outlet_id, count(*)::int as files, sum(do_value) as total_do
    from cases group by 1, 2
  ),
  tot as (select financier_id, sum(do_value) as month_do from cases group by 1)
  select g.financier_id, f.name, g.outlet_id, coalesce(o.name, 'All branches'), g.files, g.total_do, t.month_do,
         case f.bank_payout_basis when 'percent' then round(g.total_do * f.bank_payout_rate / 100, 2) else g.files * f.bank_payout_rate end,
         case f.ca_payout_basis when 'percent' then round(g.total_do * f.ca_payout_rate / 100, 2) else g.files * f.ca_payout_rate end,
         t.month_do >= coalesce(f.addon_target_amount, 0) and f.addon_payout_rate > 0,
         case when t.month_do >= coalesce(f.addon_target_amount, 0) then
           case f.addon_payout_basis when 'percent' then round(g.total_do * f.addon_payout_rate / 100, 2) else g.files * f.addon_payout_rate end
         else 0 end,
         x.payout,
         case when f.gst_included then x.payout else round(x.payout * (1 + cfg.gst_percent / 100), 2) end,
         case when f.gst_included then round(x.payout / (1 + cfg.gst_percent / 100), 2) else x.payout end,
         case when f.gst_included then x.payout - round(x.payout / (1 + cfg.gst_percent / 100), 2) else round(x.payout * cfg.gst_percent / 100, 2) end,
         bc.id, bc.status, bc.invoice_no, bc.bank_utr, bc.ca_utr
  from grp g
  join financiers f on f.id = g.financier_id
  join tot t on t.financier_id = g.financier_id
  left join outlets o on o.id = g.outlet_id
  cross join finance_config cfg
  cross join m
  cross join lateral (select
      (case f.bank_payout_basis when 'percent' then round(g.total_do * f.bank_payout_rate / 100, 2) else g.files * f.bank_payout_rate end)
    + (case f.ca_payout_basis when 'percent' then round(g.total_do * f.ca_payout_rate / 100, 2) else g.files * f.ca_payout_rate end)
    + (case when t.month_do >= coalesce(f.addon_target_amount, 0) then
         case f.addon_payout_basis when 'percent' then round(g.total_do * f.addon_payout_rate / 100, 2) else g.files * f.addon_payout_rate end
       else 0 end) as payout) x
  left join bank_claims bc on bc.month = m.d and bc.financier_id = g.financier_id and bc.outlet_id is not distinct from g.outlet_id
  where has_right('finance_claims', 'view')
  order by f.name, o.name nulls first;
$$;

create or replace function claim_generate(p_month date, p_financier_id uuid, p_outlet_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  v_id uuid;
begin
  if not has_right('finance_claims', 'edit') then raise exception 'You need Claims & Payouts: edit'; end if;
  select * into s from finance_claims_summary(p_month) x where x.financier_id = p_financier_id and x.outlet_id is not distinct from p_outlet_id;
  if s.financier_id is null then raise exception 'No verified disbursed cases for this claim'; end if;
  if s.claim_id is not null and s.claim_status <> 'generated' then raise exception 'This claim is already invoiced'; end if;
  insert into bank_claims (month, financier_id, outlet_id, files, total_do, bank_payout, ca_payout, addon_payout, expected_invoice, generated_by, updated_by)
  values (date_trunc('month', p_month)::date, p_financier_id, p_outlet_id, s.files, s.total_do, s.bank_payout, s.ca_payout, s.addon_payout,
          s.expected_invoice, current_employee_id(), current_employee_id())
  on conflict (month, financier_id, coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid)) do update set
    files = excluded.files, total_do = excluded.total_do, bank_payout = excluded.bank_payout, ca_payout = excluded.ca_payout,
    addon_payout = excluded.addon_payout, expected_invoice = excluded.expected_invoice, updated_by = excluded.updated_by, updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

-- generated → invoiced (number, date, amount) → bank_received (UTR) → settled (CA / add-on UTR).
create or replace function claim_step(p_claim_id uuid, p_step text, p jsonb default '{}')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c bank_claims%rowtype;
begin
  select * into c from bank_claims where id = p_claim_id for update;
  if c.id is null then raise exception 'Claim not found'; end if;
  if p_step = 'undo' then
    if not has_right('finance_claims', 'approve') then raise exception 'Undoing a step needs Claims & Payouts: approve'; end if;
    update bank_claims set status = case status when 'settled' then 'bank_received' when 'bank_received' then 'invoiced' else 'generated' end,
      ca_utr = case when status = 'settled' then null else ca_utr end, ca_received_on = case when status = 'settled' then null else ca_received_on end,
      bank_utr = case when status = 'bank_received' then null else bank_utr end,
      bank_received_on = case when status = 'bank_received' then null else bank_received_on end,
      invoice_no = case when status = 'invoiced' then null else invoice_no end,
      invoice_date = case when status = 'invoiced' then null else invoice_date end,
      invoice_amount = case when status = 'invoiced' then null else invoice_amount end,
      updated_by = current_employee_id(), updated_at = now()
    where id = c.id;
    return;
  end if;
  if not has_right('finance_claims', 'edit') then raise exception 'You need Claims & Payouts: edit'; end if;
  if p_step = 'invoice' then
    if c.status not in ('generated', 'invoiced') then raise exception 'The bank has paid; undo first to change the invoice'; end if;
    if nullif(btrim(p->>'invoice_no'), '') is null or (p->>'invoice_date') is null or coalesce((p->>'invoice_amount')::numeric, 0) <= 0 then
      raise exception 'Enter the invoice number, date and amount';
    end if;
    update bank_claims set status = 'invoiced', invoice_no = btrim(p->>'invoice_no'), invoice_date = (p->>'invoice_date')::date,
      invoice_amount = (p->>'invoice_amount')::numeric, updated_by = current_employee_id(), updated_at = now() where id = c.id;
  elsif p_step = 'bank_received' then
    if c.status <> 'invoiced' then raise exception 'Raise the invoice first'; end if;
    if nullif(btrim(p->>'utr'), '') is null then raise exception 'Enter the UTR'; end if;
    update bank_claims set status = 'bank_received', bank_utr = btrim(p->>'utr'),
      bank_received_on = coalesce((p->>'on')::date, (now() at time zone 'Asia/Kolkata')::date),
      updated_by = current_employee_id(), updated_at = now() where id = c.id;
  elsif p_step = 'settled' then
    if c.status <> 'bank_received' then raise exception 'Record the bank''s payment first'; end if;
    if (c.ca_payout + c.addon_payout) > 0 and nullif(btrim(p->>'utr'), '') is null then raise exception 'Enter the CA / add-on UTR'; end if;
    update bank_claims set status = 'settled', ca_utr = nullif(btrim(p->>'utr'), ''),
      ca_received_on = coalesce((p->>'on')::date, (now() at time zone 'Asia/Kolkata')::date),
      updated_by = current_employee_id(), updated_at = now() where id = c.id;
  else
    raise exception 'Unknown step';
  end if;
end;
$$;

-- Salesperson finance payout per case: a share of DO, released once the bank's payout for that month,
-- financier and branch has arrived. Read-only: one row per case, so a case is never paid twice.
create or replace function finance_sp_payouts(p_month date)
returns table (case_id uuid, booking_id uuid, customer_name text, employee_id uuid, employee text, financier text,
               do_value numeric, rate_percent numeric, amount numeric, released boolean, bank_utr text)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, b.id, b.customer_name, b.employee_id, e.name, f.name,
         coalesce(c.net_disbursement_amount, c.do_amount, c.loan_amount, 0), cfg.sp_payout_percent,
         round(coalesce(c.net_disbursement_amount, c.do_amount, c.loan_amount, 0) * cfg.sp_payout_percent / 100, 2),
         bc.bank_utr is not null, bc.bank_utr
  from finance_cases c
  join bookings b on b.id = c.booking_id
  join employees e on e.id = b.employee_id
  join financiers f on f.id = c.financier_id
  cross join finance_config cfg
  left join bank_claims bc on bc.month = c.disbursement_month and bc.financier_id = c.financier_id
    and bc.outlet_id is not distinct from case when f.invoice_by_branch then c.outlet_id end
    and bc.status in ('bank_received', 'settled')
  where c.verified and c.status = 'disbursed' and c.finance_type = 'in_house' and c.disbursement_month = date_trunc('month', p_month)::date
    and (has_right('finance_claims', 'view') or b.employee_id = current_employee_id())
  order by e.name, b.customer_name;
$$;

-- ===== RLS =====
alter table financier_branches enable row level security;
alter table financier_emi_terms enable row level security;
alter table financier_rate_slabs enable row level security;
alter table finance_assign_pool enable row level security;
alter table finance_case_verification_log enable row level security;
alter table bank_claims enable row level security;
alter table finance_config enable row level security;
create policy financier_branches_select on financier_branches for select to authenticated using (true);
create policy financier_branches_write on financier_branches for all to authenticated
  using (has_right('finance_banks', 'edit') or is_master_data_admin()) with check (has_right('finance_banks', 'edit') or is_master_data_admin());
create policy financier_emi_terms_select on financier_emi_terms for select to authenticated using (true);
create policy financier_emi_terms_write on financier_emi_terms for all to authenticated
  using (has_right('finance_banks', 'edit') or is_master_data_admin()) with check (has_right('finance_banks', 'edit') or is_master_data_admin());
create policy financier_rate_slabs_select on financier_rate_slabs for select to authenticated using (true);
create policy financier_rate_slabs_write on financier_rate_slabs for all to authenticated
  using (has_right('finance_banks', 'edit') or is_master_data_admin()) with check (has_right('finance_banks', 'edit') or is_master_data_admin());
create policy finance_assign_pool_select on finance_assign_pool for select to authenticated using (true);
create policy finance_assign_pool_write on finance_assign_pool for all to authenticated
  using (ops_can('finance_banks', 'edit', outlet_id)) with check (ops_can('finance_banks', 'edit', outlet_id));
create policy fc_verification_log_select on finance_case_verification_log for select to authenticated
  using (exists (select 1 from finance_cases c where c.id = case_id and can_work_finance(c.outlet_id)));
create policy bank_claims_select on bank_claims for select to authenticated using (has_right('finance_claims', 'view'));
create policy finance_config_select on finance_config for select to authenticated using (true);
create policy finance_config_write on finance_config for update to authenticated using (has_right('finance_claims', 'approve'));
-- Financier payout settings are written by the Banks page.
create policy financiers_write_banks on financiers for update to authenticated
  using (has_right('finance_banks', 'edit')) with check (has_right('finance_banks', 'edit'));
create policy financiers_insert_banks on financiers for insert to authenticated with check (has_right('finance_banks', 'edit'));

-- ===== Screens that show one case per booking now show the lead case (latest definitions) =====
create or replace function pool_booking_completion(p_booking_id uuid, out completed_at timestamptz, out win_path text)
language plpgsql
stable
set search_path = public
as $$
declare
  c finance_cases%rowtype;
  v_deal numeric;
  v_pct numeric;
begin
  if price_diff_blocked(p_booking_id) then
    return;
  end if;
  select * into c from finance_cases where id = booking_lead_finance_case_id(p_booking_id);
  if c.id is not null then
    if c.status in ('do_received', 'disbursed') then
      select min(e.created_at) into completed_at from finance_case_events e where e.case_id = c.id and e.status_to = 'do_received';
      completed_at := coalesce(completed_at, c.updated_at);
      win_path := 'do';
    end if;
    return;
  end if;

  select cash_payment_percentage into v_pct from pool_config;
  select a.deal_amount into v_deal from booking_account(p_booking_id) a;
  if coalesce(v_deal, 0) <= 0 then
    return;
  end if;
  select x.t into completed_at from (
    select greatest(r.created_at, r.cleared_on::timestamp at time zone 'Asia/Kolkata') as t,
           sum(r.amount) over (order by r.cleared_on, r.created_at, r.id) as running
    from payment_receipts r
    where r.booking_id = p_booking_id and r.clearance_status = 'cleared'
  ) x
  where x.running >= v_deal * v_pct / 100
  order by x.running
  limit 1;
  if completed_at is not null then
    win_path := 'cash';
  end if;
end;
$$;

create or replace function pool_detail(p_variant_id uuid, p_color_id uuid)
returns table (booking_id uuid, customer_name text, ctdms_order_no text, outlet text, consultant text, booking_date date,
               place text, fast_tracked boolean, completed_at timestamptz, win_path text, finance_status text,
               cash_percent numeric, vin text, queue_position int)
language sql
stable
security definer
set search_path = public
as $$
  with rows as (
    select bk.id, bk.customer_name, bk.ctdms_order_booking_no, o.name as outlet, e.name as consultant, booking_order_date(bk) as bdate,
           case when pm.status = 'allotted' then 'allotted'
                when pm.status = 'active' and pm.completed_at is not null then 'winner'
                when pm.status = 'active' then 'member'
                else 'queue' end as place,
           coalesce(pm.fast_tracked and pm.status = 'active', false) as fast_tracked,
           case when pm.status in ('active', 'allotted') then pm.completed_at end as completed_at,
           case when pm.status in ('active', 'allotted') then pm.win_path end as win_path,
           (select fc.status from finance_cases fc where fc.id = booking_lead_finance_case_id(bk.id)) as finance_status,
           (select case when ac.deal_amount > 0 then floor(ac.cleared * 100 / ac.deal_amount) end from booking_account(bk.id) ac) as cash_percent,
           (select v.vin from allotments a join vehicles v on v.id = a.vehicle_id where a.booking_id = bk.id and a.released_at is null) as vin,
           bk.created_at
    from bookings bk
    left join pool_members pm on pm.booking_id = bk.id
    left join outlets o on o.id = bk.outlet_id
    left join employees e on e.id = bk.employee_id
    where bk.variant_id = p_variant_id and bk.color_id = p_color_id
      and ((pm.status = 'allotted' and bk.status = 'allocated') or (bk.status = 'booked' and booking_allotable(bk.id)))
  )
  select r.id, r.customer_name, r.ctdms_order_booking_no, r.outlet, r.consultant, r.bdate, r.place, r.fast_tracked,
         r.completed_at, r.win_path, r.finance_status, r.cash_percent, r.vin,
         (row_number() over (order by case r.place when 'allotted' then 0 when 'winner' then 1 when 'member' then 2 else 3 end,
                                     r.completed_at nulls last, r.bdate, r.created_at, r.id))::int
  from rows r
  where coalesce(current_employee_role_rank() <= 3, false)
  order by 14;
$$;

create or replace function pool_finance_queue(p_outlet_id uuid default null)
returns table (booking_id uuid, customer_name text, customer_mobile text, ctdms_order_no text, outlet_id uuid, outlet text,
               consultant text, model_name text, variant_name text, color_name text, booking_date date, fast_tracked boolean,
               completed_at timestamptz, win_path text, finance_status text, financier text, do_number text, do_date date,
               deal_amount numeric, cleared numeric, pending numeric, cash_percent numeric, cash_target_percent numeric,
               free_cars int)
language sql
stable
security definer
set search_path = public
as $$
  select bk.id, bk.customer_name, bk.customer_mobile, bk.ctdms_order_booking_no, bk.outlet_id, o.name, e.name, mo.name, va.name,
         co.name, pm.booking_date, pm.fast_tracked, pm.completed_at, pm.win_path, fc.status, fi.name, fc.do_number, fc.do_date,
         ac.deal_amount, ac.cleared, ac.pending,
         case when ac.deal_amount > 0 then floor(ac.cleared * 100 / ac.deal_amount) end,
         (select cash_payment_percentage from pool_config), pool_free_count(pm.variant_id, pm.color_id)
  from pool_members pm
  join bookings bk on bk.id = pm.booking_id
  join outlets o on o.id = bk.outlet_id
  left join employees e on e.id = bk.employee_id
  join variants va on va.id = pm.variant_id join models mo on mo.id = va.model_id join colors co on co.id = pm.color_id
  left join finance_cases fc on fc.id = booking_lead_finance_case_id(bk.id)
  left join financiers fi on fi.id = fc.financier_id
  cross join lateral booking_account(bk.id) ac
  where pm.status = 'active' and (p_outlet_id is null or bk.outlet_id = p_outlet_id) and pool_can_see_booking(bk)
  order by pm.completed_at nulls last, pm.booking_date, bk.created_at;
$$;

create or replace function pool_non_pool_bookings(p_outlet_id uuid default null)
returns table (booking_id uuid, customer_name text, customer_mobile text, ctdms_order_no text, outlet_id uuid, outlet text,
               consultant text, model_name text, variant_name text, color_name text, booking_date date, finance_status text,
               cash_percent numeric, free_cars int)
language sql
stable
security definer
set search_path = public
as $$
  select bk.id, bk.customer_name, bk.customer_mobile, bk.ctdms_order_booking_no, bk.outlet_id, o.name, e.name, mo.name, va.name,
         co.name, booking_order_date(bk), fc.status,
         (select case when ac.deal_amount > 0 then floor(ac.cleared * 100 / ac.deal_amount) end from booking_account(bk.id) ac),
         pool_free_count(bk.variant_id, bk.color_id)
  from bookings bk
  join outlets o on o.id = bk.outlet_id
  left join employees e on e.id = bk.employee_id
  join variants va on va.id = bk.variant_id join models mo on mo.id = va.model_id join colors co on co.id = bk.color_id
  left join finance_cases fc on fc.id = booking_lead_finance_case_id(bk.id)
  where bk.status = 'booked' and booking_allotable(bk.id)
    and not exists (select 1 from pool_members pm where pm.booking_id = bk.id and pm.status = 'active')
    and (p_outlet_id is null or bk.outlet_id = p_outlet_id) and pool_can_see_booking(bk)
  order by booking_order_date(bk), bk.created_at;
$$;

create or replace function pool_vna_demand(p_outlet_id uuid default null)
returns table (booking_id uuid, customer_name text, customer_mobile text, ctdms_order_no text, outlet_id uuid, outlet text,
               consultant text, model_name text, variant_name text, color_name text, booking_date date, days_waiting int,
               queue_position int, free_cars int, finance_status text, other_colors jsonb, other_variants jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with waiting as (
    select bk.*, booking_order_date(bk) as bdate,
           row_number() over (partition by bk.variant_id, bk.color_id order by booking_order_date(bk), bk.created_at, bk.id)::int as pos
    from bookings bk
    where bk.status = 'booked' and booking_allotable(bk.id)
  ), keyed as (
    select w.*, pool_free_count(w.variant_id, w.color_id) as free from waiting w
  )
  select k.id, k.customer_name, k.customer_mobile, k.ctdms_order_booking_no, k.outlet_id, o.name, e.name, mo.name, va.name, co.name,
         k.bdate, ((now() at time zone 'Asia/Kolkata')::date - k.bdate)::int, k.pos, k.free,
         (select fc.status from finance_cases fc where fc.id = booking_lead_finance_case_id(k.id)),
         coalesce((
           select jsonb_agg(jsonb_build_object('color_id', x.color_id, 'color', x.name, 'free', x.free) order by x.free desc, x.name)
           from (select c2.id as color_id, c2.name, count(*)::int as free from vehicles v2 join colors c2 on c2.id = v2.color_id
                 where v2.variant_id = k.variant_id and v2.color_id <> k.color_id and pool_vehicle_free(v2)
                 group by c2.id, c2.name) x), '[]'::jsonb),
         coalesce((
           select jsonb_agg(jsonb_build_object('variant_id', y.variant_id, 'variant', y.name, 'free', y.free, 'price_difference', y.diff)
                            order by abs(coalesce(y.diff, 0)), y.name)
           from (select va2.id as variant_id, va2.name, count(*)::int as free,
                        pool_variant_price(va2.id) - pool_variant_price(k.variant_id) as diff
                 from vehicles v2 join variants va2 on va2.id = v2.variant_id
                 where va2.model_id = va.model_id and va2.fuel_type_id = va.fuel_type_id and va2.id <> k.variant_id and pool_vehicle_free(v2)
                 group by va2.id, va2.name
                 order by abs(coalesce(pool_variant_price(va2.id) - pool_variant_price(k.variant_id), 0))
                 limit 4) y), '[]'::jsonb)
  from keyed k
  join outlets o on o.id = k.outlet_id
  left join employees e on e.id = k.employee_id
  join variants va on va.id = k.variant_id join models mo on mo.id = va.model_id join colors co on co.id = k.color_id
  where k.pos > k.free and (p_outlet_id is null or k.outlet_id = p_outlet_id)
    and pool_can_see_booking((select bb from bookings bb where bb.id = k.id))
  order by k.bdate, k.created_at;
$$;

create or replace function pool_next_in_line(p_outlet_id uuid default null)
returns table (variant_id uuid, color_id uuid, model text, variant text, color text, waiting int, queue_position int, booking_id uuid,
               customer_name text, customer_mobile text, outlet text, consultant text, team_leader text, booking_date date,
               finance_status text, financier text)
language sql
stable
security definer
set search_path = public
as $$
  with waiting as (
    select bk.*, booking_order_date(bk) bdate,
           row_number() over (partition by bk.variant_id, bk.color_id order by booking_order_date(bk), bk.created_at, bk.id)::int pos,
           count(*) over (partition by bk.variant_id, bk.color_id)::int n
    from bookings bk
    join variants va on va.id = bk.variant_id
    where bk.status = 'booked' and booking_allotable(bk.id) and not va.pool_manual_only
  )
  select w.variant_id, w.color_id, mo.name, va.name, co.name, w.n, w.pos, w.id, w.customer_name, w.customer_mobile, o.name, e.name,
         tl.name, w.bdate, fc.status, fi.name
  from waiting w
  join variants va on va.id = w.variant_id join models mo on mo.id = va.model_id join colors co on co.id = w.color_id
  join outlets o on o.id = w.outlet_id
  left join employees e on e.id = w.employee_id
  left join employees tl on tl.id = e.reports_to_employee_id
  left join finance_cases fc on fc.id = booking_lead_finance_case_id(w.id)
  left join financiers fi on fi.id = fc.financier_id
  where pool_free_count(w.variant_id, w.color_id) = 0
    and w.pos <= (select next_in_line_size from pool_config)
    and (p_outlet_id is null or w.outlet_id = p_outlet_id)
    and pool_can_see_booking((select bb from bookings bb where bb.id = w.id))
  order by mo.name, va.name, co.name, w.pos;
$$;

create or replace function rm_booking_detail(p_booking_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not (can_work_booking_rm(b) or (has_right('rm_assign', 'view') and ops_branch_ok(b.outlet_id))) then
    raise exception 'Booking not found';
  end if;
  return jsonb_build_object(
    'booking', (select jsonb_build_object('id', b.id, 'customer_name', b.customer_name, 'mobile', coalesce(c.mobile, b.customer_mobile),
                  'email', c.email, 'order_no', coalesce(b.ctdms_order_booking_no, b.order_booking_no), 'status', b.status,
                  'booked_on', coalesce(b.ctdms_order_date, b.created_at::date), 'outlet', o.name, 'outlet_id', b.outlet_id,
                  'consultant', e.name, 'rm', rm.name, 'rm_employee_id', b.rm_employee_id, 'model', mo.name, 'variant', va.name,
                  'color', co.name, 'mode_of_purchase', b.mode_of_purchase, 'total_amount', b.total_amount,
                  'likely_delivery_date', b.likely_delivery_date, 'bucket', rm_bucket(b))
                from outlets o
                left join customers c on c.id = b.customer_id
                left join employees e on e.id = b.employee_id
                left join employees rm on rm.id = b.rm_employee_id
                left join variants va on va.id = b.variant_id
                left join models mo on mo.id = va.model_id
                left join colors co on co.id = b.color_id
                where o.id = b.outlet_id),
    'account', (select to_jsonb(a) from booking_account(b.id) a),
    'vehicle', (select jsonb_build_object('vin', v.vin, 'source', v.source, 'location', v.location)
                from allotments al join vehicles v on v.id = al.vehicle_id where al.booking_id = b.id and al.released_at is null),
    'finance', (select jsonb_build_object('status', f.status, 'financier', fi.name, 'loan_amount', f.loan_amount)
                from finance_cases f left join financiers fi on fi.id = f.financier_id
                where f.id = booking_lead_finance_case_id(b.id)),
    'stages', (select coalesce(jsonb_agg(jsonb_build_object('stage', s.stage, 'status', s.status, 'detail', s.detail)), '[]')
               from ops_stage_status(b.id) s
               where exists (select 1 from billing_requests r where r.booking_id = b.id and r.status in ('pending', 'invoiced'))),
    'slot', (select jsonb_build_object('id', ds.id, 'date', ds.slot_date, 'time', ds.slot_time)
             from delivery_slots ds where ds.booking_id = b.id and ds.status = 'booked'),
    'notes', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'body', n.body, 'author', a.name,
                                                           'created_at', n.created_at) order by n.created_at desc), '[]')
              from booking_notes n join employees a on a.id = n.author_id where n.booking_id = b.id),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'detail', q.detail, 'status', q.status,
                                                              'resolution', q.resolution, 'created_at', q.created_at,
                                                              'created_by', cb.name) order by q.created_at desc), '[]')
                 from booking_customer_requests q left join employees cb on cb.id = q.created_by where q.booking_id = b.id),
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'due_at', t.due_at, 'status', t.status,
                                                           'assigned_to', a.name) order by t.status = 'open' desc, t.due_at), '[]')
              from tasks t join employees a on a.id = t.assigned_to where t.booking_id = b.id)
  );
end;
$$;

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
      if not exists (select 1 from finance_cases x where x.booking_id = b.id and x.status <> 'rejected'
                     and x.financier_id = (select financier_id from finance_cases where id = (f->>'id')::uuid)) then
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
  select * into v_case from finance_cases where id = booking_lead_finance_case_id(b.id);
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

-- ===== Grants =====
do $$
declare f text;
begin
  foreach f in array array[
    'finance_emi_options(numeric, numeric, int, int)', 'booking_lead_finance_case_id(uuid)', 'set_case_verified(uuid, boolean, text)',
    'finance_cases_desk(date, uuid, uuid, uuid, boolean, text)', 'finance_claims_summary(date)', 'claim_generate(date, uuid, uuid)',
    'claim_step(uuid, text, jsonb)', 'finance_sp_payouts(date)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke execute on function finance_case_gate(finance_cases, text) from public, anon, authenticated;
revoke execute on function financier_rate_slabs_guard() from public, anon, authenticated;
revoke execute on function finance_cases_verified_lock() from public, anon, authenticated;

-- ===== Menu =====
insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('finance_banks',  'sales', 'Banks',             '/finance/banks',          41, true),
  ('finance_desk',   'sales', 'Finance Desk',      '/finance/desk',           42, true),
  ('finance_claims', 'sales', 'Claims & Payouts',  '/finance/claims-payouts', 43, true);
select seed_role_rights('Finance Executive', 'finance_desk', array['view', 'edit']);
select seed_role_rights('Finance Executive', 'finance_banks', array['view']);
select seed_role_rights('Outlet Head', 'finance_desk', array['view', 'edit']);
select seed_role_rights('Outlet Head', 'finance_banks', array['view', 'edit']);
select seed_role_rights('Outlet Head', 'finance_cases', array['approve']);
select seed_role_rights('Outlet Head', 'finance_claims', array['view']);
select seed_role_rights('Accounts', 'finance_claims', array['view', 'edit']);
select seed_role_rights('Accounts', 'finance_desk', array['view']);
