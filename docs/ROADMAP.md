# Rajesh Toyota CRM — Full Enquiry-to-Delivery Plan

## Context

Rajesh Toyota runs two systems side by side: Toyota's own CRM (CTDMS) and our own CRM, the one in this repo. Phases 0–5 are already built and merged:
- Supabase schema: outlets, roles and employees, catalog, schemes, RTO, insurance, accessories and VAS, approvals, quotes and bookings
- `calculate_price()`, the pricing engine
- an Expo mobile quote and booking flow
- a Next.js admin dashboard with master CRUD and reports

What's missing is the rest of the lifecycle:
- enquiry capture
- the daily reconciliation with CTDMS
- staged quotes, where each step needs approval
- a digital Welcome Docket
- stock allotment (FIFO plus manual swaps)
- billing, finance, insurance, RTO, payment reconciliation and delivery
- hold and cancel
- employee management

This plan extends the existing codebase. It does not replace it.

**Decisions already made by the business:**
- **Quote approvals.** Company-scheme stage: Team Leader approves. Dealer discount: Outlet Head approves up to a threshold, Business Head above it.
- **FIFO.** Ordered by **earliest booking date**.
- **Stock views.** Include **Transit (CTDMS) + Physical** stock. Transit cars can be pre-matched and are tagged "In transit".
- **Platforms.**
  - **Mobile** is for Sales Consultants: enquiry, quote, booking, Welcome Docket and finance documents.
  - The **dashboard** is for the back office: CRM sync, stock, billing, insurance, RTO, payments, delivery and HR.

**Source documents reviewed:**
- CTDMS Enquiry Survey Report (.xls, 49 rows for 17/09/2026)
- CTDMS Stock Statement – Transit (PDF, 31 vehicles)
- Sep'26 North 2 Scheme Circular
- Welcome Docket (40 pages)
- Camry TGA/TGLOSS accessories order form

The physical stock sheet is still to come. The Physical stock importer's column mapping gets finalised once it arrives.

---

## 1. Customer lifecycle (single source of truth)

`enquiries.stage` / `bookings.status` drive every queue in the system:

```
ENQUIRY ─► CRM SYNC ─► QUOTE (Basic → +Company Schemes → +Dealer Discount → Final)
   │                                                               │
   └──── (drop / lost) ◄───────────────────────────────────────────┤
                                                                   ▼
BOOKING + Welcome Docket ─► ALLOTTED (chassis) ─► SENT FOR BILLING ─► BILLED
   ─► INSURED ─► RTO DONE ─► PAYMENT CLEARED ─► DELIVERED
Side states at any point after booking: ON HOLD (resumable) · CANCELLED (refund flow)
Parallel track when mode_of_purchase = in-house finance: FINANCE CASE (login → sanction → DO → disbursed)
```

**Hard gates** are enforced in the DB with triggers or RPCs, not only in the UI:

| Transition | Gate |
|---|---|
| Quote stage N → N+1 | Previous stage approval = approved (Basic needs none) |
| Final quote → Booking | Final quote approved; booking amount receipt entered |
| Booking → Allotted | Booking not on hold or cancelled; vehicle `free` and matches variant + colour |
| Allotted → Sent for billing | Welcome Docket complete (mandatory fields + signatures) |
| → Delivered | Outstanding = 0 (cleared receipts ≥ final deal amount), insurance policy no., RTO temp/perm no., PDI and accessory fitment checklist done |

---

## 2. Modules

