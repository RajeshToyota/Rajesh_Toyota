# Rajesh Toyota CRM

The CRM for Rajesh Toyota's three branches: Jaipur (JP05A), Dausa (DN01A) and Kotputli (VK01A). It
follows every customer from the first enquiry to the delivered car, and runs alongside Toyota's own
CTDMS.

- **Mobile app (Expo):** for Sales Consultants. Enquiries, staged quotes, bookings, the Welcome
  Docket, finance documents, delivery, and hold or cancel.
- **Dashboard (Next.js on Vercel):** for the back office. CTDMS sync, stock and allotment, billing,
  finance, payments, insurance and RTO, cancellations, HR, reports and master data.
- **Supabase (Postgres + Auth + Storage):** the single source of truth for both apps. Every rule is
  enforced in the database (row-level security and RPC functions), not only in the screens.

Supabase project: `dvcjynxvqpcydcphdcst` (`us-east-1`). An earlier project in `ap-southeast-1`
(`qmfuooozyjuwqwzehtns`) was retired because of latency against Vercel's `iad1` region.

The full plan, with every decision and the detail of each phase, is in
[`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Status (26 Oct 2026)

**All planned phases (0–15) are built and live on Supabase.** The work is on branch
`claude/upbeat-meitner-nb4x9z` ([pull request #1](https://github.com/RajeshToyota/Rajesh_Toyota/pull/1)).
The system is **not yet in daily use**: staff logins and a few settings are still needed (see
[What's left](#whats-left)).

| Phase | What it covers | Status |
|---|---|---|
| 0 | Schema, roles and branch hierarchy, row-level security, seed data | ✅ Live |
| 1 | Pricing engine (`calculate_price`) and the `price-quote` Edge Function | ✅ Live |
| 2 | Dashboard: master-data screens | ✅ Live |
| 3 – 4 | Mobile quote and booking flow | ✅ Live |
| 5 | Reports, discount approvals, mobile polish | ✅ Live |
| 6a | Real branches, TKM suffix / colour codes, full dealer price lists (Private, Commercial, CSD), TGA accessories, TGLOSS, T-Secure EW; 36 CTDMS staff and 265 open CTDMS orders loaded | ✅ Live |
| 6 | Enquiry capture: customers deduplicated by mobile number, enquiries on mobile and dashboard | ✅ Live |
| 7 | CTDMS daily sync: "To enter in Toyota CRM" and "Missing in our CRM" queues, booking sync | ✅ Live |
| 8 | Staged quotes: Basic → Company schemes (TL approves) → Dealer discount (OH up to ₹25,000, BH above) → Final | ✅ Live |
| 9 | Digital Welcome Docket with document photos, signatures and PDF | ✅ Live |
| 10 | Stock import from CTDMS PDFs, FIFO allotment, swaps, billing queue, new Accounts role | ✅ Live |
| 11 | Finance cases, new Finance Executive role | ✅ Live |
| 12 | Payments and outstanding, insurance, RTO, delivery checklist and gate | ✅ Live |
| 13 | Hold, cancellation, refunds, booking history | ✅ Live |
| 14 | Employee management: HR role, onboarding and offboarding, assets, login invites | ✅ Live |
| 15 | Pipeline dashboard, consultant / source / stock-ageing reports, mobile "This month" card | ✅ Live |

### What the system does now

1. **Enquiry.** The consultant records the walk-in or call. The customer is found or created by
   mobile number.
2. **CTDMS sync.** The back office uploads CTDMS's enquiry report each morning. Our enquiries are
   matched to Toyota's, and the gaps become to-do lists with a *Done* button.
3. **Quote, in stages.** Basic price, then company schemes, then dealer discount, then final. Each
   priced stage needs the right approver, and the customer can be sent a PDF at any stage.
4. **Booking and Welcome Docket.** A booking is made from the final quote. The docket is filled on
   the phone, with photos, both signatures and a PDF. Billing is blocked until it is complete.
5. **Stock and allotment.** CTDMS stock statements (transit and physical PDFs) are uploaded. Cars are
   proposed to bookings oldest-first, and a car can be swapped to another customer. Every change is
   listed as a "Block / Unblock in CTDMS" to-do.
6. **Billing.** The Outlet Head sends the booking for billing, and Accounts records the invoice.
7. **Finance.** Finance cases move from documents to login, sanction, DO and disbursement.
   Disbursements become payment receipts.
8. **Payments, insurance, RTO.** Accounts records and clears receipts. The back office records the
   policy and the registration.
9. **Delivery.** The consultant fills the checklist on mobile. Delivery is refused while money is
   outstanding, unless the Business Head overrides it.
10. **Hold / cancel.** A hold releases the car. A cancellation needs the Outlet Head, and refunds are
    raised automatically (cheque within 7 working days; loan money goes back to the financier).
11. **People.** HR adds staff, runs the onboarding and offboarding checklists, issues assets and
    sends login invites. A leaver's open work is handed over.
12. **Reports.** The pipeline overview, consultant performance, sources and lost / cancel reasons,
    and stock ageing. Each person sees only their own slice.

### Roles

| Role | Rank | Sees / does |
|---|---|---|
| Admin, Business Head | 0, 1 | Everything; master data; approves large dealer discounts; overrides outstanding at delivery |
| Outlet Head | 2 | Their branch; allots and swaps cars, sends for billing, approves cancellations and discounts up to ₹25,000 |
| Head Customer Relations | 3 | Branch back office: CTDMS sync, insurance, RTO, stock view |
| Team Leader | 4 | Their team; approves company-scheme quotes |
| Sales Consultant | 5 | Their own enquiries, quotes and bookings (mobile) |
| Accounts | 6* | Their branch's billing queue, receipts, cheque clearance, refunds |
| Finance Executive | 6* | Finance cases at their branch |
| HR | 6* | Staff records, checklists, assets, logins; no customer data |

\* Recognised by role name, ranked below every approval check.

---

## What's left

### 1. To switch the system on

These are settings and data, not code.

- [ ] **Create staff logins.** Add each person's work email on their *People → Employees* page and
      press *Send login invite*. Create the first HR user (or let the Business Head do it).
- [ ] **Add `SUPABASE_SERVICE_ROLE_KEY` to the dashboard's server environment on Vercel.** Without it,
      the invite and set-password buttons only explain what's missing. Never give it a
      `NEXT_PUBLIC_` prefix.
- [ ] **Allow the set-password page as a redirect.** In Supabase → Authentication → URL
      Configuration, add `<dashboard address>/auth/set-password`.
- [ ] **Upload the first CTDMS stock statements** (transit and physical) under *Stock*, so allotment
      and stock ageing have data.
- [ ] **Run the mobile app on a real phone.** It type-checks but has not been run on a device yet.
- [ ] Turn on leaked-password protection in Supabase Auth (the only security advisory flagged).

### 2. Data and decisions still needed

- [ ] **The full employee sheet.** Staff were created from the CTDMS booking dump (30 Sales
      Officers, 6 Team Leaders) with no emails or phone numbers. The sheet will add codes, contacts
      and the rest of the team.
- [ ] **Unmapped stock codes.** Glanza suffixes `D24Z3`, `D24ZI` and `D24ZK` are not in the price
      list, and the "WHITEPEARL & A.BLACK" two-tone isn't linked to `FRN1L` / `FRN4L`. 9 of 204
      cars in the sample statements can't be matched until these are added.
- [ ] **Real IDV depreciation slabs** (the current ones are placeholders) and the **current TCS
      rate**. Both are only used when a price-list row doesn't give the figure.
- [ ] **Can CTDMS export the stock statement as Excel?** That would be more robust than reading the PDF.

### 3. Not built yet

| Item | Why it matters | Notes |
|---|---|---|
| Scheme-master upgrades | Model the circular's rules in full: suffix / fuel scoping, "% of ex-showroom capped at ₹X", TFS-only subvention, rural / corporate / loyalty eligibility, bulk slabs | Deferred in Phase 8; schemes are picked by hand today |
| Re-price at delivery | The design calls for a third price check before delivery; today the deal amount is the booked price plus the docket's accessories | Phase 12 uses the booked amount |
| Dashboard importers for price lists and accessories (PDF) | TKM revisions can be uploaded without a developer | Today a revised list goes through `scripts/seed/build_master_seed.py` and a new migration. The old CSV price-list upload doesn't know the new list columns |
| Printable per-model TGA accessories order form | Same layout as Toyota's form, with fitment sign-off by SO / SM / VAS lead | The docket captures the order; delivery has one "accessories fitted" tick |
| Post-delivery surveys and referral follow-up | After delivery the plan triggers surveys and the referral form | Referrals are captured in the docket only |
| Scheme claim tracking | Tax-paid receipts are kept as claim proof, but claims aren't tracked | Receipts are stored with the RTO record |
| Employee self-service on mobile | Staff see their own private details only on the dashboard | |
| End-to-end browser test | One automated run of enquiry → delivery across both apps | Each phase is covered by SQL tests and builds instead |

---

## Repository layout

- `supabase/migrations/` — every schema change, in order (RLS, functions, seed data)
- `supabase/tests/` — SQL test suites, run against a scratch database (each rolls back)
- `supabase/functions/` — Edge Functions (`price-quote`)
- `dashboard/` — Next.js dashboard
- `mobile/` — Expo app
- `scripts/seed/` — generators for the master data (price lists, accessories, EW, TKM codes) and the
  CTDMS order import
- `scripts/localdb/` — apply all migrations to a local Postgres
- `docs/ROADMAP.md` — the plan and the detail of each phase

## Running and checking locally

**Dashboard**

```bash
cd dashboard && npm install && npm run dev
npm run lint && npx tsc --noEmit && npm run build   # what to run before pushing
```

Environment:
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`: the project URL and publishable key.
- `SUPABASE_SERVICE_ROLE_KEY` (server only): login invites, set-password links, blocking a leaver's
  login.
- `NEXT_PUBLIC_SITE_URL` (optional): the address used in invite emails. If unset, the request's
  address is used.

**Mobile**

```bash
cd mobile && npm install && npx expo start   # scan the QR code with Expo Go
npx tsc --noEmit
```

Environment: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` (in `mobile/.env`, git-ignored).
The app is on **Expo SDK 58** (React Native 0.88), so it opens in the current Expo Go from the App
Store / Play Store.

**Database tests.** These need a local Postgres 16. The stubs stand in for Supabase's `auth` and
`storage` schemas.

```bash
export PGHOST=/tmp PGPORT=54329 PGUSER=postgres
scripts/localdb/apply.sh rt_crm_test
psql -v ON_ERROR_STOP=1 -d rt_crm_test -f supabase/tests/<suite>.sql
```

Run each suite on a freshly applied database. The suites are:
- `price_list_pricing`
- `enquiries`
- `ctdms_sync`
- `staged_quotes`
- `welcome_dockets`
- `stock_allotment`
- `finance_cases`
- `payments_delivery`
- `hold_cancel`
- `employee_management`
- `pipeline_reports`

## Design rules

- **Selections are permanent, prices are recomputed.** What the customer chose is stored. The
  price is always recalculated server-side from live master data (`calculate_price`): at quote
  creation and at booking. A third check before delivery is still to come (see above).
- **Gates live in the database.** Status changes go through `security definer` functions that check
  the rule:
  - docket complete before billing
  - nothing outstanding before delivery
  - the right approver for each quote stage

  Booking changes are logged in `booking_events`.
- **Everyone sees only their slice.** Row-level security follows the reporting hierarchy and
  branch. The report functions run as the signed-in user, so reports obey the same rules.
- **No personal data in git.** CTDMS customer and staff names stay in `data/private/` (git-ignored)
  and are loaded straight into the database.

## Master data and CTDMS imports

- `supabase/migrations/20261024000002_master_data_seed.sql` is **generated** by
  `scripts/seed/build_master_seed.py` from the TKM price-list PDFs, the TGA accessory order forms and
  the T-Secure EW list. When TKM revises a list, update the script's input, regenerate, and add the
  output as a new migration. The script checks every row against the list's own "On Road" figure.
- Open CTDMS orders (PO Order Listing, Booked / Accepted) and the staff they name are built by
  `scripts/seed/build_ctdms_orders_seed.py` into `data/private/`. After go-live, the daily order
  listing is uploaded on the dashboard's *CTDMS Sync* page instead.

## Live database versions

`apply_migration` stamps its own version numbers, so the live versions differ from the file names.

| File | Live version | Name |
|---|---|---|
| `20260918000002`–`000004` | `20260918101317`, `20260918101353`, `20260918101905` | 18 Sep live-schema changes |
| `20261024000001` | `20261024180708` | branches_codes_pricelist |
| `20261024000002` | in sections: `20261024181155` catalog; variant colours by hand in the SQL editor (its `delete` needs confirmation); `20261025180959` / `20261025181929` prices; `20261025182327` accessories; `20261025182457` TGLOSS; `20261025182610` EW | master_data_seed |
| `20261024000003` | `20261025182740` | pricing_engine_price_list |
| `20261025000001` | `20261025183418` | customers_enquiries (Phase 6) |
| `20261025000002` | `20261025190553` | enquiries_hardening |
| `20261026000001` | `20261025192303` | ctdms_sync (Phase 7) |
| `20261027000001` | `20261026041848` | staged_quotes (Phase 8) |
| `20261028000001` | `20261026043750` | welcome_dockets (Phase 9) |
| `20261029000001` | `20261026052321` | stock_allotment (Phase 10) |
| `20261030000001` | `20261026053217` | finance_cases (Phase 11) |
| `20261031000001` | `20261026074654` | payments_delivery (Phase 12) |
| `20261101000001` | `20261026075429` | hold_cancel (Phase 13) |
| `20261102000001` | `20261026081013` | employee_management (Phase 14) |
| `20261103000001` | `20261026091801` | pipeline_reports (Phase 15) |

The 36 CTDMS staff and 265 open orders were loaded with `execute_sql`. They are not recorded as
migrations.
