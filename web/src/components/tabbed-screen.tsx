import { Suspense, lazy } from "react";
import { Navigate, Outlet, Route, useLocation, useSearchParams } from "react-router-dom";
import RequireModule from "@/components/RequireModule";
import { useRbacStore } from "@/lib/rbac";
import { screenModules, tabHref, type ScreenTab, type TabbedScreen } from "@/lib/tabbed-screens";
import { LinkTabs, PageHeader } from "@/ui";

const EntityTab = lazy(() => import("@/pages/masters/EntityTab"));
const loading = <p className="py-10 text-center text-sm text-slate-400">Loading…</p>;

function useVisibleTabs(screen: TabbedScreen) {
  const { available, isAdmin, rights } = useRbacStore();
  return screen.tabs.filter((t) => !available || isAdmin || t.modules.some((m) => rights.has(`${m}:view`)));
}

// The screen's frame: header and tab links. Only the open tab's route renders (and loads) below.
function Frame({ screen }: { screen: TabbedScreen }) {
  const tabs = useVisibleTabs(screen);
  const { pathname } = useLocation();
  return (
    <div>
      {screen.title && <PageHeader title={screen.title} note={screen.note} />}
      {tabs.length > 1 && <LinkTabs current={pathname.replace(/\/$/, "")} tabs={tabs.map((t) => ({ href: tabHref(screen, t), label: t.label }))} />}
      <Suspense fallback={loading}>
        <Outlet />
      </Suspense>
    </div>
  );
}

// /<screen>: open the first tab the employee may see. An old ?tab=<id> link opens that tab; any
// other query is kept.
function FirstTab({ screen }: { screen: TabbedScreen }) {
  const tabs = useVisibleTabs(screen);
  const [params] = useSearchParams();
  const tab = tabs.find((t) => t.id === params.get("tab")) ?? tabs[0];
  if (!tab) return <p className="py-10 text-center text-sm text-slate-500">You do not have access to this screen.</p>;
  params.delete("tab");
  const query = params.toString();
  return <Navigate to={`${tabHref(screen, tab)}${query ? `?${query}` : ""}`} replace />;
}

function TabBody({ screen, tab }: { screen: TabbedScreen; tab: ScreenTab }) {
  return (
    <RequireModule module={tab.modules}>
      {tab.entity ? <EntityTab key={tab.entity} slug={tab.entity} module={screen.module} /> : tab.Component && <tab.Component key={tab.id} />}
    </RequireModule>
  );
}

// The routes of one tabbed screen: the frame, its index, and one child route per tab.
export function tabbedScreenRoute(screen: TabbedScreen) {
  return (
    <Route
      key={screen.path}
      path={screen.path}
      element={
        <RequireModule module={screenModules[screen.path]}>
          <Frame screen={screen} />
        </RequireModule>
      }
    >
      <Route index element={<FirstTab screen={screen} />} />
      {screen.tabs.map((tab) => (
        <Route key={tab.id} path={tab.id} element={<TabBody screen={screen} tab={tab} />} />
      ))}
    </Route>
  );
}
