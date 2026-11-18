-- RTO (Normal registration) worked out the Techwheels way with the RTO calculation sheet's figures
-- (rto_normal), and one price-list row per variant. Runs in a transaction that is rolled back.
begin;
do $$
declare
  v uuid;
  pw uuid;
  std uuid;
  r jsonb;
  n int;
  bad text;
begin
  -- One row per variant / list / state / effective date; no colour or paint rows left.
  select count(*) into n from price_list where color_id is not null or paint_category <> 'standard';
  if n <> 0 then raise exception 'expected no colour/paint price-list rows, found %', n; end if;
  begin
    insert into price_list (variant_id, color_id, state, ex_showroom_price, effective_from)
    select variant_id, (select id from colors limit 1), state, 1, current_date from price_list limit 1;
    raise exception 'per-colour row: expected an error';
  exception when check_violation then null;
  end;

  -- The worked-out RTO matches the printed TKM figure (within 1 rupee of rounding) on every list
  -- row except the few printed one-offs (Land Cruiser 300, two Hycross commercial rows).
  select string_agg(format('%s/%s: printed %s, worked out %s', v.name, p.list_type, p.road_tax_registration, p.rto_amount), '; ')
  into bad
  from price_list p join variants v on v.id = p.variant_id join models m on m.id = v.model_id
  where p.road_tax_registration is not null and abs(p.road_tax_registration - p.rto_amount) > 1
    and m.name <> 'Land Cruiser 300'
    and not (m.name = 'Innova Hycross' and p.list_type = 'commercial');
  if bad is not null then raise exception 'RTO differs from the printed list: %', bad; end if;

  -- Fortuner 4x2 MT (FRNBJ), diesel, private: 35,75,000 x 12% = 4,29,000; surcharge 53,625;
  -- green 7,500; fixed 4,200 -> 4,94,325 (as printed).
  select id into v from variants where tkm_suffix_code = 'FRNBJ';
  select id into pw from colors where tkm_color_code = '089';
  select id into std from colors where tkm_color_code = '040';
  r := rto_normal(v, 'private', 3575000, 12, 7500, 0);
  if (r->>'total')::numeric <> 494325 or (r->>'mv_tax')::numeric <> 429000 or (r->>'surcharge_mv_tax')::numeric <> 53625 then
    raise exception 'rto_normal FRNBJ: got %', r;
  end if;
  r := calculate_price(jsonb_build_object('variant_id', v, 'color_id', std, 'state', 'Rajasthan'));
  if (r->>'rto_amount')::numeric <> 494325 then raise exception 'standard colour RTO: got %', r->>'rto_amount'; end if;

  -- Pearl white (+20,000): MV tax on 35,95,000 = 4,31,400; surcharge 53,925 -> 4,97,025, which is
  -- what the old Pearl White row printed.
  r := calculate_price(jsonb_build_object('variant_id', v, 'color_id', pw, 'state', 'Rajasthan'));
  if (r->>'rto_amount')::numeric <> 497025 then raise exception 'pearl colour RTO: got %', r->>'rto_amount'; end if;

  -- Changing a list's fixed charges re-prices the stored figures.
  update rto_settings set service_charge = 1500 where list_type = 'private';
  if (select rto_amount from price_list where variant_id = v and list_type = 'private') <> 494825 then
    raise exception 'settings change not refreshed';
  end if;

  -- A row with no MV tax rate falls back to the printed figure.
  update price_list set mv_tax_rate = null where variant_id = v and list_type = 'private';
  if (select rto_amount from price_list where variant_id = v and list_type = 'private') <> 494325 then
    raise exception 'no-rate fallback: expected printed 494325';
  end if;

  -- EV: no MV tax, surcharge or green tax; just the fixed charges.
  update variants set fuel_type_id = (select id from fuel_types where name = 'EV') where id = v;
  if (rto_normal(v, 'private', 3575000, 12, 7500, 0)->>'total')::numeric <> 4700 then
    raise exception 'EV: got %', rto_normal(v, 'private', 3575000, 12, 7500, 0);
  end if;

  raise notice 'rto_formula: all checks passed';
end $$;
rollback;
