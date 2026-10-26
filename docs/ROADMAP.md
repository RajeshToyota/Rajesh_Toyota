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

**Second batch (received 24 Oct):**
- **CTDMS Stock Statement – Physical Stock** (PDF, 173 vehicles: 152 Free, 15 Blocked, 6 Alloted). Same columns as Transit, plus Key No., Order No./Date, Order Status (Booked/Accepted/Invoiced), Amount Received, Finance Company, Likely Delivery, Location.
- **TGA accessory order forms** for 11 models: Glanza, Hyryder, Taisor, Rumion, Crysta, Hycross, Fortuner, Camry, LC, Vellfire. Each lists S.No, category, accessory, part no. and MRP, with a TGLOSS packages page.
- **Price lists 2026:**
  - Private, Commercial and CSD lists, each per suffix with dual-tone rows. Columns: Ex-showroom, TCS, Road Tax & Registration, Insurance (Advance / Premium / Premium 3+3), FASTag, On-road, True Warranty 5th yr, TGLOSS.
  - The T-Secure extended warranty matrix (by model × vehicle age × km).
  - The **All Model Suffix & Colour Code** sheet, with old → new suffix and colour code → name.

**Decisions added 24 Oct:**
- **Quote prices come straight from the dealer price lists.** RTO and the three insurance options are not calculated by formula.
- **Our CRM decides allotment.** CTDMS is told via a "Block in CTDMS" to-do, and each stock upload flags any mismatches.

**Third batch (received 24 Oct): CTDMS PO Order Listings** for the three branches.

| Branch | Dealer code | Booked | Accepted |
|---|---|---|---|
| Jaipur | JP05A | 93 | 110 |
| Dausa | DN01A | 11 | 23 |
| Kotputli | VK01A | 6 | 22 |

- **Total: 265 open orders.**
- **Columns:** Order No/Date/Status, Model, Suffix Code + description, Ext colour code + description, VIN (empty in all rows), Customer Code + Name, institutional type and group, Organisation, Team Leader, Sales Officer, Received Amount, Int colour, ICROP enquiry no., Order Id.
- **No mobile number** is in the dump. Customers are keyed by CTDMS Customer Code until the phone is captured.
- **There are 30 Sales Officers and 6 Team Leaders.** 63 rows have no Team Leader.

**Decisions added 24 Oct (batch 3):**
- **Branches are Jaipur (JP05A), Dausa (DN01A) and Kotputli (VK01A).** They replace the test Jodhpur outlet.
- **Employees are created from the booking dump for now.** That means 30 SOs and 6 TLs at their branch, with SO → TL reporting. The full employee sheet will enrich them later. The employee file was not attached, so it still needs to be sent.
- **Only orders with status Booked or Accepted are imported** as open bookings.

## Phase 8 — status: live (26 Oct)

Staged quotes with stage approvals (`20261027000001_staged_quotes.sql`).
- **Four stages:** Basic → With company schemes → With additional dealer discount → Final.
  - A new quote always starts at *Basic*, with no schemes and no discount.
  - Stages move only through `submit_quote_stage` and `finalize_quote`. Direct edits to the stage,
    schemes or discount are refused, and once past Basic the vehicle and add-ons are locked.
  - A stage must be approved before the next one, or before Final. Re-submitting a stage replaces its
    pending request.
  - Every step is kept in `quote_versions`, so the history and each stage's price stay on record.
- **Dealer discount** is a new `calculate_price` input. It comes off the price before TCS and out of
  dealer margin.
- **Approval rules** (editable in *Approval Rules* on the dashboard; an approval is needed when the
  amount is **above** the threshold, and the highest threshold crossed decides):
  - Company schemes: above ₹0 → Team Leader.
  - Dealer discount: above ₹0 → Outlet Head; above ₹25,000 → Business Head.
  - Direct bookings (no quote) keep the old scheme-discount rules.
- **Approvals are decided only through `decide_approval`.** It checks the approver's rank and line,
  and nobody can approve their own request. Approvals can no longer be inserted or updated directly;
  before this, a Sales Consultant could approve their own request.
