import { useEffect, useMemo, useState } from "react";
import { View, Text, TextInput, Switch, Alert, Pressable, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/auth-context";
import { WizardShell } from "@/components/wizard-shell";
import { PickerList, type PickerOption } from "@/components/picker-list";
import {
  MODE_OPTIONS,
  PURPOSE_OPTIONS,
  SOURCE_OPTIONS,
  TEMPERATURE_OPTIONS,
  createEnquiry,
  findCustomer,
  normalizeMobile,
  type CustomerLookup,
} from "@/lib/enquiries";

// Team Leader (rank 4) and above may assign an enquiry to someone in their team.
const ASSIGN_MAX_RANK = 4;
const STEP_TITLES = ["Customer", "Interest", "Source", "Assign & Save"];

export default function NewEnquiryScreen() {
  const { employee } = useAuth();
  const [step, setStep] = useState(0);

  const [mobileInput, setMobileInput] = useState("");
  const [lookup, setLookup] = useState<CustomerLookup | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const [purpose, setPurpose] = useState<string | null>("new_purchase");
  const [models, setModels] = useState<PickerOption[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [fuels, setFuels] = useState<PickerOption[]>([]);
  const [fuelTypeId, setFuelTypeId] = useState<string | null>(null);

  const [mode, setMode] = useState<string | null>("Walk-in");
  const [source, setSource] = useState<string | null>(null);
  const [testDrive, setTestDrive] = useState(false);
  const [temperature, setTemperature] = useState<string | null>("WRM");
  const [notes, setNotes] = useState("");

  const [team, setTeam] = useState<PickerOption[]>([]);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const mobile = normalizeMobile(mobileInput);
  const canAssign = employee?.roleRank != null && employee.roleRank <= ASSIGN_MAX_RANK;

  useEffect(() => {
    supabase
      .from("models")
      .select("id, name")
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => setModels((data ?? []).map((m) => ({ id: m.id, label: m.name }))));
  }, []);

  // Fuels offered for the chosen model, from its active variants.
  useEffect(() => {
    setFuelTypeId(null);
    if (!modelId) {
      setFuels([]);
      return;
    }
    supabase
      .from("variants")
      .select("fuel_type_id, fuel_types(name)")
      .eq("model_id", modelId)
      .eq("is_active", true)
      .then(({ data }) => {
        const seen = new Map<string, string>();
        for (const v of (data ?? []) as any[]) {
          const fuel = Array.isArray(v.fuel_types) ? v.fuel_types[0] : v.fuel_types;
          if (v.fuel_type_id && !seen.has(v.fuel_type_id)) seen.set(v.fuel_type_id, fuel?.name ?? "");
        }
        setFuels(Array.from(seen, ([id, label]) => ({ id, label })));
      });
  }, [modelId]);

  // Staff a Team Leader+ can assign to: active Sales Consultants / Team Leaders at their branch that
  // RLS lets them see (create_enquiry re-checks this server-side).
  useEffect(() => {
    if (!canAssign || !employee?.outletId) return;
    supabase
      .from("employees")
      .select("id, name, roles(name, rank)")
      .eq("outlet_id", employee.outletId)
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => {
        const rows = ((data ?? []) as any[]).filter((e) => {
          const role = Array.isArray(e.roles) ? e.roles[0] : e.roles;
          return role && role.rank >= (employee.roleRank ?? 0);
        });
        setTeam(rows.map((e) => ({ id: e.id, label: e.id === employee.id ? `${e.name} (me)` : e.name })));
      });
  }, [canAssign, employee]);

  useEffect(() => {
    setLookup(null);
    if (!mobile) return;
    let cancelled = false;
    setLookingUp(true);
    findCustomer(mobile)
      .then((res) => {
        if (cancelled) return;
        setLookup(res);
        if (res?.customer && !name.trim()) setName(res.customer.name);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLookingUp(false));
    return () => {
      cancelled = true;
    };
    // name is read only to avoid overwriting what the user typed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile]);

  const stepValid = useMemo(
    () => [!!mobile && name.trim().length > 0, !!purpose && !!modelId, !!mode && !!temperature, true],
    [mobile, name, purpose, modelId, mode, temperature],
  );

  async function save() {
    if (!mobile || !purpose || !modelId || !mode || !temperature) return;
    setSaving(true);
    try {
      const id = await createEnquiry({
        mobile,
        name: name.trim(),
        email: email.trim() || undefined,
        purpose_of_visit: purpose,
        model_id: modelId,
        fuel_type_id: fuelTypeId,
        mode,
        source_desc: source,
        test_drive_given: testDrive,
        temperature,
        notes: notes.trim() || undefined,
        assigned_employee_id: canAssign ? assigneeId : null,
      });
      const mine = !canAssign || !assigneeId || assigneeId === employee?.id;
      Alert.alert("Enquiry saved", mine ? "Make a quote for this customer now?" : "Assigned to the selected consultant.", [
        { text: "Later", style: "cancel", onPress: () => router.replace("/(app)/enquiries") },
        ...(mine ? [{ text: "Make quote", onPress: () => router.replace(`/(app)/quotes/new?enquiryId=${id}`) }] : []),
      ]);
    } catch (e: any) {
      Alert.alert("Could not save", e.message ?? "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  const lastStep = STEP_TITLES.length - 1;

  return (
    <WizardShell
      title={STEP_TITLES[step]}
      stepIndex={step}
      stepCount={STEP_TITLES.length}
      onBack={step > 0 ? () => setStep((s) => s - 1) : undefined}
      onNext={() => (step === lastStep ? save() : setStep((s) => s + 1))}
      nextDisabled={!stepValid[step]}
      nextLoading={saving}
      nextLabel={step === lastStep ? "Save Enquiry" : "Continue"}
    >
      {step === 0 && (
        <View className="gap-4">
          <View>
            <Text className="mb-1 text-sm font-medium text-slate-700">Mobile number *</Text>
            <TextInput
              value={mobileInput}
              onChangeText={setMobileInput}
              keyboardType="phone-pad"
              placeholder="10-digit mobile"
              className="rounded-lg border border-slate-300 px-4 py-3 text-base"
            />
            {mobileInput.length > 0 && !mobile && (
              <Text className="mt-1 text-xs text-red-600">Enter a valid 10-digit Indian mobile number.</Text>
            )}
          </View>

          {lookingUp && <ActivityIndicator />}
          {lookup?.customer && (
            <View className="rounded-xl border border-blue-200 bg-blue-50 p-3">
              <Text className="font-medium text-blue-900">Existing customer: {lookup.customer.name}</Text>
              {lookup.open_enquiries.map((e) => (
                <Text key={e.id} className="mt-1 text-sm text-blue-800">
                  Open {e.model} enquiry with {e.mine ? "your team" : e.assigned_to} ({e.outlet}),{" "}
                  {new Date(e.created_at).toLocaleDateString()}
                </Text>
              ))}
              {lookup.open_enquiries.length > 0 && (
                <Text className="mt-2 text-xs text-blue-700">
                  Check with that consultant before creating another enquiry.
                </Text>
              )}
            </View>
          )}

          <View>
            <Text className="mb-1 text-sm font-medium text-slate-700">Customer name *</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Full name"
              className="rounded-lg border border-slate-300 px-4 py-3 text-base"
            />
          </View>
          <View>
            <Text className="mb-1 text-sm font-medium text-slate-700">Email</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              className="rounded-lg border border-slate-300 px-4 py-3 text-base"
            />
          </View>
        </View>
      )}

      {step === 1 && (
        <View className="gap-4">
          <Text className="font-medium text-slate-700">Purpose of visit</Text>
          <PickerList options={PURPOSE_OPTIONS} selectedId={purpose} onSelect={setPurpose} />
          <Text className="mt-2 font-medium text-slate-700">Model</Text>
          <PickerList options={models} selectedId={modelId} onSelect={setModelId} />
          {fuels.length > 0 && (
            <>
              <Text className="mt-2 font-medium text-slate-700">Fuel (optional)</Text>
              <PickerList options={fuels} selectedId={fuelTypeId} onSelect={setFuelTypeId} />
            </>
          )}
        </View>
      )}

      {step === 2 && (
        <View className="gap-4">
          <Text className="font-medium text-slate-700">How did they reach us?</Text>
          <PickerList options={MODE_OPTIONS} selectedId={mode} onSelect={setMode} />
          <Text className="mt-2 font-medium text-slate-700">Source (optional)</Text>
          <PickerList options={SOURCE_OPTIONS} selectedId={source} onSelect={setSource} />
          <View className="flex-row items-center justify-between rounded-xl border border-slate-200 p-4">
            <Text className="font-medium text-slate-900">Test drive given</Text>
            <Switch value={testDrive} onValueChange={setTestDrive} />
          </View>
          <Text className="mt-2 font-medium text-slate-700">Temperature</Text>
          <PickerList options={TEMPERATURE_OPTIONS} selectedId={temperature} onSelect={setTemperature} />
        </View>
      )}

      {step === 3 && (
        <View className="gap-4">
          {canAssign ? (
            <>
              <Text className="font-medium text-slate-700">Assign to</Text>
              <PickerList options={team} selectedId={assigneeId ?? employee?.id ?? null} onSelect={setAssigneeId} />
            </>
          ) : (
            <View className="rounded-xl border border-slate-200 p-4">
              <Text className="text-sm text-slate-500">Assigned to</Text>
              <Text className="font-medium text-slate-900">
                {employee?.name} · {employee?.outletName}
              </Text>
            </View>
          )}
          <View>
            <Text className="mb-1 text-sm font-medium text-slate-700">Notes</Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              multiline
              placeholder="Budget, exchange vehicle, timeline…"
              className="min-h-24 rounded-lg border border-slate-300 px-4 py-3 text-base"
            />
          </View>
          <Pressable onPress={() => setStep(0)}>
            <Text className="text-sm text-slate-500">
              {name} · {mobile}
            </Text>
          </Pressable>
        </View>
      )}
    </WizardShell>
  );
}
