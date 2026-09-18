-- Phase 0 seed data: enough to develop the pricing engine, dashboard, and mobile app against.
-- Placeholder/stub values are flagged inline — confirm real numbers before go-live.

-- Roles (rank: lower = more senior)
insert into roles (id, name, rank) values
  ('00000000-0000-0000-0001-000000000001', 'Admin', 0),
  ('00000000-0000-0000-0001-000000000002', 'Business Head', 1),
  ('00000000-0000-0000-0001-000000000003', 'Outlet Head', 2),
  ('00000000-0000-0000-0001-000000000004', 'Head Customer Relations', 3),
  ('00000000-0000-0000-0001-000000000005', 'Team Leader', 4),
  ('00000000-0000-0000-0001-000000000006', 'Sales Consultant', 5);

-- Outlets
insert into outlets (id, name, dealer_code, city, state, address) values
  ('00000000-0000-0000-0002-000000000001', 'Rajesh Toyota - Jaipur Civil Lines', 'RT-JPR-01', 'Jaipur', 'Rajasthan', 'Civil Lines, Jaipur'),
  ('00000000-0000-0000-0002-000000000002', 'Rajesh Toyota - Jodhpur', 'RT-JDH-01', 'Jodhpur', 'Rajasthan', 'Jodhpur');

