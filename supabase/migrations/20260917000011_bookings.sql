-- Bookings. Re-priced independently at booking time (never inherits a quote's stored price).
-- status 'booked' | 'allocated' | 'delivered' | 'cancelled'. A future 'ready_to_invoice' value
-- is the extension point for the deferred invoicing/third-re-pricing phase — not built here.

create table bookings (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid references quotes(id),
  outlet_id uuid not null references outlets(id),
  employee_id uuid not null references employees(id),
  order_booking_no text,
  ctdms_enquiry_no text,
  ctdms_order_booking_no text,

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
  priced_as_of timestamptz,

  pan_number text,
  date_of_birth date,
  marital_status text,
  wedding_anniversary date,
  family_size int,
  family_status text,
  qualification text,
  income_group text,
  occupation text,

  registration_type text,
  vehicle_booked_type text,
  replacement_vehicle_details text,
  mode_of_purchase text,
  nominee_name text,
  mothers_maiden_name text,

  is_company_purchase boolean not null default false,
  company_name text,
  company_contact_person text,
  company_designation text,
  driving_licence_number text,

  payment_instrument_type text,
  payment_instrument_no text,
  payment_date date,
  payment_amount numeric,
  payment_bank_name text,

  data_consent boolean not null default false,
  signature_storage_path text,
  likely_delivery_date date,
  status text not null default 'booked',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status in ('booked', 'allocated', 'delivered', 'cancelled', 'ready_to_invoice'))
);
create index idx_bookings_quote_id on bookings(quote_id);
create index idx_bookings_outlet_id on bookings(outlet_id);
create index idx_bookings_employee_id on bookings(employee_id);
create index idx_bookings_status on bookings(status);
create trigger trg_bookings_updated_at before update on bookings for each row execute function set_updated_at();

alter table scrap_certificates
  add constraint fk_scrap_certificates_booking foreign key (linked_booking_id) references bookings(id);

alter table approvals
  add constraint fk_approvals_quote foreign key (quote_id) references quotes(id),
  add constraint fk_approvals_booking foreign key (booking_id) references bookings(id);
