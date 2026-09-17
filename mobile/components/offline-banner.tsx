import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { flushPendingUploads } from "@/lib/upload-queue";

// A persistent top banner whenever the device has no network — the wizard screens themselves
// stay fully usable offline (all their state is local React state until the user explicitly
// submits), this just makes the "why did that submit fail" question answer itself.
export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const offline = state.isConnected === false;
      setIsOffline(offline);
      if (!offline) {
        // Connection restored — try to flush anything queued while we were offline.
        flushPendingUploads().catch(() => {});
      }
    });
    return unsubscribe;
  }, []);

  if (!isOffline) return null;

  return (
    <View className="bg-amber-500 px-4 py-2">
      <Text className="text-center text-xs font-medium text-white">
        No internet connection — changes will be saved once you&apos;re back online.
      </Text>
    </View>
  );
}
