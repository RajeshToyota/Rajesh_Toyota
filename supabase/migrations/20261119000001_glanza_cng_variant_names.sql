-- Glanza CNG variants (D24Z5–Z8) were seeded without "CNG" in the name, so they read the
-- same as the petrol variants (e.g. "Glanza G - AMT (Z6)" vs "Glanza G - AMT (ZS)").
-- Restore the names used in the price list.
update public.variants v
set name = n.name, updated_at = now()
from (values
  ('D24Z5', 'Glanza G CNG- MT (Z5)'),
  ('D24Z6', 'Glanza G CNG- AMT (Z6)'),
  ('D24Z7', 'Glanza S CNG-MT (Z7)'),
  ('D24Z8', 'Glanza S CNG-AMT (Z8)')
) as n(suffix, name)
where v.suffix = n.suffix;
