import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  console.error("Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in web/.env.local (see .env.example).");
}

// One browser client for the whole app; the session lives in localStorage. Every read and write is
// still checked by RLS and the security-definer RPCs in the database.
// detectSessionInUrl is off: /auth/set-password reads the invite link's tokens itself.
export const supabase: SupabaseClient = createSupabaseClient(url ?? "http://localhost", anonKey ?? "missing", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

export function createClient() {
  return supabase;
}
