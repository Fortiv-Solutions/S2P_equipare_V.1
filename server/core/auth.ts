/**
 * Authentication & authorisation.
 *  - Internal users: password sign-in (Equipcare SSO is not configured — DEC-12).
 *  - Vendor users: password + one-time code (MFA). SMS/e-mail delivery is not live, so the code
 *    is returned to the sign-in screen and flagged as simulated delivery.
 *  - Every API request is authorised server-side (FR-PLT-03).
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { get, run, now, addHours } from './db.ts';
import { forbidden, HttpError } from './http.ts';
import { isRole, permsFor, permsForMerged, MERGED_ROLES, type Perm, type Role } from './permissions.ts';
import { SINGLE_USER, ADMIN_EMAIL, SESSION_ID_SINGLE } from './mode.ts';
import { audit } from './audit.ts';

export interface Actor {
  id: number;
  name: string;
  email: string;
  roles: Role[];
  role: Role;
  perms: Set<Perm>;
  vendorId: number | null;
  plants: string[] | '*';
  categories: string[];
  department: string | null;
  sessionId: string;
  ip?: string;
  channel?: string;
  /** Single-user Administrator holding every internal role at once (not the vendor portal). */
  merged?: boolean;
  /** Vendor company the Administrator is acting as in the vendor portal (single-user mode). */
  actingVendorName?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
  }
}

export const SESSION_COOKIE = 's2p_sid';
const SESSION_HOURS = 10;
const IDLE_MINUTES = 60;

