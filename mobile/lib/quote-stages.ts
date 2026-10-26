import { supabase } from "@/lib/supabase";

// Staged quotes (20261027000001_staged_quotes.sql): Basic -> With company schemes -> With additional
// dealer discount -> Final. Moving between stages and approving them happens only in the database
// RPCs; this file is their client side.

export type QuoteStage = "basic" | "with_schemes" | "with_dealer_discount" | "final";

export const STAGES: { id: QuoteStage; label: string; documentTitle: string }[] = [
  { id: "basic", label: "Basic price", documentTitle: "Vehicle Quotation" },
  { id: "with_schemes", label: "Company schemes", documentTitle: "Vehicle Quotation — with company offers" },
  { id: "with_dealer_discount", label: "Dealer discount", documentTitle: "Vehicle Quotation — special offer" },
  { id: "final", label: "Final", documentTitle: "Final Offer" },
];

export const stageLabel = (stage: string | null | undefined) => STAGES.find((s) => s.id === stage)?.label ?? stage ?? "—";
export const stageDocumentTitle = (stage: string | null | undefined) =>
  STAGES.find((s) => s.id === stage)?.documentTitle ?? "Vehicle Quotation";

export interface StageResult {
  stage: QuoteStage;
  total_amount: number;
  approval_required?: boolean;
  required_role?: string | null;
}

export async function submitSchemes(quoteId: string, schemeLineItemIds: string[]): Promise<StageResult> {
  const { data, error } = await supabase.rpc("submit_quote_stage", {
    p_quote_id: quoteId,
    p_stage: "with_schemes",
    p_scheme_line_item_ids: schemeLineItemIds,
  });
  if (error) throw new Error(error.message);
  return data as StageResult;
}

export async function submitDealerDiscount(quoteId: string, amount: number): Promise<StageResult> {
  const { data, error } = await supabase.rpc("submit_quote_stage", {
    p_quote_id: quoteId,
    p_stage: "with_dealer_discount",
    p_dealer_discount: amount,
  });
  if (error) throw new Error(error.message);
  return data as StageResult;
}

export async function finalizeQuote(quoteId: string): Promise<StageResult> {
  const { data, error } = await supabase.rpc("finalize_quote", { p_quote_id: quoteId });
  if (error) throw new Error(error.message);
  return data as StageResult;
}

export interface SchemeOption {
  id: string;
  line_type: string;
  amount: number;
  group: string | null;
  requires_scrap: boolean;
}

// Customer-facing scheme items that apply to this model and suffix today.
export async function loadSchemeOptions(modelId: string, suffix: string | null): Promise<SchemeOption[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("schemes")
    .select(
      "id, name, suffix_scope_list, scheme_line_items(id, line_type, tkm_share, dealer_share, is_customer_facing, " +
        "scheme_conditions(mutually_exclusive_group, requires_scrap))",
    )
    .eq("model_id", modelId)
    .lte("valid_from", today)
    .gte("valid_to", today);
  if (error) throw new Error(error.message);

  const options: SchemeOption[] = [];
  for (const scheme of (data ?? []) as any[]) {
    if (scheme.suffix_scope_list && !(suffix && scheme.suffix_scope_list.includes(suffix))) continue;
    for (const li of scheme.scheme_line_items ?? []) {
      if (!li.is_customer_facing) continue;
      const condition = Array.isArray(li.scheme_conditions) ? li.scheme_conditions[0] : li.scheme_conditions;
      options.push({
        id: li.id,
        line_type: li.line_type,
        amount: Number(li.tkm_share) + Number(li.dealer_share),
        group: condition?.mutually_exclusive_group ?? null,
        requires_scrap: !!condition?.requires_scrap,
      });
    }
  }
  return options;
}
