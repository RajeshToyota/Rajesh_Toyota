import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, TextInput, ActivityIndicator, Alert, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/auth-context";
import { PriceSummary } from "@/components/price-summary";
import {
  STAGES,
  finalizeQuote,
  loadSchemeOptions,
  stageDocumentTitle,
  stageLabel,
  submitDealerDiscount,
  submitSchemes,
  type QuoteStage,
  type SchemeOption,
} from "@/lib/quote-stages";
import {
  buildQuoteHtml,
  buildWhatsAppMessage,
  generateQuotePdf,
  openWhatsApp,
  shareQuotePdfNative,
  uploadQuotePdf,
} from "@/lib/quote-document";
import { queuePendingUpload } from "@/lib/upload-queue";
import type { PricingResult } from "@/lib/types";

type One<T> = T | T[] | null;
const one = <T,>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

type Approval = {
  status: "pending" | "approved" | "rejected";
  comment: string | null;
  required_role: One<{ name: string }>;
  approver: One<{ name: string }>;
};
type Version = {
  id: string;
  version_no: number;
  stage: QuoteStage;
  total_amount: number | null;
  dealer_discount: number;
  created_at: string;
  approval: One<Approval>;
};

// Above Sales Consultant (rank 5) may see dealer margin, as in the price-quote function.
const MARGIN_MAX_RANK = 4;

