import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const AdminHubPage = lazy(() => import('./AdminHubPage'));
const UsersPage = lazy(() => import('./UsersPage'));
const ConfigPage = lazy(() => import('./ConfigPage'));
const MastersPage = lazy(() => import('./MastersPage'));
const JobsPage = lazy(() => import('./OpsPages').then((m) => ({ default: m.JobsPage })));
const OutboxPage = lazy(() => import('./OpsPages').then((m) => ({ default: m.OutboxPage })));
const AuditPage = lazy(() => import('./OpsPages').then((m) => ({ default: m.AuditPage })));

/** Platform administration (SCR-ADM-01..04). `/admin/approval-matrix` is owned by the approvals area. */
export const routes: RouteObject[] = [
  { path: '/admin', element: <AdminHubPage /> },
  { path: '/admin/users', element: <UsersPage /> },
  { path: '/admin/config', element: <ConfigPage /> },
  { path: '/admin/masters', element: <MastersPage /> },
  { path: '/admin/jobs', element: <JobsPage /> },
  { path: '/admin/outbox', element: <OutboxPage /> },
  { path: '/audit', element: <AuditPage /> },
];
