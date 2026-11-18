import type { NavigateFunction } from "react-router-dom";

// The router's navigate function, so code outside components (server actions, redirect()) can move pages.
let navigateFn: NavigateFunction | null = null;

export function setNavigate(fn: NavigateFunction) {
  navigateFn = fn;
}

export function navigateTo(to: string, opts?: { replace?: boolean }) {
  if (navigateFn) navigateFn(to, opts);
  else window.location.assign(to);
}
