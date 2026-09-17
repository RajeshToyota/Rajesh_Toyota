import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as Linking from "expo-linking";
import { supabase } from "@/lib/supabase";
import type { PricingResult } from "@/lib/types";

interface QuoteDocumentData {
  customerName: string;
  variantName: string;
  colorName: string;
  outletName: string;
  employeeName: string;
  pricing: PricingResult;
}

function formatInr(amount: number): string {
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

export function buildQuoteHtml(data: QuoteDocumentData): string {
  const rows = data.pricing.line_items
    .map(
      (item) =>
        `<tr><td style="padding:6px 0;color:#334155;">${item.label}</td><td style="padding:6px 0;text-align:right;">${formatInr(item.amount)}</td></tr>`,
    )
    .join("");

  return `
    <html>
      <head><meta charset="utf-8" /></head>
      <body style="font-family: Helvetica, Arial, sans-serif; padding: 24px; color: #0f172a;">
        <h1 style="font-size: 20px; margin-bottom: 4px;">Rajesh Toyota</h1>
        <p style="color:#64748b; margin-top:0;">Vehicle Quotation — indicative, priced as of ${new Date(data.pricing.priced_as_of).toLocaleDateString()}</p>

        <table style="width:100%; margin-top: 16px; font-size: 13px;">
          <tr><td style="color:#64748b; padding:2px 0;">Customer</td><td style="text-align:right;">${data.customerName}</td></tr>
          <tr><td style="color:#64748b; padding:2px 0;">Vehicle</td><td style="text-align:right;">${data.variantName}</td></tr>
          <tr><td style="color:#64748b; padding:2px 0;">Color</td><td style="text-align:right;">${data.colorName}</td></tr>
          <tr><td style="color:#64748b; padding:2px 0;">Outlet</td><td style="text-align:right;">${data.outletName}</td></tr>
          <tr><td style="color:#64748b; padding:2px 0;">Sales Consultant</td><td style="text-align:right;">${data.employeeName}</td></tr>
        </table>

        <hr style="margin: 16px 0; border: none; border-top: 1px solid #e2e8f0;" />

        <table style="width:100%; font-size: 14px; border-collapse: collapse;">
          ${rows}
          <tr>
            <td style="padding-top:10px; font-weight:bold; border-top: 2px solid #0f172a;">Total Amount</td>
            <td style="padding-top:10px; font-weight:bold; text-align:right; border-top: 2px solid #0f172a;">${formatInr(data.pricing.total_amount)}</td>
          </tr>
        </table>

        <p style="margin-top: 24px; font-size: 11px; color: #94a3b8;">
          This is an indicative quote. Price, schemes, and RTO/insurance amounts are subject to
          change and will be re-confirmed at the time of booking, as per Toyota's terms.
        </p>
      </body>
    </html>
  `;
}

export async function generateQuotePdf(html: string): Promise<string> {
  const { uri } = await Print.printToFileAsync({ html, base64: false });
  return uri;
}

export async function uploadQuotePdf(
  localUri: string,
  employeeId: string,
  quoteId: string,
): Promise<string> {
  const response = await fetch(localUri);
  const blob = await response.blob();
  const path = `${employeeId}/${quoteId}.pdf`;

  const { error } = await supabase.storage
    .from("quote-pdfs")
    .upload(path, blob, { contentType: "application/pdf", upsert: true });

  if (error) throw new Error(error.message);
  return path;
}

export async function shareQuotePdfNative(localUri: string) {
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error("Sharing is not available on this device");
  await Sharing.shareAsync(localUri, { mimeType: "application/pdf", dialogTitle: "Share Quote" });
}

export function buildWhatsAppMessage(data: QuoteDocumentData): string {
  const lines = [
    `*Rajesh Toyota — Vehicle Quotation*`,
    ``,
    `Customer: ${data.customerName}`,
    `Vehicle: ${data.variantName} (${data.colorName})`,
    ``,
    ...data.pricing.line_items.map((item) => `${item.label}: ${formatInr(item.amount)}`),
    ``,
    `*Total: ${formatInr(data.pricing.total_amount)}*`,
    ``,
    `Indicative price as of ${new Date(data.pricing.priced_as_of).toLocaleDateString()}. Final pricing confirmed at booking.`,
    ``,
    `— ${data.employeeName}, ${data.outletName}`,
  ];
  return lines.join("\n");
}

export async function openWhatsApp(phone: string, message: string) {
  const digits = phone.replace(/[^\d]/g, "");
  const url = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
  const canOpen = await Linking.canOpenURL(url);
  if (!canOpen) throw new Error("WhatsApp is not available");
  await Linking.openURL(url);
}
