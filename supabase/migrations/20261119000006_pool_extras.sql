-- Phase 28: allotment pool extras — the rest of Techwheels' stock allotment pool.
--   - Cross-match pairs (Techwheels' sap_vc_cross_match_pairs): two suffixes of a model that can stand
--     in for each other (e.g. with and without a package). Exact matches go first; a winner whose own
--     variant has no free car takes the paired variant's car only when no winner of that variant is
--     waiting for it. Pool sizes count both variants' free cars. The allotment records the kind
--     (upgrade / downgrade) and a signed adjustment, mirrored on the booking until the car is released;
--     an invoiced booking is never touched.
--   - Next in line: variant + colours with no free car, and the first N customers waiting.
--   - Average and median hours from joining the pool to getting a car.
--   - DO revert: the DO is withdrawn, the car goes back and the pool recomputes.
--   - Revert from billing: a car sent for billing (not yet invoiced) goes back to allotted or to the pool.
--   - WhatsApp send log: what was sent to whom and for which slot, so pages can warn "already sent" and
--     "slot changed since".
--   - Manual-only variants: kept out of the pool and its lists.

alter table pool_audit_log drop constraint pool_audit_log_event_check;
alter table pool_audit_log add constraint pool_audit_log_event_check check (event in (
  'pool_join', 'pool_bump', 'removed_ineligible', 'completion_banked', 'completion_unbanked', 'allotted',
  'released', 'fast_track', 'hold', 'change_vehicle', 'config_change', 'engine_error',
  'cross_match_allotted', 'do_reverted', 'billing_reverted'));

alter table pool_config add column next_in_line_size int not null default 3 check (next_in_line_size between 1 and 20);
alter table variants add column pool_manual_only boolean not null default false;

-- ===== Cross-match pairs =====
create table pool_cross_match_pairs (
  id uuid primary key default gen_random_uuid(),
  base_variant_id uuid not null references variants(id),
  upgraded_variant_id uuid not null references variants(id),
  adjustment_amount numeric not null check (adjustment_amount >= 0),
  label text not null,
  is_active boolean not null default true,
  created_by uuid references employees(id) default current_employee_id(),
  created_at timestamptz not null default now(),
  check (base_variant_id <> upgraded_variant_id)
);
create unique index uq_pool_pairs_base on pool_cross_match_pairs(base_variant_id) where is_active;
create unique index uq_pool_pairs_upgraded on pool_cross_match_pairs(upgraded_variant_id) where is_active;
create index idx_pool_pairs_by on pool_cross_match_pairs(created_by);
alter table pool_cross_match_pairs enable row level security;
create policy pool_pairs_select on pool_cross_match_pairs for select to authenticated using (true);

-- A variant may be in only one active pair, on either side.
create or replace function pool_pairs_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if NEW.is_active and exists (
    select 1 from pool_cross_match_pairs p
    where p.is_active and p.id <> NEW.id
      and (p.base_variant_id in (NEW.base_variant_id, NEW.upgraded_variant_id)
           or p.upgraded_variant_id in (NEW.base_variant_id, NEW.upgraded_variant_id))
  ) then
    raise exception 'A variant can be in only one active pair';
  end if;
  if (select model_id from variants where id = NEW.base_variant_id) is distinct from (select model_id from variants where id = NEW.upgraded_variant_id) then
    raise exception 'Both variants must be of the same model';
  end if;
  return NEW;
end;
$$;
create trigger trg_pool_pairs_guard before insert or update on pool_cross_match_pairs for each row execute function pool_pairs_guard();

alter table allotments
  add column cross_match_kind text check (cross_match_kind in ('upgrade', 'downgrade')),
  add column cross_match_adjustment numeric;
alter table bookings add column cross_match_adjustment numeric not null default 0;

create or replace function pool_partner_variant(p_variant_id uuid)
returns uuid
language sql
stable
set search_path = public
as $$
  select case when base_variant_id = p_variant_id then upgraded_variant_id else base_variant_id end
  from pool_cross_match_pairs where is_active and p_variant_id in (base_variant_id, upgraded_variant_id) limit 1;
$$;

-- The booking carries the adjustment of the car it holds now; an invoiced booking keeps what it had.
create or replace function allotments_mirror_cross_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from billing_requests where booking_id = NEW.booking_id and status = 'invoiced') then
    return NEW;
  end if;
  update bookings set cross_match_adjustment = coalesce((
    select a.cross_match_adjustment from allotments a where a.booking_id = NEW.booking_id and a.released_at is null), 0)
  where id = NEW.booking_id;
  return NEW;
