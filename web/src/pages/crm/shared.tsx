import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { rpcRows } from "@/ui";

export const CHANNELS = [
  { id: "call", name: "Call" },
  { id: "visit", name: "Showroom visit" },
  { id: "whatsapp", name: "WhatsApp" },
  { id: "sms", name: "SMS" },
  { id: "email", name: "Email" },
  { id: "home_visit", name: "Home visit" },
];
export const OUTCOMES = [
  { id: "connected", name: "Connected" },
  { id: "not_reachable", name: "Not reachable" },
  { id: "call_back", name: "Asked to call back" },
  { id: "interested", name: "Interested" },
  { id: "visit_planned", name: "Visit planned" },
  { id: "test_drive_planned", name: "Test drive planned" },
  { id: "quote_sent", name: "Quote sent" },
  { id: "negotiating", name: "Negotiating" },
  { id: "not_interested", name: "Not interested" },
];
export const TEMPS = [
  { id: "HOT", name: "Hot" },
  { id: "WRM", name: "Warm" },
  { id: "CLD", name: "Cold" },
];
export const PURPOSES = [
  { id: "new_purchase", name: "New purchase" },
  { id: "test_drive", name: "Test drive" },
  { id: "exchange", name: "Exchange" },
  { id: "price_enquiry", name: "Price enquiry" },
  { id: "finance_enquiry", name: "Finance enquiry" },
  { id: "delivery", name: "Delivery" },
  { id: "service", name: "Service" },
  { id: "other", name: "Other" },
];

export const label = (list: { id: string; name: string }[], id: string | null | undefined) => list.find((x) => x.id === id)?.name ?? id ?? "—";

// "2026-11-20T10:30" for datetime-local inputs, in the browser's (IST) time.
export const localDateTime = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
export const toIso = (local: string | null) => (local ? new Date(local).toISOString() : null);

export function useModels() {
  return useQuery(async () => must(await supabase.from("models").select("id, name").eq("is_active", true).order("name")) as { id: string; name: string }[], []);
}

export function useConsultants(outletId?: string | null) {
  return useQuery(
    () => rpcRows<{ id: string; name: string; role: string; waiting: number }>("branch_consultants", { p_outlet_id: outletId || null }),
    [outletId],
  );
}
