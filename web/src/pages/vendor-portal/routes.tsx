import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const VendorHomePage = lazy(() => import('./VendorHomePage'));
const ProfilePage = lazy(() => import('./ProfilePage'));
const OnboardingPage = lazy(() => import('./OnboardingPage'));
const RegisterPage = lazy(() => import('./RegisterPage'));
const NewTicketPage = lazy(() => import('../vendors/TicketPages').then((m) => ({ default: m.NewTicketPage })));
const VendorTickets = lazy(() => import('../vendors/TicketsRoute').then((m) => ({ default: m.VendorTickets })));
const VendorTicket = lazy(() => import('../vendors/TicketsRoute').then((m) => ({ default: m.VendorTicket })));

/** Vendor portal routes (under /vendor) — signed-in vendor users (Module 9). RFQ/PO/ASN/invoice/dispute pages live in their own areas. */
export const routes: RouteObject[] = [
  { path: '/vendor', element: <VendorHomePage /> },
  { path: '/vendor/profile', element: <ProfilePage /> },
  { path: '/vendor/onboarding', element: <OnboardingPage /> },
  { path: '/vendor/tickets', element: <VendorTickets /> },
  { path: '/vendor/tickets/new', element: <NewTicketPage /> },
  { path: '/vendor/tickets/:id', element: <VendorTicket /> },
];
/** Public routes (no session): accept a vendor invitation by setting a password. */
export const publicRoutes: RouteObject[] = [{ path: '/register', element: <RegisterPage /> }];
