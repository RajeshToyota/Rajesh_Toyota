import { lazy, type ComponentType } from "react";
import { ServerPage, type ServerComponent } from "@/compat/server-page";

type Module = { default: ServerComponent };
export type Loader = () => Promise<Module>;

// A page ported from the Next.js dashboard, loaded on first visit (as Techwheels lazy-loads its admin
// pages) and rendered through <ServerPage> with its layouts around it.
export function ported(load: Loader, layouts: Loader[] = []) {
  return lazy(async () => {
    const [page, ...wrappers] = await Promise.all([load(), ...layouts.map((l) => l())]);
    const Page: ComponentType = () => <ServerPage page={page.default} layouts={wrappers.map((w) => w.default)} />;
    return { default: Page };
  });
}

