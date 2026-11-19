-- Phase 33: used cars and reception (Techwheels' used-car deal flow, inspection, stock documents and
-- outside-car procurement; the reception kiosk with tokens and the CTDMS enquiry-number queue).
--
-- Used cars
--   Source       where the car came from: enquiry, walk-in, quote, booking or outside (procurement lead).
--   Deal status  separate from the evaluation's own status: pending → offered → negotiating → deal_done /
--                no_deal. Offer and asking price are each ≥ 0; an offer is "communicated" only once there is
--                one. No deal needs a reason; a closed evaluation can be reopened unless the registration
--                is open elsewhere or already in our stock.
--   Refurbishment  set by the office (Outlet Head), never by the evaluator who valued the car.
--   Inspection   checklist 1–18 (finding none / suspected / confirmed), interior 1–4, damage 1–8, 8 red
--                flags; the car is accidental when any finding or red flag says so, unless overridden with a
--                reason. Saved as a draft until final.
--   Documents    9 slots per stock car; Form 35, NOC and challan can be marked not applicable. Documents
--                never block stock-in.
--   Stock        stock-in only after the deal is done (an outside car: after the purchase is approved);
--                stock-out needs B2B / B2C, buyer and amount; reverting either needs used_car_stock approve.
--   Outside      procurement leads: not_evaluated → evaluated → under_negotiation → purchase_approved →
--                purchased / lost (reason).
-- Reception
--   Kiosk        tokens 'T' + 3 digits per branch per day; a returning customer is recognised by mobile.
--   Qualifiers   fuel types, exchange (creates the evaluation request), finance required + financier,
--                model segment.
--   CTDMS queue  every converted walk-in waits until its enquiry has a CTDMS enquiry number (typed in, or
--                filled by the daily CTDMS enquiry report); a closure request with a reason takes it out.
--   Follow-up    for walk-ins that left without converting; a team walk-in report with CTDMS compliance.

-- ===== Modules and rights =====
insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('used_car_exchange', 'used', 'Exchange Business',    '/used-cars/exchange',     5, true),
  ('kiosk',             'crm',  'Reception Kiosk',      '/kiosk',                 31, true),
  ('reception_ctdms',   'crm',  'CTDMS Enquiry Queue',  '/reception/ctdms-queue', 32, true);

select seed_role_rights(r, m, x) from (values
  ('Outlet Head', 'used_car_exchange', array['view','create','edit','approve']), ('Outlet Head', 'used_car_stock', array['approve']),
  ('Head Customer Relations', 'used_car_exchange', array['view','create']),
  ('Team Leader', 'used_car_exchange', array['view','create']),
  ('Sales Consultant', 'used_car_exchange', array['view','create']),
  ('Used Car Evaluator', 'used_car_exchange', array['view','create','edit']),
  ('Outlet Head', 'kiosk', array['view','create']), ('Head Customer Relations', 'kiosk', array['view','create']),
  ('Receptionist', 'kiosk', array['view','create']),
  ('Outlet Head', 'reception_ctdms', array['view','create','edit','approve']),
  ('Head Customer Relations', 'reception_ctdms', array['view','create','edit','approve']),
  ('Team Leader', 'reception_ctdms', array['view','create']), ('Sales Consultant', 'reception_ctdms', array['view','create']),
  ('Receptionist', 'reception_ctdms', array['view','create'])
) v(r, m, x);

-- ======================================================================
-- USED CARS
-- ======================================================================
create table used_car_outside_leads (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references outlets(id),
  lead_source text not null check (lead_source in ('referral', 'online_portal', 'broker', 'walk_in', 'social_media', 'existing_customer', 'other')),
  seller_name text not null,
  seller_mobile text,
  reg_no text not null,
  make text not null default 'Toyota',
  model text not null,
  mfg_year int check (mfg_year between 1990 and 2100),
  odometer_km int check (odometer_km >= 0),
  expected_price numeric check (expected_price >= 0),
  status text not null default 'not_evaluated'
    check (status in ('not_evaluated', 'evaluated', 'under_negotiation', 'purchase_approved', 'purchased', 'lost')),
  lost_reason text check (lost_reason in ('price_gap', 'sold_elsewhere', 'seller_not_responding', 'documents_issue', 'car_condition', 'other')),
  lost_note text,
  evaluation_id uuid unique,
  approved_price numeric,
  approved_by uuid references employees(id),
  approved_at timestamptz,
  created_by uuid references employees(id),
  created_at timestamptz not null default now(),
  check (status <> 'lost' or lost_reason is not null)
);
create index idx_ucol_outlet_status on used_car_outside_leads(outlet_id, status);
create index idx_ucol_created_by on used_car_outside_leads(created_by);
create index idx_ucol_approved_by on used_car_outside_leads(approved_by);
alter table used_car_outside_leads enable row level security;
create policy ucol_select on used_car_outside_leads for select to authenticated using (ops_can('used_car_exchange', 'view', outlet_id));

alter table used_car_evaluations
  add column source text check (source in ('enquiry', 'walkin', 'quote', 'booking', 'outside')),
  add column quote_id uuid references quotes(id),
  add column walkin_id uuid references showroom_walkins(id),
  add column outside_lead_id uuid references used_car_outside_leads(id),
  add column deal_status text not null default 'pending' check (deal_status in ('pending', 'offered', 'negotiating', 'deal_done', 'no_deal')),
  add column offer_price numeric check (offer_price >= 0),
  add column asking_price numeric check (asking_price >= 0),
  add column offer_communicated_at timestamptz,
  add column no_deal_reason text check (no_deal_reason in ('price_gap', 'customer_retained', 'sold_elsewhere', 'documents_issue', 'car_condition', 'other')),
  add column refurb_required boolean,
  add column refurb_estimate numeric check (refurb_estimate >= 0),
  add column refurb_work text,
  add column refurb_set_by uuid references employees(id),
  add column refurb_set_at timestamptz,
  add column is_accidental boolean;
create index idx_uce_quote on used_car_evaluations(quote_id);
create index idx_uce_walkin on used_car_evaluations(walkin_id);
create index idx_uce_outside on used_car_evaluations(outside_lead_id);
create index idx_uce_refurb_set_by on used_car_evaluations(refurb_set_by);
alter table used_car_outside_leads add constraint fk_ucol_evaluation foreign key (evaluation_id) references used_car_evaluations(id);

update used_car_evaluations set
  source = case when booking_id is not null then 'booking' when enquiry_id is not null then 'enquiry' else 'walkin' end,
  deal_status = case status when 'negotiating' then 'negotiating' when 'accepted' then 'deal_done' when 'procured' then 'deal_done'
                            when 'rejected' then 'no_deal' when 'cancelled' then 'no_deal' else 'pending' end;

-- Deal status follows the evaluation's own status; the source is inferred when not given.
create or replace function used_car_evaluation_sync()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.source := coalesce(new.source, case when new.outside_lead_id is not null then 'outside' when new.booking_id is not null then 'booking'
                                            when new.quote_id is not null then 'quote' when new.walkin_id is not null then 'walkin'
                                            when new.enquiry_id is not null then 'enquiry' else 'walkin' end);
    return new;
  end if;
  if new.status is distinct from old.status then
    if new.status in ('accepted', 'procured') then
      new.deal_status := 'deal_done';
    elsif new.status in ('rejected', 'cancelled') then
      new.deal_status := 'no_deal';
    elsif old.status in ('rejected', 'cancelled') then
      new.deal_status := 'pending';
    elsif new.status = 'negotiating' and new.deal_status = 'pending' then
      new.deal_status := 'negotiating';
    end if;
  end if;
  return new;
