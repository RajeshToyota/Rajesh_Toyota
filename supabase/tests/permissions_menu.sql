-- Module rights (Phase 17b):
--   - Admin has every right; roles get what role_module_rights gives them
--   - a personal revoke beats the role, a personal grant adds to it
--   - a hidden module (is_active false) is off for everyone but Admin
--   - only the Admin / Business Head change access, nobody changes their own, and every change is logged
--   - modules added later are granted to the Business Head automatically
-- Phase 0 seed hierarchy, rolled back:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/permissions_menu.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000001'), ('a0000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000005');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000001', '00000000-0000-0000-0003-000000000002',
             '00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005');

create or replace function pg_temp.as_user(n text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000' || n, true);
$$;
create or replace function pg_temp.expect_error(sql text, msg text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if sqlerrm not like msg || '%' then raise exception 'expected "%" but got "%"', msg, sqlerrm; end if;
    return;
  end;
  raise exception 'expected error "%" from: %', msg, sql;
end $$;

set local role authenticated;

-- ---- Admin: everything, including modules no role has
select pg_temp.as_user('1');
do $$ begin
  if not has_right('access_studio', 'delete') then raise exception 'admin should have every right'; end if;
  if (select count(*) from my_rights()) <> (select count(*) * 5 from app_modules where is_active) then
    raise exception 'admin my_rights should list every module and right';
  end if;
end $$;

-- ---- Sales Consultant: role rights only
select pg_temp.as_user('5');
do $$ begin
  if not has_right('enquiries', 'create') then raise exception 'SC should create enquiries'; end if;
  if has_right('stock_billing') then raise exception 'SC should not see billing'; end if;
  if has_right('access_studio') then raise exception 'SC should not see the access studio'; end if;
  if exists (select 1 from my_rights() where module_key = 'stock_billing') then raise exception 'my_rights leaked billing'; end if;
  if not exists (select 1 from my_rights() where module_key = 'enquiries' and "right" = 'view') then raise exception 'my_rights missing enquiries'; end if;
end $$;
select pg_temp.expect_error($$select set_role_right('00000000-0000-0000-0001-000000000006', 'stock_billing', 'view', true)$$,
  'Only the Admin or Business Head');

-- ---- Outlet Head cannot change access either
select pg_temp.as_user('3');
select pg_temp.expect_error($$select set_employee_override('00000000-0000-0000-0003-000000000005', 'stock_billing', 'view', 'grant')$$,
  'Only the Admin or Business Head');

-- ---- Business Head: personal grant and revoke for SC1, not for self, not for top roles
select pg_temp.as_user('2');
select set_employee_override('00000000-0000-0000-0003-000000000005', 'stock_billing', 'view', 'grant', 'Covering for Accounts');
select set_employee_override('00000000-0000-0000-0003-000000000005', 'enquiries', 'create', 'revoke', 'Training');
select pg_temp.expect_error($$select set_employee_override('00000000-0000-0000-0003-000000000002', 'hr', 'view', 'revoke')$$,
  'You cannot change your own access');
select pg_temp.expect_error($$select set_role_right('00000000-0000-0000-0001-000000000002', 'hr', 'view', false)$$,
  'Only the Admin can change the Admin and Business Head roles');
do $$ begin
  if (select count(*) from access_audit_log) <> 2 then raise exception 'each change should be logged'; end if;
  if (select source from employee_effective_rights('00000000-0000-0000-0003-000000000005')
      where module_key = 'enquiries' and "right" = 'create') <> 'revoke' then
    raise exception 'effective rights should explain the revoke';
  end if;
end $$;

select pg_temp.as_user('5');
do $$ begin
  if not has_right('stock_billing') then raise exception 'grant should add billing'; end if;
  if has_right('enquiries', 'create') then raise exception 'revoke should beat the role'; end if;
  if not has_right('enquiries', 'view') then raise exception 'revoke is per right'; end if;
end $$;
-- Not someone else's overrides
do $$ begin
  if exists (select 1 from employee_module_overrides where employee_id <> current_employee_id()) then
    raise exception 'SC should only read their own overrides';
  end if;
end $$;
select pg_temp.expect_error($$select * from employee_effective_rights('00000000-0000-0000-0003-000000000006')$$,
  'Only the Admin or Business Head');

-- ---- Hiding a module turns it off for everyone but Admin
select pg_temp.as_user('2');
select set_module('enquiries', false);
select pg_temp.as_user('5');
do $$ begin
  if has_right('enquiries', 'view') then raise exception 'hidden module should be off'; end if;
end $$;
select pg_temp.as_user('1');
do $$ begin
  if not has_right('enquiries', 'view') then raise exception 'admin still sees hidden modules'; end if;
end $$;
select pg_temp.as_user('2');
select set_module('enquiries', true);

-- ---- A module added later is the Business Head's automatically; seed_role_rights adds the rest
reset role;
insert into app_modules (key, group_key, label, path) values ('test_later', 'admin', 'Later', '/later');
select seed_role_rights('Sales Consultant', 'test_later', array['view']);
set local role authenticated;
select pg_temp.as_user('2');
do $$ begin
  if not has_right('test_later', 'approve') then raise exception 'business head should get new modules'; end if;
end $$;
select pg_temp.as_user('5');
do $$ begin
  if not has_right('test_later') or has_right('test_later', 'edit') then raise exception 'seed_role_rights wrong'; end if;
end $$;

-- ---- Direct writes are closed
select pg_temp.expect_error($$insert into role_module_rights select id, 'hr', 'view' from roles limit 1$$, 'new row violates row-level security');

select 'permissions_menu: all checks passed';
rollback;
