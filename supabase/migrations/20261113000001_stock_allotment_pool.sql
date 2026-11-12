-- Stock Allotment Pool: cars are allotted automatically, the way the Techwheels pool works.
--   - One pool per variant + colour, shared by every branch.
--   - Pool size = base + increment x (free cars - 1), and 0 when no car is free (2 and 1 to start).
--   - Who is in the pool is FIFO: the earliest-booked eligible bookings, by CTDMS order date (else
--     the booking date). An earlier booking pushes out the latest member who hasn't completed yet.
--     Members who have completed, and members fast-tracked by a manager, are never pushed out.
--   - Inside the pool, whoever completes first wins:
--       - financed (a live finance case): the case reaches "DO received";
--       - cash (no live finance case): cleared receipts reach 70% of the deal amount.
--   - The oldest free car (yard before transit, then most days since TKM invoice, then VIN) goes to
--     the first winner, then the next car to the next winner, until cars or winners run out.
--   - The pool rechecks itself when bookings, finance cases, payments, holds, approvals or stock
--     change, once per variant + colour, when the change is committed:
--       - a winner who stops qualifying (hold, cancellation, DO rejected, bounced cheque) loses the car;
--       - so does a winner whose car leaves the yard report or is invoiced in CTDMS for another order;
--       - nothing is taken back once the car has been sent for billing.
--   - A car CTDMS has blocked for an order stays out of the pool; it goes through the CTDMS
--     proposals on Match & Allot as before.
--   - Every move is written to pool_audit_log.
-- The pool starts switched off (pool_config.enabled). Until it is switched on, allotment works
-- exactly as in 20261029000001.

-- ===== Allotments: a 'pool' method and how the pool winner qualified =====
alter table allotments drop constraint allotments_method_check;
alter table allotments add constraint allotments_method_check check (method in ('fifo', 'manual', 'ctdms', 'pool'));
alter table allotments add column win_path text check (win_path in ('do', 'cash', 'manual'));

-- ===== Tables =====
create table pool_config (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  base_pool_size int not null default 2 check (base_pool_size between 1 and 50),
  increment_per_vehicle int not null default 1 check (increment_per_vehicle between 0 and 20),
  cash_payment_percentage numeric not null default 70 check (cash_payment_percentage > 0 and cash_payment_percentage <= 100),
  updated_by uuid references employees(id),
  updated_at timestamptz not null default now()
);
insert into pool_config (id) values (true);

-- One row per booking that has ever been in a pool; status says where it is now.
create table pool_members (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings(id),
  variant_id uuid not null references variants(id),
  color_id uuid not null references colors(id),
  booking_date date not null,
  status text not null default 'active' check (status in ('active', 'allotted', 'removed')),
  joined_at timestamptz not null default now(),
  completed_at timestamptz,
  win_path text check (win_path in ('do', 'cash', 'manual')),
  fast_tracked boolean not null default false,
  fast_track_reason text,
  removed_reason text,
  updated_at timestamptz not null default now()
);
create index idx_pool_members_key on pool_members(variant_id, color_id, status);
create trigger trg_pool_members_updated_at before update on pool_members for each row execute function set_updated_at();

create table pool_audit_log (
  id uuid primary key default gen_random_uuid(),
  event text not null check (event in (
    'pool_join', 'pool_bump', 'removed_ineligible', 'completion_banked', 'completion_unbanked', 'allotted',
    'released', 'fast_track', 'hold', 'change_vehicle', 'config_change', 'engine_error')),
  booking_id uuid references bookings(id),
  vehicle_id uuid references vehicles(id),
  variant_id uuid references variants(id),
  color_id uuid references colors(id),
  details jsonb not null default '{}'::jsonb,
  by_employee_id uuid references employees(id) default current_employee_id(),
  -- clock time, so events within one transaction keep their order
  created_at timestamptz not null default clock_timestamp()
);
create index idx_pool_audit_log_booking on pool_audit_log(booking_id, created_at);
create index idx_pool_audit_log_vehicle on pool_audit_log(vehicle_id, created_at);
create index idx_pool_audit_log_key on pool_audit_log(variant_id, color_id, created_at);

-- Variant + colour keys changed in the current transaction, rechecked when it commits.
create table pool_dirty_keys (
  txid bigint not null default txid_current(),
  variant_id uuid not null,
  color_id uuid not null,
  primary key (txid, variant_id, color_id)
);

-- ===== Read access (all writes go through the functions below) =====
alter table pool_config enable row level security;
alter table pool_members enable row level security;
alter table pool_audit_log enable row level security;
alter table pool_dirty_keys enable row level security;
create policy pool_config_select on pool_config for select to authenticated using (true);
create policy pool_members_select on pool_members for select to authenticated using (
  coalesce(current_employee_role_rank() <= 3, false) or can_access_booking(booking_id)
);
create policy pool_audit_log_select on pool_audit_log for select to authenticated using (
  coalesce(current_employee_role_rank() <= 3, false)
);
revoke all on pool_dirty_keys from public, anon, authenticated;

-- ===== Allot core (shared by allot_vehicle and the pool) =====
-- No role or eligibility checks: callers do those.
create or replace function allot_vehicle_core(p_booking_id uuid, p_vehicle_id uuid, p_method text, p_reason text,
                                              p_by uuid, p_win_path text default null)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  b bookings%rowtype;
  v vehicles%rowtype;
  v_id uuid;
