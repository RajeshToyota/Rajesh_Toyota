-- Phase 24: catalog and pricing masters, with Techwheels' pricing rules.
-- The TKM price list stays the authority for ex-showroom, road tax and the insurance options it
-- prints. What this adds, from Techwheels:
--   - Variant tax data (GST, MV tax rate, engine cc, HSN), colour photos per model and variant content
--     (features plus up to seven colour-tagged images).
--   - Accessories: universal with excluded models, top picks, packs, variant groups.
--   - Insurance engine: IDV/OD/TP per variant, the highest enabled OD discount, add-on rates per
--     insurer × add-on × TP type (% of IDV), other charges per TP type, GST; zero-dep and consumables
--     are mandatory (battery protection too on EVs); insurers compared and the cheapest offered.
--   - RTO formula as fallback (and the only path for BH / Transfer / Scrap): MV tax, 12.5% surcharge,
--     green tax by engine cc, fixed charges, hypothecation when financed; BH = ex/(1+GST)×rate/6 plus
--     the BH fee; scrap rebate 26% of tax+surcharge capped at ₹1,00,000; transfer ₹1,000.
--   - Ceramic coating prices per model.
--   - Scheme categories (scheme_master) with the selection rules: one corporate, one loyalty, never
--     exchange and scrappage together; previous-model-year amounts; save_scheme_revision() derives
--     end dates from the next revision and never lets two revisions overlap.
--   - Variant coupon cap and approved MR discount, and the margin floor:
--       dealer discount + coupon + MR ≤ max(0, ex-showroom − dealer cost) + TKM share − schemes − buffer
--     A quote below the floor needs the Business Head.
--   - quotes.pricing_extras / bookings.pricing_extras carry the new selections into calculate_price().

-- ===== Settings =====
create table pricing_config (
  id uuid not null unique default gen_random_uuid(),
  key text primary key,
  value numeric not null,
  note text
);
insert into pricing_config (key, value, note) values
  ('coupon_cap_default', 10000, 'Coupon cap when a variant has no rule'),
  ('margin_buffer', 5000, 'Kept back from the margin before discounts (Techwheels: 5000)'),
  ('insurance_gst_percent', 18, 'GST on the insurance premium'),
  ('idv_factor_percent', 95, 'IDV as % of ex-showroom when a variant has no IDV set'),
  ('rto_surcharge_percent', 12.5, 'Surcharge on MV tax'),
  ('scrap_rebate_percent', 26, 'Scrap rebate: % of MV tax + surcharge'),
  ('scrap_rebate_cap', 100000, 'Scrap rebate cap'),
  ('rto_transfer_charge', 1000, 'Flat charge for a transfer registration');

create or replace function pricing_setting(p_key text)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select value from pricing_config where key = p_key;
$$;

-- ===== Variants, colours, content =====
alter table variants
  add column gst_rate_percent numeric check (gst_rate_percent between 0 and 100),
  add column mv_tax_rate_percent numeric check (mv_tax_rate_percent between 0 and 100),
  add column engine_cc int check (engine_cc >= 0),
  add column hsn_code text check (hsn_code ~ '^[0-9]{8}$'),
  add column is_ev boolean not null default false;

create table model_colour_photos (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references models(id) on delete cascade,
  fuel_type_id uuid references fuel_types(id),
  color_id uuid not null references colors(id),
  image_path text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index idx_model_colour_photos_model on model_colour_photos(model_id);
create index idx_model_colour_photos_fuel on model_colour_photos(fuel_type_id);
create index idx_model_colour_photos_color on model_colour_photos(color_id);

create table variant_content (
  variant_id uuid primary key references variants(id) on delete cascade,
  features jsonb not null default '[]' check (jsonb_typeof(features) = 'array'),
  -- [{path, color_id}] — at most seven images, each tagged with the colour it shows
  images jsonb not null default '[]' check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 7),
  updated_by uuid references employees(id),
  updated_at timestamptz not null default now()
);
create index idx_variant_content_by on variant_content(updated_by);

insert into storage.buckets (id, name, public) values ('catalog-media', 'catalog-media', false)
on conflict (id) do nothing;
create policy catalog_media_select on storage.objects for select to authenticated using (bucket_id = 'catalog-media');
create policy catalog_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'catalog-media' and (is_master_data_admin() or has_right('catalog', 'edit')));
create policy catalog_media_update on storage.objects for update to authenticated
  using (bucket_id = 'catalog-media' and (is_master_data_admin() or has_right('catalog', 'edit')));
create policy catalog_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'catalog-media' and (is_master_data_admin() or has_right('catalog', 'edit')));

-- ===== Accessories =====
alter table accessories
  add column is_universal boolean not null default false,
  add column excluded_model_ids uuid[] not null default '{}',
  add column is_top boolean not null default false,
  add column top_order int,
  add column is_pack boolean not null default false,
  add column variant_group text,
  add column warranty_years int check (warranty_years >= 0),
  add column features jsonb not null default '[]',
  add constraint accessories_exclusions_need_universal check (is_universal or cardinality(excluded_model_ids) = 0);

-- Accessories that can be sold on a variant: its own model's (or variant's), plus universal ones not
-- excluded for the model. Top picks first.
create or replace function accessories_for_variant(p_variant_id uuid)
returns setof accessories
language sql
stable
security invoker
set search_path = public
as $$
  select a.* from accessories a, variants v
  where v.id = p_variant_id and a.is_active
    and ((a.variant_id = v.id)
         or (a.variant_id is null and a.model_id = v.model_id)
         or (a.is_universal and not (v.model_id = any (a.excluded_model_ids))))
  order by a.is_top desc, a.top_order nulls last, a.sort_order, a.name;
$$;

-- ===== Insurance engine =====
alter table insurance_providers add column is_active boolean not null default true;

create table insurance_tp_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  sort_order int not null default 0
);
insert into insurance_tp_types (code, name, sort_order) values
  ('1+3', '1 yr OD + 3 yr TP', 10),
  ('3+3', '3 yr OD + 3 yr TP', 20);

create table variant_tp_types (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null unique references variants(id) on delete cascade,
  tp_type_code text not null references insurance_tp_types(code)
);
create index idx_variant_tp_types_tp on variant_tp_types(tp_type_code);

-- Per variant: IDV, OD and TP premiums and other charges, effective-dated.
create table insurance_rates (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references variants(id) on delete cascade,
  tp_type_code text not null references insurance_tp_types(code),
  idv_amount numeric check (idv_amount >= 0),          -- null: ex-showroom × idv_factor_percent
  od_amount numeric not null check (od_amount >= 0),
  tp_amount numeric not null check (tp_amount >= 0),
  other_charges numeric not null default 0 check (other_charges >= 0),
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (variant_id, tp_type_code, effective_from)
);
create index idx_insurance_rates_tp on insurance_rates(tp_type_code);

