-- RTO worked out the Techwheels way, and one price-list row per variant.
--
-- 1. RTO (Normal registration only), as TECHWHEELS-WEB src/lib/pricing/rto.js computes it:
--      MV tax    = ex-showroom x MV tax rate          (0 for EV)
--      surcharge = 12.5% of MV tax
--      green tax = by engine cc, from green_tax_slabs (0 for EV)
--      total     = new registration + hypothecation addition + duplicate tax card
--                  + MV tax + surcharge + green tax
--    The fixed charges live in rto_settings (one row), the MV tax rate on each price-list row (it
--    differs between the private and commercial lists), the engine cc on the variant. Until those
--    are filled in, the list's printed Road Tax & Registration keeps being used.
-- 2. The price list holds one row per variant x list x state x effective date. Every colour of a
--    variant is sold at that price unless Variant <-> Color gives the colour an extra cost. The
--    Pearl White / dual-tone rows become extra costs on those colours, the per-colour rows become a
--    single row, and the rows folded in are moved to price_list_archive (nothing is lost).

-- ===== RTO inputs =====
create table rto_settings (
  id boolean primary key default true check (id),
  new_registration numeric not null default 0,
  hypothecation_addition numeric not null default 0,
  duplicate_tax_card numeric not null default 0,
  surcharge_percent numeric not null default 12.5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table rto_settings is 'Single row: fixed RTO charges (as Techwheels rto_settings). No row = RTO formula not configured.';
create trigger trg_rto_settings_updated_at before update on rto_settings for each row execute function set_updated_at();

create table green_tax_slabs (
  id uuid primary key default gen_random_uuid(),
  min_cc int not null,
  max_cc int not null,
  amount numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (max_cc >= min_cc)
);
create trigger trg_green_tax_slabs_updated_at before update on green_tax_slabs for each row execute function set_updated_at();

alter table rto_settings enable row level security;
alter table green_tax_slabs enable row level security;
create policy rto_settings_select on rto_settings for select to authenticated using (true);
create policy rto_settings_write on rto_settings for all to authenticated
  using (is_master_data_admin()) with check (is_master_data_admin());
create policy green_tax_slabs_select on green_tax_slabs for select to authenticated using (true);
create policy green_tax_slabs_write on green_tax_slabs for all to authenticated
  using (is_master_data_admin()) with check (is_master_data_admin());

alter table variants add column engine_cc int check (engine_cc is null or engine_cc > 0);

alter table price_list
  add column mv_tax_rate numeric check (mv_tax_rate is null or (mv_tax_rate >= 0 and mv_tax_rate <= 100)),
  -- Normal-registration RTO at this row's ex-showroom price: the formula when configured, else the
  -- printed Road Tax & Registration. Maintained by triggers; read-only for users.
  add column rto_amount numeric;
comment on column price_list.mv_tax_rate is 'MV (road) tax rate in percent, e.g. 10 for 10%.';
comment on column price_list.road_tax_registration is 'Road Tax & Registration as printed on the TKM list.';

-- ===== The formula =====
-- Returns null when it cannot be worked out yet (no MV tax rate, no rto_settings row, or a non-EV
-- variant with no engine cc while green-tax slabs exist), so callers fall back to the printed figure.
create or replace function rto_normal(p_variant_id uuid, p_ex_showroom numeric, p_mv_tax_rate numeric)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  s rto_settings%rowtype;
  v_engine_cc int;
  v_fuel text;
  v_is_ev boolean;
  v_mv numeric;
  v_surcharge numeric;
  v_green numeric := 0;
  v_fixed numeric;
begin
  if p_mv_tax_rate is null or p_ex_showroom is null then return null; end if;
  select * into s from rto_settings limit 1;
  if not found then return null; end if;

  select v.engine_cc, lower(f.name) into v_engine_cc, v_fuel
  from variants v left join fuel_types f on f.id = v.fuel_type_id
  where v.id = p_variant_id;
  v_is_ev := v_fuel in ('ev', 'electric');

  v_mv := case when v_is_ev then 0 else round(p_ex_showroom * p_mv_tax_rate / 100) end;
  v_surcharge := round(v_mv * s.surcharge_percent / 100);

  if not v_is_ev then
    if v_engine_cc is null then
      if exists (select 1 from green_tax_slabs) then return null; end if;
    else
      select round(amount) into v_green from green_tax_slabs
      where min_cc <= v_engine_cc and max_cc >= v_engine_cc
      order by min_cc desc limit 1;
      v_green := coalesce(v_green, 0);
    end if;
  end if;

  v_fixed := round(s.new_registration) + round(s.hypothecation_addition) + round(s.duplicate_tax_card);
  return jsonb_build_object(
    'reg_type', 'Normal',
    'new_registration', round(s.new_registration),
    'hypothecation_addition', round(s.hypothecation_addition),
    'duplicate_tax_card', round(s.duplicate_tax_card),
    'mv_tax', v_mv,
    'surcharge_mv_tax', v_surcharge,
    'green_tax', v_green,
    'total', v_fixed + v_mv + v_surcharge + v_green
  );
end;
$$;
grant execute on function rto_normal(uuid, numeric, numeric) to authenticated;

create or replace function price_list_set_rto_amount()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  NEW.rto_amount := coalesce(
    (rto_normal(NEW.variant_id, NEW.ex_showroom_price, NEW.mv_tax_rate)->>'total')::numeric,
    NEW.road_tax_registration);
  return NEW;
end;
$$;
create trigger trg_price_list_rto_amount before insert or update on price_list
  for each row execute function price_list_set_rto_amount();

-- Recompute stored RTO amounts when an input changes elsewhere.
create or replace function refresh_price_list_rto(p_variant_id uuid default null)
returns void
language sql
set search_path = public
as $$
  update price_list pl
  set rto_amount = coalesce((rto_normal(pl.variant_id, pl.ex_showroom_price, pl.mv_tax_rate)->>'total')::numeric,
                            pl.road_tax_registration)
  where (p_variant_id is null or pl.variant_id = p_variant_id)
    and pl.rto_amount is distinct from coalesce(
      (rto_normal(pl.variant_id, pl.ex_showroom_price, pl.mv_tax_rate)->>'total')::numeric, pl.road_tax_registration);
$$;

create or replace function rto_inputs_changed()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if TG_TABLE_NAME = 'variants' then
    perform refresh_price_list_rto(NEW.id);
  else
    perform refresh_price_list_rto(null);
  end if;
  return null;
end;
$$;
create trigger trg_rto_settings_refresh after insert or update or delete on rto_settings
  for each statement execute function rto_inputs_changed();
create trigger trg_green_tax_slabs_refresh after insert or update or delete on green_tax_slabs
  for each statement execute function rto_inputs_changed();
create trigger trg_variants_rto_refresh after update of engine_cc, fuel_type_id on variants
  for each row when (OLD.engine_cc is distinct from NEW.engine_cc or OLD.fuel_type_id is distinct from NEW.fuel_type_id)
  execute function rto_inputs_changed();

-- ===== One row per variant: fold colour / paint rows =====
create table price_list_archive (like price_list including defaults);
alter table price_list_archive add column archived_at timestamptz not null default now(),
  add column archive_reason text not null;
alter table price_list_archive enable row level security;
create policy price_list_archive_select on price_list_archive for select to authenticated using (true);

-- a) Pearl White / dual-tone rows -> extra cost on that variant's colours of that paint. The
--    difference is the same on every list, so the private list's (else any list's) is used.
--    Colours that already carry an extra cost are left as they are.
with paint_diff as (
  select distinct on (p.variant_id, p.paint_category)
    p.variant_id, p.paint_category, p.ex_showroom_price - s.ex_showroom_price as diff
  from price_list p
  join price_list s on s.variant_id = p.variant_id and s.list_type = p.list_type and s.state = p.state
    and s.color_id is null and s.paint_category = 'standard' and s.effective_from = p.effective_from
    and s.effective_to is not distinct from p.effective_to
  where p.color_id is null and p.paint_category <> 'standard'
  order by p.variant_id, p.paint_category, (p.list_type = 'private') desc, p.effective_from desc
)
update variant_colors vc
set extra_cost = d.diff
from paint_diff d, colors c
where vc.variant_id = d.variant_id and c.id = vc.color_id and c.paint_category = d.paint_category
  and vc.extra_cost = 0 and d.diff <> 0;

