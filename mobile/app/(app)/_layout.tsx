import { Redirect, Stack } from "expo-router";
import { ActivityIndicator, Text, View } from "react-native";
import { useAuth } from "@/contexts/auth-context";

export default function AppLayout() {
  const { session, employee, loading } = useAuth();

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <ActivityIndicator />
      </View>
    );
  }

  if (!session) {
    return <Redirect href="/(auth)/login" />;
  }

  if (!employee) {
    return (
      <View className="flex-1 items-center justify-center bg-white px-6">
        <Text className="text-center text-slate-700">
          Your account is signed in but isn&apos;t linked to an employee record yet. Ask an
          admin to link your login from the dashboard&apos;s Employees screen.
        </Text>
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: true, headerBackTitle: "Back" }}>
      <Stack.Screen name="index" options={{ title: "Rajesh Toyota" }} />
      <Stack.Screen name="quotes/index" options={{ title: "My Quotes" }} />
      <Stack.Screen name="quotes/new" options={{ title: "New Quote" }} />
      <Stack.Screen name="bookings/index" options={{ title: "My Bookings" }} />
      <Stack.Screen name="bookings/new" options={{ title: "New Booking" }} />
      <Stack.Screen name="bookings/from-quote/[quoteId]" options={{ title: "Proceed to Booking" }} />
      <Stack.Screen name="approvals/index" options={{ title: "Pending Approvals" }} />
      <Stack.Screen name="profile" options={{ title: "Profile" }} />
    </Stack>
  );
}
