-- Lost to Competition (Reporting): customers who enquired with us and then registered a car bought
-- from another Toyota dealer or another brand, found by matching the RTO registration dump to the
-- enquiry dump on mobile number. The page reads both files in the browser; nothing is stored, so the
-- only database change is the menu entry and who may open it.
insert into app_modules (key, group_key, label, path, sort_order, in_menu) values
  ('rpt_lost_sales', 'reporting', 'Lost to Competition', '/reports/lost-sales', 95, true)
on conflict (key) do nothing;

select seed_role_rights(r, m, x) from (values
  ('Outlet Head', 'rpt_lost_sales', array['view']),
  ('Head Customer Relations', 'rpt_lost_sales', array['view']),
  ('Team Leader', 'rpt_lost_sales', array['view'])
) v(r, m, x);
