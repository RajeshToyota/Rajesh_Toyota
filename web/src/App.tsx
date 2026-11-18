import { Suspense, lazy, useEffect, type ComponentType } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import ProtectedRoute from "@/components/ProtectedRoute";
import AdminPanel from "@/pages/AdminPanel";
import LoginPage from "@/pages/login/page";
import SetPasswordPage from "@/pages/auth/set-password/page";
import { ServerPage, type ServerComponent } from "@/compat/server-page";
import { setNavigate } from "@/compat/navigate";

type Module = { default: ServerComponent };
type Loader = () => Promise<Module>;

// A page ported from the Next.js dashboard, loaded on first visit (as Techwheels lazy-loads its admin
// pages) and rendered through <ServerPage> with its layouts around it.
function ported(load: Loader, layouts: Loader[] = []) {
  return lazy(async () => {
    const [page, ...wrappers] = await Promise.all([load(), ...layouts.map((l) => l())]);
    const Page: ComponentType = () => <ServerPage page={page.default} layouts={wrappers.map((w) => w.default)} />;
    return { default: Page };
  });
}

const reportsLayout: Loader = () => import("@/pages/staff/reports/layout");
const stockLayout: Loader = () => import("@/pages/staff/stock/layout");
const bookingLayout: Loader = () => import("@/pages/staff/reports/bookings/[id]/layout");
const bookingFile = [reportsLayout, bookingLayout];

// One row per screen. Paths are the same as in the old dashboard, so bookmarks and links keep working.
const routes: { path: string; Component: ComponentType }[] = [
  // Reporting home
  { path: "/", Component: ported(() => import("@/pages/staff/page")) },

  // Sales
  { path: "/enquiries", Component: ported(() => import("@/pages/staff/enquiries/page")) },
  { path: "/enquiries/new", Component: ported(() => import("@/pages/staff/enquiries/new/page")) },
  { path: "/crm-sync", Component: ported(() => import("@/pages/staff/crm-sync/page")) },
  { path: "/finance", Component: ported(() => import("@/pages/staff/finance/page")) },
  { path: "/finance/:id", Component: ported(() => import("@/pages/staff/finance/[id]/page")) },

  // Stock
  { path: "/stock", Component: ported(() => import("@/pages/staff/stock/page"), [stockLayout]) },
  { path: "/stock/import", Component: ported(() => import("@/pages/staff/stock/import/page"), [stockLayout]) },
  { path: "/stock/match", Component: ported(() => import("@/pages/staff/stock/match/page"), [stockLayout]) },
  { path: "/stock/allotted", Component: ported(() => import("@/pages/staff/stock/allotted/page"), [stockLayout]) },
  { path: "/stock/billing", Component: ported(() => import("@/pages/staff/stock/billing/page"), [stockLayout]) },
  { path: "/stock/ctdms", Component: ported(() => import("@/pages/staff/stock/ctdms/page"), [stockLayout]) },
  { path: "/stock/finance-queue", Component: ported(() => import("@/pages/staff/stock/finance-queue/page"), [stockLayout]) },
  { path: "/stock/vna", Component: ported(() => import("@/pages/staff/stock/vna/page"), [stockLayout]) },
  { path: "/stock/vehicle/:id", Component: ported(() => import("@/pages/staff/stock/vehicle/[id]/page"), [stockLayout]) },
  { path: "/stock/pool", Component: ported(() => import("@/pages/staff/stock/pool/page"), [stockLayout]) },
  { path: "/stock/pool/config", Component: ported(() => import("@/pages/staff/stock/pool/config/page"), [stockLayout]) },
  { path: "/stock/pool/audit", Component: ported(() => import("@/pages/staff/stock/pool/audit/page"), [stockLayout]) },
  {
    path: "/stock/pool/:variant/:color",
    Component: ported(() => import("@/pages/staff/stock/pool/[variant]/[color]/page"), [stockLayout]),
  },
  { path: "/payments", Component: ported(() => import("@/pages/staff/payments/page")) },
  { path: "/cancellations", Component: ported(() => import("@/pages/staff/cancellations/page")) },

  // People
  { path: "/hr", Component: ported(() => import("@/pages/staff/hr/page")) },
  { path: "/hr/new", Component: ported(() => import("@/pages/staff/hr/new/page")) },
  { path: "/hr/:id", Component: ported(() => import("@/pages/staff/hr/[id]/page")) },

  // Reporting
  { path: "/reports/consultants", Component: ported(() => import("@/pages/staff/reports/consultants/page"), [reportsLayout]) },
  { path: "/reports/sources", Component: ported(() => import("@/pages/staff/reports/sources/page"), [reportsLayout]) },
  { path: "/reports/stock-ageing", Component: ported(() => import("@/pages/staff/reports/stock-ageing/page"), [reportsLayout]) },
  { path: "/reports/quotes", Component: ported(() => import("@/pages/staff/reports/quotes/page"), [reportsLayout]) },
  { path: "/reports/approvals", Component: ported(() => import("@/pages/staff/reports/approvals/page"), [reportsLayout]) },
  { path: "/reports/margin", Component: ported(() => import("@/pages/staff/reports/margin/page"), [reportsLayout]) },
  { path: "/reports/bookings", Component: ported(() => import("@/pages/staff/reports/bookings/page"), [reportsLayout]) },
  { path: "/reports/bookings/:id", Component: ported(() => import("@/pages/staff/reports/bookings/[id]/page"), bookingFile) },
  {
    path: "/reports/bookings/:id/payments",
    Component: ported(() => import("@/pages/staff/reports/bookings/[id]/payments/page"), bookingFile),
  },
  {
    path: "/reports/bookings/:id/insurance-rto",
    Component: ported(() => import("@/pages/staff/reports/bookings/[id]/insurance-rto/page"), bookingFile),
  },
  {
    path: "/reports/bookings/:id/delivery",
    Component: ported(() => import("@/pages/staff/reports/bookings/[id]/delivery/page"), bookingFile),
  },
  {
    path: "/reports/bookings/:id/hold-cancel",
    Component: ported(() => import("@/pages/staff/reports/bookings/[id]/hold-cancel/page"), bookingFile),
  },

  // Masters
  { path: "/admin/price-list/import", Component: ported(() => import("@/pages/staff/admin/price-list/import/page")) },
  { path: "/admin/:entity", Component: ported(() => import("@/pages/staff/admin/[entity]/page")) },
];

// Hands the router's navigate to code outside components (server actions, redirect()).
function NavigateBridge() {
  const navigate = useNavigate();
  useEffect(() => setNavigate(navigate), [navigate]);
  return null;
}

export default function App() {
  return (
    <>
      <NavigateBridge />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/set-password" element={<SetPasswordPage />} />
        <Route
          element={
            <ProtectedRoute>
              <AdminPanel />
            </ProtectedRoute>
          }
        >
          {routes.map(({ path, Component }) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<p className="py-10 text-center text-sm text-slate-400">Loading…</p>}>
                  <Component />
                </Suspense>
              }
            />
          ))}
          <Route path="/reports" element={<Navigate to="/reports/quotes" replace />} />
          <Route path="*" element={<p className="py-10 text-center text-sm text-slate-500">Page not found.</p>} />
        </Route>
      </Routes>
    </>
  );
}
