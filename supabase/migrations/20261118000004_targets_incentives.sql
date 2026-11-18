-- Phase 20: monthly targets and incentive payouts (Techwheels' targets, payroll incentive engine and
-- finance payout), with the dealership's incentive SOPs set up as editable schemes, not hard-coded.
--
-- Retail = a car invoiced to the customer in the month (billing_requests.invoice_date), credited to the
-- booking's consultant (CA).
--
-- Schemes (incentive_schemes.rules, jsonb), one or more per kind, each valid for a range of months:
--   ca_retail   Sales Consultant (CA) incentive per car, with slabs, focus-model bonus and a cap.
--               Paid only when the month's gates are met (digital check-in, leads checked at least
--               N times, learning assessment). Release: 75% with the next month's salary (by the 15th),
--               25% held until TKM settles (every 6 months).
--   tl_team     Team Leader: a share of the team's CA incentive.
--   gm_sm       TKM's GM/SM incentive for the month, entered per branch when the run is calculated,
--               split GM 60 : SM 40. Release: 75% monthly, 25% when TKM pays.
--   prefinance  In-house finance penetration = in-house files / (retail − cash sales). From 60%,
--               Rs 300 per file plus Rs 30 per percentage point above 60, shared by the branch's
--               Finance Executives. Released only after the banks pay the dealership.
--
-- A run calculates every line for a month (draft, recalculable), is approved, and the held parts are
-- released later (TKM settlement, bank payment). Bank payouts on in-house cases go from the bank to the
-- CA directly: the CA submits the invoice, Accounts verifies, the GM approves; a payout taken on an
-- outside (DSA) loan without telling the company is flagged.

-- ===== Modules and rights =====
insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('targets',            'people', 'Targets',             '/targets',             30, true),
  ('incentives',         'people', 'Incentive Runs',      '/incentives',          40, true),
  ('incentive_schemes',  'people', 'Incentive Schemes',   '/incentives/schemes',  50, true),
  ('bank_payouts',       'people', 'Bank Payouts to CA',  '/incentives/bank-payouts', 60, true),
  ('my_incentive',       'people', 'My Incentive',        '/incentives/me',       70, true);

select seed_role_rights(r, m, x) from (values
  ('Outlet Head', 'targets', array['view','create','edit']), ('Outlet Head', 'incentives', array['view']),
  ('Outlet Head', 'bank_payouts', array['view']), ('Outlet Head', 'my_incentive', array['view']),
  ('Team Leader', 'targets', array['view']), ('Team Leader', 'my_incentive', array['view']),
  ('Sales Consultant', 'targets', array['view']), ('Sales Consultant', 'my_incentive', array['view']),
  ('Sales Consultant', 'bank_payouts', array['view','create']),
  ('Accounts', 'incentives', array['view','edit']), ('Accounts', 'bank_payouts', array['view','edit']),
  ('Finance Executive', 'my_incentive', array['view']), ('Finance Executive', 'bank_payouts', array['view','edit']),
  ('HR', 'incentives', array['view','edit']), ('HR', 'targets', array['view'])
) v(r, m, x);

-- ===== Targets =====
create table employee_monthly_targets (
  id uuid primary key default gen_random_uuid(),
  month date not null check (extract(day from month) = 1),
  employee_id uuid not null references employees(id),
  model_id uuid references models(id),
  target_units int not null check (target_units >= 0),
  set_by uuid references employees(id),
  updated_at timestamptz not null default now()
);
create unique index uq_targets on employee_monthly_targets(month, employee_id, coalesce(model_id, '00000000-0000-0000-0000-000000000000'));
create index idx_targets_employee on employee_monthly_targets(employee_id);
create index idx_targets_model on employee_monthly_targets(model_id);
create index idx_targets_set_by on employee_monthly_targets(set_by);

alter table employee_monthly_targets enable row level security;
create policy targets_select on employee_monthly_targets for select to authenticated
  using (can_access_employee_data(current_employee_id(), employee_id) or has_right('incentives', 'view'));

-- Retail units in a month: invoiced cars by the booking's consultant.
create or replace function retail_units(p_month date)
returns table (employee_id uuid, outlet_id uuid, model_id uuid, booking_id uuid, is_cash boolean, in_house boolean)
language sql
stable
security definer
set search_path = public
as $$
  select b.employee_id, b.outlet_id, va.model_id, b.id,
         coalesce(b.mode_of_purchase, '') ~* '^\s*cash',
         exists (select 1 from finance_cases f where f.booking_id = b.id and f.finance_type = 'in_house'
                 and f.status in ('do_received', 'disbursed'))
  from billing_requests r
  join bookings b on b.id = r.booking_id
  left join variants va on va.id = b.variant_id
  where r.status = 'invoiced' and r.invoice_date >= p_month and r.invoice_date < p_month + interval '1 month'
    and b.status <> 'cancelled';
$$;

