import { useMemo } from "react";
import { useLocation, useNavigate, useSearchParams as useRouterSearchParams } from "react-router-dom";
import { navigateTo } from "./navigate";
import { refreshPages } from "./refresh";

// Thrown by redirect() / notFound() to stop the code that called them, as in Next.js.
export class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`Redirecting to ${to}`);
  }
}
export class NotFoundSignal extends Error {
  constructor() {
    super("Not found");
  }
}

export function redirect(to: string): never {
  navigateTo(to, { replace: true });
  throw new RedirectSignal(to);
}

export function notFound(): never {
  throw new NotFoundSignal();
}

export function useRouter() {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (to: string) => navigate(to),
      replace: (to: string) => navigate(to, { replace: true }),
      back: () => navigate(-1),
      refresh: () => refreshPages(),
    }),
    [navigate],
  );
}

export function usePathname() {
  return useLocation().pathname;
}

export function useSearchParams() {
  return useRouterSearchParams()[0];
}
