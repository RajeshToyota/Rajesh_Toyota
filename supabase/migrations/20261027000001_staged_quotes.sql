-- Phase 8: staged quotes with stage approvals.
--
-- A quote moves Basic -> With company schemes -> With additional dealer discount -> Final:
--   * basic: list price only (schemes and discount are cleared on insert);
--   * with_schemes: the consultant's scheme picks; a Team Leader approves any scheme discount;
--   * with_dealer_discount: an extra discount out of dealer margin; Outlet Head approves up to
--     Rs 25,000, Business Head above (approval_rules, editable);
--   * final: locked; only a final quote can be booked, and the booking takes its selections.
-- Stage moves happen only in submit_quote_stage() / finalize_quote(), which snapshot every step
-- into quote_versions and raise the approval request. Approvals are decided only through
-- decide_approval(), which checks the approver's rank and that nobody approves their own request.

-- ===== Pricing: additional dealer discount =====
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

  -- 5. RTO: the dealer list's Road Tax & Registration when printed, else rto_pricing (variant-level
  -- pricing takes precedence over model-level). Then the scrap certificate.
  v_rto_amount := v_pl.road_tax_registration;

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
    'priced_as_of', now()
  );
end;
$$;

grant execute on function calculate_price(jsonb) to authenticated;

alter table quotes
  add column dealer_discount numeric not null default 0 check (dealer_discount >= 0),
  add column current_stage text not null default 'basic'
    check (current_stage in ('basic', 'with_schemes', 'with_dealer_discount', 'final')),
  add column finalized_at timestamptz;
create index idx_quotes_current_stage on quotes(current_stage);
alter table bookings add column dealer_discount numeric not null default 0 check (dealer_discount >= 0);

-- The 13-argument overload from 20261024000003 is left in place (unused).
create or replace function build_pricing_selections(
  p_variant_id uuid, p_color_id uuid, p_outlet_id uuid, p_rto_category_id uuid,
  p_scrap_certificate_id uuid, p_insurance_plan_id uuid, p_insurance_addon_ids uuid[],
  p_accessory_ids uuid[], p_vas_product_ids uuid[], p_selected_scheme_line_item_ids uuid[],
  p_list_type text, p_insurance_option text, p_include_extended_warranty boolean, p_dealer_discount numeric
) returns jsonb
language sql
stable
set search_path = public
as $$
  select build_pricing_selections(
    p_variant_id, p_color_id, p_outlet_id, p_rto_category_id, p_scrap_certificate_id, p_insurance_plan_id,
    p_insurance_addon_ids, p_accessory_ids, p_vas_product_ids, p_selected_scheme_line_item_ids,
    p_list_type, p_insurance_option, p_include_extended_warranty)
    || jsonb_build_object('dealer_discount', coalesce(p_dealer_discount, 0));
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
  ));

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
    ));
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

create or replace trigger trg_quotes_recompute_pricing
  before insert or update of
    variant_id, color_id, outlet_id, rto_category_id, scrap_certificate_id,
    insurance_plan_id, insurance_addon_ids, accessory_ids, vas_product_ids,
    selected_scheme_line_item_ids, price_list_type, insurance_option, include_extended_warranty, dealer_discount
  on quotes
  for each row execute function quotes_recompute_pricing();

create or replace trigger trg_bookings_recompute_pricing
  before insert or update of
    variant_id, color_id, outlet_id, rto_category_id, scrap_certificate_id,
    insurance_plan_id, insurance_addon_ids, accessory_ids, vas_product_ids,
    selected_scheme_line_item_ids, price_list_type, insurance_option, include_extended_warranty, dealer_discount
  on bookings
  for each row execute function bookings_recompute_pricing();

-- ===== Quote versions: one snapshot per stage submission =====
create table quote_versions (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  version_no int not null,
  stage text not null check (stage in ('basic', 'with_schemes', 'with_dealer_discount', 'final')),
  selected_scheme_line_item_ids uuid[] not null default '{}',
  dealer_discount numeric not null default 0,
  priced_snapshot jsonb,
  total_amount numeric,
  dealer_margin numeric,
  approval_id uuid references approvals(id),
  created_by uuid references employees(id),
  created_at timestamptz not null default now(),
  unique (quote_id, version_no)
);
create index idx_quote_versions_approval on quote_versions(approval_id);

