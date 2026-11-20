# Rajesh Toyota CRM

Multi-outlet automobile dealership CRM: Expo mobile app (Sales Consultants), Next.js admin
dashboard, and a Supabase (Postgres + Auth + RLS) backend that is the single source of truth for
both. See `supabase/migrations/` for the schema, RLS policies, and seed data (Phase 0).

Supabase project ref: `zayuhrajnaenwuiutcpq` (`ap-south-1`, Mumbai), since 2026-11-18. The web app is a
static Vite build whose browsers query Supabase directly, so the database sits next to the staff in
India. The previous project, `dvcjynxvqpcydcphdcst` (`us-east-1`), was kept unchanged as a fallback;
it dated from the Next.js dashboard, whose server code ran in Vercel's `iad1`. An earlier
`ap-southeast-1` project (`qmfuooozyjuwqwzehtns`) predates both.

## Layout

- `supabase/migrations/` — versioned SQL migrations (schema, RLS, seed data)
- `supabase/functions/` — Edge Functions (added in Phase 1: `price-quote`)
- `web/` — React + Vite staff web app, built the same way as Techwheels (Phase 17a). It replaces
  `dashboard/`; see `docs/TECHWHEELS_PARITY_PLAN.md`
- `dashboard/` — the original Next.js admin dashboard (Phase 2). Kept running until `web/` is signed
  off, then retired
- `docs/ROADMAP.md` — full enquiry-to-delivery plan (Phases 6–16)
- `docs/TECHWHEELS_PARITY_PLAN.md` — Phases 17–22: bring the app to Techwheels parity
- `scripts/seed/` — generators for master data (price lists, accessories, EW, TKM codes) and for
  importing open CTDMS orders; `scripts/localdb/` — apply all migrations to a local Postgres
- `supabase/tests/` — SQL checks run against a scratch database; `scripts/localdb/test.sh` rebuilds it and runs them all
- `mobile/` — Expo mobile app (added in Phase 3+)

## Web app (`web/`)

```
cd web && cp .env.example .env.local   # fill in the anon key
npm install && npm run dev
```

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`: the project URL and publishable key.
- `VITE_SITE_URL` (optional): the public address used in login-invite emails; defaults to the
  address the app is opened at.
- HR login invites and blocking a leaver's login run in the `employee-login` edge function
  (`supabase/functions/employee-login`), which needs no extra setup beyond deploying it: Supabase
  gives edge functions the service-role key.
- Hosting: Vercel, static build (`npm run build` → `dist/`), single-page rewrite in `web/vercel.json`.
- The pages were moved over from `dashboard/` unchanged and run through a small Next.js
  compatibility layer (`web/src/compat/README.md`). New pages are plain React, as in Techwheels.

## Dashboard environment (old Next.js app)

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`: the project URL and publishable key.
- `SUPABASE_SERVICE_ROLE_KEY` (server only; never prefix with `NEXT_PUBLIC_`): lets HR send login
  invites and set-password links, and blocks a leaver's login. Without it those buttons explain
  what's missing; everything else works.
- `NEXT_PUBLIC_SITE_URL` (optional): the dashboard's public address, used in the link inside invite
  emails. Without it, the address of the request is used.
- In Supabase → Authentication → URL Configuration, add `<dashboard address>/auth/set-password` to the
  redirect URLs, or invite links will land on the Site URL instead.

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
  `psql -d rt_crm_test -f supabase/tests/price_list_pricing.sql` (and `enquiries.sql`, `ctdms_sync.sql`, `staged_quotes.sql`, `welcome_dockets.sql`, `stock_allotment.sql`, `finance_cases.sql`, `payments_delivery.sql`, `hold_cancel.sql`, `employee_management.sql`, `pipeline_reports.sql`, `stock_allotment_pool.sql`, `access_studio_depth.sql`, `catalog_pricing_masters.sql`, `quotes_workbench.sql`, `booking_docs_refunds.sql`, `stock_yard_form22.sql`, `pool_extras.sql`, `finance_claims.sql`, `ops_billing_screens.sql`, `pdi_delivery_flow.sql`, `payroll.sql`, `used_cars_reception.sql`, `lost_sales.sql`). `scripts/localdb/test.sh` runs every file.
- The live project was migrated with `apply_migration`, which stamps its own version numbers, so
  live version numbers differ from these filenames. `20260918000002`–`000004` are live as
  `20260918101317`, `20260918101353` and `20260918101905`.