-- b) Current per-colour rows with no colour-less row for the same variant / list / state / dates
--    -> one row at the lowest colour price; any colour priced above it gets the difference as extra
--    cost. Expired per-colour lists were superseded by the current colour-less rows (often from the
--    same start date), so they only go to the archive.
create temporary table pl_colour_groups on commit drop as
select p.variant_id, p.list_type, p.state, p.effective_from, p.effective_to,
       min(p.ex_showroom_price) as base_price
from price_list p
where p.color_id is not null
  and (p.effective_to is null or p.effective_to >= current_date)
  and not exists (
    select 1 from price_list s
    where s.variant_id = p.variant_id and s.list_type = p.list_type and s.state = p.state
      and s.color_id is null and s.paint_category = 'standard'
      and s.effective_from = p.effective_from and s.effective_to is not distinct from p.effective_to)
group by 1, 2, 3, 4, 5;

insert into price_list (variant_id, color_id, list_type, paint_category, state, ex_showroom_price,
  dealer_purchase_price, tcs_amount, road_tax_registration, insurance_options, fastag_amount,
  ew_5th_year_amount, tgloss_package_amount, tga_combo_amount, essential_kit_amount,
  smile_package_amount, on_road_listed, source_file, effective_from, effective_to)
select distinct on (g.variant_id, g.list_type, g.state, g.effective_from, g.effective_to)
  p.variant_id, null, p.list_type, 'standard', p.state, p.ex_showroom_price,
  p.dealer_purchase_price, p.tcs_amount, p.road_tax_registration, p.insurance_options, p.fastag_amount,
  p.ew_5th_year_amount, p.tgloss_package_amount, p.tga_combo_amount, p.essential_kit_amount,
  p.smile_package_amount, p.on_road_listed, p.source_file, p.effective_from, p.effective_to
