import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { docTypeLabel, type Docket, type DocketBooking, type DocketDocument } from "@/lib/docket";

// The Welcome Docket PDF given to the customer. The terms below are copied word for word from
// the printed Toyota Welcome Docket (pp.8, 13 and 24), including its original wording.

export const ORDER_TERMS: string[] = [
  "The order form, dully filled along with booking amount must be submitted by the customer to the authorized dealer (“Dealer”) of Toyota Kirloskar Motor Pvt. Ltd. (“TKM”)",
  "Booking amount should be in favor of Dealer, payable at the location of the Dealer, and no amount may be sent to TKM.",
  "No change in booking name or transfer of booking is permissible unless it is in favor of the nominee.( As mentioned in the order form)",
  "The order form number should be mentioned in all the correspondence henceforth till the time of delivery",
  "The balance amount towards the price of the vehicle will be payable to the Dealer on the intimation from the Dealer.",
  "Delivery of vehicle will be made after receipt of full price of the vehicle and other charges as applicable",
  "All payments towards price of vehicle and other charges to be made prior to the intimated delivery date, failing which will result in change of allocation sequence after a grace period of three working days.",
  "Allocation of vehicles to customers will be done strictly after the receipt of full price and other charges, subject to availability of Model, Suffix and Color",
  "At any point of time delivery status of vehicle can be confirmed/will be available with Dealer.",
  "Change in Model, Suffix or Color may result in change of allocation sequence and delivery period.",
  "The delivery of the vehicle can only be taken from the Dealer where the Booking is made.",
];

export const REFUND_TERMS: string[] = [
  "The customer shall make a written request to dealer with whom the booking was made for cancellation of the booking along with original Customer Copy of the Booking Form and Cash Receipt.",
  "The booking amount will be returned to the customer by the dealer by the way of Cheque only.",
  "The refund would be made within 7 working days after the receipt of all Document for cancellation.",
];

export const MORE_ORDER_TERMS: string[] = [
  "The delivery of the vehicle by the dealer is subject to the right of TKM to change model, specification, and features without prior notice.",
  "The vehicle specification, price and statutory levies shall be as applicable as on the date of delivery of the vehicle by the Dealer.",
  "TKM or the Dealer shall not be responsible to the customer for loss of any document, draft/ cheque or delay in their receipt when sent by mail/courier.",
  "Any tentative delivery date indicated by Dealer shall not be treated as firm commitment by Dealer/TKM.",
  "All disputes related to booking and sale of vehicles shall be subject to the exclusive jurisdiction of the courts at whose jurisdiction the Dealer with whom the booking made is situated.",
  "The document required for registration of the Toyota car have to be submitted as per the existing policy, rules and regulation of the concerned Transport Authority of the State Government",
  "The delivery of the car shall be given after registration number is allotted on payment receipt by the Transport Department",
  "Value of car for exchange may vary. Actual price will be determined at the time old car handover based on condition of old car.",
  "Delivery of vehicle by the dealer is Subject to Force Majeure events and the Dealer shall not be responsible for the delay arising there from.",
  "This is only an acknowledgement of order received and not a cash receipt.",
  "In case of Order cancellation after receipt of full loan/finance amount by Dealer from bank/ financier, refund of loan / finance amount shall be made only to the respective bank/ Financier.",
  "Refund of loan amount in such cases can be made to the customer only if specific written communication in received from the respective bank/financier authorizing the Dealer to that effect.",
  "I acknowledge that the Dealer and/or TKM may process personal and/or sensitive data collected hereunder for (1) its internal and/or for other commercial, publicity or promotional purposes (2) managing my relationship with Dealer and/or TKM (3) complying with legal obligations and requirements and (4) for carrying out research, planning and statistical analysis by Dealer, TKM and/or Toyota affiliate companies.",
];

export const DATA_CONSENT_YES =
  "I agree and give my consent to the Dealer and/or TKM (a) to process any such personal and/or sensitive data provided hereunder and (b) for sharing / transfer of my personal data with Toyota affiliate companies.";
export const DATA_CONSENT_NO = "I do not agree/consent to the same.";

