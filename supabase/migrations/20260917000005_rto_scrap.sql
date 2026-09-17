-- RTO categories/pricing, and scrap certificates.

create table rto_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_rto_categories_updated_at before update on rto_categories for each row execute function set_updated_at();

create table rto_pricing (
  id uuid primary key default gen_random_uuid(),
  rto_category_id uuid not null references rto_categories(id),
  state text not null,
  model_id uuid references models(id),
  variant_id uuid references variants(id),
  amount numeric not null,
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  check (model_id is not null or variant_id is not null)
);
create index idx_rto_pricing_lookup on rto_pricing(rto_category_id, state, model_id, variant_id, effective_from, effective_to);
create trigger trg_rto_pricing_updated_at before update on rto_pricing for each row execute function set_updated_at();

create table scrap_certificates (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  amount numeric,
  certificate_number text,
  document_url text,
  linked_quote_id uuid,
  linked_booking_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source in ('Rajesh Toyota', 'Self'))
);
create trigger trg_scrap_certificates_updated_at before update on scrap_certificates for each row execute function set_updated_at();