- **Booking** needs a *Final* quote, and copies its schemes and dealer discount.
- **Mobile:** the new quote screen ends at the basic price, then opens the quote screen. That screen
  has the stage tracker, scheme picks, dealer discount, Finalise, a WhatsApp/PDF share titled for the
  stage, and Proceed to Booking. The Approvals screen lists only requests the user can decide.
- **Dashboard:** the approvals report shows the stage and customer and decides through the RPC.
- **Deferred:** the scheme-master upgrades (suffix/fuel scoping, % caps, finance-company and
  eligibility rules, bulk slabs).
- **Tests:** `supabase/tests/staged_quotes.sql`. Mobile has not been run on a device yet.

## Phase 7 — status: live (26 Oct)

CTDMS daily sync, on the dashboard at `/crm-sync`, for back office (Head Customer Relations and above).
- **Upload.** One box takes either CTDMS export. The file is parsed **in the browser** by
  `dashboard/src/lib/xls.ts`, a dependency-free BIFF8 reader (the npm SheetJS build has open advisories,
  and the patched build is CDN-only). `lib/ctdms-import.ts` recognises the report and maps its columns,
  and only the mapped rows are sent to the database.
  - The reader matches LibreOffice cell for cell on all four sample exports.
  - 12,000 damaged variants of those files all fail cleanly.
- **Enquiry Survey Report → `import_ctdms_enquiry_report`.**
  - Each CTDMS enquiry is matched by its number, then by mobile at that branch. Matches get the CTDMS
    number and are set to *verified*.
  - CTDMS enquiries we don't have go to **Missing in our CRM**. *Create in our CRM* there fills in the
    Sales Officer and model from CTDMS: model from the suffix code, or the model name when there's no
    suffix. Staff choose only what can't be resolved.
  - Enquiries marked *entered* but absent from a report covering their date become *mismatch*.
  - CTDMS repeats some enquiries on two survey lines, so each is counted once.
- **PO Order Listing (one branch, Booked + Accepted) → `import_ctdms_order_listing`.**
  - New orders are added as imported bookings, and unknown Sales Officers are added under their TL.
  - Known orders get their CTDMS fields refreshed; our own bookings with that order number become *verified*.
  - Imported orders no longer listed become *Closed in CTDMS*.
  - Our bookings marked entered but not listed become *mismatch*.
  - Rows with other statuses only update existing orders; they never add new ones.
- **Queues with a Done button:**
  - *To enter in Toyota CRM*: enquiries. The CTDMS number is optional.
  - *To book in CTDMS*: bookings. The order number is required, since the next listing matches on it.
  - Both queues also list *mismatch* items again.
- **Audit and visibility.** *Upload history* keeps every batch with its summary. Back office reads its
  branch's enquiries and bookings, including imported orders that have no consultant yet.
- **Tests:**
  - `supabase/tests/ctdms_sync.sql` uses synthetic rows.
  - The real exports were also run end to end on a scratch copy of the live data.
    - Re-uploading the three listings left all 265 orders unchanged.
    - The 17 Sep report gave 46 distinct enquiries, all created automatically.

## Phase 6 — status: live (25 Oct)

Built and tested on local Postgres. It goes live together with Phase 6a.

- **Migration:** `20261025000001_customers_enquiries.sql`.
  - New tables: `customers` (one per mobile number) and `enquiries`.
  - New links: `quotes.enquiry_id` and `bookings.enquiry_id` / `customer_id`.
  - RPCs: `create_enquiry`, `find_customer`, `reassign_enquiry` and `mark_enquiry_lost`.
  - Triggers move an enquiry to quoted or booked.
- **Who sees and assigns what:**
  - A Sales Consultant sees only their own enquiries and customers.
  - A Team Leader and above sees their team's, and can assign and reassign within it.
  - `find_customer` warns about an open enquiry with another consultant without revealing the details.
- **Mobile:**
  - New Enquiry, a 4-step wizard that starts with the mobile number and spots returning customers.
  - My Enquiries, with stage filters, Make Quote and Mark lost.
  - A quote started from an enquiry is prefilled with the customer, model and fuel, and stays linked
    through to booking.
- **Dashboard:**
  - `/enquiries`: filters for branch, SC, date, stage, mode and Toyota-CRM status, plus inline
    reassign and mark lost.
  - `/enquiries/new`: the reception-desk form.
