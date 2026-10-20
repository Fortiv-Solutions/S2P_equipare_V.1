import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const VendorsPage = lazy(() => import('./VendorsPage'));
const InviteVendorPage = lazy(() => import('./InviteVendorPage'));
const VendorDetailPage = lazy(() => import('./VendorDetailPage'));
const TicketsPage = lazy(() => import('./TicketsRoute').then((m) => ({ default: m.InternalTickets })));
const TicketPage = lazy(() => import('./TicketsRoute').then((m) => ({ default: m.InternalTicket })));

/** Internal vendor management and ticket handling (Module 9). */
export const routes: RouteObject[] = [
  { path: '/vendors', element: <VendorsPage /> },
  { path: '/vendors/invite', element: <InviteVendorPage /> },
  { path: '/vendors/:id', element: <VendorDetailPage /> },
  { path: '/tickets', element: <TicketsPage /> },
  { path: '/tickets/:id', element: <TicketPage /> },
];