- Phase 6a/6 on live (25 Oct 2026):
  - `20261024000001` → `20261024180708` branches_codes_pricelist
  - `20261024000002` was too large for one call, so it went live in sections, each self-contained:
    - `20261024181155` master_data_seed_1_catalog
    - variant colours: run by hand in the SQL editor, because its `delete` needs confirmation
    - `20261025180959` / `20261025181929` master_data_seed_3a/3b_prices
    - `20261025182327` master_data_seed_4_accessories
    - `20261025182457` master_data_seed_5_tgloss
    - `20261025182610` master_data_seed_6_ew
  - `20261024000003` → `20261025182740` pricing_engine_price_list
  - `20261025000001` → `20261025183418` customers_enquiries
  - `20261025000002` → `20261025190553` enquiries_hardening
  - `20261026000001` → `20261025192303` ctdms_sync (Phase 7)
  - `20261027000001` → `20261026041848` staged_quotes (Phase 8)
  - `20261028000001` → `20261026043750` welcome_dockets (Phase 9)
  - `20261029000001` → `20261026052321` stock_allotment (Phase 10)
  - `20261030000001` → `20261026053217` finance_cases (Phase 11)
  - `20261031000001` → `20261026074654` payments_delivery (Phase 12)
  - `20261101000001` → `20261026075429` hold_cancel (Phase 13)
  - `20261102000001` → `20261026081013` employee_management (Phase 14)
  - `20261103000001` → `20261026091801` pipeline_reports (Phase 15)
  - `20261113000001` → `20261112135745` stock_allotment_pool (Phase 16; applied with comments stripped, pool switched off)
  - `20261118000001` → `20261118070111` permissions_menu (Phase 17b)
  - `20261118000002` → `20261118070716` ops_billing_pdi_delivery (Phase 18; comments stripped; gate-pass rule off)
  - `20261118000003` → `20261118071007` rm_leads_reception_test_drive (Phase 19; comments stripped)
  - `20261118000004` → `20261118071211` targets_incentives (Phase 20; comments stripped)
  - `20261118000005` → `20261118071354` stock_extras (Phase 21; comments stripped; price-difference rule off)
  - `20261118000006` → `20261118071925` exchange_used_cars (Phase 22; comments stripped)
  - `20261118000007` → `20261118072135` search_path_hardening
  - `20261118000008` → `20261118075219` employee_salary (salary type, monthly salary, ESI, PF)
  - The CTDMS staff (36) and open orders (265) were loaded with `execute_sql` and are not recorded as
    migrations.
- Mumbai (`zayuhrajnaenwuiutcpq`), 19 Nov 2026 — Phases 23–33, applied in order through the Management API
  migrations endpoint (comments stripped) after a rolled-back dry run of all eleven on live data:
  - `20261118000009` → `20261118114503` rto_formula_single_price_row; `20261119000001` → `20261119061142` glanza_cng_variant_names
  - `20261119010001` → `20261119061424` access_studio_depth (Phase 23)
  - `20261119010002` → `20261119061429` catalog_pricing_masters (Phase 24; BH / Scrap / Transfer RTO on the single-row price list)
  - `20261119010003` → `20261119061432` quotes_workbench (Phase 25)
  - `20261119010004` → `20261119061436` booking_docs_refunds (Phase 26)
  - `20261119010005` → `20261119061440` stock_yard_form22 (Phase 27)
  - `20261119010006` → `20261119061444` pool_extras (Phase 28)
  - `20261119010007` → `20261119061449` finance_claims (Phase 29)
  - `20261119010008` → `20261119061453` ops_billing_screens (Phase 30)
  - `20261119010009` → `20261119061456` pdi_delivery_flow (Phase 31)
  - `20261119010010` → `20261119061500` payroll (Phase 32)
  - `20261119010011` → `20261119061504` used_cars_reception (Phase 33)
  - `20261119020001` → `20261119063109` masters_menu_dedupe (Phase 24 pages off the flat menu)
  - `20261119020002` → `20261119063537` menu_merges (one menu entry per job)
  - `20261119050001` → `20261119091522` moved_screens_paths; `20261119060001` → `20261119113403` tab_paths (each tab its own address)
  - `20261119070001` → `20261119121117` scheme_revision_edit (edit / delete a revision on the Schemes tab)
  - `20261119080001` → `20261119180726` lost_to_competition (Reporting → Lost to Competition: RTO dump matched to enquiries)
  - `20261120000001` → `20261120103858` lost_sales_saved_dumps (uploaded RTO / enquiry dumps are saved; comments stripped)
  - `20261120020001` → `20261120110120` lost_sales_officer_enquiries (total enquiries per sales officer)
  - The us-east-1 fallback (`dvcjynxvqpcydcphdcst`) does not have these.
