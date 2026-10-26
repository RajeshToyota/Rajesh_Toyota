-- Staged quotes: Basic -> schemes (TL) -> dealer discount (OH up to 25k, BH above) -> final ->
-- booking; approvals only through decide_approval. Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/staged_quotes.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000002'), ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000004'),
  ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000006');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000002', '00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000004',
             '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000006');

create temp table t_ids (k text primary key, id uuid);
grant all on t_ids to authenticated;

-- A Hyryder scheme worth Rs 15,000 to the customer (10,000 TKM + 5,000 dealer).
with s as (
  insert into schemes (model_id, name, valid_from, valid_to)
  select id, 'Test Consumer Offer', current_date - 1, current_date + 30 from models where tkm_model_code = 'D22'
  returning id)
insert into t_ids select 'scheme', id from s;
with l as (
  insert into scheme_line_items (scheme_id, line_type, tkm_share, dealer_share, is_customer_facing)
  select id, 'Consumer Offer', 10000, 5000, true from t_ids where k = 'scheme'
  returning id)
insert into t_ids select 'li', id from l;

create or replace function pg_temp.as_user(n int) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;

-- ---- SC1 makes a quote; schemes sent with the insert are dropped (Basic = list price)
set local role authenticated;
select pg_temp.as_user(5);
with q as (
  insert into quotes (outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                      selected_scheme_line_item_ids, dealer_discount)
  select '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Stage Buyer', v.id, c.id,
         '00000000-0000-0000-000b-000000000001', 'premium', array[(select id from t_ids where k = 'li')], 99999
  from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ'
  returning id)
insert into t_ids select 'q1', id from q;

do $$
declare
  q quotes%rowtype;
  r jsonb;
begin
  select * into q from quotes where id = (select id from t_ids where k = 'q1');
  if q.current_stage <> 'basic' or q.selected_scheme_line_item_ids <> '{}' or q.dealer_discount <> 0 or q.total_amount <> 2311480 then
    raise exception 'basic quote wrong: % % % %', q.current_stage, q.selected_scheme_line_item_ids, q.dealer_discount, q.total_amount;
  end if;

  begin
    update quotes set current_stage = 'final' where id = q.id;
    raise exception 'direct stage change: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Quote stages, schemes and dealer discount change only%' then raise; end if;
  end;

  -- Stage 2: schemes -> Team Leader. 19,84,000 + TCS 19,840 + 2,31,588 + 60,402 + 500.
  r := submit_quote_stage(q.id, 'with_schemes', array[(select id from t_ids where k = 'li')]);
  if not (r->>'approval_required')::boolean or r->>'required_role' <> 'Team Leader' or (r->>'total_amount')::numeric <> 2296330 then
    raise exception 'schemes stage wrong: %', r;
  end if;

  begin
    perform submit_quote_stage(q.id, 'with_dealer_discount', null, 5000);
    raise exception 'skipping a pending approval: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'The current stage is pending%' then raise; end if;
  end;
  begin
    perform decide_approval((select id from approvals where quote_id = q.id and status = 'pending'), 'approved');
    raise exception 'self-approval: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'You cannot approve your own request%' then raise; end if;
  end;
  begin
    insert into approvals (quote_id, requested_by_employee_id, required_role_id, requested_discount_amount, status)
    values (q.id, '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0001-000000000006', 1, 'approved');
    raise exception 'direct approval insert: expected an error';
  exception when insufficient_privilege then
    null;
  end;
end $$;

-- ---- SC2 cannot approve; the Team Leader can
select pg_temp.as_user(6);
do $$
begin
  begin
    perform decide_approval((select id from approvals where status = 'pending' limit 1), 'approved');
    raise exception 'SC2 approving: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Approval not found%' and sqlerrm not like 'This request needs a Team Leader%' then raise; end if;
  end;
end $$;
select pg_temp.as_user(4);
do $$
begin
  update approvals set status = 'approved' where status = 'pending';  -- direct update: silently blocked
  if exists (select 1 from approvals where status = 'approved') then
    raise exception 'direct approval update must not take effect';
  end if;
  perform decide_approval((select id from approvals where status = 'pending'), 'approved', 'ok');
end $$;

-- ---- SC1: dealer discount 30,000 -> Business Head
select pg_temp.as_user(5);
do $$
declare
  r jsonb;
  q uuid := (select id from t_ids where k = 'q1');
begin
  r := submit_quote_stage(q, 'with_dealer_discount', null, 30000);
  -- 19,54,000 + TCS 19,540 + 2,31,588 + 60,402 + 500
  if r->>'required_role' <> 'Business Head' or (r->>'total_amount')::numeric <> 2266030 then
    raise exception 'dealer stage 30k wrong: %', r;
  end if;
  if (select dealer_margin from quotes where id = q) <> (select dealer_margin from quote_versions where quote_id = q and stage = 'with_schemes') - 30000 then
    raise exception 'dealer discount must come out of dealer margin';
  end if;
end $$;

select pg_temp.as_user(3);
do $$
begin
  begin
    perform decide_approval((select id from approvals where status = 'pending'), 'approved');
    raise exception 'OH approving above 25k: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This request needs a Business Head%' then raise; end if;
  end;
end $$;

-- ---- SC1 lowers it to 20,000 (supersedes the BH request) -> Outlet Head
select pg_temp.as_user(5);
do $$
declare
  r jsonb;