### M1. Enquiry entry (mobile + dashboard)
- **New table `customers`:** name, `mobile` (normalised to 10 digits, indexed), alt phone, email, address, pin, PAN. Dedupe on mobile.
- **New table `enquiries`:**
  - `customer_id`, `outlet_id` (branch), `assigned_employee_id` (SC)
  - `purpose_of_visit` (new purchase / test drive / exchange / info / finance enquiry…), `model_id`, `fuel_type_id`, optional `variant_id`/`color_id`
  - `source` and `mode`, mirroring CTDMS values: Walk-in, Dealer CAC Call-In/Out, TKM Digital, Cold Call, UIO Lead, Dealer Digital, Referral…
  - `test_drive_given`, `temperature` (HOT/WRM/CLD, same codes as CTDMS)
  - `ctdms_enquiry_no` (unique, nullable), `crm_sync_status` (`pending_entry` | `marked_done` | `verified` | `mismatch`)
  - `stage`, `lost_reason`
- **Mobile:** new "New Enquiry" screen as the first step, before quotes. `quotes/new.tsx` gets an `enquiryId` param so the quote pre-fills from it.
- **Dashboard:** enquiry list with filters (branch, SC, stage, sync status) and reassignment of branch or SC.

### M2. Toyota CRM daily sync (dashboard)
- **Upload page `/crm-sync`.** Staff upload the CTDMS *Enquiry Survey Report* every morning, as .xls or .xlsx.
- **Parsing.** A server action parses it with SheetJS (`xlsx`). The header row is found by looking for `ENQUIRY NUMBER`, because the report has title rows above it.
- **Columns used:** ENQUIRY NUMBER, ENQUIRY DT, CUSTOMER NAME, MOBILE NUMBER, MODEL NAME, GRADE CODE, MODEL SUFFIX CODE, EXTERIOR COLOR CODE, ENQIRY STATUS, ENQUIRY_MODE_NAME, ENQUIRY_SOURCE_DESC, TEST DRIVE GIVEN STATUS, SALES_OFFICER.
- **Audit trail.** Rows are stored in `crm_import_batches` / `crm_import_rows`.
- **Matching.** On normalised mobile, against open enquiries:
  1. **Matched.** Write `ctdms_enquiry_no` onto our enquiry and set `crm_sync_status = verified`. Mirror the CTDMS status (ORD/HOT/WRM/CLD/DRP/SCS) for reference.
  2. **In our CRM, not in CTDMS → "To enter in Toyota CRM" queue.**
     - Each row shows the fields the staff member needs to type into CTDMS.
     - A **Done** button records who and when, and sets `marked_done`.
     - The next day's upload auto-verifies the row. If it's still missing, it's flagged `mismatch`.
  3. **In CTDMS, not in our CRM → "Missing in our CRM" queue.** One click creates the enquiry. The SC is resolved via `employees.ctdms_sales_officer_name`.
- **Same flow for bookings.** `bookings.ctdms_order_booking_no` gets its own "To book in CTDMS" queue, with the same Done button.

### M3. Staged quotation (mobile builds, approvers act on mobile or dashboard)
- **Quote versions.** Add `quote_versions` (quote_id, `stage` = `basic` | `with_schemes` | `with_dealer_discount` | `final`, snapshot, total, dealer_margin, approval_id, created_by). `quotes` gets `current_stage` and `enquiry_id`.
- **Stage 1 – Basic:** ex-showroom, TCS, RTO, insurance, **FASTag**, accessories and VAS. This is the existing `calculate_price()` with no scheme IDs. FASTag is added as a `fixed_charges` master, or a VAS with `is_mandatory`.
- **Stage 2 – With company schemes.** The SC picks from the eligible scheme line items, then the Team Leader approves.
- **Stage 3 – With additional dealer discount.**
  - Add a `dealer_discount` input to `calculate_price()`. It is customer-facing and reduces dealer margin.
  - Approval comes from `approval_rules`: Outlet Head up to the threshold, Business Head above it. The rule data needs no schema change; `approval_rules` gets a `stage` column.
