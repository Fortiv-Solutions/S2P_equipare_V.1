import { Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation, useRouteError, type RouteObject } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { AppShell } from '@/layout/AppShell';
import { LoginPage } from '@/pages/auth/LoginPage';
import { Button, Empty, LoadingBlock } from '@/components/ui';
import { routes as commonRoutes, publicRoutes } from '@/pages/common/routes';
import { routes as prRoutes } from '@/pages/pr/routes';
import { routes as rfqRoutes } from '@/pages/rfq/routes';
import { routes as cmpRoutes } from '@/pages/cmp/routes';
import { routes as approvalRoutes } from '@/pages/approvals/routes';
import { routes as contractRoutes } from '@/pages/contracts/routes';
import { routes as poRoutes } from '@/pages/po/routes';
import { routes as asnRoutes } from '@/pages/asn/routes';
import { routes as vendorPortalRoutes, publicRoutes as vendorPublicRoutes } from '@/pages/vendor-portal/routes';
import { routes as vendorRoutes } from '@/pages/vendors/routes';
import { routes as invoiceRoutes } from '@/pages/invoices/routes';
import { routes as paymentRoutes } from '@/pages/payments/routes';
import { routes as integrationRoutes } from '@/pages/integration/routes';
import { routes as reportRoutes } from '@/pages/reports/routes';
import { routes as adminRoutes } from '@/pages/admin/routes';
import { SearchX, TriangleAlert } from 'lucide-react';

function Splash() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--primary-900)' }}>
      <img src="/brand/logo-white.svg" alt="Equipcare" style={{ height: 56, opacity: 0.9 }} />
    </div>
  );
}

/**
 * The sign-in screen. In single-user mode the server always acts as the Administrator, so there is always a
 * session and this redirects straight to the workspace; the screen only appears in multi-user mode.
 */
function LoginGate() {
  const { me, loading } = useAuth();
  if (loading) return <Splash />;
  if (me) return <Navigate to={me.role === 'VEN' ? '/vendor' : '/'} replace />;
  return <LoginPage />;
}

/** Signed-in users only; vendors are kept in /vendor and internal users out of it. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Splash />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  const vendorArea = loc.pathname === '/vendor' || loc.pathname.startsWith('/vendor/');
  const shared = ['/notifications', '/profile'].includes(loc.pathname);
  if (me.role === 'VEN' && !vendorArea && !shared) return <Navigate to="/vendor" replace />;
  if (me.role !== 'VEN' && vendorArea) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function RouteError() {
  const err = useRouteError() as Error | undefined;
  return (
    <div className="content">
      <Empty title="This screen hit an error" icon={<TriangleAlert size={24} />} action={<Button variant="deep" onClick={() => window.location.reload()}>Reload</Button>}>
        {err?.message ?? 'Unexpected error.'}
      </Empty>
    </div>
  );
}

export function NotFound() {
  return (
    <Empty title="Page not found" icon={<SearchX size={24} />} action={<Button variant="deep" onClick={() => history.back()}>Go back</Button>}>
      The link may be out of date, or your role does not include this screen.
    </Empty>
  );
}

const withSuspense = (rs: RouteObject[]): RouteObject[] =>
  rs.map((r) => ({ ...r, element: r.element ? <Suspense fallback={<LoadingBlock rows={6} />}>{r.element}</Suspense> : r.element, children: r.children ? withSuspense(r.children) : undefined }) as RouteObject);

const router = createBrowserRouter([
  { path: '/login', element: <LoginGate /> },
  ...withSuspense([...publicRoutes, ...vendorPublicRoutes]),
  {
    element: <RequireAuth><AppShell /></RequireAuth>,
    errorElement: <RouteError />,
    children: [
      {
        errorElement: <RouteError />,
        element: <Outlet />,
        children: withSuspense([
          ...commonRoutes, ...prRoutes, ...rfqRoutes, ...cmpRoutes, ...approvalRoutes, ...contractRoutes, ...poRoutes, ...asnRoutes,
          ...vendorPortalRoutes, ...vendorRoutes, ...invoiceRoutes, ...paymentRoutes, ...integrationRoutes, ...reportRoutes, ...adminRoutes,
          { path: '*', element: <NotFound /> },
        ]),
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
