import { Suspense, lazy, useEffect, type ComponentType } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import ProtectedRoute from "@/components/ProtectedRoute";
import AdminPanel from "@/pages/AdminPanel";
import LoginPage from "@/pages/login/page";
import SetPasswordPage from "@/pages/auth/set-password/page";
import { ServerPage, type ServerComponent } from "@/compat/server-page";
import { setNavigate } from "@/compat/navigate";
import RequireModule from "@/components/RequireModule";
import { phaseRoutes } from "@/routes";

const VerifyReceipt = lazy(() => import("@/pages/ops/billing/Stages").then((m) => ({ default: m.VerifyReceipt })));

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
export type RouteDef = { path: string; module?: string; Component: ComponentType };

const routes: RouteDef[] = [
  // Reporting home
  { path: "/", module: "pipeline", Component: ported(() => import("@/pages/staff/page")) },

  // Sales
  { path: "/enquiries", module: "enquiries", Component: ported(() => import("@/pages/staff/enquiries/page")) },
  { path: "/enquiries/new", module: "enquiries_new", Component: ported(() => import("@/pages/staff/enquiries/new/page")) },
  { path: "/crm-sync", module: "crm_sync", Component: ported(() => import("@/pages/staff/crm-sync/page")) },
  { path: "/finance", module: "finance_cases", Component: ported(() => import("@/pages/staff/finance/page")) },
  { path: "/finance/:id", module: "finance_cases", Component: ported(() => import("@/pages/staff/finance/[id]/page")) },

  // Stock
  { path: "/stock", module: "stock_free", Component: ported(() => import("@/pages/staff/stock/page"), [stockLayout]) },
  { path: "/stock/import", module: "stock_import", Component: ported(() => import("@/pages/staff/stock/import/page"), [stockLayout]) },
  { path: "/stock/match", module: "stock_match", Component: ported(() => import("@/pages/staff/stock/match/page"), [stockLayout]) },
  { path: "/stock/allotted", module: "stock_allotted", Component: ported(() => import("@/pages/staff/stock/allotted/page"), [stockLayout]) },
  { path: "/stock/billing", module: "stock_billing", Component: ported(() => import("@/pages/staff/stock/billing/page"), [stockLayout]) },
  { path: "/stock/ctdms", module: "stock_ctdms", Component: ported(() => import("@/pages/staff/stock/ctdms/page"), [stockLayout]) },
  { path: "/stock/finance-queue", module: "stock_finance_queue", Component: ported(() => import("@/pages/staff/stock/finance-queue/page"), [stockLayout]) },
  { path: "/stock/vna", module: "stock_vna", Component: ported(() => import("@/pages/staff/stock/vna/page"), [stockLayout]) },
  { path: "/stock/vehicle/:id", module: "stock_free", Component: ported(() => import("@/pages/staff/stock/vehicle/[id]/page"), [stockLayout]) },
  { path: "/stock/pool", module: "stock_pool", Component: ported(() => import("@/pages/staff/stock/pool/page"), [stockLayout]) },
  { path: "/stock/pool/config", module: "stock_pool_config", Component: ported(() => import("@/pages/staff/stock/pool/config/page"), [stockLayout]) },
  { path: "/stock/pool/audit", module: "stock_pool", Component: ported(() => import("@/pages/staff/stock/pool/audit/page"), [stockLayout]) },
  {
    path: "/stock/pool/:variant/:color", module: "stock_pool",
    Component: ported(() => import("@/pages/staff/stock/pool/[variant]/[color]/page"), [stockLayout]),
  },
  { path: "/payments", module: "payments", Component: ported(() => import("@/pages/staff/payments/page")) },
  { path: "/cancellations", module: "cancellations", Component: ported(() => import("@/pages/staff/cancellations/page")) },

  // People
  { path: "/hr", module: "hr", Component: ported(() => import("@/pages/staff/hr/page")) },
  { path: "/hr/new", module: "hr_new", Component: ported(() => import("@/pages/staff/hr/new/page")) },
  { path: "/hr/:id", module: "hr", Component: ported(() => import("@/pages/staff/hr/[id]/page")) },

  // Reporting
  { path: "/reports/consultants", module: "rpt_consultants", Component: ported(() => import("@/pages/staff/reports/consultants/page"), [reportsLayout]) },
  { path: "/reports/sources", module: "rpt_sources", Component: ported(() => import("@/pages/staff/reports/sources/page"), [reportsLayout]) },
  { path: "/reports/stock-ageing", module: "rpt_stock_ageing", Component: ported(() => import("@/pages/staff/reports/stock-ageing/page"), [reportsLayout]) },
  { path: "/reports/quotes", module: "rpt_quotes", Component: ported(() => import("@/pages/staff/reports/quotes/page"), [reportsLayout]) },
  { path: "/reports/approvals", module: "rpt_approvals", Component: ported(() => import("@/pages/staff/reports/approvals/page"), [reportsLayout]) },
  { path: "/reports/margin", module: "rpt_margin", Component: ported(() => import("@/pages/staff/reports/margin/page"), [reportsLayout]) },
  { path: "/reports/bookings", module: "rpt_bookings", Component: ported(() => import("@/pages/staff/reports/bookings/page"), [reportsLayout]) },
  { path: "/reports/bookings/:id", module: "rpt_bookings", Component: ported(() => import("@/pages/staff/reports/bookings/[id]/page"), bookingFile) },
  {
    path: "/reports/bookings/:id/payments", module: "rpt_bookings",
    Component: ported(() => import("@/pages/staff/reports/bookings/[id]/payments/page"), bookingFile),
  },
  {
    path: "/reports/bookings/:id/insurance-rto", module: "rpt_bookings",
    Component: ported(() => import("@/pages/staff/reports/bookings/[id]/insurance-rto/page"), bookingFile),
  },
  {
    path: "/reports/bookings/:id/delivery", module: "rpt_bookings",
    Component: ported(() => import("@/pages/staff/reports/bookings/[id]/delivery/page"), bookingFile),
  },
  {
    path: "/reports/bookings/:id/hold-cancel", module: "rpt_bookings",
    Component: ported(() => import("@/pages/staff/reports/bookings/[id]/hold-cancel/page"), bookingFile),
  },

  // Masters
  { path: "/admin/price-list/import", module: "masters", Component: ported(() => import("@/pages/staff/admin/price-list/import/page")) },
  { path: "/admin/:entity", module: "masters", Component: ported(() => import("@/pages/staff/admin/[entity]/page")) },

  // Admin
  { path: "/admin/access", module: "access_studio", Component: lazy(() => import("@/pages/admin/AccessStudio")) },

  // Phases 18–22 add their screens here.
  ...phaseRoutes,
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
        {/* Public: customers check a printed receipt by its number (Phase 30). */}
        <Route
          path="/verify/receipt"
          element={
            <Suspense fallback={null}>
              <VerifyReceipt />
            </Suspense>
          }
        />
        <Route
          element={
            <ProtectedRoute>
              <AdminPanel />
            </ProtectedRoute>
          }
        >
          {routes.map(({ path, module, Component }) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<p className="py-10 text-center text-sm text-slate-400">Loading…</p>}>
                  <RequireModule module={module}>
                    <Component />
                  </RequireModule>
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
