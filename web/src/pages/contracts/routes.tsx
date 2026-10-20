import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const ContractsPage = lazy(() => import('./ContractsPage'));
const ContractFormPage = lazy(() => import('./ContractFormPage'));
const ContractDetailPage = lazy(() => import('./ContractDetailPage'));
const OpportunitiesPage = lazy(() => import('./OpportunitiesPage'));
const RenewalsPage = lazy(() => import('./RenewalsPage'));
const VendorContractsPage = lazy(() => import('./VendorContractsPage').then((m) => ({ default: m.VendorContractsPage })));
const VendorContractDetailPage = lazy(() => import('./VendorContractsPage').then((m) => ({ default: m.VendorContractDetailPage })));

/** Routes owned by the contracts area (Module 6). */
export const routes: RouteObject[] = [
  { path: '/contracts', element: <ContractsPage /> },
  { path: '/contracts/new', element: <ContractFormPage /> },
  { path: '/contracts/opportunities', element: <OpportunitiesPage /> },
  { path: '/contracts/renewals', element: <RenewalsPage /> },
  { path: '/contracts/:id', element: <ContractDetailPage /> },
  { path: '/contracts/:id/edit', element: <ContractFormPage /> },
  { path: '/vendor/contracts', element: <VendorContractsPage /> },
  { path: '/vendor/contracts/:id', element: <VendorContractDetailPage /> },
];
