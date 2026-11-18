-- Phase 22: exchange and used cars (Techwheels' exchange business, used-car evaluations, negotiation and
-- stock), for Toyota U Trust.
--
--   Evaluation   a consultant asks for the customer's old car to be valued (from an enquiry or booking);
--                the branch's Used Car Evaluator inspects it (photos, condition, history) and values it.
--   Negotiation  dealer offers and customer counters are logged; an offer above the evaluator's value by
--                more than 5% needs the Outlet Head.
--   Procurement  the accepted car is bought in: it joins used-car stock, and when the evaluation is tied to
--                a booking its value goes on the booking as an "exchange" receipt (cleared at once), so
--                the customer's outstanding drops by that amount.
--   Stock        refurbish, list, sell; margin = sold − bought − refurbishment.
--   U Trust      Toyota cars up to 7 years old and 1,20,000 km are flagged U Trust-eligible.

-- ===== Modules and rights =====
insert into menu_groups (key, title, sort_order) values ('used', 'Used Cars', 27) on conflict (key) do nothing;
insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('used_car_evaluations', 'used', 'Exchange Evaluations', '/used-cars/evaluations', 10, true),
  ('used_car_stock',       'used', 'Used Car Stock',       '/used-cars/stock',       20, true),
  ('rpt_used_cars',        'used', 'Exchange Summary',     '/used-cars/summary',     30, true);

select seed_role_rights(r, m, x) from (values
  ('Outlet Head', 'used_car_evaluations', array['view','create','edit','approve']), ('Outlet Head', 'used_car_stock', array['view','create','edit']),
  ('Outlet Head', 'rpt_used_cars', array['view']),
  ('Head Customer Relations', 'used_car_evaluations', array['view','create']), ('Head Customer Relations', 'rpt_used_cars', array['view']),
  ('Team Leader', 'used_car_evaluations', array['view','create']),
  ('Sales Consultant', 'used_car_evaluations', array['view','create']),
  ('Used Car Evaluator', 'used_car_evaluations', array['view','edit']), ('Used Car Evaluator', 'used_car_stock', array['view','create','edit']),
  ('Used Car Evaluator', 'rpt_used_cars', array['view']),
  ('Accounts', 'used_car_stock', array['view']), ('Accounts', 'rpt_used_cars', array['view'])
) v(r, m, x);

-- ===== Tables =====
create table used_car_evaluations (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references outlets(id),
  enquiry_id uuid references enquiries(id),
  booking_id uuid references bookings(id),
  customer_name text not null,
  customer_mobile text,
  reg_no text not null,
  make text not null default 'Toyota',
  model text not null,
  variant text,
  fuel text,
  transmission text,
  mfg_year int check (mfg_year between 1990 and 2100),
  odometer_km int check (odometer_km >= 0),
  owners int check (owners between 1 and 10),
  colour text,
  insurance_valid_till date,
  hypothecated_to text,
  accident_history text,
  condition jsonb not null default '{}',       -- {"engine": 1-5, "body": 1-5, "interior": 1-5, "tyres": 1-5}
  photo_paths text[] not null default '{}',
  status text not null default 'requested'
    check (status in ('requested', 'evaluated', 'negotiating', 'accepted', 'procured', 'rejected', 'cancelled')),
  customer_expected numeric,
  evaluator_price numeric,
  final_price numeric,
  offer_valid_till date,
  remarks text,
  close_reason text,
  requested_by uuid references employees(id),
  requested_at timestamptz not null default now(),
  evaluator_id uuid references employees(id),
  evaluated_at timestamptz,
  decided_at timestamptz
);
create index idx_uce_outlet_status on used_car_evaluations(outlet_id, status);
create index idx_uce_enquiry on used_car_evaluations(enquiry_id);
create index idx_uce_booking on used_car_evaluations(booking_id);
create index idx_uce_requested_by on used_car_evaluations(requested_by);
create index idx_uce_evaluator on used_car_evaluations(evaluator_id);
create unique index uq_uce_open_reg on used_car_evaluations(upper(replace(reg_no, ' ', '')))
  where status in ('requested', 'evaluated', 'negotiating', 'accepted');

create table used_car_negotiations (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null references used_car_evaluations(id),
  side text not null check (side in ('dealer', 'customer')),
  amount numeric not null check (amount > 0),
  note text,
  by_employee_id uuid references employees(id),
  created_at timestamptz not null default now()
);
create index idx_ucn_evaluation on used_car_negotiations(evaluation_id, created_at);
create index idx_ucn_by on used_car_negotiations(by_employee_id);

