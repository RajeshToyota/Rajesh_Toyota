# Rajesh Toyota — bring it to Techwheels parity

> **Status (18 Nov 2026):** Phases 17a–22 are built and tested on a local database. They are not yet on the live project. See the "Phases 17–22" section of `docs/ROADMAP.md` for what shipped and what is left before go-live.

## Context
Goal: Rajesh Toyota should work like Techwheels, with the same logic and modules.

Rajesh Toyota (RT) is **not** a blank project:
- Phases 0–16 are live on Supabase (38 migrations).
- Stack: Next.js 16 dashboard + Expo mobile app.
- Live chain: enquiry → quote → booking → Welcome Docket → stock allotment pool (already ported from Techwheels) → finance → payments → insurance/RTO → delivery → hold/cancel, plus HR, reports and about 25 masters.

**Decision:** rebuild the **dashboard** as a React + Vite app in the same shape as Techwheels (TW). Everything else stays:
- the Supabase database: 38 migrations, about 150 RPCs, RLS and live data;
- the Expo mobile app (TW's mobile app is also Expo);
- the business logic, which already lives in SQL.

Why a rebuild is easier than it sounds:
- RT's dashboard is small: 41 pages and about 11k lines.
- Almost every page just calls `supabase.rpc`.
- Only 7 server-action files exist, and only HR (login invites) needs the service-role key.

Once the dashboard runs on the TW stack, TW pages (shell, RBAC, menu, tables, upload screens) can be adapted almost line for line instead of being rewritten for Next.js.

Then port the TW modules RT lacks, one phase at a time, re-keyed for Toyota:
- Tata VC codes become model + suffix + colour.
- The Tata CRM Opty ID becomes the CTDMS enquiry/order no.
- Tata CSV parsers become parsers for CTDMS .xls/PDF exports.

Port the **business logic** (the rules inside the RPCs, the stage gates, the payout formulas). Do not copy TW code: it is a React/Vite app keyed on Tata VC codes in 1,000+ places.

## How the TW → RT mapping works (applies to every phase)

| TW pattern | RT equivalent |
|---|---|
| `booking_execution` stage row + `r:ops_billing_*` RPCs | Add stage columns/tables keyed on `bookings.id`. Only SECURITY DEFINER RPCs change status (RT already works this way, e.g. `send_for_billing`, `record_invoice`). |
| `has_rbac_right(context, right)` + `visibility_core_pass` | A new `has_right()`, layered on RT's rank helpers (`can_access_employee_data`, `can_manage_stock`…) |
| DB-driven menu (`admin_menu_modules`) | Replace the hard-coded groups in `dashboard/src/components/sidebar-nav.tsx` with a `menu_modules` table filtered by rights |
| Vite page in `src/pages/admin/X.jsx` | Same layout in `web/src/pages/admin/X.tsx`, a route in `web/src/App.tsx`, calling RT RPCs with client-side supabase-js |
| `api/*.js` Vercel functions (imports, PDFs) | `web/api/*.ts`, or Supabase edge functions where the service-role key is needed |
| TW mobile `mobile/app/(main)/X` | RT `mobile/app/(app)/X`, where the feature is for consultants or the field |
| pg_cron / Vercel cron | Supabase pg_cron (RT already drains `pool_dirty_keys` this way) |

Each phase:
1. Migration in `Rajesh_Toyota/supabase/migrations/2026MMDD…`
2. SQL tests in `supabase/tests/`
3. Dashboard pages
4. Mobile screens where needed
5. Roadmap entry in `docs/ROADMAP.md`
6. Ships switched off behind a config flag, as the pool did

## Phase order

### Phase 17a — Rebuild the dashboard on Vite + React (the Techwheels shell)
- Create `Rajesh_Toyota/web/` with React, Vite, react-router v7, Tailwind v4, Zustand, supabase-js, xlsx/papaparse and jspdf. Use TypeScript with `allowJs`, so TW `.jsx` code can be pasted in and typed gradually.
- Copy the TW app shell and adapt it: `AdminPanel.jsx` layout, `ProtectedRoute.jsx`, `src/lib/supabase.js`, `authReady.js`, the RBAC store pattern from `src/lib/rbac.js`, and the lazy-loaded routes from `App.jsx`. Remove TW branding and the Tata-only routes.
- Port all 41 RT pages to `web/src/pages/admin/*`, with the same features: enquiries, CTDMS sync, finance, stock (free stock, import, match, allotted, billing, CTDMS, vehicle, pool and its config/audit, finance queue, VNA), payments, cancellations, bookings and their tabs, HR, reports, masters and the price-list import.
  - Server components become `useEffect`/query hooks calling the same RPCs.
  - Server actions become direct RPC calls.
  - `lib/xls.ts`, the pdfjs CTDMS parser and `lib/entities.ts` (generic masters) move over unchanged.
- HR login invite: `hr/actions.ts` is the one server action that uses the service-role key. It becomes a Supabase edge function `invite-employee`, mirroring TW's `api/hr/resend-invite.js`.
- `/auth/set-password` becomes a client route.
- Hosting: Vercel SPA rewrite, as in TW's `vercel.json`.
- Keep `dashboard/` running until `web/` reaches feature parity and signs off. Then switch the domain and delete `dashboard/`.
- Check: a page-by-page parity checklist, with a Playwright smoke test of every route for each role.

### Phase 17b — Permissions and the database-driven menu (foundation)
**TW reference:** `src/lib/rbac.js`, `EmployeeAccessStudio.jsx`, `scripts/syncAdminModules.js`, `has_rbac_right`, `employee_permission_rights`.

**Build in RT:**
- New tables: `permissions` (one row per module key, e.g. `stock.pool`), `rights` (view/create/edit/approve/delete), `role_permission_rights`, `employee_permission_overrides`, `menu_groups`, `menu_modules`.
- RPC `has_right(module, right)`. It checks admin first, then employee revoke, then employee grant, then role. Hierarchy and outlet scoping stay in RT's existing rank helpers. This matches TW, where only Sales Persons are limited to their own hierarchy.
- Seed rights from today's rank behaviour, so nothing changes on day one.
- Web work, ported from TW:
  - `AdminPanel` loads `menu_groups` and `menu_modules` filtered by rights.
  - `usePermissionGate` / `useRightGate` hooks.
  - Access Studio page, adapted from `EmployeeAccessStudio.jsx`.
  - A build-time sync script, adapted from `scripts/syncAdminModules.js`, so every new route registers its own permission.
- New roles TW has and RT lacks: Relationship Manager, PDI/Workshop, Insurance Exec, RTO Exec, Gate/Security, Used-Car Evaluator.

### Phase 18 — Ops Billing pipeline, PDI and delivery slots
**TW reference:** `/admin/ops-billing/*` pages, `src/lib/opsBillingRpc.js`, `booking_execution`, `booking_stage_reversal_request`, `pdi_board_list`, `pdi_record_result`, `delivery_slot_booking`, `rmDeliverySlots.js`.

**RT already has:** `billing_requests`, `record_invoice`, `payment_receipts`, `insurance_policies`, `rto_registrations`, `deliveries`, `delivery_blockers()`.

**Build in RT:**
- `booking_ops_stages`: one row per booking. Each tab has its own status, owner and timestamp:
  - Billing (invoice)
  - Accounts (payment cleared)
  - Insurance
  - RTO
  - Accessories fitted
  - Scheme (TKM claim proof)
  - Scrap
  - Gate pass
- Wire the existing RPCs so they advance their stage.
- `request_stage_reversal` / `decide_stage_reversal`: going backwards needs approval, as in TW.
- Gate pass can only be issued when every earlier stage is done. Extend `delivery_blockers()` to enforce this.
- PDI:
  - `pdi_schedule` and `booking_pdi` (checklist result, pass/fail, photos).
  - A failed PDI blocks the gate pass.
- Delivery slots:
  - `delivery_bays` and `delivery_slots`, with capacity per branch per slot.
  - Bookable once the gate pass is ready.
  - A WhatsApp deep-link to the customer.
- Web pages, adapted from TW `OpsBilling*Page.jsx`, the PDI board and the delivery scheduler: `/admin/ops-billing/:stage`, `/admin/pdi-board`, `/admin/delivery-scheduler`.
- Mobile: PDI checklist screen and "My deliveries".

### Phase 19 — RM console, leads, follow-ups, reception and test drive
**TW reference:**
- RM: `rm/RmDashboardPage.jsx`, `RmBookingDetailPage.jsx`, `rm_pipeline_*` RPCs + cache, `rm_assign_booking`, `booking_customer_requests`.
- Leads: `leads/followup/*`.
- Reception: `walkinService.js`, `showroom_walkins`.
- Test drive: `test_drive_*`.

**Build in RT:**
1. **Follow-ups (closes RT's biggest CRM gap).**
   - `enquiry_followups` and `tasks`: due date, outcome, next action, hot/warm/cold.
   - RPCs `log_followup` and `my_due_followups`.
   - Mobile: a "Today" list for Sales Consultants.
2. **Reception walk-ins.**
   - `showroom_walkins` (kiosk form at the outlet, assigned to a consultant).
   - Feeds `create_enquiry`.
3. **Test drive.**
   - `test_drive_vehicles` (demo fleet) and `test_drives` (slot, DL photo, feedback).
   - Replaces the `test_drive_given` flag.
4. **RM console** (after booking, until delivery).
   - Add `bookings.rm_employee_id` and RPC `rm_assign_booking`.
   - `rm_pipeline_counts` / `rm_pipeline_list`: buckets such as awaiting docs, finance pending, allotted, billing, PDI, delivery due. These come from the Phase 18 stages plus the pool.
   - Booking 360 page: notes, tasks, customer requests.
5. **Reports:** walk-in → enquiry → booking conversion, follow-up compliance.

### Phase 20 — Targets and incentive payouts
**TW reference:** `employee_monthly_targets`, `incentive_schemes`, `payroll_incentive_rules`, `components/payroll/IncentiveRuleEngine`, `finance-payout` / claims-payout reports.

**Build in RT:**
- `employee_monthly_targets` (by model and branch).
- `incentive_schemes`: a slab engine (per-unit rate, focus models, caps, Team Leader % of team).
- `incentive_runs` / `incentive_lines` (monthly, frozen once approved).
- Encode the existing Techwheels SOPs as **configurable rules**, not hard-coded:
  - **CA incentive:** 75% released by the 15th of the next month. The remaining 25% is paid once TKM settles. Eligibility gates: digital check-in, leads checked at least 5×/month, learning assessment done.
  - **GM/SM:** 60:40 split; 75% paid monthly, 25% when TKM pays.
  - **Pre-finance team:** paid from 60% in-house finance penetration (total sales minus cash sales). Rs 300 per file, plus Rs 30 for each extra percentage point. Released after the bank pays.
  - **Bank payout to CA:** in-house cases paid bank → CA directly. Invoices verified by Accounts and the GM. Out-house DSA payouts get flagged.
- Dashboard pages:
  - `/targets`
  - `/incentives/run/[month]` (calculate, review, approve, export)
  - `/incentives/finance-payout`
- Mobile: a "My incentive" card on home.

### Phase 21 — Stock extras
**TW reference:** `sap_price_diff_*`, `stock_transfers`, `vehicle_location_log` / `yard_master`, `vehicle_transit_import`, `rajasthan_dealers_stock` + `sap_vna_*`, `stock_control`, `chassis-monitor`.

**Build in RT** (finishes the "not built" items in RT's Phase 16 pool):
1. **Price-difference blocking.** A booking priced on an older price list cannot win a car until the difference is approved or collected. Hook into `pool_recompute`.
2. **Stock transfers** between branches (JP05A / DN01A / VK01A), with approval. Add an `outlet_id` move on `vehicles` plus an audit trail.
3. **Yard and vehicle location log.**
4. **In-transit import:** parse CTDMS dispatch/invoice export → `vehicles.status = in_transit`.
5. **Stock control:** block a VIN, or flag it as demo or damaged.
6. **Other Toyota dealers' stock:** file upload, matched against VNA demand.
7. **Chassis timeline / search console:** RPC `search_console(vin|mobile|booking_no)`.

### Phase 22 — Exchange and used cars (U Trust)
**TW reference:** `ExchangeBusinessPage.jsx`, `used_car_vehicles`, `used_car_evaluations`, `outside_car_leads`, `used-car-negotiation`, `fn:used-car-rc-ocr`.

**Build in RT:**
- Exchange flag on the enquiry or booking.
- `used_car_evaluations` (evaluator, photos, RC details, quoted vs offered price, negotiation log).
- `used_car_vehicles` (procured stock and its status).
- The exchange value flows into the booking's payments as receipt mode `exchange`, which RT already has.
- The U Trust/exchange scheme check is linked to scheme eligibility.
- Mobile: an evaluation screen with camera upload.
- RC OCR/lookup comes later, if a provider API is approved.

## Deliberately not ported (Tata-only or not needed now)
- Tata VC alias tables, Gear/DCI imports, Punch EV, ZAWL/RAS stock, Tata back-order email.
- The public configurator, Razorpay, the customer portal and the WhatsApp Cloud API. These are candidates for a later phase once ops parity is reached.

## Critical files (RT)
- `supabase/migrations/20261113000001_stock_allotment_pool.sql`: pool hooks for price difference and transfers.
- `supabase/migrations/20261031000001_payments_delivery.sql`: `delivery_blockers()`, `deliveries`.
- `supabase/migrations/20261029000001_stock_allotment.sql`: `vehicles`, `billing_requests`, `record_invoice`.
- `supabase/migrations/20260917000002_outlets_roles_employees.sql` and `000012_rls_policies.sql`: roles and the RLS base.
- `dashboard/src/app/(app)/**` is the source for the page port. `dashboard/src/lib/{xls,entities,auth}.ts` and `hr/actions.ts` are reused or replaced in Phase 17a.
- New `web/` app, seeded from these TW files: `src/App.jsx`, `src/pages/AdminPanel.jsx`, `src/components/ProtectedRoute.jsx`, `src/lib/rbac.js`, `scripts/syncAdminModules.js`, `vercel.json`.
- `mobile/app/(app)/bookings/[id]/*`
- `docs/ROADMAP.md`

## Verification (per phase)
1. Apply the migration to a local DB (RT's local-DB script, see README) and run `supabase/tests/*.sql`. Add tests for every gate, e.g. "gate pass blocked while PDI failed" and "incentive 25% held until TKM settlement".
2. In `web/`, run `npm run build` and `npm run lint`. Then click through each new page as Admin, Outlet Head, Sales Consultant and Accounts to confirm that menu items and rights hide and show correctly (Playwright smoke test).
3. Walk one booking end to end on seed data: enquiry → booking → allot → each ops stage → PDI → slot → delivery. Check that the RM pipeline counts move.
4. Apply to the live Supabase project only after sign-off, with the feature flag off. Then switch it on per branch.

Work happens on branch `claude/nifty-clarke-b2snr1` in Rajesh_Toyota. Each phase is a separate commit or PR.
