import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const InboxPage = lazy(() => import('./InboxPage'));
const DecisionPage = lazy(() => import('./DecisionPage'));
const ExceptionsPage = lazy(() => import('./ExceptionsPage'));
const MatrixPage = lazy(() => import('./MatrixPage'));

/** Routes owned by the approvals area (Module 5). */
export const routes: RouteObject[] = [
  { path: '/approvals', element: <InboxPage /> },
  { path: '/approvals/:id', element: <DecisionPage /> },
  { path: '/exceptions', element: <ExceptionsPage /> },
  { path: '/admin/approval-matrix', element: <MatrixPage /> },
];
