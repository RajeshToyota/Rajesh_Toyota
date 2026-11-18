-- Access Studio depth (Phase 23):
--   - an extra role adds its rights; 'all' matches every right; a revoke still beats the role
--   - edit needs view; create stands alone; ticking edit adds view
--   - set_employee_roles: first role is primary, at least one role, top roles only by the Admin
--   - can_see_employee_record: own_only and limited department scope
--   - reassign_manager: reason required, loops refused, every change logged; snapshots freeze a month
--   - financier scope
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/access_studio_depth.sql
begin;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000001'), ('a0000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000004'),
  ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000006');
update employees set auth_user_id = ('a0000000-0000-0000-0000-00000000000' || right(id::text, 1))::uuid
where id in ('00000000-0000-0000-0003-000000000001', '00000000-0000-0000-0003-000000000002',
             '00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000004',
             '00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000006');
update employees set department = 'sales' where id in ('00000000-0000-0000-0003-000000000005', '00000000-0000-0000-0003-000000000006');

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

-- ---- Extra role: SC1 also works as Accounts at Jaipur
select pg_temp.as_user('5');
do $$ begin
  if has_right('stock_billing', 'edit') then raise exception 'SC has no billing yet'; end if;
end $$;

select pg_temp.as_user('2');
select pg_temp.expect_error($$select set_employee_roles('00000000-0000-0000-0003-000000000005', '[]'::jsonb)$$,
  'An employee must keep at least one role');
select pg_temp.expect_error($$select set_employee_roles('00000000-0000-0000-0003-000000000005',
  '[{"role_id":"00000000-0000-0000-0001-000000000002"}]'::jsonb)$$, 'Only the Admin can give');
select set_employee_roles('00000000-0000-0000-0003-000000000005', jsonb_build_array(
  jsonb_build_object('role_id', '00000000-0000-0000-0001-000000000006'),
  jsonb_build_object('role_id', '00000000-0000-0000-0001-000000000007', 'outlet_id', '00000000-0000-0000-0002-000000000001')));

select pg_temp.as_user('5');
do $$ begin
  if not has_right('stock_billing', 'edit') then raise exception 'extra Accounts role should give billing edit'; end if;
  if not has_right('enquiries', 'create') then raise exception 'primary role still counts'; end if;
  if not exists (select 1 from my_rights() where module_key = 'payments' and "right" = 'edit') then
    raise exception 'my_rights should include extra role rights';
  end if;
end $$;

-- ---- 'all' wildcard, revoke beats it, view rule
select pg_temp.as_user('2');
select set_role_right('00000000-0000-0000-0001-000000000006', 'rpt_margin', 'all', true);
select pg_temp.as_user('5');
do $$ begin
  if not has_right('rpt_margin', 'approve') or not has_right('rpt_margin', 'delete') then raise exception 'all should match every right'; end if;
end $$;
select pg_temp.as_user('2');
select set_employee_override('00000000-0000-0000-0003-000000000005', 'rpt_margin', 'view', 'revoke', 'test');
select pg_temp.as_user('5');
do $$ begin
  if has_right('rpt_margin', 'view') then raise exception 'revoke beats the all right'; end if;
  if has_right('rpt_margin', 'edit') then raise exception 'edit needs view'; end if;
  if not has_right('rpt_margin', 'approve') then raise exception 'approve does not need view'; end if;
end $$;

select pg_temp.as_user('2');
select set_role_right('00000000-0000-0000-0001-000000000005', 'stock_billing', 'edit', true);
do $$ begin
  if not exists (select 1 from role_module_rights where role_id = '00000000-0000-0000-0001-000000000005'
                 and module_key = 'stock_billing' and "right" = 'view') then
    raise exception 'ticking edit should add view';
  end if;
end $$;
select set_role_right('00000000-0000-0000-0001-000000000005', 'stock_billing', 'view', false);
do $$ begin
  if exists (select 1 from role_module_rights where role_id = '00000000-0000-0000-0001-000000000005'
             and module_key = 'stock_billing') then
    raise exception 'taking view away should take edit too';
  end if;
  if (select source from employee_effective_rights('00000000-0000-0000-0003-000000000005')
      where module_key = 'rpt_margin' and "right" = 'view') <> 'revoke' then raise exception 'effective source'; end if;
  if not (select role_has from employee_effective_rights('00000000-0000-0000-0003-000000000005')
          where module_key = 'payments' and "right" = 'edit') then raise exception 'role baseline should include extra role'; end if;
end $$;

-- ---- Visibility settings
select pg_temp.as_user('4');  -- Team Leader: sees the team
do $$ begin
  if not can_see_employee_record('rpt_bookings', '00000000-0000-0000-0003-000000000005') then raise exception 'TL sees team'; end if;
  if can_see_employee_record('rpt_bookings', '00000000-0000-0000-0003-000000000008') then raise exception 'TL does not see Jodhpur'; end if;
