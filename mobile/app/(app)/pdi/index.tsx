import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import { STAGE_LABEL, loadPdiFlow, markAtYard, markWashed, type FlowRow } from "@/lib/pdi";

const TONE: Record<string, string> = {
  to_rework: "bg-red-100 text-red-700",
  pdi_pending: "bg-amber-100 text-amber-700",
  to_move: "bg-blue-100 text-blue-700",
  to_wash: "bg-blue-100 text-blue-700",
  ready: "bg-emerald-100 text-emerald-700",
};

// The PDI technician's list: every allotted car at the branch, at its PDI stage, with the next step.
export default function PdiFlowScreen() {
  const [rows, setRows] = useState<FlowRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await loadPdiFlow());
    } catch (e: any) {
      Alert.alert("Could not load", e.message ?? String(e));
      setRows([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (e: any) {
      Alert.alert("Not done", e.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!rows) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} className="flex-1 bg-white">
      <FlatList
        data={rows}
        keyExtractor={(r) => r.booking_id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        contentContainerClassName="p-4 gap-3"
        ListEmptyComponent={<Text className="mt-8 text-center text-slate-400">No allotted cars.</Text>}
        renderItem={({ item }) => (
          <View className="rounded-xl border border-slate-200 p-4">
            <View className="flex-row items-center justify-between">
              <Text className="text-base font-medium text-slate-900">{item.customer_name}</Text>
              <View className={`rounded-full px-2 py-0.5 ${TONE[item.stage] ?? "bg-slate-100"}`}>
                <Text className="text-xs font-medium">{STAGE_LABEL[item.stage] ?? item.stage}</Text>
              </View>
            </View>
            <Text className="mt-1 text-sm text-slate-600">{item.car}</Text>
            <Text className="text-xs text-slate-500">{item.vin} · {item.location ?? "location not recorded"}</Text>
            <Text className="mt-1 text-xs text-slate-500">{item.detail}</Text>
            <View className="mt-3 flex-row flex-wrap gap-2">
              {item.stage === "pdi_pending" && item.inspection_id && (
                <Pressable
                  className="rounded-lg bg-slate-900 px-3 py-2"
                  onPress={() => router.push({ pathname: "/(app)/pdi/[inspectionId]", params: { inspectionId: item.inspection_id!, bookingId: item.booking_id } })}
                >
                  <Text className="text-sm font-medium text-white">Do the PDI</Text>
                </Pressable>
              )}
              {item.stage === "to_rework" && (
                <Pressable className="rounded-lg border border-slate-300 px-3 py-2" disabled={!!busy} onPress={() => act(item.booking_id, () => markAtYard(item.booking_id, item.outlet_id, "workshop"))}>
                  <Text className="text-sm text-slate-800">Moved to workshop</Text>
                </Pressable>
              )}
              {item.stage === "to_move" && (
                <Pressable className="rounded-lg border border-slate-300 px-3 py-2" disabled={!!busy} onPress={() => act(item.booking_id, () => markAtYard(item.booking_id, item.outlet_id, "delivery_bay"))}>
                  <Text className="text-sm text-slate-800">At the delivery bay</Text>
                </Pressable>
              )}
              {item.stage === "to_wash" && (
                <Pressable className="rounded-lg border border-slate-300 px-3 py-2" disabled={!!busy} onPress={() => act(item.booking_id, () => markWashed(item.booking_id))}>
                  <Text className="text-sm text-slate-800">Washed</Text>
                </Pressable>
              )}
              {busy === item.booking_id && <ActivityIndicator />}
            </View>
          </View>
        )}
      />
    </SafeAreaView>
  );
}
