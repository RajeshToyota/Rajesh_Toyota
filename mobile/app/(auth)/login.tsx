import { useState } from "react";
import { View, Text, TextInput, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "@/lib/supabase";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    setError(null);
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (error) setError(error.message);
    // On success, the root/auth layouts pick up the new session and redirect automatically.
  }

  return (
    <SafeAreaView className="flex-1 bg-white">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 justify-center px-6"
      >
        <Text className="text-2xl font-semibold text-slate-900">Rajesh Toyota</Text>
        <Text className="mt-1 text-slate-500">Sign in to create quotes and bookings</Text>

        <View className="mt-8 gap-4">
          <View>
            <Text className="mb-1 text-sm font-medium text-slate-700">Email</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              className="rounded-lg border border-slate-300 px-4 py-3 text-base"
              placeholder="you@rajeshtoyota.com"
            />
          </View>

          <View>
            <Text className="mb-1 text-sm font-medium text-slate-700">Password</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              className="rounded-lg border border-slate-300 px-4 py-3 text-base"
              placeholder="••••••••"
            />
          </View>

          {error && <Text className="text-sm text-red-600">{error}</Text>}

          <Pressable
            onPress={handleLogin}
            disabled={loading || !email || !password}
            className="mt-2 items-center rounded-lg bg-slate-900 py-3 disabled:opacity-50"
          >
            {loading ? <ActivityIndicator color="#fff" /> : <Text className="font-medium text-white">Sign in</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
