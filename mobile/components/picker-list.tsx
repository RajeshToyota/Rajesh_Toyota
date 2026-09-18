import { View, Text, Pressable, ActivityIndicator } from "react-native";

export interface PickerOption {
  id: string;
  label: string;
  sublabel?: string;
}

export function PickerList({
  options,
  selectedId,
  onSelect,
  loading,
  emptyLabel = "Nothing available for this selection.",
}: {
  options: PickerOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading?: boolean;
  emptyLabel?: string;
}) {
  if (loading) {
    return (
      <View className="items-center py-8">
        <ActivityIndicator />
      </View>
    );
  }

  if (options.length === 0) {
    return <Text className="py-8 text-center text-slate-400">{emptyLabel}</Text>;
  }

  return (
    <View className="gap-2">
      {options.map((opt) => {
        const active = opt.id === selectedId;
        return (
          <Pressable
            key={opt.id}
            onPress={() => onSelect(opt.id)}
            className={`rounded-xl border p-4 ${active ? "border-slate-900 bg-slate-900" : "border-slate-200 bg-white"}`}
          >
            <Text className={`font-medium ${active ? "text-white" : "text-slate-900"}`}>{opt.label}</Text>
            {opt.sublabel && (
              <Text className={`mt-0.5 text-sm ${active ? "text-slate-300" : "text-slate-500"}`}>{opt.sublabel}</Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

export function CheckboxRow({
  label,
  sublabel,
  checked,
  onToggle,
}: {
  label: string;
  sublabel?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      onPress={onToggle}
      className={`flex-row items-center justify-between rounded-xl border p-4 ${checked ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white"}`}
    >
      <View className="flex-1 pr-3">
        <Text className="font-medium text-slate-900">{label}</Text>
        {sublabel && <Text className="mt-0.5 text-sm text-slate-500">{sublabel}</Text>}
      </View>
      <View className={`h-5 w-5 items-center justify-center rounded border ${checked ? "border-slate-900 bg-slate-900" : "border-slate-300"}`}>
        {checked && <Text className="text-xs text-white">✓</Text>}
      </View>
    </Pressable>
  );
}
