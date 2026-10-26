"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Every change to stock goes through a database function that checks the caller's role and
// branch (20261029000001_stock_allotment.sql); these actions only pass the form along.

const str = (fd: FormData, key: string) => {
  const v = (fd.get(key) as string | null)?.trim();
  return v ? v : null;
};

async function rpc(name: string, args: Record<string, unknown>) {
  const supabase = await createClient();
  const { error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  revalidatePath("/stock", "layout");
}

export async function allotVehicle(fd: FormData) {
  await rpc("allot_vehicle", {
    p_booking_id: str(fd, "booking_id"),
    p_vehicle_id: str(fd, "vehicle_id"),
    p_method: str(fd, "method") ?? "manual",
    p_reason: str(fd, "reason"),
  });
}

// Confirms several proposals at once ("booking_id:vehicle_id" pairs); stops at the first refusal.
export async function allotProposals(fd: FormData) {
  const method = str(fd, "method") ?? "fifo";
  const pairs = fd.getAll("pair").map(String);
  if (pairs.length === 0) throw new Error("Tick at least one proposal");
  const supabase = await createClient();
  let done = 0;
  for (const pair of pairs) {
    const [bookingId, vehicleId] = pair.split(":");
    const { error } = await supabase.rpc("allot_vehicle", {
      p_booking_id: bookingId,
      p_vehicle_id: vehicleId,
      p_method: method,
      p_reason: null,
    });
    if (error) {
      revalidatePath("/stock", "layout");
      throw new Error(`${done} allotted; then: ${error.message}`);
    }
    done++;
  }
  revalidatePath("/stock", "layout");
}

export async function releaseAllotment(fd: FormData) {
  await rpc("release_allotment", { p_allotment_id: str(fd, "allotment_id"), p_reason: str(fd, "reason") });
}

export async function swapVehicle(fd: FormData) {
  await rpc("swap_vehicle_customer", {
    p_vehicle_id: str(fd, "vehicle_id"),
    p_new_booking_id: str(fd, "booking_id"),
    p_reason: str(fd, "reason"),
  });
}

export async function markBlockDone(fd: FormData) {
  await rpc("mark_block_task_done", { p_task_id: str(fd, "task_id") });
}

export async function sendForBilling(fd: FormData) {
  await rpc("send_for_billing", { p_booking_id: str(fd, "booking_id") });
}

export async function cancelBilling(fd: FormData) {
  await rpc("cancel_billing_request", { p_request_id: str(fd, "request_id"), p_reason: str(fd, "reason") });
}

export async function recordInvoice(fd: FormData) {
  const amount = Number(str(fd, "invoice_amount")?.replace(/,/g, ""));
  await rpc("record_invoice", {
    p_request_id: str(fd, "request_id"),
    p_invoice_no: str(fd, "invoice_no"),
    p_invoice_date: str(fd, "invoice_date"),
    p_invoice_amount: Number.isFinite(amount) ? amount : null,
  });
}

export async function mapColor(fd: FormData) {
  await rpc("map_stock_color", {
    p_description: str(fd, "description"),
    p_variant_id: str(fd, "variant_id"),
    p_color_id: str(fd, "color_id"),
  });
}
