import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, Pressable, ActivityIndicator, Alert, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { PickerList } from "@/components/picker-list";
import {
  APPLICANT_TYPES,
  FINANCE_STAGES,
  addFinancePhoto,
  financeStageLabel,
  loadCases,
  loadDocTypes,
  loadFinanceDocuments,
  loadFinanciers,
  markFinanceDocOnPaper,
  openCase,
  removeFinanceDocument,
  type ApplicantType,
  type FinanceCase,
  type FinanceDocType,
  type FinanceDocument,
} from "@/lib/finance";

const inr = (n: number | null) => (n == null ? "—" : `₹${Math.round(Number(n)).toLocaleString("en-IN")}`);

// The consultant's side of a finance case: open it, collect the documents for the applicant's
// checklist, and follow the stages the Finance Executive moves it through.
export default function FinanceScreen() {
  const { id: bookingId } = useLocalSearchParams<{ id: string }>();
  const [cases, setCases] = useState<FinanceCase[] | null>(null);
  const [docTypes, setDocTypes] = useState<FinanceDocType[]>([]);
  const [documents, setDocuments] = useState<FinanceDocument[]>([]);
  const [financiers, setFinanciers] = useState<{ id: string; name: string }[]>([]);
  const [financierId, setFinancierId] = useState<string | null>(null);
  const [applicantType, setApplicantType] = useState<ApplicantType | null>(null);
  const [financeType, setFinanceType] = useState<"in_house" | "own">("in_house");
  const [otherLabel, setOtherLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, t, f] = await Promise.all([loadCases(bookingId), loadDocTypes(), loadFinanciers()]);
      setCases(c);
      setDocTypes(t);
      setFinanciers(f);
      const live = c.find((x) => x.status !== "rejected");
      setDocuments(live ? await loadFinanceDocuments(live.id) : []);
    } catch (e: any) {
      setError(e.message ?? "Could not load the finance case");
    }
  }, [bookingId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!cases) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        {error ? <Text className="px-6 text-center text-red-600">{error}</Text> : <ActivityIndicator />}
      </SafeAreaView>
    );
  }

  const live = cases.find((c) => c.status !== "rejected") ?? null;
  const rejected = cases.filter((c) => c.status === "rejected");
  const editable = live && live.status !== "disbursed";

  async function addPhoto(docType: string, source: "camera" | "library") {
    if (!live) return;
    const permission =
      source === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", `Allow ${source === "camera" ? "camera" : "photo"} access to attach documents.`);
      return;
    }
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.6 };
    const result = source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    if (result.canceled || !result.assets?.[0]) return;
    setBusy(docType);
    setError(null);
    try {
      await addFinancePhoto({
        caseId: live.id,
        bookingId,
        docType,
        label: docType === "other" ? otherLabel : undefined,
        localUri: result.assets[0].uri,
        mimeType: result.assets[0].mimeType,
      });
      setDocuments(await loadFinanceDocuments(live.id));
    } catch (e: any) {
      setError(e.message ?? "Upload failed");
    } finally {
      setBusy(null);
    }
  }

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

  // ---- No live case yet: open one.
  if (!live) {
    return (
      <SafeAreaView edges={["bottom"]} className="flex-1 bg-white">
        <ScrollView contentContainerClassName="p-4 gap-3">
          {rejected.map((c) => (
            <View key={c.id} className="rounded-xl border border-red-200 bg-red-50 p-3">
              <Text className="font-medium text-red-900">{c.financiers?.name} rejected</Text>
              <Text className="mt-1 text-sm text-red-800">{c.rejection_reason}</Text>
            </View>
          ))}
          <Text className="text-base font-semibold text-slate-900">Open a finance case</Text>
          <Text className="text-sm font-medium text-slate-700">Finance</Text>
          <View className="flex-row gap-2">
            {(["in_house", "own"] as const).map((t) => (
              <Pressable
                key={t}
                onPress={() => setFinanceType(t)}
                className={`rounded-lg border px-4 py-2.5 ${financeType === t ? "border-slate-900 bg-slate-900" : "border-slate-300"}`}
              >
                <Text className={financeType === t ? "font-medium text-white" : "text-slate-700"}>
                  {t === "in_house" ? "In-house" : "Own finance"}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text className="text-sm font-medium text-slate-700">Applicant</Text>
          <View className="flex-row flex-wrap gap-2">
            {APPLICANT_TYPES.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => setApplicantType(t.id)}
                className={`rounded-lg border px-4 py-2.5 ${applicantType === t.id ? "border-slate-900 bg-slate-900" : "border-slate-300"}`}
              >
                <Text className={applicantType === t.id ? "font-medium text-white" : "text-slate-700"}>{t.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text className="text-sm font-medium text-slate-700">Financier</Text>
          <PickerList
            options={financiers.map((f) => ({ id: f.id, label: f.name }))}
            selectedId={financierId}
            onSelect={setFinancierId}
          />
          <Pressable
            disabled={!financierId || !applicantType || busy !== null}
            onPress={() => run("open", () => openCase(bookingId, financierId!, applicantType!, financeType))}
            className={`items-center rounded-lg py-3 ${financierId && applicantType ? "bg-slate-900" : "bg-slate-300"}`}
          >
            {busy === "open" ? <ActivityIndicator color="#fff" /> : <Text className="font-medium text-white">Open Finance Case</Text>}
          </Pressable>
          {error && <Text className="text-sm text-red-600">{error}</Text>}
        </ScrollView>
      </SafeAreaView>
    );
  }

  const stageIndex = FINANCE_STAGES.findIndex((s) => s.id === live.status);
  const checklist = docTypes.filter((t) => t.applicant_types.includes(live.applicant_type));
  const missingRequired = checklist.filter((t) => t.required_for.includes(live.applicant_type) && !documents.some((d) => d.doc_type === t.id));

  return (
    <SafeAreaView edges={["bottom"]} className="flex-1 bg-white">
      <ScrollView contentContainerClassName="p-4 gap-3" keyboardShouldPersistTaps="handled">
        <View className="rounded-xl border border-slate-200 p-4">
          <Text className="font-semibold text-slate-900">
            {live.financiers?.name} · {live.finance_type === "own" ? "Own finance" : "In-house"} ·{" "}
            {APPLICANT_TYPES.find((t) => t.id === live.applicant_type)?.label}
          </Text>
          <View className="mt-3 flex-row gap-1">
            {FINANCE_STAGES.map((s, i) => (
              <View key={s.id} className="flex-1">
                <View className={`h-1.5 rounded-full ${i <= stageIndex ? "bg-emerald-600" : "bg-slate-200"}`} />
                <Text className={`mt-1 text-[10px] ${i === stageIndex ? "font-semibold text-slate-900" : "text-slate-400"}`}>{s.label}</Text>
              </View>
            ))}
          </View>
          {live.loan_amount != null && (
            <Text className="mt-3 text-sm text-slate-600">
              Loan {inr(live.loan_amount)} · {live.tenure_months} months @ {live.roi_percent}% · EMI {inr(live.emi)}
            </Text>
          )}
          {live.do_number && (
            <Text className="mt-1 text-sm text-slate-600">
              DO {live.do_number} · {inr(live.do_amount)}
            </Text>
          )}
          {live.disbursed_amount != null && <Text className="mt-1 text-sm text-slate-600">Disbursed {inr(live.disbursed_amount)}</Text>}
          <Text className="mt-2 text-xs text-slate-400">The Finance Executive updates the terms and stages.</Text>
        </View>

        <Text className="mt-2 text-base font-semibold text-slate-900">Documents</Text>
        {live.status === "docs_pending" && (
          <Text className={`text-sm ${missingRequired.length ? "text-amber-700" : "text-emerald-700"}`}>
            {missingRequired.length
              ? `${missingRequired.length} required document${missingRequired.length > 1 ? "s" : ""} still needed before login.`
              : "All required documents are in. The Finance Executive can log the case in."}
          </Text>
        )}
        {checklist.map((t) => {
          const docs = documents.filter((d) => d.doc_type === t.id);
          const required = t.required_for.includes(live.applicant_type);
          return (
            <View key={t.id} className={`rounded-xl border p-3 ${docs.length ? "border-emerald-200 bg-emerald-50" : "border-slate-200"}`}>
              <Text className="font-medium text-slate-900">
                {docs.length ? "✓ " : ""}
                {t.label}
                {required ? " *" : ""}
              </Text>
              {docs.map((d) => (
                <View key={d.id} className="mt-1 flex-row items-center justify-between">
                  <Text className="text-xs text-slate-600">
                    {d.collected_on_paper ? "Collected on paper" : "Photo attached"}
                    {d.label ? ` — ${d.label}` : ""}
                  </Text>
                  {editable && (
                    <Pressable onPress={() => run(`rm-${d.id}`, () => removeFinanceDocument(d))}>
                      <Text className="text-xs text-red-600 underline">Remove</Text>
                    </Pressable>
                  )}
                </View>
              ))}
              {t.id === "other" && editable && (
                <TextInput
                  value={otherLabel}
                  onChangeText={setOtherLabel}
                  placeholder="Which document?"
                  className="mt-2 rounded-lg border border-slate-300 px-3 py-2"
                />
              )}
              {editable &&
                (busy === t.id ? (
                  <ActivityIndicator className="mt-2" />
                ) : (
                  <View className="mt-2 flex-row gap-2">
                    <Pressable onPress={() => addPhoto(t.id, "camera")} className="rounded-lg border border-slate-300 px-3 py-2">
                      <Text className="text-sm text-slate-700">Camera</Text>
                    </Pressable>
                    <Pressable onPress={() => addPhoto(t.id, "library")} className="rounded-lg border border-slate-300 px-3 py-2">
                      <Text className="text-sm text-slate-700">Gallery</Text>
                    </Pressable>
                    {!docs.some((d) => d.collected_on_paper) && (
                      <Pressable
                        onPress={() => run(`paper-${t.id}`, () => markFinanceDocOnPaper(live.id, t.id, t.id === "other" ? otherLabel : undefined))}
                        className="rounded-lg border border-slate-300 px-3 py-2"
                      >
                        <Text className="text-sm text-slate-700">On paper</Text>
                      </Pressable>
                    )}
                  </View>
                ))}
            </View>
          );
        })}

        {rejected.length > 0 && (
          <View className="mt-2 gap-2">
            <Text className="text-xs font-semibold uppercase text-slate-400">Earlier cases</Text>
            {rejected.map((c) => (
              <Text key={c.id} className="text-sm text-slate-500">
                {c.financiers?.name}: {financeStageLabel(c.status)} — {c.rejection_reason}
              </Text>
            ))}
          </View>
        )}
        {error && <Text className="text-sm text-red-600">{error}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}
