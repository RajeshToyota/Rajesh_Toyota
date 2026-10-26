"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Each of these is checked in the database (20261031000001_payments_delivery.sql): receipts by the
// branch's Accounts, insurance and RTO by its back office, delivery by whoever handles the booking.

const str = (fd: FormData, key: string) => {
  const v = (fd.get(key) as string | null)?.trim();
  return v ? v : null;
};
const num = (fd: FormData, key: string) => {
  const v = str(fd, key);
  if (v === null) return null;
  const n = Number(v.replace(/,/g, ""));
  if (!Number.isFinite(n)) throw new Error(`${key.replace(/_/g, " ")} must be a number`);
  return n;
};

async function call(name: string, args: Record<string, unknown>, bookingId: string | null) {
  const supabase = await createClient();
  const { error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  if (bookingId) revalidatePath(`/reports/bookings/${bookingId}`, "layout");
  revalidatePath("/payments");
}

export async function recordPayment(fd: FormData) {
  const bookingId = str(fd, "booking_id");
  await call(
    "record_payment",
    {
      p_booking_id: bookingId,
      p_mode: str(fd, "mode"),
      p_amount: num(fd, "amount"),
      p_received_on: str(fd, "received_on"),
      p_instrument_no: str(fd, "instrument_no"),
      p_bank_name: str(fd, "bank_name"),
      p_notes: str(fd, "notes"),
    },
    bookingId,
  );
}

export async function setClearance(fd: FormData) {
  await call(
    "set_payment_clearance",
    { p_receipt_id: str(fd, "receipt_id"), p_status: str(fd, "status"), p_on: str(fd, "on") },
    str(fd, "booking_id"),
  );
}

function pick(fd: FormData, keys: string[], numbers: string[] = []) {
  const p: Record<string, string | number | boolean> = {};
  for (const k of keys) {
    const v = numbers.includes(k) ? num(fd, k) : str(fd, k);
    if (v !== null) p[k] = v;
  }
  return p;
}

export async function saveInsurance(fd: FormData) {
  const bookingId = str(fd, "booking_id");
  const p = pick(
    fd,
    ["insurance_provider_id", "insurer_name", "policy_no", "coverage", "premium", "idv", "start_date", "end_date", "policy_storage_path"],
    ["premium", "idv"],
  );
  const inHouse = str(fd, "in_house");
  if (inHouse) p.in_house = inHouse === "true";
  await call("save_insurance_policy", { p_booking_id: bookingId, p }, bookingId);
}

export async function saveRto(fd: FormData) {
  const bookingId = str(fd, "booking_id");
  const p = pick(
    fd,
    ["temp_reg_no", "temp_reg_date", "perm_reg_no", "perm_reg_date", "hsrp_status", "hsrp_date", "rc_status", "rc_date",
     "road_tax_amount", "tax_receipt_storage_path", "notes"],
    ["road_tax_amount"],
  );
  await call("save_rto_registration", { p_booking_id: bookingId, p }, bookingId);
}

export async function completeDelivery(fd: FormData) {
  const bookingId = str(fd, "booking_id");
  await call("complete_delivery", { p_booking_id: bookingId, p_override_reason: str(fd, "override_reason") }, bookingId);
}