begin
  select * into b from bookings where id = p_booking_id for update;
  select * into v from vehicles where id = p_vehicle_id for update;
  insert into allotments (booking_id, vehicle_id, method, override_reason, allotted_by, win_path)
  values (b.id, v.id, p_method, nullif(btrim(p_reason), ''), p_by, p_win_path)
  returning id into v_id;
  update vehicles set status = 'allotted' where id = v.id;
  update bookings set status = 'allocated' where id = b.id;
  -- A car CTDMS already has blocked for this order needs nothing done there.
  if not (p_method = 'ctdms' or (v.ctdms_block_status in ('Blocked', 'Alloted') and v.ctdms_order_no = b.ctdms_order_booking_no)) then
    insert into ctdms_block_tasks (allotment_id, vehicle_id, booking_id, action) values (v_id, v.id, b.id, 'block');
  end if;
  return v_id;
end;
$$;
revoke execute on function allot_vehicle_core(uuid, uuid, text, text, uuid, text) from public, anon, authenticated;

-- As in 20261029000001, on top of allot_vehicle_core.
create or replace function allot_vehicle(p_booking_id uuid, p_vehicle_id uuid, p_method text default 'manual', p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v vehicles%rowtype;
begin
  select * into b from bookings where id = p_booking_id for update;
  select * into v from vehicles where id = p_vehicle_id for update;
  if b.id is null or v.id is null then
    raise exception 'Booking or vehicle not found';
  end if;
  if not can_manage_stock(array[b.outlet_id, v.outlet_id]) then
    raise exception 'Only an Outlet Head or above can allot cars';
  end if;
  if p_method not in ('fifo', 'manual', 'ctdms') then
    raise exception 'Unknown allotment method %', p_method;
  end if;
  if not booking_allotable(b.id) then
    raise exception 'This booking cannot take a car (already allotted, not booked, closed in CTDMS or awaiting approval)';
  end if;
  if not vehicle_allotable(v) then
    raise exception 'This car is not available (allotted, billed, missing from the latest report or invoiced in CTDMS)';
  end if;
  if (v.variant_id is distinct from b.variant_id or v.color_id is distinct from b.color_id) then
    if p_method = 'fifo' or nullif(btrim(p_reason), '') is null then
      raise exception 'This car does not match the booking''s variant and colour; give a reason to allot it anyway';
    end if;
  end if;
  return allot_vehicle_core(b.id, v.id, p_method, p_reason, current_employee_id(), case when p_method = 'manual' then 'manual' end);
end;
$$;

-- CTDMS order numbers repeat per dealer code: match the order within the car's own branch.
create or replace function propose_ctdms_allotments(p_outlet_id uuid default null)
returns table (booking_id uuid, vehicle_id uuid, ctdms_order_no text, customer_name text, vin text, matches_booking boolean)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, v.id, v.ctdms_order_no, b.customer_name, v.vin,
         (v.variant_id = b.variant_id and v.color_id = b.color_id)
  from vehicles v
  join bookings b on b.ctdms_order_booking_no = v.ctdms_order_no and b.outlet_id = v.outlet_id
  where vehicle_allotable(v) and v.ctdms_block_status in ('Blocked', 'Alloted')
    and booking_allotable(b.id) and (p_outlet_id is null or v.outlet_id = p_outlet_id)
    and coalesce(current_employee_role_rank() <= 3, false);
$$;

-- ===== Pool rules =====
-- A free car for the pool: allotable, and not blocked in CTDMS for some order.
create or replace function pool_vehicle_free(v vehicles)
returns boolean
language sql
stable
set search_path = public
as $$
  select v.variant_id is not null and v.color_id is not null and vehicle_allotable(v)
    and coalesce(v.ctdms_block_status, '') not in ('Blocked', 'Alloted');
$$;

create or replace function pool_free_count(p_variant_id uuid, p_color_id uuid)
returns int
language sql
stable
set search_path = public
as $$
  select count(*)::int from vehicles v
  where v.variant_id = p_variant_id and v.color_id = p_color_id and pool_vehicle_free(v);
$$;

create or replace function pool_target_size(p_free int)
returns int
language sql
stable
set search_path = public
as $$
  select case when coalesce(p_free, 0) <= 0 then 0
              else c.base_pool_size + c.increment_per_vehicle * (p_free - 1) end
  from pool_config c;
$$;

-- When (and how) a booking completed: the DO for a financed booking, the cleared receipt that took
-- a cash booking to the configured share of the deal amount. Null while it hasn't.
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
  select * into c from finance_cases where booking_id = p_booking_id and status <> 'rejected';
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

create or replace function pool_log(p_event text, p_booking_id uuid, p_vehicle_id uuid, p_variant_id uuid, p_color_id uuid,
                                    p_details jsonb default '{}'::jsonb)
returns void
language sql
set search_path = public
as $$
  insert into pool_audit_log (event, booking_id, vehicle_id, variant_id, color_id, details)
  values (p_event, p_booking_id, p_vehicle_id, p_variant_id, p_color_id, coalesce(p_details, '{}'::jsonb));
$$;

-- ===== The engine =====
-- Brings one variant + colour pool up to date and allots every car it can. Safe to run any time.
create or replace function pool_recompute(p_variant_id uuid, p_color_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  cfg pool_config%rowtype;
  m pool_members%rowtype;
  a allotments%rowtype;
  v vehicles%rowtype;
  b bookings%rowtype;
  c record;
  v_reason text;
  v_free int;
  v_target int;
  v_protected int;
  v_slots int;
  v_wanted uuid[];
  v_winner pool_members%rowtype;
  v_vehicle uuid;
  v_allotment uuid;
  v_joined int := 0;
  v_bumped int := 0;
  v_removed int := 0;
  v_released int := 0;
  v_allotted int := 0;
  v_guard int := 0;
begin
  select * into cfg from pool_config;
  if p_variant_id is null or p_color_id is null or not cfg.enabled then
    return jsonb_build_object('skipped', true);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pool:' || p_variant_id::text || ':' || p_color_id::text, 0));
  -- Our own changes below must not queue this key again.
  perform set_config('pool.busy', 'on', true);

  -- 1. Winners holding a car: still entitled to it?
  for m in select * from pool_members where variant_id = p_variant_id and color_id = p_color_id and status = 'allotted' for update loop
    a := null;
    select * into a from allotments where booking_id = m.booking_id and released_at is null;
    if a.id is null or a.method <> 'pool' then
      -- Released elsewhere (hold, cancellation, a manager) or allotted outside the pool.
      if a.id is null and booking_allotable(m.booking_id) then
        update pool_members set status = 'active', fast_tracked = false, removed_reason = null where id = m.id;
      else
        update pool_members set status = 'removed', completed_at = null, win_path = null,
          removed_reason = case when a.id is null then 'Car released and booking no longer eligible' else 'Allotted outside the pool' end
        where id = m.id;
        v_removed := v_removed + 1;
      end if;
      continue;
    end if;
    -- Once the car has gone for billing it stays.
    continue when exists (select 1 from billing_requests where allotment_id = a.id and status in ('pending', 'invoiced'));

    select * into v from vehicles where id = a.vehicle_id;
    select * into b from bookings where id = m.booking_id;
    c := pool_booking_completion(b.id);
    v_reason := case
      when v.missing_from_report and v.source = 'physical' then 'Car left the physical stock report'
      when v.ctdms_order_status = 'Invoiced' and v.ctdms_order_no is distinct from b.ctdms_order_booking_no
        then 'Car invoiced in CTDMS for another order'
      when booking_on_hold(b.id) or b.status <> 'allocated' or coalesce(b.ctdms_order_status, '') = 'Closed in CTDMS'
        then 'Booking no longer eligible'
      when c.completed_at is null then
        case m.win_path when 'do' then 'DO no longer in place' else 'Cleared payment fell below ' || cfg.cash_payment_percentage || '%' end
    end;
    continue when v_reason is null;

    perform release_allotment_core(a.id, 'Pool: ' || v_reason);
    v_released := v_released + 1;
    perform pool_log('released', b.id, v.id, p_variant_id, p_color_id, jsonb_build_object('reason', v_reason));
    if booking_allotable(b.id) then
      update pool_members set status = 'active', completed_at = c.completed_at, win_path = c.win_path where id = m.id;
      if c.completed_at is null then
        perform pool_log('completion_unbanked', b.id, null, p_variant_id, p_color_id, jsonb_build_object('was', m.win_path));
      end if;
    else
      update pool_members set status = 'removed', completed_at = null, win_path = null, removed_reason = v_reason where id = m.id;
      v_removed := v_removed + 1;
    end if;
  end loop;

  -- 2. Members who can no longer take a car leave the pool.
  for m in
    select pm.* from pool_members pm join bookings bk on bk.id = pm.booking_id
    where pm.variant_id = p_variant_id and pm.color_id = p_color_id and pm.status = 'active'
      and (not booking_allotable(pm.booking_id) or bk.variant_id is distinct from pm.variant_id or bk.color_id is distinct from pm.color_id)
    for update of pm
  loop
    update pool_members set status = 'removed', completed_at = null, win_path = null, fast_tracked = false,
      removed_reason = 'No longer eligible' where id = m.id;
    perform pool_log('removed_ineligible', m.booking_id, null, p_variant_id, p_color_id);
    v_removed := v_removed + 1;
  end loop;

  -- 3. Bank (or unbank) completions.
  for m in select * from pool_members where variant_id = p_variant_id and color_id = p_color_id and status = 'active' for update loop
    c := pool_booking_completion(m.booking_id);
    if c.completed_at is distinct from m.completed_at or c.win_path is distinct from m.win_path then
      update pool_members set completed_at = c.completed_at, win_path = c.win_path where id = m.id;
      perform pool_log(case when c.completed_at is null then 'completion_unbanked' else 'completion_banked' end,
                       m.booking_id, null, p_variant_id, p_color_id,
                       jsonb_build_object('win_path', coalesce(c.win_path, m.win_path), 'completed_at', c.completed_at));
    end if;
  end loop;

  loop
    v_guard := v_guard + 1;
    exit when v_guard > 1000;

    -- 4 + 5. FIFO membership: keep members who completed or were fast-tracked; fill the other
    -- places with the earliest-booked eligible bookings, pushing out later members.
    v_free := pool_free_count(p_variant_id, p_color_id);
    v_target := pool_target_size(v_free);
    select count(*) into v_protected from pool_members
    where variant_id = p_variant_id and color_id = p_color_id and status = 'active' and (completed_at is not null or fast_tracked);
    v_slots := greatest(v_target - v_protected, 0);

    select coalesce(array_agg(x.id), '{}') into v_wanted from (
      select bk.id from bookings bk
      where bk.variant_id = p_variant_id and bk.color_id = p_color_id and booking_allotable(bk.id)
        and not exists (select 1 from pool_members pm where pm.booking_id = bk.id and pm.status = 'active'
                        and (pm.completed_at is not null or pm.fast_tracked))
      order by booking_order_date(bk), bk.created_at, bk.id
      limit v_slots
    ) x;

    for m in
      select * from pool_members
      where variant_id = p_variant_id and color_id = p_color_id and status = 'active'
        and completed_at is null and not fast_tracked and booking_id <> all(v_wanted)
      for update
    loop
      update pool_members set status = 'removed', removed_reason = 'Pushed out by an earlier booking or fewer free cars' where id = m.id;
      perform pool_log('pool_bump', m.booking_id, null, p_variant_id, p_color_id,
                       jsonb_build_object('free_cars', v_free, 'pool_size', v_target));
      v_bumped := v_bumped + 1;
    end loop;

    for b in
      select bk.* from bookings bk
      where bk.id = any(v_wanted)
        and not exists (select 1 from pool_members pm where pm.booking_id = bk.id and pm.status = 'active')
    loop
      c := pool_booking_completion(b.id);
      insert into pool_members (booking_id, variant_id, color_id, booking_date, status, completed_at, win_path)
      values (b.id, p_variant_id, p_color_id, booking_order_date(b), 'active', c.completed_at, c.win_path)
      on conflict (booking_id) do update set variant_id = excluded.variant_id, color_id = excluded.color_id,
        booking_date = excluded.booking_date, status = 'active', joined_at = now(), completed_at = excluded.completed_at,
        win_path = excluded.win_path, fast_tracked = false, fast_track_reason = null, removed_reason = null;
      perform pool_log('pool_join', b.id, null, p_variant_id, p_color_id,
                       jsonb_build_object('booking_date', booking_order_date(b), 'completed', c.completed_at is not null));
      v_joined := v_joined + 1;
    end loop;

    -- 6. The first winner takes the oldest free car.
    select pm.* into v_winner from pool_members pm join bookings bk on bk.id = pm.booking_id
    where pm.variant_id = p_variant_id and pm.color_id = p_color_id and pm.status = 'active' and pm.completed_at is not null
    order by pm.completed_at, pm.booking_date, bk.created_at, pm.id
    limit 1
    for update of pm skip locked;
    exit when v_winner.id is null;

    select v2.id into v_vehicle from vehicles v2
    where v2.variant_id = p_variant_id and v2.color_id = p_color_id and pool_vehicle_free(v2)
    order by (v2.source = 'physical') desc, v2.days_since_invoice desc nulls last, v2.vin
    limit 1
    for update skip locked;
    exit when v_vehicle is null;

    v_allotment := allot_vehicle_core(v_winner.booking_id, v_vehicle, 'pool', null, null, v_winner.win_path);
    update pool_members set status = 'allotted' where id = v_winner.id;
    perform pool_log('allotted', v_winner.booking_id, v_vehicle, p_variant_id, p_color_id,
                     jsonb_build_object('win_path', v_winner.win_path, 'completed_at', v_winner.completed_at,
                                        'allotment_id', v_allotment));
    v_allotted := v_allotted + 1;
    v_winner := null;
    v_vehicle := null;
  end loop;

  perform set_config('pool.busy', 'off', true);
  return jsonb_build_object('joined', v_joined, 'bumped', v_bumped, 'removed', v_removed, 'released', v_released,
                            'allotted', v_allotted, 'free_cars', pool_free_count(p_variant_id, p_color_id));
end;
$$;
revoke execute on function pool_recompute(uuid, uuid) from public, anon, authenticated;

-- Every variant + colour that has free cars, eligible bookings or pool members.
create or replace function pool_recompute_all_core()
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  k record;
  r jsonb;
  v_keys int := 0;
  v_allotted int := 0;
begin
  for k in
    select variant_id, color_id from vehicles where status = 'available' and variant_id is not null and color_id is not null
    union
    select variant_id, color_id from bookings where status in ('booked', 'allocated') and variant_id is not null and color_id is not null
    union
    select variant_id, color_id from pool_members where status <> 'removed'
  loop
    r := pool_recompute(k.variant_id, k.color_id);
    v_keys := v_keys + 1;
    v_allotted := v_allotted + coalesce((r->>'allotted')::int, 0);
  end loop;
  return jsonb_build_object('pools', v_keys, 'allotted', v_allotted);
end;
$$;
revoke execute on function pool_recompute_all_core() from public, anon, authenticated;

-- ===== Rechecking on change =====
create or replace function pool_mark_dirty(p_variant_id uuid, p_color_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_variant_id is null or p_color_id is null or current_setting('pool.busy', true) = 'on'
     or not coalesce((select enabled from pool_config), false) then
    return;
  end if;
  insert into pool_dirty_keys (variant_id, color_id) values (p_variant_id, p_color_id) on conflict do nothing;
end;
$$;
revoke execute on function pool_mark_dirty(uuid, uuid) from public, anon, authenticated;

create or replace function pool_mark_booking_dirty(p_booking_id uuid)
returns void
language sql
set search_path = public
as $$
  select pool_mark_dirty(b.variant_id, b.color_id) from bookings b where b.id = p_booking_id;
$$;
revoke execute on function pool_mark_booking_dirty(uuid) from public, anon, authenticated;

-- Runs when the transaction commits (or at the end of the statement under SET CONSTRAINTS ALL
-- IMMEDIATE). A key that fails is logged and left as it was; the change that queued it still commits.
create or replace function pool_drain_dirty_keys()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  k record;
begin
  for k in delete from pool_dirty_keys where txid = txid_current() returning variant_id, color_id loop
    begin
      perform pool_recompute(k.variant_id, k.color_id);
    exception when others then
      perform set_config('pool.busy', 'off', true);
      perform pool_log('engine_error', null, null, k.variant_id, k.color_id, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
  return null;
end;
$$;
create constraint trigger trg_pool_dirty_keys_drain after insert on pool_dirty_keys
  deferrable initially deferred for each row execute function pool_drain_dirty_keys();

create or replace function pool_trg_bookings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pool_mark_dirty(NEW.variant_id, NEW.color_id);
  if TG_OP = 'UPDATE' and (OLD.variant_id is distinct from NEW.variant_id or OLD.color_id is distinct from NEW.color_id) then
    perform pool_mark_dirty(OLD.variant_id, OLD.color_id);
  end if;
  return null;
end;
$$;
create trigger trg_pool_bookings after insert or update of status, variant_id, color_id, ctdms_order_status, ctdms_order_date, total_amount
  on bookings for each row execute function pool_trg_bookings();

create or replace function pool_trg_vehicles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pool_mark_dirty(NEW.variant_id, NEW.color_id);
  if TG_OP = 'UPDATE' and (OLD.variant_id is distinct from NEW.variant_id or OLD.color_id is distinct from NEW.color_id) then
    perform pool_mark_dirty(OLD.variant_id, OLD.color_id);
  end if;
  return null;
end;
$$;
create trigger trg_pool_vehicles after insert or update of status, source, missing_from_report, ctdms_order_status,
  ctdms_order_no, ctdms_block_status, days_since_invoice, variant_id, color_id
  on vehicles for each row execute function pool_trg_vehicles();

-- Finance cases, receipts, holds, approvals and docket accessories all point at a booking.
create or replace function pool_trg_booking_child()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pool_mark_booking_dirty(NEW.booking_id);
  return null;
end;
$$;
create trigger trg_pool_finance_cases after insert or update of status on finance_cases
  for each row execute function pool_trg_booking_child();
create trigger trg_pool_payment_receipts after insert or update of clearance_status, amount on payment_receipts
  for each row execute function pool_trg_booking_child();
create trigger trg_pool_booking_holds after insert or update of resumed_at on booking_holds
  for each row execute function pool_trg_booking_child();
create trigger trg_pool_approvals after insert or update of status on approvals
  for each row when (NEW.booking_id is not null) execute function pool_trg_booking_child();
create trigger trg_pool_welcome_dockets after insert or update of accessories_total on welcome_dockets
  for each row execute function pool_trg_booking_child();

revoke execute on function pool_drain_dirty_keys() from public, anon, authenticated;
revoke execute on function pool_trg_bookings() from public, anon, authenticated;
revoke execute on function pool_trg_vehicles() from public, anon, authenticated;
revoke execute on function pool_trg_booking_child() from public, anon, authenticated;

-- ===== Who sees what =====
-- Back office sees every booking; others see the bookings they work: their consultant line, their
-- branch's back office, or their branch's finance desk.
create or replace function pool_can_see_booking(b bookings)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_employee_role_rank() <= 3, false) or can_work_finance(b.outlet_id) or can_handle_booking(b);
$$;
revoke execute on function pool_can_see_booking(bookings) from public, anon, authenticated;

-- ===== Actions =====
create or replace function pool_recompute_all()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(current_employee_role_rank() <= 1, false) then
    raise exception 'Only a Business Head or Admin can recheck every pool';
  end if;
  if not (select enabled from pool_config) then
    raise exception 'The stock allotment pool is switched off';
  end if;
  return pool_recompute_all_core();
end;
$$;

create or replace function pool_config_update(p_enabled boolean, p_base_pool_size int, p_increment_per_vehicle int,
                                              p_cash_payment_percentage numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o pool_config%rowtype;
  n pool_config%rowtype;
begin
  if not coalesce(current_employee_role_rank() <= 1, false) then
    raise exception 'Only a Business Head or Admin can change the pool settings';
  end if;
  select * into o from pool_config for update;
  update pool_config set enabled = coalesce(p_enabled, enabled), base_pool_size = coalesce(p_base_pool_size, base_pool_size),
    increment_per_vehicle = coalesce(p_increment_per_vehicle, increment_per_vehicle),
    cash_payment_percentage = coalesce(p_cash_payment_percentage, cash_payment_percentage),
    updated_by = current_employee_id(), updated_at = now()
  returning * into n;
  perform pool_log('config_change', null, null, null, null, jsonb_build_object(
    'before', jsonb_build_object('enabled', o.enabled, 'base_pool_size', o.base_pool_size,
                                 'increment_per_vehicle', o.increment_per_vehicle, 'cash_payment_percentage', o.cash_payment_percentage),
    'after', jsonb_build_object('enabled', n.enabled, 'base_pool_size', n.base_pool_size,
                                'increment_per_vehicle', n.increment_per_vehicle, 'cash_payment_percentage', n.cash_payment_percentage)));
  if n.enabled then
    return pool_recompute_all_core();
  end if;
  return jsonb_build_object('pools', 0, 'allotted', 0);
end;
$$;

-- A manager puts a booking into its pool ahead of the queue. It then can't be pushed out.
create or replace function pool_fast_track(p_booking_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  c record;
begin
  select * into b from bookings where id = p_booking_id for update;
  if b.id is null then
    raise exception 'Booking not found';
  end if;
  if not can_manage_stock(array[b.outlet_id]) then
    raise exception 'Only an Outlet Head or above can fast-track a booking';
  end if;
  if not (select enabled from pool_config) then
    raise exception 'The stock allotment pool is switched off';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give the reason for fast-tracking';
  end if;
  if not booking_allotable(b.id) then
    raise exception 'This booking cannot take a car (already allotted, not booked, on hold, closed in CTDMS or awaiting approval)';
  end if;
  if exists (select 1 from pool_members where booking_id = b.id and status = 'active' and fast_tracked) then
    raise exception 'This booking is already fast-tracked';
  end if;
  if pool_free_count(b.variant_id, b.color_id) = 0 then
    raise exception 'No car of this variant and colour is free';
  end if;

  c := pool_booking_completion(b.id);
  insert into pool_members (booking_id, variant_id, color_id, booking_date, status, completed_at, win_path, fast_tracked, fast_track_reason)
  values (b.id, b.variant_id, b.color_id, booking_order_date(b), 'active', c.completed_at, c.win_path, true, btrim(p_reason))
  on conflict (booking_id) do update set variant_id = excluded.variant_id, color_id = excluded.color_id,
    booking_date = excluded.booking_date, status = 'active',
    joined_at = case when pool_members.status = 'active' then pool_members.joined_at else now() end,
    completed_at = excluded.completed_at, win_path = excluded.win_path, fast_tracked = true,
    fast_track_reason = excluded.fast_track_reason, removed_reason = null;
  perform pool_log('fast_track', b.id, null, b.variant_id, b.color_id, jsonb_build_object('reason', btrim(p_reason)));
  return pool_recompute(b.variant_id, b.color_id);
end;
$$;

-- Hold from the pool screens: the usual hold (the car is released and the booking leaves the pool
-- until it is resumed, keeping its booking date).
create or replace function pool_member_hold(p_booking_id uuid, p_reason text, p_expected_resume date default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  b bookings%rowtype;
begin
  -- Recheck the pool once the hold is in place, not halfway through it.
  perform set_config('pool.busy', 'on', true);
  v_id := hold_booking(p_booking_id, p_reason, p_expected_resume);
  perform set_config('pool.busy', 'off', true);
  select * into b from bookings where id = p_booking_id;
  perform pool_mark_dirty(b.variant_id, b.color_id);
  perform pool_log('hold', b.id, null, b.variant_id, b.color_id, jsonb_build_object('reason', btrim(p_reason)));
  return v_id;
end;
$$;

-- Gives a booking a different car of the same variant and colour. If that car is another
-- customer's, they need a car in return: the booking's current car (a straight swap) or another
-- free one. Without p_replacement_vehicle_id it says so and changes nothing.
create or replace function pool_change_vehicle(p_booking_id uuid, p_new_vehicle_id uuid, p_reason text,
                                               p_replacement_vehicle_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v vehicles%rowtype;
  a allotments%rowtype;
  oa allotments%rowtype;
  ob bookings%rowtype;
  rv vehicles%rowtype;
begin
  select * into b from bookings where id = p_booking_id for update;
  select * into v from vehicles where id = p_new_vehicle_id for update;
  if b.id is null or v.id is null then
    raise exception 'Booking or vehicle not found';
  end if;
  select * into a from allotments where booking_id = b.id and released_at is null for update;
  if a.id is null then
    raise exception 'This booking has no car to change';
  end if;
  if a.vehicle_id = v.id then
    raise exception 'This booking already has that car';
  end if;
  if not can_manage_stock(array[b.outlet_id, v.outlet_id]) then
    raise exception 'Only an Outlet Head or above can change the car';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give the reason for changing the car';
  end if;
  if v.variant_id is distinct from b.variant_id or v.color_id is distinct from b.color_id then
    raise exception 'The new car must be the booking''s variant and colour; use Match & Allot for anything else';
  end if;
  if exists (select 1 from billing_requests where allotment_id = a.id and status in ('pending', 'invoiced')) then
    raise exception 'This car has been sent for billing; pull the billing request back first';
  end if;

  select * into oa from allotments where vehicle_id = v.id and released_at is null for update;
  if oa.id is null then
    if not vehicle_allotable(v) then
      raise exception 'That car is not available (billed, missing from the latest report or invoiced in CTDMS)';
    end if;
    -- Recheck the pool once both moves are done, not between them.
    perform set_config('pool.busy', 'on', true);
    perform release_allotment_core(a.id, 'Changed car: ' || btrim(p_reason));
    perform allot_vehicle_core(b.id, v.id, a.method, a.override_reason, current_employee_id(), a.win_path);
    perform set_config('pool.busy', 'off', true);
    perform pool_mark_dirty(b.variant_id, b.color_id);
    perform pool_log('change_vehicle', b.id, v.id, b.variant_id, b.color_id,
                     jsonb_build_object('from_vehicle', a.vehicle_id, 'reason', btrim(p_reason)));
    return jsonb_build_object('status', 'changed');
  end if;

  -- The car is another customer's.
  select * into ob from bookings where id = oa.booking_id for update;
  if exists (select 1 from billing_requests where allotment_id = oa.id and status in ('pending', 'invoiced')) then
    raise exception 'That car has been sent for billing for %', ob.customer_name;
  end if;
  if p_replacement_vehicle_id is null then
    return jsonb_build_object('status', 'needs_replacement', 'other_booking_id', ob.id, 'other_customer', ob.customer_name,
                              'current_vehicle_id', a.vehicle_id);
  end if;
  if not can_manage_stock(array[ob.outlet_id]) then
    raise exception 'Only an Outlet Head of that customer''s branch or above can take their car';
  end if;
  select * into rv from vehicles where id = p_replacement_vehicle_id for update;
  if rv.id is null or rv.variant_id is distinct from ob.variant_id or rv.color_id is distinct from ob.color_id then
    raise exception 'The car given back must be %''s variant and colour', ob.customer_name;
  end if;
  if rv.id <> a.vehicle_id and not vehicle_allotable(rv) then
    raise exception 'The car given back is not available';
  end if;

  perform set_config('pool.busy', 'on', true);
  perform release_allotment_core(a.id, 'Changed car: ' || btrim(p_reason));
  perform release_allotment_core(oa.id, 'Car given to ' || b.customer_name || ': ' || btrim(p_reason));
  perform allot_vehicle_core(b.id, v.id, a.method, a.override_reason, current_employee_id(), a.win_path);
  perform allot_vehicle_core(ob.id, rv.id, oa.method, oa.override_reason, current_employee_id(), oa.win_path);
  perform set_config('pool.busy', 'off', true);
  perform pool_mark_dirty(b.variant_id, b.color_id);
  perform pool_log('change_vehicle', b.id, v.id, b.variant_id, b.color_id,
                   jsonb_build_object('from_vehicle', a.vehicle_id, 'reason', btrim(p_reason), 'took_from', ob.id));
  perform pool_log('change_vehicle', ob.id, rv.id, ob.variant_id, ob.color_id,
                   jsonb_build_object('from_vehicle', v.id, 'reason', btrim(p_reason), 'given_to', b.id));
  return jsonb_build_object('status', 'swapped');
end;
$$;

-- ===== Lists =====
create or replace function pool_overview()
returns table (variant_id uuid, color_id uuid, model_name text, variant_name text, color_name text, free_cars int,
               pool_size int, members int, winners int, allotted int, waiting int)
language sql
stable
security definer
set search_path = public
as $$
  with keys as (
    select v.variant_id, v.color_id from vehicles v where pool_vehicle_free(v)
    union
    select pm.variant_id, pm.color_id from pool_members pm where pm.status = 'active'
    union
    select bk.variant_id, bk.color_id from bookings bk
    where bk.status = 'booked' and bk.variant_id is not null and bk.color_id is not null and booking_allotable(bk.id)
  ), counted as (
    select k.variant_id, k.color_id, pool_free_count(k.variant_id, k.color_id) as free_cars from keys k
  )
  select k.variant_id, k.color_id, mo.name, va.name, co.name, k.free_cars, pool_target_size(k.free_cars),
         (select count(*)::int from pool_members pm where pm.variant_id = k.variant_id and pm.color_id = k.color_id and pm.status = 'active'),
         (select count(*)::int from pool_members pm where pm.variant_id = k.variant_id and pm.color_id = k.color_id
            and pm.status = 'active' and pm.completed_at is not null),
         (select count(*)::int from pool_members pm join allotments a on a.booking_id = pm.booking_id and a.released_at is null
          where pm.variant_id = k.variant_id and pm.color_id = k.color_id and pm.status = 'allotted'),
         (select count(*)::int from bookings bk where bk.variant_id = k.variant_id and bk.color_id = k.color_id
            and bk.status = 'booked' and booking_allotable(bk.id))
  from counted k
  join variants va on va.id = k.variant_id join models mo on mo.id = va.model_id join colors co on co.id = k.color_id
  where coalesce(current_employee_role_rank() <= 3, false)
  order by mo.name, va.name, co.name;
$$;

-- Everyone in or queuing for one pool, in the order the pool sees them: winners by completion
-- time, then members and the queue by booking date. Allotted members whose car has not been
-- billed yet are listed too.
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
           (select fc.status from finance_cases fc where fc.booking_id = bk.id and fc.status <> 'rejected') as finance_status,
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

-- Pool members still waiting for a car, with how far each has got with the DO or payment.
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
  left join finance_cases fc on fc.booking_id = bk.id and fc.status <> 'rejected'
  left join financiers fi on fi.id = fc.financier_id
  cross join lateral booking_account(bk.id) ac
  where pm.status = 'active' and (p_outlet_id is null or bk.outlet_id = p_outlet_id) and pool_can_see_booking(bk)
  order by pm.completed_at nulls last, pm.booking_date, bk.created_at;
$$;

-- Bookings that could take a car but are not in a pool (no free car, or behind the queue).
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
  left join finance_cases fc on fc.booking_id = bk.id and fc.status <> 'rejected'
  where bk.status = 'booked' and booking_allotable(bk.id)
    and not exists (select 1 from pool_members pm where pm.booking_id = bk.id and pm.status = 'active')
    and (p_outlet_id is null or bk.outlet_id = p_outlet_id) and pool_can_see_booking(bk)
  order by booking_order_date(bk), bk.created_at;
$$;

-- The variant's current ex-showroom price (lowest paint), to compare variants.
create or replace function pool_variant_price(p_variant_id uuid)
returns numeric
language sql
stable
set search_path = public
as $$
  select min(p.ex_showroom_price) from price_list p
  where p.variant_id = p_variant_id and p.effective_from <= current_date and (p.effective_to is null or p.effective_to >= current_date);
$$;

-- "Vehicle Not Available": bookings further down their variant + colour queue than there are free
-- cars, with how long they have waited and what is free instead.
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
         (select fc.status from finance_cases fc where fc.booking_id = k.id and fc.status <> 'rejected'),
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

create or replace function pool_audit_search(p_booking_id uuid default null, p_vin text default null,
                                             p_variant_id uuid default null, p_color_id uuid default null)
returns table (id uuid, created_at timestamptz, event text, booking_id uuid, customer_name text, ctdms_order_no text,
               vin text, variant_name text, color_name text, details jsonb, by_name text)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.created_at, l.event, l.booking_id, bk.customer_name, bk.ctdms_order_booking_no, v.vin, va.name, co.name,
         l.details, e.name
  from pool_audit_log l
  left join bookings bk on bk.id = l.booking_id
  left join vehicles v on v.id = l.vehicle_id
  left join variants va on va.id = l.variant_id
  left join colors co on co.id = l.color_id
  left join employees e on e.id = l.by_employee_id
  where coalesce(current_employee_role_rank() <= 3, false)
    and (p_booking_id is null or l.booking_id = p_booking_id)
    and (p_vin is null or btrim(p_vin) = '' or v.vin ilike '%' || btrim(p_vin) || '%'
         or l.booking_id in (select a.booking_id from allotments a join vehicles v3 on v3.id = a.vehicle_id where v3.vin ilike '%' || btrim(p_vin) || '%'))
    and (p_variant_id is null or l.variant_id = p_variant_id)
    and (p_color_id is null or l.color_id = p_color_id)
  order by l.created_at desc
  limit 300;
$$;

-- ===== Grants =====
revoke execute on function pool_vehicle_free(vehicles) from public, anon, authenticated;
revoke execute on function pool_free_count(uuid, uuid) from public, anon;
revoke execute on function pool_target_size(int) from public, anon;
revoke execute on function pool_booking_completion(uuid) from public, anon, authenticated;
revoke execute on function pool_log(text, uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function pool_variant_price(uuid) from public, anon;
revoke execute on function pool_recompute_all() from public, anon;
revoke execute on function pool_config_update(boolean, int, int, numeric) from public, anon;
revoke execute on function pool_fast_track(uuid, text) from public, anon;
revoke execute on function pool_member_hold(uuid, text, date) from public, anon;
revoke execute on function pool_change_vehicle(uuid, uuid, text, uuid) from public, anon;
revoke execute on function pool_overview() from public, anon;
revoke execute on function pool_detail(uuid, uuid) from public, anon;
revoke execute on function pool_finance_queue(uuid) from public, anon;
revoke execute on function pool_non_pool_bookings(uuid) from public, anon;
revoke execute on function pool_vna_demand(uuid) from public, anon;
revoke execute on function pool_audit_search(uuid, text, uuid, uuid) from public, anon;
grant execute on function pool_free_count(uuid, uuid) to authenticated;
grant execute on function pool_target_size(int) to authenticated;
grant execute on function pool_variant_price(uuid) to authenticated;
grant execute on function pool_recompute_all() to authenticated;
grant execute on function pool_config_update(boolean, int, int, numeric) to authenticated;
grant execute on function pool_fast_track(uuid, text) to authenticated;
grant execute on function pool_member_hold(uuid, text, date) to authenticated;
grant execute on function pool_change_vehicle(uuid, uuid, text, uuid) to authenticated;
grant execute on function pool_overview() to authenticated;
grant execute on function pool_detail(uuid, uuid) to authenticated;
grant execute on function pool_finance_queue(uuid) to authenticated;
grant execute on function pool_non_pool_bookings(uuid) to authenticated;
grant execute on function pool_vna_demand(uuid) to authenticated;
grant execute on function pool_audit_search(uuid, text, uuid, uuid) to authenticated;
