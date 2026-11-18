#!/usr/bin/env bash
# Rebuild the scratch database and run every SQL test in supabase/tests. Usage:
#   PGHOST=/tmp PGPORT=54329 PGUSER=postgres scripts/localdb/test.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
scripts/localdb/apply.sh rt_crm_test
fail=0
for t in supabase/tests/*.sql; do
  if out=$(psql -q -v ON_ERROR_STOP=1 -d rt_crm_test -f "$t" 2>&1); then
    echo "ok    $t"
  else
    echo "FAIL  $t"; echo "$out" | grep -E 'ERROR|CONTEXT' | head -5; fail=1
  fi
done
exit $fail
