import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const RfqListPage = lazy(() => import('./RfqListPage'));
const RfqNewPage = lazy(() => import('./RfqNewPage'));
const RfqPage = lazy(() => import('./RfqPage'));
const VendorRfqInboxPage = lazy(() => import('./VendorRfqInboxPage'));
const VendorRfqPage = lazy(() => import('./VendorRfqPage'));

/** Routes owned by the rfq area (Module 2 RFQ automation, Module 3 vendor quotation entry). */
export const routes: RouteObject[] = [
  { path: '/rfqs', element: <RfqListPage /> },
  { path: '/rfqs/new', element: <RfqNewPage /> },
  { path: '/rfqs/:id', element: <RfqPage /> },
  { path: '/vendor/rfqs', element: <VendorRfqInboxPage /> },
  { path: '/vendor/rfqs/:id', element: <VendorRfqPage /> },
];