export const ACCESSORY_TERMS: string[] = [
  "Please note the price are Inclusive of all local levies and labour charges wherever applicable.",
  "Order once placed cannot be cancelled",
  "Payment of accessories to be made before delivery of vehicle.",
  "10% advance to be paid by the customer while placing the order.",
  "The rates of taxes, duties, levies, octroi etc. Are as applicable on the date of sale.",
  "Warranty on the goods is offered to the extend covered under the Warranty Policy of the manufacturer.",
  "The sale is subject force majeure events. The Dealer shall not be liable to the customer for the delayed delivery of the goods under such events.",
];

export const RTO_DISCLAIMER: string[] = [
  "It is to be noted that the dealership is only facilitating the registration of your car. Registration certificate (RC) booklet/ RC smart card/ High security registration plate (HSRP) is issued by concerned Road Transport Office (RTO)",
  "Registration process may get delayed due to Saturday offs or other gazetted government holidays, RTO IT systems problems etc",
  "Allotment of either regular numbers, or special “Choice” registration numbers are not the dealers responsibility or in its purview",
  "Disclosure of true and complete information in the documents is the customers responsibility",
  "If all documents are as per the requirement of RTO authorities, the RC booklet/ Smart card can be obtained in a specified time frame. Incase any additional document is demanded by the RTO authorities, it is mandatory for the customer to fulfill it. Time taken for physical verification is totally dependent on the RTO authorities.",
];

export const RTO_NOTE =
  "Note: The approximate time for receipt time of RC booklet/ Smart card / fitment of HSRP communicated by dealership is only tentative and actual timelines may vary due to a combination of factors mentioned above.";

export interface DocketDocumentData {
  booking: DocketBooking;
  docket: Docket;
  documents: DocketDocument[];
  customerSignature: string | null; // data: URLs
  consultantSignature: string | null;
}

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${Math.round(Number(n)).toLocaleString("en-IN")}`);
const date = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString("en-IN") : "—");
const dateTime = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";

function rows(pairs: [string, unknown][]) {
  return pairs
    .map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${v === null || v === undefined || v === "" ? "—" : esc(v)}</td></tr>`)
    .join("");
}

const list = (items: string[]) => `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;

function signatures(data: DocketDocumentData) {
  const img = (src: string | null) => (src ? `<img src="${src}" style="height:60px;" />` : `<div style="height:60px;"></div>`);
  return `
    <table class="sig"><tr>
      <td>${img(data.customerSignature)}<div class="line">Customer Signature &amp; Date</div></td>
      <td>${img(data.consultantSignature)}<div class="line">Sales Consultant Signature &amp; Date</div></td>
    </tr></table>
    <p class="muted">Signed ${date(data.docket.completed_at ?? new Date().toISOString())}</p>`;
}

export function buildDocketHtml(data: DocketDocumentData): string {
  const { booking: b, docket: d } = data;
  const model = b.variants?.models?.name ?? "";
  const vehicle = `${model} ${b.variants?.name ?? ""}`.trim();
  const pricing = b.priced_snapshot;
  const collected = new Set(data.documents.map((x) => x.doc_type));
  const yes = (v: boolean) => (v ? "Yes" : "No");
  const option = (v: string | null, labels: Record<string, string>) => (v ? labels[v] ?? v : null);

  const priceRows = pricing
    ? pricing.line_items.map((i) => `<tr><td>${esc(i.label)}</td><td class="r">${inr(i.amount)}</td></tr>`).join("") +
      `<tr class="total"><td>Total On Road Price</td><td class="r">${inr(pricing.total_amount)}</td></tr>`
    : `<tr><td colspan="2">Price not available</td></tr>`;

  const accessoryRows = d.accessory_order_items.length
    ? d.accessory_order_items
        .map(
          (a, i) =>
            `<tr><td>${i + 1}</td><td>${esc(a.name)}</td><td>${esc(a.part_no ?? "")}</td><td class="r">${a.qty}</td><td class="r">${inr(a.price)}</td><td class="r">${inr(a.amount)}</td></tr>`,
        )
        .join("") +
      `<tr class="total"><td colspan="5">Total</td><td class="r">${inr(d.accessories_total)}</td></tr>
       <tr><td colspan="5">Advance (10%)</td><td class="r">${inr(d.accessories_advance)}</td></tr>`
    : `<tr><td colspan="6">No accessories ordered</td></tr>`;

  const referralBlocks = d.referrals.length
    ? d.referrals
        .map((r) => `<table class="kv">${rows([["Name", r.name], ["Occupation", r.occupation], ["Phone no", r.phone], ["Address", r.address], ["Car owned", r.car_owned]])}</table>`)
        .join("")
    : `<p class="muted">No referrals given.</p>`;

  return `
