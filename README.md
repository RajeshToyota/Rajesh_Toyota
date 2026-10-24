# Rajesh Toyota CRM

Multi-outlet automobile dealership CRM: Expo mobile app (Sales Consultants), Next.js admin
dashboard, and a Supabase (Postgres + Auth + RLS) backend that is the single source of truth for
both. See `supabase/migrations/` for the schema, RLS policies, and seed data (Phase 0).

Supabase project ref: `dvcjynxvqpcydcphdcst` (`us-east-1`). An earlier project in `ap-southeast-1`
(`qmfuooozyjuwqwzehtns`) was migrated away from due to cross-region latency against Vercel's
default `iad1` function region — see migration history for the full schema if that project is
ever revisited.

## Layout

- `supabase/migrations/` — versioned SQL migrations (schema, RLS, seed data)
- `supabase/functions/` — Edge Functions (added in Phase 1: `price-quote`)
- `dashboard/` — Next.js admin dashboard (added in Phase 2)
- `docs/ROADMAP.md` — full enquiry-to-delivery plan (Phases 6–15)
- `scripts/seed/` — generators for master data (price lists, accessories, EW, TKM codes) and for
  importing open CTDMS orders; `scripts/localdb/` — apply all migrations to a local Postgres
- `supabase/tests/` — SQL checks run against a scratch database
- `mobile/` — Expo mobile app (added in Phase 3+)

## Core design principle

Selections (what the customer chose) are permanent. Price is never authoritative from storage —
it is recomputed server-side from live master data at each of three checkpoints: quote creation,
proceed-to-booking, and (a later phase, not yet built) finalize-for-delivery. See the pricing
engine in `supabase/migrations/` (Phase 1) for the shared `calculate_price` implementation.

## Master data and CTDMS imports (Phase 6a)

- `supabase/migrations/20261024000002_master_data_seed.sql` is **generated** by
  `scripts/seed/build_master_seed.py` from the TKM price-list PDFs, the TGA accessory order forms and
  the T-Secure EW list. When TKM revises a list, update the file/config in the script, regenerate,
  and add the output as a new migration. The script reconciles every row against the list's own
  "On Road" figure and prints anything that doesn't add up.
- Open CTDMS orders (PO Order Listing, status Booked/Accepted) and the Sales Officers / Team Leaders
  they name are loaded with `scripts/seed/build_ctdms_orders_seed.py`. Its output contains customer
  and staff names, so it goes to `data/private/` (git-ignored) and is applied straight to the
  database — never committed.
- Local check: `PGHOST=/tmp PGPORT=54329 PGUSER=postgres scripts/localdb/apply.sh` then
  `psql -d rt_crm_test -f supabase/tests/price_list_pricing.sql` (and `supabase/tests/enquiries.sql`).
- The live project was migrated with `apply_migration`, which stamps its own version numbers, so
  live version numbers differ from these filenames. `20260918000002`–`000004` are live as
  `20260918101317`, `20260918101353` and `20260918101905`.
