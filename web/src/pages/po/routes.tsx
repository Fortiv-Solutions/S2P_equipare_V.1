import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const PoDashboardPage = lazy(() => import('./PoDashboardPage'));
const PoDetailPage = lazy(() => import('./PoDetailPage'));
const AmendPage = lazy(() => import('./AmendPage'));
const VendorPoListPage = lazy(() => import('./VendorPoListPage'));
const VendorPoDetailPage = lazy(() => import('./VendorPoDetailPage'));

/** Routes owned by the po area (Module 7). */
export const routes: RouteObject[] = [
  { path: '/pos', element: <PoDashboardPage /> },
  { path: '/pos/:id', element: <PoDetailPage /> },
  { path: '/pos/:id/amend', element: <AmendPage /> },
  { path: '/vendor/pos', element: <VendorPoListPage /> },
  { path: '/vendor/pos/:id', element: <VendorPoDetailPage /> },
];
