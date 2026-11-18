import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { loadChecklist, recordPdi, uploadPdiPhoto, type ChecklistItem } from "@/lib/pdi";

const CHOICES = [
  { id: "ok", label: "OK", on: "bg-emerald-600" },
  { id: "fail", label: "Fail", on: "bg-red-600" },
  { id: "na", label: "N/A", on: "bg-slate-500" },
] as const;

// The PDI checklist on the phone: every item ok / fail / not applicable, remarks (needed for a fail)
// and photos, recorded through record_pdi_result.
export default function PdiChecklistScreen() {
  const { inspectionId, bookingId } = useLocalSearchParams<{ inspectionId: string; bookingId: string }>();
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [remarks, setRemarks] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadChecklist()
      .then((list) => {
        setItems(list);
        setResults(Object.fromEntries(list.map((i) => [i.code, "ok"])));
      })
      .catch((e) => Alert.alert("Could not load the checklist", e.message));
  }, []);

  async function addPhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Allow camera access to add PDI photos.");
      return;
    }
    const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.6 });
    if (shot.canceled || !shot.assets?.[0]) return;
    setBusy(true);
    try {
      const path = await uploadPdiPhoto(bookingId, shot.assets[0].uri, shot.assets[0].mimeType);
      setPhotos((p) => [...p, path]);
    } catch (e: any) {
      Alert.alert("Upload failed", e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    try {
      const outcome = await recordPdi(inspectionId, results, remarks.trim(), photos);
      Alert.alert(outcome === "passed" ? "PDI passed" : "PDI failed", outcome === "passed" ? "Move the car to the delivery bay." : "Take the car to the workshop.");
      router.back();
    } catch (e: any) {
      Alert.alert("Not recorded", e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!items) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <ActivityIndicator />
      </SafeAreaView>
    );
  }
  const sections = [...new Set(items.map((i) => i.section))];
  const failed = Object.values(results).includes("fail");

  return (
    <SafeAreaView edges={["bottom"]} className="flex-1 bg-white">
      <ScrollView contentContainerClassName="p-4 gap-4">
        {sections.map((s) => (
          <View key={s} className="gap-2">
            <Text className="text-sm font-semibold uppercase text-slate-500">{s}</Text>
            {items
              .filter((i) => i.section === s)
              .map((i) => (
                <View key={i.code} className="rounded-lg border border-slate-200 p-3">
                  <Text className="text-sm text-slate-900">{i.label}</Text>
                  <View className="mt-2 flex-row gap-2">
                    {CHOICES.map((c) => (
                      <Pressable
                        key={c.id}
                        onPress={() => setResults((r) => ({ ...r, [i.code]: c.id }))}
                        className={`rounded-full px-3 py-1 ${results[i.code] === c.id ? c.on : "bg-slate-100"}`}
                      >
                        <Text className={`text-xs ${results[i.code] === c.id ? "text-white" : "text-slate-700"}`}>{c.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ))}
          </View>
        ))}
        <TextInput
          value={remarks}
          onChangeText={setRemarks}
          placeholder={failed ? "What failed (needed)" : "Remarks"}
          multiline
          className="min-h-20 rounded-lg border border-slate-300 p-3 text-sm"
        />
        <Pressable className="rounded-lg border border-slate-300 px-3 py-2" onPress={addPhoto} disabled={busy}>
          <Text className="text-center text-sm text-slate-800">Add a photo ({photos.length})</Text>
        </Pressable>
        <Pressable className={`rounded-lg px-3 py-3 ${failed ? "bg-red-600" : "bg-emerald-600"}`} onPress={submit} disabled={busy}>
          <Text className="text-center text-base font-medium text-white">{busy ? "Saving…" : failed ? "Record as failed" : "Record as passed"}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
