import { useCallback, useState } from "react";
import { View, Text, FlatList, TextInput, Pressable, RefreshControl, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/auth-context";
import { decideApproval } from "@/lib/approvals";

type ApprovalRow = {
  id: string;
  requested_discount_amount: number;
  created_at: string;
  quote_id: string | null;
  booking_id: string | null;
  requested_by: { name: string } | { name: string }[] | null;
};

// RLS already scopes this to approvals the current employee can act on: the requester's
// manager chain, or a same-outlet Outlet Head, or org-wide Business Head/Admin — so this is
// naturally the "Team Leaders/Outlet Heads" approvals queue from spec 6.3 with no extra filtering.
export default function PendingApprovalsScreen() {
  const { employee } = useAuth();
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("approvals")
      .select("id, requested_discount_amount, created_at, quote_id, booking_id, requested_by:requested_by_employee_id(name)")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    setApprovals(data ?? []);
  }, []);

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
      await decideApproval(id, decision, employee.id, comments[id]);
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
          const requester = Array.isArray(item.requested_by) ? item.requested_by[0] : item.requested_by;
          const busy = deciding === item.id;
          return (
            <View className="rounded-xl border border-slate-200 p-4">
              <View className="flex-row items-center justify-between">
                <Text className="font-medium text-slate-900">{requester?.name ?? "—"}</Text>
                <Text className="text-xs text-slate-400">{item.quote_id ? "Quote" : "Booking"}</Text>
              </View>
              <Text className="mt-1 text-lg font-semibold text-slate-900">
                ₹{Math.round(item.requested_discount_amount).toLocaleString("en-IN")} discount
              </Text>
              <Text className="mt-1 text-xs text-slate-400">{new Date(item.created_at).toLocaleString()}</Text>

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
