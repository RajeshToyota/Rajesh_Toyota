# Rajesh Toyota — Techwheels module parity, round 2 (Phases 23–33)

> **Status:** being built phase by phase; see the "Phases 23–33" section of `docs/ROADMAP.md`. Nothing from this round is on the live project yet.

## Context
The user wants the listed Techwheels (TW) modules in Rajesh Toyota (RT) with **the same business logic** (not the same code): Access Studio, Payroll, the car/pricing masters, Quotes, Booking Docs / Cancelled / Refunds, stock & inventory, the allotment pool, Yard & Form 22, PDI & Delivery, Finance (Banks, Cases, Claims & Payouts), the 10 Ops Billing screens, Used Cars and Reception.

RT already has a first pass at most of these: Phases 17–22 are on live Supabase and the `web/` Vite app is built but not deployed. A module-by-module comparison of TW's tables, RPCs and pages against RT shows each RT module has the core state machine. RT is missing TW's deeper rules, which this plan adds as gap phases. Where RT is already stronger, it keeps its version:
- staged quote approvals;
- the automatic refund engine (financier vs customer, 7 working days);
- the PDI checklist and gate pass.

Decisions taken (answered by user):
- **Finance:** TW multi-bank model. Several financier cases per booking, a final HPN financier, and RT's document/amount gates on each case's forward moves.
- **Payroll:** full TW payroll (attendance, advances, ledger, locks, slips, bank export). It pulls incentive lines from RT's existing engine, which gets TW's rule types. Incentives keep crediting on invoice date.
- **Reception:** kiosk with tokens, plus the CTDMS-enquiry-number queue (the green-form analogue). No IVR.
- **Used cars:** deal flow, inspection, documents and outside-car procurement only. No valuation engine, no public page.

## Conventions (same as Phases 17–22, see `docs/TECHWHEELS_PARITY_PLAN.md`)
Each phase consists of:
- one migration `supabase/migrations/202611DD0000NN_<name>.sql`;
- a SQL test `supabase/tests/<name>.sql`, added to `scripts/localdb/test.sh`;
- pages in `web/src/pages/<area>/*.tsx`, registered in `web/src/App.tsx`, with a row in `app_modules` plus `role_module_rights` seeds, gated by `has_right()`;
- a roadmap row in `docs/ROADMAP.md`.

Rules that apply throughout:
- Status changes go only through SECURITY DEFINER RPCs with `search_path` pinned (as in `20261118000007_search_path_hardening.sql`).
- New behaviour that changes existing flows ships behind an `ops_config` / feature flag, off by default.
- Re-key TW's Tata identifiers for Toyota:
  - Tata VC → model + suffix + colour (`variants.tkm_suffix_code`, `colors.tkm_color_code`);
  - Tata opty / SO → CTDMS enquiry / order no.;
  - Sitapura yard → the outlet's workshop yard.
- Work happens in `/home/user/Rajesh_Toyota` on branch `claude/techwheels-modules-integration-2h9gmi`, one commit per phase. TW is read-only reference.

---

## Phase 23 — Access Studio depth (RBAC)
TW reference: `has_rbac_right`, `visibility_core_pass`, `employee_assignments`, the `rbac/*` pages, `reporting_hierarchy_reassign_manager`.

