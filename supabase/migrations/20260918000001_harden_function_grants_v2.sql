-- Supabase's default privileges on some projects grant EXECUTE on new public-schema functions
-- directly to anon (not only via the PUBLIC pseudo-role), so 20260917000014's
-- "revoke ... from public" didn't reliably close this off on every project — confirmed still
-- open on a freshly created project even though the original project was fine. Revoke from anon
-- explicitly as a second, more direct pass.

revoke execute on function can_access_employee_data(uuid, uuid) from anon;
revoke execute on function current_employee_id() from anon;
revoke execute on function current_employee_role_rank() from anon;
revoke execute on function is_master_data_admin() from anon;
