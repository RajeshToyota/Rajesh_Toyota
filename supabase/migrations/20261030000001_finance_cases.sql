-- Phase 11: finance cases. A booking bought on finance gets a case that moves
--   docs pending -> logged in -> sanctioned -> DO received -> disbursed (or rejected)
-- with the loan terms, the financier's DO and the disbursement. Documents follow the docket's
-- finance checklists (pp.19 and 21) for salaried, self-employed and company applicants, with
-- photos in booking-documents/<booking_id>/finance/.
-- Who:
--   - A new Finance Executive role works every case at its branch (with Outlet Head and above).
--   - The Sales Consultant can open a case, collect documents and see its progress.
-- Cases are tracked only: they do not hold up billing.

-- ===== Finance Executive role =====
-- Rank 6 keeps it below every approval and hierarchy check; it is recognised by name.
insert into roles (id, name, rank) values ('00000000-0000-0000-0001-000000000008', 'Finance Executive', 6)
on conflict (id) do nothing;

create or replace function is_finance_executive()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from employees e join roles r on r.id = e.role_id
    where e.id = current_employee_id() and r.name = 'Finance Executive' and e.is_active
  );
$$;

-- Finance Executive of the branch, or Outlet Head of the branch, or Business Head / Admin.
create or replace function can_work_finance(p_outlet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_employee_role_rank() <= 1, false)
      or ((is_finance_executive() or coalesce(current_employee_role_rank() = 2, false))
          and current_employee_outlet_id() = p_outlet_id);
$$;

-- The Finance Executive reads its branch's bookings (and through them the booking documents).
create policy bookings_select_finance on bookings for select to authenticated using (
  is_finance_executive() and outlet_id = current_employee_outlet_id()
);

-- ===== Financiers =====
create table financiers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  short_name text,
  is_captive boolean not null default false, -- Toyota Financial Services (subvention schemes)
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table financiers enable row level security;
create policy financiers_select on financiers for select to authenticated using (true);
create policy financiers_write on financiers for all to authenticated
  using (is_master_data_admin()) with check (is_master_data_admin());

-- TFS plus the financiers that appear on the branches' CTDMS orders.
insert into financiers (name, short_name, is_captive) values
  ('Toyota Financial Services', 'TFS', true),
  ('State Bank of India', 'SBI', false),
  ('HDFC Bank', 'HDFC', false),
  ('ICICI Bank', 'ICICI', false),
  ('Axis Bank', 'Axis', false),
  ('AU Small Finance Bank', 'AU', false),
  ('Bank of Baroda', 'BoB', false),
  ('Punjab National Bank', 'PNB', false),
  ('Bank of India', 'BOI', false),
  ('Kotak Mahindra Prime', 'Kotak', false),
  ('Mahindra & Mahindra Financial Services', 'M&M Finance', false),
  ('Bajaj Finance', 'Bajaj', false)
on conflict (name) do nothing;

-- ===== Cases =====
create table finance_cases (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  outlet_id uuid not null references outlets(id),
  financier_id uuid not null references financiers(id),
  finance_type text not null default 'in_house' check (finance_type in ('in_house', 'own')),
  applicant_type text not null check (applicant_type in ('salaried', 'self_employed', 'company')),
  status text not null default 'docs_pending'
    check (status in ('docs_pending', 'logged_in', 'sanctioned', 'do_received', 'disbursed', 'rejected')),
  application_no text,
  login_date date,
  loan_amount numeric check (loan_amount > 0),
  tenure_months int check (tenure_months between 1 and 120),
  roi_percent numeric check (roi_percent >= 0 and roi_percent < 50),
  emi numeric,
  advance_emis int not null default 0 check (advance_emis between 0 and 12),
  processing_fee numeric not null default 0 check (processing_fee >= 0),
  sanction_date date,
  do_number text,
  do_amount numeric check (do_amount > 0),
  do_date date,
  disbursed_amount numeric check (disbursed_amount > 0),
  disbursed_date date,
  rejection_reason text,
  notes text,
  created_by uuid references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One live case per booking; a rejected case stays as history and a new one can be opened.
create unique index uq_finance_cases_active on finance_cases(booking_id) where status <> 'rejected';
create index idx_finance_cases_outlet_status on finance_cases(outlet_id, status);
create trigger trg_finance_cases_updated_at before update on finance_cases for each row execute function set_updated_at();

create table finance_case_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references finance_cases(id) on delete cascade,
  status_from text,
  status_to text not null,
  note text,
  by_employee_id uuid references employees(id),
  created_at timestamptz not null default now()
);
create index idx_finance_case_events_case on finance_case_events(case_id);

