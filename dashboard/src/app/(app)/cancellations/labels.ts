export const CANCEL_REASONS = [
  { id: "finance_not_approved", name: "Finance not approved" },
  { id: "bought_elsewhere", name: "Bought elsewhere" },
  { id: "delivery_delay", name: "Delivery delay" },
  { id: "price", name: "Price" },
  { id: "changed_mind", name: "Changed mind / model" },
  { id: "personal", name: "Personal reasons" },
  { id: "other", name: "Other" },
];

export const cancelReasonLabel = (id: string) => CANCEL_REASONS.find((r) => r.id === id)?.name ?? id;

export const EVENT_LABELS: Record<string, string> = {
  hold: "Put on hold",
  resume: "Resumed",
  cancel_requested: "Cancellation requested",
  cancel_approved: "Cancellation approved",
  cancel_rejected: "Cancellation rejected",
};
