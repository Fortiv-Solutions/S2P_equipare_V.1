import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const MonitorPage = lazy(() => import('./MonitorPage'));
const ErrorQueuePage = lazy(() => import('./ErrorQueuePage'));
const ReconciliationPage = lazy(() => import('./ReconciliationPage'));
const RunbookPage = lazy(() => import('./RunbookPage'));
const SimulatorPage = lazy(() => import('./SimulatorPage'));

/** Routes owned by the integration area (Module 12). */
export const routes: RouteObject[] = [
  { path: '/integration', element: <MonitorPage /> },
  { path: '/integration/errors', element: <ErrorQueuePage /> },
  { path: '/integration/reconciliation', element: <ReconciliationPage /> },
  { path: '/integration/runbook', element: <RunbookPage /> },
  { path: '/sap-simulator', element: <SimulatorPage /> },
];
