import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, Pressable, TextInput, ActivityIndicator, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { supabase } from "@/lib/supabase";
import {
  CANCEL_REASONS,
  holdBooking,
  loadHoldCancel,
  requestCancellation,
  resumeBooking,
  type Cancellation,
  type Hold,
  type Refund,
} from "@/lib/hold-cancel";

const inr = (n: number) => `₹${Math.round(Number(n)).toLocaleString("en-IN")}`;
const fmt = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-IN") : "—");

export default function HoldCancelScreen() {
  const { id: bookingId } = useLocalSearchParams<{ id: string }>();
  const [status, setStatus] = useState<string | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [cancellations, setCancellations] = useState<Cancellation[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [holdReason, setHoldReason] = useState("");
  const [resumeDate, setResumeDate] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [letter, setLetter] = useState<{ uri: string; mime?: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ data: b }, hc] = await Promise.all([
        supabase.from("bookings").select("status").eq("id", bookingId).single(),
        loadHoldCancel(bookingId),
      ]);
      setStatus(b?.status ?? null);
      setHold(hc.hold);
      setCancellations(hc.cancellations);
      setRefunds(hc.refunds);
      setLoaded(true);
    } catch (e: any) {
      setError(e.message ?? "Could not load");
      setLoaded(true);
    }
  }, [bookingId]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e.message ?? "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  async function photographLetter() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Allow camera access to photograph the written request.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.6 });
    if (!result.canceled && result.assets?.[0]) setLetter({ uri: result.assets[0].uri, mime: result.assets[0].mimeType });
  }

  if (!loaded) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  const pending = cancellations.find((c) => c.status === "pending");
  const open = status !== null && !["delivered", "cancelled"].includes(status);

  return (
    <SafeAreaView edges={["bottom"]} className="flex-1 bg-white">
      <ScrollView contentContainerClassName="p-4 gap-3" keyboardShouldPersistTaps="handled">
        {status === "cancelled" && (
          <View className="rounded-xl border border-red-200 bg-red-50 p-4">
            <Text className="font-medium text-red-900">This booking is cancelled</Text>
          </View>
        )}

        {refunds.length > 0 && (
          <View className="rounded-xl border border-slate-200 p-4">
            <Text className="font-medium text-slate-900">Refunds</Text>
            {refunds.map((r) => (
              <Text key={r.id} className="mt-1 text-sm text-slate-600">
                {inr(r.amount)} to {r.payee === "financier" ? r.payee_name : "the customer"} —{" "}
                {r.status === "paid" ? `paid, cheque ${r.cheque_no} on ${fmt(r.paid_on)}` : `due by ${fmt(r.due_date)}`}
              </Text>
            ))}
          </View>
        )}

        {open && (
          <View className="rounded-xl border border-slate-200 p-4">
            <Text className="font-medium text-slate-900">Hold</Text>
            {hold ? (
              <>
                <Text className="mt-1 text-sm text-amber-800">
                  On hold since {fmt(hold.held_at)}: {hold.reason}
                  {hold.expected_resume_date ? ` (expected back ${fmt(hold.expected_resume_date)})` : ""}
                </Text>
                <Pressable
                  onPress={() => run("resume", () => resumeBooking(bookingId))}
                  className="mt-3 items-center rounded-lg bg-slate-900 py-3"
                >
                  {busy === "resume" ? <ActivityIndicator color="#fff" /> : <Text className="font-medium text-white">Resume booking</Text>}
                </Pressable>
              </>
            ) : status === "ready_to_invoice" ? (
              <Text className="mt-1 text-sm text-slate-500">Sent for billing: ask the Outlet Head to pull it back before a hold.</Text>
            ) : (
              <>
                <Text className="mt-1 text-sm text-slate-500">
                  Any allotted car is released and the booking leaves the FIFO queue until resumed.
                </Text>
                <TextInput
                  value={holdReason}
                  onChangeText={setHoldReason}
                  placeholder="Reason"
                  className="mt-2 rounded-lg border border-slate-300 px-3 py-2.5"
                />
                <TextInput
                  value={resumeDate}
                  onChangeText={setResumeDate}
                  placeholder="Expected back (YYYY-MM-DD, optional)"
                  className="mt-2 rounded-lg border border-slate-300 px-3 py-2.5"
                />
                <Pressable
                  disabled={!holdReason.trim() || busy !== null}
                  onPress={() =>
                    Alert.alert("Put on hold?", "Any allotted car will be released.", [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Put on hold",
                        onPress: () =>
                          run("hold", async () => {
                            await holdBooking(bookingId, holdReason.trim(), resumeDate.trim() || null);
                            setHoldReason("");
                            setResumeDate("");
                          }),
                      },
                    ])
                  }
                  className={`mt-3 items-center rounded-lg py-3 ${holdReason.trim() ? "bg-amber-600" : "bg-slate-300"}`}
                >
                  {busy === "hold" ? <ActivityIndicator color="#fff" /> : <Text className="font-medium text-white">Put on hold</Text>}
                </Pressable>
              </>
            )}
          </View>
        )}

        <View className="rounded-xl border border-slate-200 p-4">
          <Text className="font-medium text-slate-900">Cancellation</Text>
          {cancellations.map((c) => (
            <Text key={c.id} className="mt-1 text-sm text-slate-600">
              {fmt(c.requested_at)} · {c.status === "pending" ? "waiting for the Outlet Head" : c.status} ·{" "}
              {CANCEL_REASONS.find((r) => r.id === c.reason_category)?.label}: {c.reason}
              {c.decision_note ? ` — ${c.decision_note}` : ""}
            </Text>
          ))}
          {open && !pending && (
            <>
              <Text className="mt-2 text-sm text-slate-500">Reason</Text>
              <View className="mt-1 flex-row flex-wrap gap-2">
                {CANCEL_REASONS.map((r) => (
                  <Pressable
                    key={r.id}
                    onPress={() => setCategory(r.id)}
                    className={`rounded-lg border px-3 py-2 ${category === r.id ? "border-slate-900 bg-slate-900" : "border-slate-300"}`}
                  >
                    <Text className={category === r.id ? "text-white" : "text-slate-700"}>{r.label}</Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                value={reason}
                onChangeText={setReason}
                placeholder="The customer's reason, in their words"
                multiline
                className="mt-2 min-h-[64px] rounded-lg border border-slate-300 px-3 py-2.5"
              />
              <Pressable onPress={photographLetter} className="mt-2 rounded-lg border border-slate-300 px-3 py-2.5">
                <Text className="text-slate-700">
                  {letter ? "✓ Written request photographed — tap to retake" : "Photograph the customer's written request"}
                </Text>
              </Pressable>
              <Pressable
                disabled={!category || !reason.trim() || busy !== null}
                onPress={() =>
                  run("cancel", async () => {
                    await requestCancellation({ bookingId, reasonCategory: category!, reason: reason.trim(), letterUri: letter?.uri, letterMime: letter?.mime });
                    setReason("");
                    setLetter(null);
                  })
                }
                className={`mt-3 items-center rounded-lg py-3 ${category && reason.trim() ? "bg-red-600" : "bg-slate-300"}`}
              >
                {busy === "cancel" ? <ActivityIndicator color="#fff" /> : <Text className="font-medium text-white">Request cancellation</Text>}
              </Pressable>
              <Text className="mt-2 text-xs text-slate-500">
                The Outlet Head approves it. The booking amount is refunded by cheque within 7 working days; loan money goes back to
                the financier.
              </Text>
            </>
          )}
        </View>

        {error && <Text className="text-sm text-red-600">{error}</Text>}
        <Pressable onPress={() => router.back()} className="items-center py-2">
          <Text className="text-sm text-slate-500 underline">Back to the booking</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