begin
  r := submit_quote_stage((select id from t_ids where k = 'q1'), 'with_dealer_discount', null, 20000);
  if r->>'required_role' <> 'Outlet Head' then
    raise exception 'dealer stage 20k wrong: %', r;
  end if;
  if (select status || '/' || comment from approvals where requested_discount_amount = 30000) <> 'rejected/Superseded by a newer submission' then
    raise exception 'the 30k request should be superseded';
  end if;
  begin
    perform finalize_quote((select id from t_ids where k = 'q1'));
    raise exception 'finalising while pending: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'The current stage is pending%' then raise; end if;
  end;
end $$;

select pg_temp.as_user(3);
select decide_approval((select id from approvals where status = 'pending'), 'approved');

-- ---- SC1 finalises and books; the booking takes the quote's numbers whatever is sent
select pg_temp.as_user(5);
do $$
declare
  q uuid := (select id from t_ids where k = 'q1');
  r jsonb;
begin
  r := finalize_quote(q);
  if (select current_stage from quotes where id = q) <> 'final' or (select count(*) from quote_versions where quote_id = q) <> 5 then
    raise exception 'final: expected stage final and 5 versions (basic, schemes, 30k, 20k, final)';
  end if;
  begin
    update quotes set variant_id = (select id from variants where tkm_suffix_code = 'D22U5') where id = q;
    raise exception 'changing a final quote: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'This quote is past the basic stage%' then raise; end if;
  end;
end $$;

with b as (
  insert into bookings (quote_id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id,
                        dealer_discount, selected_scheme_line_item_ids)
  select (select id from t_ids where k = 'q1'), '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005',
         'Stage Buyer', v.id, c.id, '00000000-0000-0000-000b-000000000001', 999999, '{}'
  from variants v, colors c where v.tkm_suffix_code = 'D22U5' and c.tkm_color_code = 'ZHJ'
  returning id)
insert into t_ids select 'b1', id from b;

do $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = (select id from t_ids where k = 'b1');
  -- 19,99,000 - 15,000 - 20,000 = 19,64,000 + TCS 19,640 + 2,31,588 + 60,402 + 500
  if b.dealer_discount <> 20000 or b.total_amount <> 2276130
     or b.variant_id <> (select id from variants where tkm_suffix_code = 'D22U4') then
    raise exception 'booking should carry the final quote: % % %', b.dealer_discount, b.total_amount, b.variant_id;
  end if;
  begin
    update bookings set dealer_discount = 50000 where id = b.id;
    raise exception 'changing a booking discount: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'A booking''s schemes and dealer discount%' then raise; end if;
  end;
  if (request_booking_approval(b.id)->>'approval_required')::boolean then
    raise exception 'a booking from a final quote needs no new approval';
  end if;
end $$;

-- ---- A quote that is not final cannot be booked; a rejected stage blocks progress until resubmitted
with q as (
  insert into quotes (outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option)
  select '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Second Buyer', v.id, c.id,
         '00000000-0000-0000-000b-000000000001', 'premium'
  from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ'
  returning id)
insert into t_ids select 'q2', id from q;
do $$
declare
  q uuid := (select id from t_ids where k = 'q2');
begin
  begin
    insert into bookings (quote_id, outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id)
    select q, '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Second Buyer', v.id, c.id,
           '00000000-0000-0000-000b-000000000001'
    from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ';
    raise exception 'booking a basic quote: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'Finalise the quote before booking it%' then raise; end if;
  end;
  perform submit_quote_stage(q, 'with_schemes', array[(select id from t_ids where k = 'li')]);
end $$;

select pg_temp.as_user(4);
select decide_approval((select id from approvals where status = 'pending'), 'rejected', 'Offer not applicable');

select pg_temp.as_user(5);
do $$
declare
  q uuid := (select id from t_ids where k = 'q2');
  r jsonb;
begin
  begin
    perform finalize_quote(q);
    raise exception 'finalising a rejected stage: expected an error';
  exception when raise_exception then
    if sqlerrm not like 'The current stage is rejected%' then raise; end if;
  end;
  r := submit_quote_stage(q, 'with_schemes', '{}');
  if (r->>'approval_required')::boolean then
    raise exception 'no schemes, no approval';
  end if;
  perform finalize_quote(q);
end $$;

-- ---- Direct booking (no quote): scheme discount approval via the old rules (above Rs 10,000 -> TL)
with b as (
  insert into bookings (outlet_id, employee_id, customer_name, variant_id, color_id, rto_category_id, insurance_option,
                        selected_scheme_line_item_ids, dealer_discount)
  select '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000005', 'Walk-in Buyer', v.id, c.id,
         '00000000-0000-0000-000b-000000000001', 'premium', array[(select id from t_ids where k = 'li')], 40000
  from variants v, colors c where v.tkm_suffix_code = 'D22U4' and c.tkm_color_code = 'ZHJ'
  returning id)
insert into t_ids select 'b2', id from b;
do $$
declare
  r jsonb;
begin
  if (select dealer_discount from bookings where id = (select id from t_ids where k = 'b2')) <> 0 then
    raise exception 'a direct booking carries no dealer discount';
  end if;
  r := request_booking_approval((select id from t_ids where k = 'b2'));
  if not (r->>'approval_required')::boolean or r->>'required_role' <> 'Team Leader' then
    raise exception 'direct booking approval wrong: %', r;
  end if;
  raise notice 'staged_quotes: all checks passed';
end $$;

rollback;
