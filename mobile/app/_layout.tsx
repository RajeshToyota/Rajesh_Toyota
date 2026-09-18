import "../global.css";
import "react-native-reanimated";
import { Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/contexts/auth-context";
import { ErrorBoundary } from "@/components/error-boundary";
import { OfflineBanner } from "@/components/offline-banner";

const queryClient = new QueryClient();

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ErrorBoundary>
              <StatusBar style="dark" />
              <OfflineBanner />
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(auth)" />
                <Stack.Screen name="(app)" />
              </Stack>
            </ErrorBoundary>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
