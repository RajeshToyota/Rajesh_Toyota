-- Configurable TCS rate. Do not hardcode the rate inside the pricing function — read it from here.

create table tax_config (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  rate_percentage numeric not null,
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
create trigger trg_tax_config_updated_at before update on tax_config for each row execute function set_updated_at();