end;
$$;
create trigger trg_uce_sync before insert or update of status on used_car_evaluations
  for each row execute function used_car_evaluation_sync();

-- An outside lead moves with its evaluation.
create or replace function used_car_outside_lead_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.outside_lead_id is null then return new; end if;
  update used_car_outside_leads l set status = case
      when new.status = 'procured' then 'purchased'
      when new.status in ('rejected', 'cancelled') then 'lost'
      when l.status = 'purchase_approved' then l.status
      when new.status = 'negotiating' or new.deal_status in ('offered', 'negotiating') then 'under_negotiation'
      when new.evaluator_price is not null then 'evaluated'
      else 'not_evaluated' end,
    lost_reason = case when new.status in ('rejected', 'cancelled') then coalesce(l.lost_reason, case new.no_deal_reason
                         when 'price_gap' then 'price_gap' when 'sold_elsewhere' then 'sold_elsewhere'
                         when 'documents_issue' then 'documents_issue' when 'car_condition' then 'car_condition' else 'other' end)
                       when new.status not in ('rejected', 'cancelled') then null else l.lost_reason end
  where l.id = new.outside_lead_id;
  return new;
end;
$$;
create trigger trg_uce_outside_sync after update on used_car_evaluations
  for each row when (new.outside_lead_id is not null) execute function used_car_outside_lead_sync();

-- Offer and asking price. The offer counts as communicated only when there is one.
create or replace function set_used_car_offer(p_id uuid, p_offer numeric, p_asking numeric default null, p_communicated boolean default false)
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
  if p_offer < 0 or p_asking < 0 then raise exception 'Prices cannot be negative'; end if;
  if p_communicated and coalesce(p_offer, e.offer_price) is null then raise exception 'Enter the offer before marking it communicated'; end if;
  if p_offer > e.evaluator_price * 1.05 and not ops_can('used_car_evaluations', 'approve', e.outlet_id) then
    raise exception 'An offer more than 5%% above the valuation (₹%) needs the Outlet Head', to_char(round(e.evaluator_price), 'FM99,99,99,999');
  end if;
  if p_offer is not null and p_offer is distinct from e.offer_price and p_offer > 0 then
    insert into used_car_negotiations (evaluation_id, side, amount, note, by_employee_id) values (e.id, 'dealer', p_offer, 'Offer', current_employee_id());
  end if;
  if p_asking is not null and p_asking is distinct from e.asking_price and p_asking > 0 then
    insert into used_car_negotiations (evaluation_id, side, amount, note, by_employee_id) values (e.id, 'customer', p_asking, 'Asking price', current_employee_id());
  end if;
  update used_car_evaluations set
    offer_price = coalesce(p_offer, offer_price),
    asking_price = coalesce(p_asking, asking_price),
    offer_communicated_at = case when p_communicated then coalesce(offer_communicated_at, now()) else offer_communicated_at end,
    deal_status = case
      when coalesce(p_asking, asking_price) is not null and (p_communicated or offer_communicated_at is not null)
           and coalesce(p_asking, asking_price) > coalesce(p_offer, offer_price) then 'negotiating'
      when p_communicated or offer_communicated_at is not null then 'offered'
      else deal_status end
  where id = e.id;
end;
$$;

-- No deal: closes the evaluation (rejected) with a reason code.
create or replace function mark_used_car_no_deal(p_id uuid, p_reason text, p_note text default null)
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
  if p_reason is null or p_reason not in ('price_gap', 'customer_retained', 'sold_elsewhere', 'documents_issue', 'car_condition', 'other') then
    raise exception 'Pick the reason';
  end if;
  if p_reason = 'other' and nullif(btrim(p_note), '') is null then raise exception 'Describe the reason'; end if;
  update used_car_evaluations set no_deal_reason = p_reason, status = 'rejected',
    close_reason = coalesce(nullif(btrim(p_note), ''), replace(p_reason, '_', ' ')), decided_at = now()
  where id = e.id;
end;
$$;

