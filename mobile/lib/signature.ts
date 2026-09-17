import { supabase } from "@/lib/supabase";

export async function uploadSignature(localUri: string, employeeId: string, bookingId: string): Promise<string> {
  const response = await fetch(localUri);
  const blob = await response.blob();
  const path = `${employeeId}/${bookingId}.png`;

  const { error } = await supabase.storage
    .from("booking-signatures")
    .upload(path, blob, { contentType: "image/png", upsert: true });

  if (error) throw new Error(error.message);
  return path;
}
