-- Discount approval rules and approval request records.

create table approval_rules (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid references outlets(id),
  discount_threshold numeric not null,
  required_role_id uuid not null references roles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_approval_rules_outlet_id on approval_rules(outlet_id);
create trigger trg_approval_rules_updated_at before update on approval_rules for each row execute function set_updated_at();

create table approvals (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid,
  booking_id uuid,
  requested_by_employee_id uuid not null references employees(id),
  required_role_id uuid not null references roles(id),
  approver_employee_id uuid references employees(id),
  status text not null default 'pending',
  requested_discount_amount numeric not null,
  comment text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status in ('pending', 'approved', 'rejected')),
  check (quote_id is not null or booking_id is not null)
);
create index idx_approvals_quote_id on approvals(quote_id);
create index idx_approvals_booking_id on approvals(booking_id);
create index idx_approvals_requested_by on approvals(requested_by_employee_id);
create index idx_approvals_status on approvals(status);
create trigger trg_approvals_updated_at before update on approvals for each row execute function set_updated_at();
