import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { migrate } from './core/schema.ts';
import { sessionMiddleware } from './core/auth.ts';
import { errorHandler, HttpError } from './core/http.ts';
import { coreRouter } from './core/routes.ts';
import { startScheduler } from './core/scheduler.ts';
import { MODULES } from './modules/index.ts';
import { ensureSeeded } from './seed/seed.ts';
import { registerCoreJobs } from './core/jobs.ts';
import { isVendorActive } from './modules/vendors/service.ts';
import { ensureSingleUser } from './core/singleuser.ts';
import { SINGLE_USER } from './core/mode.ts';

migrate();
for (const m of MODULES) m.init?.();
ensureSeeded();
ensureSingleUser();

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

// Single-user mode has no sign-in, so network reachability IS the access control. Refuse any request whose Host
// header is not a local name (stops DNS-rebinding and cross-site calls). Add names with S2P_ALLOWED_HOSTS=a.example,b.example.
if (SINGLE_USER) {
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]', ...(process.env.S2P_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);
  app.use((req, _res, next) => {
    const host = (req.get('host') ?? '').toLowerCase().replace(/:\d+$/, '');
    if (allowed.has(host)) return next();
    next(new HttpError(403, 'bad_host', 'This server runs without sign-in and only answers on localhost.'));
  });
}
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Baseline security headers (NFR-SEC). CSP allows Google Fonts used by the design system.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  next();
});

// Simple per-IP rate limit on sign-in and uploads (NFR-API-01).
const hits = new Map<string, number[]>();
function rateLimit(max: number, windowMs: number) {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const key = `${req.baseUrl}${req.path}:${req.ip}`;
    const t = Date.now();
    const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    list.push(t);
    hits.set(key, list);
    if (list.length > max) return next(new HttpError(429, 'rate_limited', 'Too many attempts. Wait a minute and try again.'));
    next();
  };
}
app.use('/api/auth/login', rateLimit(20, 60000));
app.use('/api/auth/verify-otp', rateLimit(20, 60000));
app.use('/api/files', rateLimit(120, 60000));

// CSRF defence in depth: state-changing requests from another origin are refused.
app.use('/api', (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    const o = new URL(origin);
    const host = req.get('x-forwarded-host') ?? req.get('host') ?? '';
    const ok = o.host === host || ['localhost', '127.0.0.1'].includes(o.hostname) && ['localhost', '127.0.0.1'].includes(host.split(':')[0]);
    if (!ok) return next(new HttpError(403, 'bad_origin', 'Request origin is not allowed.'));
  } catch {
    return next(new HttpError(403, 'bad_origin', 'Request origin is not allowed.'));
  }
  next();
});
app.use('/api', sessionMiddleware);
// Vendors who are not Active yet (onboarding, no SAP code) can only use onboarding, profile, tickets and basics.
const ONBOARDING_ALLOWED = ['/auth', '/vendors', '/notifications', '/files', '/meta', '/nav-counts', '/me', '/comments', '/views', '/search'];
app.use('/api', (req, _res, next) => {
  const a = req.actor;
  if (!a || a.role !== 'VEN' || a.vendorId == null) return next();
  if (ONBOARDING_ALLOWED.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
  if (isVendorActive(a.vendorId)) return next();
  next(new HttpError(403, 'vendor_not_active', 'Your company is still being onboarded. RFQs, POs, invoices and payments open once procurement and finance approve your registration and the SAP vendor code is linked.'));
});
app.use('/api', coreRouter);
for (const m of MODULES) {
  app.use(`/api/${m.path}`, m.router);
}
registerCoreJobs();

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'Unknown API endpoint.')));
app.use(errorHandler);

const dist = path.resolve(process.cwd(), 'web/dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const PORT = Number(process.env.PORT ?? 4000);
// Without sign-in, listen on the loopback interface only unless the operator opts in with HOST.
const HOST = process.env.HOST ?? (SINGLE_USER ? '127.0.0.1' : undefined);
if (process.env.S2P_NO_LISTEN !== '1') {
  const onListen = () => {
    console.log(`Equipcare S2P API on http://localhost:${PORT}`);
    if (process.env.S2P_NO_SCHEDULER !== '1') startScheduler();
    if (SINGLE_USER) console.log(`Single-user mode: no sign-in; listening on ${HOST ?? 'all interfaces'} only.${HOST && !['127.0.0.1', 'localhost', '::1'].includes(HOST) ? ' WARNING: this host is reachable from the network and anyone who can connect is the Administrator.' : ''}`);
  };
  if (HOST) app.listen(PORT, HOST, onListen);
  else app.listen(PORT, onListen);
}
