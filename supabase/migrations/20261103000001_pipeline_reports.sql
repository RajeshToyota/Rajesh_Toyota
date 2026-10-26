-- Phase 15: pipeline dashboard and reports.
-- Every function here is security invoker, so each person's numbers are exactly the rows RLS already
-- lets them see: a consultant sees their own pipeline, a Team Leader their team, an Outlet Head their
-- branch, the Business Head everything. Dates are taken in IST.
--   - pipeline_activity: what happened in a period, per branch and person (enquiries to deliveries).
--   - pipeline_snapshot: what is open right now, per branch and person, stage by stage.
--   - pipeline_breakdowns: enquiry sources and their conversion, lost and cancellation reasons,
--     bookings by model.
--   - stock_ageing: cars not yet billed, by branch, source and age band, with interest.
-- enquiries gains lost_at, so "lost this month" is exact.

-- ===== When an enquiry was lost =====
alter table enquiries add column lost_at timestamptz;
update enquiries set lost_at = updated_at where stage = 'lost' and lost_at is null;

create or replace function enquiries_lost_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if NEW.stage = 'lost' and (TG_OP = 'INSERT' or OLD.stage is distinct from 'lost') then
    NEW.lost_at := now();
  elsif NEW.stage <> 'lost' then
    NEW.lost_at := null;
  end if;
  return NEW;
end;
$$;
create trigger trg_enquiries_lost_at before insert or update of stage on enquiries
  for each row execute function enquiries_lost_at();

create or replace function ist_date(p timestamptz)
returns date
language sql
immutable
set search_path = public
as $$
  select (p at time zone 'Asia/Kolkata')::date;
$$;

-- The booking's own date: the CTDMS order date for imported orders, else when it was entered.
create or replace function booking_date(b bookings)
returns date
language sql
stable
set search_path = public
as $$
  select coalesce(b.ctdms_order_date, ist_date(b.created_at));
$$;

-- ===== Activity in a period =====
create or replace function pipeline_activity(p_from date, p_to date, p_outlet_id uuid default null)
returns table (
  outlet_id uuid, employee_id uuid,
  enquiries int, test_drives int, quotes int, final_quotes int, bookings int,
  allotted int, billed int, delivered int, cancelled int, lost int
)
language sql
stable
security invoker
set search_path = public
as $$
  with ev as (
    select e.outlet_id, e.assigned_employee_id as employee_id, 'enquiry' as k from enquiries e
      where ist_date(e.created_at) between p_from and p_to
    union all
    select e.outlet_id, e.assigned_employee_id, 'test_drive' from enquiries e
      where e.test_drive_given and ist_date(e.created_at) between p_from and p_to
    union all
    select e.outlet_id, e.assigned_employee_id, 'lost' from enquiries e
      where e.stage = 'lost' and ist_date(e.lost_at) between p_from and p_to
    union all
    select q.outlet_id, q.employee_id, 'quote' from quotes q
      where ist_date(q.created_at) between p_from and p_to
    union all
    select q.outlet_id, q.employee_id, 'final_quote' from quotes q
      where q.finalized_at is not null and ist_date(q.finalized_at) between p_from and p_to
    union all
    select b.outlet_id, b.employee_id, 'booking' from bookings b
      where booking_date(b) between p_from and p_to
    union all
    select b.outlet_id, b.employee_id, 'allotted' from bookings b
      where exists (select 1 from allotments a where a.booking_id = b.id and ist_date(a.allotted_at) between p_from and p_to)
    union all
    select b.outlet_id, b.employee_id, 'billed' from billing_requests r join bookings b on b.id = r.booking_id
      where r.status = 'invoiced' and coalesce(r.invoice_date, ist_date(r.invoiced_at)) between p_from and p_to
    union all
    select b.outlet_id, b.employee_id, 'delivered' from deliveries d join bookings b on b.id = d.booking_id
      where d.status = 'delivered' and ist_date(d.delivered_at) between p_from and p_to
    union all
    select b.outlet_id, b.employee_id, 'cancelled' from booking_cancellations c join bookings b on b.id = c.booking_id
      where c.status = 'approved' and ist_date(c.decided_at) between p_from and p_to
  )
  select ev.outlet_id, ev.employee_id,
    count(*) filter (where k = 'enquiry')::int,
    count(*) filter (where k = 'test_drive')::int,
    count(*) filter (where k = 'quote')::int,
    count(*) filter (where k = 'final_quote')::int,
    count(*) filter (where k = 'booking')::int,
    count(*) filter (where k = 'allotted')::int,
    count(*) filter (where k = 'billed')::int,
    count(*) filter (where k = 'delivered')::int,
    count(*) filter (where k = 'cancelled')::int,
    count(*) filter (where k = 'lost')::int
  from ev
  where p_outlet_id is null or ev.outlet_id = p_outlet_id
  group by ev.outlet_id, ev.employee_id;
$$;

