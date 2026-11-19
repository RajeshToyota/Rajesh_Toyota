-- Catalog & pricing masters (Phase 24):
--   - insurance engine: worked premium, mandatory add-ons, an insurer without a mandatory rate cannot quote,
--     cheapest insurer first, and calculate_price takes the insurer path
--   - RTO formula: normal, BH, scrap rebate cap, transfer; BH registration on a quote
--   - ceramic coating, coupon cap, approved MR discount, margin floor -> Business Head
--   - scheme categories and previous model-year amounts; save_scheme_revision splits and never overlaps
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/catalog_pricing_masters.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000002'), ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000004'),
  ('a0000000-0000-0000-0000-000000000005');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000002', '00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000004',
             '00000000-0000-0000-0003-000000000005');

create temp table t_ids (k text primary key, id uuid);
grant all on t_ids to authenticated;
insert into t_ids select 'v', id from variants where tkm_suffix_code = 'D22U4';
insert into t_ids select 'c', id from colors where tkm_color_code = 'ZHJ';
insert into t_ids select 'm', model_id from variants where tkm_suffix_code = 'D22U4';

create or replace function pg_temp.as_user(n int) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;
create or replace function pg_temp.expect_error(sql text, msg text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if sqlerrm not like msg || '%' then raise exception 'expected "%" but got "%"', msg, sqlerrm; end if;
    return;
  end;
  raise exception 'expected error "%" from: %', msg, sql;
end $$;
create or replace function pg_temp.sel(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object('variant_id', (select id from t_ids where k = 'v'), 'color_id', (select id from t_ids where k = 'c'),
                            'state', 'Rajasthan', 'rto_category_id', '00000000-0000-0000-000b-000000000001') || extra;
$$;

-- ===== Master data, as the Business Head would enter it =====
insert into insurance_providers (id, name) values
  ('10000000-0000-0000-0000-000000000001', 'Insurer A'), ('10000000-0000-0000-0000-000000000002', 'Insurer B'),
  ('10000000-0000-0000-0000-000000000003', 'Insurer C');
insert into insurance_addons (id, name, price, is_mandatory) values
  ('20000000-0000-0000-0000-000000000001', 'Consumables Cover', 0, true);
insert into insurance_rates (variant_id, tp_type_code, idv_amount, od_amount, tp_amount, other_charges)
select id, '1+3', 1900000, 40000, 10000, 500 from t_ids where k = 'v';
insert into insurance_od_discounts (variant_id, discount_percent, is_enabled)
select id, x.p, x.e from t_ids, (values (50, true), (70, true), (80, false)) x(p, e) where k = 'v';
insert into insurance_other_charges (tp_type_code, amount) values ('1+3', 100);
-- A: zero dep 0.4% + consumables 0.1%; B: zero dep 0.3% + consumables 0.1% (cheaper); C: no consumables rate.
insert into insurance_addon_rates (provider_id, addon_id, tp_type_code, rate_percent)
select '10000000-0000-0000-0000-000000000001'::uuid, id, '1+3', 0.4 from insurance_addons where name = 'Zero Depreciation'
union all select '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '1+3', 0.1
union all select '10000000-0000-0000-0000-000000000002', id, '1+3', 0.3 from insurance_addons where name = 'Zero Depreciation'
union all select '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '1+3', 0.1
union all select '10000000-0000-0000-0000-000000000003', id, '1+3', 0.2 from insurance_addons where name = 'Zero Depreciation';

update variants set gst_rate_percent = 28, engine_cc = 1490 where id = (select id from t_ids where k = 'v');
-- Private list: fixed charges 4,200 (seeded by 20261118000009), BH fee 2,000; the row: MV tax 10%, green tax 1,000.
update rto_settings set bh_processing_fee = 2000 where list_type = 'private';
update price_list set mv_tax_rate = 10, green_tax = 1000, extra_rto_charges = 0
where variant_id = (select id from t_ids where k = 'v') and list_type = 'private';
insert into ceramic_coating_prices (id, model_id, price) select '30000000-0000-0000-0000-000000000001', id, 25000 from t_ids where k = 'm';
-- Dealer cost: margin before discounts = 19,99,000 - 19,50,000 = 49,000.
update price_list set dealer_purchase_price = 1950000
where variant_id = (select id from t_ids where k = 'v') and paint_category = 'standard' and list_type = 'private';

set local role authenticated;
select pg_temp.as_user(5);

-- ===== Insurance =====
do $$
declare
  b jsonb;
  n int;
begin
  -- A: net OD = 40,000 - 70% = 12,000; add-ons 1,900,000 × 0.5% = 9,500; other 500 + 100;
  -- taxable = 12,000 + 10,000 + 600 + 9,500 = 32,100; GST 18% = 5,778; premium 37,878.
  b := insurance_premium((select id from t_ids where k = 'v'), '10000000-0000-0000-0000-000000000001');
  if (b->>'od_discount_percent')::numeric <> 70 or (b->>'net_od')::numeric <> 12000 or (b->>'addons_amount')::numeric <> 9500
     or (b->>'taxable')::numeric <> 32100 or (b->>'premium')::numeric <> 37878 then
    raise exception 'insurer A premium wrong: %', b;
  end if;
  if insurance_premium((select id from t_ids where k = 'v'), '10000000-0000-0000-0000-000000000003') is not null then
    raise exception 'an insurer without a mandatory add-on rate cannot quote';
  end if;
  select count(*) into n from insurance_quotes((select id from t_ids where k = 'v'));
  if n <> 2 then raise exception 'two insurers should quote, got %', n; end if;
  if (select provider from insurance_quotes((select id from t_ids where k = 'v')) where is_cheapest) <> 'Insurer B' then
    raise exception 'B should be cheapest';
  end if;
  b := calculate_price(pg_temp.sel(jsonb_build_object('insurance_provider_id', '10000000-0000-0000-0000-000000000001')));
  if (b->>'insurance_amount')::numeric <> 37878 or b->'insurance_breakdown'->>'provider' <> 'Insurer A' then
    raise exception 'calculate_price insurer path wrong: %', b->'insurance_amount';
  end if;
end $$;

-- ===== RTO =====
do $$
declare
  r jsonb;
  b jsonb;
begin
  -- Normal: MV 10% of 19,99,000 = 1,99,900; surcharge 24,988 (12.5%, rounded); green 1,000;
  -- fixed 4,200 → 2,30,088.
  r := rto_calc((select id from t_ids where k = 'v'), 1999000, 'NORMAL', 'private', 10, 1000, 0);
  if (r->>'mv_tax')::numeric <> 199900 or (r->>'surcharge_mv_tax')::numeric <> 24988 or (r->>'total')::numeric <> 230088 then
    raise exception 'normal RTO wrong: %', r;
  end if;
  -- Without the row's inputs, the variant's current price-list row supplies them.
  if (rto_calc((select id from t_ids where k = 'v'), 1999000)->>'total')::numeric <> 230088 then
    raise exception 'price-list inputs: %', rto_calc((select id from t_ids where k = 'v'), 1999000);
  end if;
  -- BH: 19,99,000 / 1.28 × 10% / 6 = 26,029 (rounded) + green 1,000 + fixed 4,200 + BH fee 2,000 = 33,229.
  r := rto_calc((select id from t_ids where k = 'v'), 1999000, 'BH', 'private', 10, 1000, 0);
  if (r->>'mv_tax')::numeric <> 26029 or (r->>'total')::numeric <> 33229 then raise exception 'BH RTO wrong: %', r; end if;
  -- Scrap: rebate 26% of (1,99,900 + 24,988) = 58,471.
  r := rto_calc((select id from t_ids where k = 'v'), 1999000, 'SCRAP', 'private', 10, 1000, 0);
  if (r->>'rebate_waiver')::numeric <> 58471 or (r->>'total')::numeric <> 230088 - 58471 then raise exception 'scrap RTO wrong: %', r; end if;
  -- The cap: a ₹1 crore car.
  if (rto_calc((select id from t_ids where k = 'v'), 10000000, 'SCRAP', 'private', 10, 1000, 0)->>'rebate_waiver')::numeric <> 100000 then
    raise exception 'scrap rebate should be capped';
  end if;
  if (rto_calc((select id from t_ids where k = 'v'), 1999000, 'TRANSFER')->>'total')::numeric <> 1000 then
    raise exception 'transfer is flat';
  end if;
  if rto_calc((select id from t_ids where k = 'v'), 1999000, 'BH', 'private', null, null, null) is null then
    raise exception 'the row''s MV tax rate is used when none is given';
  end if;
  b := calculate_price(pg_temp.sel('{"rto_type": "BH"}'));
  if (b->>'rto_amount')::numeric <> 33229 or b->>'rto_type' <> 'BH' then raise exception 'BH on the quote: %', b->>'rto_amount'; end if;
  -- Normal keeps 20261118000009's path: the formula on the row.
  b := calculate_price(pg_temp.sel('{}'));
  if (b->>'rto_amount')::numeric <> 230088 then raise exception 'normal RTO on the quote: %', b->>'rto_amount'; end if;
end $$;

-- ===== Ceramic, coupon, MR, margin floor =====
select pg_temp.expect_error($$select calculate_price(pg_temp.sel('{"coupon_amount": 15000}'))$$, 'Coupon of 15000 is above this variant''s cap of 10000');
select pg_temp.expect_error($$select calculate_price(pg_temp.sel('{"apply_mr_discount": true}'))$$, 'This variant has no approved MR discount');
select pg_temp.expect_error($$select upsert_discount_rules(jsonb_build_array(jsonb_build_object('variant_id', (select id from t_ids where k = 'v'), 'coupon_cap', 20000)))$$,
  'You need Variant Coupon Cap: edit');
select pg_temp.as_user(2);
select upsert_discount_rules(jsonb_build_array(jsonb_build_object('variant_id', (select id from t_ids where k = 'v'), 'coupon_cap', 20000, 'mr_discount', 8000)));
select pg_temp.as_user(5);
do $$
declare
  b jsonb;
  base numeric := (calculate_price(pg_temp.sel('{}'))->>'total_amount')::numeric;
begin
  b := calculate_price(pg_temp.sel(jsonb_build_object('ceramic_coating_id', '30000000-0000-0000-0000-000000000001')));
  if (b->>'total_amount')::numeric <> base + 25000 then raise exception 'ceramic should add 25,000'; end if;
  -- Coupon 15,000 + MR 8,000 = 23,000 off, plus TCS on 23,000 less (1%).
  b := calculate_price(pg_temp.sel('{"coupon_amount": 15000, "apply_mr_discount": true}'));
  if (b->>'total_amount')::numeric <> base - 23000 - 230 then raise exception 'coupon + MR total wrong: % vs %', b->>'total_amount', base; end if;
  -- Available = 49,000 - 5,000 = 44,000; used 23,000: fine.
  if (b->>'margin_available')::numeric <> 44000 or (b->>'margin_floor_breached')::boolean then raise exception 'margin wrong: %', b; end if;
end $$;

-- ---- A quote below the floor: coupon 20,000 + MR 8,000 + dealer discount 20,000 = 48,000 > 44,000
with q as (
  insert into quotes (outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option, pricing_extras)
  select '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Floor Buyer',
         (select id from t_ids where k = 'v'), (select id from t_ids where k = 'c'), '00000000-0000-0000-000b-000000000001', 'premium',
         '{"coupon_amount": 20000, "apply_mr_discount": true}'
  returning id)
insert into t_ids select 'q', id from q;
do $$
declare
  r jsonb;
begin
  r := submit_quote_stage((select id from t_ids where k = 'q'), 'with_dealer_discount', null, 20000);
  if r->>'required_role' <> 'Business Head' then raise exception 'below the floor needs the Business Head: %', r; end if;
  begin
    update quotes set pricing_extras = '{}' where id = (select id from t_ids where k = 'q');
    raise exception 'extras after basic: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This quote is past the basic stage%' then raise; end if;
  end;
end $$;
select pg_temp.as_user(2);
select decide_approval((select id from approvals where quote_id = (select id from t_ids where k = 'q') and status = 'pending'), 'approved');
select pg_temp.as_user(5);
select finalize_quote((select id from t_ids where k = 'q'));

-- ===== Schemes =====
select pg_temp.as_user(2);
do $$
declare
  s1 uuid;
  s2 uuid;
  s3 uuid;
  v_model uuid := (select id from t_ids where k = 'm');
  lines jsonb := '[{"scheme_master_code": "exchange", "tkm_share": 10000, "dealer_share": 5000, "prev_my_tkm_share": 20000}]';
begin
  s1 := save_scheme_revision(jsonb_build_object('model_id', v_model, 'name', 'Exchange Offer', 'valid_from', current_date - 10, 'lines', lines));
  if (select valid_to from schemes where id = s1) <> date '2099-12-31' then raise exception 'first revision runs open'; end if;
  -- A later revision closes the first the day before.
  s2 := save_scheme_revision(jsonb_build_object('model_id', v_model, 'name', 'Exchange Offer', 'valid_from', current_date + 10, 'lines', lines));
  if (select valid_to from schemes where id = s1) <> current_date + 9 then raise exception 'first revision should end the day before the second'; end if;
  -- A revision between them ends the day before the next one.
  s3 := save_scheme_revision(jsonb_build_object('model_id', v_model, 'name', 'Exchange Offer', 'valid_from', current_date + 5, 'lines', lines));
  if (select valid_to from schemes where id = s3) <> current_date + 9 or (select valid_to from schemes where id = s1) <> current_date + 4 then
    raise exception 'middle revision wrong';
  end if;
  -- Same start date replaces the lines.
  if save_scheme_revision(jsonb_build_object('model_id', v_model, 'name', 'Exchange Offer', 'valid_from', current_date + 5, 'lines', lines)) <> s3 then
    raise exception 'same start date should update in place';
  end if;
  if (select count(*) from scheme_line_items where scheme_id = s3) <> 1 then raise exception 'lines replaced, not added'; end if;
  begin
    perform save_scheme_revision(jsonb_build_object('model_id', v_model, 'name', 'Exchange Offer', 'valid_from', current_date - 2,
                                                    'valid_to', current_date + 6, 'lines', lines));
    raise exception 'overlap: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'The revision would overlap%' then raise; end if;
  end;
  perform save_scheme_revision(jsonb_build_object('model_id', v_model, 'name', 'Scrappage Offer', 'valid_from', current_date - 10,
    'lines', '[{"scheme_master_code": "scrappage", "tkm_share": 5000, "dealer_share": 0}]'::jsonb));
  insert into t_ids select 'ex', id from scheme_line_items where scheme_id = s1;
  insert into t_ids select 'sc', sli.id from scheme_line_items sli join schemes s on s.id = sli.scheme_id where s.name = 'Scrappage Offer';
end $$;
select pg_temp.as_user(5);
select pg_temp.expect_error($$select calculate_price(pg_temp.sel(jsonb_build_object('selected_scheme_line_item_ids',
  jsonb_build_array((select id from t_ids where k = 'ex'), (select id from t_ids where k = 'sc')))))$$,
  'An exchange scheme and a scrappage scheme cannot be combined');
do $$
declare
  cur numeric := (calculate_price(pg_temp.sel(jsonb_build_object('selected_scheme_line_item_ids', jsonb_build_array((select id from t_ids where k = 'ex')))))->>'scheme_discount_customer_facing')::numeric;
  prev numeric := (calculate_price(pg_temp.sel(jsonb_build_object('model_year', 'previous', 'selected_scheme_line_item_ids', jsonb_build_array((select id from t_ids where k = 'ex')))))->>'scheme_discount_customer_facing')::numeric;
begin
  if cur <> 15000 or prev <> 25000 then raise exception 'model-year amounts wrong: % %', cur, prev; end if;
end $$;
select pg_temp.expect_error($$select save_scheme_revision('{}'::jsonb)$$, 'You need Schemes: edit');

select 'catalog_pricing_masters: all checks passed';
rollback;
