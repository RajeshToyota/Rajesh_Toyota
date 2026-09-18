-- Real TKM price sheets give insurance premiums and VAS prices as flat rupee amounts per
-- variant (not a %-of-IDV formula, and not one flat number org-wide) — both master-data shapes
-- Phase 0's schema didn't anticipate. Extend both to be scoped like accessories/RTO already are.

-- Insurance: mirrors rto_pricing's shape (scoped to variant OR model, by state, effective-dated).
-- calculate_price prefers an insurance_pricing match when one exists, falling back to the
-- existing pricing_basis (idv_percentage/flat) logic on insurance_plans for plans that don't
-- have variant-specific numbers.
create table insurance_pricing (
  id uuid primary key default gen_random_uuid(),
  insurance_plan_id uuid not null references insurance_plans(id),
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
create index idx_insurance_pricing_lookup on insurance_pricing(insurance_plan_id, state, model_id, variant_id, effective_from, effective_to);
create trigger trg_insurance_pricing_updated_at before update on insurance_pricing for each row execute function set_updated_at();

alter table insurance_pricing enable row level security;
create policy insurance_pricing_select on insurance_pricing for select to authenticated using (true);
create policy insurance_pricing_write on insurance_pricing for insert to authenticated with check (is_master_data_admin());
create policy insurance_pricing_modify on insurance_pricing for update to authenticated using (is_master_data_admin()) with check (is_master_data_admin());
create policy insurance_pricing_delete on insurance_pricing for delete to authenticated using (is_master_data_admin());

-- VAS: same model_id/variant_id scoping accessories already has, since a "Smile Package" costs a
-- different amount on a Camry than an Innova Crysta.
alter table vas_products add column model_id uuid references models(id);
alter table vas_products add column variant_id uuid references variants(id);
create index idx_vas_products_model_id on vas_products(model_id);
create index idx_vas_products_variant_id on vas_products(variant_id);
