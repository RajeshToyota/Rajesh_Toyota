-- Exchange and used cars (Phase 22): request, evaluation by the branch evaluator, offers (>5% over
-- valuation needs the Outlet Head), acceptance, procurement as an exchange receipt on the booking,
-- refurbish / list / sell with margin, U Trust flag, summary.
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/exchange_used_cars.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000005'),
  ('a0000000-0000-0000-0000-000000000006'), ('a0000000-0000-0000-0000-00000000000e');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000006');
insert into employees (id, auth_user_id, name, role_id, outlet_id) values
  ('00000000-0000-0000-0003-00000000000e', 'a0000000-0000-0000-0000-00000000000e', 'Jaipur Evaluator',
   '00000000-0000-0000-0001-00000000000f', '00000000-0000-0000-0002-000000000001');

create or replace function pg_temp.as_user(n text) returns void language sql as $$
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
create temp table t_ids (k text primary key, id uuid) on commit drop;
grant all on t_ids to authenticated;

insert into bookings (id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                      mode_of_purchase, data_consent, payment_instrument_type, payment_amount)
select '00000000-0000-0000-00bb-000000000081', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005',
       'Exchange Buyer', v.id, c.id, '00000000-0000-0000-000b-000000000001', 'premium', 'Cash', true, 'Cash', 50000
from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';

set local role authenticated;

-- ===== Request =====
select pg_temp.as_user('5');
insert into t_ids select 'ev', request_evaluation(jsonb_build_object('booking_id', '00000000-0000-0000-00bb-000000000081',
  'reg_no', 'rj14  ab 1234', 'model', 'Innova Crysta', 'mfg_year', extract(year from now())::int - 4, 'odometer_km', 60000,
  'owners', 1, 'customer_expected', 900000));
select pg_temp.expect_error($$select request_evaluation('{"reg_no": "RJ14 AB 1234", "model": "Innova", "customer_name": "X"}')$$,
  'This car already has an open evaluation');
select pg_temp.expect_error(format($f$select record_evaluation('%s', '{"evaluator_price": 1}')$f$, (select id from t_ids)), 'Evaluation not found');
select pg_temp.as_user('6');
do $$ begin
  if exists (select 1 from used_car_evaluations) then raise exception 'another consultant should not see it'; end if;
end $$;

-- ===== Evaluate =====
select pg_temp.as_user('e');
do $$
declare
  v uuid := (select id from t_ids where k = 'ev');
  photos jsonb;
begin
  if (select reg_no from used_car_evaluations where id = v) <> 'RJ14 AB 1234' then raise exception 'reg no should be tidied'; end if;
  perform pg_temp.expect_error(format($f$select record_evaluation('%s', '{"evaluator_price": 800000, "photo_paths": ["used-car/%s/a.jpg"]}')$f$, v, v),
    'Add at least 4 photos');
  perform pg_temp.expect_error(format($f$select record_evaluation('%s', '{"evaluator_price": 800000, "photo_paths": ["x/a","x/b","x/c","x/d"]}')$f$, v),
    'Photos must be stored with this evaluation');
  photos := (select jsonb_agg('used-car/' || v || '/' || s || '.jpg') from unnest(array['front', 'back', 'left', 'right']) s);
  perform record_evaluation(v, jsonb_build_object('evaluator_price', 800000, 'photo_paths', photos,
    'condition', '{"engine": 4, "body": 3, "interior": 4, "tyres": 3}', 'colour', 'Silver'));
  if (select status || '/' || utrust from used_car_evaluation_list() where id = v) <> 'evaluated/true' then
    raise exception 'should be evaluated and U Trust eligible: %', (select row_to_json(l) from used_car_evaluation_list() l);
  end if;
end $$;

-- ===== Negotiate and accept =====
select pg_temp.as_user('5');
select pg_temp.expect_error(format($f$select log_used_car_offer('%s', 'dealer', 900000)$f$, (select id from t_ids)), 'An offer more than 5%');
select log_used_car_offer((select id from t_ids), 'customer', 900000, 'Wants 9 lakh');
select pg_temp.as_user('e');
select log_used_car_offer((select id from t_ids), 'dealer', 820000, 'Best we can do');
select pg_temp.as_user('5');
select accept_used_car_offer((select id from t_ids));
select pg_temp.expect_error(format($f$select procure_used_car('%s')$f$, (select id from t_ids)), 'Evaluation not found');

-- ===== Procure: the value becomes an exchange receipt on the booking =====
select pg_temp.as_user('e');
do $$
declare
  v_before numeric;
  v_car uuid;
begin
  if (select final_price from used_car_evaluations) <> 820000 then raise exception 'final price should be the last dealer offer'; end if;
  insert into t_ids select 'car', procure_used_car((select id from t_ids where k = 'ev'), null, 'RC and NOC collected');
  if (select count(*) from used_car_negotiation_log((select id from t_ids where k = 'ev'))) <> 2 then raise exception 'negotiation log wrong'; end if;
end $$;
select pg_temp.as_user('3');
do $$ begin
  if (select count(*) from payment_receipts where booking_id = '00000000-0000-0000-00bb-000000000081' and mode = 'exchange'
        and amount = 820000 and clearance_status = 'cleared') <> 1 then
    raise exception 'exchange receipt missing';
  end if;
end $$;

-- ===== Refurbish, list, sell =====
select pg_temp.as_user('e');
select pg_temp.expect_error(format($f$select update_used_car('%s', '{"status": "sold", "sold_price": 950000}')$f$, (select id from t_ids where k = 'car')),
  'Enter the sale price and the buyer');
select update_used_car((select id from t_ids where k = 'car'), '{"status": "refurbishing", "add_refurbishment": 20000}');
select update_used_car((select id from t_ids where k = 'car'), '{"status": "listed", "listed_price": 975000}');
select update_used_car((select id from t_ids where k = 'car'), '{"status": "sold", "sold_price": 940000, "buyer_name": "Next Owner", "buyer_mobile": "9850000005"}');
do $$ begin
  if (select margin from used_car_stock_list()) <> 100000 then raise exception 'margin should be 9.4L - 8.2L - 20k'; end if;
  perform pg_temp.expect_error(format($f$select update_used_car('%s', '{"notes": "x"}')$f$, (select id from t_ids where k = 'car')), 'This car has left stock');
  if (select procured || '/' || sold || '/' || margin from used_car_summary(current_date, current_date) where outlet like '%Jaipur%') <> '1/1/100000' then
    raise exception 'summary wrong: %', (select json_agg(s) from used_car_summary(current_date, current_date) s);
  end if;
end $$;

select 'exchange_used_cars: all checks passed';
rollback;