-- The OD discount options for a variant; the highest enabled one is applied (Techwheels' od_rate).
create table insurance_od_discounts (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references variants(id) on delete cascade,
  discount_percent numeric not null check (discount_percent > 0 and discount_percent < 100),
  is_enabled boolean not null default true,
  unique (variant_id, discount_percent)
);

alter table insurance_addons
  add column is_mandatory boolean not null default false,
  add column ev_only boolean not null default false;
-- Zero-dep and consumables are always included; battery protection on EVs.
update insurance_addons set is_mandatory = true where name ~* '(zero ?dep|consumable)';
update insurance_addons set is_mandatory = true, ev_only = true where name ~* 'battery' and name ~* 'protect';

create table insurance_addon_rates (
  provider_id uuid not null references insurance_providers(id) on delete cascade,
  addon_id uuid not null references insurance_addons(id) on delete cascade,
  tp_type_code text not null references insurance_tp_types(code),
  rate_percent numeric not null check (rate_percent >= 0 and rate_percent < 100),  -- % of IDV
  id uuid primary key default gen_random_uuid(),
  unique (provider_id, addon_id, tp_type_code)
);
create index idx_insurance_addon_rates_addon on insurance_addon_rates(addon_id);
create index idx_insurance_addon_rates_tp on insurance_addon_rates(tp_type_code);

create table insurance_other_charges (
  id uuid primary key default gen_random_uuid(),
  tp_type_code text not null unique references insurance_tp_types(code),
  amount numeric not null default 0 check (amount >= 0)
);

-- One insurer's premium for a variant. Returns null when the variant has no rate, or the insurer has
-- no rate for a mandatory add-on (that insurer then cannot quote).
create or replace function insurance_premium(
  p_variant_id uuid, p_provider_id uuid, p_addon_ids uuid[] default '{}', p_tp_type text default null,
  p_ex_showroom numeric default null, p_as_of date default current_date
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tp text := coalesce(p_tp_type, (select tp_type_code from variant_tp_types where variant_id = p_variant_id), '1+3');
  r insurance_rates%rowtype;
  v_is_ev boolean;
  v_ex numeric := p_ex_showroom;
  v_idv numeric;
  v_disc numeric;
  v_net_od numeric;
  v_other numeric;
  v_addons jsonb := '[]';
  v_addon_total numeric := 0;
  v_taxable numeric;
  v_gst numeric;
  a record;
begin
  select * into r from insurance_rates
  where variant_id = p_variant_id and tp_type_code = v_tp
    and effective_from <= p_as_of and (effective_to is null or effective_to >= p_as_of)
  order by effective_from desc limit 1;
  if r.id is null then
    return null;
  end if;
  select is_ev into v_is_ev from variants where id = p_variant_id;
  if v_ex is null then
    select ex_showroom_price into v_ex from price_list
    where variant_id = p_variant_id and list_type = 'private' and effective_from <= p_as_of
      and (effective_to is null or effective_to >= p_as_of)
    order by effective_from desc limit 1;
  end if;
  v_idv := coalesce(r.idv_amount, round(coalesce(v_ex, 0) * pricing_setting('idv_factor_percent') / 100));
  v_disc := coalesce((select max(discount_percent) from insurance_od_discounts where variant_id = p_variant_id and is_enabled), 0);
  v_net_od := round(r.od_amount - r.od_amount * v_disc / 100);
  v_other := r.other_charges + coalesce((select amount from insurance_other_charges where tp_type_code = v_tp), 0);

  for a in
    select ad.id, ad.name, ad.is_mandatory, ar.rate_percent
    from insurance_addons ad
    left join insurance_addon_rates ar on ar.addon_id = ad.id and ar.provider_id = p_provider_id and ar.tp_type_code = v_tp
    where (ad.id = any (coalesce(p_addon_ids, '{}')) or (ad.is_mandatory and (not ad.ev_only or v_is_ev)))
  loop
    if a.rate_percent is null then
      if a.is_mandatory then
        return null;
      end if;
      continue;  -- an optional add-on this insurer does not sell
    end if;
    v_addons := v_addons || jsonb_build_array(jsonb_build_object(
      'addon_id', a.id, 'name', a.name, 'mandatory', a.is_mandatory, 'rate_percent', a.rate_percent,
      'amount', round(v_idv * a.rate_percent / 100)));
    v_addon_total := v_addon_total + round(v_idv * a.rate_percent / 100);
  end loop;

  v_taxable := v_net_od + r.tp_amount + v_other + v_addon_total;
  v_gst := round(v_taxable * pricing_setting('insurance_gst_percent') / 100);
  return jsonb_build_object(
    'provider_id', p_provider_id, 'provider', (select name from insurance_providers where id = p_provider_id),
    'tp_type', v_tp, 'idv', v_idv, 'od', r.od_amount, 'od_discount_percent', v_disc, 'net_od', v_net_od,
    'tp', r.tp_amount, 'other_charges', v_other, 'addons', v_addons, 'addons_amount', v_addon_total,
    'taxable', v_taxable, 'gst', v_gst, 'premium', v_taxable + v_gst);
end;
$$;

-- Every insurer's premium for a variant, cheapest first (the customer is offered the cheapest).
create or replace function insurance_quotes(p_variant_id uuid, p_addon_ids uuid[] default '{}', p_tp_type text default null)
returns table (provider_id uuid, provider text, premium numeric, breakdown jsonb, is_cheapest boolean)
language sql
stable
security definer
set search_path = public
as $$
  with q as (
    select p.id, p.name, insurance_premium(p_variant_id, p.id, p_addon_ids, p_tp_type) b
    from insurance_providers p where p.is_active
  )
  select id, name, (b->>'premium')::numeric, b,
         (b->>'premium')::numeric = min((b->>'premium')::numeric) over ()
  from q where b is not null
  order by (b->>'premium')::numeric, name;
$$;

-- ===== RTO formula =====
create table rto_settings (
  id int primary key default 1 check (id = 1),
  new_registration numeric not null default 0,
  hypothecation_addition numeric not null default 0,
  duplicate_tax_card numeric not null default 0,
  bh_processing_fee numeric not null default 0,
  updated_at timestamptz not null default now()
);
insert into rto_settings (id) values (1);

create table green_tax_slabs (
  id uuid primary key default gen_random_uuid(),
  min_cc int not null check (min_cc >= 0),
  max_cc int not null,
  amount numeric not null check (amount >= 0),
  check (max_cc >= min_cc)
);

-- RTO for one registration type, Techwheels' computeRtoOptions/computeRtoTotal. Null when the variant
-- has no MV tax rate (not configured), except Transfer which is flat.
create or replace function rto_calc(p_variant_id uuid, p_ex_showroom numeric, p_type text default 'NORMAL', p_financed boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_type text := upper(coalesce(p_type, 'NORMAL'));
  v variants%rowtype;
  s rto_settings%rowtype;
  v_mv numeric;
  v_sur numeric;
  v_green numeric;
  v_rebate numeric := 0;
  v_bh_fee numeric := 0;
  v_fixed numeric;
begin
  if v_type not in ('NORMAL', 'BH', 'SCRAP', 'TRANSFER') then
    raise exception 'Unknown registration type %', p_type;
  end if;
  if v_type = 'TRANSFER' then
    return jsonb_build_object('reg_type', 'TRANSFER', 'total', pricing_setting('rto_transfer_charge'));
  end if;
  select * into v from variants where id = p_variant_id;
  select * into s from rto_settings where id = 1;
  if v.mv_tax_rate_percent is null and not v.is_ev then
    return null;
  end if;
  v_fixed := s.new_registration + s.duplicate_tax_card + case when p_financed then s.hypothecation_addition else 0 end;
  v_green := case when v.is_ev then 0 else coalesce((select amount from green_tax_slabs where min_cc <= coalesce(v.engine_cc, 0) and max_cc >= coalesce(v.engine_cc, 0) limit 1), 0) end;

  if v_type = 'BH' then
    v_mv := case when v.is_ev then 0
                 else round((p_ex_showroom / (1 + coalesce(v.gst_rate_percent, 0) / 100)) * v.mv_tax_rate_percent / 100 / 6) end;
    v_sur := 0;
    v_bh_fee := case when v.is_ev then 0 else s.bh_processing_fee end;
  else
    v_mv := case when v.is_ev then 0 else round(p_ex_showroom * v.mv_tax_rate_percent / 100) end;
    v_sur := round(v_mv * pricing_setting('rto_surcharge_percent') / 100);
    if v_type = 'SCRAP' then
      v_rebate := least(round((v_mv + v_sur) * pricing_setting('scrap_rebate_percent') / 100), pricing_setting('scrap_rebate_cap'));
    end if;
  end if;
  return jsonb_build_object(
    'reg_type', v_type, 'new_registration', s.new_registration, 'duplicate_tax_card', s.duplicate_tax_card,
    'hypothecation_addition', case when p_financed then s.hypothecation_addition else 0 end,
    'mv_tax', v_mv, 'surcharge', v_sur, 'green_tax', v_green, 'rebate_waiver', v_rebate, 'bh_processing_fee', v_bh_fee,
    'total', v_fixed + v_mv + v_sur + v_green - v_rebate + v_bh_fee);
end;
$$;

-- ===== Ceramic coating =====
create table ceramic_coating_prices (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references models(id) on delete cascade,
  name text not null default 'Ceramic Coating',
  price numeric not null check (price >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (model_id, name)
);

-- ===== Extended warranty options for a new car =====
create or replace function ew_options_for_variant(p_variant_id uuid)
returns table (product text, km_limit int, price numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on (e.product, e.km_limit) e.product, e.km_limit, e.price
  from ew_prices e join variants v on v.model_id = e.model_id
  where v.id = p_variant_id and e.min_age_months = 0 and e.effective_from <= current_date
  order by e.product, e.km_limit, e.effective_from desc;
$$;

-- ===== Scheme categories, model-year amounts, revisions =====
create table scheme_master (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category text not null check (category in ('upfront', 'corporate', 'exchange', 'scrappage', 'loyalty', 'additional')),
  has_company_share boolean not null default true,
  is_active boolean not null default true
);
insert into scheme_master (code, name, category) values
  ('consumer', 'Consumer offer', 'upfront'),
  ('exchange', 'Exchange bonus', 'exchange'),
  ('scrappage', 'Scrappage bonus', 'scrappage'),
  ('corporate', 'Corporate offer', 'corporate'),
  ('loyalty', 'Loyalty bonus', 'loyalty'),
  ('additional', 'Additional offer', 'additional');

alter table scheme_line_items
  add column scheme_master_code text references scheme_master(code),
  add column prev_my_tkm_share numeric,
  add column prev_my_dealer_share numeric;
create index idx_scheme_line_items_master on scheme_line_items(scheme_master_code);

-- Save a scheme revision from its start date only (Techwheels' save_variant_scheme_revision):
--   - the same start date replaces that revision's lines;
--   - a revision covering the start date is closed the day before;
--   - the new revision runs until the day before the next revision, or as long as the one it split;
--   - so two revisions of a scheme (same model, suffixes and name) never overlap, and history stays.
-- p: {model_id, name, suffix_scope_list (array or null), valid_from, valid_to (optional),
--     lines: [{line_type, scheme_master_code, tkm_share, dealer_share, prev_my_tkm_share,
--              prev_my_dealer_share, is_customer_facing, mutually_exclusive_group,
--              requires_exchange, requires_scrap}]}
create or replace function save_scheme_revision(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_model uuid := (p->>'model_id')::uuid;
  v_name text := nullif(trim(p->>'name'), '');
  v_from date := (p->>'valid_from')::date;
  v_to date := nullif(p->>'valid_to', '')::date;
  v_scope text[] := case when jsonb_typeof(p->'suffix_scope_list') = 'array'
                         then (select array_agg(x order by x) from jsonb_array_elements_text(p->'suffix_scope_list') x) end;
  v_id uuid;
  v_cover schemes%rowtype;
  v_next date;
  l jsonb;
  v_line uuid;
begin
  if not (is_master_data_admin() or has_right('schemes', 'edit')) then
    raise exception 'You need Schemes: edit';
  end if;
  if v_model is null or v_name is null or v_from is null then
    raise exception 'Model, scheme name and start date are required';
  end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then
    raise exception 'A scheme needs at least one line';
  end if;

  perform pg_advisory_xact_lock(hashtext('scheme:' || v_model || ':' || v_name));

  -- Same start date: replace that revision.
  select id into v_id from schemes
  where model_id = v_model and name = v_name and suffix_scope_list is not distinct from v_scope and valid_from = v_from;

  if v_id is null then
    select * into v_cover from schemes
    where model_id = v_model and name = v_name and suffix_scope_list is not distinct from v_scope
      and valid_from < v_from and valid_to >= v_from
    order by valid_from desc limit 1;
    select min(valid_from) into v_next from schemes
    where model_id = v_model and name = v_name and suffix_scope_list is not distinct from v_scope and valid_from > v_from;

    v_to := coalesce(v_to, v_next - 1, v_cover.valid_to, date '2099-12-31');
    if v_next is not null and v_to >= v_next then
      raise exception 'The revision would overlap the one starting %', v_next;
    end if;
    if v_to < v_from then
      raise exception 'The end date is before the start date';
    end if;
    if v_cover.id is not null then
      update schemes set valid_to = v_from - 1 where id = v_cover.id;
    end if;
    insert into schemes (model_id, name, suffix_scope_list, valid_from, valid_to)
    values (v_model, v_name, v_scope, v_from, v_to) returning id into v_id;
  else
    if v_to is not null then
      select min(valid_from) into v_next from schemes
      where model_id = v_model and name = v_name and suffix_scope_list is not distinct from v_scope and valid_from > v_from;
      if v_next is not null and v_to >= v_next then
        raise exception 'The revision would overlap the one starting %', v_next;
      end if;
      update schemes set valid_to = v_to where id = v_id;
    end if;
    delete from scheme_line_items where scheme_id = v_id;
  end if;

  for l in select * from jsonb_array_elements(p->'lines') loop
    insert into scheme_line_items (scheme_id, line_type, scheme_master_code, tkm_share, dealer_share,
                                   prev_my_tkm_share, prev_my_dealer_share, is_customer_facing)
    values (v_id, coalesce(nullif(l->>'line_type', ''), (select name from scheme_master where code = l->>'scheme_master_code')),
            nullif(l->>'scheme_master_code', ''), coalesce((l->>'tkm_share')::numeric, 0), coalesce((l->>'dealer_share')::numeric, 0),
            nullif(l->>'prev_my_tkm_share', '')::numeric, nullif(l->>'prev_my_dealer_share', '')::numeric,
            coalesce((l->>'is_customer_facing')::boolean, true))
    returning id into v_line;
    if nullif(l->>'mutually_exclusive_group', '') is not null or coalesce((l->>'requires_exchange')::boolean, false)
       or coalesce((l->>'requires_scrap')::boolean, false) then
      insert into scheme_conditions (scheme_line_item_id, mutually_exclusive_group, requires_exchange, requires_scrap)
      values (v_line, nullif(l->>'mutually_exclusive_group', ''), coalesce((l->>'requires_exchange')::boolean, false),
              coalesce((l->>'requires_scrap')::boolean, false));
    end if;
  end loop;
  return v_id;
end;
$$;

-- ===== Variant coupon cap and MR discount =====
create table discount_rules_variant (
  variant_id uuid primary key references variants(id) on delete cascade,
  coupon_cap numeric check (coupon_cap >= 0),
  mr_discount numeric check (mr_discount >= 0),
  mr_approved_by uuid references employees(id),
  mr_approved_at timestamptz,
  updated_at timestamptz not null default now()
);
create index idx_discount_rules_variant_by on discount_rules_variant(mr_approved_by);

-- Bulk upsert from a CSV: [{variant_id, coupon_cap, mr_discount}]. An MR discount needs the Business
-- Head (or Admin); it is stamped as approved by whoever saves it.
create or replace function upsert_discount_rules(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
  n int := 0;
begin
  if not (is_master_data_admin() or has_right('discount_rules', 'edit')) then
    raise exception 'You need Variant Coupon Cap: edit';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if nullif(r->>'mr_discount', '')::numeric > 0 and not (coalesce(current_employee_role_rank() <= 1, false) or has_right('discount_rules', 'approve')) then
      raise exception 'Only the Business Head can approve an MR discount';
    end if;
    insert into discount_rules_variant (variant_id, coupon_cap, mr_discount, mr_approved_by, mr_approved_at, updated_at)
    values ((r->>'variant_id')::uuid, nullif(r->>'coupon_cap', '')::numeric, nullif(r->>'mr_discount', '')::numeric,
            case when nullif(r->>'mr_discount', '')::numeric > 0 then current_employee_id() end,
            case when nullif(r->>'mr_discount', '')::numeric > 0 then now() end, now())
    on conflict (variant_id) do update set
      coupon_cap = excluded.coupon_cap, mr_discount = excluded.mr_discount,
      mr_approved_by = excluded.mr_approved_by, mr_approved_at = excluded.mr_approved_at, updated_at = now();
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ===== RLS for the new masters =====
do $$
declare t text;
begin
  foreach t in array array['pricing_config', 'model_colour_photos', 'variant_content', 'insurance_tp_types', 'variant_tp_types',
                           'insurance_rates', 'insurance_od_discounts', 'insurance_addon_rates', 'insurance_other_charges',
                           'rto_settings', 'green_tax_slabs', 'ceramic_coating_prices', 'scheme_master', 'discount_rules_variant'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I_select on %I for select to authenticated using (true)', t, t);
    execute format('create policy %I_write on %I for all to authenticated using (is_master_data_admin() or has_right(''catalog'', ''edit'')) with check (is_master_data_admin() or has_right(''catalog'', ''edit''))', t, t);
  end loop;
end $$;
-- The coupon cap / MR table is written only through upsert_discount_rules (MR needs approval).
drop policy discount_rules_variant_write on discount_rules_variant;

-- ===== Quote / booking selections that calculate_price reads beyond the columns =====
-- Keys: model_year ('current' | 'previous'), insurance_provider_id, insurance_tp_type,
-- rto_type ('NORMAL' | 'BH' | 'SCRAP' | 'TRANSFER'), is_financed, ceramic_coating_id,
-- coupon_amount, apply_mr_discount.
alter table quotes add column pricing_extras jsonb not null default '{}' check (jsonb_typeof(pricing_extras) = 'object');
alter table bookings add column pricing_extras jsonb not null default '{}' check (jsonb_typeof(pricing_extras) = 'object');

-- ===== Pricing engine (latest definitions from 20261027000001, extended) =====

create or replace function calculate_price(selections jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_variant_id uuid := nullif(selections->>'variant_id','')::uuid;
  v_color_id uuid := nullif(selections->>'color_id','')::uuid;
  v_state text := selections->>'state';
  v_rto_category_id uuid := nullif(selections->>'rto_category_id','')::uuid;
  v_as_of_date date := coalesce((selections->>'as_of_date')::date, current_date);
  v_has_exchange boolean := coalesce((selections->>'has_exchange')::boolean, false);
  v_has_scrap boolean := coalesce((selections->>'has_scrap')::boolean, false);
  v_scrap jsonb := selections->'scrap';
  v_insurance_plan_id uuid := nullif(selections->>'insurance_plan_id','')::uuid;
  v_insurance_addon_ids uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(selections->'insurance_addon_ids','[]'::jsonb)) x), '{}');
  v_accessory_ids uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(selections->'accessory_ids','[]'::jsonb)) x), '{}');
  v_vas_ids uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(selections->'vas_product_ids','[]'::jsonb)) x), '{}');
  v_selected_scheme_ids uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(selections->'selected_scheme_line_item_ids','[]'::jsonb)) x), '{}');
  v_list_type text := coalesce(nullif(selections->>'list_type',''), 'private');
  v_insurance_option text := nullif(selections->>'insurance_option','');
  v_include_ew boolean := coalesce((selections->>'include_extended_warranty')::boolean, false);
  v_dealer_discount numeric := coalesce(nullif(selections->>'dealer_discount','')::numeric, 0);
  -- Phase 24 selections
  v_model_year text := coalesce(nullif(selections->>'model_year',''), 'current');
  v_provider_id uuid := nullif(selections->>'insurance_provider_id','')::uuid;
  v_tp_type text := nullif(selections->>'insurance_tp_type','');
  v_rto_type text := upper(coalesce(nullif(selections->>'rto_type',''), 'NORMAL'));
  v_financed boolean := coalesce((selections->>'is_financed')::boolean, false);
  v_ceramic_id uuid := nullif(selections->>'ceramic_coating_id','')::uuid;
  v_ceramic_amount numeric := 0;
  v_coupon numeric := coalesce(nullif(selections->>'coupon_amount','')::numeric, 0);
  v_coupon_cap numeric;
  v_apply_mr boolean := coalesce((selections->>'apply_mr_discount')::boolean, false);
  v_mr numeric := 0;
  v_rule discount_rules_variant%rowtype;
  v_tkm_selected numeric := 0;
  v_margin_available numeric;
  v_margin_used numeric;
  v_rto jsonb;
  v_ins jsonb;
  v_pl price_list%rowtype;
  v_paint_category text;
  v_fastag_amount numeric := 0;
  v_ew_amount numeric := 0;

  v_model_id uuid;
  v_suffix text;
  v_ex_showroom numeric;
  v_color_extra numeric := 0;
  v_scheme_discount numeric := 0;
  v_dealer_margin numeric := 0;
  v_tcs_rate numeric;
  v_tcs_amount numeric;
  v_rto_amount numeric;
  v_scrap_amount numeric := 0;
  v_insurance_amount numeric := 0;
  v_accessories_amount numeric := 0;
  v_vas_amount numeric := 0;
  v_total numeric;
  v_line_items jsonb := '[]'::jsonb;
  v_idv numeric;
  v_dup_group text;
  v_basis text;
  v_base_rate numeric;
  v_coverage_type text;
  v_dep numeric;
  v_base_premium numeric;
  v_variant_premium numeric;
  rec record;
