#!/usr/bin/env bash
# Recreate a scratch database and apply every migration in order. Usage:
#   PGHOST=/tmp PGPORT=54329 PGUSER=postgres scripts/localdb/apply.sh [dbname]
set -euo pipefail
cd "$(dirname "$0")/../.."
db="${1:-rt_crm_test}"
dropdb --if-exists "$db"
createdb "$db"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f scripts/localdb/supabase_stubs.sql
for f in supabase/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$f" >/dev/null || { echo "FAILED: $f"; exit 1; }
done
echo "Applied $(ls supabase/migrations/*.sql | wc -l) migrations to $db"