alter table quote_versions enable row level security;
create policy quote_versions_select on quote_versions for select to authenticated using (
  exists (select 1 from quotes q where q.id = quote_id and can_access_employee_data(current_employee_id(), q.employee_id))
);
-- Written only by submit_quote_stage() / finalize_quote().

-- ===== Approvals by stage =====
alter table approvals
  add column stage text check (stage in ('with_schemes', 'with_dealer_discount')),
  add column quote_version_id uuid references quote_versions(id);
create index idx_approvals_quote_version on approvals(quote_version_id);

-- stage null = the rules for direct bookings (no staged quote). An approval is needed when the
-- amount is above discount_threshold; the highest threshold crossed decides the role.
alter table approval_rules add column stage text check (stage in ('with_schemes', 'with_dealer_discount'));
insert into approval_rules (outlet_id, stage, discount_threshold, required_role_id) values
  (null, 'with_schemes', 0, '00000000-0000-0000-0001-000000000005'),          -- Team Leader: any scheme discount
  (null, 'with_dealer_discount', 0, '00000000-0000-0000-0001-000000000003'),  -- Outlet Head: up to Rs 25,000
  (null, 'with_dealer_discount', 25000, '00000000-0000-0000-0001-000000000002'); -- Business Head: above

create or replace function approval_role_for(p_outlet_id uuid, p_stage text, p_amount numeric)
returns uuid
language sql
stable
set search_path = public
as $$
  select required_role_id from approval_rules
  where stage is not distinct from p_stage
    and (outlet_id = p_outlet_id or outlet_id is null)
    and coalesce(p_amount, 0) > discount_threshold
  order by discount_threshold desc, (outlet_id is not null) desc
  limit 1;
$$;

-- Approvals change only through the RPCs below (security definer, so not bound by these).
create policy approvals_no_direct_insert on approvals as restrictive for insert to authenticated with check (false);
create policy approvals_no_direct_update on approvals as restrictive for update to authenticated using (false);

-- ===== Guard: stages, schemes and dealer discount move only through the stage RPCs =====
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
       NEW.price_list_type, NEW.insurance_option, NEW.include_extended_warranty)
     is distinct from (
       OLD.variant_id, OLD.color_id, OLD.outlet_id, OLD.rto_category_id, OLD.scrap_certificate_id,
       OLD.insurance_plan_id, OLD.insurance_addon_ids, OLD.accessory_ids, OLD.vas_product_ids,
       OLD.price_list_type, OLD.insurance_option, OLD.include_extended_warranty) then
    raise exception 'This quote is past the basic stage; start a new quote to change the vehicle or add-ons';
  end if;
  return NEW;
end;
$$;
-- Named to run before trg_quotes_recompute_pricing, so an insert is priced without schemes.
create trigger trg_quotes_00_stage_guard before insert or update on quotes
  for each row execute function quotes_stage_guard();

-- ===== Bookings take the final quote's selections =====
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
       or NEW.selected_scheme_line_item_ids is distinct from OLD.selected_scheme_line_item_ids then
      raise exception 'A booking''s schemes and dealer discount come from its quote and cannot be changed';
    end if;
    return NEW;
  end if;

  if NEW.quote_id is null then
    -- Direct bookings carry no dealer discount; their scheme discount is approved via
    -- request_booking_approval().
    NEW.dealer_discount := 0;
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
  return NEW;
end;
$$;
-- Runs before trg_bookings_default_crm_sync and trg_bookings_recompute_pricing.
create trigger trg_bookings_00_from_final_quote
  before insert or update of dealer_discount, selected_scheme_line_item_ids on bookings
  for each row execute function bookings_from_final_quote();

-- ===== Stage RPCs =====
create or replace function quote_stage_index(p_stage text)
returns int
language sql
immutable
set search_path = public
as $$
  select case p_stage when 'basic' then 1 when 'with_schemes' then 2 when 'with_dealer_discount' then 3 when 'final' then 4 end;
$$;

