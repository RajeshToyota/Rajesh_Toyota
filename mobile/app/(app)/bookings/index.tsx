import { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { supabase } from "@/lib/supabase";

type BookingRow = {
  id: string;
  total_amount: number | null;
  status: string;
  created_at: string;
  priced_as_of: string | null;
  order_booking_no: string | null;
};

const STATUSES = ["all", "booked", "allocated", "delivered", "cancelled"] as const;

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    booked: "bg-blue-100 text-blue-700",
    allocated: "bg-amber-100 text-amber-700",
    delivered: "bg-emerald-100 text-emerald-700",
    cancelled: "bg-red-100 text-red-700",
  };
  return (
    <View className={`rounded-full px-2 py-0.5 ${colors[status] ?? "bg-slate-100"}`}>
      <Text className="text-xs font-medium capitalize">{status}</Text>
    </View>
  );
}

export default function MyBookingsScreen() {
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [filter, setFilter] = useState<(typeof STATUSES)[number]>("all");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    let query = supabase
      .from("bookings")
      .select("id, total_amount, status, created_at, priced_as_of, order_booking_no")
      .order("created_at", { ascending: false });

    if (filter !== "all") query = query.eq("status", filter);

    const { data } = await query;
    setBookings(data ?? []);
  }, [filter]);

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

  return (
    <SafeAreaView edges={["bottom"]} className="flex-1 bg-white">
      <View className="flex-row flex-wrap gap-2 border-b border-slate-100 px-4 py-3">
        {STATUSES.map((s) => (
          <Pressable
            key={s}
            onPress={() => setFilter(s)}
            className={`rounded-full px-3 py-1.5 ${filter === s ? "bg-slate-900" : "bg-slate-100"}`}
          >
            <Text className={`text-sm capitalize ${filter === s ? "text-white" : "text-slate-700"}`}>{s}</Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={bookings}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerClassName="p-4 gap-3"
        ListEmptyComponent={<Text className="mt-8 text-center text-slate-400">No bookings yet.</Text>}
        renderItem={({ item }) => (
          <View className="rounded-xl border border-slate-200 p-4">
            <View className="flex-row items-center justify-between">
              <Text className="font-medium text-slate-900">{item.order_booking_no ?? "Booking"}</Text>
              <StatusBadge status={item.status} />
            </View>
            <Text className="mt-1 text-lg font-semibold text-slate-900">
              {item.total_amount ? `₹${Math.round(item.total_amount).toLocaleString("en-IN")}` : "—"}
            </Text>
            <Text className="mt-1 text-xs text-slate-400">
              Priced {item.priced_as_of ? new Date(item.priced_as_of).toLocaleDateString() : "—"}
            </Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}