begin
  if v_variant_id is null or v_color_id is null or v_state is null then
    raise exception 'variant_id, color_id, and state are required';
  end if;

  select model_id, suffix into v_model_id, v_suffix from variants where id = v_variant_id;
  if v_model_id is null then
    raise exception 'Unknown variant_id: %', v_variant_id;
  end if;

  -- 1. Price-list row, as of the pricing date. A row for this exact colour wins; otherwise the
  -- row for the colour's paint category (standard / pearl white / dual tone) on the chosen list.
  select coalesce(paint_category, 'standard') into v_paint_category from colors where id = v_color_id;

  select * into v_pl
  from price_list
  where variant_id = v_variant_id and state = v_state and list_type = v_list_type
    and (color_id = v_color_id or (color_id is null and paint_category = v_paint_category))
    and effective_from <= v_as_of_date and (effective_to is null or effective_to >= v_as_of_date)
  order by (color_id is not null) desc, effective_from desc
  limit 1;

  -- A paint with no dedicated row on this list is sold at the standard price.
  if v_pl.id is null and v_paint_category <> 'standard' then
    select * into v_pl
    from price_list
    where variant_id = v_variant_id and state = v_state and list_type = v_list_type
      and color_id is null and paint_category = 'standard'
      and effective_from <= v_as_of_date and (effective_to is null or effective_to >= v_as_of_date)
    order by effective_from desc
    limit 1;
  end if;

  v_ex_showroom := v_pl.ex_showroom_price;
  if v_ex_showroom is null then
    raise exception 'No active % price_list entry for variant % / color % / state % as of %', v_list_type, v_variant_id, v_color_id, v_state, v_as_of_date;
  end if;

  -- Colour upcharges only apply to legacy per-colour rows; paint-category rows already price it in.
  if v_pl.color_id is not null then
    select coalesce(extra_cost, 0) into v_color_extra from variant_colors where variant_id = v_variant_id and color_id = v_color_id;
  end if;
  v_color_extra := coalesce(v_color_extra, 0);

  v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','base_price','label','Ex-Showroom Price','amount',v_ex_showroom));
  if v_color_extra <> 0 then
    v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','base_price_addon','label','Color Upcharge','amount',v_color_extra));
  end if;

  -- 2. Mutual-exclusivity check: reject rather than guess if the caller selected two items from
  -- the same exclusive group.
  select mutually_exclusive_group into v_dup_group
  from scheme_conditions
  where scheme_line_item_id = any(v_selected_scheme_ids) and mutually_exclusive_group is not null
  group by mutually_exclusive_group
  having count(*) > 1
  limit 1;

  if v_dup_group is not null then
    raise exception 'Multiple mutually-exclusive scheme selections in group %', v_dup_group;
  end if;

  if exists (
    select 1 from scheme_conditions sc
    where sc.scheme_line_item_id = any(v_selected_scheme_ids) and sc.requires_exchange and not v_has_exchange
  ) then
    raise exception 'A selected scheme line item requires an exchange, but has_exchange was not set';
  end if;

  if exists (
    select 1 from scheme_conditions sc
    where sc.scheme_line_item_id = any(v_selected_scheme_ids) and sc.requires_scrap and not v_has_scrap
  ) then
    raise exception 'A selected scheme line item requires a scrap certificate, but has_scrap was not set';
  end if;

  -- 2b. Scheme categories (Techwheels' selection rules): one corporate, one loyalty, and never an
  -- exchange and a scrappage scheme together.
  if (select count(*) from scheme_line_items sli join scheme_master sm on sm.code = sli.scheme_master_code
      where sli.id = any(v_selected_scheme_ids) and sm.category = 'corporate') > 1 then
    raise exception 'Only one corporate scheme can be applied';
  end if;
  if (select count(*) from scheme_line_items sli join scheme_master sm on sm.code = sli.scheme_master_code
      where sli.id = any(v_selected_scheme_ids) and sm.category = 'loyalty') > 1 then
    raise exception 'Only one loyalty scheme can be applied';
  end if;
  if (select count(distinct sm.category) from scheme_line_items sli join scheme_master sm on sm.code = sli.scheme_master_code
      where sli.id = any(v_selected_scheme_ids) and sm.category in ('exchange', 'scrappage')) > 1 then
    raise exception 'An exchange scheme and a scrappage scheme cannot be combined';
  end if;
  if v_model_year not in ('current', 'previous') then
    raise exception 'model_year must be current or previous';
  end if;

  if exists (
    select 1 from unnest(v_selected_scheme_ids) sid
    where not exists (
      select 1 from scheme_line_items sli
      join schemes s on s.id = sli.scheme_id
      where sli.id = sid
        and s.model_id = v_model_id
        and (s.suffix_scope_list is null or v_suffix = any(s.suffix_scope_list))
        and s.valid_from <= v_as_of_date and s.valid_to >= v_as_of_date
    )
  ) then
    raise exception 'One or more selected scheme line items are not active for this variant as of %', v_as_of_date;
  end if;

  -- 3. Customer-facing discount total (selected items only) + margin from those same items.
  for rec in
    select sli.line_type,
           case when v_model_year = 'previous' then coalesce(sli.prev_my_tkm_share, sli.tkm_share) else sli.tkm_share end as tkm_share,
           case when v_model_year = 'previous' then coalesce(sli.prev_my_dealer_share, sli.dealer_share) else sli.dealer_share end as dealer_share,
           sli.is_customer_facing
    from scheme_line_items sli
    where sli.id = any(v_selected_scheme_ids)
  loop
    if rec.is_customer_facing then
      v_tkm_selected := v_tkm_selected + rec.tkm_share;
      v_scheme_discount := v_scheme_discount + rec.tkm_share + rec.dealer_share;
      v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','scheme_discount','label',rec.line_type,'amount', -(rec.tkm_share + rec.dealer_share)));
      v_dealer_margin := v_dealer_margin + rec.dealer_share;
    else
      v_dealer_margin := v_dealer_margin + rec.tkm_share + rec.dealer_share;
    end if;
  end loop;

  -- Dealer-only line items on schemes applicable to this deal always contribute to margin,
  -- since they are never customer-selectable (not shown in the quote UI at all).
  for rec in
    select sli.tkm_share, sli.dealer_share
    from scheme_line_items sli
    join schemes s on s.id = sli.scheme_id
    where sli.is_customer_facing = false
      and s.model_id = v_model_id
      and (s.suffix_scope_list is null or v_suffix = any(s.suffix_scope_list))
      and s.valid_from <= v_as_of_date and s.valid_to >= v_as_of_date
      and sli.id <> all(v_selected_scheme_ids)
  loop
    v_dealer_margin := v_dealer_margin + rec.tkm_share + rec.dealer_share;
  end loop;

  -- 3b. Additional dealer discount (Phase 8): customer-facing, paid entirely out of dealer margin.
  if v_dealer_discount < 0 then
    raise exception 'Dealer discount cannot be negative';
  end if;
  if v_dealer_discount > v_ex_showroom + v_color_extra - v_scheme_discount then
    raise exception 'Dealer discount is larger than the vehicle price';
  end if;
  if v_dealer_discount > 0 then
    v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','dealer_discount','label','Additional Dealer Discount','amount', -v_dealer_discount));
    v_dealer_margin := v_dealer_margin - v_dealer_discount;
  end if;

  -- 3c. Coupon (capped per variant) and the pre-approved MR discount (Techwheels' discount_rules_variant).
  select * into v_rule from discount_rules_variant where variant_id = v_variant_id;
  v_coupon_cap := coalesce(v_rule.coupon_cap, pricing_setting('coupon_cap_default'), 0);
  if v_coupon < 0 then
    raise exception 'Coupon cannot be negative';
  end if;
  if v_coupon > v_coupon_cap then
    raise exception 'Coupon of % is above this variant''s cap of %', v_coupon, v_coupon_cap;
  end if;
  if v_apply_mr then
    if coalesce(v_rule.mr_discount, 0) <= 0 or v_rule.mr_approved_by is null then
      raise exception 'This variant has no approved MR discount';
    end if;
    v_mr := v_rule.mr_discount;
  end if;
  if v_coupon > 0 then
    v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','coupon','label','Coupon','amount', -v_coupon));
  end if;
  if v_mr > 0 then
    v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','mr_discount','label','MR Discount','amount', -v_mr));
  end if;
  v_dealer_margin := v_dealer_margin - v_coupon - v_mr;
  if v_dealer_discount + v_coupon + v_mr > v_ex_showroom + v_color_extra - v_scheme_discount then
    raise exception 'Discounts are larger than the vehicle price';
  end if;

  -- 4. TCS, on (price - customer-facing discounts), at the configured rate.
  select rate_percentage into v_tcs_rate
  from tax_config
  where name = 'TCS on sale of motor vehicle'
    and effective_from <= v_as_of_date and (effective_to is null or effective_to >= v_as_of_date)
  order by effective_from desc limit 1;

  if v_tcs_rate is null then
    raise exception 'No active tax_config entry for TCS as of %', v_as_of_date;
  end if;

  -- The dealer list prints TCS as 0 below the statutory threshold; honour that.
  if v_pl.tcs_amount = 0 then
    v_tcs_rate := 0;
  end if;

  v_tcs_amount := round((v_ex_showroom + v_color_extra - v_scheme_discount - v_dealer_discount - v_coupon - v_mr) * v_tcs_rate / 100, 2);
  v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','tax','label', format('TCS @ %s%%', v_tcs_rate), 'amount', v_tcs_amount));

  -- 5. RTO: the dealer list's Road Tax & Registration when printed, else rto_pricing (variant-level
  -- pricing takes precedence over model-level). Then the scrap certificate.
  if v_rto_type not in ('NORMAL', 'BH', 'SCRAP', 'TRANSFER') then
    raise exception 'Unknown registration type %', v_rto_type;
  end if;
  if v_rto_type <> 'NORMAL' then
    -- BH series, transfer and scrap registrations are priced by the RTO formula (Phase 24).
    v_rto := rto_calc(v_variant_id, v_ex_showroom + v_color_extra, v_rto_type, v_financed);
    v_rto_amount := (v_rto->>'total')::numeric;
    if v_rto_amount is null then
      raise exception 'Set the MV tax rate on this variant to price a % registration', v_rto_type;
    end if;
  else
    v_rto_amount := v_pl.road_tax_registration;

    if v_rto_amount is null and v_rto_category_id is not null then
      select amount into v_rto_amount
      from rto_pricing
      where rto_category_id = v_rto_category_id and state = v_state
        and (variant_id = v_variant_id or (variant_id is null and model_id = v_model_id))
        and effective_from <= v_as_of_date and (effective_to is null or effective_to >= v_as_of_date)
      order by variant_id nulls last, effective_from desc
      limit 1;
    end if;

    -- Neither the list nor rto_pricing: the RTO formula, when the variant has its tax rate.
    if v_rto_amount is null then
      v_rto := rto_calc(v_variant_id, v_ex_showroom + v_color_extra, 'NORMAL', v_financed);
      v_rto_amount := (v_rto->>'total')::numeric;
    end if;

    if v_rto_amount is null and v_rto_category_id is null then
      raise exception 'rto_category_id is required when the price list has no Road Tax & Registration amount';
    end if;
  end if;

  if v_rto_amount is null then
    raise exception 'No active rto_pricing entry for category % / state % / variant % as of %', v_rto_category_id, v_state, v_variant_id, v_as_of_date;
  end if;

  v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','rto','label', case when v_rto_type = 'NORMAL' then 'RTO & Registration' else format('RTO & Registration (%s)', v_rto_type) end,'amount',v_rto_amount));

  if v_scrap is not null and (v_scrap->>'source') = 'Rajesh Toyota' then
    v_scrap_amount := coalesce((v_scrap->>'amount')::numeric, 0);
    if v_scrap_amount <> 0 then
      v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','scrap','label','Scrap Certificate Bonus (Rajesh Toyota)','amount', -v_scrap_amount));
    end if;
  end if;

  -- 6. Insurance: the dealer list's option (advance / premium / premium_3plus3 / luxury) when one is
  -- chosen; otherwise a base plan (idv_percentage basis uses the age-0 IDV slab; flat/slab bases use
  -- base_rate directly as a stub — no insurer slab table is modeled yet). Add-ons apply to either.
  if v_insurance_option is not null then
    v_base_premium := (v_pl.insurance_options->>v_insurance_option)::numeric;
    if v_base_premium is null then
      raise exception 'Insurance option % is not on this price list (available: %)', v_insurance_option,
        (select string_agg(k, ', ') from jsonb_object_keys(v_pl.insurance_options) k);
    end if;

    v_insurance_amount := v_base_premium;
    v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','insurance','label', format('Insurance (%s)', initcap(replace(replace(v_insurance_option, '_3plus3', ' 3+3'), '_', ' '))), 'amount', v_base_premium));

    if array_length(v_insurance_addon_ids, 1) > 0 then
      for rec in select name, price from insurance_addons where id = any(v_insurance_addon_ids) loop
        v_insurance_amount := v_insurance_amount + rec.price;
        v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','insurance_addon','label',rec.name,'amount',rec.price));
      end loop;
    end if;
  elsif v_insurance_plan_id is not null then
    select pricing_basis, base_rate, coverage_type into v_basis, v_base_rate, v_coverage_type
    from insurance_plans where id = v_insurance_plan_id;

    if v_basis is null then
      raise exception 'Unknown insurance_plan_id: %', v_insurance_plan_id;
    end if;

    select amount into v_variant_premium
    from insurance_pricing
    where insurance_plan_id = v_insurance_plan_id and state = v_state
      and (variant_id = v_variant_id or (variant_id is null and model_id = v_model_id))
      and effective_from <= v_as_of_date and (effective_to is null or effective_to >= v_as_of_date)
    order by variant_id nulls last, effective_from desc
    limit 1;

    if v_variant_premium is not null then
      v_base_premium := v_variant_premium;
    elsif v_basis = 'idv_percentage' then
      select depreciation_percentage into v_dep from idv_slabs where min_age_months <= 0 and max_age_months >= 0 limit 1;
      v_dep := coalesce(v_dep, 0);
      v_idv := (v_ex_showroom + v_color_extra) * (1 - v_dep / 100);
      v_base_premium := round(v_idv * v_base_rate / 100, 2);
    else
      v_base_premium := v_base_rate;
    end if;

    v_insurance_amount := v_base_premium;
    v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','insurance','label', format('Insurance (%s)', v_coverage_type), 'amount', v_base_premium));

    if array_length(v_insurance_addon_ids, 1) > 0 then
      for rec in select name, price from insurance_addons where id = any(v_insurance_addon_ids) loop
        v_insurance_amount := v_insurance_amount + rec.price;
        v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','insurance_addon','label',rec.name,'amount',rec.price));
      end loop;
    end if;
  elsif v_provider_id is not null then
    -- Phase 24 insurance engine: this insurer's premium, mandatory add-ons included.
    v_ins := insurance_premium(v_variant_id, v_provider_id, v_insurance_addon_ids, v_tp_type, v_ex_showroom + v_color_extra, v_as_of_date);
    if v_ins is null then
      raise exception 'This insurer cannot quote this variant (no rates, or no rate for a mandatory add-on)';
    end if;
    v_insurance_amount := (v_ins->>'premium')::numeric;
    v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','insurance','label', format('Insurance (%s, %s)', v_ins->>'provider', v_ins->>'tp_type'), 'amount', v_insurance_amount));
  end if;

  -- 6b. FASTag (always, when the list prints it) and the optional 5th-year extended warranty.
  v_fastag_amount := coalesce(v_pl.fastag_amount, 0);
  if v_fastag_amount <> 0 then
    v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','fastag','label','FASTag','amount',v_fastag_amount));
  end if;

  if v_include_ew then
    v_ew_amount := v_pl.ew_5th_year_amount;
    if v_ew_amount is null then
      raise exception 'This price list has no extended warranty amount for the selected variant';
    end if;
    v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','extended_warranty','label','True Warranty (5th Year)','amount',v_ew_amount));
  end if;

  -- 7. Accessories
  if array_length(v_accessory_ids, 1) > 0 then
    for rec in select name, price from accessories where id = any(v_accessory_ids) loop
      v_accessories_amount := v_accessories_amount + rec.price;
      v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','accessory','label',rec.name,'amount',rec.price));
    end loop;
  end if;

  -- 8. VAS
  if array_length(v_vas_ids, 1) > 0 then
    for rec in select name, price from vas_products where id = any(v_vas_ids) loop
      v_vas_amount := v_vas_amount + rec.price;
      v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','vas','label',rec.name,'amount',rec.price));
    end loop;
  end if;

  -- 8b. Ceramic coating
  if v_ceramic_id is not null then
    select price into v_ceramic_amount from ceramic_coating_prices where id = v_ceramic_id and model_id = v_model_id and is_active;
    if v_ceramic_amount is null then
      raise exception 'That ceramic coating is not offered on this model';
    end if;
    v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','ceramic_coating','label','Ceramic Coating','amount',v_ceramic_amount));
  end if;

  -- 8c. Margin floor (Techwheels' marginCap): discounts may not eat into the margin below the buffer.
  if v_pl.dealer_purchase_price is not null then
    v_margin_available := greatest(0, v_ex_showroom + v_color_extra - v_pl.dealer_purchase_price)
                          + v_tkm_selected - v_scheme_discount - coalesce(pricing_setting('margin_buffer'), 0);
  end if;
  v_margin_used := v_dealer_discount + v_coupon + v_mr;

  -- 9. Total
  v_total := v_ex_showroom + v_color_extra - v_scheme_discount - v_dealer_discount + v_tcs_amount + v_rto_amount - v_scrap_amount
             + v_insurance_amount + v_fastag_amount + v_ew_amount + v_accessories_amount + v_vas_amount
             + v_ceramic_amount - v_coupon - v_mr;

  return jsonb_build_object(
    'as_of_date', v_as_of_date,
    'ex_showroom_price', v_ex_showroom,
    'color_extra_cost', v_color_extra,
    'scheme_discount_customer_facing', v_scheme_discount,
    'dealer_discount', v_dealer_discount,
    'tcs_rate_percentage', v_tcs_rate,
    'tcs_amount', v_tcs_amount,
    'rto_amount', v_rto_amount,
    'scrap_amount', v_scrap_amount,
    'list_type', v_list_type,
    'paint_category', v_pl.paint_category,
    'insurance_option', v_insurance_option,
    'insurance_amount', v_insurance_amount,
    'fastag_amount', v_fastag_amount,
    'extended_warranty_amount', v_ew_amount,
    'on_road_listed', v_pl.on_road_listed,
    'accessories_amount', v_accessories_amount,
    'vas_amount', v_vas_amount,
    'total_amount', v_total,
    'dealer_margin', v_dealer_margin,
    'line_items', v_line_items,
    'model_year', v_model_year,
    'rto_type', v_rto_type,
    'rto_breakdown', v_rto,
    'insurance_provider_id', v_provider_id,
    'insurance_breakdown', v_ins,
    'ceramic_amount', v_ceramic_amount,
    'coupon_amount', v_coupon,
    'coupon_cap', v_coupon_cap,
    'mr_discount', v_mr,
    'margin_available', v_margin_available,
    'margin_used', v_margin_used,
    'margin_floor_breached', coalesce(v_margin_used > 0 and v_margin_used > v_margin_available, false),
    'priced_as_of', now()
  );
end;
$$;

create or replace function quotes_recompute_pricing()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_result jsonb;
begin
  v_result := calculate_price(build_pricing_selections(
    NEW.variant_id, NEW.color_id, NEW.outlet_id, NEW.rto_category_id,
    NEW.scrap_certificate_id, NEW.insurance_plan_id, NEW.insurance_addon_ids,
    NEW.accessory_ids, NEW.vas_product_ids, NEW.selected_scheme_line_item_ids,
    NEW.price_list_type, NEW.insurance_option, NEW.include_extended_warranty, NEW.dealer_discount
  ) || NEW.pricing_extras);

  NEW.priced_snapshot := v_result;
  NEW.total_amount := (v_result->>'total_amount')::numeric;
  NEW.dealer_margin := (v_result->>'dealer_margin')::numeric;
  NEW.priced_as_of := (v_result->>'priced_as_of')::timestamptz;

  return NEW;
end;
$$;

create or replace function bookings_recompute_pricing()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if NEW.imported_from_ctdms and (NEW.variant_id is null or NEW.color_id is null) then
    return NEW;
  end if;

  begin
    v_result := calculate_price(build_pricing_selections(
      NEW.variant_id, NEW.color_id, NEW.outlet_id, NEW.rto_category_id,
      NEW.scrap_certificate_id, NEW.insurance_plan_id, NEW.insurance_addon_ids,
      NEW.accessory_ids, NEW.vas_product_ids, NEW.selected_scheme_line_item_ids,
      NEW.price_list_type, NEW.insurance_option, NEW.include_extended_warranty, NEW.dealer_discount
    ) || NEW.pricing_extras);
  exception when others then
    if NEW.imported_from_ctdms then
      return NEW;
    end if;
    raise;
  end;

  NEW.priced_snapshot := v_result;
  NEW.total_amount := (v_result->>'total_amount')::numeric;
  NEW.dealer_margin := (v_result->>'dealer_margin')::numeric;
  NEW.priced_as_of := (v_result->>'priced_as_of')::timestamptz;

  return NEW;
end;
$$;

create or replace function quotes_stage_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('rt.quote_stage_rpc', true), '') = 'on' then
    return NEW;
  end if;

  if TG_OP = 'INSERT' then
    NEW.current_stage := 'basic';
    NEW.selected_scheme_line_item_ids := '{}';
    NEW.dealer_discount := 0;
    NEW.finalized_at := null;
    return NEW;
  end if;

  if NEW.current_stage is distinct from OLD.current_stage
     or NEW.dealer_discount is distinct from OLD.dealer_discount
     or NEW.selected_scheme_line_item_ids is distinct from OLD.selected_scheme_line_item_ids
     or NEW.finalized_at is distinct from OLD.finalized_at then
    raise exception 'Quote stages, schemes and dealer discount change only through the staged quote';
  end if;

  if OLD.current_stage <> 'basic' and (
       NEW.variant_id, NEW.color_id, NEW.outlet_id, NEW.rto_category_id, NEW.scrap_certificate_id,
       NEW.insurance_plan_id, NEW.insurance_addon_ids, NEW.accessory_ids, NEW.vas_product_ids,
       NEW.price_list_type, NEW.insurance_option, NEW.include_extended_warranty, NEW.pricing_extras)
     is distinct from (
       OLD.variant_id, OLD.color_id, OLD.outlet_id, OLD.rto_category_id, OLD.scrap_certificate_id,
       OLD.insurance_plan_id, OLD.insurance_addon_ids, OLD.accessory_ids, OLD.vas_product_ids,
       OLD.price_list_type, OLD.insurance_option, OLD.include_extended_warranty, OLD.pricing_extras) then
    raise exception 'This quote is past the basic stage; start a new quote to change the vehicle or add-ons';
  end if;
  return NEW;
end;
$$;

create or replace function bookings_from_final_quote()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  q quotes%rowtype;
begin
  if NEW.imported_from_ctdms then
    return NEW;
  end if;

  if TG_OP = 'UPDATE' then
    if NEW.dealer_discount is distinct from OLD.dealer_discount
       or NEW.selected_scheme_line_item_ids is distinct from OLD.selected_scheme_line_item_ids
       or (NEW.pricing_extras->'coupon_amount') is distinct from (OLD.pricing_extras->'coupon_amount')
       or (NEW.pricing_extras->'apply_mr_discount') is distinct from (OLD.pricing_extras->'apply_mr_discount') then
      raise exception 'A booking''s schemes and dealer discount come from its quote and cannot be changed';
    end if;
    return NEW;
  end if;

  if NEW.quote_id is null then
    -- Direct bookings carry no dealer discount, coupon or MR.
    NEW.dealer_discount := 0;
    NEW.pricing_extras := NEW.pricing_extras - 'coupon_amount' - 'apply_mr_discount';
    return NEW;
  end if;

  select * into q from quotes where id = NEW.quote_id;
  if q.id is null then
    raise exception 'Quote not found';
  end if;
  if q.current_stage <> 'final' then
    raise exception 'Finalise the quote before booking it';
  end if;

  NEW.variant_id := q.variant_id;
  NEW.color_id := q.color_id;
  NEW.rto_category_id := q.rto_category_id;
  NEW.price_list_type := q.price_list_type;
  NEW.insurance_option := q.insurance_option;
  NEW.include_extended_warranty := q.include_extended_warranty;
  NEW.insurance_plan_id := q.insurance_plan_id;
  NEW.insurance_addon_ids := q.insurance_addon_ids;
  NEW.accessory_ids := q.accessory_ids;
  NEW.vas_product_ids := q.vas_product_ids;
  NEW.selected_scheme_line_item_ids := q.selected_scheme_line_item_ids;
  NEW.dealer_discount := q.dealer_discount;
  NEW.pricing_extras := q.pricing_extras;
  NEW.customer_name := coalesce(nullif(btrim(NEW.customer_name), ''), q.customer_name);
  NEW.customer_mobile := coalesce(nullif(btrim(NEW.customer_mobile), ''), q.customer_mobile, q.customer_phone);
  NEW.enquiry_id := coalesce(NEW.enquiry_id, q.enquiry_id);
  if NEW.customer_id is null and NEW.enquiry_id is not null then
    select customer_id into NEW.customer_id from enquiries where id = NEW.enquiry_id;
  end if;
  return NEW;
end;
$$;

create or replace function submit_quote_stage(
  p_quote_id uuid, p_stage text, p_scheme_line_item_ids uuid[] default null, p_dealer_discount numeric default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  q quotes%rowtype;
  v_state text;
  v_amount numeric;
  v_role uuid;
  v_version uuid;
  v_approval uuid;
begin
  select * into q from quotes where id = p_quote_id for update;
  if q.id is null or not can_access_employee_data(current_employee_id(), q.employee_id) then
    raise exception 'Quote not found';
  end if;
  if q.status in ('converted', 'expired') then
    raise exception 'This quote is closed';
  end if;
  if q.current_stage = 'final' then
    raise exception 'This quote is final; start a new quote to change it';
  end if;
  if p_stage not in ('with_schemes', 'with_dealer_discount') then
    raise exception 'Unknown stage %', p_stage;
  end if;
  if p_stage = 'with_dealer_discount' and coalesce(p_dealer_discount, 0) <= 0 then
    raise exception 'Enter the additional dealer discount';
  end if;

  v_state := quote_stage_state(q.id);
  if quote_stage_index(p_stage) > quote_stage_index(q.current_stage) and v_state <> 'cleared' then
    raise exception 'The current stage is %; it must be approved before moving on', v_state;
  end if;

  -- The first submission keeps a record of the basic price.
  if not exists (select 1 from quote_versions where quote_id = q.id) then
    perform snapshot_quote_version(q.id);
  end if;
  -- A new submission replaces whatever was still waiting.
  update approvals set status = 'rejected', comment = 'Superseded by a newer submission', decided_at = now()
  where quote_id = q.id and status = 'pending';

  perform set_config('rt.quote_stage_rpc', 'on', true);
  if p_stage = 'with_schemes' then
    update quotes set current_stage = 'with_schemes', dealer_discount = 0,
      selected_scheme_line_item_ids = coalesce(p_scheme_line_item_ids, '{}')
    where id = q.id;
  else
    update quotes set current_stage = 'with_dealer_discount', dealer_discount = p_dealer_discount
    where id = q.id;
  end if;
  perform set_config('rt.quote_stage_rpc', 'off', true);

  select * into q from quotes where id = p_quote_id;
  v_amount := case when p_stage = 'with_schemes'
                   then coalesce((q.priced_snapshot->>'scheme_discount_customer_facing')::numeric, 0)
                   else q.dealer_discount end;
  v_role := approval_role_for(q.outlet_id, p_stage, v_amount);
  -- Below the margin floor (Phase 24) the Business Head decides, whatever the amount.
  if coalesce((q.priced_snapshot->>'margin_floor_breached')::boolean, false) then
    v_role := (select id from roles where name = 'Business Head');
  end if;
  v_version := snapshot_quote_version(q.id);

  if v_role is not null then
    insert into approvals (quote_id, quote_version_id, stage, requested_by_employee_id, required_role_id,
                           requested_discount_amount, status)
    values (q.id, v_version, p_stage, current_employee_id(), v_role, v_amount, 'pending')
    returning id into v_approval;
    update quote_versions set approval_id = v_approval where id = v_version;
  end if;

  return jsonb_build_object('stage', p_stage, 'version_id', v_version, 'total_amount', q.total_amount,
    'approval_required', v_role is not null, 'required_role', (select name from roles where id = v_role));
end;
$$;

create or replace function finalize_quote(p_quote_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  q quotes%rowtype;
  v_state text;
begin
  select * into q from quotes where id = p_quote_id for update;
  if q.id is null or not can_access_employee_data(current_employee_id(), q.employee_id) then
    raise exception 'Quote not found';
  end if;
  if q.current_stage = 'final' then
    raise exception 'This quote is already final';
  end if;
  if q.status in ('converted', 'expired') then
    raise exception 'This quote is closed';
  end if;
  v_state := quote_stage_state(q.id);
  if v_state <> 'cleared' then
    raise exception 'The current stage is %; it must be approved before the quote is final', v_state;
  end if;

  -- Below the margin floor the latest submission must carry the Business Head's approval.
  if coalesce((q.priced_snapshot->>'margin_floor_breached')::boolean, false) and not exists (
    select 1 from quote_versions v join approvals a on a.id = v.approval_id join roles r on r.id = a.required_role_id
    where v.quote_id = q.id and a.status = 'approved' and r.rank <= 1
      and v.version_no = (select max(version_no) from quote_versions where quote_id = q.id)
  ) then
    raise exception 'The discounts go below the margin floor (₹% available, ₹% given); submit the stage again for the Business Head''s approval',
      round(coalesce((q.priced_snapshot->>'margin_available')::numeric, 0)), round(coalesce((q.priced_snapshot->>'margin_used')::numeric, 0));
  end if;

  if not exists (select 1 from quote_versions where quote_id = q.id) then
    perform snapshot_quote_version(q.id);
  end if;
  perform set_config('rt.quote_stage_rpc', 'on', true);
  update quotes set current_stage = 'final', finalized_at = now() where id = q.id;
  perform set_config('rt.quote_stage_rpc', 'off', true);
  perform snapshot_quote_version(q.id);

  select * into q from quotes where id = p_quote_id;
  return jsonb_build_object('stage', 'final', 'total_amount', q.total_amount);
end;
$$;

create or replace trigger trg_quotes_recompute_pricing
  before insert or update of
    variant_id, color_id, outlet_id, rto_category_id, scrap_certificate_id,
    insurance_plan_id, insurance_addon_ids, accessory_ids, vas_product_ids,
    selected_scheme_line_item_ids, price_list_type, insurance_option, include_extended_warranty, dealer_discount,
    pricing_extras
  on quotes
  for each row execute function quotes_recompute_pricing();

create or replace trigger trg_bookings_recompute_pricing
  before insert or update of
    variant_id, color_id, outlet_id, rto_category_id, scrap_certificate_id,
    insurance_plan_id, insurance_addon_ids, accessory_ids, vas_product_ids,
    selected_scheme_line_item_ids, price_list_type, insurance_option, include_extended_warranty, dealer_discount,
    pricing_extras
  on bookings
  for each row execute function bookings_recompute_pricing();

create or replace trigger trg_bookings_00_from_final_quote
  before insert or update of dealer_discount, selected_scheme_line_item_ids, pricing_extras on bookings
  for each row execute function bookings_from_final_quote();

-- ===== Grants =====
revoke execute on function pricing_setting(text) from public, anon;
revoke execute on function insurance_premium(uuid, uuid, uuid[], text, numeric, date) from public, anon;
revoke execute on function insurance_quotes(uuid, uuid[], text) from public, anon;
revoke execute on function rto_calc(uuid, numeric, text, boolean) from public, anon;
revoke execute on function save_scheme_revision(jsonb) from public, anon;
revoke execute on function upsert_discount_rules(jsonb) from public, anon;
revoke execute on function accessories_for_variant(uuid) from public, anon;
revoke execute on function ew_options_for_variant(uuid) from public, anon;
grant execute on function pricing_setting(text) to authenticated;
grant execute on function insurance_premium(uuid, uuid, uuid[], text, numeric, date) to authenticated;
grant execute on function insurance_quotes(uuid, uuid[], text) to authenticated;
grant execute on function rto_calc(uuid, numeric, text, boolean) to authenticated;
grant execute on function save_scheme_revision(jsonb) to authenticated;
grant execute on function upsert_discount_rules(jsonb) to authenticated;
grant execute on function accessories_for_variant(uuid) to authenticated;
grant execute on function ew_options_for_variant(uuid) to authenticated;

-- ===== Menu =====
insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('catalog',        'masters', 'Cars & Variants',     '/masters/catalog',        20, true),
  ('insurance_rates','masters', 'Insurance Rates',     '/masters/insurance',      30, true),
  ('rto_settings',   'masters', 'RTO Settings',        '/masters/rto',            40, true),
  ('schemes',        'masters', 'Schemes',             '/masters/schemes',        50, true),
  ('discount_rules', 'masters', 'Variant Coupon Cap',  '/masters/discount-rules', 60, true);
select seed_role_rights('Outlet Head', 'catalog', array['view']);
select seed_role_rights('Outlet Head', 'insurance_rates', array['view']);
select seed_role_rights('Outlet Head', 'rto_settings', array['view']);
select seed_role_rights('Outlet Head', 'schemes', array['view']);
select seed_role_rights('Outlet Head', 'discount_rules', array['view']);
select seed_role_rights('Team Leader', 'schemes', array['view']);
select seed_role_rights('Insurance Executive', 'insurance_rates', array['view', 'edit']);
select seed_role_rights('RTO Executive', 'rto_settings', array['view', 'edit']);
