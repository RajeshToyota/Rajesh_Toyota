import { supabase } from "@/lib/supabase";

export async function createScrapCertificate(params: {
  source: "Self" | "Rajesh Toyota";
  amount?: number;
  certificateNumber?: string;
}): Promise<string> {
  const { data, error } = await supabase
    .from("scrap_certificates")
    .insert({
      source: params.source,
      amount: params.amount ?? null,
      certificate_number: params.certificateNumber || null,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return data.id;
}

export async function linkScrapCertificate(
  certificateId: string,
  target: { quoteId?: string; bookingId?: string },
) {
  const { error } = await supabase
    .from("scrap_certificates")
    .update({
      linked_quote_id: target.quoteId ?? null,
      linked_booking_id: target.bookingId ?? null,
    })
    .eq("id", certificateId);

  if (error) throw new Error(error.message);
}
