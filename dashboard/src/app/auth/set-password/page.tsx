"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

// Landing page for the login invite and set-password emails. Those links carry the session in the
// URL fragment (invites are not PKCE), so this page reads it itself and then sets the password.
// Created on first use in the browser, not while the page is prerendered.
let client: ReturnType<typeof createBrowserClient> | null = null;
const getClient = () =>
  (client ??= createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    isSingleton: false,
    auth: { detectSessionInUrl: false },
  }));

export default function SetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const supabase = getClient();
    (async () => {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const failure = hash.get("error_description");
      const access_token = hash.get("access_token");
      const refresh_token = hash.get("refresh_token");
      if (failure) {
        setError(`${failure.replace(/\+/g, " ")}. Ask HR to send a new link.`);
      } else if (access_token && refresh_token) {
        const { error: sessionError } = await supabase.auth.setSession({ access_token, refresh_token });
        if (sessionError) setError(sessionError.message);
        window.history.replaceState(null, "", window.location.pathname);
      }
      const { data } = await supabase.auth.getUser();
      if (data.user) setEmail(data.user.email ?? null);
      else if (!failure) setError((e) => e ?? "This link has expired or was already used. Ask HR to send a new one.");
      setReady(true);
    })();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== confirm) return setError("The two passwords don't match.");
    setSaving(true);
    const { error: updateError } = await getClient().auth.updateUser({ password });
    setSaving(false);
    if (updateError) return setError(updateError.message);
    setDone(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Rajesh Toyota CRM</h1>
        {!ready ? (
          <p className="mt-4 text-sm text-slate-500">Checking your link…</p>
        ) : done ? (
          <div className="mt-4 space-y-3 text-sm text-slate-700">
            <p>Your password is set. Sign in with {email ?? "your work email"} and this password, here or in the Rajesh Toyota app.</p>
            <button
              onClick={() => {
                router.replace("/");
                router.refresh();
              }}
              className="w-full rounded-md bg-slate-900 px-3 py-2 font-medium text-white hover:bg-slate-800"
            >
              Open the dashboard
            </button>
          </div>
        ) : email ? (
          <form onSubmit={submit} className="mt-4 space-y-3">
            <p className="text-sm text-slate-600">Choose a password for {email}.</p>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="New password (8+ characters)"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat the password"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              disabled={saving}
              className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Set password"}
            </button>
          </form>
        ) : (
          <p className="mt-4 text-sm text-red-600">{error}</p>
        )}
      </div>
    </div>
  );
}
