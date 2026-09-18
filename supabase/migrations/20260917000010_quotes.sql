-- Quotes. Price is a live-recomputed value; priced_snapshot/total_amount are indicative-only
-- snapshots for display/PDF/audit, never treated as a locked-in price at booking time.

create table quotes (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references outlets(id),
  employee_id uuid not null references employees(id),
  customer_name text not null,
  customer_phone text,
  customer_mobile text,
  variant_id uuid not null references variants(id),
  color_id uuid not null references colors(id),
  rto_category_id uuid not null references rto_categories(id),
  scrap_certificate_id uuid references scrap_certificates(id),
  insurance_plan_id uuid references insurance_plans(id),
  insurance_addon_ids uuid[] not null default '{}',
  accessory_ids uuid[] not null default '{}',
  vas_product_ids uuid[] not null default '{}',
  selected_scheme_line_item_ids uuid[] not null default '{}',
  priced_snapshot jsonb,
  total_amount numeric,
  dealer_margin numeric,
  priced_as_of timestamptz,
  status text not null default 'draft',
  pdf_storage_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status in ('draft', 'sent', 'converted', 'expired'))
);
create index idx_quotes_outlet_id on quotes(outlet_id);
create index idx_quotes_employee_id on quotes(employee_id);
create index idx_quotes_status on quotes(status);
create trigger trg_quotes_updated_at before update on quotes for each row execute function set_updated_at();

alter table scrap_certificates
  add constraint fk_scrap_certificates_quote foreign key (linked_quote_id) references quotes(id);