<html><head><meta charset="utf-8" />
<style>
  body { font-family: Helvetica, Arial, sans-serif; color: #0f172a; font-size: 11px; padding: 20px; }
  h1 { font-size: 20px; margin: 0; } h2 { font-size: 13px; margin: 18px 0 6px; padding: 4px 0; border-bottom: 2px solid #0f172a; text-transform: uppercase; letter-spacing: 0.3px; }
  table { width: 100%; border-collapse: collapse; } td, th { padding: 4px 6px; border: 1px solid #e2e8f0; vertical-align: top; text-align: left; }
  td.k { width: 38%; color: #475569; } .r { text-align: right; } tr.total td { font-weight: bold; }
  .kv { margin-bottom: 8px; } .muted { color: #64748b; } ul { margin: 4px 0; padding-left: 16px; } li { margin: 2px 0; }
  .sig td { border: none; text-align: center; width: 50%; padding-top: 18px; } .sig .line { border-top: 1px solid #94a3b8; padding-top: 4px; }
  .page { page-break-before: always; }
</style></head>
<body>
  <h1>Welcome Docket</h1>
  <p class="muted">Rajesh Toyota — ${esc(b.outlets?.name ?? "")}${b.outlets?.address ? `, ${esc(b.outlets.address)}` : ""}</p>
  <p>Dear Customer, thank you for choosing TOYOTA. This Welcome Docket helps you understand various aspects related to
  the booking and subsequent purchase of your new Toyota from us. Please retain your copy with the signature of the Sales Consultant.</p>

  <h2>Order Booking Form</h2>
  <table class="kv">${rows([
    ["Order Booking Form No.", b.order_booking_no],
    ["CTDMS Enquiry No.", b.ctdms_enquiry_no],
    ["CTDMS Order Booking No.", b.ctdms_order_booking_no],
    ["Date of booking", date(b.created_at)],
    ["Customer Name", b.customer_name],
    ["Model / Suffix / Color", `${vehicle}${b.variants?.suffix ? ` (${b.variants.suffix})` : ""} — ${b.colors?.name ?? ""}`],
    ["Communication Address", `${d.communication_address ?? ""}${d.address_type ? ` (${d.address_type === "office" ? "Off" : "Res"})` : ""}`],
    ["PIN", d.pin],
    ["Mob No.", d.mobile],
    ["Phone No.", d.alt_phone],
    ["Email ID", d.email],
    ["PAN Number", b.pan_number],
    ["Occupation", b.occupation],
    ["Date of Birth", b.date_of_birth ? date(b.date_of_birth) : null],
    ["Mode of Purchase", b.mode_of_purchase],
    [b.is_company_purchase ? "Company Name" : "Name of Nominee", b.is_company_purchase ? b.company_name : b.nominee_name],
    ["Mother's Maiden Name", b.is_company_purchase ? null : b.mothers_maiden_name],
    ["Likely Delivery Date", b.likely_delivery_date ? date(b.likely_delivery_date) : null],
  ])}</table>
  <table>${priceRows}</table>

  <h2>Payment Details</h2>
  <table class="kv">${rows([
    ["Cheque / DD / PO / Cash", b.payment_instrument_type],
    ["Payment Instrument No.", b.payment_instrument_no],
    ["Date", b.payment_date ? date(b.payment_date) : null],
    ["Amount", b.payment_amount != null ? inr(b.payment_amount) : null],
    ["Drawn on (Bank Name)", b.payment_bank_name],
  ])}</table>
  <p>The allocation of the vehicle will be made on “first come first serve basis”.</p>

  <h2 class="page">Terms and Conditions for Order / Purchase of Toyota Vehicle</h2>
  ${list(ORDER_TERMS)}
  <p><b>Refund in case of cancellation</b></p>
  ${list(REFUND_TERMS)}
  ${list(MORE_ORDER_TERMS)}
  <p>[${b.data_consent ? "✓" : " "}] ${esc(DATA_CONSENT_YES)}<br />[${b.data_consent ? " " : "✓"}] ${esc(DATA_CONSENT_NO)}</p>
  <p>Accepted by the customer: ${yes(d.terms_accepted)}</p>
  ${signatures(data)}

  <h2 class="page">Accessories Order Form</h2>
  <table class="kv">${rows([["Model", vehicle], ["Color", b.colors?.name], ["Mode of payment", option(d.accessories_payment_mode, { cash: "Cash", card: "Credit Card" })]])}</table>
  <table><tr><th>Sl. No</th><th>Description</th><th>Part No</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr>${accessoryRows}</table>
  <p><b>Terms &amp; Conditions</b></p>
  <ol>${ACCESSORY_TERMS.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>

  <h2>Checklist of Documents</h2>
  <table>${data.documents.length === 0 ? `<tr><td>No documents recorded</td></tr>` : ""}
    ${Array.from(collected)
      .map((t) => {
        const docs = data.documents.filter((x) => x.doc_type === t);
        const how = docs.some((x) => x.storage_path) ? "Copy on file" : "Collected on paper";
        const label = docs.find((x) => x.label)?.label;
        return `<tr><td>✓ ${esc(docTypeLabel(t))}${label ? ` — ${esc(label)}` : ""}</td><td>${how}</td></tr>`;
      })
      .join("")}
  </table>

  <h2 class="page">Registration &amp; Delivery Details</h2>
  <table class="kv">${rows([
    ["Name of Customer", b.customer_name],
    ["Model / Suffix / Color", `${vehicle} / ${b.variants?.suffix ?? "—"} / ${b.colors?.name ?? "—"}`],
    ["Father/Husband Name", d.father_or_husband_name],
    ["Registration Address", d.registration_address],
    ["Hypothecated To", d.hypothecated_to],
    ["Insurance Coverage", option(d.insurance_coverage, { in_house: "In house", by_party: "By party" })],
    ["Registration Type", option(d.registration_period, { permanent: "Permanent", temporary: "Temporary" })],
    ["RTO Location", d.rto_location],
    ["Private / Commercial", option(d.registration_use, { private: "Private", commercial: "Commercial" })],
    ["Permit (commercial vehicle only)", option(d.permit_type, { state: "State Permit", all_india: "All India Permit" })],
    ["Special Registration Number (Optional)", d.special_registration_number],
    ["Date of Registration", d.registration_date ? date(d.registration_date) : null],
    ["Date & Time of Delivery", d.delivery_at ? dateTime(d.delivery_at) : null],
    ["Place of Delivery", d.delivery_place],
  ])}</table>
  <p><b>Approximate receipt time &amp; Important Notes</b></p>
  <table class="kv">${rows([
    ["Temporary Registration Validity Period", d.temp_registration_validity_days ? `${d.temp_registration_validity_days} working days` : null],
    ["RC Booklet/ Smart Card", d.rc_days ? `${d.rc_days} working days` : null],
    ["Reg Plate / High Security Registration Plate", d.hsrp_days ? `${d.hsrp_days} working days` : null],
  ])}</table>

  <h2>RTO Process</h2>
  <p>Toyota Kirloskar Motor is committed to abide to the rules &amp; regulations prescribed by the local RTO authorities.
  Dealership assisting the customer for Temporary/Permanent registration is governed by the mandate of the local RTO.</p>
  <p><b>Disclaimer</b></p>
  ${list(RTO_DISCLAIMER)}
  <p>${esc(RTO_NOTE)}</p>
  <p>[${d.rto_terms_accepted ? "✓" : " "}] I have read and agree to all the terms &amp; conditions mentioned above</p>
  ${signatures(data)}

  <h2 class="page">Toyota Programmes</h2>
  <table class="kv">${rows([
    ["U Trust (sell / exchange / buy certified used car)", yes(d.utrust_interest)],
    ["Toyota i-Connect / T-Connect app", yes(d.tconnect_interest)],
    ["Extended Warranty", yes(d.extended_warranty_interest)],
    ["Smiles Plus service package", yes(d.smiles_interest)],
  ])}</table>

  <h2>Referral Form</h2>
  <p class="muted">The highest compliment we can ever receive from a customer is referral.</p>
  ${referralBlocks}

  <p class="muted" style="margin-top:24px;">Sales Consultant: ${esc(b.employees?.name ?? "")} · Generated ${dateTime(new Date().toISOString())}</p>
</body></html>`;
}

export async function generateDocketPdf(html: string): Promise<string> {
  const { uri } = await Print.printToFileAsync({ html, base64: false });
  return uri;
}

export async function shareDocketPdf(localUri: string) {
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error("Sharing is not available on this device");
  await Sharing.shareAsync(localUri, { mimeType: "application/pdf", dialogTitle: "Share Welcome Docket" });
}