create or replace function set_target(p_month date, p_employee_id uuid, p_model_id uuid, p_units int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet uuid;
begin
  select outlet_id into v_outlet from employees where id = p_employee_id and is_active;
  if v_outlet is null then raise exception 'Employee not found'; end if;
  if not (ops_can('targets', 'edit', v_outlet) and (is_branch_back_office(v_outlet)
          or can_access_employee_data(current_employee_id(), p_employee_id))) then
    raise exception 'You cannot set targets for this employee';
  end if;
  if p_units is null or p_units < 0 then raise exception 'Enter the target in cars'; end if;
  insert into employee_monthly_targets as t (month, employee_id, model_id, target_units, set_by)
  values (date_trunc('month', p_month)::date, p_employee_id, p_model_id, p_units, current_employee_id())
  on conflict (month, employee_id, coalesce(model_id, '00000000-0000-0000-0000-000000000000'))
    do update set target_units = excluded.target_units, set_by = excluded.set_by, updated_at = now();
end;
$$;

-- Target vs retail for the month, per consultant the caller can see.
create or replace function target_vs_actual(p_month date, p_outlet_id uuid default null)
returns table (employee_id uuid, employee text, role text, outlet text, target_units int, retail int, in_house int,
               cash int, achievement_pct numeric, model_targets jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with m as (select date_trunc('month', p_month)::date as month),
  people as (
    select e.id, e.name, r.name as role, o.name as outlet, e.outlet_id
    from employees e join roles r on r.id = e.role_id left join outlets o on o.id = e.outlet_id
    where e.is_active and r.name in ('Sales Consultant', 'Team Leader')
      and (p_outlet_id is null or e.outlet_id = p_outlet_id)
      and (can_access_employee_data(current_employee_id(), e.id) or (has_right('incentives', 'view') and ops_branch_ok(e.outlet_id)))
  ),
  sold as (select * from retail_units((select month from m)))
  select p.id, p.name, p.role, p.outlet,
         (select t.target_units from employee_monthly_targets t, m where t.employee_id = p.id and t.month = m.month and t.model_id is null),
         (select count(*)::int from sold s where s.employee_id = p.id),
         (select count(*)::int from sold s where s.employee_id = p.id and s.in_house),
         (select count(*)::int from sold s where s.employee_id = p.id and s.is_cash),
         round(100.0 * (select count(*) from sold s where s.employee_id = p.id)
               / nullif((select t.target_units from employee_monthly_targets t, m where t.employee_id = p.id and t.month = m.month and t.model_id is null), 0), 1),
         (select coalesce(jsonb_agg(jsonb_build_object('model', mo.name, 'model_id', t.model_id, 'target', t.target_units,
                    'retail', (select count(*) from sold s where s.employee_id = p.id and s.model_id = t.model_id))), '[]')
            from employee_monthly_targets t join models mo on mo.id = t.model_id, m
           where t.employee_id = p.id and t.month = m.month)
  from people p
  order by p.outlet, p.role desc, p.name;
$$;

-- ===== Monthly gates (CA eligibility) =====
create table employee_monthly_compliance (
  month date not null check (extract(day from month) = 1),
  employee_id uuid not null references employees(id),
  digital_checkin boolean not null default false,
  lead_checks int,                 -- null: counted from follow-ups logged (distinct days)
  assessment_passed boolean not null default false,
  note text,
  updated_by uuid references employees(id),
  updated_at timestamptz not null default now(),
  primary key (month, employee_id)
);
create index idx_compliance_employee on employee_monthly_compliance(employee_id);
create index idx_compliance_updated_by on employee_monthly_compliance(updated_by);
alter table employee_monthly_compliance enable row level security;
create policy compliance_select on employee_monthly_compliance for select to authenticated
  using (can_access_employee_data(current_employee_id(), employee_id) or has_right('incentives', 'view'));

create or replace function save_compliance(p_month date, p_employee_id uuid, p_digital_checkin boolean, p_lead_checks int,
                                           p_assessment_passed boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet uuid := (select outlet_id from employees where id = p_employee_id);
begin
  if not (ops_can('incentives', 'edit', v_outlet) or (ops_can('targets', 'edit', v_outlet) and is_branch_back_office(v_outlet))) then
    raise exception 'You cannot record incentive gates for this employee';
  end if;
  insert into employee_monthly_compliance as c (month, employee_id, digital_checkin, lead_checks, assessment_passed, note, updated_by)
  values (date_trunc('month', p_month)::date, p_employee_id, coalesce(p_digital_checkin, false), p_lead_checks,
          coalesce(p_assessment_passed, false), nullif(btrim(p_note), ''), current_employee_id())
  on conflict (month, employee_id) do update set digital_checkin = excluded.digital_checkin, lead_checks = excluded.lead_checks,
    assessment_passed = excluded.assessment_passed, note = excluded.note, updated_by = excluded.updated_by, updated_at = now();
end;
$$;

-- ===== Schemes =====
create table incentive_schemes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('ca_retail', 'tl_team', 'gm_sm', 'prefinance')),
  month_from date not null check (extract(day from month_from) = 1),
  month_to date check (month_to is null or extract(day from month_to) = 1),
  outlet_id uuid references outlets(id),      -- null: every branch
  rules jsonb not null,
  is_active boolean not null default true,
  created_by uuid references employees(id),
  updated_at timestamptz not null default now()
);
create index idx_incentive_schemes_outlet on incentive_schemes(outlet_id);
create index idx_incentive_schemes_created_by on incentive_schemes(created_by);
alter table incentive_schemes enable row level security;
create policy incentive_schemes_select on incentive_schemes for select to authenticated using (true);

-- The SOPs as they stand (from 1 Sep 2026). Amounts per car for CAs are an example to edit.
insert into incentive_schemes (name, kind, month_from, rules) values
  ('CA retail incentive', 'ca_retail', '2026-09-01', '{
     "per_unit": 1000,
     "slabs": [{"min_units": 5, "per_unit": 1500}, {"min_units": 10, "per_unit": 2000}],
     "focus_models": {},
     "cap": null,
     "release_now_pct": 75,
     "held_until": "tkm_settlement",
     "gates": {"digital_checkin": true, "lead_checks_min": 5, "assessment": true}
   }'),
  ('Team Leader team share', 'tl_team', '2026-09-01', '{"team_pct": 10, "release_now_pct": 75, "held_until": "tkm_settlement"}'),
  ('GM / SM TKM incentive', 'gm_sm', '2026-09-01', '{
     "gm_pct": 60, "sm_pct": 40, "gm_role": "Business Head", "sm_role": "Outlet Head",
     "release_now_pct": 75, "held_until": "tkm_settlement"
   }'),
  ('Pre-finance in-house penetration', 'prefinance', '2026-09-01', '{
     "min_penetration_pct": 60, "base_per_file": 300, "step_per_pct": 30,
     "team_role": "Finance Executive", "release_now_pct": 0, "held_until": "bank_payment"
   }');

create or replace function save_incentive_scheme(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not has_right('incentive_schemes', 'edit') then raise exception 'You cannot change incentive schemes'; end if;
  if p_id is null then
    insert into incentive_schemes (name, kind, month_from, month_to, outlet_id, rules, created_by)
    values (btrim(p->>'name'), p->>'kind', date_trunc('month', (p->>'month_from')::date)::date,
            date_trunc('month', nullif(p->>'month_to', '')::date)::date, nullif(p->>'outlet_id', '')::uuid,
            coalesce(p->'rules', '{}'), current_employee_id())
    returning id into v_id;
  else
    update incentive_schemes set
      name = coalesce(nullif(btrim(p->>'name'), ''), name),
      month_from = coalesce(date_trunc('month', (p->>'month_from')::date)::date, month_from),
      month_to = case when p ? 'month_to' then date_trunc('month', nullif(p->>'month_to', '')::date)::date else month_to end,
      rules = coalesce(p->'rules', rules),
      is_active = coalesce((p->>'is_active')::boolean, is_active),
      updated_at = now()
    where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Scheme not found'; end if;
  end if;
  return v_id;
end;
$$;

-- ===== Runs =====
create table incentive_runs (
  id uuid primary key default gen_random_uuid(),
  month date not null check (extract(day from month) = 1),
  status text not null default 'draft' check (status in ('draft', 'approved', 'cancelled')),
  inputs jsonb not null default '{}',   -- {"gm_sm_amounts": {"<outlet_id>": 120000}}
  calculated_by uuid references employees(id),
  calculated_at timestamptz,
  approved_by uuid references employees(id),
  approved_at timestamptz,
  note text
);
create unique index uq_incentive_runs_month on incentive_runs(month) where status <> 'cancelled';
create index idx_incentive_runs_calculated_by on incentive_runs(calculated_by);
create index idx_incentive_runs_approved_by on incentive_runs(approved_by);

create table incentive_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references incentive_runs(id) on delete cascade,
  employee_id uuid not null references employees(id),
  scheme_id uuid references incentive_schemes(id),
  kind text not null,
  outlet_id uuid references outlets(id),
  basis jsonb not null default '{}',
  gross numeric not null default 0,
  eligible boolean not null default true,
  ineligible_reason text,
  release_now numeric not null default 0,
  held numeric not null default 0,
  held_until text check (held_until in ('tkm_settlement', 'bank_payment')),
  held_released_at timestamptz,
  held_released_by uuid references employees(id),
  held_release_note text
);
create index idx_incentive_lines_run on incentive_lines(run_id);
create index idx_incentive_lines_employee on incentive_lines(employee_id);
create index idx_incentive_lines_scheme on incentive_lines(scheme_id);
create index idx_incentive_lines_outlet on incentive_lines(outlet_id);
create index idx_incentive_lines_released_by on incentive_lines(held_released_by);

alter table incentive_runs enable row level security;
alter table incentive_lines enable row level security;
create policy incentive_runs_select on incentive_runs for select to authenticated using (true);
create policy incentive_lines_select on incentive_lines for select to authenticated
  using (employee_id = current_employee_id()
         or (has_right('incentives', 'view') and (outlet_id is null or ops_branch_ok(outlet_id))));

-- The scheme of a kind that applies to a month and branch (a branch's own scheme beats the general one).
create or replace function incentive_scheme_for(p_kind text, p_month date, p_outlet_id uuid)
returns incentive_schemes
language sql
stable
security definer
set search_path = public
as $$
  select s.* from incentive_schemes s
  where s.kind = p_kind and s.is_active and s.month_from <= p_month and (s.month_to is null or s.month_to >= p_month)
    and (s.outlet_id is null or s.outlet_id = p_outlet_id)
  order by s.outlet_id is null, s.month_from desc
  limit 1;
$$;

-- Per-car rate for a CA's month: the highest slab reached, else the base.
create or replace function ca_rate(p_rules jsonb, p_units int)
returns numeric
language sql
immutable
as $$
  select coalesce((select (s->>'per_unit')::numeric from jsonb_array_elements(coalesce(p_rules->'slabs', '[]')) s
                   where (s->>'min_units')::int <= p_units order by (s->>'min_units')::int desc limit 1),
                  (p_rules->>'per_unit')::numeric, 0);
$$;

create or replace function calculate_incentive_run(p_month date, p_inputs jsonb default '{}')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_run incentive_runs%rowtype;
  s incentive_schemes%rowtype;
  e record;
  o record;
  v_units int;
  v_focus numeric;
  v_gross numeric;
  v_now numeric;
  v_reasons text[];
  c employee_monthly_compliance%rowtype;
  v_checks int;
  v_pen numeric;
  v_rate numeric;
  v_team int;
  v_amount numeric;
  v_people uuid[];
begin
  if not has_right('incentives', 'edit') then raise exception 'You cannot calculate incentives'; end if;
  if v_month >= date_trunc('month', now() at time zone 'Asia/Kolkata')::date + interval '1 month' then
    raise exception 'That month has not started';
  end if;
  select * into v_run from incentive_runs where month = v_month and status <> 'cancelled' for update;
  if v_run.status = 'approved' then raise exception 'This month is approved; cancel the run to recalculate'; end if;
  if v_run.id is null then
    insert into incentive_runs (month, inputs) values (v_month, coalesce(p_inputs, '{}')) returning * into v_run;
  else
    update incentive_runs set inputs = coalesce(p_inputs, inputs) where id = v_run.id returning * into v_run;
    delete from incentive_lines where run_id = v_run.id;
  end if;

  create temp table if not exists t_retail on commit drop as select * from retail_units(v_month) limit 0;
  truncate t_retail;
  insert into t_retail select * from retail_units(v_month);

  -- CA retail
  for e in
    select emp.id, emp.outlet_id from employees emp join roles r on r.id = emp.role_id
    where r.name = 'Sales Consultant' and (emp.is_active or emp.exit_date >= v_month)
  loop
    s := incentive_scheme_for('ca_retail', v_month, e.outlet_id);
    continue when s.id is null;
    select count(*) into v_units from t_retail where employee_id = e.id;
    continue when v_units = 0;
    select coalesce(sum((s.rules->'focus_models'->>t.model_id::text)::numeric), 0) into v_focus
    from t_retail t where t.employee_id = e.id and s.rules->'focus_models' ? t.model_id::text;
    v_gross := v_units * ca_rate(s.rules, v_units) + v_focus;
    if (s.rules->>'cap') is not null then v_gross := least(v_gross, (s.rules->>'cap')::numeric); end if;
    select * into c from employee_monthly_compliance where month = v_month and employee_id = e.id;
    v_checks := coalesce(c.lead_checks, (select count(distinct (f.created_at at time zone 'Asia/Kolkata')::date)
                                         from enquiry_followups f where f.employee_id = e.id
                                           and f.created_at >= v_month and f.created_at < v_month + interval '1 month'));
    v_reasons := '{}';
    if coalesce((s.rules->'gates'->>'digital_checkin')::boolean, false) and not coalesce(c.digital_checkin, false) then
      v_reasons := array_append(v_reasons, 'No digital check-in');
    end if;
    if v_checks < coalesce((s.rules->'gates'->>'lead_checks_min')::int, 0) then
      v_reasons := array_append(v_reasons, 'Leads checked ' || v_checks || ' times (needs ' || (s.rules->'gates'->>'lead_checks_min') || ')');
    end if;
    if coalesce((s.rules->'gates'->>'assessment')::boolean, false) and not coalesce(c.assessment_passed, false) then
      v_reasons := array_append(v_reasons, 'Learning assessment not done');
    end if;
    v_now := case when cardinality(v_reasons) = 0 then round(v_gross * coalesce((s.rules->>'release_now_pct')::numeric, 100) / 100) else 0 end;
    insert into incentive_lines (run_id, employee_id, scheme_id, kind, outlet_id, basis, gross, eligible, ineligible_reason,
                                 release_now, held, held_until)
    values (v_run.id, e.id, s.id, 'ca_retail', e.outlet_id,
            jsonb_build_object('units', v_units, 'rate', ca_rate(s.rules, v_units), 'focus_bonus', v_focus, 'lead_checks', v_checks),
            v_gross, cardinality(v_reasons) = 0, nullif(array_to_string(v_reasons, '; '), ''),
            v_now, case when cardinality(v_reasons) = 0 then v_gross - v_now else 0 end,
            case when cardinality(v_reasons) = 0 and v_gross > v_now then s.rules->>'held_until' end);
  end loop;

  -- Team Leader: share of the eligible CA incentive of their direct reports
  for e in
    select emp.id, emp.outlet_id from employees emp join roles r on r.id = emp.role_id
    where r.name = 'Team Leader' and (emp.is_active or emp.exit_date >= v_month)
  loop
    s := incentive_scheme_for('tl_team', v_month, e.outlet_id);
    continue when s.id is null;
    select coalesce(sum(l.gross), 0), count(*) into v_amount, v_team
    from incentive_lines l join employees sc on sc.id = l.employee_id
    where l.run_id = v_run.id and l.kind = 'ca_retail' and l.eligible and sc.reports_to_employee_id = e.id;
    continue when v_amount = 0;
    v_gross := round(v_amount * coalesce((s.rules->>'team_pct')::numeric, 0) / 100);
    v_now := round(v_gross * coalesce((s.rules->>'release_now_pct')::numeric, 100) / 100);
    insert into incentive_lines (run_id, employee_id, scheme_id, kind, outlet_id, basis, gross, release_now, held, held_until)
    values (v_run.id, e.id, s.id, 'tl_team', e.outlet_id, jsonb_build_object('team_ca_incentive', v_amount, 'team_members', v_team),
            v_gross, v_now, v_gross - v_now, case when v_gross > v_now then s.rules->>'held_until' end);
  end loop;

  -- GM / SM: TKM's amount for each branch, entered for the run
  for o in select x.key::uuid as outlet_id, x.value::numeric as amount from jsonb_each_text(coalesce(v_run.inputs->'gm_sm_amounts', '{}')) x
  loop
    continue when o.amount is null or o.amount <= 0;
    s := incentive_scheme_for('gm_sm', v_month, o.outlet_id);
    continue when s.id is null;
    -- GM: the GM role (e.g. Business Head) across branches, shared equally
    select array_agg(emp.id) into v_people from employees emp join roles r on r.id = emp.role_id
    where emp.is_active and r.name = coalesce(s.rules->>'gm_role', 'Business Head');
    if v_people is not null then
      v_amount := round(o.amount * coalesce((s.rules->>'gm_pct')::numeric, 60) / 100 / cardinality(v_people));
      insert into incentive_lines (run_id, employee_id, scheme_id, kind, outlet_id, basis, gross, release_now, held, held_until)
      select v_run.id, p, s.id, 'gm_sm', o.outlet_id,
             jsonb_build_object('share', 'GM', 'tkm_amount', o.amount, 'pct', s.rules->>'gm_pct', 'shared_by', cardinality(v_people)),
             v_amount, round(v_amount * coalesce((s.rules->>'release_now_pct')::numeric, 100) / 100),
             v_amount - round(v_amount * coalesce((s.rules->>'release_now_pct')::numeric, 100) / 100), s.rules->>'held_until'
      from unnest(v_people) p;
    end if;
    -- SM: the branch's SM role (e.g. Outlet Head), shared equally
    select array_agg(emp.id) into v_people from employees emp join roles r on r.id = emp.role_id
    where emp.is_active and r.name = coalesce(s.rules->>'sm_role', 'Outlet Head') and emp.outlet_id = o.outlet_id;
    if v_people is not null then
      v_amount := round(o.amount * coalesce((s.rules->>'sm_pct')::numeric, 40) / 100 / cardinality(v_people));
      insert into incentive_lines (run_id, employee_id, scheme_id, kind, outlet_id, basis, gross, release_now, held, held_until)
      select v_run.id, p, s.id, 'gm_sm', o.outlet_id,
             jsonb_build_object('share', 'SM', 'tkm_amount', o.amount, 'pct', s.rules->>'sm_pct', 'shared_by', cardinality(v_people)),
             v_amount, round(v_amount * coalesce((s.rules->>'release_now_pct')::numeric, 100) / 100),
             v_amount - round(v_amount * coalesce((s.rules->>'release_now_pct')::numeric, 100) / 100), s.rules->>'held_until'
      from unnest(v_people) p;
    end if;
  end loop;

  -- Pre-finance: in-house penetration per branch
  for o in
    select t.outlet_id, count(*) filter (where not t.is_cash) as financeable, count(*) filter (where t.in_house) as files
    from t_retail t group by t.outlet_id
  loop
    s := incentive_scheme_for('prefinance', v_month, o.outlet_id);
    continue when s.id is null or o.financeable = 0;
    v_pen := round(100.0 * o.files / o.financeable, 2);
    continue when v_pen < coalesce((s.rules->>'min_penetration_pct')::numeric, 60);
    v_rate := coalesce((s.rules->>'base_per_file')::numeric, 300)
              + coalesce((s.rules->>'step_per_pct')::numeric, 30) * floor(v_pen - coalesce((s.rules->>'min_penetration_pct')::numeric, 60));
    select array_agg(emp.id) into v_people from employees emp join roles r on r.id = emp.role_id
    where emp.is_active and r.name = coalesce(s.rules->>'team_role', 'Finance Executive') and emp.outlet_id = o.outlet_id;
    continue when v_people is null;
    v_amount := round(o.files * v_rate / cardinality(v_people));
    insert into incentive_lines (run_id, employee_id, scheme_id, kind, outlet_id, basis, gross, release_now, held, held_until)
    select v_run.id, p, s.id, 'prefinance', o.outlet_id,
           jsonb_build_object('files', o.files, 'financeable_sales', o.financeable, 'penetration_pct', v_pen, 'per_file', v_rate,
                              'shared_by', cardinality(v_people)),
           v_amount, round(v_amount * coalesce((s.rules->>'release_now_pct')::numeric, 0) / 100),
           v_amount - round(v_amount * coalesce((s.rules->>'release_now_pct')::numeric, 0) / 100), s.rules->>'held_until'
    from unnest(v_people) p;
  end loop;

  update incentive_runs set calculated_by = current_employee_id(), calculated_at = now() where id = v_run.id;
  return v_run.id;
end;
$$;

create or replace function approve_incentive_run(p_run_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r incentive_runs%rowtype;
begin
  select * into r from incentive_runs where id = p_run_id for update;
  if r.id is null or r.status <> 'draft' then raise exception 'Run not found or not a draft'; end if;
  if not has_right('incentives', 'approve') then raise exception 'Only the Business Head can approve incentives'; end if;
  if r.calculated_by = current_employee_id() and not coalesce(current_employee_role_rank() = 0, false) then
    raise exception 'Someone other than the person who calculated it must approve';
  end if;
  update incentive_runs set status = 'approved', approved_by = current_employee_id(), approved_at = now(),
    note = coalesce(nullif(btrim(p_note), ''), note)
  where id = r.id;
end;
$$;

create or replace function cancel_incentive_run(p_run_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not has_right('incentives', 'approve') then raise exception 'Only the Business Head can cancel a run'; end if;
  if exists (select 1 from incentive_lines where run_id = p_run_id and held_released_at is not null) then
    raise exception 'Held amounts of this run have been released; it cannot be cancelled';
  end if;
  update incentive_runs set status = 'cancelled', note = nullif(btrim(p_note), '') where id = p_run_id and status <> 'cancelled';
  if not found then raise exception 'Run not found'; end if;
end;
$$;

-- TKM has settled, or the bank has paid: release held amounts of approved runs up to a month.
create or replace function release_held_incentives(p_held_until text, p_up_to_month date, p_note text, p_outlet_id uuid default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not has_right('incentives', 'approve') then raise exception 'Only the Business Head can release held incentives'; end if;
  if p_held_until not in ('tkm_settlement', 'bank_payment') then raise exception 'Choose TKM settlement or bank payment'; end if;
  if nullif(btrim(p_note), '') is null then raise exception 'Note the settlement (e.g. TKM credit note number)'; end if;
  update incentive_lines l set held_released_at = now(), held_released_by = current_employee_id(), held_release_note = btrim(p_note)
  from incentive_runs r
  where r.id = l.run_id and r.status = 'approved' and r.month <= date_trunc('month', p_up_to_month)::date
    and l.held > 0 and l.held_until = p_held_until and l.held_released_at is null
    and (p_outlet_id is null or l.outlet_id = p_outlet_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function incentive_run_lines(p_run_id uuid)
returns table (id uuid, employee_id uuid, employee text, role text, outlet text, kind text, scheme text, basis jsonb, gross numeric,
               eligible boolean, ineligible_reason text, release_now numeric, held numeric, held_until text, held_released_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select l.id, l.employee_id, e.name, r.name, o.name, l.kind, s.name, l.basis, l.gross, l.eligible, l.ineligible_reason, l.release_now,
         l.held, l.held_until, l.held_released_at
  from incentive_lines l
  join employees e on e.id = l.employee_id
  left join roles r on r.id = e.role_id
  left join outlets o on o.id = l.outlet_id
  left join incentive_schemes s on s.id = l.scheme_id
  where l.run_id = p_run_id
  order by o.name, l.kind, e.name;
$$;

-- What the signed-in employee has earned: per month, now and held.
create or replace function my_incentive(p_months int default 6)
returns table (month date, status text, kind text, gross numeric, eligible boolean, ineligible_reason text, release_now numeric,
               held numeric, held_until text, held_released_at timestamptz, basis jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select r.month, r.status, l.kind, l.gross, l.eligible, l.ineligible_reason, l.release_now, l.held, l.held_until, l.held_released_at, l.basis
  from incentive_lines l join incentive_runs r on r.id = l.run_id
  where l.employee_id = current_employee_id() and r.status <> 'cancelled'
    and r.month >= date_trunc('month', now() at time zone 'Asia/Kolkata')::date - make_interval(months => greatest(p_months, 1) - 1)
  order by r.month desc, l.kind;
$$;

-- What is still held, by kind and month, for the payout desk.
create or replace function held_incentives_summary()
returns table (held_until text, month date, outlet text, lines int, amount numeric)
language sql
stable
security definer
set search_path = public
as $$
  select l.held_until, r.month, o.name, count(*)::int, sum(l.held)
  from incentive_lines l join incentive_runs r on r.id = l.run_id left join outlets o on o.id = l.outlet_id
  where r.status = 'approved' and l.held > 0 and l.held_released_at is null
    and has_right('incentives', 'view') and (l.outlet_id is null or ops_branch_ok(l.outlet_id))
  group by 1, 2, 3
  order by 1, 2, 3;
$$;

-- ===== Bank payouts to CA (in-house cases) =====
create table bank_payouts (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  finance_case_id uuid references finance_cases(id),
  financier_id uuid references financiers(id),
  employee_id uuid not null references employees(id),     -- the CA paid by the bank
  outlet_id uuid not null references outlets(id),
  kind text not null default 'in_house' check (kind in ('in_house', 'outhouse_flag')),
  amount numeric not null check (amount > 0),
  invoice_no text,
  invoice_date date,
  status text not null default 'submitted'
    check (status in ('submitted', 'accounts_verified', 'gm_approved', 'paid', 'rejected', 'flagged')),
  note text,
  submitted_by uuid references employees(id),
  submitted_at timestamptz not null default now(),
  verified_by uuid references employees(id),
  verified_at timestamptz,
  approved_by uuid references employees(id),
  approved_at timestamptz,
  paid_on date,
  rejected_reason text
);
create unique index uq_bank_payouts_case on bank_payouts(finance_case_id) where kind = 'in_house' and status <> 'rejected';
create index idx_bank_payouts_booking on bank_payouts(booking_id);
create index idx_bank_payouts_financier on bank_payouts(financier_id);
create index idx_bank_payouts_employee on bank_payouts(employee_id);
create index idx_bank_payouts_outlet on bank_payouts(outlet_id, status);
create index idx_bank_payouts_submitted_by on bank_payouts(submitted_by);
create index idx_bank_payouts_verified_by on bank_payouts(verified_by);
create index idx_bank_payouts_approved_by on bank_payouts(approved_by);

alter table bank_payouts enable row level security;
create policy bank_payouts_select on bank_payouts for select to authenticated
  using (employee_id = current_employee_id() or ops_can('bank_payouts', 'edit', outlet_id) or ops_can('incentives', 'approve', outlet_id));

-- The CA submits the invoice they will raise to the bank for their in-house case.
create or replace function submit_bank_payout(p_finance_case_id uuid, p_amount numeric, p_invoice_no text, p_invoice_date date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  f finance_cases%rowtype;
  b bookings%rowtype;
  v_id uuid;
begin
  select * into f from finance_cases where id = p_finance_case_id;
  if f.id is null then raise exception 'Finance case not found'; end if;
  select * into b from bookings where id = f.booking_id;
  if not (b.employee_id = current_employee_id() or ops_can('bank_payouts', 'edit', b.outlet_id)) then
    raise exception 'Finance case not found';
  end if;
  if f.finance_type <> 'in_house' then raise exception 'Bank payouts are only for in-house finance cases'; end if;
  if f.status not in ('do_received', 'disbursed') then raise exception 'The loan must be at DO or disbursed'; end if;
  if nullif(btrim(p_invoice_no), '') is null or p_invoice_date is null or coalesce(p_amount, 0) <= 0 then
    raise exception 'Enter the invoice number, date and amount';
  end if;
  insert into bank_payouts (booking_id, finance_case_id, financier_id, employee_id, outlet_id, amount, invoice_no, invoice_date, submitted_by)
  values (b.id, f.id, f.financier_id, b.employee_id, b.outlet_id, p_amount, btrim(p_invoice_no), p_invoice_date, current_employee_id())
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'A payout invoice for this case is already in';
end;
$$;

-- Accounts verifies, the GM approves, Accounts records the bank's payment to the CA.
create or replace function move_bank_payout(p_id uuid, p_status text, p_note text default null, p_paid_on date default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p bank_payouts%rowtype;
begin
  select * into p from bank_payouts where id = p_id for update;
  if p.id is null then raise exception 'Payout not found'; end if;
  if p_status = 'accounts_verified' then
    if p.status <> 'submitted' or not ops_can('bank_payouts', 'edit', p.outlet_id) then raise exception 'Only Accounts can verify a submitted invoice'; end if;
    update bank_payouts set status = p_status, verified_by = current_employee_id(), verified_at = now(), note = coalesce(nullif(btrim(p_note), ''), note) where id = p.id;
  elsif p_status = 'gm_approved' then
    if p.status <> 'accounts_verified' or not ops_can('incentives', 'approve', p.outlet_id) then raise exception 'Only the GM can approve a verified invoice'; end if;
    update bank_payouts set status = p_status, approved_by = current_employee_id(), approved_at = now() where id = p.id;
  elsif p_status = 'paid' then
    if p.status <> 'gm_approved' or not ops_can('bank_payouts', 'edit', p.outlet_id) then raise exception 'Only an approved invoice can be marked paid'; end if;
    update bank_payouts set status = p_status, paid_on = coalesce(p_paid_on, (now() at time zone 'Asia/Kolkata')::date) where id = p.id;
  elsif p_status = 'rejected' then
    if p.status in ('paid', 'rejected', 'flagged') or not (ops_can('bank_payouts', 'edit', p.outlet_id) or ops_can('incentives', 'approve', p.outlet_id)) then
      raise exception 'This invoice cannot be rejected';
    end if;
    if nullif(btrim(p_note), '') is null then raise exception 'Give the reason'; end if;
    update bank_payouts set status = 'rejected', rejected_reason = btrim(p_note) where id = p.id;
  else
    raise exception 'Unknown status';
  end if;
end;
$$;

-- A CA found taking a payout on an outside (DSA / own-finance) loan without telling the company: flagged
-- for the GM (the SOP treats this as cheating).
create or replace function flag_outhouse_payout(p_booking_id uuid, p_amount numeric, p_note text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not ops_can('bank_payouts', 'edit', b.outlet_id) then raise exception 'Booking not found'; end if;
  if nullif(btrim(p_note), '') is null then raise exception 'Describe what was found'; end if;
  insert into bank_payouts (booking_id, employee_id, outlet_id, kind, amount, status, note, submitted_by)
  values (b.id, b.employee_id, b.outlet_id, 'outhouse_flag', coalesce(p_amount, 1), 'flagged', btrim(p_note), current_employee_id())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function bank_payout_list(p_status text default null)
returns table (id uuid, kind text, status text, customer_name text, employee text, outlet text, financier text, amount numeric,
               invoice_no text, invoice_date date, submitted_at timestamptz, verified_by text, approved_by text, paid_on date,
               note text, rejected_reason text)
language sql
stable
security invoker
set search_path = public
as $$
  select p.id, p.kind, p.status, b.customer_name, e.name, o.name, fi.name, p.amount, p.invoice_no, p.invoice_date, p.submitted_at,
         v.name, a.name, p.paid_on, p.note, p.rejected_reason
  from bank_payouts p
  join bookings b on b.id = p.booking_id
  join employees e on e.id = p.employee_id
  join outlets o on o.id = p.outlet_id
  left join financiers fi on fi.id = p.financier_id
  left join employees v on v.id = p.verified_by
  left join employees a on a.id = p.approved_by
  where p_status is null or p.status = p_status
  order by p.submitted_at desc;
$$;

-- In-house cases at DO or disbursed with no payout invoice yet, for the CA (theirs) or the desk (branch).
create or replace function bank_payout_candidates()
returns table (finance_case_id uuid, customer_name text, employee text, financier text, loan_amount numeric, status text)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, b.customer_name, e.name, fi.name, f.loan_amount, f.status
  from finance_cases f
  join bookings b on b.id = f.booking_id
  join employees e on e.id = b.employee_id
  left join financiers fi on fi.id = f.financier_id
  where f.finance_type = 'in_house' and f.status in ('do_received', 'disbursed')
    and not exists (select 1 from bank_payouts p where p.finance_case_id = f.id and p.status <> 'rejected')
    and (b.employee_id = current_employee_id() or ops_can('bank_payouts', 'edit', b.outlet_id))
  order by f.updated_at desc;
$$;

-- ===== Grants =====
do $$
declare
  f text;
begin
  foreach f in array array[
    'set_target(date, uuid, uuid, int)', 'target_vs_actual(date, uuid)', 'save_compliance(date, uuid, boolean, int, boolean, text)',
    'save_incentive_scheme(uuid, jsonb)', 'calculate_incentive_run(date, jsonb)', 'approve_incentive_run(uuid, text)',
    'cancel_incentive_run(uuid, text)', 'release_held_incentives(text, date, text, uuid)', 'incentive_run_lines(uuid)',
    'my_incentive(int)', 'held_incentives_summary()', 'submit_bank_payout(uuid, numeric, text, date)',
    'move_bank_payout(uuid, text, text, date)', 'flag_outhouse_payout(uuid, numeric, text)', 'bank_payout_list(text)',
    'bank_payout_candidates()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke execute on function retail_units(date) from public, anon, authenticated;
revoke execute on function incentive_scheme_for(text, date, uuid) from public, anon, authenticated;
grant execute on function ca_rate(jsonb, int) to authenticated;
