import { supabase } from "@/lib/supabase";
import { findApprovalRequirement, createApprovalRequest } from "@/lib/approvals";
import type { PricingResult, QuoteSelections } from "@/lib/types";
import type { BookingForm } from "@/hooks/use-booking-form";

// Confirming always creates the bookings row (this is the persisted record of what was agreed),
// per spec 6.2 step 6. When the discount crosses an approval threshold, a pending approvals row
// is attached to that booking alongside it, same as the quote flow's block-until-approved
// behavior — the schema has no "pending" booking status to withhold the row itself on, so the
// gate is enforced on top of the booked record rather than before it: a Team Leader/Outlet Head
// must clear the pending approval before the booking can move past `booked` (allocated/delivered).
export async function confirmBooking(params: {
  quoteId?: string;
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
      outlet_id: params.outletId,
      employee_id: params.employeeId,
      order_booking_no: params.orderBookingNo ?? null,
      ctdms_enquiry_no: params.ctdmsEnquiryNo ?? null,
      ctdms_order_booking_no: params.ctdmsOrderBookingNo ?? null,
      variant_id: params.selections.variant_id,
      color_id: params.selections.color_id,
      rto_category_id: params.selections.rto_category_id,
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

  const requirement = await findApprovalRequirement(
    params.outletId,
    params.pricing.scheme_discount_customer_facing,
  );

  if (requirement) {
    await createApprovalRequest({
      bookingId: inserted.id,
      requestedByEmployeeId: params.employeeId,
      requiredRoleId: requirement.requiredRoleId,
      discountAmount: params.pricing.scheme_discount_customer_facing,
    });
  }

  return {
    bookingId: inserted.id,
    approvalNeeded: !!requirement,
    approvalRoleName: requirement?.requiredRoleName ?? null,
  };
}
