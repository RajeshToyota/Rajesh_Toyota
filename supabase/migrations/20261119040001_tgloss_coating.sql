-- TGLOSS and ceramic coating are the same product. The "Ceramic Coating" master becomes the TGLOSS
-- master and is filled from the TGLOSS prices we already hold:
--   * the coating options per model (packages, ceramic, graphene, gloss body coating) move from the
--     TGLOSS VAS products into this master (one pick per quote), and those VAS rows are switched off so
--     the same coating cannot be added twice. TGLOSS add-ons (underbody, silencer, internal panel,
--     rat repellent, windshield polish, exterior beautification) stay as VAS tick-boxes.
--   * a model with no TGLOSS VAS rows but a TGLOSS package amount on its price list gets that package.
-- The table keeps its name (ceramic_coating_prices) so saved quotes and bookings keep working.

alter table ceramic_coating_prices alter column name set default 'TGLOSS';

insert into ceramic_coating_prices (id, model_id, name, price, is_active)
select md5('tgloss|' || vp.id)::uuid, vp.model_id, vp.name, vp.price, true
from vas_products vp
where vp.category = 'TGLOSS' and vp.model_id is not null and vp.is_active
  and vp.name ~* '(ceramic|graphene|gloss body)'
on conflict (model_id, name) do update set price = excluded.price, is_active = true;

update vas_products set is_active = false
where category = 'TGLOSS' and model_id is not null and name ~* '(ceramic|graphene|gloss body)';

insert into ceramic_coating_prices (id, model_id, name, price, is_active)
select distinct on (v.model_id) md5('tgloss-pl|' || v.model_id)::uuid, v.model_id,
  'TGLOSS Ceramic Coating with 2 Boosters + Underbody, Silencer, Internal Panel Coating & Rat Repellent (Package)',
  p.tgloss_package_amount, true
from price_list p
join variants v on v.id = p.variant_id
where p.tgloss_package_amount is not null
  and not exists (select 1 from ceramic_coating_prices c where c.model_id = v.model_id)
order by v.model_id, p.effective_from desc
on conflict (model_id, name) do nothing;

-- Quote line item reads "TGLOSS: <option>" instead of "Ceramic Coating".
do $$
declare
  d text := pg_get_functiondef('calculate_price(jsonb)'::regprocedure);
  n text;
begin
  n := replace(d, $q$'label','Ceramic Coating'$q$,
    $q$'label',(select case when name ilike 'tgloss%' then name else 'TGLOSS: ' || name end from ceramic_coating_prices where id = v_ceramic_id)$q$);
  n := replace(n, 'That ceramic coating is not offered on this model', 'That TGLOSS option is not offered on this model');
  if n = d then raise exception 'calculate_price: ceramic coating label not found'; end if;
  execute n;
end;
$$;
