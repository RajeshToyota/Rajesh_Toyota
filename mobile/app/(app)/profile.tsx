import { View, Text, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/contexts/auth-context";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between border-b border-slate-100 py-3">
      <Text className="text-slate-500">{label}</Text>
      <Text className="font-medium text-slate-900">{value}</Text>
    </View>
  );
}

export default function ProfileScreen() {
  const { employee, signOut } = useAuth();

  return (
    <SafeAreaView edges={["bottom"]} className="flex-1 bg-white px-4">
      <View className="mt-4">
        <Row label="Name" value={employee?.name ?? "—"} />
        <Row label="Email" value={employee?.email ?? "—"} />
        <Row label="Role" value={employee?.roleName ?? "—"} />
        <Row label="Outlet" value={employee?.outletName ?? "—"} />
      </View>

      <Pressable onPress={() => signOut()} className="mt-8 items-center rounded-lg border border-red-200 py-3">
        <Text className="font-medium text-red-600">Sign out</Text>
      </Pressable>
    </SafeAreaView>
  );
}
