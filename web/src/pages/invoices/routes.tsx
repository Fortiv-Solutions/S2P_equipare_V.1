import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const InvoiceListPage = lazy(() => import('./InvoiceListPage'));
const ExceptionQueuePage = lazy(() => import('./ExceptionQueuePage'));
const InvoiceReviewPage = lazy(() => import('./InvoiceReviewPage'));
const InvoiceUploadPage = lazy(() => import('./InvoiceUploadPage'));
const VendorInvoicesPage = lazy(() => import('./VendorInvoicesPage'));
const VendorInvoicePage = lazy(() => import('./VendorInvoicePage'));

/** Routes owned by the invoices area: SCR-INV-01..03 (internal) and SCR-VPT-07 (vendor). */
export const routes: RouteObject[] = [
  { path: '/invoices', element: <InvoiceListPage /> },
  { path: '/invoices/exceptions', element: <ExceptionQueuePage /> },
  { path: '/invoices/upload', element: <InvoiceUploadPage /> },
  { path: '/invoices/:id', element: <InvoiceReviewPage /> },
  { path: '/vendor/invoices', element: <VendorInvoicesPage /> },
  { path: '/vendor/invoices/upload', element: <InvoiceUploadPage vendor /> },
  { path: '/vendor/invoices/:id', element: <VendorInvoicePage /> },
];