from pl_colour_groups g
join price_list p on p.variant_id = g.variant_id and p.list_type = g.list_type and p.state = g.state
  and p.effective_from = g.effective_from and p.effective_to is not distinct from g.effective_to
  and p.color_id is not null and p.ex_showroom_price = g.base_price
order by g.variant_id, g.list_type, g.state, g.effective_from, g.effective_to, p.created_at;

update variant_colors vc
set extra_cost = p.ex_showroom_price - g.base_price
from price_list p
join pl_colour_groups g on g.variant_id = p.variant_id and g.list_type = p.list_type and g.state = p.state
  and g.effective_from = p.effective_from and g.effective_to is not distinct from p.effective_to
where p.color_id is not null and vc.variant_id = p.variant_id and vc.color_id = p.color_id
  and p.list_type = 'private'
  and vc.extra_cost = 0 and p.ex_showroom_price > g.base_price;

-- c) Archive and remove everything that is not a colour-less standard row.
insert into price_list_archive
select p.*, now(), case when p.color_id is not null then 'per-colour row' else p.paint_category || ' paint row' end
from price_list p
where p.color_id is not null or p.paint_category <> 'standard';
delete from price_list where color_id is not null or paint_category <> 'standard';

-- d) Keep it that way.
alter table price_list add constraint price_list_one_row_per_variant
  check (color_id is null and paint_category = 'standard');
create unique index uq_price_list_variant_list_state_from
  on price_list(variant_id, list_type, state, effective_from);

-- Stored RTO amounts for the rows that remain.
update price_list set rto_amount = road_tax_registration;

-- ===== Pricing engine =====
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
  v_pl price_list%rowtype;
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

  -- 1. Price-list row, as of the pricing date: one row per variant / list / state. Every colour
  -- of the variant is sold at that price unless Variant <-> Color gives the colour an extra cost.
  select * into v_pl
  from price_list
  where variant_id = v_variant_id and state = v_state and list_type = v_list_type
    and effective_from <= v_as_of_date and (effective_to is null or effective_to >= v_as_of_date)
  order by effective_from desc
  limit 1;

  v_ex_showroom := v_pl.ex_showroom_price;
  if v_ex_showroom is null then
    raise exception 'No active % price_list entry for variant % / color % / state % as of %', v_list_type, v_variant_id, v_color_id, v_state, v_as_of_date;
  end if;

  -- Colour price difference (e.g. Pearl White, dual tone), from Variant <-> Color.
  select extra_cost into v_color_extra from variant_colors where variant_id = v_variant_id and color_id = v_color_id;
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
    select sli.line_type, sli.tkm_share, sli.dealer_share, sli.is_customer_facing
    from scheme_line_items sli
    where sli.id = any(v_selected_scheme_ids)
  loop
    if rec.is_customer_facing then
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

  v_tcs_amount := round((v_ex_showroom + v_color_extra - v_scheme_discount - v_dealer_discount) * v_tcs_rate / 100, 2);
  v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','tax','label', format('TCS @ %s%%', v_tcs_rate), 'amount', v_tcs_amount));

  -- 5. RTO (Normal registration), worked out as Techwheels does (rto_normal) on the ex-showroom
  -- price including the colour difference. Until the row's MV tax rate and the RTO settings are
  -- filled in, the list's printed Road Tax & Registration is used, then rto_pricing (variant-level
  -- pricing takes precedence over model-level). Then the scrap certificate.
  v_rto_amount := (rto_normal(v_variant_id, v_ex_showroom + v_color_extra, v_pl.mv_tax_rate)->>'total')::numeric;
  if v_rto_amount is null then
    v_rto_amount := v_pl.road_tax_registration;
  end if;

  if v_rto_amount is null then
    if v_rto_category_id is null then
      raise exception 'rto_category_id is required when the price list has no Road Tax & Registration amount';
    end if;

    select amount into v_rto_amount
    from rto_pricing
    where rto_category_id = v_rto_category_id and state = v_state
      and (variant_id = v_variant_id or (variant_id is null and model_id = v_model_id))
      and effective_from <= v_as_of_date and (effective_to is null or effective_to >= v_as_of_date)
    order by variant_id nulls last, effective_from desc
    limit 1;
  end if;

  if v_rto_amount is null then
    raise exception 'No active rto_pricing entry for category % / state % / variant % as of %', v_rto_category_id, v_state, v_variant_id, v_as_of_date;
  end if;

  v_line_items := v_line_items || jsonb_build_array(jsonb_build_object('type','rto','label','RTO & Registration','amount',v_rto_amount));

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

  -- 9. Total
  v_total := v_ex_showroom + v_color_extra - v_scheme_discount - v_dealer_discount + v_tcs_amount + v_rto_amount - v_scrap_amount
             + v_insurance_amount + v_fastag_amount + v_ew_amount + v_accessories_amount + v_vas_amount;

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
    'mv_tax_rate', v_pl.mv_tax_rate,
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
    'priced_as_of', now()
  );
end;
$$;

grant execute on function calculate_price(jsonb) to authenticated;

grant execute on function calculate_price(jsonb) to authenticated;
