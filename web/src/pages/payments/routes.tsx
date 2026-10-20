import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const PaymentsPage = lazy(() => import('./PaymentsPage'));
const AdvanceNewPage = lazy(() => import('./AdvanceNewPage'));
const AdvancePage = lazy(() => import('./AdvancePage'));
const VendorPaymentsPage = lazy(() => import('./VendorPaymentsPage'));

/** Routes owned by the payments area: SCR-PAY-01/02 (internal) and SCR-VPT-08 (vendor). */
export const routes: RouteObject[] = [
  { path: '/payments', element: <PaymentsPage /> },
  { path: '/advances/new', element: <AdvanceNewPage /> },
  { path: '/advances/:id', element: <AdvancePage /> },
  { path: '/vendor/payments', element: <VendorPaymentsPage /> },
];
