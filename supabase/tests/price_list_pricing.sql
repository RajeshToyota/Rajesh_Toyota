-- Checks calculate_price against figures printed on the dealer price lists (seeded by
-- 20261024000002). Run against a scratch DB: psql -v ON_ERROR_STOP=1 -f supabase/tests/price_list_pricing.sql
do $$
declare
  r jsonb;
  v uuid;
  c uuid;
begin
  -- Hyryder V eDrive (D22U4), Cafe White, private list, Premium insurance:
  -- 19,99,000 + TCS 19,990 + RTO 2,31,588 + Premium 60,402 + FASTag 500 = 23,11,480 (list "On Road Price (PREMIUM)").
  select id into v from variants where tkm_suffix_code = 'D22U4';
  select id into c from colors where tkm_color_code = 'ZHJ';
  r := calculate_price(jsonb_build_object('variant_id', v, 'color_id', c, 'state', 'Rajasthan', 'insurance_option', 'premium'));
  if (r->>'total_amount')::numeric <> 2311480 then raise exception 'D22U4 standard premium: expected 2311480, got %', r->>'total_amount'; end if;

  -- Same variant in a dual-tone paint picks up the dual-tone row: 20,19,000 + 20,190 + 2,33,838 + 60,840 + 500 = 23,34,368.
  select id into c from colors where tkm_color_code = 'C9J';
  r := calculate_price(jsonb_build_object('variant_id', v, 'color_id', c, 'state', 'Rajasthan', 'insurance_option', 'premium'));
  if (r->>'total_amount')::numeric <> 2334368 then raise exception 'D22U4 dual tone premium: expected 2334368, got %', r->>'total_amount'; end if;

  -- Glanza E MT (D24ZW): list prints TCS 0 below the threshold. Advance: 6,99,000 + 0 + 77,474 + 36,019 + 500 = 8,12,993.
  select id into v from variants where tkm_suffix_code = 'D24ZW';
  r := calculate_price(jsonb_build_object('variant_id', v, 'color_id', c, 'state', 'Rajasthan', 'insurance_option', 'advance'));
  if (r->>'tcs_amount')::numeric <> 0 or (r->>'total_amount')::numeric <> 812993 then
    raise exception 'D24ZW advance: expected 812993 with TCS 0, got % (TCS %)', r->>'total_amount', r->>'tcs_amount';
  end if;

  -- Fortuner Legender 4x4 AT (FRN4L) commercial list does not exist: must refuse, not guess.
  select id into v from variants where tkm_suffix_code = 'FRN4L';
  select id into c from colors where tkm_color_code = '089';
  begin
    r := calculate_price(jsonb_build_object('variant_id', v, 'color_id', c, 'state', 'Rajasthan', 'list_type', 'commercial', 'insurance_option', 'premium'));
    raise exception 'FRN4L commercial: expected an error';
  exception when raise_exception then
    if sqlerrm like 'FRN4L commercial%' then raise; end if;
  end;

  -- Pearl white Fortuner 4x2 MT (FRNBJ) uses the PW row, plus the 5th-year warranty:
  -- 35,95,000 + 35,950 + 4,97,025 + 1,57,498 + 500 + EW 51,680 = 43,37,653.
  select id into v from variants where tkm_suffix_code = 'FRNBJ';
  r := calculate_price(jsonb_build_object('variant_id', v, 'color_id', c, 'state', 'Rajasthan', 'insurance_option', 'premium', 'include_extended_warranty', true));
  if (r->>'total_amount')::numeric <> 4337653 then raise exception 'FRNBJ pearl premium + EW: expected 4337653, got %', r->>'total_amount'; end if;

  -- Innova Crysta GX 8S (IMVIV) commercial list: 19,99,000 + 19,990 + 2,35,143 + 76,319 + 500 = 23,30,952.
  select id into v from variants where tkm_suffix_code = 'IMVIV';
  select id into c from colors where tkm_color_code = '040';
  r := calculate_price(jsonb_build_object('variant_id', v, 'color_id', c, 'state', 'Rajasthan', 'list_type', 'commercial', 'insurance_option', 'premium'));
  if (r->>'total_amount')::numeric <> 2330952 then raise exception 'IMVIV commercial premium: expected 2330952, got %', r->>'total_amount'; end if;

  -- An option the list does not print is rejected with the options it does have.
  begin
    r := calculate_price(jsonb_build_object('variant_id', v, 'color_id', c, 'state', 'Rajasthan', 'list_type', 'commercial', 'insurance_option', 'premium_3plus3'));
    raise exception 'IMVIV 3+3: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Insurance option premium_3plus3 is not on this price list%' then raise; end if;
  end;

  raise notice 'price_list_pricing: all checks passed';
end $$;
