import { View, Text, Pressable, ScrollView, ActivityIndicator } from "react-native";
import type { ReactNode } from "react";

export function WizardShell({
  title,
  stepIndex,
  stepCount,
  children,
  onBack,
  onNext,
  nextLabel = "Continue",
  nextDisabled,
  nextLoading,
  hideNext,
}: {
  title: string;
  stepIndex: number;
  stepCount: number;
  children: ReactNode;
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  nextLoading?: boolean;
  hideNext?: boolean;
}) {
  return (
    <View className="flex-1 bg-white">
      <View className="border-b border-slate-100 px-4 py-3">
        <Text className="text-xs text-slate-400">
          Step {stepIndex + 1} of {stepCount}
        </Text>
        <Text className="mt-0.5 text-lg font-semibold text-slate-900">{title}</Text>
        <View className="mt-2 h-1 flex-row gap-1">
          {Array.from({ length: stepCount }).map((_, i) => (
            <View key={i} className={`h-1 flex-1 rounded-full ${i <= stepIndex ? "bg-slate-900" : "bg-slate-100"}`} />
          ))}
        </View>
      </View>

      <ScrollView contentContainerClassName="p-4 pb-8" keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>

      <View className="flex-row gap-3 border-t border-slate-100 px-4 py-3">
        {onBack && (
          <Pressable onPress={onBack} className="flex-1 items-center rounded-lg border border-slate-300 py-3">
            <Text className="font-medium text-slate-700">Back</Text>
          </Pressable>
        )}
        {!hideNext && (
          <Pressable
            onPress={onNext}
            disabled={nextDisabled || nextLoading}
            className={`flex-1 items-center rounded-lg py-3 ${nextDisabled || nextLoading ? "bg-slate-300" : "bg-slate-900"}`}
          >
            {nextLoading ? <ActivityIndicator color="#fff" /> : <Text className="font-medium text-white">{nextLabel}</Text>}
          </Pressable>
        )}
      </View>
    </View>
  );
}