-- Employees across the hierarchy (auth_user_id left null until real accounts are created in Phase 2)
insert into employees (id, name, phone, email, role_id, outlet_id, reports_to_employee_id) values
  ('00000000-0000-0000-0003-000000000001', 'Admin User', '9000000001', 'admin@rajeshtoyota.com', '00000000-0000-0000-0001-000000000001', null, null),
  ('00000000-0000-0000-0003-000000000002', 'Business Head', '9000000002', 'bh@rajeshtoyota.com', '00000000-0000-0000-0001-000000000002', null, '00000000-0000-0000-0003-000000000001'),
  ('00000000-0000-0000-0003-000000000003', 'Jaipur Outlet Head', '9000000003', 'oh.jaipur@rajeshtoyota.com', '00000000-0000-0000-0001-000000000003', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000002'),
  ('00000000-0000-0000-0003-000000000004', 'Jaipur Team Leader', '9000000004', 'tl.jaipur@rajeshtoyota.com', '00000000-0000-0000-0001-000000000005', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000003'),
  ('00000000-0000-0000-0003-000000000005', 'Jaipur Sales Consultant 1', '9000000005', 'sc1.jaipur@rajeshtoyota.com', '00000000-0000-0000-0001-000000000006', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000004'),
  ('00000000-0000-0000-0003-000000000006', 'Jaipur Sales Consultant 2', '9000000006', 'sc2.jaipur@rajeshtoyota.com', '00000000-0000-0000-0001-000000000006', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0003-000000000004'),
  ('00000000-0000-0000-0003-000000000007', 'Jodhpur Outlet Head', '9000000007', 'oh.jodhpur@rajeshtoyota.com', '00000000-0000-0000-0001-000000000003', '00000000-0000-0000-0002-000000000002', '00000000-0000-0000-0003-000000000002'),
  ('00000000-0000-0000-0003-000000000008', 'Jodhpur Sales Consultant 1', '9000000008', 'sc1.jodhpur@rajeshtoyota.com', '00000000-0000-0000-0001-000000000006', '00000000-0000-0000-0002-000000000002', '00000000-0000-0000-0003-000000000007');

-- Catalog: fuel types, transmissions, models, variants, colors
insert into fuel_types (id, name) values
  ('00000000-0000-0000-0004-000000000001', 'Petrol'),
  ('00000000-0000-0000-0004-000000000002', 'Diesel'),
  ('00000000-0000-0000-0004-000000000003', 'Hybrid');

insert into transmissions (id, name) values
  ('00000000-0000-0000-0005-000000000001', 'MT'),
  ('00000000-0000-0000-0005-000000000002', 'AT'),
  ('00000000-0000-0000-0005-000000000003', 'CVT');

insert into models (id, name, segment) values
  ('00000000-0000-0000-0006-000000000001', 'Innova Crysta', 'MUV'),
  ('00000000-0000-0000-0006-000000000002', 'Fortuner', 'SUV');

insert into variants (id, model_id, fuel_type_id, transmission_id, suffix, name) values
  ('00000000-0000-0000-0007-000000000001', '00000000-0000-0000-0006-000000000001', '00000000-0000-0000-0004-000000000002', '00000000-0000-0000-0005-000000000001', 'GX', 'Innova Crysta 2.4 GX MT Diesel'),
  ('00000000-0000-0000-0007-000000000002', '00000000-0000-0000-0006-000000000001', '00000000-0000-0000-0004-000000000002', '00000000-0000-0000-0005-000000000002', 'VX', 'Innova Crysta 2.4 VX AT Diesel'),
  ('00000000-0000-0000-0007-000000000003', '00000000-0000-0000-0006-000000000002', '00000000-0000-0000-0004-000000000002', '00000000-0000-0000-0005-000000000002', 'GR-S', 'Fortuner 2.8 GR-S AT Diesel');

insert into colors (id, name, hex, is_dual_tone) values
  ('00000000-0000-0000-0008-000000000001', 'Super White', '#FFFFFF', false),
  ('00000000-0000-0000-0008-000000000002', 'Silver Metallic', '#C0C0C0', false),
  ('00000000-0000-0000-0008-000000000003', 'Attitude Black Mica', '#1C1C1C', false);

insert into variant_colors (variant_id, color_id, extra_cost) values
  ('00000000-0000-0000-0007-000000000001', '00000000-0000-0000-0008-000000000001', 0),
  ('00000000-0000-0000-0007-000000000001', '00000000-0000-0000-0008-000000000002', 8500),
  ('00000000-0000-0000-0007-000000000002', '00000000-0000-0000-0008-000000000001', 0),
  ('00000000-0000-0000-0007-000000000002', '00000000-0000-0000-0008-000000000003', 8500),
  ('00000000-0000-0000-0007-000000000003', '00000000-0000-0000-0008-000000000001', 0),
  ('00000000-0000-0000-0007-000000000003', '00000000-0000-0000-0008-000000000003', 12000);

insert into price_list (variant_id, color_id, ex_showroom_price, dealer_purchase_price, state, effective_from) values
  ('00000000-0000-0000-0007-000000000001', '00000000-0000-0000-0008-000000000001', 2154000, 1980000, 'Rajasthan', '2026-04-01'),
  ('00000000-0000-0000-0007-000000000001', '00000000-0000-0000-0008-000000000002', 2162500, 1988000, 'Rajasthan', '2026-04-01'),
  ('00000000-0000-0000-0007-000000000002', '00000000-0000-0000-0008-000000000001', 2489000, 2290000, 'Rajasthan', '2026-04-01'),
  ('00000000-0000-0000-0007-000000000002', '00000000-0000-0000-0008-000000000003', 2497500, 2298000, 'Rajasthan', '2026-04-01'),
  ('00000000-0000-0000-0007-000000000003', '00000000-0000-0000-0008-000000000001', 4432000, 4100000, 'Rajasthan', '2026-04-01'),
  ('00000000-0000-0000-0007-000000000003', '00000000-0000-0000-0008-000000000003', 4444000, 4111000, 'Rajasthan', '2026-04-01');

-- Scheme: one customer-facing discount, one mutually-exclusive pair, one dealer-only margin item
insert into schemes (id, model_id, suffix_scope, name, valid_from, valid_to) values
  ('00000000-0000-0000-0009-000000000001', '00000000-0000-0000-0006-000000000001', null, 'Innova Crysta Festive Scheme - Sept 2026', '2026-09-01', '2026-09-30');

insert into scheme_line_items (id, scheme_id, line_type, tkm_share, dealer_share, is_customer_facing) values
  ('00000000-0000-0000-000a-000000000001', '00000000-0000-0000-0009-000000000001', 'Sales Discount', 15000, 10000, true),
  ('00000000-0000-0000-000a-000000000002', '00000000-0000-0000-0009-000000000001', 'Exchange Bonus', 0, 20000, true),
  ('00000000-0000-0000-000a-000000000003', '00000000-0000-0000-0009-000000000001', 'Loyalty Bonus', 0, 10000, true),
  ('00000000-0000-0000-000a-000000000004', '00000000-0000-0000-0009-000000000001', 'TFS Subvention', 0, 8000, false);

insert into scheme_conditions (scheme_line_item_id, mutually_exclusive_group, requires_exchange, requires_scrap) values
  ('00000000-0000-0000-000a-000000000002', 'exchange_or_loyalty', true, false),
  ('00000000-0000-0000-000a-000000000003', 'exchange_or_loyalty', false, false);

-- RTO
insert into rto_categories (id, name) values
  ('00000000-0000-0000-000b-000000000001', 'Regular'),
  ('00000000-0000-0000-000b-000000000002', 'BH'),
  ('00000000-0000-0000-000b-000000000003', 'TRC'),
  ('00000000-0000-0000-000b-000000000004', 'Scrap-linked');

insert into rto_pricing (rto_category_id, state, model_id, amount, effective_from) values
  ('00000000-0000-0000-000b-000000000001', 'Rajasthan', '00000000-0000-0000-0006-000000000001', 195000, '2026-04-01'),
  ('00000000-0000-0000-000b-000000000004', 'Rajasthan', '00000000-0000-0000-0006-000000000001', 175000, '2026-04-01'),
  ('00000000-0000-0000-000b-000000000001', 'Rajasthan', '00000000-0000-0000-0006-000000000002', 385000, '2026-04-01');

-- Insurance (placeholder rates — confirm with the actual insurer rate card before go-live)
insert into insurance_providers (id, name) values
  ('00000000-0000-0000-000c-000000000001', 'TATA AIG (via Rajesh Toyota)');

insert into insurance_plans (id, provider_id, coverage_type, pricing_basis, base_rate) values
  ('00000000-0000-0000-000d-000000000001', '00000000-0000-0000-000c-000000000001', '3+1', 'idv_percentage', 3.2),
  ('00000000-0000-0000-000d-000000000002', '00000000-0000-0000-000c-000000000001', '3+3', 'idv_percentage', 4.5);

insert into insurance_addons (name, price, applicable_coverage_types) values
  ('Zero Depreciation', 4500, array['3+1', '3+3']),
  ('Engine Protector', 2200, array['3+1', '3+3']),
  ('Roadside Assistance', 750, array['3+1', '3+3']);

-- Placeholder IDV depreciation slabs — STUB, confirm real table before go-live
insert into idv_slabs (min_age_months, max_age_months, depreciation_percentage) values
  (0, 6, 5),
  (7, 12, 15),
  (13, 24, 20),
  (25, 36, 30),
  (37, 48, 40),
  (49, 60, 50);

-- Accessories & VAS
insert into accessories (model_id, name, part_no, price) values
  ('00000000-0000-0000-0006-000000000001', 'All Weather Floor Mats', 'ACC-FM-001', 3500),
  ('00000000-0000-0000-0006-000000000001', 'Body Cover', 'ACC-BC-001', 2200),
  ('00000000-0000-0000-0006-000000000002', 'Seat Covers - Leatherette', 'ACC-SC-002', 12500);

insert into vas_products (name, pricing_type, price, tenure_months) values
  ('Smiles Package', 'flat', 15000, 36),
  ('T-Gloss', 'flat', 6500, null),
  ('Extended Warranty 2yr', 'flat', 18000, 24);

-- Tax config — STUB rate, confirm current TCS % with finance before go-live
insert into tax_config (name, rate_percentage, effective_from) values
  ('TCS on sale of motor vehicle', 1.0, '2026-04-01');

-- Approval thresholds — STUB placeholder values, confirm real thresholds before go-live
insert into approval_rules (outlet_id, discount_threshold, required_role_id) values
  (null, 10000, '00000000-0000-0000-0001-000000000005'),
  (null, 50000, '00000000-0000-0000-0001-000000000003');
