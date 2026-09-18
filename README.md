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
- `mobile/` — Expo mobile app (added in Phase 3+)

## Core design principle

Selections (what the customer chose) are permanent. Price is never authoritative from storage —
it is recomputed server-side from live master data at each of three checkpoints: quote creation,
proceed-to-booking, and (a later phase, not yet built) finalize-for-delivery. See the pricing
engine in `supabase/migrations/` (Phase 1) for the shared `calculate_price` implementation.