create table used_car_vehicles (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null unique references used_car_evaluations(id),
  outlet_id uuid not null references outlets(id),
  reg_no text not null,
  status text not null default 'in_stock' check (status in ('in_stock', 'refurbishing', 'listed', 'sold', 'returned')),
  procurement_price numeric not null,
  procured_on date not null,
  refurbishment_cost numeric not null default 0,
  listed_price numeric,
  sold_price numeric,
  sold_on date,
  buyer_name text,
  buyer_mobile text,
  exchange_receipt_id uuid references payment_receipts(id),
  notes text,
  procured_by uuid references employees(id),
  updated_at timestamptz not null default now()
);
create index idx_ucv_outlet_status on used_car_vehicles(outlet_id, status);
create index idx_ucv_receipt on used_car_vehicles(exchange_receipt_id);
create index idx_ucv_procured_by on used_car_vehicles(procured_by);

alter table used_car_evaluations enable row level security;
alter table used_car_negotiations enable row level security;
alter table used_car_vehicles enable row level security;

-- Who works an evaluation: the requester's line, the branch's evaluator and back office.
create or replace function can_see_evaluation(e used_car_evaluations)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select ops_can('used_car_evaluations', 'view', e.outlet_id)
     and (is_branch_back_office(e.outlet_id) or has_right('used_car_evaluations', 'edit')
          or can_access_employee_data(current_employee_id(), e.requested_by));
$$;

create policy uce_select on used_car_evaluations for select to authenticated using (can_see_evaluation(used_car_evaluations));
create policy ucn_select on used_car_negotiations for select to authenticated
  using (exists (select 1 from used_car_evaluations e where e.id = evaluation_id));
create policy ucv_select on used_car_vehicles for select to authenticated using (ops_can('used_car_stock', 'view', outlet_id));

-- Toyota, at most 7 years old and 1,20,000 km.
create or replace function utrust_eligible(e used_car_evaluations)
returns boolean
language sql
stable
as $$
  select upper(e.make) = 'TOYOTA' and e.mfg_year is not null
     and extract(year from now() at time zone 'Asia/Kolkata')::int - e.mfg_year <= 7
     and coalesce(e.odometer_km, 0) <= 120000;
$$;

