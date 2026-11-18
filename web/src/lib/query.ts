import { useCallback, useEffect, useState } from "react";
import { useRefreshStore } from "@/compat/refresh";

// Loads data for a page and reloads it when the inputs change or any action calls refreshPages().
export function useQuery<T>(load: () => Promise<T>, deps: unknown[]) {
  const version = useRefreshStore((s) => s.version);
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    load()
      .then((data) => !cancelled && setState({ data, error: null, loading: false }))
      .catch((e: unknown) => !cancelled && setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version, tick]);

  return { ...state, reload };
}

// Throws the database's message, so callers can show it.
export function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}
