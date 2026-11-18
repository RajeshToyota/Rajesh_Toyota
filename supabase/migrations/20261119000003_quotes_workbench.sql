-- Phase 25: Quotes workbench (Techwheels' Manage Quotes) on top of Rajesh Toyota's staged quotes.
--   - Quotes record how many cars (fleet), where they were made (mobile or web), the preferred
--     financier and whether the customer has a car to exchange.
--   - A quote is locked once a booking made from it is invoiced; after that only the Admin can change
--     it (Techwheels' quote_is_billed / can_edit_quote).
--   - Fleet: a final quote for N cars books one car first; expand_booking_to_fleet() creates the other
--     N-1 bookings in the same group, each priced on its own, with the booking payment split evenly.
--   - quote_workbench(): one query behind the Create / Approve / Proceed / Bookings tabs.

alter table quotes
  add column quantity int not null default 1 check (quantity between 1 and 200),
  add column source text not null default 'mobile' check (source in ('mobile', 'web')),
  add column preferred_financier_id uuid references financiers(id),
  add column exchange_interest boolean not null default false;
create index idx_quotes_preferred_financier on quotes(preferred_financier_id);

alter table bookings
  add column booking_group_id uuid references bookings(id),
  add column fleet_unit_no int check (fleet_unit_no >= 1);
create index idx_bookings_group on bookings(booking_group_id);

-- ===== Billing lock =====
create or replace function quote_is_billed(p_quote_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from bookings b join billing_requests br on br.booking_id = b.id
    where b.quote_id = p_quote_id and br.status = 'invoiced'
  );
$$;

create or replace function can_edit_quote(p_quote_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when q.id is null or not can_access_employee_data(current_employee_id(), q.employee_id) then
      jsonb_build_object('editable', false, 'reason', 'Quote not found')
    when quote_is_billed(q.id) and coalesce(current_employee_role_rank(), 99) <> 0 then
      jsonb_build_object('editable', false, 'reason', 'The car has been invoiced; only the Admin can change this quote')
    when q.current_stage <> 'basic' then
      jsonb_build_object('editable', false, 'reason', 'Past the basic stage; start a new quote to change the car or add-ons')
    else jsonb_build_object('editable', true)
  end
  from (select 1) x left join quotes q on q.id = p_quote_id;
$$;

create or replace function quotes_billing_lock()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (NEW.variant_id, NEW.color_id, NEW.outlet_id, NEW.rto_category_id, NEW.scrap_certificate_id, NEW.insurance_plan_id,
      NEW.insurance_addon_ids, NEW.accessory_ids, NEW.vas_product_ids, NEW.selected_scheme_line_item_ids, NEW.price_list_type,
      NEW.insurance_option, NEW.include_extended_warranty, NEW.dealer_discount, NEW.pricing_extras, NEW.customer_name,
      NEW.customer_mobile, NEW.quantity)
     is distinct from
     (OLD.variant_id, OLD.color_id, OLD.outlet_id, OLD.rto_category_id, OLD.scrap_certificate_id, OLD.insurance_plan_id,
      OLD.insurance_addon_ids, OLD.accessory_ids, OLD.vas_product_ids, OLD.selected_scheme_line_item_ids, OLD.price_list_type,
      OLD.insurance_option, OLD.include_extended_warranty, OLD.dealer_discount, OLD.pricing_extras, OLD.customer_name,
      OLD.customer_mobile, OLD.quantity)
     and quote_is_billed(OLD.id) and coalesce(current_employee_role_rank(), 99) <> 0 then
    raise exception 'The car has been invoiced; only the Admin can change this quote';
  end if;
  return NEW;
end;
$$;
create trigger trg_quotes_billing_lock before update on quotes
  for each row execute function quotes_billing_lock();

-- ===== Fleet bookings =====
-- Creates the rest of a fleet quote's bookings from its first booking. Each new booking copies the
-- first one's customer and booking form, takes its selections from the quote (as every booking from a
-- quote does) and is priced on its own; the booking payment is split evenly across the cars.
create or replace function expand_booking_to_fleet(p_booking_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  b bookings%rowtype;
  q quotes%rowtype;
  v_have int;
  v_unit numeric;
  n int := 0;
  i int;
  v_new uuid;
  v_cols text;
begin
  select * into b from bookings where id = p_booking_id for update;
  if b.id is null or not can_access_employee_data(current_employee_id(), b.employee_id) then
    raise exception 'Booking not found';
  end if;
  if b.quote_id is null then
    raise exception 'Only a booking made from a quote can be expanded to a fleet';
  end if;
  select * into q from quotes where id = b.quote_id;
  if q.quantity <= 1 then
    raise exception 'This quote is for one car';
  end if;
  if b.status = 'cancelled' then
    raise exception 'This booking is cancelled';
  end if;
  perform pg_advisory_xact_lock(hashtext('fleet:' || q.id));
  select count(*) into v_have from bookings where quote_id = q.id and status <> 'cancelled';
  if v_have >= q.quantity then
    raise exception 'All % bookings of this fleet already exist', q.quantity;
  end if;

  v_unit := case when b.payment_amount is not null then round(b.payment_amount / q.quantity, 2) end;
  update bookings set booking_group_id = coalesce(booking_group_id, id), fleet_unit_no = coalesce(fleet_unit_no, 1),
                      payment_amount = coalesce(v_unit, payment_amount)
  where id = b.id;

  -- Every column except the ones a new booking must not inherit.
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'bookings'
    and column_name not in ('id', 'created_at', 'updated_at', 'booking_group_id', 'fleet_unit_no', 'payment_amount',
                            'priced_snapshot', 'total_amount', 'priced_as_of', 'dealer_margin', 'signature_storage_path',
                            'order_booking_no', 'status', 'received_amount', 'imported_from_ctdms',
                            'rm_employee_id', 'rm_assigned_at')
    and column_name not like 'ctdms_order%'
    and column_name not like 'crm_%'
    and is_generated = 'NEVER';

  for i in (v_have + 1)..q.quantity loop
    execute format('insert into bookings (%s, booking_group_id, fleet_unit_no, payment_amount, status) '
                   'select %s, $1, $2, $3, ''booked'' from bookings where id = $4 returning id', v_cols, v_cols)
      into v_new using b.id, i, v_unit, b.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ===== Workbench =====
-- p_tab: 'drafts' (still at basic, being built), 'approve' (waiting for an approval),
-- 'proceed' (final, fewer bookings than cars), 'bookings' (booked from a quote).
create or replace function quote_workbench(p_tab text, p_search text default null, p_limit int default 200)
returns table (
  quote_id uuid, created_at timestamptz, customer_name text, customer_mobile text, consultant text, outlet text,
  car text, colour text, stage text, stage_state text, total_amount numeric, quantity int, bookings int,
  booking_ids uuid[], pending_approval_id uuid, required_role text, requested_amount numeric, billed boolean, source text
)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select q.*, quote_stage_state(q.id) as st,
           (select count(*)::int from bookings b where b.quote_id = q.id and b.status <> 'cancelled') as nb,
           (select array_agg(b.id order by b.fleet_unit_no nulls first, b.created_at) from bookings b where b.quote_id = q.id) as bids
    from quotes q
    where can_access_employee_data(current_employee_id(), q.employee_id)
      and (p_search is null or p_search = ''
       or q.customer_name ilike '%' || p_search || '%'
       or coalesce(q.customer_mobile, q.customer_phone, '') like '%' || p_search || '%')
  )
  select b.id, b.created_at, b.customer_name, coalesce(b.customer_mobile, b.customer_phone), e.name, o.name,
         trim(coalesce(m.name, '') || ' ' || v.name), c.name, b.current_stage, b.st, b.total_amount, b.quantity, b.nb,
         coalesce(b.bids, '{}'), a.id, r.name, a.requested_discount_amount, quote_is_billed(b.id), b.source
  from base b
  join employees e on e.id = b.employee_id
  join outlets o on o.id = b.outlet_id
  join variants v on v.id = b.variant_id
  left join models m on m.id = v.model_id
  join colors c on c.id = b.color_id
  left join approvals a on a.quote_id = b.id and a.status = 'pending'
  left join roles r on r.id = a.required_role_id
  where case p_tab
          when 'drafts' then b.current_stage <> 'final' and a.id is null
          when 'approve' then a.id is not null
          when 'proceed' then b.current_stage = 'final' and b.nb < b.quantity and b.status not in ('expired')
          when 'bookings' then b.nb > 0
          else true
        end
  order by b.created_at desc
  limit p_limit;
$$;

revoke execute on function quote_is_billed(uuid) from public, anon;
revoke execute on function can_edit_quote(uuid) from public, anon;
revoke execute on function quotes_billing_lock() from public, anon, authenticated;
revoke execute on function expand_booking_to_fleet(uuid) from public, anon;
revoke execute on function quote_workbench(text, text, int) from public, anon;
grant execute on function quote_is_billed(uuid) to authenticated;
grant execute on function can_edit_quote(uuid) to authenticated;
grant execute on function expand_booking_to_fleet(uuid) to authenticated;
grant execute on function quote_workbench(text, text, int) to authenticated;

insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('quotes', 'sales', 'Quotes', '/quotes', 25, true);
select seed_role_rights('Outlet Head', 'quotes', array['view', 'create', 'edit', 'approve']);
select seed_role_rights('Head Customer Relations', 'quotes', array['view', 'create', 'edit', 'approve']);
select seed_role_rights('Team Leader', 'quotes', array['view', 'create', 'edit', 'approve']);
select seed_role_rights('Sales Consultant', 'quotes', array['view', 'create', 'edit']);

-- Prices a quote before it is saved, exactly as the quote trigger will (the web quote builder).
create or replace function preview_quote_price(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  arr text := '[]';
begin
  return calculate_price(build_pricing_selections(
    nullif(p->>'variant_id', '')::uuid, nullif(p->>'color_id', '')::uuid, nullif(p->>'outlet_id', '')::uuid,
    nullif(p->>'rto_category_id', '')::uuid, nullif(p->>'scrap_certificate_id', '')::uuid, nullif(p->>'insurance_plan_id', '')::uuid,
    coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'insurance_addon_ids', arr::jsonb)) x), '{}'),
    coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'accessory_ids', arr::jsonb)) x), '{}'),
    coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'vas_product_ids', arr::jsonb)) x), '{}'),
    '{}', coalesce(nullif(p->>'price_list_type', ''), 'private'), nullif(p->>'insurance_option', ''),
    coalesce((p->>'include_extended_warranty')::boolean, false), 0
  ) || coalesce(p->'pricing_extras', '{}'::jsonb));
end;
$$;
revoke execute on function preview_quote_price(jsonb) from public, anon;
grant execute on function preview_quote_price(jsonb) to authenticated;
