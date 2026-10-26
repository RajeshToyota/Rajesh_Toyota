import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, Pressable, ActivityIndicator, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { CheckboxRow } from "@/components/picker-list";
import { SignaturePad, type SignaturePadHandle } from "@/components/signature-pad";
import {
  DELIVERY_CHECKS,
  completeDelivery,
  loadAccount,
  loadBlockers,
  loadDelivery,
  saveChecklist,
  saveDeliverySignature,
  saveHandoverPhoto,
  type BookingAccount,
  type Delivery,
  type DeliveryCheck,
} from "@/lib/delivery";

// Blockers this screen resolves (as delivery_blockers() words them); the rest wait on the office.
const ON_SCREEN = new Set([
  "PDI done",
  "Accessories fitted and checked",
  "FASTag fitted",
  "Documents explained",
  "Vehicle demo done",
  "Handover photo",
  "Customer signature",
]);

const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${Math.round(Number(n)).toLocaleString("en-IN")}`);

export default function DeliveryScreen() {
  const { id: bookingId } = useLocalSearchParams<{ id: string }>();
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [blockers, setBlockers] = useState<string[] | null>(null);
  const [account, setAccount] = useState<BookingAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signatureRef = useRef<SignaturePadHandle>(null);

  const load = useCallback(async () => {
    try {
      const [d, b, a] = await Promise.all([loadDelivery(bookingId), loadBlockers(bookingId), loadAccount(bookingId)]);
      setDelivery(d);
      setBlockers(b);
      setAccount(a);
    } catch (e: any) {
      setError(e.message ?? "Could not load the delivery");
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

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Allow camera access to take the handover photo.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.6 });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    await run("photo", () => saveHandoverPhoto(bookingId, asset.uri, asset.mimeType));
  }

  if (!blockers) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        {error ? <Text className="px-6 text-center text-red-600">{error}</Text> : <ActivityIndicator />}
      </SafeAreaView>
    );
  }

  if (delivery?.status === "delivered") {
    return (
      <SafeAreaView edges={["bottom"]} className="flex-1 bg-white p-4">
        <View className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <Text className="font-medium text-emerald-900">Delivered</Text>
          <Text className="mt-1 text-sm text-emerald-800">
            {delivery.delivered_at ? new Date(delivery.delivered_at).toLocaleString("en-IN") : ""}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // The parts that are not on this screen: invoice, insurance, registration, money.
  const office = blockers.filter((b) => !ON_SCREEN.has(b));

  return (
    <SafeAreaView edges={["bottom"]} className="flex-1 bg-white">
      <ScrollView contentContainerClassName="p-4 gap-3" keyboardShouldPersistTaps="handled">
        {account && (
          <View className="rounded-xl border border-slate-200 p-4">
            <Text className="font-medium text-slate-900">Payments</Text>
            <Text className="mt-1 text-sm text-slate-600">
              Deal {inr(account.deal_amount)} · received {inr(account.cleared)}
              {Number(account.pending) > 0 ? ` · ${inr(account.pending)} awaiting clearance` : ""}
            </Text>
            <Text className={`mt-1 text-sm font-semibold ${Number(account.outstanding) > 0 ? "text-red-700" : "text-emerald-700"}`}>
              {Number(account.outstanding) > 0 ? `Outstanding ${inr(account.outstanding)}` : "Fully paid"}
            </Text>
          </View>
        )}

        {office.length > 0 && (
          <View className="rounded-xl border border-amber-300 bg-amber-50 p-4">
            <Text className="font-medium text-amber-900">Waiting on the office</Text>
            {office.map((b) => (
              <Text key={b} className="mt-1 text-sm text-amber-800">
                • {b}
              </Text>
            ))}
          </View>
        )}

        <Text className="mt-2 text-base font-semibold text-slate-900">Delivery checklist</Text>
        {DELIVERY_CHECKS.map((c) => (
          <CheckboxRow
            key={c.key}
            label={c.label}
            checked={!!delivery?.[c.key as DeliveryCheck]}
            onToggle={() => run(c.key, () => saveChecklist(bookingId, { [c.key]: !delivery?.[c.key as DeliveryCheck] }))}
          />
        ))}

        <Pressable onPress={takePhoto} className="rounded-xl border border-slate-200 p-4">
          <Text className="font-medium text-slate-900">
            {delivery?.handover_photo_path ? "✓ Handover photo taken — tap to retake" : "Take the handover photo"}
          </Text>
          {busy === "photo" && <ActivityIndicator className="mt-2" />}
        </Pressable>

        <Text className="mt-2 font-medium text-slate-900">
          Customer signature {delivery?.customer_signature_path ? "✓ (sign again to replace)" : ""}
        </Text>
        <SignaturePad ref={signatureRef} height={150} />
        <Pressable
          onPress={async () => {
            if (!signatureRef.current || signatureRef.current.isEmpty()) {
              setError("Ask the customer to sign first.");
              return;
            }
            const uri = await signatureRef.current.captureAsPngUri();
            await run("signature", () => saveDeliverySignature(bookingId, uri));
          }}
          className="items-center rounded-lg border border-slate-300 py-3"
        >
          {busy === "signature" ? <ActivityIndicator /> : <Text className="font-medium text-slate-700">Save signature</Text>}
        </Pressable>

        <Pressable
          disabled={blockers.length > 0 || busy !== null}
          onPress={() => run("complete", () => completeDelivery(bookingId))}
          className={`mt-2 items-center rounded-lg py-3 ${blockers.length === 0 ? "bg-emerald-600" : "bg-slate-300"}`}
        >
          {busy === "complete" ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text className="font-medium text-white">
              {blockers.length === 0 ? "Mark Delivered" : `${blockers.length} item${blockers.length > 1 ? "s" : ""} still needed`}
            </Text>
          )}
        </Pressable>
        {error && <Text className="text-sm text-red-600">{error}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}