export default function QuoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { employee } = useAuth();
  const [quote, setQuote] = useState<any>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [schemeOptions, setSchemeOptions] = useState<SchemeOption[]>([]);
  const [selectedSchemes, setSelectedSchemes] = useState<string[]>([]);
  const [discount, setDiscount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: q, error: qErr }, { data: v }] = await Promise.all([
      supabase
        .from("quotes")
        .select(
          "id, customer_name, customer_mobile, customer_phone, current_stage, status, priced_snapshot, total_amount, " +
            "dealer_discount, selected_scheme_line_item_ids, variants(name, suffix, model_id, models(name)), colors(name), outlets(name)",
        )
        .eq("id", id)
        .single(),
      supabase
        .from("quote_versions")
        .select(
          "id, version_no, stage, total_amount, dealer_discount, created_at, " +
            "approval:approvals!quote_versions_approval_id_fkey(status, comment, " +
            "required_role:roles!approvals_required_role_id_fkey(name), approver:employees!approvals_approver_employee_id_fkey(name))",
        )
        .eq("quote_id", id)
        .order("version_no"),
    ]);
    if (qErr || !q) {
      setError(qErr?.message ?? "Quote not found");
      return;
    }
    const row = q as any;
    setError(null);
    setQuote(row);
    setVersions((v ?? []) as unknown as Version[]);
    setSelectedSchemes(row.selected_scheme_line_item_ids ?? []);
    setDiscount(row.dealer_discount ? String(row.dealer_discount) : "");
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const variant = one<any>(quote?.variants);
  useEffect(() => {
    if (!variant?.model_id) return;
    loadSchemeOptions(variant.model_id, variant.suffix ?? null).then(setSchemeOptions, () => setSchemeOptions([]));
  }, [variant?.model_id, variant?.suffix]);

  const stage: QuoteStage = quote?.current_stage ?? "basic";
  const latest = versions[versions.length - 1];
  const latestApproval = one(latest?.approval ?? null);
  // The current stage is cleared unless its latest submission waits for or failed approval.
  const state: "cleared" | "pending" | "rejected" =
    latestApproval && latestApproval.status !== "approved" ? latestApproval.status : "cleared";
  const closed = quote?.status === "converted" || quote?.status === "expired";
  const isFinal = stage === "final";
  const stageIndex = STAGES.findIndex((s) => s.id === stage);

  const pricing: PricingResult | null = useMemo(() => {
    const p = quote?.priced_snapshot as PricingResult | null;
    if (!p) return null;
    if (employee?.roleRank != null && employee.roleRank <= MARGIN_MAX_RANK) return p;
    const { dealer_margin: _hidden, ...rest } = p;
    return rest as PricingResult;
  }, [quote?.priced_snapshot, employee?.roleRank]);

  async function run(label: string, action: () => Promise<{ approval_required?: boolean; required_role?: string | null } | void>) {
    setBusy(label);
    try {
      const result = await action();
      if (result && result.approval_required) {
        Alert.alert("Sent for approval", `A ${result.required_role} has to approve this before the quote can move on.`);
      }
      await load();
    } catch (e: any) {
      Alert.alert("Could not save", e.message ?? "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  function toggleScheme(option: SchemeOption) {
    setSelectedSchemes((prev) => {
      if (prev.includes(option.id)) return prev.filter((x) => x !== option.id);
      const others = option.group
        ? prev.filter((x) => schemeOptions.find((o) => o.id === x)?.group !== option.group)
        : prev;
      return [...others, option.id];
    });
  }

  async function share(channel: "pdf" | "whatsapp") {
    if (!pricing || !employee || !quote) return;
    setBusy(channel);
    try {
      const docData = {
        customerName: quote.customer_name,
        variantName: variant?.name ?? "",
        colorName: one<any>(quote.colors)?.name ?? "",
        outletName: one<any>(quote.outlets)?.name ?? employee.outletName ?? "",
        employeeName: employee.name,
        pricing: { ...pricing, dealer_margin: undefined },
        title: stageDocumentTitle(stage),
      };
      if (channel === "pdf") {
        const uri = await generateQuotePdf(buildQuoteHtml(docData));
        try {
          await uploadQuotePdf(uri, employee.id, quote.id);
          await supabase
            .from("quotes")
            .update({ status: "sent", pdf_storage_path: `${employee.id}/${quote.id}.pdf` })
            .eq("id", quote.id);
        } catch {
          await queuePendingUpload({ quoteId: quote.id, employeeId: employee.id, localUri: uri });
        }
        await shareQuotePdfNative(uri);
      } else {
        await openWhatsApp(quote.customer_mobile || quote.customer_phone || "", buildWhatsAppMessage(docData));
        await supabase.from("quotes").update({ status: "sent" }).eq("id", quote.id);
      }
    } catch (e: any) {
      Alert.alert("Could not share", e.message ?? "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white p-6">
        <Text className="text-center text-red-600">{error}</Text>
      </SafeAreaView>
    );
  }
  if (!quote) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  const canEditSchemes = !isFinal && !closed && stageIndex <= 1 && (state === "cleared" || stage === "with_schemes");
  const canEditDiscount =
    !isFinal && !closed && (stage === "with_dealer_discount" || (stageIndex <= 1 && state === "cleared"));
  const canFinalize = !isFinal && !closed && state === "cleared";
  const discountAmount = Number(discount.replace(/[^\d.]/g, "")) || 0;

  return (
    <SafeAreaView edges={["bottom"]} className="flex-1 bg-white">
      <ScrollView
        contentContainerClassName="p-4 gap-4"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        <View>
          <Text className="text-lg font-semibold text-slate-900">{quote.customer_name}</Text>
          <Text className="text-sm text-slate-500">
            {one<any>(variant?.models)?.name} — {variant?.name} · {one<any>(quote.colors)?.name}
          </Text>
        </View>

        {/* Stage tracker */}
        <View className="flex-row gap-1">
          {STAGES.map((s, i) => {
            const done = i < stageIndex || (i === stageIndex && state === "cleared");
            const current = i === stageIndex;
            return (
              <View key={s.id} className="flex-1">
                <View
                  className={`h-1.5 rounded-full ${
                    done ? "bg-emerald-600" : current && state === "rejected" ? "bg-red-500" : current ? "bg-amber-400" : "bg-slate-200"
                  }`}
                />
                <Text className={`mt-1 text-xs ${current ? "font-medium text-slate-900" : "text-slate-500"}`}>{s.label}</Text>
              </View>
            );
          })}
        </View>

        {state === "pending" && (
          <View className="rounded-xl border border-amber-300 bg-amber-50 p-3">
            <Text className="font-medium text-amber-900">Waiting for approval</Text>
            <Text className="mt-1 text-sm text-amber-800">
              {stageLabel(stage)} needs a {one(latestApproval?.required_role ?? null)?.name ?? "manager"}&apos;s approval.
            </Text>
          </View>
        )}
        {state === "rejected" && (
          <View className="rounded-xl border border-red-300 bg-red-50 p-3">
            <Text className="font-medium text-red-900">Not approved</Text>
            <Text className="mt-1 text-sm text-red-800">
              {one(latestApproval?.approver ?? null)?.name ?? "The approver"}:{" "}
              {latestApproval?.comment ?? "no reason given"}. Change the offer and send it again.
            </Text>
          </View>
        )}

        {pricing && <PriceSummary pricing={pricing} title={stageDocumentTitle(stage)} />}

        {/* Stage 2: company schemes */}
        {canEditSchemes && (
          <View className="rounded-xl border border-slate-200 p-4">
            <Text className="font-medium text-slate-900">Company schemes</Text>
            <Text className="mb-2 text-xs text-slate-500">A Team Leader approves any scheme discount.</Text>
            {schemeOptions.length === 0 && <Text className="text-sm text-slate-400">No schemes apply to this variant today.</Text>}
            {schemeOptions.map((o) => {
              const on = selectedSchemes.includes(o.id);
              return (
                <Pressable key={o.id} onPress={() => toggleScheme(o)} className="flex-row items-center justify-between py-2">
                  <View className="flex-row items-center gap-2">
                    <View className={`h-5 w-5 rounded border ${on ? "border-slate-900 bg-slate-900" : "border-slate-300"}`} />
                    <Text className="text-slate-800">{o.line_type}</Text>
                  </View>
                  <Text className="text-slate-600">−{inr(o.amount)}</Text>
                </Pressable>
              );
            })}
            {schemeOptions.length > 0 && (
              <Pressable
                disabled={!!busy}
                onPress={() => run("schemes", () => submitSchemes(quote.id, selectedSchemes))}
                className={`mt-2 items-center rounded-lg py-3 ${busy ? "bg-slate-300" : "bg-slate-900"}`}
              >
                {busy === "schemes" ? <ActivityIndicator color="#fff" /> : <Text className="font-medium text-white">Apply schemes</Text>}
              </Pressable>
            )}
          </View>
        )}

        {/* Stage 3: additional dealer discount */}
        {canEditDiscount && (
          <View className="rounded-xl border border-slate-200 p-4">
            <Text className="font-medium text-slate-900">Additional dealer discount</Text>
            <Text className="mb-2 text-xs text-slate-500">
              Outlet Head approves up to ₹25,000; above that the Business Head.
            </Text>
            <TextInput
              value={discount}
              onChangeText={setDiscount}
              keyboardType="numeric"
              placeholder="Amount in ₹"
              className="rounded-lg border border-slate-300 px-4 py-3 text-base"
            />
            <Pressable
              disabled={!!busy || discountAmount <= 0}
              onPress={() => run("discount", () => submitDealerDiscount(quote.id, discountAmount))}
              className={`mt-2 items-center rounded-lg py-3 ${busy || discountAmount <= 0 ? "bg-slate-300" : "bg-slate-900"}`}
            >
              {busy === "discount" ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text className="font-medium text-white">Send for approval</Text>
              )}
            </Pressable>
          </View>
        )}

        {canFinalize && (
          <Pressable
            disabled={!!busy}
            onPress={() =>
              Alert.alert("Make this the final offer?", "The price is locked and can then be booked.", [
                { text: "Cancel", style: "cancel" },
                { text: "Finalise", onPress: () => run("final", () => finalizeQuote(quote.id)) },
              ])
            }
            className="items-center rounded-lg border border-slate-900 py-3"
          >
            {busy === "final" ? <ActivityIndicator /> : <Text className="font-medium text-slate-900">Finalise quote</Text>}
          </Pressable>
        )}

        {/* Share whatever stage is cleared, so the customer can get the basic price first. */}
        {state === "cleared" && !closed && (
          <View className="flex-row gap-2">
            <Pressable
              disabled={!!busy}
              onPress={() => share("whatsapp")}
              className={`flex-1 items-center rounded-lg py-3 ${busy ? "bg-slate-300" : "bg-emerald-600"}`}
            >
              {busy === "whatsapp" ? <ActivityIndicator color="#fff" /> : <Text className="font-medium text-white">WhatsApp</Text>}
            </Pressable>
            <Pressable
              disabled={!!busy}
              onPress={() => share("pdf")}
              className="flex-1 items-center rounded-lg border border-slate-300 py-3"
            >
              {busy === "pdf" ? <ActivityIndicator /> : <Text className="font-medium text-slate-900">Share PDF</Text>}
            </Pressable>
          </View>
        )}

        {isFinal && !closed && (
          <Pressable
            onPress={() => router.push(`/(app)/bookings/from-quote/${quote.id}`)}
            className="items-center rounded-lg bg-slate-900 py-3"
          >
            <Text className="font-medium text-white">Proceed to Booking</Text>
          </Pressable>
        )}

        {versions.length > 0 && (
          <View className="rounded-xl border border-slate-100 p-4">
            <Text className="mb-2 text-sm font-medium text-slate-500">History</Text>
            {versions.map((v) => {
              const a = one(v.approval);
              return (
                <View key={v.id} className="flex-row justify-between py-1">
                  <Text className="text-sm text-slate-700">
                    {stageLabel(v.stage)}
                    {v.stage === "with_dealer_discount" ? ` (−${inr(v.dealer_discount)})` : ""}
                    {a ? ` · ${a.status}` : ""}
                  </Text>
                  <Text className="text-sm text-slate-500">{v.total_amount != null ? inr(v.total_amount) : "—"}</Text>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
