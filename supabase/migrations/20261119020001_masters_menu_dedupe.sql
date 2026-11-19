-- The Phase 24 masters pages are reached from the Masters drill-down (their tables under each group,
-- their own tools as "Colour Photos", "RTO Calculator", …), so their flat links would show each
-- screen twice. Routes and rights stay; only the flat menu entries go.
update app_modules set in_menu = false
where key in ('catalog', 'insurance_rates', 'rto_settings', 'schemes', 'discount_rules');
