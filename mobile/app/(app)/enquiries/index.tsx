import { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, RefreshControl, Alert, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, router } from "expo-router";
import { supabase } from "@/lib/supabase";
import { STAGE_LABELS, markEnquiryLost, purposeLabel } from "@/lib/enquiries";

type EnquiryRow = {
  id: string;
  created_at: string;
  stage: string;
  temperature: string;
  purpose_of_visit: string;
  ctdms_enquiry_no: string | null;
  customers: { name: string; mobile: string } | null;
  models: { name: string } | null;
  fuel_types: { name: string } | null;
  employees: { name: string } | null;
};

const FILTERS = ["open", "quoted", "booked", "lost", "all"] as const;

const STAGE_COLORS: Record<string, string> = {
  open: "bg-blue-100 text-blue-700",
  quoted: "bg-amber-100 text-amber-700",
  booked: "bg-emerald-100 text-emerald-700",
  lost: "bg-slate-200 text-slate-600",
};

const TEMPERATURE_COLORS: Record<string, string> = {
  HOT: "text-red-600",
  WRM: "text-amber-600",
  CLD: "text-sky-600",
};

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export default function MyEnquiriesScreen() {
  const [rows, setRows] = useState<EnquiryRow[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("open");
  const [refreshing, setRefreshing] = useState(false);

  // RLS returns the caller's own enquiries (and their team's, for Team Leaders and above).
  const load = useCallback(async () => {
    let query = supabase
      .from("enquiries")
      .select(
        "id, created_at, stage, temperature, purpose_of_visit, ctdms_enquiry_no, customers(name, mobile), models(name), fuel_types(name), employees!enquiries_assigned_employee_id_fkey(name)",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (filter !== "all") query = query.eq("stage", filter);
    const { data } = await query;
    setRows(
      ((data ?? []) as any[]).map((r) => ({
        ...r,
        customers: one(r.customers),
        models: one(r.models),
        fuel_types: one(r.fuel_types),
        employees: one(r.employees),
      })),
    );
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

  function closeAsLost(id: string) {
    const submit = async (reason?: string) => {
      if (!reason?.trim()) return;
      try {
        await markEnquiryLost(id, reason);
        load();
      } catch (e: any) {
        Alert.alert("Could not update", e.message ?? "Something went wrong");
      }
    };
    if (Platform.OS === "ios") {
      Alert.prompt("Mark as lost", "Why was this enquiry lost?", submit);
    } else {
      Alert.alert("Mark as lost", "Why was this enquiry lost?", [
        { text: "Cancel", style: "cancel" },
        { text: "Bought another brand", onPress: () => submit("Bought another brand") },
        { text: "Not interested / postponed", onPress: () => submit("Not interested / postponed") },
      ]);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} className="flex-1 bg-white">
      <View className="flex-row flex-wrap gap-2 border-b border-slate-100 px-4 py-3">
        {FILTERS.map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            className={`rounded-full px-3 py-1.5 ${filter === f ? "bg-slate-900" : "bg-slate-100"}`}
          >
            <Text className={`text-sm capitalize ${filter === f ? "text-white" : "text-slate-700"}`}>{f}</Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerClassName="p-4 gap-3"
        ListHeaderComponent={
          <Pressable
            onPress={() => router.push("/(app)/enquiries/new")}
            className="mb-1 items-center rounded-lg bg-slate-900 py-3"
          >
            <Text className="font-medium text-white">+ New Enquiry</Text>
          </Pressable>
        }
        ListEmptyComponent={<Text className="mt-8 text-center text-slate-400">No enquiries here.</Text>}
        renderItem={({ item }) => (
          <View className="rounded-xl border border-slate-200 p-4">
            <View className="flex-row items-center justify-between">
              <Text className="font-medium text-slate-900">{item.customers?.name}</Text>
              <View className={`rounded-full px-2 py-0.5 ${STAGE_COLORS[item.stage] ?? "bg-slate-100"}`}>
                <Text className="text-xs font-medium">{STAGE_LABELS[item.stage] ?? item.stage}</Text>
              </View>
            </View>
            <Text className="mt-0.5 text-sm text-slate-500">{item.customers?.mobile}</Text>
            <Text className="mt-1 text-sm text-slate-700">
              {item.models?.name}
              {item.fuel_types ? ` · ${item.fuel_types.name}` : ""} · {purposeLabel(item.purpose_of_visit)}
            </Text>
            <Text className="mt-1 text-xs text-slate-400">
              <Text className={TEMPERATURE_COLORS[item.temperature]}>{item.temperature}</Text>
              {" · "}
              {new Date(item.created_at).toLocaleDateString()}
              {item.employees ? ` · ${item.employees.name}` : ""}
              {item.ctdms_enquiry_no ? ` · CTDMS ${item.ctdms_enquiry_no}` : " · Not yet in CTDMS"}
            </Text>
            {(item.stage === "open" || item.stage === "quoted") && (
              <View className="mt-3 flex-row gap-2">
                <Pressable
                  onPress={() => router.push(`/(app)/quotes/new?enquiryId=${item.id}`)}
                  className="flex-1 items-center rounded-lg border border-slate-300 py-2"
                >
                  <Text className="text-sm font-medium text-slate-700">
                    {item.stage === "open" ? "Make Quote" : "New Quote"}
                  </Text>
                </Pressable>
                <Pressable onPress={() => closeAsLost(item.id)} className="items-center rounded-lg px-3 py-2">
                  <Text className="text-sm text-slate-500">Mark lost</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
      />
    </SafeAreaView>
  );
}
