import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const WorkspacePage = lazy(() => import('./WorkspacePage'));

/** Overview page of each workspace. The module screens keep their own routes and appear as tabs. */
export const routes: RouteObject[] = [
  { path: '/sourcing', element: <WorkspacePage wkey="sourcing" /> },
  { path: '/delivery', element: <WorkspacePage wkey="delivery" /> },
  { path: '/finance', element: <WorkspacePage wkey="finance" /> },
];