Extend `20261118000001_permissions_menu.sql` objects:
- **Masters:** `departments` table (seeded from today's `employees.department` CHECK values) and `roles.department_id`.
- **Multiple roles:** `employee_role_assignments` (employee, role, outlet or `is_global`).
  - `has_right()` checks, in order: admin → revoke → grant → any assigned role → primary role.
  - Active, onboarded staff must keep at least one role.
- **Rights:** an `ALL` right wildcard.
- **View baseline:** create and approve do not require view; ticking any other right auto-adds view (enforced in `set_role_right`).
- **Per-module visibility flags** on `app_modules`: `hierarchy_scope` (`all` | `limited` + department list) and `own_only`. A helper `can_see_employee_record(module, target_employee)` combines rights with RT's rank, team and outlet helpers (Sales Consultant → own records; TL → team; Outlet Head → outlet).
- **Reporting hierarchy:**
  - `reporting_hierarchy_history` (effective_from/to, reason, changed_by) with a trigger on `employees.reports_to_employee_id`;
  - RPC `reassign_manager(emp, mgr, reason)` with a cycle check and visibility check;
  - monthly snapshot RPC, used by payroll and TL incentives.
- **Financier scope** for finance executives (`employee_financier_scope`), used in Phase 29.
- **Who can manage access** becomes the right `admin.access` edit, replacing the rank ≤ 1 check.
- **Web:**
  - extend `web/src/pages/admin/AccessStudio.tsx` with a roles-with-scope editor, the matrix showing base/override/effective, and a per-employee module add;
  - new pages `/admin/departments`, `/admin/reporting-hierarchy`;
  - an admin "preview as employee" toggle in `AdminPanel.tsx`.
- **Tests:** multi-role grant, revoke beats role, `limited` scope, hierarchy cycle rejected.

## Phase 24 — Catalog & pricing masters
TW reference: `ManageVariants`, `ManageCarColours`, `ManageVariantContent`, `ManageAccessories`, `ManageInsurance` (+ `src/lib/pricing/insurance.js`), `ManageRto` (+ `rto.js`), `ManageExtendedWarranty`, `ManageCeramicCoating`, `ManageSchemes` (+ `schemeShared.js`, `save_variant_scheme_revision`), `ManageDiscountRulesVariant`, `src/utils/marginCap.js`.

The TKM price list (`price_list`) stays the authority for ex-showroom, road tax and insurance options. TW formulas are added as fallbacks and rules.

**Cars / variants / colours**
- Add `gst_rate`, `mv_tax_rate`, `engine_cc` and `hsn_code` to `variants`.
- New `model_colour_photos` (model, fuel, colour, image, sort).
- New `variant_content` (features jsonb plus up to 7 colour-tagged images), using a storage bucket `catalog-media`.
- Pages `/masters/cars`, `/masters/colours`, `/masters/variants`, `/masters/variant-content`. These become dedicated pages instead of the generic `[entity]` page, which stays for the simple masters.

**Accessories**
- Add `is_universal`, `excluded_model_ids[]` (only allowed when universal), `is_top`/`top_order`, `is_pack`, `variant_group`, `warranty_years`, `features`.
- The quote accessory picker filters by these.

**Insurance (TW premium engine)**
- New tables:
  - `insurance_tp_types`, plus `variant_tp_type`;
  - `insurance_rates` per variant × provider: IDV (default ex-showroom × 0.95), OD, TP, other charges;
  - `insurance_od_discounts` (four options, each enabled or not);
  - `insurance_addon_rates` (provider × addon × tp_type → % of IDV);
  - `insurance_other_charges` per tp_type.
- New SQL function `insurance_premium(variant, provider, addons)`:
  - netOD = OD × (1 − max enabled discount %);
  - taxable = netOD + TP + other charges + add-ons;
  - premium = taxable + GST, rounded;
  - zero-dep and consumables are mandatory add-ons.
- New `insurance_quotes(variant)` returns the comparison across providers, with the cheapest provider as default.
- `calculate_price` uses it when the price list's `insurance_options` is empty or the user picks a provider.

**RTO**
- Built on main's `20261118000009` (per-list `rto_settings` fixed charges, the price-list row's MV tax rate, green tax and extra charges, `rto_normal`). Phase 24 adds `rto_settings.bh_processing_fee`.
- New `rto_calc(variant, ex, type NORMAL|BH|TRANSFER|SCRAP, list)`:
  - NORMAL = `rto_normal`;
  - BH = (ex / (1 + gst)) × rate / 6, plus the fixed charges, green tax and the BH fee;
  - SCRAP = normal less the rebate (26 % of tax + surcharge, capped);
  - TRANSFER = flat amount.
- `calculate_price` keeps main's Normal path (formula, then the printed figure, then `rto_pricing`) and uses `rto_calc` for BH, Scrap and Transfer.

**Extended warranty, ceramic coating, schemes, coupon cap**
- Extended warranty: keep `ew_prices` and add a per-variant year-1/2/3 view for quoting.
- Ceramic coating: new `ceramic_coating_prices` (model, price), and a `ceramic` selection in `calculate_price` and on quotes.
- Schemes:
  - `scheme_master` categories (upfront / corporate / exchange / scrappage / loyalty / additional), plus `has_company_share`;
  - current vs previous model-year amounts on `scheme_line_items`;
  - RPC `save_scheme_revision(start_date, …)`: the end date comes from the next revision, the row covering the start date is split, overlaps are forbidden, and history is kept;
  - a bulk CSV import with preview;
  - selection rules in `calculate_price`: upfront always; at most one corporate; exchange XOR scrappage; one loyalty.
