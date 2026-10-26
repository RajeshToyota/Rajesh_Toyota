import { useCallback, useState } from "react";
import { View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { PriceSummary } from "@/components/price-summary";
import { supabase } from "@/lib/supabase";
import { findDocket, loadBooking, type Docket, type DocketBooking } from "@/lib/docket";

type Allotment = { allotted_at: string; vehicles: { vin: string; source: string } | { vin: string; source: string }[] | null };

export default function BookingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [booking, setBooking] = useState<DocketBooking | null>(null);
  const [docket, setDocket] = useState<Docket | null>(null);
  const [allotment, setAllotment] = useState<Allotment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [b, d, a] = await Promise.all([
        loadBooking(id),
        findDocket(id),
        supabase.from("allotments").select("allotted_at, vehicles(vin, source)").eq("booking_id", id).is("released_at", null).maybeSingle(),
      ]);
      setBooking(b);
      setDocket(d);
      setAllotment((a.data as Allotment | null) ?? null);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Could not load this booking");
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (error) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white px-6">
        <Text className="text-center text-red-600">{error}</Text>
      </SafeAreaView>
    );
  }
  if (!booking) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  const vehicle = `${booking.variants?.models?.name ?? ""} ${booking.variants?.name ?? ""}`.trim();
  const docketState = !docket ? "Not started" : docket.status === "complete" ? "Complete" : "In progress";
  const docketTone = !docket
    ? "border-slate-200 bg-white"
    : docket.status === "complete"
      ? "border-emerald-200 bg-emerald-50"
      : "border-amber-300 bg-amber-50";

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
        <View className="rounded-xl border border-slate-200 p-4">
          <Text className="text-lg font-semibold text-slate-900">{booking.customer_name ?? "Customer"}</Text>
          <Text className="mt-1 text-sm text-slate-500">
            {vehicle} · {booking.colors?.name ?? "—"}
          </Text>
          <Text className="mt-1 text-sm text-slate-500">
            {booking.order_booking_no ?? booking.ctdms_order_booking_no ?? "No booking number yet"} · {booking.status}
          </Text>
          {booking.customer_mobile && <Text className="mt-1 text-sm text-slate-500">{booking.customer_mobile}</Text>}
        </View>

        {allotment && (
          <View className="rounded-xl border border-slate-200 p-4">
            <Text className="font-medium text-slate-900">Car allotted</Text>
            {(() => {
              const v = Array.isArray(allotment.vehicles) ? allotment.vehicles[0] : allotment.vehicles;
              return (
                <Text className="mt-1 text-sm text-slate-500">
                  {v ? `${v.vin}${v.source === "transit" ? " · in transit" : " · in the yard"}` : "VIN not visible here"} · since{" "}
                  {new Date(allotment.allotted_at).toLocaleDateString("en-IN")}
                </Text>
              );
            })()}
          </View>
        )}

        {booking.status !== "cancelled" && (
          <Pressable
            onPress={() => router.push(`/(app)/bookings/${booking.id}/docket`)}
            className={`rounded-xl border p-4 ${docketTone}`}
          >
            <View className="flex-row items-center justify-between">
              <Text className="font-medium text-slate-900">Welcome Docket</Text>
              <Text className="text-sm text-slate-600">{docketState}</Text>
            </View>
            <Text className="mt-1 text-sm text-slate-500">
              {!docket
                ? "Registration details, documents, accessories, terms and signatures."
                : docket.status === "complete"
                  ? "Tap to share the docket PDF with the customer."
                  : "Tap to continue filling it in."}
            </Text>
            {docket?.reopened_reason && docket.status === "draft" && (
              <Text className="mt-1 text-sm text-amber-800">Reopened: {docket.reopened_reason}</Text>
            )}
          </Pressable>
        )}

        {booking.priced_snapshot && <PriceSummary pricing={booking.priced_snapshot} title="Booked Price" />}
      </ScrollView>
    </SafeAreaView>
  );
}
