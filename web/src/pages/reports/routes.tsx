import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const ReportsHome = lazy(() => import('./ReportsHome'));
const ReportPage = lazy(() => import('./ReportPage'));
const KpisPage = lazy(() => import('./KpisPage'));

/** Routes owned by the reports area (RPT-01..12, KPI-01..15). */
export const routes: RouteObject[] = [
  { path: '/reports', element: <ReportsHome /> },
  { path: '/reports/kpis', element: <KpisPage /> },
  { path: '/reports/:id', element: <ReportPage /> },
];
