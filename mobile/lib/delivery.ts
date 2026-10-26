import { supabase } from "@/lib/supabase";
import { uploadBookingFile } from "@/lib/docket";

// Delivery (20261031000001_payments_delivery.sql): the consultant fills the checklist, takes the
// handover photo and the customer's signature; complete_delivery() checks everything else (invoice,
// insurance, registration, money) before the booking becomes delivered.

export const DELIVERY_CHECKS = [
  { key: "pdi_done", label: "PDI done" },
  { key: "accessories_fitted", label: "Accessories fitted and checked against the order" },
  { key: "fastag_fitted", label: "FASTag fitted" },
  { key: "documents_explained", label: "Documents explained" },
  { key: "demo_done", label: "Vehicle demo done" },
] as const;
export type DeliveryCheck = (typeof DELIVERY_CHECKS)[number]["key"];

export type Delivery = Record<DeliveryCheck, boolean> & {
  status: "draft" | "delivered";
  handover_photo_path: string | null;
  customer_signature_path: string | null;
  delivered_at: string | null;
};

export interface BookingAccount {
  deal_amount: number;
  cleared: number;
  pending: number;
  outstanding: number;
}

export async function loadDelivery(bookingId: string): Promise<Delivery | null> {
  const { data, error } = await supabase.from("deliveries").select("*").eq("booking_id", bookingId).maybeSingle();
  if (error) throw new Error(error.message);
  return data as Delivery | null;
}

export async function loadBlockers(bookingId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc("delivery_blockers", { p_booking_id: bookingId });
  if (error) throw new Error(error.message);
  return (data ?? []) as string[];
}

export async function loadAccount(bookingId: string): Promise<BookingAccount | null> {
  const { data, error } = await supabase.rpc("booking_account", { p_booking_id: bookingId }).maybeSingle();
  if (error) throw new Error(error.message);
  return data as BookingAccount | null;
}

export async function saveChecklist(bookingId: string, patch: Partial<Record<DeliveryCheck, boolean>> & {
  handover_photo_path?: string;
  customer_signature_path?: string;
}) {
  const { error } = await supabase.rpc("save_delivery_checklist", { p_booking_id: bookingId, p: patch });
  if (error) throw new Error(error.message);
}

export async function saveHandoverPhoto(bookingId: string, localUri: string, mimeType?: string | null) {
  const path = `${bookingId}/delivery/handover-${Date.now()}.jpg`;
  await uploadBookingFile(path, localUri, mimeType || "image/jpeg");
  await saveChecklist(bookingId, { handover_photo_path: path });
}

export async function saveDeliverySignature(bookingId: string, localUri: string) {
  const path = `${bookingId}/delivery/signature-${Date.now()}.png`;
  await uploadBookingFile(path, localUri, "image/png");
  await saveChecklist(bookingId, { customer_signature_path: path });
}

export async function completeDelivery(bookingId: string) {
  const { error } = await supabase.rpc("complete_delivery", { p_booking_id: bookingId, p_override_reason: null });
  if (error) throw new Error(error.message);
}
