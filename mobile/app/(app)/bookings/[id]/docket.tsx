import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { View, Text, TextInput, Pressable, ActivityIndicator, Alert, Switch, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useAuth } from "@/contexts/auth-context";
import { supabase } from "@/lib/supabase";
import { WizardShell } from "@/components/wizard-shell";
import { CheckboxRow } from "@/components/picker-list";
import { SignaturePad, type SignaturePadHandle } from "@/components/signature-pad";
import {
  DOC_TYPES,
  addDocumentPhoto,
  completeDocket,
  fileAsDataUrl,
  loadAccessoryOptions,
  loadBooking,
  loadDocuments,
  markCollectedOnPaper,
  openDocket,
  removeDocument,
  saveDocket,
  saveSignature,
  uploadDocketPdf,
  type AccessoryOption,
  type Docket,
  type DocketBooking,
  type DocketDocument,
  type Referral,
} from "@/lib/docket";
import {
  ACCESSORY_TERMS,
  DATA_CONSENT_YES,
  MORE_ORDER_TERMS,
  ORDER_TERMS,
  REFUND_TERMS,
  RTO_DISCLAIMER,
  RTO_NOTE,
  buildDocketHtml,
  generateDocketPdf,
  shareDocketPdf,
} from "@/lib/docket-document";

const STEPS = [
  "Contact Details",
  "Registration & Delivery",
  "Accessories Order",
  "Documents",
  "Programmes & Referrals",
  "Terms & Signatures",
  "Review & Complete",
] as const;

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const toInt = (s: string) => (s.trim() === "" ? null : Math.max(1, Math.round(Number(s)) || 1));
const blank = (s: string | null | undefined) => (s && s.trim() !== "" ? s.trim() : null);

