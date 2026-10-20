import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const ComparisonsPage = lazy(() => import('./ComparisonsPage'));
const RfqComparisonPage = lazy(() => import('./RfqComparisonPage'));
const ComparisonPage = lazy(() => import('./ComparisonPage'));

/** Routes owned by the cmp area (Module 4). */
export const routes: RouteObject[] = [
  { path: '/comparisons', element: <ComparisonsPage /> },
  { path: '/comparisons/rfq/:rfqId', element: <RfqComparisonPage /> },
  { path: '/comparisons/:id', element: <ComparisonPage /> },
];
