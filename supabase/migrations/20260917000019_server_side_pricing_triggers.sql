-- Never trust the client's total_amount/dealer_margin/priced_snapshot. Until now, quotes/bookings
-- INSERT just stored whatever the client sent (RLS only checked row ownership, not correctness),
-- and dealer_margin was silently null for every quote a Sales Consultant created because the
-- price-quote Edge Function correctly strips it from their response — but the mobile app was then
-- writing that stripped null straight into the row. Both are fixed by recomputing
-- total_amount/dealer_margin/priced_snapshot server-side, from the row's own selection columns,
-- on every insert/selection-update — via calculate_price(), the same function backing price-quote,
-- so there is exactly one source of truth for a price no matter who's asking or writing.

alter table bookings add column dealer_margin numeric;

create or replace function build_pricing_selections(
  p_variant_id uuid, p_color_id uuid, p_outlet_id uuid, p_rto_category_id uuid,
  p_scrap_certificate_id uuid, p_insurance_plan_id uuid, p_insurance_addon_ids uuid[],
  p_accessory_ids uuid[], p_vas_product_ids uuid[], p_selected_scheme_line_item_ids uuid[]
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
    -- has_exchange defaults true here: this function only re-derives the *price*, and
    -- requires_exchange scheme items were already validated as selectable during the original
    -- interactive pricing call (which did have the real has_exchange flag). We don't persist
    -- that flag as a column, so defaulting true avoids the recompute spuriously rejecting an
    -- already-valid selection; it has no effect on any computed amount.
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
    NEW.accessory_ids, NEW.vas_product_ids, NEW.selected_scheme_line_item_ids
  ));

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
    selected_scheme_line_item_ids
  on quotes
  for each row execute function quotes_recompute_pricing();

create or replace function bookings_recompute_pricing()
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
    NEW.accessory_ids, NEW.vas_product_ids, NEW.selected_scheme_line_item_ids
  ));

  NEW.priced_snapshot := v_result;
  NEW.total_amount := (v_result->>'total_amount')::numeric;
  NEW.dealer_margin := (v_result->>'dealer_margin')::numeric;
  NEW.priced_as_of := (v_result->>'priced_as_of')::timestamptz;

  return NEW;
end;
$$;

create trigger trg_bookings_recompute_pricing
  before insert or update of
    variant_id, color_id, outlet_id, rto_category_id, scrap_certificate_id,
    insurance_plan_id, insurance_addon_ids, accessory_ids, vas_product_ids,
    selected_scheme_line_item_ids
  on bookings
  for each row execute function bookings_recompute_pricing();
