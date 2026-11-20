-- Lost to Competition: each sales officer's total enquiries (saved enquiry dumps, plus the CRM's own
-- when asked), for the sales officer table beside bought-from-us and lost.
create or replace function lost_sales_data(p_include_crm boolean default false)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare v jsonb;
begin
  if not has_right('rpt_lost_sales', 'view') then raise exception 'You may not open Lost to Competition.'; end if;
  with enq as (
    select mobile, name, model, grade, officer, enquiry_date, f.file_name as source
    from lost_sales_enquiries e join lost_sales_files f on f.id = e.file_id
    union all
    select c.mobile, c.name, m.name, null, emp.name, (en.created_at at time zone 'Asia/Kolkata')::date, 'CRM'
    from enquiries en
    join customers c on c.id = en.customer_id
    left join models m on m.id = en.model_id
    left join employees emp on emp.id = en.assigned_employee_id
    where p_include_crm
  ),
  cand as (
    select r.*, (select count(*) from lost_sales_rto r2 where r2.mobile = r.mobile) as mobile_regs
    from lost_sales_rto r
    where r.mobile in (select mobile from enq)
  )
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
                 'rows', count(*),
                 'no_mobile', count(*) filter (where mobile is null or mobile = ''),
                 'not_car', count(*) filter (where not is_car and coalesce(mobile, '') <> ''))
               from lost_sales_rto),
    'enquiry_mobiles', (select count(distinct mobile) from enq),
    'officer_enquiries', coalesce((select jsonb_agg(jsonb_build_array(officer, n) order by n desc)
                                   from (select coalesce(nullif(btrim(officer), ''), '—') officer, count(*) n from enq group by 1) o), '[]'),
    'toyota_dealers', coalesce((select jsonb_agg(jsonb_build_array(dealer, n) order by n desc)
                                from (select dealer, count(*) n from lost_sales_rto where is_toyota group by dealer) d), '[]'),
    'candidates', coalesce((select jsonb_agg(to_jsonb(c) - 'id' - 'file_id') from cand c), '[]'),
    'enquiries', coalesce((select jsonb_agg(to_jsonb(e)) from enq e where e.mobile in (select mobile from cand)), '[]')
  ) into v;
  return v;
end;
$$;
