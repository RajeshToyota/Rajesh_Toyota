import { View, Text, Pressable, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Link } from "expo-router";
import { useAuth } from "@/contexts/auth-context";

export default function HomeScreen() {
  const { employee } = useAuth();

  const actions = [
    { href: "/(app)/quotes/new" as const, label: "New Quote", description: "Build and share a vehicle quotation" },
    { href: "/(app)/quotes" as const, label: "My Quotes", description: "View quotes you've created" },
    { href: "/(app)/profile" as const, label: "Profile", description: "Your role, outlet, and manager" },
  ];

  return (
    <SafeAreaView edges={["bottom"]} className="flex-1 bg-slate-50">
      <ScrollView contentContainerClassName="p-4 gap-3">
        <View className="mb-2">
          <Text className="text-lg font-semibold text-slate-900">Welcome, {employee?.name}</Text>
          <Text className="text-sm text-slate-500">
            {employee?.roleName} · {employee?.outletName ?? "No outlet assigned"}
          </Text>
        </View>

        {actions.map((action) => (
          <Link key={action.href} href={action.href} asChild>
            <Pressable className="rounded-xl border border-slate-200 bg-white p-4">
              <Text className="text-base font-medium text-slate-900">{action.label}</Text>
              <Text className="mt-1 text-sm text-slate-500">{action.description}</Text>
            </Pressable>
          </Link>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
