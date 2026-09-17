import { View, Text } from "react-native";
import type { PricingResult } from "@/lib/types";

export function PriceSummary({ pricing, title }: { pricing: PricingResult; title?: string }) {
  return (
    <View className="rounded-xl border border-slate-200 p-4">
      {title && <Text className="mb-2 text-sm font-medium text-slate-500">{title}</Text>}
      {pricing.line_items.map((item, i) => (
        <View key={i} className="flex-row justify-between py-1.5">
          <Text className="text-slate-600">{item.label}</Text>
          <Text className="text-slate-900">₹{Math.round(item.amount).toLocaleString("en-IN")}</Text>
        </View>
      ))}
      <View className="mt-2 flex-row justify-between border-t border-slate-200 pt-2">
        <Text className="font-semibold text-slate-900">Total</Text>
        <Text className="font-semibold text-slate-900">₹{Math.round(pricing.total_amount).toLocaleString("en-IN")}</Text>
      </View>
      {pricing.dealer_margin !== undefined && (
        <View className="mt-1 flex-row justify-between">
          <Text className="text-sm text-slate-400">Dealer Margin</Text>
          <Text className="text-sm text-slate-400">₹{Math.round(pricing.dealer_margin).toLocaleString("en-IN")}</Text>
        </View>
      )}
    </View>
  );
}
