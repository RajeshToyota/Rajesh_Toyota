// Option lists mirror the CHECK constraints in 20261025000001_customers_enquiries.sql (and the
// mobile app's lib/enquiries.ts). Mode and source keep CTDMS's own wording for the Phase 7 sync.
export const PURPOSE_OPTIONS = [
  { id: "new_purchase", name: "New purchase" },
  { id: "test_drive", name: "Test drive" },
  { id: "exchange", name: "Exchange / upgrade" },
  { id: "price_enquiry", name: "Price enquiry" },
  { id: "finance_enquiry", name: "Finance enquiry" },
  { id: "other", name: "Other" },
];

export const MODE_OPTIONS = [
  "Walk-in",
  "Dealer CAC Call-In",
  "Dealer CAC Call-Out",
  "TKM Digital",
  "Dealer Digital",
  "Cold Call(visit)",
  "UIO Lead (Service)",
  "Other",
].map((m) => ({ id: m, name: m }));

export const SOURCE_OPTIONS = [
  "Referral Existing Customer",
  "Referral Friends/Relatives",
  "Print Advertisement",
  "TKM- Aggregator",
  "Dealer Website",
  "Promotional Mailers/SMS",
  "Other",
].map((s) => ({ id: s, name: s }));

export const TEMPERATURE_OPTIONS = [
  { id: "HOT", name: "Hot" },
  { id: "WRM", name: "Warm" },
  { id: "CLD", name: "Cold" },
];

export const STAGE_OPTIONS = [
  { id: "open", name: "Open" },
  { id: "quoted", name: "Quoted" },
  { id: "booked", name: "Booked" },
  { id: "lost", name: "Lost" },
];

export const CRM_SYNC_OPTIONS = [
  { id: "pending_entry", name: "Not yet in CTDMS" },
  { id: "marked_done", name: "Entered (unverified)" },
  { id: "verified", name: "Verified in CTDMS" },
  { id: "mismatch", name: "Missing in CTDMS" },
];

// Team Leader (rank 4) and above may assign or reassign enquiries within their team; the
// create_enquiry / reassign_enquiry RPCs enforce the same rule.
export const ASSIGN_MAX_RANK = 4;

export function labelFor(options: { id: string; name: string }[], id: string | null | undefined) {
  return options.find((o) => o.id === id)?.name ?? id ?? "—";
}
