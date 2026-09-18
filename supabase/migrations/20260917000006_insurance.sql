-- Insurance providers, plans, add-ons, and IDV depreciation slabs.

create table insurance_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_insurance_providers_updated_at before update on insurance_providers for each row execute function set_updated_at();

create table insurance_plans (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references insurance_providers(id),
  coverage_type text not null,
  pricing_basis text not null,
  base_rate numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (pricing_basis in ('idv_percentage', 'flat', 'slab'))
);
create index idx_insurance_plans_provider_id on insurance_plans(provider_id);
create trigger trg_insurance_plans_updated_at before update on insurance_plans for each row execute function set_updated_at();

create table insurance_addons (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric not null,
  applicable_coverage_types text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_insurance_addons_updated_at before update on insurance_addons for each row execute function set_updated_at();

-- Placeholder slabs — ask the customer for the actual TKM/insurer depreciation table before go-live.
create table idv_slabs (
  id uuid primary key default gen_random_uuid(),
  min_age_months int not null,
  max_age_months int not null,
  depreciation_percentage numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (max_age_months >= min_age_months)
);
create trigger trg_idv_slabs_updated_at before update on idv_slabs for each row execute function set_updated_at();