end;
$$;
create trigger trg_allotments_mirror_cross_match after insert or update of released_at, cross_match_adjustment on allotments
  for each row execute function allotments_mirror_cross_match();

create or replace function pool_pair_save(p_base_variant_id uuid, p_upgraded_variant_id uuid, p_adjustment numeric, p_label text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not has_right('stock_pool_config', 'edit') then raise exception 'You need Pool Settings: edit'; end if;
  if nullif(btrim(p_label), '') is null then raise exception 'Name the difference (e.g. the package)'; end if;
  insert into pool_cross_match_pairs (base_variant_id, upgraded_variant_id, adjustment_amount, label)
  values (p_base_variant_id, p_upgraded_variant_id, coalesce(p_adjustment, 0), btrim(p_label)) returning id into v_id;
  perform pool_mark_dirty(p_base_variant_id, c.id) from colors c;
  perform pool_mark_dirty(p_upgraded_variant_id, c.id) from colors c;
  return v_id;
end;
$$;

create or replace function pool_pair_deactivate(p_pair_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not has_right('stock_pool_config', 'edit') then raise exception 'You need Pool Settings: edit'; end if;
  update pool_cross_match_pairs set is_active = false where id = p_pair_id;
end;
$$;

-- Cars allotted across a pair, still held.
create or replace function pool_cross_match_allotments()
returns table (booking_id uuid, customer_name text, booked_variant text, allotted_variant text, color text, vin text, kind text,
               adjustment numeric, allotted_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.customer_name, bv.name, vv.name, co.name, v.vin, a.cross_match_kind, a.cross_match_adjustment, a.allotted_at
  from allotments a join bookings b on b.id = a.booking_id join vehicles v on v.id = a.vehicle_id
  join variants bv on bv.id = b.variant_id join variants vv on vv.id = v.variant_id join colors co on co.id = v.color_id
  where a.released_at is null and a.cross_match_kind is not null and pool_can_see_booking(b)
  order by a.allotted_at desc;
$$;

-- ===== Next in line =====
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
  left join finance_cases fc on fc.booking_id = w.id and fc.status <> 'rejected'
  left join financiers fi on fi.id = fc.financier_id
  where pool_free_count(w.variant_id, w.color_id) = 0
    and w.pos <= (select next_in_line_size from pool_config)
    and (p_outlet_id is null or w.outlet_id = p_outlet_id)
    and pool_can_see_booking((select bb from bookings bb where bb.id = w.id))
  order by mo.name, va.name, co.name, w.pos;
$$;

-- ===== Average time from joining the pool to getting a car =====
create or replace function pool_avg_clear_time(p_days int default 30)
returns table (allotments int, avg_hours numeric, median_hours numeric)
language sql
stable
security definer
set search_path = public
as $$
  with won as (
    select l.booking_id, l.created_at as allotted_at,
           (select max(j.created_at) from pool_audit_log j where j.booking_id = l.booking_id and j.event = 'pool_join' and j.created_at <= l.created_at) joined_at
    from pool_audit_log l
    where l.event in ('allotted', 'cross_match_allotted') and l.created_at >= now() - make_interval(days => p_days)
  )
  select count(*)::int,
         round(avg(extract(epoch from allotted_at - joined_at) / 3600)::numeric, 1),
         round((percentile_cont(0.5) within group (order by extract(epoch from allotted_at - joined_at) / 3600))::numeric, 1)
  from won where joined_at is not null and has_right('stock_pool', 'view');
$$;

-- ===== DO revert =====
-- The DO is withdrawn (the bank cancelled it, or it was recorded by mistake): the finance case goes
-- back to sanctioned, and the pool takes the car back unless it has gone for billing.
create or replace function pool_revert_do(p_booking_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_case uuid;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not ops_can('stock_pool', 'approve', b.outlet_id) then raise exception 'Booking not found'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  if exists (select 1 from billing_requests where booking_id = b.id and status in ('pending', 'invoiced')) then
    raise exception 'The car has gone for billing; pull the billing back first';
  end if;
  select id into v_case from finance_cases where booking_id = b.id and status = 'do_received' order by created_at desc limit 1;
  if v_case is null then raise exception 'This booking has no DO to withdraw'; end if;
  update finance_cases set status = 'sanctioned', do_number = null, do_amount = null, do_date = null,
    notes = concat_ws(E'\n', notes, 'DO withdrawn: ' || btrim(p_reason))
  where id = v_case;
  insert into pool_audit_log (event, booking_id, variant_id, color_id, details)
  values ('do_reverted', b.id, b.variant_id, b.color_id, jsonb_build_object('reason', btrim(p_reason)));
  perform pool_mark_dirty(b.variant_id, b.color_id);
end;
$$;

-- ===== Revert from billing =====
create or replace function pool_revert_from_billing(p_booking_id uuid, p_target text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  r billing_requests%rowtype;
  v_allotment uuid;
begin
  select * into b from bookings where id = p_booking_id for update;
  if b.id is null or not ops_can('stock_pool', 'approve', b.outlet_id) then raise exception 'Booking not found'; end if;
  if p_target not in ('allotted', 'pool') then raise exception 'Send it back to allotted or to the pool'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  if exists (select 1 from billing_requests where booking_id = b.id and status = 'invoiced') then
    raise exception 'The car has been invoiced; this is now a billing reversal';
  end if;
  select * into r from billing_requests where booking_id = b.id and status = 'pending' for update;
  if r.id is null then raise exception 'This booking has not been sent for billing'; end if;
  update billing_requests set status = 'cancelled', cancel_reason = 'Reverted: ' || btrim(p_reason) where id = r.id;
  update bookings set status = 'allocated' where id = b.id and status = 'ready_to_invoice';
  if p_target = 'pool' then
    select id into v_allotment from allotments where booking_id = b.id and released_at is null;
    if v_allotment is not null then
      perform release_allotment_core(v_allotment, 'Reverted from billing to the pool: ' || btrim(p_reason));
    end if;
  end if;
  insert into pool_audit_log (event, booking_id, vehicle_id, variant_id, color_id, details)
  values ('billing_reverted', b.id, r.vehicle_id, b.variant_id, b.color_id, jsonb_build_object('to', p_target, 'reason', btrim(p_reason)));
  perform pool_mark_dirty(b.variant_id, b.color_id);
end;
$$;

-- ===== WhatsApp send log =====
create table whatsapp_send_log (
  id uuid primary key default gen_random_uuid(),
  context text not null check (context in ('finance_queue', 'vna', 'allotted', 'delivery', 'booking', 'other')),
  booking_id uuid references bookings(id),
  mobile text,
  payload_hash text,
  slot_ref text,      -- e.g. the delivery slot the message announced
  sent_by uuid references employees(id) default current_employee_id(),
  sent_at timestamptz not null default now()
);
create index idx_whatsapp_send_log_booking on whatsapp_send_log(booking_id, context, sent_at desc);
create index idx_whatsapp_send_log_by on whatsapp_send_log(sent_by);
alter table whatsapp_send_log enable row level security;
create policy whatsapp_send_log_select on whatsapp_send_log for select to authenticated using (booking_id is null or can_access_booking(booking_id));
create policy whatsapp_send_log_insert on whatsapp_send_log for insert to authenticated
  with check (sent_by = current_employee_id() and (booking_id is null or can_access_booking(booking_id)));

-- The last message of a context per booking, and whether the slot it named has changed since.
create or replace function whatsapp_last_sent(p_context text, p_booking_ids uuid[])
returns table (booking_id uuid, sent_at timestamptz, sent_by text, slot_ref text)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on (l.booking_id) l.booking_id, l.sent_at, e.name, l.slot_ref
  from whatsapp_send_log l left join employees e on e.id = l.sent_by
  where l.context = p_context and l.booking_id = any (p_booking_ids)
  order by l.booking_id, l.sent_at desc;
$$;

create or replace function pool_set_next_in_line_size(p_size int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not has_right('stock_pool_config', 'edit') then raise exception 'You need Pool Settings: edit'; end if;
  update pool_config set next_in_line_size = p_size, updated_by = current_employee_id(), updated_at = now();
end;
$$;

create or replace function set_variant_pool_manual_only(p_variant_id uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v variants%rowtype;
begin
  if not has_right('stock_pool_config', 'edit') then raise exception 'You need Pool Settings: edit'; end if;
  update variants set pool_manual_only = p_on where id = p_variant_id returning * into v;
  perform pool_mark_dirty(p_variant_id, c.id) from colors c;
end;
$$;

-- ===== Pool: manual-only variants are not pool stock =====
create or replace function pool_vehicle_free(v vehicles)
returns boolean
language sql
stable
set search_path = public
as $$
  select v.variant_id is not null and v.color_id is not null and vehicle_allotable(v)
    and coalesce(v.ctdms_block_status, '') not in ('Blocked', 'Alloted')
    and not coalesce((select pool_manual_only from variants where id = v.variant_id), false);
$$;

-- ===== pool_recompute (latest definition, extended with cross-match pairs) =====
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
  v_partner uuid;
  v_pair pool_cross_match_pairs%rowtype;
  v_kind text;
begin
  select * into cfg from pool_config;
  if p_variant_id is null or p_color_id is null or not cfg.enabled then
    return jsonb_build_object('skipped', true);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pool:' || p_variant_id::text || ':' || p_color_id::text, 0));
  -- Our own changes below must not queue this key again.
  perform set_config('pool.busy', 'on', true);
  select * into v_pair from pool_cross_match_pairs where is_active and p_variant_id in (base_variant_id, upgraded_variant_id) limit 1;
  v_partner := case when v_pair.id is null then null when v_pair.base_variant_id = p_variant_id then v_pair.upgraded_variant_id else v_pair.base_variant_id end;

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
      when v.missing_from_report and v.source = 'physical' and not vehicle_stock_added(v.id) then 'Car left the physical stock report'
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
    -- Pair-aware: a paired variant's free cars count too (Phase 28).
    v_free := pool_free_count(p_variant_id, p_color_id) + case when v_partner is null then 0 else pool_free_count(v_partner, p_color_id) end;
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
    -- No car of our own: the paired variant's car, when none of its own winners is waiting for it.
    if v_vehicle is null and v_partner is not null
       and not exists (select 1 from pool_members px where px.variant_id = v_partner and px.color_id = p_color_id
                       and px.status = 'active' and px.completed_at is not null) then
      select v2.id into v_vehicle from vehicles v2
      where v2.variant_id = v_partner and v2.color_id = p_color_id and pool_vehicle_free(v2)
      order by (v2.source = 'physical') desc, v2.days_since_invoice desc nulls last, v2.vin
      limit 1
      for update skip locked;
      if v_vehicle is not null then
        v_kind := case when v_partner = v_pair.upgraded_variant_id then 'upgrade' else 'downgrade' end;
      end if;
    end if;
    exit when v_vehicle is null;

    v_allotment := allot_vehicle_core(v_winner.booking_id, v_vehicle, 'pool', null, null, v_winner.win_path);
    if v_kind is not null then
      update allotments set cross_match_kind = v_kind,
        cross_match_adjustment = case when v_kind = 'upgrade' then v_pair.adjustment_amount else -v_pair.adjustment_amount end
      where id = v_allotment;
      perform pool_log('cross_match_allotted', v_winner.booking_id, v_vehicle, p_variant_id, p_color_id,
                       jsonb_build_object('kind', v_kind, 'label', v_pair.label, 'adjustment', v_pair.adjustment_amount));
      -- The partner's pool size just changed; it is rechecked when this transaction commits.
      insert into pool_dirty_keys (variant_id, color_id) values (v_partner, p_color_id) on conflict do nothing;
      v_kind := null;
    end if;
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

-- ===== Grants =====
do $$
declare f text;
begin
  foreach f in array array[
    'pool_pair_save(uuid, uuid, numeric, text)', 'pool_pair_deactivate(uuid)', 'pool_cross_match_allotments()',
    'pool_next_in_line(uuid)', 'pool_avg_clear_time(int)', 'pool_revert_do(uuid, text)', 'pool_revert_from_billing(uuid, text, text)',
    'whatsapp_last_sent(text, uuid[])', 'pool_set_next_in_line_size(int)', 'set_variant_pool_manual_only(uuid, boolean)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke execute on function pool_partner_variant(uuid) from public, anon, authenticated;
revoke execute on function allotments_mirror_cross_match() from public, anon, authenticated;
revoke execute on function pool_pairs_guard() from public, anon, authenticated;
revoke execute on function pool_vehicle_free(vehicles) from public, anon, authenticated;

insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('stock_pool_extras', 'stock', 'Next in Line & Pairs', '/stock/pool/next-in-line', 22, true);
select seed_role_rights('Outlet Head', 'stock_pool_extras', array['view']);
select seed_role_rights('Head Customer Relations', 'stock_pool_extras', array['view']);
select seed_role_rights('Team Leader', 'stock_pool_extras', array['view']);
