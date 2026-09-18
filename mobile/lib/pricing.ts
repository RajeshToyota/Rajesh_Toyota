import { supabase } from "@/lib/supabase";
import type { PricingResult, QuoteSelections } from "@/lib/types";

// The only path allowed to produce a price. The mobile app never computes totals itself — it
// always calls the shared price-quote Edge Function, which wraps the same calculate_price
// Postgres function used at the "Proceed to Booking" re-pricing checkpoint, and strips
// dealer_margin from the response for roles that shouldn't see it.
export async function priceQuote(selections: QuoteSelections): Promise<PricingResult> {
  const { data, error } = await supabase.functions.invoke<PricingResult>("price-quote", {
    body: { selections },
  });

  if (error) {
    throw new Error(error.message ?? "Failed to price quote");
  }
  if (!data) {
    throw new Error("Empty pricing response");
  }

  return data;
}
