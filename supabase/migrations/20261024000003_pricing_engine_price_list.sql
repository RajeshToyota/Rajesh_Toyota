-- Pricing engine now reads the full dealer price list (see 20261024000001): Road Tax &
-- Registration, the printed insurance options, FASTag and the 5th-year extended warranty come
-- straight from the list. New optional selections:
--   "list_type": "private" | "commercial" | "csd"   (default "private")
--   "insurance_option": "advance" | "premium" | "premium_3plus3" | "luxury"   (falls back to insurance_plan_id)
--   "include_extended_warranty": boolean
-- rto_category_id is now only needed when the list has no Road Tax & Registration amount.
-- Built on the 20260918000004 version (suffix_scope_list, insurance_pricing, margin rules).

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

  -- 4. TCS, on (price - customer-facing discount), at the configured rate.
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

  v_tcs_amount := round((v_ex_showroom + v_color_extra - v_scheme_discount) * v_tcs_rate / 100, 2);
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
  v_total := v_ex_showroom + v_color_extra - v_scheme_discount + v_tcs_amount + v_rto_amount - v_scrap_amount
             + v_insurance_amount + v_fastag_amount + v_ew_amount + v_accessories_amount + v_vas_amount;

  return jsonb_build_object(
    'as_of_date', v_as_of_date,
    'ex_showroom_price', v_ex_showroom,
    'color_extra_cost', v_color_extra,
    'scheme_discount_customer_facing', v_scheme_discount,
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

-- ===== Server-side recompute: carry the new selections through =====
drop trigger trg_quotes_recompute_pricing on quotes;
drop trigger trg_bookings_recompute_pricing on bookings;
drop function build_pricing_selections(uuid, uuid, uuid, uuid, uuid, uuid, uuid[], uuid[], uuid[], uuid[]);

create or replace function build_pricing_selections(
  p_variant_id uuid, p_color_id uuid, p_outlet_id uuid, p_rto_category_id uuid,
  p_scrap_certificate_id uuid, p_insurance_plan_id uuid, p_insurance_addon_ids uuid[],
  p_accessory_ids uuid[], p_vas_product_ids uuid[], p_selected_scheme_line_item_ids uuid[],
  p_list_type text, p_insurance_option text, p_include_extended_warranty boolean
) returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_state text;
  v_scrap jsonb;
begin
  select state into v_state from outlets where id = p_outlet_id;

  if p_scrap_certificate_id is not null then
    select jsonb_build_object('source', source, 'amount', coalesce(amount, 0))
    into v_scrap
    from scrap_certificates where id = p_scrap_certificate_id;
  end if;

  return jsonb_build_object(
    'variant_id', p_variant_id,
    'color_id', p_color_id,
    'state', v_state,
    'rto_category_id', p_rto_category_id,
    'scrap', v_scrap,
    'insurance_plan_id', p_insurance_plan_id,
    'insurance_addon_ids', coalesce(to_jsonb(p_insurance_addon_ids), '[]'::jsonb),
    'accessory_ids', coalesce(to_jsonb(p_accessory_ids), '[]'::jsonb),
    'vas_product_ids', coalesce(to_jsonb(p_vas_product_ids), '[]'::jsonb),
    'selected_scheme_line_item_ids', coalesce(to_jsonb(p_selected_scheme_line_item_ids), '[]'::jsonb),
    'list_type', p_list_type,
    'insurance_option', p_insurance_option,
    'include_extended_warranty', coalesce(p_include_extended_warranty, false),
    -- See 20260917000019: the flag is not persisted, and the selection was already validated.
    'has_exchange', true,
    'has_scrap', p_scrap_certificate_id is not null
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
    NEW.price_list_type, NEW.insurance_option, NEW.include_extended_warranty
  ));

  NEW.priced_snapshot := v_result;
  NEW.total_amount := (v_result->>'total_amount')::numeric;
  NEW.dealer_margin := (v_result->>'dealer_margin')::numeric;
  NEW.priced_as_of := (v_result->>'priced_as_of')::timestamptz;

  return NEW;
end;
$$;

-- Orders imported from CTDMS keep their CTDMS figures until a consultant completes the booking:
-- they are priced only once variant and colour are mapped, and a pricing failure (e.g. no list row
-- for an older suffix) leaves them unpriced instead of rejecting the import.
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
      NEW.price_list_type, NEW.insurance_option, NEW.include_extended_warranty
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

create trigger trg_quotes_recompute_pricing
  before insert or update of
    variant_id, color_id, outlet_id, rto_category_id, scrap_certificate_id,
    insurance_plan_id, insurance_addon_ids, accessory_ids, vas_product_ids,
    selected_scheme_line_item_ids, price_list_type, insurance_option, include_extended_warranty
  on quotes
  for each row execute function quotes_recompute_pricing();

create trigger trg_bookings_recompute_pricing
  before insert or update of
    variant_id, color_id, outlet_id, rto_category_id, scrap_certificate_id,
    insurance_plan_id, insurance_addon_ids, accessory_ids, vas_product_ids,
    selected_scheme_line_item_ids, price_list_type, insurance_option, include_extended_warranty
  on bookings
  for each row execute function bookings_recompute_pricing();
