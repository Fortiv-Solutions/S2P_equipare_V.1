import { lazy } from 'react';
import { Navigate, useSearchParams, type RouteObject } from 'react-router-dom';
import { useAuth } from '@/lib/auth';

const WorkbenchPage = lazy(() => import('./WorkbenchPage'));
const PrLinePage = lazy(() => import('./PrLinePage'));
const MyRequirementsPage = lazy(() => import('./MyRequirementsPage'));

/**
 * The requisitioner's own status view. For the merged Administrator it is a view inside the PR workbench, and links
 * aimed at one requisition (e.g. from a notification) open that line in the workbench instead.
 */
function RequirementsEntry() {
  const { me } = useAuth();
  const focus = useSearchParams()[0].get('focus');
  if (me?.merged && focus) return <Navigate to={`/pr/${focus}`} replace />;
  return <MyRequirementsPage />;
}

export const routes: RouteObject[] = [
  { path: '/pr', element: <WorkbenchPage /> },
  { path: '/pr/:id', element: <PrLinePage /> },
  { path: '/my-requirements', element: <RequirementsEntry /> },
];