export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(pw: string, stored: string) {
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

export const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export interface UserRow {
  id: number;
  name: string;
  email: string;
  roles: string;
  vendor_id: number | null;
  plant_scope: string | null;
  categories: string | null;
  department: string | null;
  active: number;
  locked: number;
  failed_attempts: number;
  password_hash: string;
  title: string | null;
  phone: string | null;
}

export function rolesOf(u: Pick<UserRow, 'roles'>): Role[] {
  return u.roles.split(',').map((r) => r.trim()).filter(isRole);
}

export function createSession(userId: number, role: Role, ip: string | undefined, mfaPending = false) {
  const id = crypto.randomBytes(32).toString('hex');
  run(
    'INSERT INTO sessions (id, user_id, active_role, created_at, expires_at, last_seen, ip, mfa_pending) VALUES (?,?,?,?,?,?,?,?)',
    id, userId, role, now(), addHours(new Date(), SESSION_HOURS), now(), ip ?? null, mfaPending ? 1 : 0,
  );
  return id;
}

export function destroySession(id: string) {
  run('DELETE FROM sessions WHERE id = ?', id);
}

export function revokeUserSessions(userId: number) {
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

function actorFromSession(sid: string, ip?: string): Actor | null {
  const s = get<{ id: string; user_id: number; active_role: string; expires_at: string; last_seen: string; mfa_pending: number }>(
    'SELECT id, user_id, active_role, expires_at, last_seen, mfa_pending FROM sessions WHERE id = ?',
    sid,
  );
  if (!s || s.mfa_pending) return null;
  const t = Date.now();
  if (new Date(s.expires_at).getTime() < t || t - new Date(s.last_seen).getTime() > IDLE_MINUTES * 60000) {
    destroySession(sid);
    return null;
  }
  const u = get<UserRow>('SELECT * FROM users WHERE id = ?', s.user_id);
  if (!u || !u.active || u.locked) return null;
  const roles = rolesOf(u);
  const role = (roles.includes(s.active_role as Role) ? s.active_role : roles[0]) as Role;
  run('UPDATE sessions SET last_seen = ? WHERE id = ?', now(), sid);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    roles,
    role,
    perms: permsFor(role),
    vendorId: role === 'VEN' ? u.vendor_id : null,
    plants: !u.plant_scope || u.plant_scope === '*' ? '*' : u.plant_scope.split(','),
    categories: u.categories ? u.categories.split(',') : [],
    department: u.department,
    sessionId: sid,
    ip,
    channel: 'web',
  };
}

// ---------------------------------------------------------------- single-user mode
export function adminUser() {
  const u = get<UserRow>('SELECT * FROM users WHERE email = ?', ADMIN_EMAIL);
  if (!u) throw new HttpError(500, 'no_admin', 'The administrator account is missing. Run "npm run seed" to recreate the demo data.');
  return u;
}

/**
 * Which workspace a browser is in is kept in that browser's own cookie (`s2p_view` = `v:<vendor id>` while acting as a
 * vendor), never on the server: a shared server-side switch would flip every open tab and script at once.
 */
export const VIEW_COOKIE = 's2p_view';
export const viewCookieOptions = { httpOnly: true, sameSite: 'strict' as const, path: '/', maxAge: 30 * 86400000 };

export function singleUserActor(ip?: string, view?: string): Actor {
  const u = adminUser();
  const vid = /^v:(\d+)$/.exec(view ?? '')?.[1];
  const vendor = vid ? get<{ id: number; name: string }>('SELECT id, name FROM vendors WHERE id = ?', Number(vid)) : undefined;
  const base = {
    id: u.id, email: u.email, roles: MERGED_ROLES, plants: '*' as const, categories: u.categories ? u.categories.split(',') : [],
    department: u.department, sessionId: SESSION_ID_SINGLE, ip,
  };
  if (vendor) return { ...base, name: `${u.name} (as ${vendor.name})`, role: 'VEN', perms: permsFor('VEN'), vendorId: vendor.id, actingVendorName: vendor.name };
  return { ...base, name: u.name, role: 'ADM', perms: permsForMerged(), vendorId: null, merged: true };
}

/** Attach the actor: the Administrator in single-user mode, otherwise from the session cookie. */
export function sessionMiddleware(req: Request, _res: Response, next: NextFunction) {
  if (SINGLE_USER) {
    const a = singleUserActor(req.ip, req.cookies?.[VIEW_COOKIE]);
    a.channel = /Mobi|Android|iPhone/i.test(req.get('user-agent') ?? '') ? 'mobile' : 'web';
    req.actor = a;
    return next();
  }
  const sid = req.cookies?.[SESSION_COOKIE];
  if (sid) {
    const a = actorFromSession(sid, req.ip);
    if (a) {
      a.channel = /Mobi|Android|iPhone/i.test(req.get('user-agent') ?? '') ? 'mobile' : 'web';
      req.actor = a;
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.actor) return next(new HttpError(401, 'unauthenticated', 'Your session has ended. Sign in again.'));
  next();
}

/** Deny by default: actor must hold at least one of the listed permissions. */
export function requirePerm(...perms: Perm[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor) return next(new HttpError(401, 'unauthenticated', 'Your session has ended. Sign in again.'));
    if (!perms.some((p) => req.actor!.perms.has(p))) {
      // Single-user mode: a tab that is still in the other workspace (admin vs. vendor portal) gets a recoverable error.
      if (SINGLE_USER) {
        const vendorPerms = permsFor('VEN');
        const vendorSide = perms.every((p) => vendorPerms.has(p));
        const internalSide = perms.every((p) => !vendorPerms.has(p));
        if ((req.actor.role === 'VEN' && internalSide) || (req.actor.role !== 'VEN' && vendorSide)) {
          return next(new HttpError(403, 'wrong_workspace', 'This browser switched workspace (administrator or vendor portal). Reloading to match.'));
        }
      }
      return next(forbidden());
    }
    next();
  };
}

export function can(actor: Actor | undefined, ...perms: Perm[]) {
  return !!actor && perms.some((p) => actor.perms.has(p));
}

/** Returns the actor or throws 401 — use inside handlers. */
export function actorOf(req: Request): Actor {
  if (!req.actor) throw new HttpError(401, 'unauthenticated', 'Your session has ended. Sign in again.');
  return req.actor;
}

/** Vendor data isolation (GOV-C09, NFR-SEC-04): throw 404 when a vendor touches another vendor's record. */
export function assertVendorScope(actor: Actor, vendorId: number | null | undefined, objectType = 'record', objectId?: number | string) {
  if (actor.role === 'VEN' && actor.vendorId !== vendorId) {
    audit(actor, {
      action: 'security.cross_vendor_access_denied',
      objectType,
      objectId: objectId ?? null,
      after: { requested_vendor: vendorId ?? null, actor_vendor: actor.vendorId },
    });
    throw new HttpError(404, 'not_found', 'Record not found.');
  }
}

export function plantAllowed(actor: Actor, plant: string | null | undefined) {
  return actor.plants === '*' || !plant || actor.plants.includes(plant);
}
