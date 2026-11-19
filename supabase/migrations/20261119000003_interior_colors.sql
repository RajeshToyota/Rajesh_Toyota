-- Interior colours.
--
-- Until now the interior was written into some variant names ("Fortuner 4x2 AT (Black)",
-- "Hycross VX 7S Hybrid (2 Tone Ash Brown)", "... (Black & Maroon)"). It is now its own master:
--   interior_colors            – the list of interiors (Black, Chamois, Maroon, ...)
--   variant_interior_colors    – which interiors each variant comes in. "Black & Maroon" in a name
--                                meant the customer picks one, so those variants get two rows.
--   quotes / bookings / enquiries.interior_color_id – the interior chosen.
-- A variant with one interior fills it in automatically; with two, it is picked on the quote.
-- Names lose the colour; where two TKM suffixes then read the same (Fortuner Black vs Chamois,
-- Land Cruiser 300, Vellfire VIP), the suffix code is added in brackets as other names already do.

-- 1. Masters --------------------------------------------------------------------------------

create table public.interior_colors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.variant_interior_colors (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.variants(id) on delete cascade,
  interior_color_id uuid not null references public.interior_colors(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (variant_id, interior_color_id)
);
create index idx_variant_interior_colors_interior on public.variant_interior_colors(interior_color_id);

create trigger trg_interior_colors_updated_at before update on public.interior_colors
  for each row execute function public.set_updated_at();
create trigger trg_variant_interior_colors_updated_at before update on public.variant_interior_colors
  for each row execute function public.set_updated_at();

-- Same access as colors / variant_colors: everyone signed in reads, master-data admins write.
alter table public.interior_colors enable row level security;
alter table public.variant_interior_colors enable row level security;

create policy interior_colors_select on public.interior_colors for select to authenticated using (true);
create policy interior_colors_write on public.interior_colors for insert to authenticated with check (public.is_master_data_admin());
create policy interior_colors_modify on public.interior_colors for update to authenticated using (public.is_master_data_admin()) with check (public.is_master_data_admin());
create policy interior_colors_delete on public.interior_colors for delete to authenticated using (public.is_master_data_admin());

create policy variant_interior_colors_select on public.variant_interior_colors for select to authenticated using (true);
create policy variant_interior_colors_write on public.variant_interior_colors for insert to authenticated with check (public.is_master_data_admin());
create policy variant_interior_colors_modify on public.variant_interior_colors for update to authenticated using (public.is_master_data_admin()) with check (public.is_master_data_admin());
create policy variant_interior_colors_delete on public.variant_interior_colors for delete to authenticated using (public.is_master_data_admin());

-- 2. Seed from the colours that were in the variant names ------------------------------------

insert into public.interior_colors (name) values
  ('Black'), ('Chamois'), ('Maroon'), ('2-Tone Ash Brown'), ('Brown'), ('Dark Red'), ('Neutral Beige');

insert into public.variant_interior_colors (variant_id, interior_color_id)
select v.id, ic.id
from (values
  ('FRNBK', 'Black'), ('FRNBJ', 'Black'), ('FRNBN', 'Black'), ('FRNBI', 'Black'),
  ('FRNCK', 'Chamois'), ('FRNCN', 'Chamois'), ('FRNCI', 'Chamois'),
  ('FRNB6', 'Black'), ('FRNB6', 'Maroon'),
  ('FRNP6', 'Black'), ('FRNP6', 'Maroon'),
  ('FRNB5', 'Black'), ('FRNB5', 'Maroon'),
  ('FRN3L', 'Black'), ('FRN3L', 'Maroon'),
  ('FRN1L', 'Black'), ('FRN1L', 'Maroon'),
  ('FRN0L', 'Black'), ('FRN0L', 'Maroon'),
  ('FRN2L', 'Black'), ('FRN2L', 'Maroon'),
  ('INNYI', 'Black'), ('INNYJ', 'Black'),
  ('INNYK', '2-Tone Ash Brown'), ('INNYL', '2-Tone Ash Brown'),
  ('INNYE', '2-Tone Ash Brown'), ('INNYF', '2-Tone Ash Brown'),
  ('INNYC', '2-Tone Ash Brown'), ('INNYD', '2-Tone Ash Brown'),
  ('INNYB', 'Brown'), ('INNYA', 'Brown'),
  ('LCRL0', 'Black'), ('LCRL0', 'Dark Red'),
  ('LCRL1', 'Black'), ('LCRL2', 'Black'), ('LCRL3', 'Brown'),
  ('VELE5', 'Black'), ('VELE6', 'Brown'), ('VELE7', 'Neutral Beige')
) as m(suffix, interior)
join public.variants v on v.suffix = m.suffix
join public.interior_colors ic on ic.name = m.interior;

-- 3. Take the colour out of the names --------------------------------------------------------

update public.variants v
set name = n.name, updated_at = now()
from (values
  ('FRNBK', 'Fortuner 4x2 AT (BK)'),
  ('FRNCK', 'Fortuner 4x2 AT (CK)'),
  ('FRNBJ', 'Fortuner 4x2 MT (BJ)'),
  ('FRNBN', 'Fortuner 4x4 AT (BN)'),
  ('FRNCN', 'Fortuner 4x4 AT (CN)'),
  ('FRNBI', 'Fortuner 4x4 MT (BI)'),
  ('FRNCI', 'Fortuner 4x4 MT (CI)'),
  ('FRNB6', 'Fortuner Leader Edition 4x2 AT'),
  ('FRNP6', 'Fortuner Petrol 4x2 AT'),
  ('FRNB5', 'Fortuner Leader Edition 4x2 MT'),
  ('FRN3L', 'Fortuner GR-S 4x4 AT'),
  ('FRN1L', 'Fortuner Legender 4x2 AT'),
  ('FRN0L', 'Fortuner Legender 4x4 AT'),
  ('FRN2L', 'Fortuner Legender 4x4 MT'),
  ('INNYI', 'Innova Hycross GX Petrol 7S'),
  ('INNYJ', 'Innova Hycross GX Petrol 8S'),
  ('INNYK', 'Innova Hycross GX(O) Petrol 7S'),
  ('INNYL', 'Innova Hycross GX(O) Petrol 8S'),
  ('INNYE', 'Innova Hycross VX Hybrid 7S'),
  ('INNYF', 'Innova Hycross VX Hybrid 8S'),
  ('INNYC', 'Innova Hycross VX(O) Hybrid 7S'),
  ('INNYD', 'Innova Hycross VX(O) Hybrid 8S'),
  ('INNYB', 'Innova Hycross ZX Hybrid 7S'),
  ('INNYA', 'Innova Hycross ZX(O) Hybrid 7S'),
  ('LCRL0', 'Land Cruiser 300 GR-S (L0)'),
  ('LCRL1', 'Land Cruiser 300 GR-S (L1)'),
  ('LCRL2', 'Land Cruiser 300 ZX (L2)'),
  ('LCRL3', 'Land Cruiser 300 ZX (L3)'),
  ('VELE5', 'Vellfire Hybrid VIP (E5)'),
  ('VELE6', 'Vellfire Hybrid VIP (E6)'),
  ('VELE7', 'Vellfire Hybrid VIP (E7)')
) as n(suffix, name)
where v.suffix = n.suffix
  and v.name is distinct from n.name;

-- 4. The chosen interior on quotes, bookings and enquiries ------------------------------------

alter table public.quotes    add column interior_color_id uuid references public.interior_colors(id);
alter table public.bookings  add column interior_color_id uuid references public.interior_colors(id);
alter table public.enquiries add column interior_color_id uuid references public.interior_colors(id);
create index idx_quotes_interior_color_id    on public.quotes(interior_color_id);
create index idx_bookings_interior_color_id  on public.bookings(interior_color_id);
create index idx_enquiries_interior_color_id on public.enquiries(interior_color_id);

-- Keeps interior_color_id in step with the variant:
--  * a variant with exactly one interior gets it filled in;
--  * an interior the variant doesn't come in is refused when someone sets it, but quietly cleared
--    when only the variant changed (so a CTDMS variant update never fails on it).
create or replace function public.apply_interior_color()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_options uuid[];
begin
  if NEW.variant_id is null then
    return NEW;
  end if;

  select coalesce(array_agg(interior_color_id), '{}') into v_options
  from public.variant_interior_colors
  where variant_id = NEW.variant_id;

  if cardinality(v_options) = 0 then
    return NEW;  -- no interiors set up for this variant: leave whatever is there
  end if;

  if NEW.interior_color_id is not null and not (NEW.interior_color_id = any (v_options)) then
    if TG_OP = 'UPDATE'
       and NEW.variant_id is distinct from OLD.variant_id
       and NEW.interior_color_id is not distinct from OLD.interior_color_id then
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

create trigger trg_quotes_interior_color before insert or update of variant_id, interior_color_id on public.quotes
  for each row execute function public.apply_interior_color();
create trigger trg_bookings_interior_color before insert or update of variant_id, interior_color_id on public.bookings
  for each row execute function public.apply_interior_color();
create trigger trg_enquiries_interior_color before insert or update of variant_id, interior_color_id on public.enquiries
  for each row execute function public.apply_interior_color();

-- Fill existing rows whose variant has only one interior.
update public.quotes t set interior_color_id = vic.interior_color_id
from public.variant_interior_colors vic
where vic.variant_id = t.variant_id and t.interior_color_id is null
  and (select count(*) from public.variant_interior_colors x where x.variant_id = t.variant_id) = 1;
update public.bookings t set interior_color_id = vic.interior_color_id
from public.variant_interior_colors vic
where vic.variant_id = t.variant_id and t.interior_color_id is null
  and (select count(*) from public.variant_interior_colors x where x.variant_id = t.variant_id) = 1;
update public.enquiries t set interior_color_id = vic.interior_color_id
from public.variant_interior_colors vic
where vic.variant_id = t.variant_id and t.interior_color_id is null
  and (select count(*) from public.variant_interior_colors x where x.variant_id = t.variant_id) = 1;