-- The docket's finance checklists. `applicant_types` says which checklist each belongs to;
-- `required` ones must be in (on file or on paper) before the case is logged in.
create table finance_document_types (
  id text primary key,
  label text not null,
  applicant_types text[] not null,
  required_for text[] not null default '{}',
  sort_order int not null
);
insert into finance_document_types (id, label, applicant_types, required_for, sort_order) values
  ('photo', 'Passport size photographs', '{salaried,self_employed}', '{salaried,self_employed}', 1),
  ('pan', 'PAN card', '{salaried,self_employed}', '{salaried,self_employed}', 2),
  ('aadhaar', 'Aadhaar card', '{salaried,self_employed}', '{salaried,self_employed}', 3),
  ('address_proof', 'Address proof (Voter ID / Passport and latest electricity bill)', '{salaried,self_employed}', '{salaried,self_employed}', 4),
  ('permanent_address_proof', 'Permanent address proof', '{salaried,self_employed}', '{}', 5),
  ('rent_agreement', 'Rent agreement copy (if staying on rent)', '{salaried,self_employed}', '{}', 6),
  ('salary_slips', 'Last 3 months salary slips', '{salaried}', '{salaried}', 7),
  ('form_16', 'Last 2 years Form 16', '{salaried}', '{salaried}', 8),
  ('employment_letter', 'Letter of employment / employer''s certificate', '{salaried}', '{}', 9),
  ('bank_statement', 'Last 6 months bank statement (salary / current account)', '{salaried,self_employed,company}', '{salaried,self_employed,company}', 10),
  ('itr', 'IT returns with computation (last 2 years)', '{self_employed,company}', '{self_employed,company}', 11),
  ('balance_sheet', 'Audited balance sheet (last 2 years)', '{self_employed,company}', '{company}', 12),
  ('investments', 'Investments (LIC, MF, PPF etc.) and other liability proofs', '{salaried,self_employed}', '{}', 13),
  ('previous_rc', 'RC copy of previous vehicle', '{salaried,self_employed,company}', '{}', 14),
  ('firm_pan', 'PAN card of the firm', '{company}', '{company}', 15),
  ('firm_address_proof', 'Address proof of the firm (electricity bill, sales tax registration, bank statement)', '{company}', '{company}', 16),
  ('memorandum', 'Memorandum of agreement / articles', '{company}', '{company}', 17),
  ('board_resolution', 'Board resolution (stamped and sealed)', '{company}', '{company}', 18),
  ('directors_pan', 'PAN cards of directors', '{company}', '{company}', 19),
  ('directors_address_proof', 'Address proof of directors', '{company}', '{}', 20),
  ('partnership_deed', 'Partnership deed and partner''s authority letter', '{company}', '{}', 21),
  ('signature_verification', 'Signature verification', '{salaried,self_employed,company}', '{}', 22),
  ('quotation_receipt', 'Quotation and down payment receipt', '{salaried,self_employed,company}', '{}', 23),
  ('other', 'Other document', '{salaried,self_employed,company}', '{}', 99);
alter table finance_document_types enable row level security;
create policy finance_document_types_select on finance_document_types for select to authenticated using (true);

create table finance_documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references finance_cases(id) on delete cascade,
  doc_type text not null references finance_document_types(id),
  label text,
  storage_path text,
  collected_on_paper boolean not null default false,
  uploaded_by uuid references employees(id) default current_employee_id(),
  created_at timestamptz not null default now(),
  check (storage_path is not null or collected_on_paper)
);
create index idx_finance_documents_case on finance_documents(case_id);

-- ===== Access =====
-- A case is visible to whoever can see its booking (consultant line, back office, the branch's
-- Finance Executive). Terms and stages change only through the functions below; documents can be
-- added by anyone who can see the case, until it is disbursed or rejected.
alter table finance_cases enable row level security;
alter table finance_case_events enable row level security;
alter table finance_documents enable row level security;
create policy finance_cases_select on finance_cases for select to authenticated using (can_access_booking(booking_id));
create policy finance_case_events_select on finance_case_events for select to authenticated using (
  exists (select 1 from finance_cases c where c.id = case_id)
);
create policy finance_documents_select on finance_documents for select to authenticated using (
  exists (select 1 from finance_cases c where c.id = case_id)
);
create policy finance_documents_insert on finance_documents for insert to authenticated with check (
  exists (select 1 from finance_cases c where c.id = case_id and c.status not in ('disbursed', 'rejected')
          and (storage_path is null or storage_path like c.booking_id::text || '/finance/%'))
);
create policy finance_documents_delete on finance_documents for delete to authenticated using (
  exists (select 1 from finance_cases c where c.id = case_id and c.status not in ('disbursed', 'rejected'))
);

-- ===== EMI =====
create or replace function finance_emi(p_principal numeric, p_roi_percent numeric, p_months int)
returns numeric
language sql
immutable
set search_path = public
as $$
  select case
    when p_principal is null or p_months is null or p_months <= 0 or p_roi_percent is null then null
    when p_roi_percent = 0 then round(p_principal / p_months)
    else round(p_principal * (p_roi_percent / 1200) * power(1 + p_roi_percent / 1200, p_months)
               / (power(1 + p_roi_percent / 1200, p_months) - 1))
  end;
$$;

-- ===== Functions =====
-- Labels of the required documents still missing. Runs with the caller's access.
create or replace function finance_missing_documents(p_case_id uuid)
returns text[]
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(array_agg(t.label order by t.sort_order), '{}')
  from finance_cases c
  join finance_document_types t on c.applicant_type = any(t.required_for)
  where c.id = p_case_id
    and not exists (select 1 from finance_documents d where d.case_id = c.id and d.doc_type = t.id);
