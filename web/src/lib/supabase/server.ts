import { supabase } from "./client";

// Kept so the ported pages and actions can still `await createClient()`. In this single-page app it is
// the same browser client: there is no server, and RLS decides what each user can read and change.
export async function createClient() {
  return supabase;
}
