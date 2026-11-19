import { Suspense, type ComponentType } from "react";
import { useSearchParams } from "react-router-dom";
import { useRbacStore } from "@/lib/rbac";
import { Tabs } from "@/ui";

export type MergedTab = { id: string; label: string; module: string; Component: ComponentType };

// Two screens that do one job, behind one menu entry: a tab each, shown to whoever has that screen's
// view right. The tab is kept in ?tab= so a link can open either.
export function mergedPage(tabs: MergedTab[]): ComponentType {
  return function MergedPage() {
    const { available, isAdmin, rights } = useRbacStore();
    const [params, setParams] = useSearchParams();
    const visible = tabs.filter((t) => !available || isAdmin || rights.has(`${t.module}:view`));
    if (visible.length === 0) return <p className="py-10 text-center text-sm text-slate-500">You do not have access to this screen.</p>;
    const current = visible.find((t) => t.id === params.get("tab")) ?? visible[0];
    return (
      <div>
        {visible.length > 1 && (
          <Tabs
            current={current.id}
            onChange={(id) => setParams((p) => { p.set("tab", id); return p; }, { replace: true })}
            tabs={visible.map((t) => ({ id: t.id, label: t.label }))}
          />
        )}
        <Suspense fallback={<p className="py-10 text-center text-sm text-slate-400">Loading…</p>}>
          <current.Component key={current.id} />
        </Suspense>
      </div>
    );
  };
}