end $$;
select pg_temp.as_user('2');
select set_module_visibility('rpt_bookings', true, 'all', null);
select pg_temp.expect_error($$select set_module_visibility('rpt_bookings', false, 'limited', '{}')$$, 'A limited scope needs');
select pg_temp.as_user('4');
do $$ begin
  if can_see_employee_record('rpt_bookings', '00000000-0000-0000-0003-000000000005') then raise exception 'own_only hides the team'; end if;
  if not can_see_employee_record('rpt_bookings', '00000000-0000-0000-0003-000000000004') then raise exception 'own_only shows self'; end if;
end $$;
select pg_temp.as_user('2');
select set_module_visibility('rpt_bookings', false, 'limited', array['accounts']);
select pg_temp.as_user('3');
do $$ begin
  if can_see_employee_record('rpt_bookings', '00000000-0000-0000-0003-000000000005') then raise exception 'limited scope excludes sales'; end if;
end $$;
select pg_temp.as_user('2');
select set_module_visibility('rpt_bookings', false, 'all', null);
select pg_temp.as_user('5');  -- SC1 with a Jaipur Accounts assignment sees SC2 on an accounts module
do $$ begin
  if not can_see_employee_record('payments', '00000000-0000-0000-0003-000000000006') then raise exception 'outlet assignment reach'; end if;
  if can_see_employee_record('payments', '00000000-0000-0000-0003-000000000008') then raise exception 'not another outlet'; end if;
end $$;

-- ---- Reporting hierarchy
select pg_temp.as_user('5');
select pg_temp.expect_error($$select reassign_manager('00000000-0000-0000-0003-000000000006', '00000000-0000-0000-0003-000000000003', 'x')$$,
  'You need Reporting Hierarchy: edit');
select pg_temp.as_user('2');
select pg_temp.expect_error($$select reassign_manager('00000000-0000-0000-0003-000000000006', '00000000-0000-0000-0003-000000000003', ' ')$$,
  'Give a reason');
select pg_temp.expect_error($$select reassign_manager('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0003-000000000005', 'loop')$$,
  'That would make a loop');
select reassign_manager('00000000-0000-0000-0003-000000000006', '00000000-0000-0000-0003-000000000003', 'Team re-organised');
do $$ begin
  if (select reports_to_employee_id from employees where id = '00000000-0000-0000-0003-000000000006') <> '00000000-0000-0000-0003-000000000003' then
    raise exception 'manager not changed';
  end if;
  if (select reason from reporting_hierarchy_history where employee_id = '00000000-0000-0000-0003-000000000006' and effective_to is null)
     <> 'Team re-organised' then raise exception 'history should carry the reason'; end if;
  if (select previous_manager_id from reporting_hierarchy_history where employee_id = '00000000-0000-0000-0003-000000000006' and effective_to is null)
     <> '00000000-0000-0000-0003-000000000004' then raise exception 'history should keep the previous manager'; end if;
  if (select count(*) from reporting_hierarchy_history where employee_id = '00000000-0000-0000-0003-000000000006' and effective_to is null) <> 1 then
    raise exception 'one open history row per employee';
  end if;
  if save_hierarchy_snapshot(current_date) < 8 then raise exception 'snapshot should cover active staff'; end if;
  if (select manager_id from reporting_hierarchy_snapshots
      where month = date_trunc('month', current_date)::date and employee_id = '00000000-0000-0000-0003-000000000006')
     <> '00000000-0000-0000-0003-000000000003' then raise exception 'snapshot manager'; end if;
end $$;

-- ---- Financier scope
reset role;
insert into financiers (id, name) values ('f0000000-0000-0000-0000-000000000001', 'Test Bank A'), ('f0000000-0000-0000-0000-000000000002', 'Test Bank B');
set local role authenticated;
select pg_temp.as_user('2');
do $$ begin
  if not employee_can_work_financier('00000000-0000-0000-0003-000000000006', 'f0000000-0000-0000-0000-000000000002') then
    raise exception 'no scope means every financier';
  end if;
end $$;
select set_employee_financier_scope('00000000-0000-0000-0003-000000000006', array['f0000000-0000-0000-0000-000000000001'::uuid]);
do $$ begin
  if employee_can_work_financier('00000000-0000-0000-0003-000000000006', 'f0000000-0000-0000-0000-000000000002') then
    raise exception 'scope should limit financiers';
  end if;
end $$;

-- ---- Access manager by right: give the Outlet Head access_studio edit
select pg_temp.as_user('3');
select pg_temp.expect_error($$select set_module('rpt_margin', true)$$, 'Only the Admin or Business Head');
select pg_temp.as_user('2');
select set_employee_override('00000000-0000-0000-0003-000000000003', 'access_studio', 'view', 'grant', 'delegate');
select set_employee_override('00000000-0000-0000-0003-000000000003', 'access_studio', 'edit', 'grant', 'delegate');
select pg_temp.as_user('3');
select set_module('rpt_margin', true);

select 'access_studio_depth: all checks passed';
rollback;
