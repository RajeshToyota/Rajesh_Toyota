-- Sales variants: one variant per configuration, the interior picks the TKM suffix.
--
-- TKM gives some configurations one suffix per interior: Fortuner 4x2 AT is FRNBK (Black) or FRNCK
-- (Chamois); Vellfire VIP is VELE5 / VELE6 / VELE7. Those suffix rows stay as they are — stock,
-- CTDMS, the allotment pool, bookings and cars keep pointing at them — but they become *stock codes*
-- under one *sales variant* ("Fortuner 4x2 AT") that holds the name, price list and colours:
--
--   variants.sales_variant_id   set on a stock code, pointing at its sales variant
--   sales_variant(id)           the variant whose price list / colours apply (itself if none)
--
-- Quotes and bookings are made on the sales variant; the chosen interior swaps them to the stock
-- code (apply_interior_color). Pricing reads the sales variant's rows (calculate_price,
-- ex_showroom_on, pool_variant_price, stock_color_id).

-- 1. Structure ------------------------------------------------------------------------------

alter table public.variants
  add column sales_variant_id uuid references public.variants(id),
  add constraint variants_sales_variant_not_self check (sales_variant_id <> id);
create index idx_variants_sales_variant_id on public.variants(sales_variant_id);

create or replace function public.sales_variant(p_variant_id uuid)
returns uuid
language sql
stable
set search_path = public
as $$
  select coalesce(sales_variant_id, id) from public.variants where id = p_variant_id;
$$;

-- 2. Sales variants and their stock codes ------------------------------------------------------

create temporary table sv_map (grp text, sales_name text, sales_suffix text, stock_suffix text, keeps_rows boolean);
insert into sv_map values
  ('4x2at', 'Fortuner 4x2 AT',     'FRN*K', 'FRNBK', true),  ('4x2at', 'Fortuner 4x2 AT',     'FRN*K', 'FRNCK', false),
  ('4x4mt', 'Fortuner 4x4 MT',     'FRN*I', 'FRNBI', true),  ('4x4mt', 'Fortuner 4x4 MT',     'FRN*I', 'FRNCI', false),
  ('4x4at', 'Fortuner 4x4 AT',     'FRN*N', 'FRNBN', true),  ('4x4at', 'Fortuner 4x4 AT',     'FRN*N', 'FRNCN', false),
  ('vip',   'Vellfire Hybrid VIP', 'VELE*', 'VELE5', true),  ('vip',   'Vellfire Hybrid VIP', 'VELE*', 'VELE6', false),
  ('vip',   'Vellfire Hybrid VIP', 'VELE*', 'VELE7', false);

do $$
declare g record;
begin
  -- Every stock code must exist, and within a group the price-list rows and colours must be
  -- identical, so keeping one copy on the sales variant loses nothing.
  if (select count(*) from sv_map m join public.variants v on v.suffix = m.stock_suffix) <> (select count(*) from sv_map) then
    raise exception 'sales_variants: a stock code is missing';
  end if;
  for g in
    select m.grp,
      count(distinct (to_jsonb(p) - 'id' - 'variant_id' - 'created_at' - 'updated_at')::text) filter (where p.id is not null) as price_kinds,
      count(distinct v.id) filter (where p.id is not null) as with_prices,
      count(distinct v.id) as members
    from sv_map m join public.variants v on v.suffix = m.stock_suffix
    left join public.price_list p on p.variant_id = v.id
    group by m.grp
  loop
    if g.price_kinds > 1 or (g.with_prices > 0 and g.with_prices <> g.members) then
      raise exception 'sales_variants: price-list rows differ within group %', g.grp;
    end if;
  end loop;
  if exists (
    select 1 from (
      select m.grp, v.id,
        coalesce(string_agg(vc.color_id::text || '=' || coalesce(vc.extra_cost, 0), ',' order by vc.color_id), '') as cs
      from sv_map m join public.variants v on v.suffix = m.stock_suffix
      left join public.variant_colors vc on vc.variant_id = v.id
      group by m.grp, v.id
    ) x group by grp having count(distinct cs) > 1
  ) then
    raise exception 'sales_variants: colours differ within a group';
  end if;
end $$;

insert into public.variants (model_id, fuel_type_id, transmission_id, suffix, name, is_active,
                             gst_rate_percent, engine_cc, hsn_code, is_ev, pool_manual_only)
select v.model_id, v.fuel_type_id, v.transmission_id, m.sales_suffix, m.sales_name,
       (select bool_or(x.is_active) from sv_map mm join public.variants x on x.suffix = mm.stock_suffix where mm.grp = m.grp),
       v.gst_rate_percent, v.engine_cc, v.hsn_code, v.is_ev, v.pool_manual_only
from sv_map m join public.variants v on v.suffix = m.stock_suffix
where m.keeps_rows;

update public.variants v
set sales_variant_id = s.id, updated_at = now()
from sv_map m join public.variants s on s.suffix = m.sales_suffix
where v.suffix = m.stock_suffix;

-- The sales variant comes in every interior of its stock codes.
insert into public.variant_interior_colors (variant_id, interior_color_id)
select distinct v.sales_variant_id, vic.interior_color_id
from public.variants v join public.variant_interior_colors vic on vic.variant_id = v.id
where v.sales_variant_id is not null
on conflict do nothing;

-- One copy of the price list and colours, on the sales variant.
update public.price_list p set variant_id = v.sales_variant_id
from sv_map m join public.variants v on v.suffix = m.stock_suffix
where p.variant_id = v.id and m.keeps_rows;
delete from public.price_list p
using sv_map m join public.variants v on v.suffix = m.stock_suffix
where p.variant_id = v.id and not m.keeps_rows;