function Field({
  label,
  value,
  onChange,
  keyboardType,
  placeholder,
  multiline,
}: {
  label: string;
  value: string | number | null | undefined;
  onChange: (v: string) => void;
  keyboardType?: "default" | "numeric" | "phone-pad" | "email-address";
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <View>
      <Text className="mb-1 text-sm font-medium text-slate-700">{label}</Text>
      <TextInput
        value={value == null ? "" : String(value)}
        onChangeText={onChange}
        keyboardType={keyboardType}
        placeholder={placeholder}
        multiline={multiline}
        autoCapitalize={keyboardType === "email-address" ? "none" : "sentences"}
        className={`rounded-lg border border-slate-300 px-4 py-3 text-base ${multiline ? "min-h-[72px]" : ""}`}
      />
    </View>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <View>
      <Text className="mb-1 text-sm font-medium text-slate-700">{label}</Text>
      <View className="flex-row flex-wrap gap-2">
        {options.map((o) => (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            className={`rounded-lg border px-4 py-2.5 ${value === o.id ? "border-slate-900 bg-slate-900" : "border-slate-300 bg-white"}`}
          >
            <Text className={value === o.id ? "font-medium text-white" : "text-slate-700"}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <Text className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">{children}</Text>;
}

function Terms({ title, items, ordered }: { title?: string; items: string[]; ordered?: boolean }) {
  return (
    <View className="gap-1">
      {title && <Text className="mt-2 font-medium text-slate-800">{title}</Text>}
      {items.map((t, i) => (
        <Text key={i} className="text-xs leading-5 text-slate-600">
          {ordered ? `${i + 1}) ` : "• "}
          {t}
        </Text>
      ))}
    </View>
  );
}

export default function WelcomeDocketScreen() {
  const { id: bookingId } = useLocalSearchParams<{ id: string }>();
  const { employee } = useAuth();
  const [booking, setBooking] = useState<DocketBooking | null>(null);
  const [docket, setDocket] = useState<Docket | null>(null);
  const [form, setForm] = useState<Docket | null>(null);
  const [documents, setDocuments] = useState<DocketDocument[]>([]);
  const [accessoryOptions, setAccessoryOptions] = useState<AccessoryOption[]>([]);
  const [accessorySearch, setAccessorySearch] = useState("");
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [uploadingType, setUploadingType] = useState<string | null>(null);
  const [otherLabel, setOtherLabel] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const customerSigRef = useRef<SignaturePadHandle>(null);
  const consultantSigRef = useRef<SignaturePadHandle>(null);

  const load = useCallback(async () => {
    try {
      const b = await loadBooking(bookingId);
      const d = await openDocket(bookingId);
      setBooking(b);
      setDocket(d);
      setForm(d);
      setDocuments(await loadDocuments(d.id));
      if (b.variants?.model_id) setAccessoryOptions(await loadAccessoryOptions(b.variants.model_id));
    } catch (e: any) {
      setLoadError(e.message ?? "Could not open the Welcome Docket");
    }
  }, [bookingId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loadError) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white px-6">
        <Text className="text-center text-red-600">{loadError}</Text>
      </SafeAreaView>
    );
  }
  if (!booking || !docket || !form) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  const set = <K extends keyof Docket>(key: K, value: Docket[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));
  const isFinance = /financ/i.test(booking.mode_of_purchase ?? "");

  async function buildAndSharePdf(current: Docket) {
    if (!booking) return;
    const [customerSignature, consultantSignature, docs] = await Promise.all([
      current.customer_signature_path ? fileAsDataUrl(current.customer_signature_path) : null,
      current.consultant_signature_path ? fileAsDataUrl(current.consultant_signature_path) : null,
      loadDocuments(current.id),
    ]);
    const uri = await generateDocketPdf(
      buildDocketHtml({ booking, docket: current, documents: docs, customerSignature, consultantSignature }),
    );
    if (current.status === "complete" && !current.pdf_storage_path) {
      try {
        await uploadDocketPdf(current.id, booking.id, uri);
      } catch {
        // The customer still gets the PDF; the stored copy can be made the next time it is shared.
      }
    }
    await shareDocketPdf(uri);
  }

  // ---- A complete docket is read-only: share it, or (Outlet Head and above) reopen it.
  if (docket.status === "complete") {
    const canReopen = employee?.roleRank != null && employee.roleRank <= 2;
    return (
      <SafeAreaView edges={["bottom"]} className="flex-1 bg-white">
        <ScrollView contentContainerClassName="p-4 gap-4" keyboardShouldPersistTaps="handled">
          <View className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <Text className="font-medium text-emerald-900">Welcome Docket complete</Text>
            <Text className="mt-1 text-sm text-emerald-800">
              Completed {docket.completed_at ? new Date(docket.completed_at).toLocaleString("en-IN") : ""} for{" "}
              {booking.customer_name}.
            </Text>
          </View>
          <Pressable
            disabled={busy}
            onPress={async () => {
              setBusy(true);
              setError(null);
              try {
                await buildAndSharePdf(docket);
                const { data } = await supabase.from("welcome_dockets").select("*").eq("id", docket.id).single();
                if (data) setDocket(data as Docket);
              } catch (e: any) {
                setError(e.message ?? "Could not create the PDF");
              } finally {
                setBusy(false);
              }
            }}
            className="items-center rounded-lg bg-slate-900 py-3"
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text className="font-medium text-white">Share Docket PDF</Text>}
          </Pressable>
          {error && <Text className="text-sm text-red-600">{error}</Text>}
          {canReopen && (
            <View className="mt-4 gap-2 rounded-xl border border-slate-200 p-4">
              <Text className="font-medium text-slate-900">Reopen for changes</Text>
              <Field label="Reason" value={reopenReason} onChange={setReopenReason} />
              <Pressable
                disabled={!reopenReason.trim() || busy}
                onPress={async () => {
                  setBusy(true);
                  const { error: e } = await supabase.rpc("reopen_welcome_docket", {
                    p_docket_id: docket.id,
                    p_reason: reopenReason,
                  });
                  setBusy(false);
                  if (e) return setError(e.message);
                  setReopenReason("");
                  await load();
                }}
                className={`items-center rounded-lg border py-3 ${reopenReason.trim() ? "border-slate-900" : "border-slate-200"}`}
              >
                <Text className="font-medium text-slate-900">Reopen Docket</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Fields each step saves.
  function stepPatch(i: number): Partial<Docket> {
    if (!form) return {};
    switch (i) {
      case 0:
        return {
          mobile: blank(form.mobile)?.replace(/\D/g, "").slice(-10) ?? null,
          alt_phone: blank(form.alt_phone),
          email: blank(form.email),
          communication_address: blank(form.communication_address),
          address_type: form.address_type,
          pin: blank(form.pin),
        };
      case 1:
        return {
          father_or_husband_name: blank(form.father_or_husband_name),
          registration_address: blank(form.registration_address),
          hypothecated_to: blank(form.hypothecated_to),
          insurance_coverage: form.insurance_coverage,
          registration_period: form.registration_period,
          rto_location: blank(form.rto_location),
          registration_use: form.registration_use,
          permit_type: form.registration_use === "commercial" ? form.permit_type : null,
          special_registration_number: blank(form.special_registration_number),
          registration_date: blank(form.registration_date),
          // Typed as local (IST) time; stored with its offset so it isn't read as UTC.
          delivery_at: blank(form.delivery_at)?.replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/, "$1T$2:00+05:30") ?? null,
          delivery_place: blank(form.delivery_place),
          temp_registration_validity_days: form.temp_registration_validity_days,
          rc_days: form.rc_days,
          hsrp_days: form.hsrp_days,
        };
      case 2:
        return {
          accessory_order_items: form.accessory_order_items.map((a) => ({ accessory_id: a.accessory_id, qty: a.qty })),
          accessories_payment_mode: form.accessories_payment_mode,
        };
      case 4:
        return {
          utrust_interest: form.utrust_interest,
          tconnect_interest: form.tconnect_interest,
          extended_warranty_interest: form.extended_warranty_interest,
          smiles_interest: form.smiles_interest,
          referrals: form.referrals.filter((r) => Object.values(r).some((v) => v && String(v).trim())),
        };
      case 5:
        return { terms_accepted: form.terms_accepted, rto_terms_accepted: form.rto_terms_accepted };
      default:
        return {};
    }
  }

  async function saveStep(i: number): Promise<Docket | null> {
    if (!docket || !booking) return null;
    let saved = docket;
    const patch = stepPatch(i);
    if (Object.keys(patch).length > 0) saved = await saveDocket(docket.id, patch);
    if (i === 5) {
      if (customerSigRef.current && !customerSigRef.current.isEmpty()) {
        saved = await saveSignature(docket.id, booking.id, "customer", await customerSigRef.current.captureAsPngUri());
      }
      if (consultantSigRef.current && !consultantSigRef.current.isEmpty()) {
        saved = await saveSignature(docket.id, booking.id, "consultant", await consultantSigRef.current.captureAsPngUri());
      }
    }
    setDocket(saved);
    setForm(saved);
    return saved;
  }

  async function next() {
    setBusy(true);
    setError(null);
    try {
      await saveStep(step);
      if (step === STEPS.length - 2) {
        const r = await completeDocket(docket!.id);
        setMissing(r.missing);
        if (r.completed) {
          const { data } = await supabase.from("welcome_dockets").select("*").eq("id", docket!.id).single();
          if (data) {
            setDocket(data as Docket);
            setForm(data as Docket);
          }
          return;
        }
      }
      setStep(Math.min(step + 1, STEPS.length - 1));
    } catch (e: any) {
      setError(e.message ?? "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function back() {
    if (step === 0) return router.back();
    setError(null);
    setStep(step - 1);
  }

  async function addPhoto(docType: string, source: "camera" | "library") {
    if (!docket || !booking) return;
    const permission =
      source === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", `Allow ${source === "camera" ? "camera" : "photo"} access to attach documents.`);
      return;
    }
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.6 };
    const result = source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    if (result.canceled || !result.assets?.[0]) return;
    setUploadingType(docType);
    setError(null);
    try {
      await addDocumentPhoto({
        docketId: docket.id,
        bookingId: booking.id,
        docType,
        label: docType === "other" ? otherLabel : undefined,
        localUri: result.assets[0].uri,
        mimeType: result.assets[0].mimeType,
      });
      setDocuments(await loadDocuments(docket.id));
    } catch (e: any) {
      setError(e.message ?? "Upload failed");
    } finally {
      setUploadingType(null);
    }
  }

  const onReview = step === STEPS.length - 1;
  const selectedAccessoryIds = new Set(form.accessory_order_items.map((a) => a.accessory_id));
  const accessoryMatches = accessorySearch.trim()
    ? accessoryOptions
        .filter((a) => !selectedAccessoryIds.has(a.id))
        .filter((a) => `${a.name} ${a.part_no ?? ""} ${a.category ?? ""}`.toLowerCase().includes(accessorySearch.trim().toLowerCase()))
        .slice(0, 12)
    : [];
  const localAccessoryTotal = form.accessory_order_items.reduce((sum, a) => {
    const price = a.price ?? accessoryOptions.find((o) => o.id === a.accessory_id)?.price ?? 0;
    return sum + price * a.qty;
  }, 0);

  return (
    <WizardShell
      title={STEPS[step]}
      stepIndex={step}
      stepCount={STEPS.length}
      onBack={back}
      onNext={next}
      hideNext={onReview}
      nextLoading={busy}
      nextLabel={step === STEPS.length - 2 ? "Save & Complete" : "Save & Continue"}
    >
      <View className="gap-3">
        {docket.reopened_reason && (
          <View className="rounded-xl border border-amber-300 bg-amber-50 p-3">
            <Text className="text-sm text-amber-900">Reopened: {docket.reopened_reason}</Text>
          </View>
        )}

        {step === 0 && (
          <>
            <Text className="text-sm text-slate-500">
              {booking.customer_name} — as on the Order Booking Form.
            </Text>
            <Field label="Mobile No. *" value={form.mobile} onChange={(v) => set("mobile", v)} keyboardType="phone-pad" />
            <Field label="Phone No." value={form.alt_phone} onChange={(v) => set("alt_phone", v)} keyboardType="phone-pad" />
            <Field label="Email ID" value={form.email} onChange={(v) => set("email", v)} keyboardType="email-address" />
            <Field
              label="Communication Address *"
              value={form.communication_address}
              onChange={(v) => set("communication_address", v)}
              multiline
            />
            <Choice
              label="Address is"
              value={form.address_type}
              options={[
                { id: "residence", label: "Residence" },
                { id: "office", label: "Office" },
              ]}
              onChange={(v) => set("address_type", v)}
            />
            <Field label="PIN *" value={form.pin} onChange={(v) => set("pin", v)} keyboardType="numeric" />
          </>
        )}

        {step === 1 && (
          <>
            <Field
              label="Father / Husband Name *"
              value={form.father_or_husband_name}
              onChange={(v) => set("father_or_husband_name", v)}
            />
            <Field
              label="Registration Address *"
              value={form.registration_address}
              onChange={(v) => set("registration_address", v)}
              multiline
            />
            {form.communication_address && !form.registration_address && (
              <Pressable onPress={() => set("registration_address", form.communication_address)}>
                <Text className="text-sm text-slate-500 underline">Same as communication address</Text>
              </Pressable>
            )}
            <Field
              label={`Hypothecated To${isFinance ? " *" : ""}`}
              value={form.hypothecated_to}
              onChange={(v) => set("hypothecated_to", v)}
              placeholder={isFinance ? "Financier name" : "Leave blank if not financed"}
            />
            <Choice
              label="Insurance Coverage *"
              value={form.insurance_coverage}
              options={[
                { id: "in_house", label: "In house" },
                { id: "by_party", label: "By party" },
              ]}
              onChange={(v) => set("insurance_coverage", v)}
            />
            <Choice
              label="Registration *"
              value={form.registration_period}
              options={[
                { id: "permanent", label: "Permanent" },
                { id: "temporary", label: "Temporary" },
              ]}
              onChange={(v) => set("registration_period", v)}
            />
            <Field label="RTO Location *" value={form.rto_location} onChange={(v) => set("rto_location", v)} />
            <Choice
              label="Private / Commercial *"
              value={form.registration_use}
              options={[
                { id: "private", label: "Private" },
                { id: "commercial", label: "Commercial" },
              ]}
              onChange={(v) => set("registration_use", v)}
            />
            {form.registration_use === "commercial" && (
              <Choice
                label="Permit *"
                value={form.permit_type}
                options={[
                  { id: "state", label: "State Permit" },
                  { id: "all_india", label: "All India Permit" },
                ]}
                onChange={(v) => set("permit_type", v)}
              />
            )}
            <Field
              label="Special Registration Number (optional)"
              value={form.special_registration_number}
              onChange={(v) => set("special_registration_number", v)}
            />
            <Section>Delivery</Section>
            <Field
              label="Date of Registration (YYYY-MM-DD)"
              value={form.registration_date}
              onChange={(v) => set("registration_date", v)}
            />
            <Field
              label="Date & Time of Delivery (YYYY-MM-DD HH:MM)"
              value={
                form.delivery_at && /[zZ]|[+-]\d{2}:?\d{2}$/.test(form.delivery_at)
                  ? new Date(form.delivery_at).toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" }).slice(0, 16)
                  : (form.delivery_at ?? "")
              }
              onChange={(v) => set("delivery_at", v)}
            />
            <Field label="Place of Delivery" value={form.delivery_place} onChange={(v) => set("delivery_place", v)} />
            <Section>Approximate receipt time (working days)</Section>
            <Field
              label="Temporary Registration Validity Period"
              value={form.temp_registration_validity_days}
              onChange={(v) => set("temp_registration_validity_days", toInt(v))}
              keyboardType="numeric"
            />
            <Field label="RC Booklet / Smart Card" value={form.rc_days} onChange={(v) => set("rc_days", toInt(v))} keyboardType="numeric" />
            <Field
              label="Reg Plate / High Security Registration Plate"
              value={form.hsrp_days}
              onChange={(v) => set("hsrp_days", toInt(v))}
              keyboardType="numeric"
            />
          </>
        )}

        {step === 2 && (
          <>
            <Text className="text-sm text-slate-500">
              Toyota Genuine Accessories for this {booking.variants?.models?.name ?? "car"}. Prices come from the
              accessories list; 10% advance is paid while placing the order.
            </Text>
            {form.accessory_order_items.length === 0 && <Text className="py-2 text-slate-400">No accessories ordered.</Text>}
            {form.accessory_order_items.map((a) => {
              const option = accessoryOptions.find((o) => o.id === a.accessory_id);
              const price = a.price ?? option?.price ?? 0;
              return (
                <View key={a.accessory_id} className="flex-row items-center rounded-xl border border-slate-200 p-3">
                  <View className="flex-1 pr-2">
                    <Text className="font-medium text-slate-900">{a.name ?? option?.name}</Text>
                    <Text className="text-xs text-slate-500">
                      {a.part_no ?? option?.part_no ?? ""} · {inr(price)}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() =>
                      set(
                        "accessory_order_items",
                        a.qty <= 1
                          ? form.accessory_order_items.filter((x) => x.accessory_id !== a.accessory_id)
                          : form.accessory_order_items.map((x) => (x.accessory_id === a.accessory_id ? { ...x, qty: x.qty - 1 } : x)),
                      )
                    }
                    className="h-8 w-8 items-center justify-center rounded-full border border-slate-300"
                  >
                    <Text className="text-lg text-slate-700">−</Text>
                  </Pressable>
                  <Text className="w-8 text-center font-medium">{a.qty}</Text>
                  <Pressable
                    onPress={() =>
                      set(
                        "accessory_order_items",
                        form.accessory_order_items.map((x) =>
                          x.accessory_id === a.accessory_id ? { ...x, qty: Math.min(20, x.qty + 1) } : x,
                        ),
                      )
                    }
                    className="h-8 w-8 items-center justify-center rounded-full border border-slate-300"
                  >
                    <Text className="text-lg text-slate-700">+</Text>
                  </Pressable>
                </View>
              );
            })}
            {form.accessory_order_items.length > 0 && (
              <View className="rounded-xl bg-slate-50 p-3">
                <Text className="text-slate-700">Total {inr(localAccessoryTotal)}</Text>
                <Text className="text-slate-700">Advance (10%) {inr(Math.ceil(localAccessoryTotal * 0.1))}</Text>
              </View>
            )}
            <Field
              label="Add an accessory"
              value={accessorySearch}
              onChange={setAccessorySearch}
              placeholder="Search by name, part no. or category"
            />
            {accessoryMatches.map((a) => (
              <Pressable
                key={a.id}
                onPress={() => {
                  set("accessory_order_items", [
                    ...form.accessory_order_items,
                    { accessory_id: a.id, name: a.name, part_no: a.part_no, price: a.price, qty: 1 },
                  ]);
                  setAccessorySearch("");
                }}
                className="rounded-lg border border-slate-200 p-3"
              >
                <Text className="text-slate-900">{a.name}</Text>
                <Text className="text-xs text-slate-500">
                  {a.part_no ?? ""} {a.category ? `· ${a.category}` : ""} · {inr(a.price)}
                </Text>
              </Pressable>
            ))}
            {form.accessory_order_items.length > 0 && (
              <Choice
                label="Mode of Payment *"
                value={form.accessories_payment_mode}
                options={[
                  { id: "cash", label: "Cash" },
                  { id: "card", label: "Credit Card" },
                ]}
                onChange={(v) => set("accessories_payment_mode", v)}
              />
            )}
            <Terms title="Terms & Conditions" items={ACCESSORY_TERMS} ordered />
          </>
        )}

        {step === 3 && (
          <>
            <Text className="text-sm text-slate-500">
              Photograph each document, or mark it as collected on paper. Photo, Aadhaar and PAN / Voter ID are needed
              to complete the docket.
            </Text>
            {DOC_TYPES.map((t) => {
              const docs = documents.filter((d) => d.doc_type === t.id);
              return (
                <View
                  key={t.id}
                  className={`rounded-xl border p-3 ${docs.length ? "border-emerald-200 bg-emerald-50" : "border-slate-200"}`}
                >
                  <Text className="font-medium text-slate-900">
                    {docs.length ? "✓ " : ""}
                    {t.label}
                    {t.required ? " *" : ""}
                  </Text>
                  {docs.map((d) => (
                    <View key={d.id} className="mt-1 flex-row items-center justify-between">
                      <Text className="text-xs text-slate-600">
                        {d.collected_on_paper ? "Collected on paper" : "Photo attached"}
                        {d.label ? ` — ${d.label}` : ""}
                      </Text>
                      <Pressable
                        onPress={async () => {
                          try {
                            await removeDocument(d);
                            setDocuments(await loadDocuments(docket.id));
                          } catch (e: any) {
                            setError(e.message);
                          }
                        }}
                      >
                        <Text className="text-xs text-red-600 underline">Remove</Text>
                      </Pressable>
                    </View>
                  ))}
                  {t.id === "other" && (
                    <View className="mt-2">
                      <Field label="Which document?" value={otherLabel} onChange={setOtherLabel} />
                    </View>
                  )}
                  {uploadingType === t.id ? (
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
                          onPress={async () => {
                            try {
                              await markCollectedOnPaper(docket.id, t.id, t.id === "other" ? otherLabel : undefined);
                              setDocuments(await loadDocuments(docket.id));
                            } catch (e: any) {
                              setError(e.message);
                            }
                          }}
                          className="rounded-lg border border-slate-300 px-3 py-2"
                        >
                          <Text className="text-sm text-slate-700">On paper</Text>
                        </Pressable>
                      )}
                    </View>
                  )}
                </View>
              );
            })}
          </>
        )}

        {step === 4 && (
          <>
            <Text className="text-sm text-slate-500">Tick what the customer would like to hear more about.</Text>
            <CheckboxRow
              label="U Trust"
              sublabel="Sell or exchange a used car, or buy a certified used Toyota"
              checked={form.utrust_interest}
              onToggle={() => set("utrust_interest", !form.utrust_interest)}
            />
            <CheckboxRow
              label="Toyota Connect app"
              checked={form.tconnect_interest}
              onToggle={() => set("tconnect_interest", !form.tconnect_interest)}
            />
            <CheckboxRow
              label="Extended Warranty"
              sublabel="Toyota True Warranty up to 5 years"
              checked={form.extended_warranty_interest}
              onToggle={() => set("extended_warranty_interest", !form.extended_warranty_interest)}
            />
            <CheckboxRow
              label="Smiles Plus"
              sublabel="Pre-paid service package"
              checked={form.smiles_interest}
              onToggle={() => set("smiles_interest", !form.smiles_interest)}
            />
            <Section>Referral Form</Section>
            {[0, 1].map((i) => {
              const r: Referral = form.referrals[i] ?? {};
              const setR = (key: keyof Referral, v: string) => {
                const list = [form.referrals[0] ?? {}, form.referrals[1] ?? {}];
                list[i] = { ...list[i], [key]: v };
                set("referrals", list);
              };
              return (
                <View key={i} className="gap-2 rounded-xl border border-slate-200 p-3">
                  <Text className="font-medium text-slate-700">Referral {i + 1}</Text>
                  <Field label="Name" value={r.name} onChange={(v) => setR("name", v)} />
                  <Field label="Phone no" value={r.phone} onChange={(v) => setR("phone", v)} keyboardType="phone-pad" />
                  <Field label="Occupation" value={r.occupation} onChange={(v) => setR("occupation", v)} />
                  <Field label="Address" value={r.address} onChange={(v) => setR("address", v)} />
                  <Field label="Car owned" value={r.car_owned} onChange={(v) => setR("car_owned", v)} />
                </View>
              );
            })}
          </>
        )}

        {step === 5 && (
          <>
            <Text className="text-base font-semibold text-slate-900">Terms and Conditions for Order / Purchase</Text>
            <Terms items={ORDER_TERMS} />
            <Terms title="Refund in case of cancellation" items={REFUND_TERMS} />
            <Terms items={MORE_ORDER_TERMS} />
            <Text className="text-xs leading-5 text-slate-600">
              Data consent on the booking: {booking.data_consent ? `“${DATA_CONSENT_YES}”` : "not given"}
            </Text>
            <View className="flex-row items-center justify-between rounded-xl border border-slate-200 p-4">
              <Text className="flex-1 pr-3 text-slate-900">Customer has read and accepts these terms *</Text>
              <Switch value={form.terms_accepted} onValueChange={(v) => set("terms_accepted", v)} />
            </View>

            <Text className="mt-4 text-base font-semibold text-slate-900">RTO Process</Text>
            <Terms title="Disclaimer" items={RTO_DISCLAIMER} />
            <Text className="text-xs leading-5 text-slate-600">{RTO_NOTE}</Text>
            <View className="flex-row items-center justify-between rounded-xl border border-slate-200 p-4">
              <Text className="flex-1 pr-3 text-slate-900">
                I have read and agree to all the terms &amp; conditions mentioned above *
              </Text>
              <Switch value={form.rto_terms_accepted} onValueChange={(v) => set("rto_terms_accepted", v)} />
            </View>

            <Section>Customer Signature *</Section>
            {form.customer_signature_path && <Text className="text-xs text-emerald-700">✓ Signed — sign again to replace</Text>}
            <SignaturePad ref={customerSigRef} height={160} />
            <Section>Sales Consultant Signature *</Section>
            {form.consultant_signature_path && <Text className="text-xs text-emerald-700">✓ Signed — sign again to replace</Text>}
            <SignaturePad ref={consultantSigRef} height={160} />
          </>
        )}

        {onReview && (
          <>
            {missing && missing.length > 0 ? (
              <View className="rounded-xl border border-amber-300 bg-amber-50 p-4">
                <Text className="font-medium text-amber-900">Still needed before the docket is complete</Text>
                {missing.map((m) => (
                  <Text key={m} className="mt-1 text-sm text-amber-800">
                    • {m}
                  </Text>
                ))}
                <Text className="mt-2 text-sm text-amber-800">Go back to fill these in, then tap Save &amp; Complete.</Text>
              </View>
            ) : (
              <Text className="text-slate-500">Saved.</Text>
            )}
          </>
        )}

        {error && <Text className="text-sm text-red-600">{error}</Text>}
      </View>
    </WizardShell>
  );
}
