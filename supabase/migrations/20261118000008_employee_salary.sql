-- Employee onboarding: salary type (fixed, or fixed + incentive), monthly salary, ESI and PF.
--   - Kept apart from the employee record, like PAN and bank details: only HR, the Business Head / Admin
--     and the employee themselves can read it. Saved through save_employee_salary(); every change is kept
--     in employee_salary_history.
--   - ESI: applicable or not, with the ESIC IP number (10 digits). PF: applicable or not, with the UAN
--     (12 digits) and optionally the PF member ID.
--   - A new onboarding checklist item, "Salary, ESI and PF recorded", ticks itself when saved.
--   - Incentive runs treat "fixed" salary staff as not eligible (salary not recorded: unchanged).

create table employee_salary (
  employee_id uuid primary key references employees(id),
  salary_type text not null check (salary_type in ('fixed', 'fixed_incentive')),
  monthly_salary numeric not null check (monthly_salary > 0),
  esi_applicable boolean not null default false,
  esi_number text check (esi_number ~ '^[0-9]{10}$'),
  pf_applicable boolean not null default false,
  uan_number text check (uan_number ~ '^[0-9]{12}$'),
  pf_member_id text,
  effective_from date,
  updated_by_employee_id uuid references employees(id),
  updated_at timestamptz not null default now()
);
create index idx_employee_salary_updated_by on employee_salary(updated_by_employee_id);

create table employee_salary_history (
  id bigserial primary key,
  employee_id uuid not null references employees(id),
  salary_type text not null,
  monthly_salary numeric not null,
  esi_applicable boolean not null,
  pf_applicable boolean not null,
  effective_from date,
  changed_by uuid references employees(id),
  changed_at timestamptz not null default now()
);
create index idx_employee_salary_history_employee on employee_salary_history(employee_id, changed_at);
create index idx_employee_salary_history_changed_by on employee_salary_history(changed_by);

alter table employee_salary enable row level security;
alter table employee_salary_history enable row level security;
create policy employee_salary_select on employee_salary for select to authenticated
  using (can_manage_hr() or employee_id = current_employee_id());
create policy employee_salary_history_select on employee_salary_history for select to authenticated
  using (can_manage_hr() or employee_id = current_employee_id());

-- Onboarding checklist item that ticks itself.
alter table hr_task_templates drop constraint hr_task_templates_auto_key_check;
alter table hr_task_templates add constraint hr_task_templates_auto_key_check
  check (auto_key in ('crm_login', 'handover', 'crm_login_off', 'assets_returned', 'salary'));
insert into hr_task_templates (kind, title, sort_order, sales_staff_only, auto_key)
values ('onboarding', 'Salary, ESI and PF recorded', 35, false, 'salary');
-- Employees still being onboarded get the item too.
insert into employee_tasks (employee_id, template_id, kind, title, sort_order, auto_key)
select distinct t.employee_id, h.id, h.kind, h.title, h.sort_order, h.auto_key
from employee_tasks t cross join hr_task_templates h
where t.kind = 'onboarding' and h.auto_key = 'salary'
  and exists (select 1 from employee_tasks p where p.employee_id = t.employee_id and p.kind = 'onboarding' and p.status = 'pending')
  and not exists (select 1 from employee_tasks x where x.employee_id = t.employee_id and x.auto_key = 'salary');

create or replace function save_employee_salary(p_employee_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text := nullif(btrim(coalesce(p->>'salary_type', '')), '');
  v_amount numeric := nullif(regexp_replace(coalesce(p->>'monthly_salary', ''), '[^0-9.]', '', 'g'), '')::numeric;
  v_esi boolean := coalesce(p->>'esi_applicable', '') in ('yes', 'true');
  v_esi_no text := nullif(regexp_replace(coalesce(p->>'esi_number', ''), '\D', '', 'g'), '');
  v_pf boolean := coalesce(p->>'pf_applicable', '') in ('yes', 'true');
  v_uan text := nullif(regexp_replace(coalesce(p->>'uan_number', ''), '\D', '', 'g'), '');
  v_old employee_salary%rowtype;
begin
  perform hr_require_manager();
  if not exists (select 1 from employees where id = p_employee_id) then
    raise exception 'Employee not found';
  end if;
  if v_type is null or v_type not in ('fixed', 'fixed_incentive') then
    raise exception 'Choose the salary type: fixed, or fixed + incentive';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'Enter the monthly salary';
  end if;
  if v_esi_no is not null and length(v_esi_no) <> 10 then
    raise exception 'The ESIC IP number should be 10 digits';
  end if;
  if v_uan is not null and length(v_uan) <> 12 then
    raise exception 'The UAN should be 12 digits';
  end if;
  select * into v_old from employee_salary where employee_id = p_employee_id;
  insert into employee_salary as s (employee_id, salary_type, monthly_salary, esi_applicable, esi_number, pf_applicable,
                                    uan_number, pf_member_id, effective_from, updated_by_employee_id)
  values (p_employee_id, v_type, v_amount, v_esi, case when v_esi then v_esi_no end, v_pf, case when v_pf then v_uan end,
          case when v_pf then nullif(upper(btrim(coalesce(p->>'pf_member_id', ''))), '') end,
          nullif(p->>'effective_from', '')::date, current_employee_id())
  on conflict (employee_id) do update set
    salary_type = excluded.salary_type, monthly_salary = excluded.monthly_salary, esi_applicable = excluded.esi_applicable,
    esi_number = excluded.esi_number, pf_applicable = excluded.pf_applicable, uan_number = excluded.uan_number,
    pf_member_id = excluded.pf_member_id, effective_from = excluded.effective_from,
    updated_by_employee_id = excluded.updated_by_employee_id, updated_at = now();
  if v_old.employee_id is null or v_old.salary_type <> v_type or v_old.monthly_salary <> v_amount
     or v_old.esi_applicable <> v_esi or v_old.pf_applicable <> v_pf then
    insert into employee_salary_history (employee_id, salary_type, monthly_salary, esi_applicable, pf_applicable, effective_from, changed_by)
    values (p_employee_id, v_type, v_amount, v_esi, v_pf, nullif(p->>'effective_from', '')::date, current_employee_id());
  end if;
  perform hr_tick_auto(p_employee_id, 'salary');
end;
$$;

-- The salary type the incentive engine checks (null when not recorded).
create or replace function employee_salary_type(p_employee_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select salary_type from employee_salary where employee_id = p_employee_id;
$$;

revoke execute on function save_employee_salary(uuid, jsonb) from public, anon;
grant execute on function save_employee_salary(uuid, jsonb) to authenticated;
revoke execute on function employee_salary_type(uuid) from public, anon, authenticated;

-- Incentive runs: fixed-salary staff are not eligible.
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
    if employee_salary_type(e.id) = 'fixed' then
      v_reasons := array_append(v_reasons, 'Fixed salary (no incentive)');
    end if;
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

  -- Everyone else on a fixed salary (Team Leader, GM / SM, Finance) earns no incentive either.
  update incentive_lines set eligible = false, ineligible_reason = 'Fixed salary (no incentive)',
    release_now = 0, held = 0, held_until = null
  where run_id = v_run.id and kind <> 'ca_retail' and employee_salary_type(employee_id) = 'fixed';

  update incentive_runs set calculated_by = current_employee_id(), calculated_at = now() where id = v_run.id;
  return v_run.id;
end;
$$;
