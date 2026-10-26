import { useCallback, useState } from "react";
import { View, Text, FlatList, TextInput, Pressable, RefreshControl, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/auth-context";
import { decideApproval } from "@/lib/approvals";
import { stageLabel } from "@/lib/quote-stages";

type One<T> = T | T[] | null;
const one = <T,>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

type ApprovalRow = {
  id: string;
  stage: string | null;
  requested_discount_amount: number;
  created_at: string;
  quote_id: string | null;
  booking_id: string | null;
  requested_by_employee_id: string;
  requested_by: One<{ name: string }>;
  required_role: One<{ name: string; rank: number }>;
  quote: One<{ customer_name: string; total_amount: number | null; variants: One<{ name: string }> }>;
  booking: One<{ customer_name: string | null; total_amount: number | null }>;
};

// RLS shows the approvals in this employee's line (requester's manager chain, same-outlet Outlet
// Head, org-wide Business Head/Admin); of those, only the ones they may decide are listed: their
// role is at least the one required, and they did not raise it themselves. decide_approval()
// enforces the same rules.
export default function PendingApprovalsScreen() {
  const { employee } = useAuth();
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("approvals")
      .select(
        "id, stage, requested_discount_amount, created_at, quote_id, booking_id, requested_by_employee_id, " +
          "requested_by:requested_by_employee_id(name), required_role:required_role_id(name, rank), " +
          "quote:quote_id(customer_name, total_amount, variants(name)), booking:booking_id(customer_name, total_amount)",
      )
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    const rank = employee?.roleRank ?? 99;
    setApprovals(
      ((data ?? []) as unknown as ApprovalRow[]).filter(
        (a) => a.requested_by_employee_id !== employee?.id && rank <= (one(a.required_role)?.rank ?? -1),
      ),
    );
  }, [employee?.id, employee?.roleRank]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function handleDecide(id: string, decision: "approved" | "rejected") {
    if (!employee) return;
    setDeciding(id);
    try {
      await decideApproval(id, decision, comments[id]);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch (e: any) {
      Alert.alert("Could not save decision", e.message ?? "Something went wrong");
    } finally {
      setDeciding(null);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} className="flex-1 bg-white">
      <FlatList
        data={approvals}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerClassName="p-4 gap-3"
        ListEmptyComponent={<Text className="mt-8 text-center text-slate-400">No pending approvals.</Text>}
        renderItem={({ item }) => {
          const requester = one(item.requested_by);
          const quote = one(item.quote);
          const booking = one(item.booking);
          const busy = deciding === item.id;
          const what =
            item.stage === "with_dealer_discount"
              ? "additional dealer discount"
              : item.stage === "with_schemes"
                ? "company schemes"
                : "booking discount";
          return (
            <View className="rounded-xl border border-slate-200 p-4">
              <View className="flex-row items-center justify-between">
                <Text className="font-medium text-slate-900">{quote?.customer_name ?? booking?.customer_name ?? "—"}</Text>
                <Text className="text-xs text-slate-400">{item.stage ? stageLabel(item.stage) : "Booking"}</Text>
              </View>
              {quote && <Text className="text-xs text-slate-500">{one(quote.variants)?.name}</Text>}
              <Text className="mt-1 text-lg font-semibold text-slate-900">
                ₹{Math.round(item.requested_discount_amount).toLocaleString("en-IN")} {what}
              </Text>
              <Text className="text-sm text-slate-500">
                {(quote?.total_amount ?? booking?.total_amount) != null
                  ? `On-road after discount ₹${Math.round((quote?.total_amount ?? booking?.total_amount)!).toLocaleString("en-IN")}`
                  : ""}
              </Text>
              <Text className="mt-1 text-xs text-slate-400">
                {requester?.name ?? "—"} · {new Date(item.created_at).toLocaleString()} · needs {one(item.required_role)?.name}
              </Text>

              <TextInput
                value={comments[item.id] ?? ""}
                onChangeText={(v) => setComments((prev) => ({ ...prev, [item.id]: v }))}
                placeholder="Comment (optional)"
                className="mt-3 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />

              <View className="mt-3 flex-row gap-2">
                <Pressable
                  onPress={() => handleDecide(item.id, "approved")}
                  disabled={busy}
                  className="flex-1 items-center rounded-lg bg-emerald-600 py-2 disabled:opacity-50"
                >
                  <Text className="font-medium text-white">Approve</Text>
                </Pressable>
                <Pressable
                  onPress={() => handleDecide(item.id, "rejected")}
                  disabled={busy}
                  className="flex-1 items-center rounded-lg bg-red-600 py-2 disabled:opacity-50"
                >
                  <Text className="font-medium text-white">Reject</Text>
                </Pressable>
              </View>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}
