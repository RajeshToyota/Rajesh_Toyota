-- Accessories and value-added services (VAS).

create table accessories (
  id uuid primary key default gen_random_uuid(),
  model_id uuid references models(id),
  variant_id uuid references variants(id),
  name text not null,
  part_no text,
  price numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_accessories_model_id on accessories(model_id);
create index idx_accessories_variant_id on accessories(variant_id);
create trigger trg_accessories_updated_at before update on accessories for each row execute function set_updated_at();

create table vas_products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pricing_type text not null,
  price numeric not null,
  tenure_months int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (pricing_type in ('flat', 'slab_by_model'))
);
create trigger trg_vas_products_updated_at before update on vas_products for each row execute function set_updated_at();