- **Stage 4 – Final.** Locks the selections. The SC can then "Proceed to booking". This reuses the existing re-price checkpoint in `bookings/from-quote/[quoteId].tsx`.
- **PDF.** `mobile/lib/quote-document.ts` generates a PDF for each stage, so the customer can be sent the basic price first.
- **Scheme master upgrades,** needed to model the Sep'26 circular:
  - `schemes.suffix_codes text[]` (e.g. D22U4, FRN1L), plus `fuel_type_ids` / `exclude_fuel_type_ids` for rules like "excluding CNG"
  - `scheme_line_items.calc_type`: `flat` | `pct_ex_showroom_capped`, for "1.5% of ex-showroom or ₹20,000, whichever is lower"
  - `requires_finance_company` (TFS subvention only applies when financed via TFS)
  - eligibility tags: rural pin, corporate (T-5000), loyalty (existing Toyota), referral
  - bulk slabs (5–9, 10–14, 15–25, >25)
  - The existing `mutually_exclusive_group` already covers "Sales Discount OR TFS subvention" and "Exchange OR Scrappage".
- **Accessories master.** Add `category` (Hygiene / Styling / Utility) and `is_tga`. TGLOSS packages become VAS rows. Both match the Camry order form.

### M4. Booking + digital Welcome Docket (mobile)
- **Order Booking Form.** The existing `bookings` columns already mirror docket page 7 (PAN, DOB, nominee, mother's maiden name, company purchase, payment instrument, consent, signature). They get linked to `enquiry_id` and `customer_id`.
- **New `welcome_dockets` table**, one per booking, covering the rest of the docket:
  - **Registration & Delivery Details (p.25):**
    - father's/husband's name, registration address, hypothecated to
    - insurance in-house or by party
    - permanent/temporary, private/commercial, state or all-India permit
    - special registration number, likely delivery date/time/place
    - TR / RC / HSRP working-day estimates
  - **Accessories Order Form (p.13).** Line items from the accessories master, with qty, price and 10% advance.
  - **Document checklist (p.21).** Each item is ticked and its file uploaded to Supabase Storage, reusing the `upload-queue.ts` pattern.
  - **RTO process acknowledgement (p.24),** extended warranty / Smiles / T-Connect opt-ins, and the referral form (p.38).
  - **Signatures** from the customer and the SC, reusing `signature-pad.tsx`.
- **Output.** A branded Welcome Docket PDF, shared to the customer on WhatsApp or email, with a copy stored in Storage. The **T&C and cancellation clauses** are copied verbatim from the docket.

### M5. Stock & allotment (dashboard)
- **New `vehicles` table**, one per VIN:
  - VIN (unique), engine no., `variant_id`, `color_id`, TKM suffix code, ext/int colour
  - `source` (`transit` | `physical`), TKM invoice date and amount, interest amount, days since invoice, PDS done, yard location
  - `status`: `in_transit` | `in_stock` | `allotted` | `billed` | `delivered`
- **Imports:**
  - CTDMS Stock Statement (Transit/All). We prefer the CTDMS Excel export. PDF parsing is a fallback via `pdf-parse`.
  - The physical stock sheet, with its column map set once that sheet is shared.
  - Upsert is on VIN. The two sources merge when a transit car arrives and moves to `in_stock`.
- **Code mapping.** Stock and enquiry files use TKM codes (e.g. suffix `D22U4`, colour `089`/`WBF`). We add `variants.tkm_suffix_code` and `colors.tkm_color_code`. Unmapped codes show up in an import "Fix mapping" list.
- **New `allotments` table:** booking_id, vehicle_id, `method` (`fifo` | `manual`), allotted_by, allotted_at, released_at, release_reason. There is a partial unique index so one vehicle has at most one active allotment.
- **Three views:**
  1. **Free Stock.** Unallotted vehicles, grouped model → suffix → colour. Shows ageing (days since TKM invoice) and interest cost, so old stock gets pushed first.
  2. **Match Stock.**
     - A `propose_fifo_allotments()` RPC matches free vehicles to un-allotted bookings on the same variant + colour, ordered by booking date. Older stock goes first, so ageing reduces.
     - Proposals are shown before they are committed, and the user confirms them.
     - Each chassis row has a **"Change customer"** picker listing all eligible bookings. Swapping releases the old allotment, puts that customer back in the queue, and logs the change.
     - The user can also manually allot cross-colour, with an override reason.
  3. **Allotted / Billing queue.** **"Send for billing"** creates a `billing_requests` row. Accounts then enter the invoice no., date and amount, and the vehicle moves to `billed`.
- **Pending demand.** Bookings with no matching stock are shown separately, to help plan orders.

### M6. Finance (mobile for docs, dashboard for tracking)
- **New `finance_cases` table:**
  - booking_id, financier (TFS / bank master), in-house or own finance
  - loan amount, tenure, ROI, EMI, advance EMI, processing fee
  - `status`: docs pending → login → sanctioned → DO received → disbursed / rejected
  - DO number and amount, disbursement amount and date
- **Document checklist.** Salaried / self-employed / company lists from docket p.19 and p.21, with uploads.
- **Payment link.** The disbursement amount is posted as a receipt in M8. TFS subvention schemes check that `finance_cases.financier = TFS`.

### M7. Insurance & RTO (dashboard)
- **`insurance_policies`:** insurer, policy no., premium, IDV, add-ons, in-house or by party, policy PDF.
- **`rto_registrations`:** TR no. and date, permanent no., special number requested, HSRP status, RC status, tax receipt upload. The scheme circular asks for tax-paid receipts as claim proof, so these uploads are reused for **scheme claim tracking**.

### M8. Payments & reconciliation (dashboard)
- **New `payment_receipts` table:**
  - booking_id, mode (cash / cheque / DD / UPI / NEFT / finance disbursement / exchange value / scrap value)
  - instrument no., bank, amount, date
  - `clearance_status` (pending / cleared / bounced), receipt no.
- **Final deal amount.** This is the booking's final-stage price, re-priced at the existing *finalize-for-delivery* checkpoint named in the README.
- **Outstanding.** Outstanding = final deal amount − cleared receipts. It's shown on every booking and blocks delivery when > 0, unless a Business Head override is logged.

### M9. Delivery (dashboard + mobile)
- **Delivery checklist:**
  - PDI done
  - accessory fitment, signed off per the Camry order form's "fitment status" (SO / SM / VAS lead)
  - FASTag fitted, documents explained, demo done, handover photo
- **Records** delivery date/time and the customer signature, then sets the booking to `delivered`. That triggers the post-sale surveys and the referral form.

### M10. Hold & Cancel
- **Shared event log.** A `booking_events` log (status_from, status_to, reason, by, at) is used by every transition.
- **Hold:** reason, expected resume date. Any active allotment is released. The booking is excluded from FIFO until it resumes.
- **Cancel:**
  - reason from docket p.8 "Order Cancellation Details", plus a written-request upload
  - This releases the allotment and creates a `refunds` record.
  - Refund goes by cheque within 7 working days. If loan money was received, it goes back to the financier. Both rules come straight from the docket T&C.
  - Needs Outlet Head approval.

### M11. Employee management (dashboard)
- **Extend `employees`:** employee code, DOB, joining date, department, designation, `ctdms_sales_officer_name`, emergency contact, bank details, PAN and Aadhaar (stored in a restricted Storage bucket), exit date, exit reason.
- **Onboarding checklist:** a configurable template, with per-employee tasks such as documents collected, laptop or SIM issued, CTDMS ID created, CRM login created (invite via Supabase Auth), training.
- **Asset issue/return log** and an **offboarding checklist.** Offboarding deactivates the login and asks for reassignment of open enquiries and bookings.
- **Visibility.** The existing hierarchy (`reports_to_employee_id`) and the `can_access_employee_data` RLS keep governing who sees what.

### M12. Pipeline dashboard & reports
- **Funnel by branch and SC:** enquiries → quotes per stage → bookings → allotted → billed → delivered, plus the CTDMS sync health.
- **Other views:** stock ageing and interest, outstanding payments, pending approvals, finance pipeline.
- **Reuse.** Built on the existing `report-filter-bar.tsx` and the `reports/*` pages.

---

## 3. Build order (each phase shippable on its own)

| Phase | Scope | Main files |
|---|---|---|
| 6 | TKM code mapping, scheme schema upgrades, FASTag, `customers` + `enquiries`, mobile New Enquiry, dashboard enquiry list | new `supabase/migrations/2026102x_*.sql`, `calculate_price` update, `mobile/app/(app)/enquiries/*`, `dashboard/src/app/(app)/enquiries/*`, `dashboard/src/lib/entities.ts` |
| 7 | CTDMS daily sync (enquiries + bookings queues, Done button) | `dashboard/src/app/(app)/crm-sync/*`, `dashboard/src/lib/ctdms-import.ts` |
| 8 | Staged quotes + stage approvals | `quote_versions` migration, `mobile/app/(app)/quotes/*`, `mobile/lib/approvals.ts`, `dashboard/.../reports/approvals/*` |
| 9 | Welcome Docket capture + PDF | `welcome_dockets` migration, `mobile/app/(app)/bookings/*`, `mobile/components/booking-form-fields.tsx`, new `mobile/lib/docket-document.ts` |
| 10 | Stock import, Free/Match/Billing views, FIFO + swap | `vehicles`/`allotments`/`billing_requests` migrations, `dashboard/src/app/(app)/stock/*` |
| 11 | Finance cases | migration + `mobile/app/(app)/finance/*`, `dashboard/.../finance/*` |
| 12 | Payments, insurance, RTO, delivery + gates | migrations + `dashboard/.../bookings/[id]/*` (one booking "file" page with tabs) |
| 13 | Hold / cancel / refunds | `booking_events`, `refunds` |
| 14 | Employee management | employees extension, onboarding/asset tables, `dashboard/.../hr/*` |
| 15 | Pipeline dashboard & reports | `dashboard/src/app/(app)/page.tsx`, `reports/*` |

**Conventions to follow throughout:**
- Every new table gets RLS in the style of `20260917000012_rls_policies.sql`, scoped by `can_access_employee_data` and outlet.
- Every status change goes through a `security definer` RPC that enforces the gate and writes `booking_events`.
- Prices are always recomputed via `calculate_price()`, never trusted from the client (per `20260917000019`).

---

## 4. Verification
- **DB:**
  - `supabase db reset` applies all migrations cleanly.
  - SQL test scripts cover:
    - `calculate_price` at each quote stage (Hyryder: Sales Discount and TFS subvention can't both apply; scrappage = min(1.5%, ₹20k))
    - `propose_fifo_allotments` ordering, and swap/release
    - delivery gate blocking when outstanding > 0
- **Import tests,** run against the files shared here:
  - Enquiry XLS: 49 rows parsed, mobile normalisation, correct matched / to-enter / missing counts against seeded enquiries.
  - Transit stock: 31 vehicles, unmapped-code list shown.
- **Dashboard:** `npm run lint && npm run build`.
- **Mobile:** `npx tsc --noEmit`.
- **End-to-end** with Playwright on the dashboard, plus the Expo web build for mobile, using seed users (SC → TL → OH → BH):
  enquiry → sync → 4-stage quote with approvals → booking + docket PDF → import stock → FIFO allot → swap customer → bill → finance DO → receipts → insurance/RTO → deliver; plus a hold and a cancel path.

## 5. Open items (don't block Phase 6–9)
- Physical stock sheet format, to be shared next.
- Can CTDMS export the Stock Statement as Excel? That would avoid PDF parsing.
- The amount threshold where Outlet Head approval hands over to Business Head for dealer discount. This is master data, settable in Approval Rules.
- The real IDV depreciation slabs. The current ones are placeholders, per the comment in `20260917000006_insurance.sql`.