-- The current stage is cleared when its latest submission needed no approval or was approved.
-- 'pending' / 'rejected' otherwise.
create or replace function quote_stage_state(p_quote_id uuid)
returns text
language sql
stable
set search_path = public
as $$
  select coalesce((
    select case when v.approval_id is null then 'cleared'
                else (select case status when 'approved' then 'cleared' else status end from approvals where id = v.approval_id) end
    from quote_versions v where v.quote_id = p_quote_id
    order by v.version_no desc limit 1), 'cleared');
$$;

create or replace function snapshot_quote_version(p_quote_id uuid)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  q quotes%rowtype;
  v_id uuid;
begin
  select * into q from quotes where id = p_quote_id;
  insert into quote_versions (quote_id, version_no, stage, selected_scheme_line_item_ids, dealer_discount,
                              priced_snapshot, total_amount, dealer_margin, created_by)
  values (q.id, coalesce((select max(version_no) from quote_versions where quote_id = q.id), 0) + 1, q.current_stage,
          q.selected_scheme_line_item_ids, q.dealer_discount, q.priced_snapshot, q.total_amount, q.dealer_margin,
          current_employee_id())
  returning id into v_id;
  return v_id;
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

-- Approve or reject. The approver must hold the required role or a more senior one, have the
-- requester in their visibility, and not be the requester.
create or replace function decide_approval(p_approval_id uuid, p_decision text, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a approvals%rowtype;
  v_caller uuid := current_employee_id();
  v_required_rank int;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;
  select * into a from approvals where id = p_approval_id for update;
  if a.id is null or v_caller is null then
    raise exception 'Approval not found';
  end if;
  if a.status <> 'pending' then
    raise exception 'This request was already %', a.status;
  end if;
  if a.requested_by_employee_id = v_caller then
    raise exception 'You cannot approve your own request';
  end if;
  select rank into v_required_rank from roles where id = a.required_role_id;
  if current_employee_role_rank() is null or current_employee_role_rank() > v_required_rank
     or not can_access_employee_data(v_caller, a.requested_by_employee_id) then
    raise exception 'This request needs a % or above in the requester''s line', (select name from roles where id = a.required_role_id);
  end if;

  update approvals
  set status = p_decision, approver_employee_id = v_caller, comment = nullif(btrim(p_comment), ''), decided_at = now()
  where id = a.id;
end;
$$;

-- Direct bookings (no staged quote): request approval for the booking's scheme discount.
create or replace function request_booking_approval(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  v_amount numeric;
  v_role uuid;
begin
  select * into b from bookings where id = p_booking_id;
  if b.id is null or not can_access_employee_data(current_employee_id(), b.employee_id) then
    raise exception 'Booking not found';
  end if;
  if b.quote_id is not null then
    -- Booked from a final quote, whose stages were approved already.
    return jsonb_build_object('approval_required', false);
  end if;
  v_amount := coalesce((b.priced_snapshot->>'scheme_discount_customer_facing')::numeric, 0);
  v_role := approval_role_for(b.outlet_id, null, v_amount);
  if v_role is not null and not exists (select 1 from approvals where booking_id = b.id and status = 'pending') then
    insert into approvals (booking_id, requested_by_employee_id, required_role_id, requested_discount_amount, status)
    values (b.id, current_employee_id(), v_role, v_amount, 'pending');
  end if;
  return jsonb_build_object('approval_required', v_role is not null, 'required_role', (select name from roles where id = v_role));
end;
$$;

-- ===== Grants =====
revoke execute on function submit_quote_stage(uuid, text, uuid[], numeric) from public, anon;
revoke execute on function finalize_quote(uuid) from public, anon;
revoke execute on function decide_approval(uuid, text, text) from public, anon;
revoke execute on function request_booking_approval(uuid) from public, anon;
revoke execute on function approval_role_for(uuid, text, numeric) from public, anon, authenticated;
revoke execute on function quote_stage_state(uuid) from public, anon, authenticated;
revoke execute on function snapshot_quote_version(uuid) from public, anon, authenticated;
revoke execute on function quotes_stage_guard() from public, anon, authenticated;
revoke execute on function bookings_from_final_quote() from public, anon, authenticated;
grant execute on function submit_quote_stage(uuid, text, uuid[], numeric) to authenticated;
grant execute on function finalize_quote(uuid) to authenticated;
grant execute on function decide_approval(uuid, text, text) to authenticated;
grant execute on function request_booking_approval(uuid) to authenticated;