-- ===== Open right now =====
-- Each open booking sits in exactly one stage: on hold, cancellation asked, waiting for a car,
-- car allotted, with Accounts for billing, or billed and waiting for delivery.
create or replace function pipeline_snapshot(p_outlet_id uuid default null)
returns table (
  outlet_id uuid, employee_id uuid,
  open_enquiries int, quoted_enquiries int, quotes_awaiting_approval int,
  awaiting_car int, allotted int, with_accounts int, billed_not_delivered int,
  on_hold int, cancel_requested int
)
language sql
stable
security invoker
set search_path = public
as $$
  with bk as (
    select b.outlet_id, b.employee_id,
      case
        when exists (select 1 from booking_cancellations c where c.booking_id = b.id and c.status = 'pending') then 'cancel_requested'
        when exists (select 1 from booking_holds h where h.booking_id = b.id and h.resumed_at is null) then 'on_hold'
        when exists (select 1 from billing_requests r where r.booking_id = b.id and r.status = 'invoiced') then 'billed'
        when exists (select 1 from billing_requests r where r.booking_id = b.id and r.status = 'pending') then 'with_accounts'
        when exists (select 1 from allotments a where a.booking_id = b.id and a.released_at is null) then 'allotted'
        else 'awaiting_car'
      end as k
    from bookings b
    where b.status not in ('delivered', 'cancelled')
  ), ev as (
    select outlet_id, employee_id, k from bk
    union all
    select e.outlet_id, e.assigned_employee_id, case e.stage when 'open' then 'open_enquiry' else 'quoted_enquiry' end
      from enquiries e where e.stage in ('open', 'quoted')
    union all
    select q.outlet_id, q.employee_id, 'quote_approval' from quotes q
      where exists (select 1 from approvals a where a.quote_id = q.id and a.status = 'pending')
  )
  select ev.outlet_id, ev.employee_id,
    count(*) filter (where k = 'open_enquiry')::int,
    count(*) filter (where k = 'quoted_enquiry')::int,
    count(*) filter (where k = 'quote_approval')::int,
    count(*) filter (where k = 'awaiting_car')::int,
    count(*) filter (where k = 'allotted')::int,
    count(*) filter (where k = 'with_accounts')::int,
    count(*) filter (where k = 'billed')::int,
    count(*) filter (where k = 'on_hold')::int,
    count(*) filter (where k = 'cancel_requested')::int
  from ev
  where p_outlet_id is null or ev.outlet_id = p_outlet_id
  group by ev.outlet_id, ev.employee_id;
$$;

-- ===== Why: sources, reasons, models =====
-- kind = 'source' (enquiry mode; converted = booked so far), 'lost_reason', 'cancel_reason' or 'model'
-- (bookings in the period by model; converted = delivered so far).
create or replace function pipeline_breakdowns(p_from date, p_to date, p_outlet_id uuid default null)
returns table (kind text, label text, total int, converted int)
language sql
stable
security invoker
set search_path = public
as $$
  select 'source', e.mode, count(*)::int, count(*) filter (where e.stage = 'booked')::int
  from enquiries e
  where ist_date(e.created_at) between p_from and p_to and (p_outlet_id is null or e.outlet_id = p_outlet_id)
  group by e.mode
  union all
  select 'lost_reason', coalesce(nullif(btrim(e.lost_reason), ''), 'Not given'), count(*)::int, 0
  from enquiries e
  where e.stage = 'lost' and ist_date(e.lost_at) between p_from and p_to and (p_outlet_id is null or e.outlet_id = p_outlet_id)
  group by 2
  union all
  select 'cancel_reason', c.reason_category, count(*)::int, 0
  from booking_cancellations c join bookings b on b.id = c.booking_id
  where c.status = 'approved' and ist_date(c.decided_at) between p_from and p_to and (p_outlet_id is null or b.outlet_id = p_outlet_id)
  group by c.reason_category
  union all
  select 'model', coalesce(m.name, 'Not mapped'), count(*)::int, count(*) filter (where b.status = 'delivered')::int
  from bookings b
  left join variants v on v.id = b.variant_id
  left join models m on m.id = v.model_id
  where booking_date(b) between p_from and p_to and b.status <> 'cancelled' and (p_outlet_id is null or b.outlet_id = p_outlet_id)
  group by m.name;
$$;

-- ===== Stock ageing =====
-- Cars not yet billed. Age is days since the TKM invoice (today), or the age the last statement gave.
create or replace function stock_ageing(p_outlet_id uuid default null)
returns table (outlet_id uuid, source text, age_band text, cars int, free_cars int, interest numeric, invoice_value numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select v.outlet_id, v.source,
    case
      when a.days is null then 'unknown'
      when a.days <= 30 then '0-30'
      when a.days <= 60 then '31-60'
      when a.days <= 90 then '61-90'
      else '90+'
    end,
    count(*)::int,
    count(*) filter (where v.status = 'available')::int,
    coalesce(sum(v.interest_amount), 0),
    coalesce(sum(v.tkm_invoice_amount), 0)
  from vehicles v
  cross join lateral (
    select coalesce(ist_date(now()) - v.tkm_invoice_date, v.days_since_invoice) as days
  ) a
  where v.status in ('available', 'allotted') and (p_outlet_id is null or v.outlet_id = p_outlet_id)
  group by 1, 2, 3;
$$;

revoke execute on function enquiries_lost_at() from public, anon, authenticated;
revoke execute on function pipeline_activity(date, date, uuid) from public, anon;
revoke execute on function pipeline_snapshot(uuid) from public, anon;
revoke execute on function pipeline_breakdowns(date, date, uuid) from public, anon;
revoke execute on function stock_ageing(uuid) from public, anon;
grant execute on function pipeline_activity(date, date, uuid) to authenticated;
grant execute on function pipeline_snapshot(uuid) to authenticated;
grant execute on function pipeline_breakdowns(date, date, uuid) to authenticated;
grant execute on function stock_ageing(uuid) to authenticated;
