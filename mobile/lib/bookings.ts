import { supabase } from "@/lib/supabase";
import { requestBookingApproval } from "@/lib/approvals";
import type { PricingResult, QuoteSelections } from "@/lib/types";
import type { BookingForm } from "@/hooks/use-booking-form";

// Confirming always creates the bookings row (this is the persisted record of what was agreed),
// per spec 6.2 step 6. A booking made from a final staged quote carries that quote's approved
// schemes and dealer discount (the database copies them). A direct booking asks for approval of
// its scheme discount after the row exists; the schema has no "pending" booking status, so the gate
// sits on top of the booked record: the approval must clear before it can move past `booked`.
export async function confirmBooking(params: {
  quoteId?: string;
  enquiryId?: string | null;
  // A booking from a quote takes the quote's customer in the database; a direct booking sends it.
  customerName?: string | null;
  customerMobile?: string | null;
  outletId: string;
  employeeId: string;
  selections: QuoteSelections;
  pricing: PricingResult;
  bookingForm: ReturnType<BookingForm["toPayload"]>;
  signaturePath: string | null;
  orderBookingNo?: string;
  ctdmsEnquiryNo?: string;
  ctdmsOrderBookingNo?: string;
}): Promise<{ bookingId: string; approvalNeeded: boolean; approvalRoleName: string | null }> {
  const { data: inserted, error: insertError } = await supabase
    .from("bookings")
    .insert({
      quote_id: params.quoteId ?? null,
      enquiry_id: params.enquiryId ?? null,
      customer_name: params.customerName || null,
      customer_mobile: params.customerMobile || null,
      outlet_id: params.outletId,
      employee_id: params.employeeId,
      order_booking_no: params.orderBookingNo ?? null,
      ctdms_enquiry_no: params.ctdmsEnquiryNo ?? null,
      ctdms_order_booking_no: params.ctdmsOrderBookingNo ?? null,
      variant_id: params.selections.variant_id,
      color_id: params.selections.color_id,
      rto_category_id: params.selections.rto_category_id,
      price_list_type: params.selections.list_type ?? "private",
      insurance_option: params.selections.insurance_option ?? null,
      include_extended_warranty: params.selections.include_extended_warranty ?? false,
      insurance_plan_id: params.selections.insurance_plan_id ?? null,
      insurance_addon_ids: params.selections.insurance_addon_ids ?? [],
      accessory_ids: params.selections.accessory_ids ?? [],
      vas_product_ids: params.selections.vas_product_ids ?? [],
      selected_scheme_line_item_ids: params.selections.selected_scheme_line_item_ids ?? [],
      priced_snapshot: params.pricing,
      total_amount: params.pricing.total_amount,
      priced_as_of: params.pricing.priced_as_of,
      signature_storage_path: params.signaturePath,
      status: "booked",
      ...params.bookingForm,
    })
    .select("id")
    .single();

  if (insertError) throw new Error(insertError.message);

  const { approvalRequired, requiredRole } = await requestBookingApproval(inserted.id);

  return {
    bookingId: inserted.id,
    approvalNeeded: approvalRequired,
    approvalRoleName: requiredRole,
  };
}
