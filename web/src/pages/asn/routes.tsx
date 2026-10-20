import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const AsnListPage = lazy(() => import('./AsnListPage'));
const AsnDetailPage = lazy(() => import('./AsnDetailPage'));
const AsnFormPage = lazy(() => import('./AsnFormPage'));
const ReceiptsPage = lazy(() => import('./ReceiptsPage'));
const DisputeListPage = lazy(() => import('./DisputeListPage'));
const DisputeCapturePage = lazy(() => import('./DisputeCapturePage'));
const DisputeDetailPage = lazy(() => import('./DisputeDetailPage'));

/** Routes owned by the asn area: ASN, expected receipts, disputes (internal) and the vendor dispatch / dispute screens. */
export const routes: RouteObject[] = [
  { path: '/asns', element: <AsnListPage /> },
  { path: '/asns/:id', element: <AsnDetailPage /> },
  { path: '/receipts', element: <ReceiptsPage /> },
  { path: '/disputes', element: <DisputeListPage /> },
  { path: '/disputes/new', element: <DisputeCapturePage /> },
  { path: '/disputes/:id', element: <DisputeDetailPage /> },
  { path: '/vendor/asns', element: <AsnListPage vendor /> },
  { path: '/vendor/asns/new', element: <AsnFormPage /> },
  { path: '/vendor/asns/:id', element: <AsnDetailPage vendor /> },
  { path: '/vendor/asns/:id/edit', element: <AsnFormPage /> },
  { path: '/vendor/disputes', element: <DisputeListPage vendor /> },
  { path: '/vendor/disputes/:id', element: <DisputeDetailPage vendor /> },
];