- **Tests:** `supabase/tests/enquiries.sql` covers dedupe, assignment rules, RLS run as real roles,
  and stage changes.

## Phase 6a build — status: live (25 Oct)

Applied to Supabase on 25 Oct (see the README for live version numbers). Re-runnable *dashboard*
upload screens for PO listings, price lists and accessories are moved to Phase 7, together with the
CTDMS enquiry sync. Both need an .xls reader; see the open items.

- **Catalog:** 12 models and 110 variants with TKM suffix codes. 44 colours with TKM codes and paint
  category, and colour availability for each variant.
- **Price lists:** 203 rows across 15 private/commercial lists. Every row is reconciled with its printed
  On-Road. Five rows don't reconcile, because the source lists themselves are inconsistent:
  - Glanza V(O) MT, V AMT, V(O) AMT and G AMT CNG: the printed On-Road leaves out TCS.
  - Innova Crysta GX+ 8S (commercial): the list prints `#REF!`.
- **Accessories and extended warranty:** 366 TGA accessories and 180 TGLOSS items over 10 models, plus
  608 extended warranty prices.
- **CTDMS orders:** 265 open orders (Booked/Accepted) load across Jaipur, Dausa and Kotputli, with
  6 TLs and 30 SOs. 37 of them use suffixes that aren't on the current price lists (old Leader Edition,
  some Glanza and Crysta codes). They load unpriced.
- **Pricing:** `calculate_price()` now uses the list type (private/commercial/CSD), the list's insurance
  options, FASTag and the 5th-year extended warranty. The mobile quote flow lets the SC pick them.
- **Still pending:** the CSD list (it uses old suffix codes and a GST breakdown) and the Hyryder
  CSD rows.

### Original Phase 6a scope

1. **Migration `20261024000001_branches_codes_pricelist.sql`:**
   - `outlets.ctdms_dealer_code`, with the real branches upserted.
   - `variants.tkm_suffix_code` / `old_suffix_code`, and `colors.tkm_color_code`.
   - The `price_list` columns described in M3: `list_type`, tcs, road tax, the 3 insurance options, fastag, true_warranty_5yr, tgloss.
   - The `ew_prices` table.
   - Accessories `category` / `is_tga` / `sort_order`, plus `vas_products.model_id`.
   - `employees.ctdms_name`.
   - Booking import columns on `bookings`: `ctdms_order_id`, `ctdms_customer_code`, `ctdms_order_status`, `ctdms_order_date`, `received_amount`, `imported_from_ctdms`. `variant_id`/`color_id`/`rto_category_id` become nullable for imported rows whose codes are not yet mapped.
2. **`calculate_price()` update.** It reads the new price_list columns when they're present, with `list_type` + `insurance_option` selections. Without them it falls back to the existing RTO and IDV logic, so current quotes keep working.
3. **One-time seed migration from the shared files**, generated by a parser script in `scripts/`:
   - catalog: models / variants / colours with TKM codes
   - all private / commercial / CSD price lists
   - the EW matrix
   - accessories + TGLOSS for all models
   - the 3 branches, plus 36 employees and the 265 bookings from the PO listings
4. **Re-runnable dashboard importers** under `/admin/import`, so new lists can be uploaded later:
   - PO Order Listing (.xls): upsert on CTDMS Order No; orders whose CTDMS status is no longer Booked/Accepted are flagged.
   - Price list (PDF).
   - Accessories (PDF).
   - Parsers live in `dashboard/src/lib/importers/*` (SheetJS for xls, `pdfjs-dist` for PDF), and every import shows a preview before saving.
