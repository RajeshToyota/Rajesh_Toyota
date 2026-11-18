import {
  Children,
  Fragment,
  createElement,
  isValidElement,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { NotFoundSignal, RedirectSignal } from "./navigation";
import { useRefreshStore } from "./refresh";

// A page or layout from the old Next.js dashboard: an (often async) server component.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServerComponent = (props: any) => ReactNode | Promise<ReactNode>;

const isClientComponent = (type: unknown) =>
  typeof type === "function" && (type as { __client?: boolean }).__client === true;

// Plain functions that are not marked "use client" are server components: call them (awaiting the
// async ones) and keep walking what they return. Everything else stays an element for React to render,
// with its children walked, because a client component's children can still be server components.
async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (node === null || node === undefined || typeof node === "boolean") return node;
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return node;
  if (node instanceof Promise) return resolveTree(await node);
  if (Array.isArray(node)) return Promise.all(node.map(resolveTree));
  if (!isValidElement(node)) return node;

  const el = node as ReactElement<Record<string, unknown>>;
  const { type } = el;

  if (typeof type === "function" && !isClientComponent(type) && !(type as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
    const output = await (type as ServerComponent)(el.props);
    const resolved = await resolveTree(output);
    return el.key != null ? createElement(Fragment, { key: el.key }, resolved) : resolved;
  }

  const children = el.props.children;
  if (children === undefined) return el;
  const resolvedChildren = Array.isArray(children)
    ? await Promise.all(Children.toArray(children).map(resolveTree))
    : await resolveTree(children as ReactNode);
  return createElement(type as string, { ...el.props, key: el.key }, resolvedChildren);
}

type Loaded = { key: string; node: ReactNode } | { key: string; notFound: true } | { key: string; error: string };

// Renders a ported server page: loads its data in the browser when the URL changes or a server action
// asks for a refresh, keeping the current page on screen while it reloads.
export function ServerPage({ page, layouts = [] }: { page: ServerComponent; layouts?: ServerComponent[] }) {
  const params = useParams();
  const location = useLocation();
  const version = useRefreshStore((s) => s.version);
  const key = location.pathname + location.search;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    const routeParams = Promise.resolve({ ...params });
    const searchParams = Promise.resolve(Object.fromEntries(new URLSearchParams(location.search)));

    let tree: ReactNode = createElement(page, { params: routeParams, searchParams });
    for (const layout of [...layouts].reverse()) tree = createElement(layout, { params: routeParams }, tree);

    resolveTree(tree)
      .then((node) => !cancelled && setLoaded({ key, node }))
      .catch((e: unknown) => {
        if (cancelled || e instanceof RedirectSignal) return;
        if (e instanceof NotFoundSignal) setLoaded({ key, notFound: true });
        else {
          console.error(e);
          setLoaded({ key, error: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => {
      cancelled = true;
    };
    // params and layouts follow from the URL, which `key` already covers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version, page]);

  if (!loaded || loaded.key !== key) {
    return <p className="py-10 text-center text-sm text-slate-400">Loading…</p>;
  }
  if ("notFound" in loaded) {
    return (
      <div className="py-10 text-center text-sm text-slate-500">
        <p>This record was not found, or you do not have access to it.</p>
        <Link to="/" className="mt-2 inline-block text-slate-900 underline">
          Back to Pipeline
        </Link>
      </div>
    );
  }
  if ("error" in loaded) {
    return <p className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{loaded.error}</p>;
  }
  return <>{loaded.node}</>;
}