- Variant coupon cap:
  - new `discount_rules_variant` (variant, `coupon_cap` default 10000, `mr_discount`, `mr_approved_by`) with CSV import;
  - margin floor: dealer discount + MR + additional ≤ max(0, ex − dealer cost) + TKM share − schemes − 5000;
  - the floor is enforced in `submit_quote_stage`; breaching it routes to Business Head approval, as RT's approval rules already do.

**Tests:** insurance premium against a worked example; scheme revision split and no overlap; coupon cap and margin floor; RTO BH formula.

## Phase 25 — Quotes workbench
TW reference: `ManageQuotes.jsx`, `QuoteDetails.jsx`, `CreateAdminQuote.jsx`, `quote_is_billed`/`can_edit_quote`, `expand_booking_to_fleet`.

RT keeps its staged approvals (`20261027000001_staged_quotes.sql`).

**Database**
- Add to `quotes`: `quantity` (fleet), `source` (mobile | web), coupon, ceramic, EW years, `model_year`, `preferred_financier_id`, `exchange_interest`.
- `can_edit_quote(id)`: a quote is locked once its booking is invoiced (`billing_requests` invoiced); after that only the admin can edit.
- `expand_booking_to_fleet(booking, n)`: a `booking_group_id`, with the amount split per unit.

**Web** — `/quotes`, with tabs:
- Create: a web quote builder calling the same `calculate_price` / `submit_quote_stage` RPCs as mobile.
- Approve: pending stage approvals, using `decide_approval`.
- Proceed: final quotes with no booking go to booking.
- Bookings: WhatsApp booking message, and create the remaining fleet bookings.

Also a quote detail and edit page, and a printable PDF reusing `20260917000017_quote_pdf_storage`.

## Phase 26 — Booking Docs, Cancelled Customers, Refunds, Hold
TW reference: `BookingDocsAdminPage.jsx`, `src/lib/rmDocumentGroups.js`, `booking_documents`, `revive_cancelled_booking_v1`, `booking_refund_requests`, `excess_refund_requests`, `HoldCustomersPage`.

**Booking docs**
- New `booking_documents` (booking, doc_type, storage_path, status pending/approved/rejected, rejection_reason, reviewed_by/at, provided_by), in the existing bucket `booking-documents`.
- The doc_type catalogue covers KYC, finance, RTO, delivery and scheme documents:
  - finance: salary slip … DO;
  - RTO: Form 20/21/22, CNG form, parking affidavit, Form 60, RTO receipt, BH set;
  - delivery and billing: invoice PDF, accessories bill;
  - scheme proofs.
- Existing `docket_documents` and `finance_documents` are mapped in through a view, so nothing is migrated destructively.
- `required_doc_groups(booking)` reproduces TW's rules:
  - PAN, plus address proof (any 2 of the listed types);
  - GST for corporate customers or a GSTIN;
  - exchange RC + insurance;
  - finance by occupation (Out-house = DO only);
  - BH documents;
  - scheme-driven groups (MSME, loyalty relation proof, self scrappage).
- Review RPCs: approve, reject (reason required), and auto-approve staff uploads. `remove_booking_document` writes an audit row.
- Multi-image → PDF merge client-side with jspdf.
- Page `/booking-docs`.

**Cancelled customers**
- `cancellation_done_at/by` with New/Done tabs.
- `revive_booking(booking, reason, target active|hold)`:
  - undoes the cancel and reopens the hold or the booking;
  - restores the finance case status;
  - marks the pool dirty;
  - is refused if the refund is paid.
- Page `/cancelled-customers`, extending `web/src/pages/staff/cancellations`.

**Refunds**
- Keep the automatic engine. Add to `refunds`:
  - customer bank details: holder, account (`^[0-9]{6,20}$`), IFSC (`^[A-Z]{4}0[A-Z0-9]{6}$`), cancelled-cheque upload;
  - payment by UTR/NEFT as well as cheque;
  - a manual amount override with reason;
  - a "no refund" option (Outlet Head approve).
- Bank details are visible only with `refunds` view.
- New `excess_refunds`: several per booking, raised when receipts exceed the deal amount.
- Page `/refunds` with tabs Cancellation | Excess.

**Hold**
- `booking_holds` gets an append-only remark history.
- The hold list shows free cars for the same variant + colour and for other colours.
- Bulk hold import/export (xlsx).

**Tests:** document group rules per profile; revive restores status; excess refund validation.

