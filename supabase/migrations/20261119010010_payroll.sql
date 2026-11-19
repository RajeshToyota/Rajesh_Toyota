-- Phase 32: Payroll — Techwheels' payroll on top of Rajesh Toyota's salary record and incentive engine.
--   Salary: bank account, IFSC, payment type (NEFT / DCR) and which parts of pay apply (Techwheels'
--     salary types): base, variable, both, base_finance.
--   Attendance: present and leave days per month (half days allowed); 4 paid leaves (configurable);
--     leave deduction = base ÷ days in month × leave beyond the allowance, for salary types with base.
--   Advances: lump / EMI / custom schedule; EMI = total ÷ months with the remainder on the last;
--     a custom schedule must add up to the total.
--   Payroll incentive rules (Techwheels' payroll_incentive_rules), per role or per employee (the
--     employee's rule wins), counted on cars invoiced in the month:
--       per_car_flat (+ ev_share_slab extra), min_cars (gate), vin_flat, model bonus (dealer_model_bonus
--       by model + fuel, reduced by a negative car margin), above_target_slab, do_percent (finance,
--       once the bank has paid), inhouse_finance_flat, used_car_slab, accessories_percent; a car
--       received from another dealer counts half.
--   Payroll run: one entry per employee per month: base − leave + RT incentive released + the rule
--   components − advance; per-category locks (unlock needs Payroll: approve), overrides with a note;
--   lock & finalise applies advance deductions capped at what was earned and carries the shortfall to
--   the next month; bank export per payment type; salary slips from the entries.

-- ===== Salary =====
alter table employee_salary
  add column bank_account_no text check (bank_account_no is null or bank_account_no ~ '^[0-9]{6,20}$'),
  add column bank_ifsc text check (bank_ifsc is null or bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  add column payment_type text not null default 'NEFT' check (payment_type in ('NEFT', 'DCR')),
  add column pay_components text check (pay_components in ('base', 'variable', 'both', 'base_finance'));
update employee_salary set pay_components = case salary_type when 'fixed' then 'base' else 'both' end where pay_components is null;

create table payroll_config (
  id boolean primary key default true check (id),
  paid_leave_allowance numeric not null default 4 check (paid_leave_allowance >= 0),
  inward_transfer_factor numeric not null default 0.5 check (inward_transfer_factor between 0 and 1)
);
insert into payroll_config (id) values (true);

-- ===== Attendance =====
create table payroll_attendance (
  employee_id uuid not null references employees(id),
  month date not null check (month = date_trunc('month', month)::date),
  present_days numeric not null check (present_days >= 0 and present_days * 2 = floor(present_days * 2)),
  leave_days numeric not null default 0 check (leave_days >= 0 and leave_days * 2 = floor(leave_days * 2)),
  updated_by uuid references employees(id) default current_employee_id(),
  updated_at timestamptz not null default now(),
  primary key (employee_id, month)
);
create index idx_payroll_attendance_by on payroll_attendance(updated_by);

-- ===== Advances =====
create table payroll_advances (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  total_amount numeric not null check (total_amount > 0),
  recovered_amount numeric not null default 0 check (recovered_amount >= 0),
  deduction_type text not null check (deduction_type in ('lump', 'emi', 'custom')),
  start_month date not null check (start_month = date_trunc('month', start_month)::date),
  reason text,
  status text not null default 'open' check (status in ('open', 'partial', 'closed')),
  created_by uuid references employees(id) default current_employee_id(),
  created_at timestamptz not null default now()
);
create index idx_payroll_advances_employee on payroll_advances(employee_id);
create index idx_payroll_advances_by on payroll_advances(created_by);

create table payroll_advance_deductions (
  id uuid primary key default gen_random_uuid(),
  advance_id uuid not null references payroll_advances(id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  amount numeric not null check (amount > 0),
  applied_amount numeric,
  applied_at timestamptz
);
create index idx_payroll_adv_ded_advance on payroll_advance_deductions(advance_id, month);

-- The schedule: lump = all in the start month; EMI = round(total / n), the last takes the remainder;
-- custom = the given amounts, which must add up to the total.
create or replace function payroll_advance_schedule(p_total numeric, p_type text, p_months int, p_custom numeric[])
returns numeric[]
language plpgsql
immutable
set search_path = public
as $$
declare
  v numeric[] := '{}';
  v_each numeric;
  i int;
begin
  if p_type = 'lump' then
    return array[p_total];
  elsif p_type = 'emi' then
    if coalesce(p_months, 0) < 1 then raise exception 'Enter the number of instalments'; end if;
    v_each := round(p_total / p_months);
    for i in 1..p_months - 1 loop v := v || v_each; end loop;
    return v || (p_total - v_each * (p_months - 1));
  elsif p_type = 'custom' then
    if coalesce(cardinality(p_custom), 0) = 0 or exists (select 1 from unnest(p_custom) x where x <= 0) then
      raise exception 'Enter the instalments';
    end if;
    if (select sum(x) from unnest(p_custom) x) <> p_total then
      raise exception 'The instalments add up to %, not %', (select sum(x) from unnest(p_custom) x), p_total;
    end if;
    return p_custom;
  end if;
  raise exception 'Unknown deduction type';
end;
$$;

create or replace function create_advance(p_employee_id uuid, p_total numeric, p_type text, p_start_month date,
                                          p_months int default null, p_custom numeric[] default null, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_sched numeric[];
  i int;
begin
  if not has_right('payroll', 'edit') then raise exception 'You need Payroll: edit'; end if;
  v_sched := payroll_advance_schedule(p_total, p_type, p_months, p_custom);
  insert into payroll_advances (employee_id, total_amount, deduction_type, start_month, reason)
  values (p_employee_id, p_total, p_type, date_trunc('month', p_start_month)::date, nullif(btrim(p_reason), ''))
  returning id into v_id;
  for i in 1..cardinality(v_sched) loop
    insert into payroll_advance_deductions (advance_id, month, amount)
    values (v_id, (date_trunc('month', p_start_month) + make_interval(months => i - 1))::date, v_sched[i]);
  end loop;
  return v_id;
end;
$$;

-- ===== Payroll incentive rules =====
create table payroll_incentive_rules (
  id uuid primary key default gen_random_uuid(),
  role_id uuid references roles(id),
  employee_id uuid references employees(id),
  rule_type text not null check (rule_type in ('per_car_flat', 'ev_share_slab', 'min_cars', 'vin_flat', 'model_bonus_margin',
                                               'above_target_slab', 'do_percent', 'inhouse_finance_flat', 'used_car_slab',
                                               'accessories_percent')),
  amount numeric,
  percent numeric,
  slab_from numeric,
  slab_to numeric,
  vin text,
  valid_from date not null check (valid_from = date_trunc('month', valid_from)::date),
  valid_to date check (valid_to is null or valid_to = date_trunc('month', valid_to)::date),
  is_active boolean not null default true,
  note text,
  check ((role_id is null) <> (employee_id is null)),
  check (rule_type <> 'vin_flat' or vin is not null)
);
create index idx_payroll_rules_role on payroll_incentive_rules(role_id);
create index idx_payroll_rules_employee on payroll_incentive_rules(employee_id);

create table dealer_model_bonus (
  id uuid primary key default gen_random_uuid(),
  month date not null check (month = date_trunc('month', month)::date),
  model_id uuid not null references models(id),
  fuel_type_id uuid references fuel_types(id),
  bonus_per_car numeric not null check (bonus_per_car >= 0),
  unique (month, model_id, fuel_type_id)
);
create index idx_dealer_model_bonus_model on dealer_model_bonus(model_id);
create index idx_dealer_model_bonus_fuel on dealer_model_bonus(fuel_type_id);

-- The rules that apply to an employee in a month: their own rule of a type beats their role's.
create or replace function payroll_rules_for(p_employee_id uuid, p_month date)
returns setof payroll_incentive_rules
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select r.* from payroll_incentive_rules r join employees e on e.id = p_employee_id
    where r.is_active and r.valid_from <= p_month and (r.valid_to is null or r.valid_to >= p_month)
      and (r.employee_id = e.id or r.role_id = e.role_id)
  )
  select * from mine m
  where m.employee_id is not null
     or not exists (select 1 from mine x where x.employee_id is not null and x.rule_type = m.rule_type);
$$;

-- ===== Payroll entries =====
create table payroll_runs (
  month date primary key check (month = date_trunc('month', month)::date),
  status text not null default 'draft' check (status in ('draft', 'locked')),
  calculated_at timestamptz,
  calculated_by uuid references employees(id),
  locked_at timestamptz,
  locked_by uuid references employees(id)
);
create index idx_payroll_runs_calc_by on payroll_runs(calculated_by);
create index idx_payroll_runs_locked_by on payroll_runs(locked_by);

create table payroll_entries (
  month date not null references payroll_runs(month) on delete cascade,
  employee_id uuid not null references employees(id),
  pay_components text not null,
  base_salary numeric not null default 0,
  leave_days numeric not null default 0,
  leave_deduction numeric not null default 0,
  incentive_release numeric not null default 0,      -- RT incentive run: released this month
  car_payout numeric not null default 0,
  model_bonus numeric not null default 0,
  above_target numeric not null default 0,
  finance_payout numeric not null default 0,
  used_car_payout numeric not null default 0,
  accessories_payout numeric not null default 0,
  advance_deduction numeric not null default 0,
  basis jsonb not null default '{}',
  car_sales_locked boolean not null default false,
  finance_locked boolean not null default false,
  used_car_locked boolean not null default false,
  accessories_locked boolean not null default false,
  override_notes text,
  gross_payout numeric generated always as (base_salary + incentive_release + car_payout + model_bonus + above_target
                                            + finance_payout + used_car_payout + accessories_payout) stored,
  net_payable numeric generated always as (base_salary + incentive_release + car_payout + model_bonus + above_target
                                           + finance_payout + used_car_payout + accessories_payout - leave_deduction - advance_deduction) stored,
  primary key (month, employee_id)
);
create index idx_payroll_entries_employee on payroll_entries(employee_id);

-- Calculate (or recalculate) a month. Locked categories keep their amounts.
create or replace function calculate_payroll(p_month date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_next date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_days int := extract(day from (v_next - interval '1 day'))::int;
  cfg payroll_config%rowtype;
  s record;
  r payroll_incentive_rules%rowtype;
  old payroll_entries%rowtype;
  n int := 0;
  v_base numeric; v_leave numeric; v_leave_ded numeric; v_inc numeric;
  v_cars numeric; v_cars_n int; v_ev int; v_flat numeric; v_ev_extra numeric; v_min int; v_car numeric; v_model numeric;
  v_vin_cars int; v_target int; v_above numeric; v_fin numeric; v_used numeric; v_acc numeric; v_adv numeric;
  v_has_base boolean; v_has_var boolean; v_has_fin boolean;
  c record;
  v_bonus numeric;
  v_margin numeric;
  v_acc_total numeric;
  v_used_n int;
begin
  if not has_right('payroll', 'edit') then raise exception 'You need Payroll: edit'; end if;
  if exists (select 1 from payroll_runs where month = v_month and status = 'locked') then
    raise exception 'This month is locked';
  end if;
  select * into cfg from payroll_config;
  insert into payroll_runs (month, calculated_at, calculated_by) values (v_month, now(), current_employee_id())
  on conflict (month) do update set calculated_at = now(), calculated_by = excluded.calculated_by;

  for s in
    select e.id, sal.monthly_salary, coalesce(sal.pay_components, 'both') as comp
    from employees e join employee_salary sal on sal.employee_id = e.id
    where e.is_active or e.exit_date >= v_month
  loop
    select * into old from payroll_entries where month = v_month and employee_id = s.id;
    v_has_base := s.comp <> 'variable';
    v_has_var := s.comp in ('variable', 'both');
    v_has_fin := s.comp <> 'base';

    -- Base and leave.
    v_base := case when v_has_base then s.monthly_salary else 0 end;
    select coalesce(leave_days, 0) into v_leave from payroll_attendance where employee_id = s.id and month = v_month;
    v_leave := coalesce(v_leave, 0);
    v_leave_ded := case when v_has_base then round(v_base / v_days * greatest(0, v_leave - cfg.paid_leave_allowance), 2) else 0 end;

    -- RT incentive engine: what its approved run releases this month.
    v_inc := case when v_has_var then coalesce((
      select sum(l.release_now) from incentive_lines l join incentive_runs ir on ir.id = l.run_id
      where ir.month = v_month and ir.status = 'approved' and l.employee_id = s.id and l.eligible), 0) else 0 end;

    -- Cars invoiced in the month (a car received from another dealer counts half).
    v_cars := 0; v_cars_n := 0; v_ev := 0; v_car := 0; v_model := 0; v_vin_cars := 0; v_above := 0;
    if v_has_var then
      select count(*), coalesce(sum(case when exists (select 1 from stock_transfers t where t.vehicle_id = br.vehicle_id and t.direction = 'inward')
                                          then cfg.inward_transfer_factor else 1 end), 0),
             count(*) filter (where va.is_ev)
      into v_cars_n, v_cars, v_ev
      from billing_requests br join bookings b on b.id = br.booking_id left join variants va on va.id = b.variant_id
      where br.status = 'invoiced' and br.invoice_date >= v_month and br.invoice_date < v_next and b.employee_id = s.id;

      select amount into v_flat from payroll_rules_for(s.id, v_month) where rule_type = 'per_car_flat' limit 1;
      select amount into v_ev_extra from payroll_rules_for(s.id, v_month)
      where rule_type = 'ev_share_slab' and v_cars_n > 0 and slab_from <= v_ev * 100.0 / v_cars_n order by slab_from desc limit 1;
      select amount::int into v_min from payroll_rules_for(s.id, v_month) where rule_type = 'min_cars' limit 1;
      if v_min is not null and v_cars_n < v_min then v_ev_extra := null; end if;
      v_car := round(v_cars * (coalesce(v_flat, 0) + coalesce(v_ev_extra, 0)), 2);

      -- Per car: a VIN rule replaces the model bonus; the model bonus shrinks by a negative margin.
      if v_min is null or v_cars_n >= v_min then
        for c in
          select b.id, v.vin, va.model_id, va.fuel_type_id, coalesce((b.priced_snapshot->>'dealer_margin')::numeric, 0) as margin
          from billing_requests br join bookings b on b.id = br.booking_id join vehicles v on v.id = br.vehicle_id
          left join variants va on va.id = b.variant_id
          where br.status = 'invoiced' and br.invoice_date >= v_month and br.invoice_date < v_next and b.employee_id = s.id
        loop
          select amount into v_bonus from payroll_rules_for(s.id, v_month) where rule_type = 'vin_flat' and upper(vin) = upper(c.vin) limit 1;
          if v_bonus is not null then
            v_model := v_model + v_bonus; v_vin_cars := v_vin_cars + 1;
          elsif exists (select 1 from payroll_rules_for(s.id, v_month) where rule_type = 'model_bonus_margin') then
            select bonus_per_car into v_bonus from dealer_model_bonus d
            where d.month = v_month and d.model_id = c.model_id and (d.fuel_type_id = c.fuel_type_id or d.fuel_type_id is null)
            order by d.fuel_type_id nulls last limit 1;
            v_margin := c.margin;
            v_model := v_model + least(coalesce(v_bonus, 0), greatest(0, coalesce(v_bonus, 0) + least(0, v_margin)));
          end if;
          v_bonus := null;
        end loop;
        select coalesce(sum(target_units), 0) into v_target from employee_monthly_targets where employee_id = s.id and month = v_month;
        select amount into v_bonus from payroll_rules_for(s.id, v_month) where rule_type = 'above_target_slab' limit 1;
        v_above := greatest(0, v_cars_n - v_vin_cars - v_target) * coalesce(v_bonus, 0);
      end if;
    end if;

    -- Finance: a share of DO once the bank has paid, plus a flat per in-house case.
    v_fin := 0;
    if v_has_fin then
      select coalesce(sum(round(p.do_value * coalesce((select percent from payroll_rules_for(s.id, v_month) where rule_type = 'do_percent' limit 1),
                                                       p.rate_percent) / 100, 2)), 0)
             + count(*) * coalesce((select amount from payroll_rules_for(s.id, v_month) where rule_type = 'inhouse_finance_flat' limit 1), 0)
      into v_fin
      from finance_sp_payouts(v_month) p where p.employee_id = s.id and p.released;
    end if;

    -- Used cars bought in against the employee's invoiced bookings; accessories above the threshold.
    v_used := 0; v_acc := 0;
    if v_has_var then
      select count(distinct b.id) into v_used_n
      from billing_requests br join bookings b on b.id = br.booking_id
      where br.status = 'invoiced' and br.invoice_date >= v_month and br.invoice_date < v_next and b.employee_id = s.id
        and exists (select 1 from payment_receipts pr where pr.booking_id = b.id and pr.mode = 'exchange' and pr.clearance_status = 'cleared');
      select coalesce(amount, 0) into v_used from payroll_rules_for(s.id, v_month)
      where rule_type = 'used_car_slab' and v_used_n >= slab_from and (slab_to is null or v_used_n <= slab_to) limit 1;
      v_used := coalesce(v_used, 0) * v_used_n;

      select * into r from payroll_rules_for(s.id, v_month) where rule_type = 'accessories_percent' limit 1;
      if r.id is not null then
        select coalesce(sum(coalesce(b.revised_accessories_amount, w.accessories_total, 0)), 0) into v_acc_total
        from billing_requests br join bookings b on b.id = br.booking_id left join welcome_dockets w on w.booking_id = b.id
        where br.status = 'invoiced' and br.invoice_date >= v_month and br.invoice_date < v_next and b.employee_id = s.id;
        if v_acc_total > coalesce(r.amount, 0) * v_cars_n then
          v_acc := round(v_acc_total / (1 + (select gst_percent from finance_config) / 100) * r.percent / 100, 2);
        end if;
      end if;
    end if;

    -- Advance due this month (applied, capped, when the month is locked).
    select coalesce(sum(d.amount), 0) into v_adv from payroll_advance_deductions d join payroll_advances a on a.id = d.advance_id
    where a.employee_id = s.id and d.month = v_month and d.applied_at is null;

    insert into payroll_entries (month, employee_id, pay_components, base_salary, leave_days, leave_deduction, incentive_release,
                                 car_payout, model_bonus, above_target, finance_payout, used_car_payout, accessories_payout,
                                 advance_deduction, basis)
    values (v_month, s.id, s.comp, v_base, v_leave, v_leave_ded, v_inc, v_car, v_model, v_above, v_fin, v_used, v_acc, v_adv,
            jsonb_build_object('cars', v_cars_n, 'cars_weighted', v_cars, 'ev_cars', v_ev, 'per_car', v_flat, 'ev_extra', v_ev_extra,
                               'min_cars', v_min, 'target', v_target, 'vin_cars', v_vin_cars, 'used_cars', v_used_n,
                               'accessories_total', v_acc_total, 'days_in_month', v_days, 'paid_leave', cfg.paid_leave_allowance))
    on conflict (month, employee_id) do update set
      pay_components = excluded.pay_components, base_salary = excluded.base_salary, leave_days = excluded.leave_days,
      leave_deduction = excluded.leave_deduction, incentive_release = excluded.incentive_release,
      car_payout = case when payroll_entries.car_sales_locked then payroll_entries.car_payout else excluded.car_payout end,
      model_bonus = case when payroll_entries.car_sales_locked or payroll_entries.override_notes like '%[model_bonus]%' then payroll_entries.model_bonus else excluded.model_bonus end,
      above_target = case when payroll_entries.car_sales_locked or payroll_entries.override_notes like '%[above_target]%' then payroll_entries.above_target else excluded.above_target end,
      finance_payout = case when payroll_entries.finance_locked then payroll_entries.finance_payout else excluded.finance_payout end,
      used_car_payout = case when payroll_entries.used_car_locked then payroll_entries.used_car_payout else excluded.used_car_payout end,
      accessories_payout = case when payroll_entries.accessories_locked then payroll_entries.accessories_payout else excluded.accessories_payout end,
      advance_deduction = excluded.advance_deduction, basis = excluded.basis;
    n := n + 1;
    v_acc_total := null; v_flat := null; v_ev_extra := null; v_min := null; r := null;
  end loop;
  return n;
end;
$$;

-- Lock or unlock one category of an entry. Unlocking needs Payroll: approve.
create or replace function set_payroll_lock(p_month date, p_employee_id uuid, p_category text, p_locked boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_category not in ('car_sales', 'finance', 'used_car', 'accessories') then raise exception 'Unknown category'; end if;
  if p_locked and not has_right('payroll', 'edit') then raise exception 'You need Payroll: edit'; end if;
  if not p_locked and not has_right('payroll', 'approve') then raise exception 'Unlocking needs Payroll: approve'; end if;
  execute format('update payroll_entries set %I = $1 where month = $2 and employee_id = $3', p_category || '_locked')
    using p_locked, date_trunc('month', p_month)::date, p_employee_id;
end;
$$;

-- Override the above-target or model bonus amount, with a reason kept on the entry.
create or replace function payroll_override(p_month date, p_employee_id uuid, p_field text, p_amount numeric, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not has_right('payroll', 'approve') then raise exception 'Overrides need Payroll: approve'; end if;
  if p_field not in ('above_target', 'model_bonus') then raise exception 'Only the above-target and model bonus can be overridden'; end if;
  if nullif(btrim(p_note), '') is null then raise exception 'Give the reason'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Enter the amount'; end if;
  if exists (select 1 from payroll_runs where month = date_trunc('month', p_month)::date and status = 'locked') then raise exception 'This month is locked'; end if;
  execute format('update payroll_entries set %I = $1, override_notes = concat_ws(E''\n'', override_notes, $2) where month = $3 and employee_id = $4', p_field)
    using p_amount, '[' || p_field || '] ' || btrim(p_note), date_trunc('month', p_month)::date, p_employee_id;
end;
$$;

-- Lock & finalise: advance deductions are applied up to what each person earned this month; what
-- could not be recovered moves to next month's instalment.
create or replace function lock_payroll(p_month date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_next date := (date_trunc('month', p_month) + interval '1 month')::date;
  e payroll_entries%rowtype;
  d record;
  v_room numeric;
  v_take numeric;
  v_applied numeric;
begin
  if not has_right('payroll', 'approve') then raise exception 'Locking needs Payroll: approve'; end if;
  if not exists (select 1 from payroll_runs where month = v_month and status = 'draft') then raise exception 'Calculate the month first'; end if;
  for e in select * from payroll_entries where month = v_month loop
    v_room := greatest(0, e.gross_payout - e.leave_deduction);
    v_applied := 0;
    for d in
      select pd.*, a.id as adv from payroll_advance_deductions pd join payroll_advances a on a.id = pd.advance_id
      where a.employee_id = e.employee_id and pd.month = v_month and pd.applied_at is null
      order by a.created_at
    loop
      v_take := least(d.amount, v_room);
      v_room := v_room - v_take;
      v_applied := v_applied + v_take;
      update payroll_advance_deductions set applied_amount = v_take, applied_at = now() where id = d.id;
      update payroll_advances set recovered_amount = recovered_amount + v_take,
        status = case when recovered_amount + v_take >= total_amount then 'closed' else 'partial' end
      where id = d.adv;
      if v_take < d.amount then
        insert into payroll_advance_deductions (advance_id, month, amount) values (d.adv, v_next, d.amount - v_take);
      end if;
    end loop;
    update payroll_entries set advance_deduction = v_applied, car_sales_locked = true, finance_locked = true,
      used_car_locked = true, accessories_locked = true
    where month = v_month and employee_id = e.employee_id;
  end loop;
  update payroll_runs set status = 'locked', locked_at = now(), locked_by = current_employee_id() where month = v_month;
end;
$$;

-- Bank file rows for one payment type.
create or replace function payroll_bank_export(p_month date, p_payment_type text)
returns table (employee_code text, employee text, account_no text, ifsc text, amount numeric)
language sql
stable
security definer
set search_path = public
as $$
  select e.employee_code, e.name, s.bank_account_no, s.bank_ifsc, p.net_payable
  from payroll_entries p join employees e on e.id = p.employee_id join employee_salary s on s.employee_id = e.id
  where p.month = date_trunc('month', p_month)::date and s.payment_type = p_payment_type and p.net_payable > 0
    and has_right('payroll', 'view')
  order by e.name;
$$;

-- ===== RLS =====
alter table payroll_config enable row level security;
alter table payroll_attendance enable row level security;
alter table payroll_advances enable row level security;
alter table payroll_advance_deductions enable row level security;
alter table payroll_incentive_rules enable row level security;
alter table dealer_model_bonus enable row level security;
alter table payroll_runs enable row level security;
alter table payroll_entries enable row level security;
create policy payroll_config_select on payroll_config for select to authenticated using (true);
create policy payroll_config_write on payroll_config for update to authenticated using (has_right('payroll', 'approve'));
create policy payroll_attendance_select on payroll_attendance for select to authenticated using (has_right('payroll', 'view') or employee_id = current_employee_id());
create policy payroll_attendance_write on payroll_attendance for all to authenticated
  using (has_right('payroll', 'edit')) with check (has_right('payroll', 'edit') and not exists (
    select 1 from payroll_runs r where r.month = payroll_attendance.month and r.status = 'locked'));
create policy payroll_advances_select on payroll_advances for select to authenticated using (has_right('payroll', 'view') or employee_id = current_employee_id());
create policy payroll_adv_ded_select on payroll_advance_deductions for select to authenticated
  using (exists (select 1 from payroll_advances a where a.id = advance_id and (has_right('payroll', 'view') or a.employee_id = current_employee_id())));
create policy payroll_rules_select on payroll_incentive_rules for select to authenticated using (has_right('payroll', 'view'));
create policy payroll_rules_write on payroll_incentive_rules for all to authenticated using (has_right('payroll', 'edit')) with check (has_right('payroll', 'edit'));
create policy dealer_model_bonus_select on dealer_model_bonus for select to authenticated using (true);
create policy dealer_model_bonus_write on dealer_model_bonus for all to authenticated using (has_right('payroll', 'edit')) with check (has_right('payroll', 'edit'));
create policy payroll_runs_select on payroll_runs for select to authenticated using (true);
create policy payroll_entries_select on payroll_entries for select to authenticated using (has_right('payroll', 'view') or employee_id = current_employee_id());

do $$
declare f text;
begin
  foreach f in array array[
    'create_advance(uuid, numeric, text, date, int, numeric[], text)', 'payroll_rules_for(uuid, date)', 'calculate_payroll(date)',
    'set_payroll_lock(date, uuid, text, boolean)', 'payroll_override(date, uuid, text, numeric, text)', 'lock_payroll(date)',
    'payroll_bank_export(date, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
grant execute on function payroll_advance_schedule(numeric, text, int, numeric[]) to authenticated;

insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('payroll', 'people', 'Payroll', '/payroll', 40, true);
select seed_role_rights('HR', 'payroll', array['view', 'edit']);