$$;

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
  select id into v_id from finance_cases where booking_id = b.id and status <> 'rejected';
  if v_id is not null then
    return v_id;
  end if;

  insert into finance_cases (booking_id, outlet_id, financier_id, finance_type, applicant_type, created_by)
  values (b.id, b.outlet_id, p_financier_id, coalesce(p_finance_type, 'in_house'), p_applicant_type, current_employee_id())
  returning id into v_id;
  insert into finance_case_events (case_id, status_to, note, by_employee_id)
  values (v_id, 'docs_pending', 'Case opened', current_employee_id());
  return v_id;
end;
$$;

-- Terms, DO and disbursement details. Only the given (non-null) fields change; the EMI is worked out.
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
  if c.status in ('disbursed', 'rejected') then
    raise exception 'This case is closed';
  end if;
  if p ? 'financier_id' and not exists (select 1 from financiers where id = (p->>'financier_id')::uuid and is_active) then
    raise exception 'Unknown financier';
  end if;

  update finance_cases set
    financier_id = coalesce((p->>'financier_id')::uuid, financier_id),
    finance_type = coalesce(p->>'finance_type', finance_type),
    applicant_type = coalesce(p->>'applicant_type', applicant_type),
    application_no = coalesce(nullif(btrim(p->>'application_no'), ''), application_no),
    login_date = coalesce((p->>'login_date')::date, login_date),
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
    notes = coalesce(p->>'notes', notes)
  where id = c.id;
  update finance_cases set emi = finance_emi(loan_amount, roi_percent, tenure_months) where id = c.id;
end;
$$;

-- Moves a case on one stage (or to rejected), checking what each stage needs.
create or replace function move_finance_case(p_case_id uuid, p_status text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c finance_cases%rowtype;
  v_order text[] := array['docs_pending', 'logged_in', 'sanctioned', 'do_received', 'disbursed'];
  v_missing text[];
begin
  select * into c from finance_cases where id = p_case_id for update;
  if c.id is null or not can_work_finance(c.outlet_id) then
    raise exception 'Only the branch''s Finance Executive or Outlet Head can move a finance case';
  end if;
  if c.status in ('disbursed', 'rejected') then
    raise exception 'This case is closed';
  end if;

  if p_status = 'rejected' then
    if nullif(btrim(p_note), '') is null then
      raise exception 'Give the reason the financier rejected the case';
    end if;
    update finance_cases set status = 'rejected', rejection_reason = btrim(p_note) where id = c.id;
  else
    if array_position(v_order, p_status) is distinct from array_position(v_order, c.status) + 1 then
      raise exception 'A case moves one stage at a time (now %)', c.status;
    end if;
    if p_status = 'logged_in' then
      v_missing := finance_missing_documents(c.id);
      if cardinality(v_missing) > 0 then
        raise exception 'Documents still needed before login: %', array_to_string(v_missing, '; ');
      end if;
      if c.login_date is null then
        update finance_cases set login_date = (now() at time zone 'Asia/Kolkata')::date where id = c.id;
      end if;
    elsif p_status = 'sanctioned' and (c.loan_amount is null or c.tenure_months is null or c.roi_percent is null) then
      raise exception 'Enter the sanctioned loan amount, tenure and rate first';
    elsif p_status = 'do_received' and (c.do_number is null or c.do_amount is null or c.do_date is null) then
      raise exception 'Enter the DO number, amount and date first';
    elsif p_status = 'disbursed' and (c.disbursed_amount is null or c.disbursed_date is null) then
      raise exception 'Enter the disbursed amount and date first';
    end if;
    update finance_cases set status = p_status,
      sanction_date = case when p_status = 'sanctioned' then coalesce(sanction_date, (now() at time zone 'Asia/Kolkata')::date) else sanction_date end
    where id = c.id;
  end if;

  insert into finance_case_events (case_id, status_from, status_to, note, by_employee_id)
  values (c.id, c.status, p_status, nullif(btrim(p_note), ''), current_employee_id());
end;
$$;

revoke execute on function is_finance_executive() from public, anon;
revoke execute on function can_work_finance(uuid) from public, anon;
revoke execute on function finance_missing_documents(uuid) from public, anon;
revoke execute on function open_finance_case(uuid, uuid, text, text) from public, anon;
revoke execute on function update_finance_case(uuid, jsonb) from public, anon;
revoke execute on function move_finance_case(uuid, text, text) from public, anon;
grant execute on function is_finance_executive() to authenticated;
grant execute on function can_work_finance(uuid) to authenticated;
grant execute on function finance_missing_documents(uuid) to authenticated;
grant execute on function open_finance_case(uuid, uuid, text, text) to authenticated;
grant execute on function update_finance_case(uuid, jsonb) to authenticated;
grant execute on function move_finance_case(uuid, text, text) to authenticated;
grant execute on function finance_emi(numeric, numeric, int) to authenticated;
