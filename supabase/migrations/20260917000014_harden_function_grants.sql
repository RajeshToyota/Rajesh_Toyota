-- Harden functions flagged by the Supabase security advisor: pin search_path, and remove
-- anonymous/PUBLIC execute access from the RLS helper functions. They remain callable by
-- `authenticated` intentionally — RLS policies evaluate under the querying role, so the
-- policies calling these functions would break without it. That residual "authenticated can
-- execute this SECURITY DEFINER function" advisor warning is expected and accepted: the
-- functions only ever return booleans/uuids derived from the caller's own employee row and
-- the manager-hierarchy chain, never raw table contents.

alter function set_updated_at() set search_path = public;

revoke execute on function can_access_employee_data(uuid, uuid) from public;
revoke execute on function current_employee_id() from public;
revoke execute on function current_employee_role_rank() from public;
revoke execute on function is_master_data_admin() from public;

grant execute on function can_access_employee_data(uuid, uuid) to authenticated;
grant execute on function current_employee_id() to authenticated;
grant execute on function current_employee_role_rank() to authenticated;
grant execute on function is_master_data_admin() to authenticated;
