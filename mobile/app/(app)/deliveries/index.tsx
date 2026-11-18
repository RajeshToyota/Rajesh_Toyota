import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Linking, Pressable, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import { useAuth } from "@/contexts/auth-context";
import { STAGE_LABEL, loadMyDeliveries, type MyDelivery } from "@/lib/pdi";

// "My deliveries": the consultant's upcoming handovers, with the car's PDI stage and a WhatsApp to the customer.
export default function MyDeliveriesScreen() {
  const { employee } = useAuth();
  const [rows, setRows] = useState<(MyDelivery & { stage: string | null })[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!employee) return;
    try {
      setRows(await loadMyDeliveries(employee.id));
    } catch {
      setRows([]);
    }
  }, [employee]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

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
        keyExtractor={(r) => r.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        contentContainerClassName="p-4 gap-3"
        ListEmptyComponent={<Text className="mt-8 text-center text-slate-400">No deliveries booked.</Text>}
        renderItem={({ item }) => {
          const mobile = item.bookings?.customer_mobile?.replace(/\D/g, "").slice(-10);
          return (
            <Pressable onPress={() => router.push(`/(app)/bookings/${item.booking_id}/delivery`)} className="rounded-xl border border-slate-200 p-4">
              <View className="flex-row items-center justify-between">
                <Text className="text-base font-medium text-slate-900">{item.bookings?.customer_name}</Text>
                <Text className="text-sm text-slate-600">
                  {item.slot_date} {item.slot_time}
                  {item.bay_no ? ` · Bay ${item.bay_no}` : ""}
                </Text>
              </View>
              <Text className="mt-1 text-xs text-slate-500">Car: {item.stage ? STAGE_LABEL[item.stage] ?? item.stage : "—"}</Text>
              {mobile && (
                <Pressable
                  className="mt-2 self-start rounded-lg border border-emerald-300 px-3 py-1.5"
                  onPress={() =>
                    Linking.openURL(
                      `https://wa.me/91${mobile}?text=${encodeURIComponent(`Dear ${item.bookings?.customer_name}, your car will be handed over on ${item.slot_date} at ${item.slot_time} at Rajesh Toyota.`)}`,
                    )
                  }
                >
                  <Text className="text-sm text-emerald-700">WhatsApp the customer</Text>
                </Pressable>
              )}
            </Pressable>
          );
        }}
      />
    </SafeAreaView>
  );
}
