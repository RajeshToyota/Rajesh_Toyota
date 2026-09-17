-- Schemes: discount/subvention line items, with mutually-exclusive groups and margin visibility flags.

create table schemes (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references models(id),
  suffix_scope text,
  name text not null,
  valid_from date not null,
  valid_to date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_to >= valid_from)
);
create index idx_schemes_model_id on schemes(model_id);
create index idx_schemes_validity on schemes(valid_from, valid_to);
create trigger trg_schemes_updated_at before update on schemes for each row execute function set_updated_at();

create table scheme_line_items (
  id uuid primary key default gen_random_uuid(),
  scheme_id uuid not null references schemes(id) on delete cascade,
  line_type text not null,
  tkm_share numeric not null default 0,
  dealer_share numeric not null default 0,
  is_customer_facing boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_scheme_line_items_scheme_id on scheme_line_items(scheme_id);
create trigger trg_scheme_line_items_updated_at before update on scheme_line_items for each row execute function set_updated_at();

create table scheme_conditions (
  id uuid primary key default gen_random_uuid(),
  scheme_line_item_id uuid not null references scheme_line_items(id) on delete cascade,
  mutually_exclusive_group text,
  requires_exchange boolean not null default false,
  requires_scrap boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_scheme_conditions_line_item_id on scheme_conditions(scheme_line_item_id);
create index idx_scheme_conditions_group on scheme_conditions(mutually_exclusive_group);
create trigger trg_scheme_conditions_updated_at before update on scheme_conditions for each row execute function set_updated_at();
