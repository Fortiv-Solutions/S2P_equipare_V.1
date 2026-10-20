import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const HomePage = lazy(() => import('./HomePage'));
const NotificationsPage = lazy(() => import('./NotificationsPage'));
const ProfilePage = lazy(() => import('./ProfilePage'));

export const routes: RouteObject[] = [
  { path: '/', element: <HomePage /> },
  { path: '/notifications', element: <NotificationsPage /> },
  { path: '/profile', element: <ProfilePage /> },
];

export const publicRoutes: RouteObject[] = [];
