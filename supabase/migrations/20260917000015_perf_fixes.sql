-- Performance advisor fixes: add covering indexes for FKs, and narrow master-data "write" RLS
-- policies to insert/update/delete only (they were "for all", which duplicated the "_select"
-- policy's SELECT grant and forced Postgres to evaluate both permissive policies per query).

create index idx_variants_fuel_type_id on variants(fuel_type_id);
create index idx_variants_transmission_id on variants(transmission_id);
create index idx_variant_colors_color_id on variant_colors(color_id);
create index idx_price_list_color_id on price_list(color_id);
create index idx_rto_pricing_model_id on rto_pricing(model_id);
create index idx_rto_pricing_variant_id on rto_pricing(variant_id);
create index idx_scrap_certificates_quote_id on scrap_certificates(linked_quote_id);
create index idx_scrap_certificates_booking_id on scrap_certificates(linked_booking_id);
create index idx_quotes_variant_id on quotes(variant_id);
create index idx_quotes_color_id on quotes(color_id);
create index idx_quotes_rto_category_id on quotes(rto_category_id);
create index idx_quotes_scrap_certificate_id on quotes(scrap_certificate_id);
create index idx_quotes_insurance_plan_id on quotes(insurance_plan_id);
create index idx_bookings_variant_id on bookings(variant_id);
create index idx_bookings_color_id on bookings(color_id);
create index idx_bookings_rto_category_id on bookings(rto_category_id);
create index idx_bookings_scrap_certificate_id on bookings(scrap_certificate_id);
create index idx_bookings_insurance_plan_id on bookings(insurance_plan_id);
create index idx_approval_rules_required_role_id on approval_rules(required_role_id);
create index idx_approvals_required_role_id on approvals(required_role_id);
create index idx_approvals_approver_employee_id on approvals(approver_employee_id);

do $$
declare
  t text;
begin
  for t in select unnest(array[
    'outlets', 'roles',
    'models', 'fuel_types', 'transmissions', 'variants', 'colors', 'variant_colors', 'price_list',
    'schemes', 'scheme_line_items', 'scheme_conditions',
    'rto_categories', 'rto_pricing',
    'insurance_providers', 'insurance_plans', 'insurance_addons', 'idv_slabs',
    'accessories', 'vas_products',
    'tax_config',
    'approval_rules'
  ])
  loop
    execute format('drop policy %I_write on %I', t, t);
    execute format('create policy %I_write on %I for insert to authenticated with check (is_master_data_admin())', t, t);
    execute format('create policy %I_modify on %I for update to authenticated using (is_master_data_admin()) with check (is_master_data_admin())', t, t);
    execute format('create policy %I_delete on %I for delete to authenticated using (is_master_data_admin())', t, t);
  end loop;
end $$;

drop policy employees_write on employees;
create policy employees_write on employees for insert to authenticated with check (is_master_data_admin());
create policy employees_modify on employees for update to authenticated using (is_master_data_admin()) with check (is_master_data_admin());
create policy employees_delete on employees for delete to authenticated using (is_master_data_admin());
