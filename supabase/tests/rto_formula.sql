-- RTO (Normal registration) worked out the Techwheels way (rto_normal), and one price-list row
-- per variant. Runs in a transaction that is rolled back, so the settings it adds do not leak
-- into other tests.
begin;
do $$
declare
  v uuid;
  pw uuid;
  std uuid;
  r jsonb;
  n int;
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

  -- Not configured yet: the printed figure is used.
  select id into v from variants where tkm_suffix_code = 'FRNBJ';
  select id into pw from colors where tkm_color_code = '089';
  select id into std from colors where tkm_color_code = '040';
  if (select rto_amount from price_list where variant_id = v and list_type = 'private') <> 494325 then
    raise exception 'unconfigured rto_amount should be the printed 494325';
  end if;

  -- Configure: fixed charges 600 + 1,500 + 300, 12% MV tax, green tax 4,000 for 2,001-3,000 cc.
  insert into rto_settings (new_registration, hypothecation_addition, duplicate_tax_card) values (600, 1500, 300);
  insert into green_tax_slabs (min_cc, max_cc, amount) values (0, 2000, 2000), (2001, 3000, 4000);
  update variants set engine_cc = 2755 where id = v;
  update price_list set mv_tax_rate = 12 where variant_id = v and list_type = 'private';

  -- 35,75,000 x 12% = 4,29,000; surcharge 53,625; + 2,400 fixed + 4,000 green = 4,89,025.
  r := rto_normal(v, 3575000, 12);
  if (r->>'total')::numeric <> 489025 or (r->>'mv_tax')::numeric <> 429000 or (r->>'surcharge_mv_tax')::numeric <> 53625 then
    raise exception 'rto_normal FRNBJ: got %', r;
  end if;
  if (select rto_amount from price_list where variant_id = v and list_type = 'private') <> 489025 then
    raise exception 'stored rto_amount not refreshed: %', (select rto_amount from price_list where variant_id = v and list_type = 'private');
  end if;

  -- Standard colour quote uses it.
  r := calculate_price(jsonb_build_object('variant_id', v, 'color_id', std, 'state', 'Rajasthan'));
  if (r->>'rto_amount')::numeric <> 489025 then raise exception 'standard colour RTO: got %', r->>'rto_amount'; end if;

  -- Pearl white: MV tax on 35,95,000 = 4,31,400; surcharge 53,925; total 4,91,725.
  r := calculate_price(jsonb_build_object('variant_id', v, 'color_id', pw, 'state', 'Rajasthan'));
  if (r->>'rto_amount')::numeric <> 491725 then raise exception 'pearl colour RTO: got %', r->>'rto_amount'; end if;

  -- An engine change re-prices the stored figure: 1,998 cc -> green tax 2,000.
  update variants set engine_cc = 1998 where id = v;
  if (select rto_amount from price_list where variant_id = v and list_type = 'private') <> 487025 then
    raise exception 'engine change not refreshed';
  end if;

  -- EV: no MV tax, no surcharge, no green tax; just the fixed charges.
  update variants set fuel_type_id = (select id from fuel_types where name = 'EV') where id = v;
  if (rto_normal(v, 3575000, 12)->>'total')::numeric <> 2400 then raise exception 'EV: got %', rto_normal(v, 3575000, 12); end if;

  raise notice 'rto_formula: all checks passed';
end $$;
rollback;