## Phase 27 — Stock & inventory, Yard & Form 22
TW reference: `stock_control` ADD/DEDUCT, `sync_free_stock_live`, `ManageStockTransfers`, `ImportTransitFile`, `ChassisMonitorPage`, `SearchConsole`, `ProjectedPlanning.jsx`, `ExcessBackOrder.jsx`, `ManageVehicleLocation.jsx`.

**Stock control**
- Turn `stock_controls` into a ledger with state ADD | DEDUCT | NA.
- Reasons: cancelled_billing, demo_in_use, demo_on_sale, management_hold, management_release, damage, stna, other.
- Each entry carries effective_from/to.
- The free-stock rule: report status in transit/physical, or an active ADD; excluded by an active DEDUCT or an outward transfer. This replaces `vehicles` availability checks in `pool_free_count` and match.

**Dealer transfers** (alongside RT's branch transfers)
- New `other_dealers` (name, codes, up to 5 emails).
- `stock_transfers.direction` inward | outward, plus `transfer_order_no`, `ctdms_order_no` and the statuses requested → approved → dispatched/received → ctdms_done.
- An inward transfer creates a `vehicles` row (source `dealer_transfer`). If tied to a booking, it is bound to that booking before the pool recomputes. An outward transfer removes the car from free stock.
- An inward lifecycle report (billed_on, delivered_on).

**Transit, archive, monitoring, search**
- Transit logistics: `vehicle_transit_details` (VIN, TKM invoice, trailer, transporter, location, ETA), imported from the dispatch file (xls parser in `web/src/lib/xls.ts`).
- Delivered archive and batch validation for `import_stock_statement`: a staged batch, rejected whole if any row is invalid; delivered cars move to `vehicles_delivered`.
- Chassis monitor `/stock/monitor` shows:
  - ready-for-billing and billed counts;
  - outward-transferred cars still in the report (a mismatch);
  - ADD/DEDUCT counts by reason.
- Search console gets modes (mobile | VIN | variant | CTDMS no.). The timeline merges pool audit, stage reversals, stock controls, transfers and yard moves.

**Other dealers, planning, plant stock**
- Other dealers × VNA adds nearby-variant matching (same model, other suffix) and an alternate-colour split. Dealer stock is mapped back to the bookings it could serve.
- Stock planning `/stock/planning`, re-keyed per variant + colour:
  - weighted 90-day sales (0.5 / 0.3 / 0.2);
  - need = max(sales average, VNA);
  - order = max(0, need − (free + open orders));
  - status ORDER NOW / MONITOR / COVERED;
  - excess = open orders − max(VNA, projected);
  - an `open_orders` table entered or imported from CTDMS orders. No Tata e-mail.
- Plant stock: an optional xlsx import of TKM plant availability.

**Yard & Form 22** (extends `yards` / `vehicle_movements`)
- `yards.capacity`, plus a per-outlet "Delivered" yard and "Workshop / rework" yard.
- Add to `vehicle_movements`: `movement_type` inward/relocate/outward/delivered, driver, paper_check, vehicle_out_date and the PDI job-card no.
- A trigger moves the car to the Delivered yard when `deliveries` completes.
- Per-VIN documents: Form 22 and CNG form (CNG when the fuel is CNG), with a pending report excluding delivered cars.
- Battery-change cases: allotted, unbilled cars with a TKM invoice at least 90 days old. Status pending → approval_mail_sent → approval_received.
- Job-card open/close tracking with ageing.
- "Receive from transit" moves the car to physical and logs an inward movement.
- `/stock/yard` gets tabs: Overview (count against capacity), Transit, No location, Allotted without location, Battery change, JC, Form 22/CNG, All moves.

**Tests:** ADD makes an unreported car free and DEDUCT removes it; inward transfer binding beats the pool; the battery rule at 90 days; the delivered auto-move.

## Phase 28 — Allotment pool extras
TW reference: `sap_vc_cross_match_pairs`, `NextInLinePanel`, `sap_finance_queue_avg_clear_time`, `sap_matched_stock_revert_do`, WhatsApp send logs.

Changes to `20261113000001_stock_allotment_pool.sql` logic:
- **Cross-match pairs.**
  - New `pool_cross_match_pairs` (base variant, upgraded variant, `adjustment_amount`, label); a variant can be in only one active pair.
  - `pool_recompute` does exact matches first, then gives leftover cars to the paired variant's waiting winners in completion order. The free count is pair-aware.
  - The allotment stores the allotted variant, the kind (upgrade/downgrade) and a ± adjustment. A trigger mirrors this as a deal line on the booking, net zero against ex-showroom, and reverses it on release. Billed bookings are never touched.
  - Panel plus badge.
- **Next in line.**
  - `pool_config.next_in_line_size` (default 3).
  - RPCs list the variant + colour combinations with zero free cars and their first N customers (finance status, consultant, TL).
  - Hold action.
- **Average clear time:** average and median hours from pool join to allotment, over a chosen window.
- **DO revert:** un-verifying the DO frees the car, returns the member to active and recomputes the pool.
- **Revert from billing:** a car can go back to the pool or to allotted, before invoicing only.
- **Message log:** a `whatsapp_send_log` table (context, booking, payload hash, slot). It drives the "already sent" and "slot changed since sent" chips on Finance Queue, VNA, Allotted and Delivery.
- **Confidential stock:** a `manual_only` variant flag keeps those cars out of the pool and out of public lists.

**Tests:** cross-match allot and reverse; next-in-line ordering; DO revert recompute.

## Phase 29 — Finance: Banks, Finance Cases, Claims & Payouts
TW reference: `bank_master`, `booking_finance_cases`, `finance_set_case_verified`, `20261112161000_finance_claims_payouts.sql`, `FinancePayoutPage`, `ManageBankEmiRates`.

**Banks** (extend `financiers`)
- Contacts, payout portal link and username. The password goes in a Supabase Vault secret, not a column.
- Payout rates: `bank_payout_rate`, `ca_payout_rate`, `addon_payout_rate`, each with a basis of percent of DO or per file.
- Target and target period, `gst_included`, `invoice_by_branch`, `letter_format`.
- New `financier_branches`.
- EMI masters `financier_emi_terms` and `financier_rate_slabs` (CIBIL band, ROI, tenure and LTV caps, no overlapping bands). `finance_emi()` uses them.
- Round-robin auto-assign pool for finance executives, plus financier scope from Phase 23.
- Page `/finance/banks`.

**Finance cases (multi-bank)**
- Drop `uq_finance_cases_active`; at most one case per booking + financier.
- Statuses: docs_pending, logged_in, credit_review, sanctioned, do_received, disbursed, rejected, on_hold.
- Forward moves keep RT's gates (docs before login, amounts before sanction, DO fields before do_received). Backward and on_hold moves are allowed, with a reason, as in TW.
- `bookings.final_financier_id` (the HPN) is set when a case reaches do_received. The pool's `pool_booking_completion` reads the final or any do_received case.
- `disbursement_month`, `net_disbursement_amount`, `loan_account_no`.
- **Verified lock:** `set_case_verified` needs the disbursed amount, month, financier and DO. Unverifying needs `finance.cases` approve. A trigger freezes those fields; changes go to `finance_case_verification_log`.
- Page `/finance/cases`, with filters (month, branch, type, executive, financier, verified) and bulk verify.

**Claims & Payouts**
- `finance_claims_summary(month)` takes verified, disbursed cases, grouped by financier, then branch (or all branches).
- DO = coalesce(net disbursement, DO amount, loan amount).
- Each payout = percent ? total DO × rate / 100 : files × rate.
- The add-on is paid only if the month's DO total ≥ target.
- Expected invoice = payout (if GST is included) or payout × 1.18, with the taxable value and GST split.
- New `bank_claims`, one row per month + financier + branch. Steps: generated → invoice set (no., date, amount) → bank UTR received → CA/add-on UTR received. Undo needs the approve right.
- The claim letter prints in the financier's `letter_format` (jspdf templates).
- **Salesperson finance payout:** 0.5 % of DO (configurable) to the consultant, released only after the bank UTR for that month/financier/branch is recorded. One row per case. This feeds payroll (Phase 31).
- RT's existing `bank_payouts` (per-case CA invoice) is kept for out-house/DSA flagging and documented as separate.
- Page `/finance/claims-payouts`.

**Tests:** multi-case, then the final HPN feeds the pool; the verified lock blocks edits; the claim formula for both percent and per-file rates and the target gate.

## Phase 30 — Ops Billing (10 screens)
TW reference: `src/components/ops/*`, `ops_billing_update_booking`, `ops_billing_payment_receipts`, `booking_stage_reversal_request`, `OpsBillingGatePassPage`, `RtoReconciliationPage`, `BookingCrmUpdate.jsx`.

RT keeps `booking_ops_stages`, deriving stages from source tables (`20261118000002_ops_billing_pdi_delivery.sql`). The single `/ops-billing` board is split into one page per stage, `web/src/pages/ops/billing/<Stage>.tsx`, sharing a table component modelled on `OpsBillingTable.jsx`:
- **Accounts:**
  - deal breakdown, receipts by mode, DO amount, exchange buy-in amount;
  - discount round-off, checked against the Phase 24 margin floor;
  - "Send for CRM billing" (the existing `send_for_billing`).
- **CRM Billing:**
  - invoice no., date, amount and PDF;
  - VIN forced to the allotted vehicle (stale VIN rejected and logged);
  - a CTDMS order-update tracker (bookings missing the CTDMS order no. or date), with a lag KPI.
- **Insurance:**
  - rework SELF / ADD_ONS with amount, remarks and requested/resolved by;
  - `revised_insurance_amount` (approved by Accounts; 0 = self-insured) feeds the deal and the due amount.
- **RTO:**
  - type NORMAL/BH/TRANSFER, special number and amount, receipt upload, normalised registration number (in `rto_registrations`);
  - RTO register reconciliation upload (match on registration/VIN plus name);
  - an in-house RTO payout-expected report from Phase 29 rates.
- **Accessories:**
  - rework REDUCE / ADD_ONS with a revised amount;
  - per-item fitment checklist (`accessory_fitments`);
  - post-delivery accessories;
  - counter sales to non-booking customers (`counter_accessory_sales`).
- **Schemes:** per-scheme-line claim proof uploads (deduplicated, campaign lines excluded), MSME certificate, a "collected" list, then done.
- **Scrap:** `scrap_suppliers` master, COD no., scrap date and price, and a certificate discount ≥ 0 capped at the quoted fee (audited).
- **Gate Pass:**
  - views In process / Queue / Delivered;
  - due = final amount − DO − non-DO cleared receipts;
  - gate-pass PDF and No-Dues PDF;
  - mark delivered;
  - **revert delivered** with a reason (`delivery_reversals`), which restores the yard location and keeps the slot.
- **Stage Status:** a matrix of every stage per booking, with filters.
- **Payment Receipts:**
  - generated `receipt_no` per outlet/FY;
  - due before/after snapshots;
  - an accounting-entry flag;
  - soft cancel/delete and transfer between bookings, each through `payment_receipt_events`;
  - refused on cancelled bookings;
  - a public QR verify page `/verify/receipt/:no`, served by a Supabase edge function `receipt-verify` that returns only no., date, amount and status.

Also in this phase:
- **Reversal widening:** a request can name the documents to clear and can reopen billing. Reopening billing means an invoice cancellation: it resets accounts and billing and is refused after gate exit.
- **Cancel from billing** with customer intent, linking to Phase 26 cancel and revive.

**Tests:** revised insurance changes the due amount; receipt transfer events; scrap discount cap; reopen-billing reversal; revert delivered.

## Phase 31 — PDI & Delivery
TW reference: `20261007100000_pdi_board_flow_v2.sql`, `20261015150000_pdi_scheduler.sql`, `delivery_branch` / `delivery_slot_booking`, `rm_schedule_delivery_slot`, `ReadinessChip`, `BulkDeliveryWhatsappDialog`.

**PDI flow**
- A derived `pdi_stage(booking)`: no_vehicle → pdi_pending → to_rework (failed: move to the workshop yard, re-inspect) → to_move (passed: move to the delivery outlet's yard) → to_wash → ready.
- The stage comes from the latest yard movement (Phase 27).
- `pdi_mark_at_location`, `pdi_mark_washed`. Keep RT's checklist and photos; add the photo bucket `pdi-photos` (still open in the roadmap).
- **PDI scheduler:** a time window inside the outlet's working hours (`outlet_hours`), reschedule, one scheduled PDI per booking, and roles PDI manager/executive.

**Delivery**
- **Bays and grid:**
  - `delivery_bays` per outlet, with day start/end and `slot_minutes` (default 20);
  - a slot must sit on the grid boundary and inside outlet hours;
  - bay auto-picked or chosen, with sharing up to 3 per bay;
  - back-dated slots allowed, to record actual deliveries.
  - This replaces `ops_config.slot_times` capacity; existing slots are migrated to bay 1.
- **Day board:** a bay × time grid, readiness chip (stages done or "N left"), bulk WhatsApp deep links logged in `whatsapp_send_log` with a "slot changed since sent" warning.
- **Counts:** delivered FTD/MTD/LTD.
- **Mobile:** PDI checklist screen and "My deliveries" in `mobile/app/(app)/`. This phase closes the roadmap's mobile gap for these modules.

## Phase 32 — Payroll
TW reference: `src/components/payroll/*` (AttendanceRegister, AdvanceManagement, SalaryTypeAssignment, PayrollProcessing, SalarySlipReport, IncentiveRuleEngine).

**Salary**
- Extend `employee_salary` with bank account, IFSC and `payment_type` NEFT|DCR.
- The salary type maps to TW's inclusion split: base / variable / both / base_finance (existing fixed and fixed_incentive map onto these).

**Attendance and advances**
- Attendance: `payroll_attendance` (month = first of month, present days, leave days in 0.5 steps).
- Paid leave allowance: 4 days, configurable in `payroll_config`.
- Leave deduction = base / days in month × max(0, leave − 4), only when the type includes base.
- Advances: `payroll_advances` (total, recovered, balance, type lump/emi/custom, status open/partial/closed) and `payroll_advance_deductions` (month, amount, applied).
- The schedule builder: EMI = round(total / n) with the remainder on the last instalment; custom amounts must add up to the total.

**Incentive rule types** (added to RT's engine in `20261118000004_targets_incentives.sql` as new rule kinds on `incentive_schemes`)
- per-car registration flat, with an EV-share slab bonus;
- minimum-cars gate;
- VIN flat;
- dealer model bonus by model + fuel;
- margin-adjusted bonus: min(bonus, max(0, bonus + min(0, margin))), with margin from the Phase 24 margin calculation;
- 0.5× factor for cars received by transfer;
- in-house finance flat;
- DO % finance payout (from Phase 29);
- used-car slab per count;
- accessories % after GST above a per-car threshold;
- above-target slab.

All count on invoice date (decision). Targets gain booking, retail, accessories, finance and used-car targets per outlet.

**Payroll run**
- `payroll_entries` (month × employee): base, the components pulled from the approved incentive run lines, finance payout, used car, accessories, advance deduction and leave deduction.
- Gross and net payable are generated columns.
- Per-category locks. Unlocking needs the `payroll` approve right, not a hard-coded code.
- Overrides need a reason.
- "Lock & finalize" applies advance deductions, capped at earnings, and carries any shortfall into the next instalment.

**Output and pages**
- Salary slips (per employee and consolidated, jspdf) and the NEFT/DCR bank export (xlsx) per payout type.
- Page `/payroll` with tabs Salary types, Attendance, Advances, Rules, Processing, Slips.

**Tests:** leave deduction; EMI schedule remainder; advance cap and carry-over; margin-adjusted bonus; lock blocks recompute.

## Phase 33 — Used cars & Reception
**Used cars** — TW reference: `20261116120000_used_car_deal_flow.sql`, `20261116230000` inspection, `20261118120000` stock documents, `outside_car_leads`, `ExchangeBusinessPage`.
- Sources: enquiry, walk-in, quote, booking, outside. Add "enable exchange" back-fill on quotes and bookings.
- **Deal status** separate from stock status: pending → offered → negotiating → deal_done / no_deal.
  - Offer and asking prices, each ≥ 0; "communicated" needs an offer.
  - Mark no-deal with a reason.
  - Reopen, refused if the registration is active elsewhere.
- **Office-set refurbishment** (required, estimate, work done), set by the office and not the evaluator.
- **Structured inspection:**
  - `used_car_photos`: checklist 1–18 with a finding none/suspected/confirmed, interior 1–4, damage 1–8;
  - 8 red flags;
  - accidental = any finding or flag, unless overridden with a reason;
  - drafts;
  - bucket `used-car-photos`.
- **Stock documents:** 9 slots (Form 29/30/35, NOC, RTO mail, challan, Aadhaar front/back, PAN); Form 35, NOC and challan can be N/A; stock-in is never blocked by documents.
- **Stock in/out:** stock-in only after deal_done, date not in the future. Stock-out needs a B2B/B2C sale type, buyer and amount. Reverting either needs `used_cars` approve.
- Profit = sale − purchase − refurbishment.
- **Outside-car procurement leads:** lead source and expected price; not_evaluated → evaluated → under_negotiation → purchase_approved → purchased / lost (reason enum). Stock-in only after approval.
- Keep RT's `procure_used_car` exchange receipt and the U Trust flag.
- Pages: Exchange Business tabs (Walk-in, Quote, Booking, Outside, Enable exchange), Evaluations, Negotiation, Stock.

**Reception** — TW reference: `src/pages/Kiosk/*`, `reception_kiosk_create_walkin`, `reception_kiosk_detect_returning_customer`, `GreenFormQueue.jsx`, `greenform_closure_requests`.
- **Kiosk** `/kiosk` (tablet, receptionist login, full-screen):
  - steps: Welcome → mobile/name → repeat-customer screen (visit count, last consultant, pre-filled model) → model → fuel → exchange? → consultant (by outlet) → finance required? → financier → token;
  - auto-reset after the token is shown;
  - `kiosk_create_walkin` issues token 'T' + 3 digits per outlet per day.
- **Walk-in qualifiers** on `showroom_walkins`: fuel types, an exchange flag (auto-creates a used-car evaluation request), finance required + financier (a CHECK ties them), and a model segment.
- **CTDMS enquiry-number queue** `/reception/ctdms-queue`:
  - each converted walk-in waits until its CTDMS enquiry no. is entered (`submit_ctdms_enquiry_no`, approve right);
  - closure requests with reasons (not_interested, bought_elsewhere, price_issue, unreachable, duplicate, other);
  - ties into the existing CTDMS sync (`20261026000001_ctdms_sync.sql`) to auto-fill the number when the daily enquiry report arrives.
- **Follow-up fields** for walk-ins that left without converting.
- Team walk-in report by TL → consultant → model, plus the CTDMS-number compliance rate.

---

## Critical RT files
- `supabase/migrations/20261118000001_permissions_menu.sql`: `has_right`, `app_modules`.
- `supabase/migrations/20260917000016_pricing_engine.sql` and `20261027000001_staged_quotes.sql`: the latest `calculate_price` and `submit_quote_stage`.
- `supabase/migrations/20261113000001_stock_allotment_pool.sql` and `20261118000005_stock_extras.sql`: `pool_recompute`, `pool_free_count`, `stock_controls`, `yards`.
- `supabase/migrations/20261030000001_finance_cases.sql`: `move_finance_case`, `uq_finance_cases_active`.
- `supabase/migrations/20261118000002_ops_billing_pdi_delivery.sql` and `20261031000001_payments_delivery.sql`: stages, gate pass, slots, `delivery_blockers`, `payment_receipts`.
- `supabase/migrations/20261101000001_hold_cancel.sql`: refunds, cancellations.
- `supabase/migrations/20261118000004_targets_incentives.sql` and `000008_employee_salary.sql`: the incentive engine and salary.
- `supabase/migrations/20261118000006_exchange_used_cars.sql` and `000003_rm_leads_reception_test_drive.sql`.
- Web: `web/src/App.tsx`, `web/src/pages/AdminPanel.tsx`, `web/src/lib/{xls,entities}.ts`, and the existing pages under `web/src/pages/{ops,stockx,used,crm,admin,incentives}`.
- Docs: `docs/ROADMAP.md`, `docs/TECHWHEELS_PARITY_PLAN.md` (add Phases 23–33), `README.md` (test list).

## Verification
1. For each phase, `scripts/localdb/test.sh` rebuilds the scratch Postgres from every migration and runs all `supabase/tests/*.sql`. The new tests must cover every gate and formula listed above, and the existing 19 test files must still pass. This covers regressions in the pool, pricing and refunds.
2. `cd web && npm run build && npm run lint`, then the module check, so every new route has an `app_modules` row.
3. Playwright smoke test of every new route as Admin, Outlet Head, Sales Consultant, Accounts, Finance Exec and Receptionist: menu items and rights show and hide correctly.
4. End-to-end walk on seed data:
   1. kiosk walk-in
   2. CTDMS no.
   3. enquiry
   4. web quote with insurance comparison and coupon cap
   5. booking
   6. booking documents approved
   7. two-bank finance → DO, then pool allot (including a cross-match case)
   8. each Ops Billing stage, including an insurance rework and a reversal
   9. PDI fail → rework → pass → move → wash
   10. bay slot
   11. gate pass
   12. delivered, then revert, then delivered
   13. claims & payouts for the month
   14. payroll run with the incentive pulled in
   15. slip
5. Only after sign-off, apply migrations to live Supabase with `apply_migration`, with flags off, and record the live version numbers in the README.
