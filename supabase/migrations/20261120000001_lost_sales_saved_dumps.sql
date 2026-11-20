-- Lost to Competition: keep the uploaded RTO and enquiry dumps, so each month is uploaded once and
-- everyone with the report sees the same data. The browser still reads the Excel file; it sends the
-- parsed rows here. Reading the report returns only what it needs: the RTO registrations whose mobile
-- number is in an enquiry, and totals — not the whole dump.

create table lost_sales_files (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('rto', 'enquiry')),
  file_name text not null,
  row_count int not null default 0,
  skipped_rows int not null default 0,
  uploaded_by uuid references employees(id),
  uploaded_at timestamptz not null default now(),
  unique (kind, file_name)
);

create table lost_sales_rto (
  id bigint generated always as identity primary key,
  file_id uuid not null references lost_sales_files(id) on delete cascade,
  office text,
  reg_no text,
  reg_date date,
  vehicle_class text,
  owner text,
  mobile text,
  address text,
  financer text,
  maker text,
  brand text,
  model text,
  purchase_date date,
  amount numeric,
  dealer text,
  is_car boolean not null default true,
  is_toyota boolean not null default false
);
create index lost_sales_rto_mobile on lost_sales_rto (mobile);
create index lost_sales_rto_file on lost_sales_rto (file_id);
-- A registration that is in two monthly files is kept once.
create unique index lost_sales_rto_reg_no on lost_sales_rto (reg_no) where reg_no <> '';

create table lost_sales_enquiries (
  id bigint generated always as identity primary key,
  file_id uuid not null references lost_sales_files(id) on delete cascade,
  name text,
  mobile text not null,
  model text,
  grade text,
  officer text,
  enquiry_date date
);
create index lost_sales_enquiries_mobile on lost_sales_enquiries (mobile);
create index lost_sales_enquiries_file on lost_sales_enquiries (file_id);

alter table lost_sales_files enable row level security;
alter table lost_sales_rto enable row level security;
alter table lost_sales_enquiries enable row level security;
create policy lost_sales_files_select on lost_sales_files for select to authenticated using ((select has_right('rpt_lost_sales', 'view')));
create policy lost_sales_rto_select on lost_sales_rto for select to authenticated using ((select has_right('rpt_lost_sales', 'view')));
create policy lost_sales_enquiries_select on lost_sales_enquiries for select to authenticated using ((select has_right('rpt_lost_sales', 'view')));

-- Start a file: a file of the same kind and name replaces the earlier upload.
create or replace function lost_sales_begin_file(p_kind text, p_file_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if not has_right('rpt_lost_sales', 'create') then raise exception 'You may not upload to Lost to Competition.'; end if;
  delete from lost_sales_files where kind = p_kind and file_name = p_file_name;
  insert into lost_sales_files (kind, file_name, uploaded_by)
  values (p_kind, p_file_name, (select id from employees where auth_user_id = auth.uid() limit 1))
  returning id into v_id;
  return v_id;
end;
$$;

-- Add a batch of rows to a file; returns how many were new (repeated registrations are skipped).
create or replace function lost_sales_add_rows(p_file_id uuid, p_rows jsonb, p_skipped int default 0)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_kind text; v_n int;
begin
  if not has_right('rpt_lost_sales', 'create') then raise exception 'You may not upload to Lost to Competition.'; end if;
  select kind into v_kind from lost_sales_files where id = p_file_id;
  if v_kind is null then raise exception 'Upload not found; start again.'; end if;
  if v_kind = 'rto' then
    insert into lost_sales_rto (file_id, office, reg_no, reg_date, vehicle_class, owner, mobile, address, financer, maker, brand,
                                model, purchase_date, amount, dealer, is_car, is_toyota)
    select p_file_id, r.office, coalesce(r.reg_no, ''), r.reg_date, r.vehicle_class, r.owner, r.mobile, r.address, r.financer,
           r.maker, r.brand, r.model, r.purchase_date, r.amount, r.dealer, coalesce(r.is_car, true), coalesce(r.is_toyota, false)
    from jsonb_to_recordset(p_rows) as r(office text, reg_no text, reg_date date, vehicle_class text, owner text, mobile text,
         address text, financer text, maker text, brand text, model text, purchase_date date, amount numeric, dealer text,
         is_car boolean, is_toyota boolean)
    on conflict (reg_no) where reg_no <> '' do nothing;
  else
    insert into lost_sales_enquiries (file_id, name, mobile, model, grade, officer, enquiry_date)
    select p_file_id, r.name, r.mobile, r.model, r.grade, r.officer, r.enquiry_date
    from jsonb_to_recordset(p_rows) as r(name text, mobile text, model text, grade text, officer text, enquiry_date date)
    where r.mobile ~ '^[6-9][0-9]{9}$';
  end if;
  get diagnostics v_n = row_count;
  update lost_sales_files set row_count = row_count + v_n, skipped_rows = skipped_rows + coalesce(p_skipped, 0) where id = p_file_id;
  return v_n;
end;
$$;

create or replace function lost_sales_delete_file(p_file_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not has_right('rpt_lost_sales', 'delete') then raise exception 'You may not remove Lost to Competition files.'; end if;
  delete from lost_sales_files where id = p_file_id;
end;
$$;

-- What the report needs: totals of the saved RTO dump, Toyota sales by dealer, and the RTO rows whose
-- mobile is in an enquiry (saved enquiry dumps, plus the CRM's own enquiries the reader can see when
-- p_include_crm), each with how many registrations carry that mobile, and those enquiries.
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
    'toyota_dealers', coalesce((select jsonb_agg(jsonb_build_array(dealer, n) order by n desc)
                                from (select dealer, count(*) n from lost_sales_rto where is_toyota group by dealer) d), '[]'),
    'candidates', coalesce((select jsonb_agg(to_jsonb(c) - 'id' - 'file_id') from cand c), '[]'),
    'enquiries', coalesce((select jsonb_agg(to_jsonb(e)) from enq e where e.mobile in (select mobile from cand)), '[]')
  ) into v;
  return v;
end;
$$;

revoke execute on function lost_sales_begin_file(text, text) from public, anon;
revoke execute on function lost_sales_add_rows(uuid, jsonb, int) from public, anon;
revoke execute on function lost_sales_delete_file(uuid) from public, anon;
revoke execute on function lost_sales_data(boolean) from public, anon;
grant execute on function lost_sales_begin_file(text, text) to authenticated;
grant execute on function lost_sales_add_rows(uuid, jsonb, int) to authenticated;
grant execute on function lost_sales_delete_file(uuid) to authenticated;
grant execute on function lost_sales_data(boolean) to authenticated;

-- Uploading and removing files: the heads; Team Leaders read.
select seed_role_rights(r, m, x) from (values
  ('Outlet Head', 'rpt_lost_sales', array['create', 'delete']),
  ('Head Customer Relations', 'rpt_lost_sales', array['create', 'delete'])
) v(r, m, x);
