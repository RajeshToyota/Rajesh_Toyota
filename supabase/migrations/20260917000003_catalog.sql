-- Catalog: models, variants, colors, price list.

create table models (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  segment text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_models_updated_at before update on models for each row execute function set_updated_at();

create table fuel_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_fuel_types_updated_at before update on fuel_types for each row execute function set_updated_at();

create table transmissions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_transmissions_updated_at before update on transmissions for each row execute function set_updated_at();

create table variants (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references models(id),
  fuel_type_id uuid not null references fuel_types(id),
  transmission_id uuid not null references transmissions(id),
  suffix text not null,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_variants_model_id on variants(model_id);
create trigger trg_variants_updated_at before update on variants for each row execute function set_updated_at();

create table colors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  hex text,
  is_dual_tone boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_colors_updated_at before update on colors for each row execute function set_updated_at();

create table variant_colors (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references variants(id),
  color_id uuid not null references colors(id),
  extra_cost numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (variant_id, color_id)
);
create index idx_variant_colors_variant_id on variant_colors(variant_id);
create trigger trg_variant_colors_updated_at before update on variant_colors for each row execute function set_updated_at();

create table price_list (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references variants(id),
  color_id uuid not null references colors(id),
  ex_showroom_price numeric not null,
  dealer_purchase_price numeric,
  state text not null,
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
create index idx_price_list_lookup on price_list(variant_id, color_id, state, effective_from, effective_to);
create trigger trg_price_list_updated_at before update on price_list for each row execute function set_updated_at();