-- ===== Evaluation =====
create or replace function request_evaluation(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enq enquiries%rowtype;
  v_bk bookings%rowtype;
  v_cust customers%rowtype;
  v_outlet uuid;
  v_id uuid;
begin
  if nullif(p->>'enquiry_id', '') is not null then
    select * into v_enq from enquiries where id = (p->>'enquiry_id')::uuid;
    if v_enq.id is null or not (can_access_employee_data(current_employee_id(), v_enq.assigned_employee_id) or is_crm_back_office()) then
      raise exception 'Enquiry not found';
    end if;
    select * into v_cust from customers where id = v_enq.customer_id;
    v_outlet := v_enq.outlet_id;
  end if;
  if nullif(p->>'booking_id', '') is not null then
    select * into v_bk from bookings where id = (p->>'booking_id')::uuid;
    if v_bk.id is null or not can_work_booking_rm(v_bk) then raise exception 'Booking not found'; end if;
    if v_bk.status in ('delivered', 'cancelled') then raise exception 'This booking is closed'; end if;
    v_outlet := v_bk.outlet_id;
    if v_cust.id is null then select * into v_cust from customers where id = v_bk.customer_id; end if;
  end if;
  v_outlet := coalesce(v_outlet, current_employee_outlet_id());
  if not ops_can('used_car_evaluations', 'create', v_outlet) then raise exception 'You cannot ask for evaluations at this branch'; end if;
  if nullif(btrim(p->>'reg_no'), '') is null or nullif(btrim(p->>'model'), '') is null then
    raise exception 'Enter the registration number and model';
  end if;
  insert into used_car_evaluations (outlet_id, enquiry_id, booking_id, customer_name, customer_mobile, reg_no, make, model, variant,
                                    fuel, transmission, mfg_year, odometer_km, owners, customer_expected, remarks, requested_by)
  values (v_outlet, v_enq.id, v_bk.id, coalesce(v_cust.name, v_bk.customer_name, nullif(btrim(p->>'customer_name'), '')),
          coalesce(v_cust.mobile, v_bk.customer_mobile, normalize_mobile(p->>'customer_mobile')),
          upper(regexp_replace(btrim(p->>'reg_no'), '\s+', ' ', 'g')), coalesce(nullif(btrim(p->>'make'), ''), 'Toyota'),
          btrim(p->>'model'), nullif(btrim(p->>'variant'), ''), nullif(p->>'fuel', ''), nullif(p->>'transmission', ''),
          nullif(p->>'mfg_year', '')::int, nullif(p->>'odometer_km', '')::int, nullif(p->>'owners', '')::int,
          nullif(p->>'customer_expected', '')::numeric, nullif(btrim(p->>'remarks'), ''), current_employee_id())
  returning id into v_id;
  if v_id is not null and (select customer_name from used_car_evaluations where id = v_id) is null then
    raise exception 'Enter the customer''s name';
  end if;
  return v_id;
exception
  when not_null_violation then raise exception 'Enter the customer''s name';
  when unique_violation then raise exception 'This car already has an open evaluation';
end;
$$;

-- The evaluator inspects and values the car.
create or replace function record_evaluation(p_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e used_car_evaluations%rowtype;
begin
  select * into e from used_car_evaluations where id = p_id for update;
  if e.id is null or not ops_can('used_car_evaluations', 'edit', e.outlet_id) then raise exception 'Evaluation not found'; end if;
  if e.status not in ('requested', 'evaluated', 'negotiating') then raise exception 'This evaluation is closed'; end if;
  if coalesce((p->>'evaluator_price')::numeric, 0) <= 0 then raise exception 'Enter the valuation'; end if;
  if exists (select 1 from jsonb_array_elements_text(coalesce(p->'photo_paths', '[]')) x where x not like 'used-car/' || e.id::text || '/%') then
    raise exception 'Photos must be stored with this evaluation';
  end if;
  if coalesce(jsonb_array_length(p->'photo_paths'), cardinality(e.photo_paths)) < 4 then
    raise exception 'Add at least 4 photos (front, back, both sides)';
  end if;
  update used_car_evaluations set
    variant = coalesce(nullif(btrim(p->>'variant'), ''), variant),
    fuel = coalesce(nullif(p->>'fuel', ''), fuel),
    transmission = coalesce(nullif(p->>'transmission', ''), transmission),
    mfg_year = coalesce(nullif(p->>'mfg_year', '')::int, mfg_year),
    odometer_km = coalesce(nullif(p->>'odometer_km', '')::int, odometer_km),
    owners = coalesce(nullif(p->>'owners', '')::int, owners),
    colour = coalesce(nullif(btrim(p->>'colour'), ''), colour),
    insurance_valid_till = coalesce(nullif(p->>'insurance_valid_till', '')::date, insurance_valid_till),
    hypothecated_to = coalesce(nullif(btrim(p->>'hypothecated_to'), ''), hypothecated_to),
    accident_history = coalesce(nullif(btrim(p->>'accident_history'), ''), accident_history),
    condition = coalesce(p->'condition', condition),
    photo_paths = coalesce(array(select jsonb_array_elements_text(p->'photo_paths')), photo_paths),
    evaluator_price = (p->>'evaluator_price')::numeric,
    offer_valid_till = coalesce(nullif(p->>'offer_valid_till', '')::date, (now() at time zone 'Asia/Kolkata')::date + 7),
    remarks = coalesce(nullif(btrim(p->>'remarks'), ''), remarks),
    evaluator_id = current_employee_id(), evaluated_at = now(),
    status = case when status = 'requested' then 'evaluated' else status end
  where id = e.id;
end;
$$;

-- Offers back and forth. A dealer offer above the valuation by more than 5% needs the Outlet Head.
create or replace function log_used_car_offer(p_id uuid, p_side text, p_amount numeric, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e used_car_evaluations%rowtype;
begin
  select * into e from used_car_evaluations where id = p_id for update;
  if e.id is null or not can_see_evaluation(e) then raise exception 'Evaluation not found'; end if;
  if e.status not in ('evaluated', 'negotiating') then raise exception 'Value the car before making offers'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter the amount'; end if;
  if p_side = 'dealer' and p_amount > e.evaluator_price * 1.05 and not ops_can('used_car_evaluations', 'approve', e.outlet_id) then
    raise exception 'An offer more than 5%% above the valuation (₹%) needs the Outlet Head', to_char(round(e.evaluator_price), 'FM99,99,99,999');
  end if;
  insert into used_car_negotiations (evaluation_id, side, amount, note, by_employee_id)
  values (e.id, p_side, p_amount, nullif(btrim(p_note), ''), current_employee_id());
  update used_car_evaluations set status = 'negotiating' where id = e.id;
end;
$$;

-- The customer accepts the dealer's latest offer (or a final price agreed in the room).
create or replace function accept_used_car_offer(p_id uuid, p_final_price numeric default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e used_car_evaluations%rowtype;
  v_price numeric;
begin
  select * into e from used_car_evaluations where id = p_id for update;
  if e.id is null or not can_see_evaluation(e) then raise exception 'Evaluation not found'; end if;
  if e.status not in ('evaluated', 'negotiating') then raise exception 'This evaluation cannot be accepted now'; end if;
  v_price := coalesce(p_final_price,
                      (select n.amount from used_car_negotiations n where n.evaluation_id = e.id and n.side = 'dealer' order by n.created_at desc limit 1),
                      e.evaluator_price);
  if v_price > e.evaluator_price * 1.05 and not ops_can('used_car_evaluations', 'approve', e.outlet_id) then
    raise exception 'A price more than 5%% above the valuation needs the Outlet Head';
  end if;
  update used_car_evaluations set status = 'accepted', final_price = v_price, decided_at = now() where id = e.id;
end;
$$;

create or replace function close_evaluation(p_id uuid, p_status text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e used_car_evaluations%rowtype;
begin
  select * into e from used_car_evaluations where id = p_id for update;
  if e.id is null or not can_see_evaluation(e) then raise exception 'Evaluation not found'; end if;
  if e.status in ('procured', 'rejected', 'cancelled') then raise exception 'This evaluation is closed'; end if;
  if p_status not in ('rejected', 'cancelled') then raise exception 'Status must be rejected or cancelled'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  update used_car_evaluations set status = p_status, close_reason = btrim(p_reason), decided_at = now() where id = e.id;
end;
$$;

-- Buy the car in. Tied to a booking, its value becomes an exchange receipt on that booking.
create or replace function procure_used_car(p_id uuid, p_procured_on date default null, p_notes text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  e used_car_evaluations%rowtype;
  b bookings%rowtype;
  v_receipt uuid;
  v_id uuid;
  v_on date := coalesce(p_procured_on, (now() at time zone 'Asia/Kolkata')::date);
begin
  select * into e from used_car_evaluations where id = p_id for update;
  if e.id is null or not ops_can('used_car_stock', 'create', e.outlet_id) then raise exception 'Evaluation not found'; end if;
  if e.status <> 'accepted' then raise exception 'Only an accepted offer can be bought in'; end if;
  if v_on > (now() at time zone 'Asia/Kolkata')::date then raise exception 'The date cannot be in the future'; end if;
  if e.booking_id is not null then
    select * into b from bookings where id = e.booking_id for update;
    if b.status = 'cancelled' then raise exception 'The booking is cancelled; buy the car outside the exchange'; end if;
    insert into payment_receipts (booking_id, outlet_id, mode, amount, received_on, instrument_no, notes, clearance_status, cleared_on, recorded_by)
    values (b.id, b.outlet_id, 'exchange', e.final_price, v_on, e.reg_no, 'Exchange of ' || e.make || ' ' || e.model || ' ' || e.reg_no,
            'cleared', v_on, current_employee_id())
    returning id into v_receipt;
  end if;
  insert into used_car_vehicles (evaluation_id, outlet_id, reg_no, procurement_price, procured_on, exchange_receipt_id, notes, procured_by)
  values (e.id, e.outlet_id, e.reg_no, e.final_price, v_on, v_receipt, nullif(btrim(p_notes), ''), current_employee_id())
  returning id into v_id;
  update used_car_evaluations set status = 'procured' where id = e.id;
  return v_id;
end;
$$;

-- Refurbish, list, sell or return a used car.
create or replace function update_used_car(p_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  u used_car_vehicles%rowtype;
  v_status text := nullif(p->>'status', '');
begin
  select * into u from used_car_vehicles where id = p_id for update;
  if u.id is null or not ops_can('used_car_stock', 'edit', u.outlet_id) then raise exception 'Car not found'; end if;
  if u.status in ('sold', 'returned') then raise exception 'This car has left stock'; end if;
  if v_status = 'sold' and (coalesce((p->>'sold_price')::numeric, 0) <= 0 or nullif(btrim(p->>'buyer_name'), '') is null) then
    raise exception 'Enter the sale price and the buyer';
  end if;
  if v_status = 'listed' and coalesce((p->>'listed_price')::numeric, u.listed_price, 0) <= 0 then
    raise exception 'Enter the listed price';
  end if;
  update used_car_vehicles set
    status = coalesce(v_status, status),
    refurbishment_cost = refurbishment_cost + coalesce((p->>'add_refurbishment')::numeric, 0),
    listed_price = coalesce((p->>'listed_price')::numeric, listed_price),
    sold_price = coalesce((p->>'sold_price')::numeric, sold_price),
    sold_on = case when v_status = 'sold' then coalesce((p->>'sold_on')::date, (now() at time zone 'Asia/Kolkata')::date) else sold_on end,
    buyer_name = coalesce(nullif(btrim(p->>'buyer_name'), ''), buyer_name),
    buyer_mobile = coalesce(normalize_mobile(p->>'buyer_mobile'), buyer_mobile),
    notes = coalesce(nullif(btrim(p->>'notes'), ''), notes),
    updated_at = now()
  where id = u.id;
end;
$$;

-- ===== Lists and report =====
create or replace function used_car_evaluation_list(p_status text default null, p_outlet_id uuid default null)
returns table (id uuid, outlet text, customer_name text, customer_mobile text, reg_no text, car text, mfg_year int, odometer_km int,
               owners int, status text, customer_expected numeric, evaluator_price numeric, last_dealer_offer numeric,
               last_customer_ask numeric, final_price numeric, utrust boolean, requested_by text, evaluator text,
               requested_at timestamptz, booking_id uuid, photos int, condition jsonb, remarks text)
language sql
stable
security invoker
set search_path = public
as $$
  select e.id, o.name, e.customer_name, e.customer_mobile, e.reg_no, concat_ws(' ', e.make, e.model, e.variant), e.mfg_year, e.odometer_km,
         e.owners, e.status, e.customer_expected, e.evaluator_price,
         (select n.amount from used_car_negotiations n where n.evaluation_id = e.id and n.side = 'dealer' order by n.created_at desc limit 1),
         (select n.amount from used_car_negotiations n where n.evaluation_id = e.id and n.side = 'customer' order by n.created_at desc limit 1),
         e.final_price, utrust_eligible(e), rq.name, ev.name, e.requested_at, e.booking_id, cardinality(e.photo_paths), e.condition, e.remarks
  from used_car_evaluations e
  join outlets o on o.id = e.outlet_id
  left join employees rq on rq.id = e.requested_by
  left join employees ev on ev.id = e.evaluator_id
  where (p_status is null or e.status = p_status or (p_status = 'open' and e.status in ('requested', 'evaluated', 'negotiating', 'accepted')))
    and (p_outlet_id is null or e.outlet_id = p_outlet_id)
  order by e.status = 'requested' desc, e.requested_at desc;
$$;

create or replace function used_car_stock_list(p_status text default null)
returns table (id uuid, outlet text, reg_no text, car text, mfg_year int, odometer_km int, status text, procurement_price numeric,
               refurbishment_cost numeric, listed_price numeric, sold_price numeric, margin numeric, procured_on date, sold_on date,
               days_in_stock int, buyer_name text, utrust boolean, from_customer text)
language sql
stable
security invoker
set search_path = public
as $$
  select u.id, o.name, u.reg_no, concat_ws(' ', e.make, e.model, e.variant), e.mfg_year, e.odometer_km, u.status, u.procurement_price,
         u.refurbishment_cost, u.listed_price, u.sold_price,
         case when u.sold_price is not null then u.sold_price - u.procurement_price - u.refurbishment_cost end,
         u.procured_on, u.sold_on, (coalesce(u.sold_on, current_date) - u.procured_on)::int, u.buyer_name, utrust_eligible(e), e.customer_name
  from used_car_vehicles u
  join used_car_evaluations e on e.id = u.evaluation_id
  join outlets o on o.id = u.outlet_id
  where p_status is null or u.status = p_status or (p_status = 'in_stock_all' and u.status in ('in_stock', 'refurbishing', 'listed'))
  order by u.status = 'sold', u.procured_on;
$$;

create or replace function used_car_negotiation_log(p_id uuid)
returns table (created_at timestamptz, side text, amount numeric, note text, by_name text)
language sql
stable
security invoker
set search_path = public
as $$
  select n.created_at, n.side, n.amount, n.note, e.name
  from used_car_negotiations n left join employees e on e.id = n.by_employee_id
  where n.evaluation_id = p_id
  order by n.created_at;
$$;

create or replace function used_car_summary(p_from date, p_to date)
returns table (outlet text, requested int, evaluated int, procured int, conversion_pct numeric, avg_gap_pct numeric,
               sold int, sales_value numeric, margin numeric, in_stock int, stock_value numeric)
language sql
stable
security definer
set search_path = public
as $$
  select o.name,
         count(e.*) filter (where (e.requested_at at time zone 'Asia/Kolkata')::date between p_from and p_to)::int,
         count(e.*) filter (where (e.evaluated_at at time zone 'Asia/Kolkata')::date between p_from and p_to)::int,
         (select count(*)::int from used_car_vehicles u where u.outlet_id = o.id and u.procured_on between p_from and p_to),
         round(100.0 * (select count(*) from used_car_vehicles u where u.outlet_id = o.id and u.procured_on between p_from and p_to)
               / nullif(count(e.*) filter (where (e.evaluated_at at time zone 'Asia/Kolkata')::date between p_from and p_to), 0), 1),
         round(avg(100.0 * (e.customer_expected - e.evaluator_price) / nullif(e.evaluator_price, 0))
               filter (where e.customer_expected is not null and (e.evaluated_at at time zone 'Asia/Kolkata')::date between p_from and p_to), 1),
         (select count(*)::int from used_car_vehicles u where u.outlet_id = o.id and u.sold_on between p_from and p_to),
         (select sum(u.sold_price) from used_car_vehicles u where u.outlet_id = o.id and u.sold_on between p_from and p_to),
         (select sum(u.sold_price - u.procurement_price - u.refurbishment_cost) from used_car_vehicles u where u.outlet_id = o.id and u.sold_on between p_from and p_to),
         (select count(*)::int from used_car_vehicles u where u.outlet_id = o.id and u.status in ('in_stock', 'refurbishing', 'listed')),
         (select sum(u.procurement_price + u.refurbishment_cost) from used_car_vehicles u where u.outlet_id = o.id and u.status in ('in_stock', 'refurbishing', 'listed'))
  from outlets o
  left join used_car_evaluations e on e.outlet_id = o.id
  where o.is_active and has_right('rpt_used_cars', 'view') and ops_branch_ok(o.id)
  group by o.id, o.name
  order by o.name;
$$;

-- ===== Grants =====
do $$
declare
  f text;
begin
  foreach f in array array[
    'request_evaluation(jsonb)', 'record_evaluation(uuid, jsonb)', 'log_used_car_offer(uuid, text, numeric, text)',
    'accept_used_car_offer(uuid, numeric)', 'close_evaluation(uuid, text, text)', 'procure_used_car(uuid, date, text)',
    'update_used_car(uuid, jsonb)', 'used_car_evaluation_list(text, uuid)', 'used_car_stock_list(text)',
    'used_car_negotiation_log(uuid)', 'used_car_summary(date, date)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke execute on function can_see_evaluation(used_car_evaluations) from public, anon;
grant execute on function can_see_evaluation(used_car_evaluations) to authenticated;
revoke execute on function utrust_eligible(used_car_evaluations) from public, anon;
grant execute on function utrust_eligible(used_car_evaluations) to authenticated;

-- ===== Photos: bucket used-car-photos, path used-car/<evaluation id>/<file> =====
insert into storage.buckets (id, name, public) values ('used-car-photos', 'used-car-photos', false) on conflict (id) do nothing;

create or replace function storage_evaluation_visible(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from used_car_evaluations e
    where (storage.foldername(p_name))[1] = 'used-car'
      and e.id::text = (storage.foldername(p_name))[2]
      and can_see_evaluation(e));
$$;
revoke execute on function storage_evaluation_visible(text) from public, anon;
grant execute on function storage_evaluation_visible(text) to authenticated;

create policy used_car_photos_select on storage.objects for select to authenticated using (
  bucket_id = 'used-car-photos' and storage_evaluation_visible(name));
create policy used_car_photos_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'used-car-photos' and storage_evaluation_visible(name));