update public.variant_colors vc set variant_id = v.sales_variant_id
from sv_map m join public.variants v on v.suffix = m.stock_suffix
where vc.variant_id = v.id and m.keeps_rows;
delete from public.variant_colors vc
using sv_map m join public.variants v on v.suffix = m.stock_suffix
where vc.variant_id = v.id and not m.keeps_rows;

-- Fortuner 4x2 MT has one interior and one suffix (FRNBJ): it only loses the code from its name.
update public.variants set name = 'Fortuner 4x2 MT', updated_at = now() where suffix = 'FRNBJ';

drop table sv_map;

-- 3. Pricing reads the sales variant ---------------------------------------------------------

do $$
declare
  d text;
  v_old text;
  v_new text;
begin
  -- calculate_price: price everything from the sales variant; keep the stock code's suffix for
  -- suffix-scoped schemes (on a sales variant, the interior says which stock code it is).
  d := pg_get_functiondef('public.calculate_price(jsonb)'::regprocedure);
  v_old := $o$  select model_id, suffix into v_model_id, v_suffix from variants where id = v_variant_id;
  if v_model_id is null then
    raise exception 'Unknown variant_id: %', v_variant_id;
  end if;
$o$;
  v_new := v_old || $n$  if exists (select 1 from variants where sales_variant_id = v_variant_id) then
    v_suffix := coalesce((select c.suffix from variants c
                          join variant_interior_colors vic on vic.variant_id = c.id
                          where c.sales_variant_id = v_variant_id
                            and vic.interior_color_id = nullif(selections->>'interior_color_id', '')::uuid
                          order by c.is_active desc limit 1), v_suffix);
  end if;
  v_variant_id := sales_variant(v_variant_id);
$n$;
  if (length(d) - length(replace(d, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'calculate_price: anchor not found exactly once';
  end if;
  execute replace(d, v_old, v_new);

  -- ex_showroom_on and pool_variant_price: price-list lookups by variant.
  d := pg_get_functiondef('public.ex_showroom_on(uuid,uuid,date,text)'::regprocedure);
  v_old := 'where p.variant_id = p_variant_id';
  if (length(d) - length(replace(d, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'ex_showroom_on: anchor not found exactly once';
  end if;
  execute replace(d, v_old, 'where p.variant_id = sales_variant(p_variant_id)');

  d := pg_get_functiondef('public.pool_variant_price(uuid)'::regprocedure);
  if (length(d) - length(replace(d, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'pool_variant_price: anchor not found exactly once';
  end if;
  execute replace(d, v_old, 'where p.variant_id = sales_variant(p_variant_id)');

  -- stock_color_id: the colours a stock code comes in are its sales variant's.
  d := pg_get_functiondef('public.stock_color_id(uuid,text)'::regprocedure);
  v_old := 'select color_id from variant_colors where variant_id = p_variant_id';
  if (length(d) - length(replace(d, v_old, ''))) / length(v_old) <> 3 then
    raise exception 'stock_color_id: expected 3 variant_colors lookups';
  end if;
  execute replace(d, v_old, 'select color_id from variant_colors where variant_id = sales_variant(p_variant_id)');
end $$;

-- 4. The interior picks the stock code -----------------------------------------------------------

create or replace function public.apply_interior_color()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_options uuid[];
  v_sales uuid;
  v_stock uuid;
  v_variant_only boolean;
begin
  if NEW.variant_id is null then
    return NEW;
  end if;

  -- Only the variant changed (e.g. a CTDMS update to another suffix): the interior follows it.
  v_variant_only := TG_OP = 'UPDATE'
    and NEW.variant_id is distinct from OLD.variant_id
    and NEW.interior_color_id is not distinct from OLD.interior_color_id;

  -- On a sales variant with stock codes, the interior decides which stock code (TKM suffix) the
  -- quote or booking is for. Changing the interior later moves it to the matching stock code.
  v_sales := sales_variant(NEW.variant_id);
  if exists (select 1 from variants where sales_variant_id = v_sales)
     and not (v_variant_only and NEW.variant_id <> v_sales) then
    if NEW.interior_color_id is not null then
      select c.id into v_stock
      from variants c join variant_interior_colors vic on vic.variant_id = c.id
      where c.sales_variant_id = v_sales and vic.interior_color_id = NEW.interior_color_id
      order by c.is_active desc, c.suffix
      limit 1;
      if v_stock is null then
        raise exception 'That interior colour is not offered for this variant';
      end if;
      NEW.variant_id := v_stock;
    elsif NEW.variant_id = v_sales and TG_TABLE_NAME <> 'enquiries' then
      raise exception 'Pick the interior colour: it decides the TKM suffix for this variant';
    end if;
  end if;

  select coalesce(array_agg(interior_color_id), '{}') into v_options
  from variant_interior_colors
  where variant_id = NEW.variant_id;

  if cardinality(v_options) = 0 then
    return NEW;
  end if;

  if NEW.interior_color_id is not null and not (NEW.interior_color_id = any (v_options)) then
    if v_variant_only then
      NEW.interior_color_id := null;
    else
      raise exception 'That interior colour is not offered for this variant';
    end if;
  end if;

  if NEW.interior_color_id is null and cardinality(v_options) = 1 then
    NEW.interior_color_id := v_options[1];
  end if;

  return NEW;
end;
$$;
