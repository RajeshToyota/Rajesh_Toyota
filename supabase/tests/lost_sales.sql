-- Lost to Competition saved dumps:
--   - Outlet Head uploads; Team Leader reads but may not upload or remove; Sales Consultant sees nothing
--   - a registration in two RTO files is kept once; enquiry rows without a valid mobile are dropped
--   - a file with the same name replaces the earlier upload
--   - lost_sales_data returns only RTO rows whose mobile is in an enquiry, with registrations per mobile
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/lost_sales.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000004'), ('a0000000-0000-0000-0000-000000000005')
on conflict do nothing;
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000004', '00000000-0000-0000-0003-000000000005');

create or replace function pg_temp.as_user(n text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;

set local role authenticated;
select pg_temp.as_user('3');

create temp table t_ids (k text, id uuid);
grant select, insert on t_ids to authenticated;
insert into t_ids select 'apr', lost_sales_begin_file('rto', 'L_0426.xlsx');
select lost_sales_add_rows((select id from t_ids where k = 'apr'), '[
  {"reg_no": "RJ14AA0001", "mobile": "9800000001", "maker": "MARUTI SUZUKI INDIA LTD", "brand": "Maruti Suzuki", "dealer": "NEXA X", "is_car": true, "is_toyota": false, "reg_date": "2026-04-03"},
  {"reg_no": "RJ14AA0002", "mobile": "9800000002", "maker": "TOYOTA KIRLOSKAR MOTOR PVT LTD", "brand": "Toyota", "dealer": "RAJESH MOTORS (CARS PVT LTD.", "is_car": true, "is_toyota": true},
  {"reg_no": "RJ14AA0003", "mobile": "9800000003", "maker": "TOYOTA KIRLOSKAR MOTOR PVT LTD", "brand": "Toyota", "dealer": "SONAK", "is_car": true, "is_toyota": true},
  {"reg_no": "RJ14AA0004", "mobile": "9800000099", "maker": "HYUNDAI", "brand": "Hyundai", "dealer": "H1", "is_car": true, "is_toyota": false},
  {"reg_no": "RJ14AA0005", "mobile": null, "maker": "TAFE LIMITED", "brand": "Tractor", "dealer": "T1", "is_car": false, "is_toyota": false}
]'::jsonb);
-- May: repeats RJ14AA0001, adds a second car on mobile 9800000001.
insert into t_ids select 'may', lost_sales_begin_file('rto', 'L_0526.xlsx');
do $$ begin
  if lost_sales_add_rows((select id from t_ids where k = 'may'), '[
    {"reg_no": "RJ14AA0001", "mobile": "9800000001", "brand": "Maruti Suzuki", "dealer": "NEXA X"},
    {"reg_no": "RJ14AA0006", "mobile": "9800000001", "brand": "Kia", "dealer": "KIA Y"}
  ]'::jsonb) <> 1 then raise exception 'repeated registration should be skipped'; end if;
end $$;

insert into t_ids select 'enq', lost_sales_begin_file('enquiry', 'enq.xlsx');
do $$ begin
  if lost_sales_add_rows((select id from t_ids where k = 'enq'), '[
    {"name": "A", "mobile": "9800000001", "model": "GLANZA", "officer": "SO1"},
    {"name": "B", "mobile": "9800000002", "model": "HYRYDER", "officer": "SO1"},
    {"name": "C", "mobile": "9800000003", "model": "FORTUNER", "officer": "SO2"},
    {"name": "D", "mobile": "12345", "model": "INNOVA", "officer": "SO2"}
  ]'::jsonb, 1) <> 3 then raise exception 'bad mobile should be dropped'; end if;
end $$;

do $$
declare d jsonb := lost_sales_data(false);
begin
  if (d->'totals'->>'rows')::int <> 6 then raise exception 'rows: %', d->'totals'; end if;
  if (d->'totals'->>'no_mobile')::int <> 1 then raise exception 'no_mobile: %', d->'totals'; end if;
  if (d->>'enquiry_mobiles')::int <> 3 then raise exception 'enquiry_mobiles: %', d->>'enquiry_mobiles'; end if;
  if jsonb_array_length(d->'candidates') <> 4 then raise exception 'candidates: %', d->'candidates'; end if;
  if (select (c->>'mobile_regs')::int from jsonb_array_elements(d->'candidates') c where c->>'reg_no' = 'RJ14AA0006') <> 2 then
    raise exception 'mobile_regs wrong';
  end if;
  if jsonb_array_length(d->'toyota_dealers') <> 2 then raise exception 'toyota dealers: %', d->'toyota_dealers'; end if;
  if jsonb_array_length(d->'enquiries') <> 3 then raise exception 'enquiries: %', d->'enquiries'; end if;
end $$;

-- Re-uploading the same file name replaces it.
insert into t_ids select 'may2', lost_sales_begin_file('rto', 'L_0526.xlsx');
do $$ begin
  if (select count(*) from lost_sales_files where kind = 'rto') <> 2 then raise exception 'same name should replace'; end if;
  if (select count(*) from lost_sales_rto) <> 5 then raise exception 'old May rows should be gone'; end if;
end $$;

-- Team Leader reads, cannot upload or remove.
select pg_temp.as_user('4');
do $$ begin
  if (select count(*) from lost_sales_files) <> 3 then raise exception 'team leader should see files'; end if;
  perform lost_sales_data(false);
  begin
    perform lost_sales_begin_file('rto', 'x.xlsx');
    raise exception 'team leader uploaded';
  exception when raise_exception then
    if sqlerrm = 'team leader uploaded' then raise; end if;
  end;
  begin
    perform lost_sales_delete_file((select id from lost_sales_files limit 1));
    raise exception 'team leader removed';
  exception when raise_exception then
    if sqlerrm = 'team leader removed' then raise; end if;
  end;
end $$;

-- Sales Consultant: no access.
select pg_temp.as_user('5');
do $$ begin
  if (select count(*) from lost_sales_rto) <> 0 then raise exception 'consultant sees RTO rows'; end if;
  begin
    perform lost_sales_data(false);
    raise exception 'consultant read report';
  exception when raise_exception then
    if sqlerrm = 'consultant read report' then raise; end if;
  end;
end $$;

-- Outlet Head removes a file; its rows go with it.
select pg_temp.as_user('3');
select lost_sales_delete_file((select id from t_ids where k = 'apr'));
do $$ begin
  if (select count(*) from lost_sales_rto) <> 0 then raise exception 'rows should be removed with the file'; end if;
end $$;

rollback;