-- Reopen a closed (no-deal) evaluation.
create or replace function reopen_used_car_evaluation(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e used_car_evaluations%rowtype;
  v_reg text;
begin
  select * into e from used_car_evaluations where id = p_id for update;
  if e.id is null or not can_see_evaluation(e) then raise exception 'Evaluation not found'; end if;
  if e.status not in ('rejected', 'cancelled') then raise exception 'Only a closed evaluation can be reopened'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  v_reg := upper(replace(e.reg_no, ' ', ''));
  if exists (select 1 from used_car_evaluations x where x.id <> e.id and upper(replace(x.reg_no, ' ', '')) = v_reg
               and x.status in ('requested', 'evaluated', 'negotiating', 'accepted')) then
    raise exception 'This registration has another open evaluation';
  end if;
  if exists (select 1 from used_car_vehicles u where upper(replace(u.reg_no, ' ', '')) = v_reg and u.status not in ('sold', 'returned')) then
    raise exception 'This car is already in our used-car stock';
  end if;
  update used_car_evaluations set
    status = case when evaluator_price is not null then 'evaluated' else 'requested' end,
    no_deal_reason = null, decided_at = null,
    remarks = concat_ws(E'\n', remarks, 'Reopened: ' || btrim(p_reason))
  where id = e.id;
end;
$$;

-- Refurbishment is the office's call, not the evaluator's.
create or replace function set_used_car_refurbishment(p_id uuid, p_required boolean, p_estimate numeric default null, p_work text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e used_car_evaluations%rowtype;
begin
  select * into e from used_car_evaluations where id = p_id for update;
  if e.id is null or not ops_can('used_car_evaluations', 'approve', e.outlet_id) then
    raise exception 'Refurbishment is set by the office (Outlet Head)';
  end if;
  if e.evaluator_id = current_employee_id() then raise exception 'The evaluator of this car cannot set its refurbishment'; end if;
  if p_required is null then raise exception 'Say whether refurbishment is needed'; end if;
  if p_required and (coalesce(p_estimate, 0) <= 0 or nullif(btrim(p_work), '') is null) then
    raise exception 'Enter the estimate and the work needed';
  end if;
  update used_car_evaluations set refurb_required = p_required,
    refurb_estimate = case when p_required then p_estimate else 0 end,
    refurb_work = case when p_required then btrim(p_work) end,
    refurb_set_by = current_employee_id(), refurb_set_at = now()
  where id = e.id;
end;
$$;

-- ===== Structured inspection =====
create table used_car_inspections (
  evaluation_id uuid primary key references used_car_evaluations(id),
  checklist jsonb not null default '{}',    -- {"1": {"finding": "none|suspected|confirmed", "note": "…", "photo": "used-car/<id>/…"}, … "18"}
  interior jsonb not null default '{}',     -- {"1": {"photo": …, "note": …}, … "4"}
  damage jsonb not null default '{}',       -- {"1": {"photo": …, "note": …}, … "8"}
  red_flags text[] not null default '{}',
  is_draft boolean not null default true,
  computed_accidental boolean not null default false,
  accidental_override boolean not null default false,
  override_reason text,
  saved_by uuid references employees(id),
  saved_at timestamptz not null default now(),
  check (red_flags <@ array['flood_damage', 'fire_damage', 'chassis_repair', 'airbag_deployed', 'odometer_tampered',
                             'engine_replaced', 'pillar_repair', 'structural_damage']::text[]),
  check (not accidental_override or override_reason is not null)
);
create index idx_uci_saved_by on used_car_inspections(saved_by);
alter table used_car_inspections enable row level security;
create policy uci_select on used_car_inspections for select to authenticated
  using (exists (select 1 from used_car_evaluations e where e.id = evaluation_id));

create or replace function save_used_car_inspection(p_id uuid, p jsonb, p_final boolean default false)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  e used_car_evaluations%rowtype;
  v_check jsonb := coalesce(p->'checklist', '{}');
  v_int jsonb := coalesce(p->'interior', '{}');
  v_dmg jsonb := coalesce(p->'damage', '{}');
  v_flags text[] := coalesce(array(select jsonb_array_elements_text(p->'red_flags')), '{}');
  v_override boolean := coalesce((p->>'accidental_override')::boolean, false);
  v_reason text := nullif(btrim(p->>'override_reason'), '');
  v_computed boolean;
  k text;
  v jsonb;
begin
  select * into e from used_car_evaluations where id = p_id for update;
  if e.id is null or not ops_can('used_car_evaluations', 'edit', e.outlet_id) then raise exception 'Evaluation not found'; end if;
  if e.status in ('procured', 'rejected', 'cancelled') then raise exception 'This evaluation is closed'; end if;
  if exists (select 1 from used_car_inspections where evaluation_id = e.id and not is_draft) and not ops_can('used_car_evaluations', 'approve', e.outlet_id) then
    raise exception 'The inspection is final; the Outlet Head can change it';
  end if;
  for k, v in select * from jsonb_each(v_check) loop
    if k !~ '^([1-9]|1[0-8])$' then raise exception 'Checklist items are 1 to 18'; end if;
    if coalesce(v->>'finding', 'none') not in ('none', 'suspected', 'confirmed') then raise exception 'Finding must be none, suspected or confirmed'; end if;
  end loop;
  for k in select jsonb_object_keys(v_int) loop
    if k !~ '^[1-4]$' then raise exception 'Interior photos are 1 to 4'; end if;
  end loop;
  for k in select jsonb_object_keys(v_dmg) loop
    if k !~ '^[1-8]$' then raise exception 'Damage photos are 1 to 8'; end if;
  end loop;
  if exists (
    select 1 from (
      select x->>'photo' ph from jsonb_each(v_check) c(k, x) union all
      select x->>'photo' from jsonb_each(v_int) c(k, x) union all
      select x->>'photo' from jsonb_each(v_dmg) c(k, x)) s
    where ph is not null and ph not like 'used-car/' || e.id::text || '/%') then
    raise exception 'Photos must be stored with this evaluation';
  end if;
  if not v_flags <@ array['flood_damage', 'fire_damage', 'chassis_repair', 'airbag_deployed', 'odometer_tampered',
                          'engine_replaced', 'pillar_repair', 'structural_damage']::text[] then
    raise exception 'Unknown red flag';
  end if;
  if v_override and v_reason is null then raise exception 'Give the reason for overriding the accidental flag'; end if;
  if p_final and (select count(*) from jsonb_each(v_check) c(k, x) where x ? 'finding') < 18 then
    raise exception 'Answer all 18 checklist items before finalising';
  end if;
  v_computed := cardinality(v_flags) > 0 or exists (select 1 from jsonb_each(v_check) c(k, x) where x->>'finding' in ('suspected', 'confirmed'));
  insert into used_car_inspections as i (evaluation_id, checklist, interior, damage, red_flags, is_draft, computed_accidental,
                                         accidental_override, override_reason, saved_by, saved_at)
  values (e.id, v_check, v_int, v_dmg, v_flags, not p_final, v_computed, v_override, v_reason, current_employee_id(), now())
  on conflict (evaluation_id) do update set checklist = excluded.checklist, interior = excluded.interior, damage = excluded.damage,
    red_flags = excluded.red_flags, is_draft = excluded.is_draft, computed_accidental = excluded.computed_accidental,
    accidental_override = excluded.accidental_override, override_reason = excluded.override_reason,
    saved_by = excluded.saved_by, saved_at = excluded.saved_at;
  if p_final then
    update used_car_evaluations set is_accidental = v_computed and not v_override,
      accident_history = case when v_computed and not v_override then coalesce(accident_history, 'Accidental (inspection)') else accident_history end
    where id = e.id;
  end if;
  return v_computed and not v_override;
end;
$$;

-- ===== Stock documents (9 slots) =====
create table used_car_stock_documents (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references used_car_vehicles(id),
  slot text not null check (slot in ('form_29', 'form_30', 'form_35', 'noc', 'rto_mail', 'challan', 'aadhaar_front', 'aadhaar_back', 'pan')),
  storage_path text,
  not_applicable boolean not null default false,
  uploaded_by uuid references employees(id),
  uploaded_at timestamptz not null default now(),
  unique (vehicle_id, slot),
  check (not_applicable or storage_path is not null),
  check (not not_applicable or slot in ('form_35', 'noc', 'challan'))
);
create index idx_ucsd_uploaded_by on used_car_stock_documents(uploaded_by);
alter table used_car_stock_documents enable row level security;
create policy ucsd_select on used_car_stock_documents for select to authenticated
  using (exists (select 1 from used_car_vehicles u where u.id = vehicle_id));

create or replace function set_used_car_document(p_vehicle_id uuid, p_slot text, p_path text default null, p_not_applicable boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  u used_car_vehicles%rowtype;
begin
  select * into u from used_car_vehicles where id = p_vehicle_id;
  if u.id is null or not ops_can('used_car_stock', 'edit', u.outlet_id) then raise exception 'Car not found'; end if;
  if p_not_applicable and p_slot not in ('form_35', 'noc', 'challan') then raise exception 'Only Form 35, NOC and challan can be not applicable'; end if;
  if not p_not_applicable and (p_path is null or p_path not like 'used-car-stock/' || u.id::text || '/%') then
    raise exception 'Upload the document with this car';
  end if;
  insert into used_car_stock_documents (vehicle_id, slot, storage_path, not_applicable, uploaded_by)
  values (u.id, p_slot, case when p_not_applicable then null else p_path end, p_not_applicable, current_employee_id())
  on conflict (vehicle_id, slot) do update set storage_path = excluded.storage_path, not_applicable = excluded.not_applicable,
    uploaded_by = excluded.uploaded_by, uploaded_at = now();
end;
$$;

create or replace function used_car_document_status(p_vehicle_id uuid)
returns table (slot text, label text, storage_path text, not_applicable boolean, can_be_na boolean, done boolean)
language sql
stable
security invoker
set search_path = public
as $$
  select s.slot, s.label, d.storage_path, coalesce(d.not_applicable, false), s.slot in ('form_35', 'noc', 'challan'), d.id is not null
  from (values (1, 'form_29', 'Form 29'), (2, 'form_30', 'Form 30'), (3, 'form_35', 'Form 35'), (4, 'noc', 'NOC'), (5, 'rto_mail', 'RTO mail'),
               (6, 'challan', 'Challan clearance'), (7, 'aadhaar_front', 'Aadhaar (front)'), (8, 'aadhaar_back', 'Aadhaar (back)'), (9, 'pan', 'PAN')) s(n, slot, label)
  left join used_car_stock_documents d on d.vehicle_id = p_vehicle_id and d.slot = s.slot
  where exists (select 1 from used_car_vehicles u where u.id = p_vehicle_id)
  order by s.n;
$$;

-- Stock documents live in the used-car-photos bucket under used-car-stock/<car id>/.
create or replace function storage_used_stock_visible(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from used_car_vehicles u
    where (storage.foldername(p_name))[1] = 'used-car-stock'
      and u.id::text = (storage.foldername(p_name))[2]
      and ops_can('used_car_stock', 'view', u.outlet_id));
$$;
create policy used_car_stock_docs_select on storage.objects for select to authenticated using (
  bucket_id = 'used-car-photos' and storage_used_stock_visible(name));
create policy used_car_stock_docs_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'used-car-photos' and storage_used_stock_visible(name));

-- ===== Stock in / out =====
alter table used_car_vehicles
  add column sale_type text check (sale_type in ('B2B', 'B2C')),
  add column outside_lead_id uuid references used_car_outside_leads(id);
create index idx_ucv_outside on used_car_vehicles(outside_lead_id);

create table used_car_stock_events (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid,
  evaluation_id uuid references used_car_evaluations(id),
  event text not null check (event in ('stock_in_reverted', 'stock_out_reverted')),
  reason text not null,
  snapshot jsonb not null,
  by_employee_id uuid references employees(id),
  created_at timestamptz not null default now()
);
create index idx_ucse_evaluation on used_car_stock_events(evaluation_id);
create index idx_ucse_by on used_car_stock_events(by_employee_id);
alter table used_car_stock_events enable row level security;
create policy ucse_select on used_car_stock_events for select to authenticated
  using (exists (select 1 from used_car_evaluations e where e.id = evaluation_id));

-- An outside car is bought in only after the purchase is approved.
create or replace function used_car_vehicle_stock_in_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead uuid;
begin
  select outside_lead_id into v_lead from used_car_evaluations where id = new.evaluation_id;
  if v_lead is not null then
    if (select status from used_car_outside_leads where id = v_lead) <> 'purchase_approved' then
      raise exception 'The purchase of this outside car must be approved first';
    end if;
    new.outside_lead_id := v_lead;
  end if;
  return new;
end;
$$;
create trigger trg_ucv_stock_in before insert on used_car_vehicles for each row execute function used_car_vehicle_stock_in_check();

-- Selling now needs B2B / B2C (the rest as before).
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
  if v_status = 'sold' and coalesce(p->>'sale_type', '') not in ('B2B', 'B2C') then
    raise exception 'Say whether the sale is B2B or B2C';
  end if;
  if v_status = 'sold' and coalesce((p->>'sold_on')::date, (now() at time zone 'Asia/Kolkata')::date) > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'The date cannot be in the future';
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
    sale_type = case when v_status = 'sold' then p->>'sale_type' else sale_type end,
    buyer_name = coalesce(nullif(btrim(p->>'buyer_name'), ''), buyer_name),
    buyer_mobile = coalesce(normalize_mobile(p->>'buyer_mobile'), buyer_mobile),
    notes = coalesce(nullif(btrim(p->>'notes'), ''), notes),
    updated_at = now()
  where id = u.id;
end;
$$;

create or replace function revert_used_car_stock_out(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  u used_car_vehicles%rowtype;
begin
  select * into u from used_car_vehicles where id = p_id for update;
  if u.id is null or not ops_can('used_car_stock', 'approve', u.outlet_id) then raise exception 'Reverting a sale needs Used Car Stock: approve'; end if;
  if u.status <> 'sold' then raise exception 'This car has not been sold'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  insert into used_car_stock_events (vehicle_id, evaluation_id, event, reason, snapshot, by_employee_id)
  values (u.id, u.evaluation_id, 'stock_out_reverted', btrim(p_reason), to_jsonb(u), current_employee_id());
  update used_car_vehicles set status = case when listed_price is not null then 'listed' else 'in_stock' end,
    sold_price = null, sold_on = null, sale_type = null, buyer_name = null, buyer_mobile = null, updated_at = now()
  where id = u.id;
end;
$$;

-- Undo a stock-in: the car leaves stock, the exchange receipt (if any) is cancelled and the evaluation
-- goes back to deal done.
create or replace function revert_used_car_stock_in(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  u used_car_vehicles%rowtype;
  r payment_receipts%rowtype;
begin
  select * into u from used_car_vehicles where id = p_id for update;
  if u.id is null or not ops_can('used_car_stock', 'approve', u.outlet_id) then raise exception 'Reverting a stock-in needs Used Car Stock: approve'; end if;
  if u.status in ('sold', 'returned') then raise exception 'Revert the sale first'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Give the reason'; end if;
  if u.exchange_receipt_id is not null then
    select * into r from payment_receipts where id = u.exchange_receipt_id for update;
    if r.accounting_entry then raise exception 'The exchange receipt is entered in the accounts; take it out there first'; end if;
    if exists (select 1 from billing_requests b where b.booking_id = r.booking_id and b.status = 'invoiced') then
      raise exception 'The booking is invoiced with this exchange; it cannot be undone here';
    end if;
    update payment_receipts set clearance_status = 'cancelled', cancelled_at = now(), cancelled_by = current_employee_id(),
      cancel_reason = 'Used-car stock-in reverted: ' || btrim(p_reason)
    where id = r.id and clearance_status <> 'cancelled';
    insert into payment_receipt_events (receipt_id, event, detail) values (r.id, 'cancelled', jsonb_build_object('reason', 'used-car stock-in reverted'));
    perform pool_mark_booking_dirty(r.booking_id);
  end if;
  insert into used_car_stock_events (vehicle_id, evaluation_id, event, reason, snapshot, by_employee_id)
  values (u.id, u.evaluation_id, 'stock_in_reverted', btrim(p_reason), to_jsonb(u), current_employee_id());
  delete from used_car_stock_documents where vehicle_id = u.id;
  delete from used_car_vehicles where id = u.id;
  update used_car_evaluations set status = 'accepted' where id = u.evaluation_id;
  update used_car_outside_leads set status = 'purchase_approved' where id = u.outside_lead_id;
end;
$$;

-- ===== Outside-car procurement =====
create or replace function create_outside_lead(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet uuid := coalesce(nullif(p->>'outlet_id', '')::uuid, current_employee_outlet_id());
  v_lead uuid;
  v_eval uuid;
  v_reg text := upper(regexp_replace(btrim(coalesce(p->>'reg_no', '')), '\s+', ' ', 'g'));
begin
  if not ops_can('used_car_exchange', 'create', v_outlet) then raise exception 'You cannot add procurement leads at this branch'; end if;
  if v_reg = '' or nullif(btrim(p->>'model'), '') is null or nullif(btrim(p->>'seller_name'), '') is null then
    raise exception 'Enter the seller, registration number and model';
  end if;
  if coalesce((p->>'expected_price')::numeric, 0) < 0 then raise exception 'Prices cannot be negative'; end if;
  insert into used_car_outside_leads (outlet_id, lead_source, seller_name, seller_mobile, reg_no, make, model, mfg_year, odometer_km,
                                      expected_price, created_by)
  values (v_outlet, coalesce(nullif(p->>'lead_source', ''), 'other'), btrim(p->>'seller_name'), normalize_mobile(p->>'seller_mobile'), v_reg,
          coalesce(nullif(btrim(p->>'make'), ''), 'Toyota'), btrim(p->>'model'), nullif(p->>'mfg_year', '')::int,
          nullif(p->>'odometer_km', '')::int, nullif(p->>'expected_price', '')::numeric, current_employee_id())
  returning id into v_lead;
  -- The evaluation request goes to the branch's evaluator at once.
  insert into used_car_evaluations (outlet_id, customer_name, customer_mobile, reg_no, make, model, mfg_year, odometer_km,
                                    customer_expected, requested_by, source, outside_lead_id)
  values (v_outlet, btrim(p->>'seller_name'), normalize_mobile(p->>'seller_mobile'), v_reg, coalesce(nullif(btrim(p->>'make'), ''), 'Toyota'),
          btrim(p->>'model'), nullif(p->>'mfg_year', '')::int, nullif(p->>'odometer_km', '')::int, nullif(p->>'expected_price', '')::numeric,
          current_employee_id(), 'outside', v_lead)
  returning id into v_eval;
  update used_car_outside_leads set evaluation_id = v_eval where id = v_lead;
  return v_lead;
exception
  when unique_violation then raise exception 'This car already has an open evaluation';
end;
$$;

create or replace function approve_outside_purchase(p_lead_id uuid, p_price numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l used_car_outside_leads%rowtype;
  e used_car_evaluations%rowtype;
begin
  select * into l from used_car_outside_leads where id = p_lead_id for update;
  if l.id is null or not ops_can('used_car_exchange', 'approve', l.outlet_id) then raise exception 'Approving a purchase needs Exchange Business: approve'; end if;
  if l.status not in ('evaluated', 'under_negotiation') then raise exception 'Only an evaluated lead can be approved'; end if;
  if coalesce(p_price, 0) <= 0 then raise exception 'Enter the purchase price'; end if;
  select * into e from used_car_evaluations where id = l.evaluation_id for update;
  update used_car_outside_leads set status = 'purchase_approved', approved_price = p_price, approved_by = current_employee_id(), approved_at = now()
  where id = l.id;
  update used_car_evaluations set status = 'accepted', final_price = p_price, decided_at = now() where id = e.id;
end;
$$;

create or replace function mark_outside_lead_lost(p_lead_id uuid, p_reason text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l used_car_outside_leads%rowtype;
begin
  select * into l from used_car_outside_leads where id = p_lead_id for update;
  if l.id is null or not (ops_can('used_car_exchange', 'edit', l.outlet_id) or ops_can('used_car_exchange', 'approve', l.outlet_id)
                          or (ops_can('used_car_exchange', 'create', l.outlet_id) and can_access_employee_data(current_employee_id(), l.created_by))) then
    raise exception 'Lead not found';
  end if;
  if l.status in ('purchased', 'lost') then raise exception 'This lead is closed'; end if;
  if p_reason is null or p_reason not in ('price_gap', 'sold_elsewhere', 'seller_not_responding', 'documents_issue', 'car_condition', 'other') then
    raise exception 'Pick the reason';
  end if;
  update used_car_outside_leads set status = 'lost', lost_reason = p_reason, lost_note = nullif(btrim(p_note), '') where id = l.id;
  update used_car_evaluations set status = 'rejected', no_deal_reason = case when p_reason in ('price_gap', 'sold_elsewhere', 'documents_issue', 'car_condition') then p_reason else 'other' end,
    close_reason = coalesce(nullif(btrim(p_note), ''), replace(p_reason, '_', ' ')), decided_at = now()
  where id = l.evaluation_id and status not in ('procured', 'rejected', 'cancelled');
end;
$$;

-- ===== Enable exchange (back-fill on a quote or booking) =====
create or replace function enable_exchange(p_kind text, p_id uuid, p_car jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  q quotes%rowtype;
  v_eval uuid;
begin
  if p_kind = 'quote' then
    select * into q from quotes where id = p_id for update;
    if q.id is null or not can_access_employee_data(current_employee_id(), q.employee_id) then raise exception 'Quote not found'; end if;
    if exists (select 1 from used_car_evaluations where quote_id = q.id and status not in ('rejected', 'cancelled')) then
      raise exception 'This quote already has an exchange evaluation';
    end if;
    v_eval := request_evaluation(p_car || jsonb_build_object('enquiry_id', q.enquiry_id, 'customer_name', q.customer_name, 'customer_mobile', q.customer_mobile));
    update used_car_evaluations set quote_id = q.id, source = 'quote', outlet_id = q.outlet_id where id = v_eval;
    update quotes set exchange_interest = true where id = q.id;
  elsif p_kind = 'booking' then
    if exists (select 1 from used_car_evaluations where booking_id = p_id and status not in ('rejected', 'cancelled')) then
      raise exception 'This booking already has an exchange evaluation';
    end if;
    v_eval := request_evaluation(p_car || jsonb_build_object('booking_id', p_id));
  else
    raise exception 'Exchange can be enabled on a quote or a booking';
  end if;
  return v_eval;
end;
$$;

-- Exchange Business: evaluations by source, plus quotes and bookings that could still get an exchange.
create or replace function exchange_business(p_tab text, p_outlet_id uuid default null)
returns table (kind text, id uuid, ref_id uuid, outlet text, customer_name text, customer_mobile text, reg_no text, car text,
               status text, deal_status text, evaluator_price numeric, offer_price numeric, asking_price numeric, final_price numeric,
               refurb_required boolean, refurb_estimate numeric, is_accidental boolean, consultant text, created_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select 'evaluation', e.id, coalesce(e.booking_id, e.quote_id, e.walkin_id, e.outside_lead_id, e.enquiry_id), o.name, e.customer_name,
         e.customer_mobile, e.reg_no, concat_ws(' ', e.make, e.model, e.variant), e.status, e.deal_status, e.evaluator_price, e.offer_price,
         e.asking_price, e.final_price, e.refurb_required, e.refurb_estimate, e.is_accidental, rq.name, e.requested_at
  from used_car_evaluations e
  join outlets o on o.id = e.outlet_id
  left join employees rq on rq.id = e.requested_by
  where p_tab <> 'enable' and (p_tab = 'all' or e.source = p_tab or (p_tab = 'walkin' and e.source = 'enquiry'))
    and (p_outlet_id is null or e.outlet_id = p_outlet_id)
  union all
  select 'quote', q.id, q.id, o.name, q.customer_name, q.customer_mobile, null, m.name, q.status, null, null, null, null, null, null, null, null,
         emp.name, q.created_at
  from quotes q
  join outlets o on o.id = q.outlet_id
  join employees emp on emp.id = q.employee_id
  left join variants v on v.id = q.variant_id
  left join models m on m.id = v.model_id
  where p_tab = 'enable' and q.created_at > now() - interval '60 days'
    and not exists (select 1 from used_car_evaluations e where e.quote_id = q.id or (e.enquiry_id is not null and e.enquiry_id = q.enquiry_id))
    and (p_outlet_id is null or q.outlet_id = p_outlet_id)
  union all
  select 'booking', b.id, b.id, o.name, b.customer_name, b.customer_mobile, null, m.name, b.status, null, null, null, null, null, null, null, null,
         emp.name, b.created_at
  from bookings b
  join outlets o on o.id = b.outlet_id
  join employees emp on emp.id = b.employee_id
  left join variants v on v.id = b.variant_id
  left join models m on m.id = v.model_id
  where p_tab = 'enable' and b.status not in ('delivered', 'cancelled')
    and not exists (select 1 from used_car_evaluations e where e.booking_id = b.id)
    and (p_outlet_id is null or b.outlet_id = p_outlet_id)
  order by 19 desc;
$$;

-- ======================================================================
-- RECEPTION
-- ======================================================================
alter table showroom_walkins
  add column visit_date date not null default (now() at time zone 'Asia/Kolkata')::date,
  add column token_no text,
  add column via_kiosk boolean not null default false,
  add column visit_no int not null default 1,
  add column fuel_types text[] not null default '{}',
  add column has_exchange boolean not null default false,
  add column exchange_evaluation_id uuid references used_car_evaluations(id),
  add column finance_required boolean,
  add column financier_id uuid references financiers(id),
  add column model_segment text,
  add column followup_at timestamptz,
  add column followup_note text,
  add column followup_done_at timestamptz,
  add column ctdms_submitted_by uuid references employees(id),
  add column ctdms_submitted_at timestamptz,
  add constraint walkin_financier_needs_finance check (financier_id is null or finance_required),
  add constraint walkin_fuel_types check (fuel_types <@ array['Petrol', 'Diesel', 'CNG', 'Hybrid', 'EV']::text[]);
update showroom_walkins set visit_date = (visited_at at time zone 'Asia/Kolkata')::date;
create unique index uq_walkin_token on showroom_walkins(outlet_id, visit_date, token_no) where token_no is not null;
create index idx_walkins_exchange_eval on showroom_walkins(exchange_evaluation_id);
create index idx_walkins_financier on showroom_walkins(financier_id);
create index idx_walkins_ctdms_by on showroom_walkins(ctdms_submitted_by);
create index idx_walkins_mobile on showroom_walkins(mobile);

-- Recognise a returning customer at the kiosk.
create or replace function kiosk_detect_returning(p_mobile text)
returns table (visits int, last_visit timestamptz, last_name text, last_consultant_id uuid, last_consultant text, last_model_id uuid,
               open_enquiry_owner text)
language sql
stable
security definer
set search_path = public
as $$
  with m as (select normalize_mobile(p_mobile) mob),
  w as (
    select w.* from showroom_walkins w, m
    where w.mobile = m.mob and ops_can('kiosk', 'create', w.outlet_id)
  )
  select (select count(*)::int from w),
         (select max(visited_at) from w),
         (select customer_name from w order by visited_at desc limit 1),
         (select assigned_employee_id from w order by visited_at desc limit 1),
         (select e.name from w join employees e on e.id = w.assigned_employee_id order by w.visited_at desc limit 1),
         (select model_id from w where model_id is not null order by visited_at desc limit 1),
         (select emp.name from enquiries e join customers c on c.id = e.customer_id join employees emp on emp.id = e.assigned_employee_id, m
          where c.mobile = m.mob and e.stage in ('open', 'quoted') order by e.created_at desc limit 1)
  where has_right('kiosk', 'create');
$$;

-- Fuel types, exchange, finance and segment on a walk-in. An exchange creates the evaluation request.
create or replace function set_walkin_qualifiers(p_walkin_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  w showroom_walkins%rowtype;
  v_eval uuid;
  v_fin boolean := (p->>'finance_required')::boolean;
  v_financier uuid := nullif(p->>'financier_id', '')::uuid;
begin
  select * into w from showroom_walkins where id = p_walkin_id for update;
  if w.id is null or not (ops_can('reception', 'create', w.outlet_id) or ops_can('kiosk', 'create', w.outlet_id)
                          or (w.assigned_employee_id is not null and can_access_employee_data(current_employee_id(), w.assigned_employee_id))) then
    raise exception 'Walk-in not found';
  end if;
  if v_financier is not null and not coalesce(v_fin, w.finance_required, false) then raise exception 'Pick a financier only when finance is needed'; end if;
  if coalesce((p->>'has_exchange')::boolean, false) and w.exchange_evaluation_id is null then
    if nullif(btrim(p->>'exchange_reg_no'), '') is null or nullif(btrim(p->>'exchange_model'), '') is null then
      raise exception 'Enter the exchange car''s registration number and model';
    end if;
    insert into used_car_evaluations (outlet_id, enquiry_id, customer_name, customer_mobile, reg_no, make, model, mfg_year,
                                      requested_by, source, walkin_id)
    values (w.outlet_id, w.enquiry_id, w.customer_name, w.mobile, upper(regexp_replace(btrim(p->>'exchange_reg_no'), '\s+', ' ', 'g')),
            coalesce(nullif(btrim(p->>'exchange_make'), ''), 'Toyota'), btrim(p->>'exchange_model'), nullif(p->>'exchange_year', '')::int,
            current_employee_id(), 'walkin', w.id)
    on conflict do nothing
    returning id into v_eval;
    if v_eval is null then
      select id into v_eval from used_car_evaluations
      where upper(replace(reg_no, ' ', '')) = upper(replace(p->>'exchange_reg_no', ' ', '')) and status in ('requested', 'evaluated', 'negotiating', 'accepted');
    end if;
  end if;
  update showroom_walkins set
    fuel_types = case when p ? 'fuel_types' then array(select jsonb_array_elements_text(p->'fuel_types')) else fuel_types end,
    has_exchange = coalesce((p->>'has_exchange')::boolean, has_exchange),
    exchange_evaluation_id = coalesce(v_eval, exchange_evaluation_id),
    finance_required = coalesce(v_fin, finance_required),
    financier_id = case when coalesce(v_fin, finance_required) then coalesce(v_financier, financier_id) end,
    model_segment = coalesce(nullif(btrim(p->>'model_segment'), ''), model_segment,
                             (select segment from models where id = coalesce(nullif(p->>'model_id', '')::uuid, w.model_id))),
    model_id = coalesce(nullif(p->>'model_id', '')::uuid, model_id)
  where id = w.id;
exception
  when check_violation then raise exception 'Fuel types must be Petrol, Diesel, CNG, Hybrid or EV';
end;
$$;

-- The kiosk: one call records the visit, its qualifiers and the token.
create or replace function kiosk_create_walkin(p jsonb)
returns table (walkin_id uuid, token_no text, consultant text, visit_no int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet uuid := coalesce(nullif(p->>'outlet_id', '')::uuid, current_employee_outlet_id());
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_id uuid;
  v_token text;
  v_visits int;
begin
  if not ops_can('kiosk', 'create', v_outlet) then raise exception 'This login cannot use the kiosk at this branch'; end if;
  if normalize_mobile(p->>'mobile') is null then raise exception 'Enter a valid 10-digit mobile number'; end if;
  if nullif(btrim(p->>'customer_name'), '') is null then raise exception 'Enter your name'; end if;
  if nullif(p->>'assigned_employee_id', '') is not null
     and not exists (select 1 from employees where id = (p->>'assigned_employee_id')::uuid and is_active and outlet_id = v_outlet) then
    raise exception 'Pick a consultant of this branch';
  end if;
  -- One token sequence per branch per day.
  perform pg_advisory_xact_lock(hashtext('kiosk_token:' || v_outlet::text || v_today::text));
  select 'T' || lpad((coalesce(max(substr(w.token_no, 2)::int), 0) + 1)::text, 3, '0') into v_token
  from showroom_walkins w where w.outlet_id = v_outlet and w.visit_date = v_today and w.token_no ~ '^T[0-9]+$';
  select count(*)::int + 1 into v_visits from showroom_walkins w where w.mobile = normalize_mobile(p->>'mobile');

  insert into showroom_walkins (outlet_id, customer_name, mobile, visitors, purpose, model_id, source, assigned_employee_id, enquiry_id,
                                notes, recorded_by, token_no, via_kiosk, visit_no)
  select v_outlet, btrim(p->>'customer_name'), normalize_mobile(p->>'mobile'), coalesce((p->>'visitors')::int, 1),
         coalesce(nullif(p->>'purpose', ''), 'new_purchase'), nullif(p->>'model_id', '')::uuid, 'Kiosk',
         coalesce(oe.assigned_employee_id, nullif(p->>'assigned_employee_id', '')::uuid), oe.id, nullif(btrim(p->>'notes'), ''),
         current_employee_id(), v_token, true, v_visits
  from (select null) x
  left join lateral (
    select e.id, e.assigned_employee_id from enquiries e join customers c on c.id = e.customer_id join employees emp on emp.id = e.assigned_employee_id
    where c.mobile = normalize_mobile(p->>'mobile') and e.stage in ('open', 'quoted') and emp.is_active
    order by e.created_at desc limit 1) oe on true
  returning id into v_id;

  perform set_walkin_qualifiers(v_id, p);
  return query select v_id, v_token, (select e.name from showroom_walkins w join employees e on e.id = w.assigned_employee_id where w.id = v_id), v_visits;
end;
$$;

-- ===== CTDMS enquiry-number queue =====
create table walkin_ctdms_closures (
  id uuid primary key default gen_random_uuid(),
  walkin_id uuid not null references showroom_walkins(id),
  reason text not null check (reason in ('not_interested', 'bought_elsewhere', 'price_issue', 'unreachable', 'duplicate', 'other')),
  note text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by uuid references employees(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references employees(id),
  decided_at timestamptz,
  decision_note text,
  check (reason <> 'other' or note is not null)
);
create unique index uq_wcc_pending on walkin_ctdms_closures(walkin_id) where status in ('pending', 'approved');
create index idx_wcc_requested_by on walkin_ctdms_closures(requested_by);
create index idx_wcc_decided_by on walkin_ctdms_closures(decided_by);
alter table walkin_ctdms_closures enable row level security;
create policy wcc_select on walkin_ctdms_closures for select to authenticated
  using (exists (select 1 from showroom_walkins w where w.id = walkin_id));

create or replace function walkin_ctdms_queue(p_outlet_id uuid default null)
returns table (walkin_id uuid, visited_at timestamptz, outlet text, customer_name text, mobile text, model text, consultant text,
               enquiry_id uuid, crm_sync_status text, days_waiting int, closure_id uuid, closure_status text, closure_reason text, closure_note text)
language sql
stable
security definer
set search_path = public
as $$
  select w.id, w.visited_at, o.name, w.customer_name, w.mobile, m.name, emp.name, e.id, e.crm_sync_status,
         ((now() at time zone 'Asia/Kolkata')::date - w.visit_date)::int, c.id, c.status, c.reason, c.note
  from showroom_walkins w
  join enquiries e on e.id = w.enquiry_id
  join outlets o on o.id = w.outlet_id
  left join models m on m.id = coalesce(w.model_id, e.model_id)
  left join employees emp on emp.id = w.assigned_employee_id
  left join walkin_ctdms_closures c on c.walkin_id = w.id and c.status in ('pending', 'approved')
  where w.status = 'converted' and e.ctdms_enquiry_no is null and coalesce(c.status, '') <> 'approved'
    and (p_outlet_id is null or w.outlet_id = p_outlet_id)
    and ops_can('reception_ctdms', 'view', w.outlet_id)
    and (has_right('reception_ctdms', 'edit') or ops_can('reception', 'create', w.outlet_id)
         or can_access_employee_data(current_employee_id(), w.assigned_employee_id))
  order by w.visited_at;
$$;

create or replace function submit_ctdms_enquiry_no(p_walkin_id uuid, p_ctdms_no text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  w showroom_walkins%rowtype;
  v_no text := upper(nullif(btrim(p_ctdms_no), ''));
begin
  select * into w from showroom_walkins where id = p_walkin_id for update;
  if w.id is null or not ops_can('reception_ctdms', 'edit', w.outlet_id) then raise exception 'Entering CTDMS numbers needs CTDMS Enquiry Queue: edit'; end if;
  if w.enquiry_id is null then raise exception 'This walk-in has no enquiry'; end if;
  if v_no is null or v_no !~ '^[A-Z0-9/-]{4,30}$' then raise exception 'Enter the CTDMS enquiry number'; end if;
  if exists (select 1 from enquiries where ctdms_enquiry_no = v_no and id <> w.enquiry_id) then
    raise exception 'CTDMS enquiry % is already linked to another enquiry', v_no;
  end if;
  update enquiries set ctdms_enquiry_no = v_no,
    crm_sync_status = case when crm_sync_status in ('pending_entry', 'mismatch') then 'marked_done' else crm_sync_status end,
    crm_marked_done_by = coalesce(crm_marked_done_by, current_employee_id()), crm_marked_done_at = coalesce(crm_marked_done_at, now())
  where id = w.enquiry_id;
  update showroom_walkins set ctdms_submitted_by = current_employee_id(), ctdms_submitted_at = now() where id = w.id;
end;
$$;

create or replace function request_walkin_ctdms_closure(p_walkin_id uuid, p_reason text, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  w showroom_walkins%rowtype;
  v_id uuid;
begin
  select * into w from showroom_walkins where id = p_walkin_id;
  if w.id is null or not ops_can('reception_ctdms', 'create', w.outlet_id)
     or not (ops_can('reception', 'create', w.outlet_id) or has_right('reception_ctdms', 'edit')
             or can_access_employee_data(current_employee_id(), w.assigned_employee_id)) then
    raise exception 'Walk-in not found';
  end if;
  if exists (select 1 from enquiries where id = w.enquiry_id and ctdms_enquiry_no is not null) then raise exception 'This walk-in already has its CTDMS number'; end if;
  insert into walkin_ctdms_closures (walkin_id, reason, note, requested_by)
  values (w.id, p_reason, nullif(btrim(p_note), ''), current_employee_id())
  returning id into v_id;
  return v_id;
exception
  when unique_violation then raise exception 'A closure is already requested for this walk-in';
  when check_violation then raise exception 'Pick the reason (and describe it for "other")';
end;
$$;

-- Approving a closure closes the enquiry as lost.
create or replace function decide_walkin_ctdms_closure(p_closure_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c walkin_ctdms_closures%rowtype;
  w showroom_walkins%rowtype;
begin
  select * into c from walkin_ctdms_closures where id = p_closure_id for update;
  select * into w from showroom_walkins where id = c.walkin_id;
  if c.id is null or not ops_can('reception_ctdms', 'approve', w.outlet_id) then raise exception 'Deciding closures needs CTDMS Enquiry Queue: approve'; end if;
  if c.status <> 'pending' then raise exception 'Already decided'; end if;
  if not p_approve and nullif(btrim(p_note), '') is null then raise exception 'Give the reason for rejecting'; end if;
  update walkin_ctdms_closures set status = case when p_approve then 'approved' else 'rejected' end, decided_by = current_employee_id(),
    decided_at = now(), decision_note = nullif(btrim(p_note), '')
  where id = c.id;
  if p_approve then
    update enquiries set stage = 'lost', lost_reason = 'Closed before CTDMS entry: ' || replace(c.reason, '_', ' ') || coalesce(' — ' || c.note, '')
    where id = w.enquiry_id and stage in ('open', 'quoted');
  end if;
end;
$$;

-- ===== Follow-up for walk-ins that left =====
create or replace function set_walkin_followup(p_walkin_id uuid, p_at timestamptz, p_note text default null, p_done boolean default false)
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
  if w.status <> 'left' then raise exception 'Follow-ups are for walk-ins that left without an enquiry'; end if;
  if not p_done and p_at is null then raise exception 'Pick the follow-up time'; end if;
  update showroom_walkins set followup_at = coalesce(p_at, followup_at),
    followup_note = coalesce(nullif(btrim(p_note), ''), followup_note),
    followup_done_at = case when p_done then now() else null end
  where id = w.id;
end;
$$;

create or replace function walkin_followups(p_outlet_id uuid default null)
returns table (walkin_id uuid, visited_at timestamptz, customer_name text, mobile text, model text, consultant text, left_reason text,
               followup_at timestamptz, followup_note text, overdue boolean)
language sql
stable
security invoker
set search_path = public
as $$
  select w.id, w.visited_at, w.customer_name, w.mobile, m.name, e.name, w.left_reason, w.followup_at, w.followup_note,
         w.followup_at is not null and w.followup_at < now()
  from showroom_walkins w
  left join models m on m.id = w.model_id
  left join employees e on e.id = w.assigned_employee_id
  where w.status = 'left' and w.followup_done_at is null and w.visited_at > now() - interval '60 days'
    and (p_outlet_id is null or w.outlet_id = p_outlet_id)
  order by w.followup_at nulls first, w.visited_at desc;
$$;

-- Team walk-in report: team leader → consultant → model, with conversion and CTDMS-number compliance.
create or replace function walkin_team_report(p_from date, p_to date, p_outlet_id uuid default null)
returns table (team_leader text, consultant text, model text, walkins int, converted int, ctdms_entered int, closed int,
               with_exchange int, with_finance int, conversion_pct numeric, ctdms_compliance_pct numeric)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(tl.name, '—'), coalesce(e.name, 'Unassigned'), coalesce(m.name, '—'),
         count(*)::int,
         count(*) filter (where w.status = 'converted')::int,
         count(*) filter (where w.status = 'converted' and q.ctdms_enquiry_no is not null)::int,
         count(*) filter (where c.id is not null)::int,
         count(*) filter (where w.has_exchange)::int,
         count(*) filter (where w.finance_required)::int,
         round(100.0 * count(*) filter (where w.status = 'converted') / nullif(count(*), 0), 1),
         round(100.0 * count(*) filter (where w.status = 'converted' and q.ctdms_enquiry_no is not null)
               / nullif(count(*) filter (where w.status = 'converted' and c.id is null), 0), 1)
  from showroom_walkins w
  left join employees e on e.id = w.assigned_employee_id
  left join employees tl on tl.id = e.reports_to_employee_id
  left join models m on m.id = w.model_id
  left join enquiries q on q.id = w.enquiry_id
  left join walkin_ctdms_closures c on c.walkin_id = w.id and c.status = 'approved'
  where w.visit_date between p_from and p_to
    and (p_outlet_id is null or w.outlet_id = p_outlet_id)
    and ops_can('rpt_walkins', 'view', w.outlet_id)
    and (w.assigned_employee_id is null or can_access_employee_data(current_employee_id(), w.assigned_employee_id) or ops_can('reception', 'view', w.outlet_id))
  group by 1, 2, 3
  order by 1, 2, 3;
$$;

-- walkin_register gains the token, qualifiers and the CTDMS number.
create or replace function walkin_register_v2(p_date date default null, p_outlet_id uuid default null)
returns table (id uuid, visited_at timestamptz, token_no text, outlet text, customer_name text, mobile text, visit_no int, purpose text,
               model text, assigned_to text, assigned_employee_id uuid, status text, enquiry_id uuid, ctdms_enquiry_no text,
               fuel_types text[], has_exchange boolean, finance_required boolean, financier text, model_segment text,
               left_reason text, followup_at timestamptz, minutes_waiting int)
language sql
stable
security invoker
set search_path = public
as $$
  select w.id, w.visited_at, w.token_no, o.name, w.customer_name, w.mobile, w.visit_no, w.purpose, m.name, e.name, w.assigned_employee_id,
         w.status, w.enquiry_id, q.ctdms_enquiry_no, w.fuel_types, w.has_exchange, w.finance_required, f.name, w.model_segment,
         w.left_reason, w.followup_at,
         case when w.status = 'waiting' then (extract(epoch from now() - w.visited_at) / 60)::int end
  from showroom_walkins w
  join outlets o on o.id = w.outlet_id
  left join models m on m.id = w.model_id
  left join employees e on e.id = w.assigned_employee_id
  left join enquiries q on q.id = w.enquiry_id
  left join financiers f on f.id = w.financier_id
  where w.visit_date = coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date)
    and (p_outlet_id is null or w.outlet_id = p_outlet_id)
  order by w.status = 'waiting' desc, w.visited_at desc;
$$;

-- The CTDMS daily enquiry report fills the number (import_ctdms_enquiry_report); the queue is derived from
-- enquiries.ctdms_enquiry_no, so a matched row leaves the queue without anyone typing it.

-- The kiosk login lists the branch's consultants too.
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
    and (has_right('reception', 'view') or has_right('test_drive', 'view') or has_right('tasks', 'create') or has_right('kiosk', 'create'))
    and ops_branch_ok(e.outlet_id)
  order by r.rank desc, e.name;
$$;

-- ===== Grants =====
do $$
declare
  f text;
begin
  foreach f in array array[
    'set_used_car_offer(uuid, numeric, numeric, boolean)', 'mark_used_car_no_deal(uuid, text, text)', 'reopen_used_car_evaluation(uuid, text)',
    'set_used_car_refurbishment(uuid, boolean, numeric, text)', 'save_used_car_inspection(uuid, jsonb, boolean)',
    'set_used_car_document(uuid, text, text, boolean)', 'used_car_document_status(uuid)', 'update_used_car(uuid, jsonb)',
    'revert_used_car_stock_out(uuid, text)', 'revert_used_car_stock_in(uuid, text)', 'create_outside_lead(jsonb)',
    'approve_outside_purchase(uuid, numeric)', 'mark_outside_lead_lost(uuid, text, text)', 'enable_exchange(text, uuid, jsonb)',
    'exchange_business(text, uuid)', 'kiosk_detect_returning(text)', 'set_walkin_qualifiers(uuid, jsonb)', 'kiosk_create_walkin(jsonb)',
    'walkin_ctdms_queue(uuid)', 'submit_ctdms_enquiry_no(uuid, text)', 'request_walkin_ctdms_closure(uuid, text, text)',
    'decide_walkin_ctdms_closure(uuid, boolean, text)', 'set_walkin_followup(uuid, timestamptz, text, boolean)', 'walkin_followups(uuid)',
    'walkin_team_report(date, date, uuid)', 'walkin_register_v2(date, uuid)', 'storage_used_stock_visible(text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke execute on function used_car_evaluation_sync() from public, anon;
revoke execute on function used_car_outside_lead_sync() from public, anon;
revoke execute on function used_car_vehicle_stock_in_check() from public, anon;
