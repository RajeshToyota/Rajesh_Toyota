-- Phase 19: follow-ups, tasks, reception walk-ins, test drives and the RM console (Techwheels' lead
-- follow-up, reception kiosk, test drive and Relationship Manager modules).
--
--   Follow-ups  every open enquiry has a next follow-up date; logging a call/visit records the outcome,
--               the new temperature and the next date. New enquiries get one automatically
--               (HOT next day, WRM in 2 days, CLD in a week).
--   Tasks       a to-do for anyone, optionally tied to an enquiry or booking.
--   Reception   the front desk records every walk-in and hands it to a consultant, who turns it into an
--               enquiry (or links the customer's open one).
--   Test drive  a demo fleet per branch; drives are booked without clashes, need the driving licence
--               to start, and record kilometres and feedback. Finishing one marks the enquiry.
--   RM console  after booking, a Relationship Manager owns the customer until delivery: a pipeline by
--               where each booking is stuck, notes, and customer requests.

-- ===== Modules and rights =====
insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('followups',     'crm',       'My Follow-ups',        '/followups',             10, true),
  ('tasks',         'crm',       'Tasks',                '/tasks',                 20, true),
  ('reception',     'crm',       'Reception',            '/reception',             30, true),
  ('test_drive',    'crm',       'Test Drives',          '/test-drives',           40, true),
  ('rm_console',    'crm',       'RM Console',           '/rm',                    50, true),
  ('rm_assign',     'crm',       'Assign RMs',           null,                     55, false),
  ('rpt_walkins',   'reporting', 'Walk-in Conversion',   '/reports/walkins',       90, true),
  ('rpt_followups', 'reporting', 'Follow-up Compliance', '/reports/followups',    100, true);

select seed_role_rights(r, m, x) from (values
  ('Outlet Head', 'followups', array['view','create','edit']), ('Outlet Head', 'tasks', array['view','create','edit']),
  ('Outlet Head', 'reception', array['view','create','edit']), ('Outlet Head', 'test_drive', array['view','create','edit']),
  ('Outlet Head', 'rm_console', array['view','edit']), ('Outlet Head', 'rm_assign', array['view','edit']),
  ('Outlet Head', 'rpt_walkins', array['view']), ('Outlet Head', 'rpt_followups', array['view']),
  ('Head Customer Relations', 'followups', array['view','create','edit']), ('Head Customer Relations', 'tasks', array['view','create','edit']),
  ('Head Customer Relations', 'reception', array['view','create','edit']), ('Head Customer Relations', 'test_drive', array['view','create','edit']),
  ('Head Customer Relations', 'rm_console', array['view','edit']), ('Head Customer Relations', 'rm_assign', array['view','edit']),
  ('Head Customer Relations', 'rpt_walkins', array['view']), ('Head Customer Relations', 'rpt_followups', array['view']),
  ('Team Leader', 'followups', array['view','create','edit']), ('Team Leader', 'tasks', array['view','create','edit']),
  ('Team Leader', 'reception', array['view','edit']), ('Team Leader', 'test_drive', array['view','create','edit']),
  ('Team Leader', 'rpt_walkins', array['view']), ('Team Leader', 'rpt_followups', array['view']),
  ('Sales Consultant', 'followups', array['view','create','edit']), ('Sales Consultant', 'tasks', array['view','create','edit']),
  ('Sales Consultant', 'reception', array['view','edit']), ('Sales Consultant', 'test_drive', array['view','create','edit']),
  ('Receptionist', 'reception', array['view','create']), ('Receptionist', 'test_drive', array['view']),
  ('Relationship Manager', 'rm_console', array['view','edit']), ('Relationship Manager', 'tasks', array['view','create','edit'])
) v(r, m, x);

-- ===== Follow-ups =====
alter table enquiries add column next_followup_at timestamptz, add column last_followup_at timestamptz;
create index idx_enquiries_next_followup on enquiries(assigned_employee_id, next_followup_at) where stage in ('open', 'quoted');

create table enquiry_followups (
  id uuid primary key default gen_random_uuid(),
  enquiry_id uuid not null references enquiries(id),
  employee_id uuid not null references employees(id),
  channel text not null check (channel in ('call', 'visit', 'whatsapp', 'sms', 'email', 'home_visit')),
  outcome text not null check (outcome in ('connected', 'not_reachable', 'call_back', 'interested', 'visit_planned',
                                            'test_drive_planned', 'quote_sent', 'negotiating', 'not_interested')),
  note text,
  temperature text check (temperature in ('HOT', 'WRM', 'CLD')),
  due_at timestamptz,          -- when it was due (for on-time measurement)
  next_followup_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_enquiry_followups_enquiry on enquiry_followups(enquiry_id);
create index idx_enquiry_followups_employee on enquiry_followups(employee_id, created_at);

-- New enquiries get a first follow-up date from their temperature.
create or replace function enquiries_default_followup()
returns trigger
language plpgsql
as $$
begin
  if NEW.next_followup_at is null and NEW.stage in ('open', 'quoted') then
    NEW.next_followup_at := now() + case NEW.temperature when 'HOT' then interval '1 day'
                                                        when 'CLD' then interval '7 days'
                                                        else interval '2 days' end;
  end if;
  if NEW.stage in ('booked', 'lost') then
    NEW.next_followup_at := null;
  end if;
  return NEW;
end;
$$;
create trigger trg_enquiries_default_followup before insert or update of stage on enquiries
  for each row execute function enquiries_default_followup();
update enquiries set next_followup_at = now() where stage in ('open', 'quoted') and next_followup_at is null;

create or replace function log_followup(
  p_enquiry_id uuid, p_channel text, p_outcome text, p_note text default null,
  p_next_at timestamptz default null, p_temperature text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  e enquiries%rowtype;
  v_id uuid;
begin
  select * into e from enquiries where id = p_enquiry_id for update;
  if e.id is null or not can_access_employee_data(current_employee_id(), e.assigned_employee_id) then
    raise exception 'Enquiry not found';
  end if;
  if e.stage not in ('open', 'quoted') then raise exception 'This enquiry is closed'; end if;
  if p_outcome <> 'not_interested' and p_next_at is null then
    raise exception 'Set the next follow-up date';
  end if;
  if p_next_at is not null and p_next_at < now() - interval '5 minutes' then
    raise exception 'The next follow-up must be in the future';
  end if;
  if p_outcome in ('not_reachable', 'not_interested') and nullif(btrim(p_note), '') is null and p_outcome = 'not_interested' then
    raise exception 'Say why the customer is not interested';
  end if;
  insert into enquiry_followups (enquiry_id, employee_id, channel, outcome, note, temperature, due_at, next_followup_at)
  values (e.id, current_employee_id(), p_channel, p_outcome, nullif(btrim(p_note), ''), p_temperature, e.next_followup_at, p_next_at)
  returning id into v_id;
  update enquiries set next_followup_at = p_next_at, last_followup_at = now(),
    temperature = coalesce(p_temperature, temperature)
  where id = e.id;
  return v_id;
end;
$$;

-- Open enquiries with a follow-up, for the caller's line (their own, their team's, their branch's).
-- p_when: overdue, today, upcoming (next 7 days) or all.
create or replace function my_followups(p_when text default 'today', p_employee_id uuid default null)
returns table (
  enquiry_id uuid, customer_name text, mobile text, model text, temperature text, stage text, source text,
  assigned_to text, next_followup_at timestamptz, last_followup_at timestamptz, last_outcome text, last_note text,
  followups int, created_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select e.id, c.name, c.mobile, m.name, e.temperature, e.stage, e.mode, emp.name, e.next_followup_at, e.last_followup_at,
         lf.outcome, lf.note, (select count(*)::int from enquiry_followups f where f.enquiry_id = e.id), e.created_at
  from enquiries e
  join customers c on c.id = e.customer_id
  left join models m on m.id = e.model_id
  left join employees emp on emp.id = e.assigned_employee_id
  left join lateral (select f.outcome, f.note from enquiry_followups f where f.enquiry_id = e.id order by f.created_at desc limit 1) lf on true
  where e.stage in ('open', 'quoted')
    and (p_employee_id is null or e.assigned_employee_id = p_employee_id)
    and case p_when
          when 'overdue' then e.next_followup_at < date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
          when 'today' then e.next_followup_at < (date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day') at time zone 'Asia/Kolkata'
          when 'upcoming' then e.next_followup_at < now() + interval '7 days'
          else true
        end
  order by e.next_followup_at nulls last, e.temperature = 'HOT' desc;
$$;

create or replace function enquiry_followup_history(p_enquiry_id uuid)
returns table (id uuid, created_at timestamptz, employee text, channel text, outcome text, note text, temperature text,
               due_at timestamptz, next_followup_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select f.id, f.created_at, e.name, f.channel, f.outcome, f.note, f.temperature, f.due_at, f.next_followup_at
  from enquiry_followups f join employees e on e.id = f.employee_id
  where f.enquiry_id = p_enquiry_id
  order by f.created_at desc;
$$;

alter table enquiry_followups enable row level security;
create policy enquiry_followups_select on enquiry_followups for select to authenticated
  using (exists (select 1 from enquiries e where e.id = enquiry_id));

-- ===== Tasks =====
create table tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  detail text,
  due_at timestamptz,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  assigned_to uuid not null references employees(id),
  created_by uuid references employees(id),
  enquiry_id uuid references enquiries(id),
  booking_id uuid references bookings(id),
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  done_at timestamptz,
  done_note text,
  created_at timestamptz not null default now()
);
create index idx_tasks_assigned on tasks(assigned_to, status, due_at);
create index idx_tasks_created_by on tasks(created_by);
create index idx_tasks_enquiry on tasks(enquiry_id);
create index idx_tasks_booking on tasks(booking_id);

alter table tasks enable row level security;
create policy tasks_select on tasks for select to authenticated
  using (assigned_to = current_employee_id() or created_by = current_employee_id()
         or can_access_employee_data(current_employee_id(), assigned_to));

-- Anyone may give themselves a task; giving one to someone else needs them in your line or your branch's back office.
create or replace function create_task(p_title text, p_assigned_to uuid default null, p_due_at timestamptz default null,
                                       p_detail text default null, p_priority text default 'normal',
                                       p_enquiry_id uuid default null, p_booking_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_to uuid := coalesce(p_assigned_to, current_employee_id());
  v_id uuid;
begin
  if current_employee_id() is null then raise exception 'Not signed in as an employee'; end if;
  if not has_right('tasks', 'create') and not has_right('rm_console', 'edit') and not has_right('followups', 'create') then
    raise exception 'You cannot create tasks';
  end if;
  if nullif(btrim(p_title), '') is null then raise exception 'Give the task a title'; end if;
  if v_to <> current_employee_id()
     and not can_access_employee_data(current_employee_id(), v_to)
     and not (is_crm_back_office() and (select outlet_id from employees where id = v_to) = current_employee_outlet_id()) then
    raise exception 'You can only give tasks to people in your team';
  end if;
  if p_enquiry_id is not null and not exists (select 1 from enquiries where id = p_enquiry_id
       and can_access_employee_data(current_employee_id(), assigned_employee_id)) and not is_crm_back_office() then
    raise exception 'Enquiry not found';
  end if;
  if p_booking_id is not null and not (can_access_booking(p_booking_id) or exists (
       select 1 from bookings where id = p_booking_id and rm_employee_id = current_employee_id())) then
    raise exception 'Booking not found';
  end if;
  insert into tasks (title, detail, due_at, priority, assigned_to, created_by, enquiry_id, booking_id)
  values (btrim(p_title), nullif(btrim(p_detail), ''), p_due_at, coalesce(p_priority, 'normal'), v_to, current_employee_id(),
          p_enquiry_id, p_booking_id)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function complete_task(p_task_id uuid, p_status text default 'done', p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t tasks%rowtype;
begin
  select * into t from tasks where id = p_task_id for update;
  if t.id is null or not (t.assigned_to = current_employee_id() or t.created_by = current_employee_id()
                          or can_access_employee_data(current_employee_id(), t.assigned_to)) then
    raise exception 'Task not found';
  end if;
  if t.status <> 'open' then raise exception 'This task is already closed'; end if;
  if p_status not in ('done', 'cancelled') then raise exception 'Status must be done or cancelled'; end if;
  update tasks set status = p_status, done_at = now(), done_note = nullif(btrim(p_note), '') where id = t.id;
end;
$$;

create or replace function my_tasks(p_status text default 'open', p_employee_id uuid default null)
returns table (id uuid, title text, detail text, due_at timestamptz, priority text, status text, assigned_to text,
               created_by text, enquiry_id uuid, booking_id uuid, customer_name text, done_at timestamptz, done_note text, overdue boolean)
language sql
stable
security invoker
set search_path = public
as $$
  select t.id, t.title, t.detail, t.due_at, t.priority, t.status, a.name, c.name, t.enquiry_id, t.booking_id,
         coalesce(b.customer_name, cu.name), t.done_at, t.done_note, t.status = 'open' and t.due_at < now()
  from tasks t
  join employees a on a.id = t.assigned_to
  left join employees c on c.id = t.created_by
  left join bookings b on b.id = t.booking_id
  left join enquiries e on e.id = t.enquiry_id
  left join customers cu on cu.id = e.customer_id
  where (p_status = 'all' or t.status = p_status)
    and (case when p_employee_id is null then t.assigned_to = current_employee_id() else t.assigned_to = p_employee_id end)
  order by t.status = 'open' desc, t.due_at nulls last, t.priority = 'high' desc;
$$;

-- ===== Reception walk-ins =====
create table showroom_walkins (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references outlets(id),
  visited_at timestamptz not null default now(),
  customer_name text not null,
  mobile text not null,
  visitors int not null default 1 check (visitors between 1 and 20),
  purpose text not null default 'new_purchase'
    check (purpose in ('new_purchase', 'test_drive', 'exchange', 'price_enquiry', 'finance_enquiry', 'delivery', 'service', 'other')),
  model_id uuid references models(id),
  source text,
  assigned_employee_id uuid references employees(id),
  enquiry_id uuid references enquiries(id),
  status text not null default 'waiting' check (status in ('waiting', 'attended', 'converted', 'left')),
  attended_at timestamptz,
  left_reason text,
  notes text,
  recorded_by uuid references employees(id)
);
create index idx_walkins_outlet_date on showroom_walkins(outlet_id, visited_at);
create index idx_walkins_assigned on showroom_walkins(assigned_employee_id, status);
create index idx_walkins_enquiry on showroom_walkins(enquiry_id);
create index idx_walkins_recorded_by on showroom_walkins(recorded_by);
create index idx_walkins_model on showroom_walkins(model_id);

alter table showroom_walkins enable row level security;
create policy showroom_walkins_select on showroom_walkins for select to authenticated
  using (ops_can('reception', 'view', outlet_id)
         or (assigned_employee_id is not null and can_access_employee_data(current_employee_id(), assigned_employee_id)));

-- The front desk records the visit; with a consultant picked, it lands on their screen.
create or replace function record_walkin(p jsonb)
returns table (walkin_id uuid, open_enquiry_id uuid, open_enquiry_owner text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_outlet uuid := coalesce(nullif(p->>'outlet_id', '')::uuid, current_employee_outlet_id());
  v_mobile text := normalize_mobile(p->>'mobile');
  v_assignee uuid := nullif(p->>'assigned_employee_id', '')::uuid;
  v_id uuid;
  v_enq uuid;
  v_owner text;
begin
  if not ops_can('reception', 'create', v_outlet) then raise exception 'You cannot record walk-ins at this branch'; end if;
  if v_mobile is null then raise exception 'Enter a valid 10-digit mobile number'; end if;
  if nullif(btrim(p->>'customer_name'), '') is null then raise exception 'Enter the customer''s name'; end if;
  if v_assignee is not null and not exists (select 1 from employees where id = v_assignee and is_active and outlet_id = v_outlet) then
    raise exception 'Pick a consultant of this branch';
  end if;
  -- An open enquiry for this mobile goes back to its consultant.
  select e.id, emp.name, e.assigned_employee_id into v_enq, v_owner, v_assignee
  from enquiries e join customers c on c.id = e.customer_id join employees emp on emp.id = e.assigned_employee_id
  where c.mobile = v_mobile and e.stage in ('open', 'quoted') and emp.is_active
  order by e.created_at desc limit 1;
  if v_enq is null then
    v_assignee := nullif(p->>'assigned_employee_id', '')::uuid;
  end if;
  insert into showroom_walkins (outlet_id, customer_name, mobile, visitors, purpose, model_id, source, assigned_employee_id,
                                enquiry_id, notes, recorded_by)
  values (v_outlet, btrim(p->>'customer_name'), v_mobile, coalesce((p->>'visitors')::int, 1), coalesce(nullif(p->>'purpose', ''), 'new_purchase'),
          nullif(p->>'model_id', '')::uuid, nullif(btrim(p->>'source'), ''), v_assignee, v_enq, nullif(btrim(p->>'notes'), ''),
          current_employee_id())
  returning id into v_id;
  return query select v_id, v_enq, v_owner;
end;
$$;

create or replace function assign_walkin(p_walkin_id uuid, p_employee_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  w showroom_walkins%rowtype;
begin
  select * into w from showroom_walkins where id = p_walkin_id for update;
  if w.id is null or not (ops_can('reception', 'create', w.outlet_id) or ops_can('reception', 'edit', w.outlet_id) and is_crm_back_office()) then
    raise exception 'Walk-in not found';
  end if;
  if w.status not in ('waiting') then raise exception 'This walk-in has been attended'; end if;
  if not exists (select 1 from employees where id = p_employee_id and is_active and outlet_id = w.outlet_id) then
    raise exception 'Pick a consultant of this branch';
  end if;
  update showroom_walkins set assigned_employee_id = p_employee_id where id = w.id;
end;
$$;

-- The consultant meets the customer: link the open enquiry, or create one from the walk-in.
create or replace function attend_walkin(p_walkin_id uuid, p_enquiry jsonb default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  w showroom_walkins%rowtype;
  v_enq uuid;
begin
  select * into w from showroom_walkins where id = p_walkin_id for update;
  if w.id is null then raise exception 'Walk-in not found'; end if;
  if w.status not in ('waiting', 'attended') then raise exception 'This walk-in is closed'; end if;
  if w.assigned_employee_id is null then
    if current_employee_outlet_id() <> w.outlet_id then raise exception 'Walk-in not found'; end if;
    update showroom_walkins set assigned_employee_id = current_employee_id() where id = w.id;
    w.assigned_employee_id := current_employee_id();
  end if;
  if not can_access_employee_data(current_employee_id(), w.assigned_employee_id) then
    raise exception 'This walk-in is with another consultant';
  end if;
  v_enq := w.enquiry_id;
  if v_enq is null and p_enquiry is not null then
    v_enq := create_enquiry(p_enquiry || jsonb_build_object(
      'mobile', w.mobile, 'name', coalesce(nullif(p_enquiry->>'name', ''), w.customer_name),
      'mode', 'Walk-in', 'model_id', coalesce(p_enquiry->>'model_id', w.model_id::text),
      'purpose_of_visit', coalesce(nullif(p_enquiry->>'purpose_of_visit', ''),
                                   case when w.purpose in ('new_purchase', 'test_drive', 'exchange', 'price_enquiry', 'finance_enquiry') then w.purpose else 'other' end),
      'assigned_employee_id', w.assigned_employee_id));
  end if;
  update showroom_walkins set status = case when v_enq is not null then 'converted' else 'attended' end,
    attended_at = coalesce(attended_at, now()), enquiry_id = v_enq
  where id = w.id;
  return v_enq;
end;
$$;

create or replace function close_walkin(p_walkin_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  w showroom_walkins%rowtype;
begin
  select * into w from showroom_walkins where id = p_walkin_id for update;
  if w.id is null or not (ops_can('reception', 'view', w.outlet_id)
                          or (w.assigned_employee_id is not null and can_access_employee_data(current_employee_id(), w.assigned_employee_id))) then
    raise exception 'Walk-in not found';
  end if;
  if w.status in ('converted', 'left') then raise exception 'This walk-in is closed'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  update showroom_walkins set status = 'left', left_reason = btrim(p_reason) where id = w.id;
end;
$$;

create or replace function walkin_register(p_date date default null, p_outlet_id uuid default null)
returns table (id uuid, visited_at timestamptz, outlet text, customer_name text, mobile text, visitors int, purpose text,
               model text, source text, assigned_to text, assigned_employee_id uuid, status text, enquiry_id uuid, notes text, left_reason text,
               minutes_waiting int)
language sql
stable
security invoker
set search_path = public
as $$
  select w.id, w.visited_at, o.name, w.customer_name, w.mobile, w.visitors, w.purpose, m.name, w.source, e.name,
         w.assigned_employee_id, w.status, w.enquiry_id, w.notes, w.left_reason,
         case when w.status = 'waiting' then (extract(epoch from now() - w.visited_at) / 60)::int end
  from showroom_walkins w
  join outlets o on o.id = w.outlet_id
  left join models m on m.id = w.model_id
  left join employees e on e.id = w.assigned_employee_id
  where (w.visited_at at time zone 'Asia/Kolkata')::date = coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date)
    and (p_outlet_id is null or w.outlet_id = p_outlet_id)
  order by w.status = 'waiting' desc, w.visited_at desc;
$$;

-- ===== Test drives =====
create table test_drive_vehicles (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references outlets(id),
  variant_id uuid references variants(id),
  model_id uuid references models(id),
  reg_no text not null,
  vin text,
  fuel text,
  odometer_km int,
  status text not null default 'active' check (status in ('active', 'maintenance', 'retired')),
  created_at timestamptz not null default now()
);
create unique index uq_test_drive_vehicles_reg on test_drive_vehicles(upper(reg_no)) where status <> 'retired';
create index idx_test_drive_vehicles_outlet on test_drive_vehicles(outlet_id);
create index idx_test_drive_vehicles_variant on test_drive_vehicles(variant_id);
create index idx_test_drive_vehicles_model on test_drive_vehicles(model_id);

create table test_drives (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references test_drive_vehicles(id),
  enquiry_id uuid references enquiries(id),
  outlet_id uuid not null references outlets(id),
  employee_id uuid not null references employees(id),
  customer_name text not null,
  mobile text,
  scheduled_at timestamptz not null,
  duration_min int not null default 30 check (duration_min between 10 and 240),
  location text not null default 'showroom' check (location in ('showroom', 'home')),
  status text not null default 'scheduled' check (status in ('scheduled', 'out', 'completed', 'cancelled', 'no_show')),
  dl_number text,
  dl_photo_path text,
  start_km int,
  end_km int,
  started_at timestamptz,
  ended_at timestamptz,
  rating int check (rating between 1 and 5),
  feedback text,
  cancel_reason text,
  created_by uuid references employees(id),
  created_at timestamptz not null default now()
);
create index idx_test_drives_vehicle_time on test_drives(vehicle_id, scheduled_at);
create index idx_test_drives_enquiry on test_drives(enquiry_id);
create index idx_test_drives_outlet_time on test_drives(outlet_id, scheduled_at);
create index idx_test_drives_employee on test_drives(employee_id);
create index idx_test_drives_created_by on test_drives(created_by);

alter table test_drive_vehicles enable row level security;
alter table test_drives enable row level security;
create policy test_drive_vehicles_select on test_drive_vehicles for select to authenticated using (true);
create policy test_drives_select on test_drives for select to authenticated
  using (ops_can('test_drive', 'view', outlet_id) and (is_crm_back_office() or has_role('Receptionist')
         or can_access_employee_data(current_employee_id(), employee_id)));

create or replace function save_test_drive_vehicle(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet uuid := coalesce(nullif(p->>'outlet_id', '')::uuid, current_employee_outlet_id());
  v_id uuid;
begin
  if not (is_branch_back_office(v_outlet) and has_right('test_drive', 'edit')) then
    raise exception 'Only the branch back office can manage the demo fleet';
  end if;
  if p_id is null then
    if nullif(btrim(p->>'reg_no'), '') is null then raise exception 'Enter the registration number'; end if;
    insert into test_drive_vehicles (outlet_id, variant_id, model_id, reg_no, vin, fuel, odometer_km)
    values (v_outlet, nullif(p->>'variant_id', '')::uuid,
            coalesce(nullif(p->>'model_id', '')::uuid, (select model_id from variants where id = nullif(p->>'variant_id', '')::uuid)),
            upper(btrim(p->>'reg_no')), nullif(upper(btrim(p->>'vin')), ''), nullif(p->>'fuel', ''), (p->>'odometer_km')::int)
    returning id into v_id;
  else
    update test_drive_vehicles set status = coalesce(nullif(p->>'status', ''), status),
      odometer_km = coalesce((p->>'odometer_km')::int, odometer_km)
    where id = p_id and is_branch_back_office(outlet_id)
    returning id into v_id;
    if v_id is null then raise exception 'Vehicle not found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function schedule_test_drive(p_vehicle_id uuid, p_scheduled_at timestamptz, p_enquiry_id uuid default null,
                                               p_customer_name text default null, p_mobile text default null,
                                               p_duration_min int default 30, p_location text default 'showroom')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v test_drive_vehicles%rowtype;
  e enquiries%rowtype;
  c customers%rowtype;
  v_clash text;
  v_id uuid;
begin
  select * into v from test_drive_vehicles where id = p_vehicle_id;
  if v.id is null or v.status <> 'active' then raise exception 'This demo car is not available'; end if;
  if not ops_can('test_drive', 'create', v.outlet_id) then raise exception 'You cannot book test drives at this branch'; end if;
  if p_enquiry_id is not null then
    select * into e from enquiries where id = p_enquiry_id;
    if e.id is null or not (can_access_employee_data(current_employee_id(), e.assigned_employee_id) or is_crm_back_office()) then
      raise exception 'Enquiry not found';
    end if;
    select * into c from customers where id = e.customer_id;
  end if;
  if coalesce(c.name, nullif(btrim(p_customer_name), '')) is null then raise exception 'Enter the customer''s name'; end if;
  if p_scheduled_at < now() - interval '15 minutes' then raise exception 'Pick a time from now on'; end if;
  perform 1 from test_drive_vehicles where id = v.id for update;
  select to_char(t.scheduled_at at time zone 'Asia/Kolkata', 'HH24:MI') || ' with ' || t.customer_name into v_clash
  from test_drives t
  where t.vehicle_id = v.id and t.status in ('scheduled', 'out')
    and tstzrange(t.scheduled_at, t.scheduled_at + make_interval(mins => t.duration_min))
        && tstzrange(p_scheduled_at, p_scheduled_at + make_interval(mins => coalesce(p_duration_min, 30)))
  limit 1;
  if v_clash is not null then raise exception 'The car is already booked at %', v_clash; end if;
  insert into test_drives (vehicle_id, enquiry_id, outlet_id, employee_id, customer_name, mobile, scheduled_at, duration_min,
                           location, created_by)
  values (v.id, e.id, v.outlet_id, coalesce(e.assigned_employee_id, current_employee_id()), coalesce(c.name, btrim(p_customer_name)),
          coalesce(c.mobile, normalize_mobile(p_mobile)), p_scheduled_at, coalesce(p_duration_min, 30), coalesce(p_location, 'showroom'),
          current_employee_id())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function test_drive_can_work(t test_drives)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select ops_can('test_drive', 'edit', t.outlet_id)
     and (is_branch_back_office(t.outlet_id) or can_access_employee_data(current_employee_id(), t.employee_id));
$$;

create or replace function start_test_drive(p_id uuid, p_dl_number text, p_start_km int, p_dl_photo_path text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t test_drives%rowtype;
begin
  select * into t from test_drives where id = p_id for update;
  if t.id is null or not test_drive_can_work(t) then raise exception 'Test drive not found'; end if;
  if t.status <> 'scheduled' then raise exception 'This test drive is not waiting to start'; end if;
  if nullif(btrim(p_dl_number), '') is null then raise exception 'Record the customer''s driving licence number'; end if;
  if p_start_km is null or p_start_km < 0 then raise exception 'Enter the odometer reading'; end if;
  if p_dl_photo_path is not null and p_dl_photo_path not like 'test-drive/' || t.id::text || '/%' then
    raise exception 'The licence photo must be stored with this test drive';
  end if;
  if exists (select 1 from test_drives where vehicle_id = t.vehicle_id and status = 'out') then
    raise exception 'This car is already out on a drive';
  end if;
  update test_drives set status = 'out', dl_number = upper(btrim(p_dl_number)), dl_photo_path = p_dl_photo_path,
    start_km = p_start_km, started_at = now()
  where id = t.id;
end;
$$;

create or replace function end_test_drive(p_id uuid, p_end_km int, p_rating int default null, p_feedback text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t test_drives%rowtype;
begin
  select * into t from test_drives where id = p_id for update;
  if t.id is null or not test_drive_can_work(t) then raise exception 'Test drive not found'; end if;
  if t.status <> 'out' then raise exception 'This test drive has not started'; end if;
  if p_end_km is null or p_end_km < t.start_km then raise exception 'The closing reading must be at least %', t.start_km; end if;
  if p_end_km - t.start_km > 300 then raise exception 'That is more than 300 km; check the reading'; end if;
  update test_drives set status = 'completed', end_km = p_end_km, ended_at = now(), rating = p_rating,
    feedback = nullif(btrim(p_feedback), '')
  where id = t.id;
  update test_drive_vehicles set odometer_km = greatest(coalesce(odometer_km, 0), p_end_km) where id = t.vehicle_id;
  if t.enquiry_id is not null then
    update enquiries set test_drive_given = true where id = t.enquiry_id;
  end if;
end;
$$;

create or replace function cancel_test_drive(p_id uuid, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t test_drives%rowtype;
begin
  select * into t from test_drives where id = p_id for update;
  if t.id is null or not test_drive_can_work(t) then raise exception 'Test drive not found'; end if;
  if t.status <> 'scheduled' then raise exception 'Only a booked test drive can be cancelled'; end if;
  if p_status not in ('cancelled', 'no_show') then raise exception 'Status must be cancelled or no_show'; end if;
  update test_drives set status = p_status, cancel_reason = nullif(btrim(p_reason), '') where id = t.id;
end;
$$;

create or replace function test_drive_schedule(p_date date default null, p_outlet_id uuid default null)
returns table (id uuid, vehicle_id uuid, reg_no text, vehicle text, outlet text, customer_name text, mobile text, consultant text,
               scheduled_at timestamptz, duration_min int, location text, status text, start_km int, end_km int, rating int,
               feedback text, enquiry_id uuid)
language sql
stable
security invoker
set search_path = public
as $$
  select t.id, v.id, v.reg_no, coalesce(m.name || ' ' || va.name, m.name, va.name), o.name, t.customer_name, t.mobile, e.name,
         t.scheduled_at, t.duration_min, t.location, t.status, t.start_km, t.end_km, t.rating, t.feedback, t.enquiry_id
  from test_drives t
  join test_drive_vehicles v on v.id = t.vehicle_id
  join outlets o on o.id = t.outlet_id
  left join variants va on va.id = v.variant_id
  left join models m on m.id = coalesce(v.model_id, va.model_id)
  left join employees e on e.id = t.employee_id
  where (t.scheduled_at at time zone 'Asia/Kolkata')::date = coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date)
    and (p_outlet_id is null or t.outlet_id = p_outlet_id)
  order by v.reg_no, t.scheduled_at;
$$;

-- ===== RM console =====
alter table bookings add column rm_employee_id uuid references employees(id), add column rm_assigned_at timestamptz;
create index idx_bookings_rm on bookings(rm_employee_id);
create policy bookings_select_rm on bookings for select to authenticated using (rm_employee_id = current_employee_id());

create table booking_notes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  author_id uuid not null references employees(id),
  kind text not null default 'note' check (kind in ('note', 'call', 'whatsapp', 'visit', 'email')),
  body text not null,
  created_at timestamptz not null default now()
);
create index idx_booking_notes_booking on booking_notes(booking_id, created_at);
create index idx_booking_notes_author on booking_notes(author_id);

create table booking_customer_requests (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  kind text not null check (kind in ('delivery_date', 'accessories', 'finance', 'documents', 'colour_variant_change', 'cancellation', 'other')),
  detail text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'rejected')),
  created_by uuid references employees(id),
  created_at timestamptz not null default now(),
  resolved_by uuid references employees(id),
  resolved_at timestamptz,
  resolution text
);
create index idx_booking_requests_booking on booking_customer_requests(booking_id);
create index idx_booking_requests_status on booking_customer_requests(status);
create index idx_booking_requests_created_by on booking_customer_requests(created_by);
create index idx_booking_requests_resolved_by on booking_customer_requests(resolved_by);

alter table booking_notes enable row level security;
alter table booking_customer_requests enable row level security;
create policy booking_notes_select on booking_notes for select to authenticated using (can_access_booking(booking_id));
create policy booking_customer_requests_select on booking_customer_requests for select to authenticated using (can_access_booking(booking_id));

-- Who works a booking after it is made: its consultant line, the branch back office, or its RM.
create or replace function can_work_booking_rm(b bookings)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select can_handle_booking(b) or b.rm_employee_id = current_employee_id();
$$;

create or replace function rm_assign_booking(p_booking_id uuid, p_rm_employee_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = p_booking_id for update;
  if b.id is null or not ops_can('rm_assign', 'edit', b.outlet_id) then raise exception 'Booking not found'; end if;
  if p_rm_employee_id is not null and not exists (
       select 1 from employees e join roles r on r.id = e.role_id
       where e.id = p_rm_employee_id and e.is_active and (e.outlet_id = b.outlet_id or r.rank <= 1)
         and (r.name = 'Relationship Manager' or r.rank <= 3)) then
    raise exception 'Pick a Relationship Manager of this branch';
  end if;
  update bookings set rm_employee_id = p_rm_employee_id, rm_assigned_at = case when p_rm_employee_id is null then null else now() end
  where id = b.id;
end;
$$;

create or replace function add_booking_note(p_booking_id uuid, p_body text, p_kind text default 'note')
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
  if b.id is null or not can_work_booking_rm(b) then raise exception 'Booking not found'; end if;
  if nullif(btrim(p_body), '') is null then raise exception 'Write the note'; end if;
  insert into booking_notes (booking_id, author_id, kind, body) values (b.id, current_employee_id(), coalesce(p_kind, 'note'), btrim(p_body))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function raise_customer_request(p_booking_id uuid, p_kind text, p_detail text)
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
  if b.id is null or not can_work_booking_rm(b) then raise exception 'Booking not found'; end if;
  if nullif(btrim(p_detail), '') is null then raise exception 'Describe the request'; end if;
  insert into booking_customer_requests (booking_id, kind, detail, created_by) values (b.id, p_kind, btrim(p_detail), current_employee_id())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function update_customer_request(p_request_id uuid, p_status text, p_resolution text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r booking_customer_requests%rowtype;
  b bookings%rowtype;
begin
  select * into r from booking_customer_requests where id = p_request_id for update;
  if r.id is null then raise exception 'Request not found'; end if;
  select * into b from bookings where id = r.booking_id;
  if not can_work_booking_rm(b) then raise exception 'Request not found'; end if;
  if p_status not in ('in_progress', 'done', 'rejected') then raise exception 'Status must be in_progress, done or rejected'; end if;
  if p_status in ('done', 'rejected') and nullif(btrim(p_resolution), '') is null then raise exception 'Say what was done'; end if;
  update booking_customer_requests set status = p_status, resolution = coalesce(nullif(btrim(p_resolution), ''), resolution),
    resolved_by = case when p_status in ('done', 'rejected') then current_employee_id() end,
    resolved_at = case when p_status in ('done', 'rejected') then now() end
  where id = r.id;
end;
$$;

-- Where a booking is stuck, first match wins:
--   on_hold, docket (Welcome Docket not complete), finance (loan not at DO yet), allotment (no car),
--   billing (car allotted, not sent for billing), ops (sent for billing, ops stages open), ready (gate pass / all done)
create or replace function rm_bucket(b bookings)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from booking_holds h where h.booking_id = b.id and h.resumed_at is null) then 'on_hold'
    when not exists (select 1 from welcome_dockets w where w.booking_id = b.id and w.status = 'complete') then 'docket'
    when exists (select 1 from finance_cases f where f.booking_id = b.id and f.status in ('docs_pending', 'logged_in', 'sanctioned')) then 'finance'
    when not exists (select 1 from allotments a where a.booking_id = b.id and a.released_at is null) then 'allotment'
    when not exists (select 1 from billing_requests r where r.booking_id = b.id and r.status in ('pending', 'invoiced')) then 'billing'
    when exists (select 1 from ops_stage_status(b.id) s where s.stage <> 'gate_pass' and s.status not in ('done', 'na')) then 'ops'
    else 'ready'
  end;
$$;

-- Open bookings (not delivered or cancelled) the caller works as RM, or (back office) all at their
-- branch; p_rm narrows to one RM, 'none' to unassigned.
create or replace function rm_pipeline(p_bucket text default null, p_rm text default null)
returns table (booking_id uuid, customer_name text, mobile text, order_no text, booked_on date, outlet text, consultant text,
               rm text, rm_employee_id uuid, model text, variant text, color text, bucket text, open_requests int,
               open_tasks int, last_note_at timestamptz, delivery_slot text, likely_delivery_date date)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not has_right('rm_console', 'view') then raise exception 'You do not have access to the RM console'; end if;
  return query
  select * from (
    select b.id, b.customer_name, coalesce(c.mobile, b.customer_mobile), coalesce(b.ctdms_order_booking_no, b.order_booking_no),
           coalesce(b.ctdms_order_date, b.created_at::date), o.name, e.name, rm.name, b.rm_employee_id, mo.name, va.name, co.name,
           rm_bucket(b),
           (select count(*)::int from booking_customer_requests q where q.booking_id = b.id and q.status in ('open', 'in_progress')),
           (select count(*)::int from tasks t where t.booking_id = b.id and t.status = 'open'),
           (select max(n.created_at) from booking_notes n where n.booking_id = b.id),
           (select to_char(ds.slot_date, 'DD Mon') || ' ' || ds.slot_time from delivery_slots ds where ds.booking_id = b.id and ds.status = 'booked'),
           b.likely_delivery_date
    from bookings b
    join outlets o on o.id = b.outlet_id
    left join customers c on c.id = b.customer_id
    left join employees e on e.id = b.employee_id
    left join employees rm on rm.id = b.rm_employee_id
    left join variants va on va.id = b.variant_id
    left join models mo on mo.id = va.model_id
    left join colors co on co.id = b.color_id
    where b.status not in ('delivered', 'cancelled')
      and (b.rm_employee_id = current_employee_id()
           or (has_right('rm_assign', 'view') and ops_branch_ok(b.outlet_id)))
      and (p_rm is null or (p_rm = 'none' and b.rm_employee_id is null) or b.rm_employee_id::text = p_rm)
  ) x(booking_id, customer_name, mobile, order_no, booked_on, outlet, consultant, rm, rm_employee_id, model, variant, color, bucket,
      open_requests, open_tasks, last_note_at, delivery_slot, likely_delivery_date)
  where p_bucket is null or x.bucket = p_bucket
  order by x.booked_on;
end;
$$;

create or replace function rm_pipeline_counts(p_rm text default null)
returns table (bucket text, bookings int)
language sql
stable
security definer
set search_path = public
as $$
  select p.bucket, count(*)::int from rm_pipeline(null, p_rm) p group by p.bucket;
$$;

-- Everything about one booking for the RM's Booking 360 page.
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
                where f.booking_id = b.id and f.status <> 'rejected' order by f.created_at desc limit 1),
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

-- RMs (and back office) of a branch, for assignment.
create or replace function rm_candidates(p_outlet_id uuid)
returns table (id uuid, name text, role text, open_bookings int)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.name, r.name,
         (select count(*)::int from bookings b where b.rm_employee_id = e.id and b.status not in ('delivered', 'cancelled'))
  from employees e join roles r on r.id = e.role_id
  where e.is_active and (r.name = 'Relationship Manager' or r.rank between 2 and 3)
    and e.outlet_id = p_outlet_id and has_right('rm_assign', 'view')
  order by r.name = 'Relationship Manager' desc, e.name;
$$;

-- ===== Reports =====
create or replace function walkin_conversion(p_from date, p_to date, p_outlet_id uuid default null)
returns table (outlet text, walkins int, visitors int, attended int, converted int, left_unattended int, booked int,
               avg_wait_min int)
language sql
stable
security invoker
set search_path = public
as $$
  select o.name, count(*)::int, sum(w.visitors)::int, count(*) filter (where w.status in ('attended', 'converted'))::int,
         count(*) filter (where w.enquiry_id is not null)::int, count(*) filter (where w.status = 'left')::int,
         count(*) filter (where exists (select 1 from enquiries e where e.id = w.enquiry_id and e.stage = 'booked'))::int,
         (avg(extract(epoch from w.attended_at - w.visited_at) / 60) filter (where w.attended_at is not null))::int
  from showroom_walkins w join outlets o on o.id = w.outlet_id
  where (w.visited_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    and (p_outlet_id is null or w.outlet_id = p_outlet_id)
  group by o.name
  order by o.name;
$$;

-- Per consultant: follow-ups logged, how many were on time (logged on or before the due day), and
-- open enquiries now overdue.
create or replace function followup_compliance(p_from date, p_to date, p_outlet_id uuid default null)
returns table (employee_id uuid, employee text, outlet text, logged int, on_time int, late int, overdue_now int, open_enquiries int)
language sql
stable
security invoker
set search_path = public
as $$
  with mine as (
    select e.id, e.name, o.name as outlet
    from employees e left join outlets o on o.id = e.outlet_id
    where e.is_active and can_access_employee_data(current_employee_id(), e.id)
      and (p_outlet_id is null or e.outlet_id = p_outlet_id)
      and exists (select 1 from enquiries q where q.assigned_employee_id = e.id)
  )
  select m.id, m.name, m.outlet,
         (select count(*)::int from enquiry_followups f where f.employee_id = m.id
            and (f.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
         (select count(*)::int from enquiry_followups f where f.employee_id = m.id
            and (f.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
            and (f.due_at is null or (f.created_at at time zone 'Asia/Kolkata')::date <= (f.due_at at time zone 'Asia/Kolkata')::date)),
         (select count(*)::int from enquiry_followups f where f.employee_id = m.id
            and (f.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
            and (f.created_at at time zone 'Asia/Kolkata')::date > (f.due_at at time zone 'Asia/Kolkata')::date),
         (select count(*)::int from enquiries q where q.assigned_employee_id = m.id and q.stage in ('open', 'quoted')
            and q.next_followup_at < date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
         (select count(*)::int from enquiries q where q.assigned_employee_id = m.id and q.stage in ('open', 'quoted'))
  from mine m
  order by 7 desc, 2;
$$;

-- ===== Grants =====
do $$
declare
  f text;
begin
  foreach f in array array[
    'log_followup(uuid, text, text, text, timestamptz, text)', 'my_followups(text, uuid)', 'enquiry_followup_history(uuid)',
    'create_task(text, uuid, timestamptz, text, text, uuid, uuid)', 'complete_task(uuid, text, text)', 'my_tasks(text, uuid)',
    'record_walkin(jsonb)', 'assign_walkin(uuid, uuid)', 'attend_walkin(uuid, jsonb)', 'close_walkin(uuid, text)',
    'walkin_register(date, uuid)', 'save_test_drive_vehicle(uuid, jsonb)',
    'schedule_test_drive(uuid, timestamptz, uuid, text, text, int, text)', 'start_test_drive(uuid, text, int, text)',
    'end_test_drive(uuid, int, int, text)', 'cancel_test_drive(uuid, text, text)', 'test_drive_schedule(date, uuid)',
    'rm_assign_booking(uuid, uuid)', 'add_booking_note(uuid, text, text)', 'raise_customer_request(uuid, text, text)',
    'update_customer_request(uuid, text, text)', 'rm_pipeline(text, text)', 'rm_pipeline_counts(text)',
    'rm_booking_detail(uuid)', 'rm_candidates(uuid)', 'walkin_conversion(date, date, uuid)', 'followup_compliance(date, date, uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke execute on function enquiries_default_followup() from public, anon, authenticated;
revoke execute on function test_drive_can_work(test_drives) from public, anon, authenticated;
revoke execute on function can_work_booking_rm(bookings) from public, anon, authenticated;
revoke execute on function rm_bucket(bookings) from public, anon, authenticated;

-- Sales staff of a branch, for the front desk's "hand to" list and test drive bookings.
create or replace function branch_consultants(p_outlet_id uuid default null)
returns table (id uuid, name text, role text, waiting int)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.name, r.name,
         (select count(*)::int from showroom_walkins w where w.assigned_employee_id = e.id and w.status = 'waiting')
  from employees e join roles r on r.id = e.role_id
  where e.is_active and r.rank between 2 and 5
    and e.outlet_id = coalesce(p_outlet_id, current_employee_outlet_id())
    and (has_right('reception', 'view') or has_right('test_drive', 'view') or has_right('tasks', 'create'))
    and ops_branch_ok(e.outlet_id)
  order by r.rank desc, e.name;
$$;
revoke execute on function branch_consultants(uuid) from public, anon;
grant execute on function branch_consultants(uuid) to authenticated;
