import "server-only";
import { createClient } from "@supabase/supabase-js";

// Service-key client for the few things the database cannot do for a signed-in user: sending login
// invites and closing a leaver's login. It bypasses RLS, so callers must check the user's rights first.
// Returns null when SUPABASE_SERVICE_ROLE_KEY is not set on the server.
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