5. **Verification.**
   - Spin up Postgres in Docker if it's available. Apply all migrations plus the seed, and run price checks: Hyryder D22U4 private, Premium insurance → on-road ₹23,11,480 per the list.
   - Run dashboard lint and build.

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
- **Stage 1 – Basic:** ex-showroom, TCS, RTO, insurance, **FASTag**, accessories and VAS. This is the existing `calculate_price()` with no scheme IDs.
  - **`price_list` becomes the full dealer list**, one row per variant × list type (`private` / `commercial` / `csd`) × effective date. Dual tone is either its own row or `variant_colors.extra_cost`.
  - **Columns:** `ex_showroom_price`, `tcs`, `road_tax_registration`, `insurance_advance`, `insurance_premium`, `insurance_premium_3plus3`, `fastag`, `true_warranty_5yr`, `tgloss_package`.
  - **`calculate_price()` reads these columns** instead of `rto_pricing` and the IDV formula. The SC picks the list type (from the registration type: White board = private, Yellow board = commercial, or CSD) and the insurance option (Advance / Premium / 3+3).
  - **Fallbacks stay.** `tax_config` still drives TCS when the list leaves it blank, and the 5% rate under Section 206CCA becomes a per-customer flag. `rto_pricing` and the insurance tables stay as fallbacks.
  - **Extended warranty.** A `ew_prices` table (model group × age band × product × km) holds the T-Secure matrix. At sale the age band is 0–2 months.
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
- **Accessories master.** Add `category` (Functional / Beautification / Interior / Hygiene / Styling / Utility…), `is_tga`, `effective_from` and `sort_order`. Seed it from the 11 model order forms by part no. + model.
  - **TGLOSS packages and the individual coatings** become model-specific VAS rows. Prices differ by model: e.g. Ceramic Plus is ₹47,453 on Camry and ₹55,203 on LC.
  - **The printable per-model "TGA Accessories Order Form"** is generated from the master with the same layout: selected items, fitment status, and SO / SM / VAS lead sign-off. It is used again at delivery (M9).

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
- **Code mapping.** Stock and enquiry files use TKM codes (e.g. suffix `D22U4`, colour `089`/`WBF`). We add `variants.tkm_suffix_code` (plus `old_suffix_code`) and `colors.tkm_color_code`.
  - Both are **seeded from the "All Model Suffix & Colour Code" sheet**. The model prefix + new suffix makes the full code: FRN + 1L = `FRN1L`, D22 + U4 = `D22U4`.
  - Unmapped codes show up in an import "Fix mapping" list.
- **CTDMS columns we keep.** The physical stock report also carries Key No., Block status (Free / Blocked / Alloted), Order No./Date, Order Status, Amount Received, Finance Company, Likely Delivery and Location. They are stored as `ctdms_*` fields on `vehicles`.
- **Our CRM decides allotment:**
  - Every allot or swap in our CRM adds a row to a **"Block / Unblock in CTDMS" to-do** with a Done button, the same pattern as M2.
  - Each stock upload compares CTDMS block status and order no. with our allotment. Differences go to a **Mismatch** list: blocked in CTDMS but free with us, or blocked for a different order.
  - **First import:** CTDMS Blocked/Alloted cars are proposed as allotments to the matching bookings (by order no.) once the booking dump is loaded.
- **PDF parsing.** The CTDMS PDFs are fixed-layout. The parser uses `pdftotext -layout`-style text extraction via `pdfjs-dist` in a server action:
  - It anchors each row on the VIN pattern (17 chars, optional `~MMYY` suffix) and splits multi-line model names such as "URBAN CRUISER / HYRYDER".
  - It's tested against both shared files: 31 transit and 173 physical vehicles.
  - The Excel export is still preferred if CTDMS offers it.
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
| 6a | **Master data load from shared files.** Dashboard importers that the back office can re-run when TKM revises lists: models/variants/colours from the Suffix & Colour Code sheet, price lists (Private / Commercial / CSD, all models), EW matrix, TGA accessories + TGLOSS for 11 models | price_list + `ew_prices` migrations, `dashboard/src/app/(app)/admin/price-list/import/*` (extend), new `admin/accessories/import`, `dashboard/src/lib/pdf-table.ts` |
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
- Employee data and the booking dump are coming next. They will seed `employees` (with `ctdms_sales_officer_name`) and the open bookings, and those bookings get linked to the 21 CTDMS-blocked/allotted cars.
- Price list PDFs vary slightly per model (merged cells, dual-tone rows). Each import shows a preview to confirm before saving, and any rows it can't parse are listed for manual entry.
- Can CTDMS export the Stock Statement as Excel? That would avoid PDF parsing.
- The amount threshold where Outlet Head approval hands over to Business Head for dealer discount. This is master data, settable in Approval Rules.
- The real IDV depreciation slabs. The current ones are placeholders, per the comment in `20260917000006_insurance.sql`.
