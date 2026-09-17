-- Extensions and shared helpers used across all later migrations.

create extension if not exists "pgcrypto";

-- Generic updated_at trigger, attached to every table that has an updated_at column.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
