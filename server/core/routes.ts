/** Platform-wide API: auth, notifications, files, comments, search, audit, config, views, jobs, meta. */
import { Router } from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { all, get, insert, run, update, now, addHours, J } from './db.ts';
import { h, parse, badRequest, forbidden, notFound, conflict, HttpError, reasonSchema, idParam, sendCsv } from './http.ts';
import {
  SESSION_COOKIE, createSession, destroySession, revokeUserSessions, verifyPassword, hashPassword, rolesOf,
  requireAuth, requirePerm, actorOf, sha, type UserRow,
} from './auth.ts';
import { ROLES, ROLE_PERMISSIONS, isRole, type Role } from './permissions.ts';
import { audit, verifyChain } from './audit.ts';
import { cfg, listConfig, applyConfig } from './config.ts';
import { upload, storeFile, getAttachment, canReadFile, filePath, canAccessObject } from './files.ts';
import { createApproval, onDecision } from './approvals.ts';
import { freshness, simSettings } from './sap.ts';
import { listJobs, runJob } from './scheduler.ts';
import { SINGLE_USER } from './mode.ts';
import { VIEW_COOKIE, viewCookieOptions } from './auth.ts';

export const coreRouter = Router();

const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/' };
const MANDATORY_EVENTS = new Set(['NTF-10', 'NTF-11', 'NTF-22', 'NTF-28', 'NTF-32', 'NTF-33']);

// ---------------------------------------------------------------- auth
const noSignIn = () => new HttpError(409, 'single_user_mode', 'This installation runs in single-user mode: there is no sign-in. You are already working as the Administrator.');

coreRouter.post('/auth/login', h((req, res) => {
  if (SINGLE_USER) throw noSignIn();
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email('Enter a valid e-mail address'), password: z.string().min(1, 'Enter your password') }), req.body);
  const u = get<UserRow>('SELECT * FROM users WHERE lower(email) = ?', body.email);
  const max = cfg<number>('security.max_failed_logins');
  if (!u || !u.active) {
    audit(null, { action: 'auth.login_failed', objectType: 'user', objectRef: body.email, after: { reason: 'unknown or inactive account' } });
    throw new HttpError(401, 'invalid_credentials', 'E-mail or password is incorrect.');
  }
  if (u.locked) throw new HttpError(423, 'locked', `This account is locked after ${max} failed sign-ins. Ask your administrator to unlock it.`);
  if (!verifyPassword(body.password, u.password_hash)) {
    const attempts = u.failed_attempts + 1;
    const lock = attempts >= max;
    update('users', u.id, { failed_attempts: attempts, locked: lock ? 1 : 0 });
    audit({ id: u.id, name: u.name, role: rolesOf(u)[0], ip: req.ip } as never, { action: lock ? 'auth.account_locked' : 'auth.login_failed', objectType: 'user', objectId: u.id, after: { attempts } });
    if (lock) throw new HttpError(423, 'locked', `This account is now locked after ${max} failed sign-ins. Ask your administrator to unlock it.`);
    throw new HttpError(401, 'invalid_credentials', `E-mail or password is incorrect. ${max - attempts} attempt(s) left before the account locks.`);
  }
  const roles = rolesOf(u);
  const isVendor = roles.includes('VEN');
  const mfa = isVendor && cfg<boolean>('security.vendor_mfa');
  const sid = createSession(u.id, roles[0], req.ip, mfa);
  res.cookie(SESSION_COOKIE, sid, { ...cookieOpts, maxAge: 10 * 3600000 });
  if (mfa) {
    const code = String(crypto.randomInt(100000, 999999));
    run('UPDATE sessions SET otp_hash = ?, otp_expires_at = ? WHERE id = ?', sha(code + sid), addHours(new Date(), 0.17), sid);
    insert('outbox', { channel: 'sms', recipient: u.phone ?? u.email, subject: 'Equipcare S2P sign-in code', body: `Your sign-in code is ${code}`, template: 'AUTH-OTP.v1', status: 'Simulated — not sent (no SMS provider connected)', created_at: now() });
    return { mfaRequired: true, simulatedCode: code, delivery: 'Simulated delivery — no SMS or e-mail provider is connected, so the code is shown here.' };
  }
  update('users', u.id, { failed_attempts: 0, last_login: now() });
  audit({ id: u.id, name: u.name, role: roles[0], ip: req.ip } as never, { action: 'auth.login', objectType: 'user', objectId: u.id });
  return { ok: true };
}));

coreRouter.post('/auth/verify-otp', h((req) => {
  if (SINGLE_USER) throw noSignIn();
  const { code } = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }), req.body);
  const sid = req.cookies?.[SESSION_COOKIE];
  const s = sid ? get<{ id: string; user_id: number; otp_hash: string; otp_expires_at: string; mfa_pending: number }>('SELECT * FROM sessions WHERE id = ?', sid) : undefined;
  if (!s || !s.mfa_pending) throw new HttpError(401, 'unauthenticated', 'Sign in again to get a new code.');
  if (new Date(s.otp_expires_at).getTime() < Date.now()) throw new HttpError(401, 'otp_expired', 'The code has expired. Sign in again to get a new code.');
  if (sha(code + s.id) !== s.otp_hash) throw new HttpError(401, 'otp_invalid', 'That code is not correct.');
  run('UPDATE sessions SET mfa_pending = 0, otp_hash = NULL WHERE id = ?', s.id);
  const u = get<UserRow>('SELECT * FROM users WHERE id = ?', s.user_id)!;
  update('users', u.id, { failed_attempts: 0, last_login: now() });
  audit({ id: u.id, name: u.name, role: 'VEN', ip: req.ip } as never, { action: 'auth.login', objectType: 'user', objectId: u.id, after: { mfa: true } });
  return { ok: true };
}));

coreRouter.post('/auth/logout', h((req, res) => {
  if (SINGLE_USER) return { ok: true, singleUser: true };
  const sid = req.cookies?.[SESSION_COOKIE];
  if (sid) destroySession(sid);
  if (req.actor) audit(req.actor, { action: 'auth.logout', objectType: 'user', objectId: req.actor.id });
  res.clearCookie(SESSION_COOKIE, cookieOpts);
  return { ok: true };
}));

coreRouter.get('/auth/me', requireAuth, h((req) => {
  const a = actorOf(req);
  const u = get<UserRow & { vendor_role: string | null }>('SELECT * FROM users WHERE id = ?', a.id)!;
  const vendorId = SINGLE_USER ? a.vendorId : u.vendor_id;
  const vendor = vendorId ? get('SELECT id, name, sap_code, onboarding_status, portal_status FROM vendors WHERE id = ?', vendorId) : null;
  const singleLabel = 'Administrator — all modules';
  return {
    id: a.id, name: SINGLE_USER ? u.name : a.name, email: a.email, title: u.title, department: u.department, phone: u.phone,
    role: a.role,
    roleLabel: SINGLE_USER ? (a.merged ? singleLabel : `Vendor portal — ${a.actingVendorName}`) : ROLES[a.role],
    roles: SINGLE_USER ? [{ code: 'ADM', label: singleLabel }] : a.roles.map((r) => ({ code: r, label: ROLES[r] })),
    perms: [...a.perms], plants: a.plants, categories: a.categories, vendor, vendorRole: u.vendor_role,
    singleUser: SINGLE_USER, merged: !!a.merged, actingVendor: a.actingVendorName ? { id: a.vendorId, name: a.actingVendorName } : null,
  };
}));

/** Single-user mode: vendor companies the Administrator can open the vendor portal as. */
coreRouter.get('/auth/acting-vendors', requireAuth, h((req) => {
  if (!SINGLE_USER) throw forbidden('Acting as a vendor is only available in single-user mode.');
  actorOf(req);
  return all('SELECT id, name, sap_code, city, state, onboarding_status, portal_status FROM vendors ORDER BY (sap_code IS NULL), name');
}));

coreRouter.post('/auth/switch-role', requireAuth, h((req, res) => {
  const a = actorOf(req);
  if (SINGLE_USER) {
    const b = parse(z.object({ role: z.enum(['ADM', 'VEN']), vendor_id: z.number().int().positive().optional() }), req.body);
    if (b.role === 'VEN') {
      const v = b.vendor_id ? get<{ id: number; name: string }>('SELECT id, name FROM vendors WHERE id = ?', b.vendor_id) : undefined;
      if (!v) throw badRequest('Choose the vendor company to act as.', { vendor_id: 'Choose a vendor' });
      res.cookie(VIEW_COOKIE, `v:${v.id}`, viewCookieOptions);
      audit(a, { action: 'auth.acting_as_vendor', objectType: 'vendor', objectId: v.id, objectRef: v.name, before: { role: a.role, vendor_id: a.vendorId }, after: { role: 'VEN', vendor_id: v.id } });
    } else {
      res.clearCookie(VIEW_COOKIE, { path: '/' });
      audit(a, { action: 'auth.exited_vendor_portal', objectType: 'vendor', objectId: a.vendorId, before: { role: a.role, vendor_id: a.vendorId }, after: { role: 'ADM' } });
    }
    return { ok: true };
  }
  const { role } = parse(z.object({ role: z.string() }), req.body);
  if (!isRole(role) || !a.roles.includes(role)) throw forbidden('You do not hold that role.');
  run('UPDATE sessions SET active_role = ? WHERE id = ?', role, a.sessionId);
  audit(a, { action: 'auth.role_switched', objectType: 'user', objectId: a.id, before: { role: a.role }, after: { role } });
  return { ok: true };
}));

coreRouter.post('/auth/password', requireAuth, h((req, res) => {
  if (SINGLE_USER) throw new HttpError(409, 'single_user_mode', 'Single-user mode has no password to change.');
  const a = actorOf(req);
  const body = parse(z.object({ current: z.string().min(1), next: z.string().min(10, 'Use at least 10 characters').regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number') }), req.body);
  const u = get<UserRow>('SELECT * FROM users WHERE id = ?', a.id)!;
  if (!verifyPassword(body.current, u.password_hash)) throw badRequest('Current password is incorrect.', { current: 'Incorrect' });
  update('users', a.id, { password_hash: hashPassword(body.next) });
  revokeUserSessions(a.id);
  res.clearCookie(SESSION_COOKIE, cookieOpts);
  audit(a, { action: 'auth.password_changed', objectType: 'user', objectId: a.id });
  return { ok: true, signedOut: true };
}));

/** Demo personas for the sign-in screen (MVP demo mode only). */
coreRouter.get('/auth/demo-users', h(() => {
  if (SINGLE_USER || process.env.S2P_DEMO === '0') return [];
  return all<{ id: number; name: string; email: string; roles: string; title: string; vendor: string | null }>(
    'SELECT u.id, u.name, u.email, u.roles, u.title, v.name AS vendor FROM users u LEFT JOIN vendors v ON v.id = u.vendor_id WHERE u.active = 1 AND u.locked = 0 ORDER BY u.id',
  ).map((u) => ({ ...u, roles: u.roles.split(',').map((r) => ({ code: r, label: ROLES[r as Role] })) }));
}));

// ---------------------------------------------------------------- meta
coreRouter.get('/meta', requireAuth, h((req) => {
  const a = actorOf(req);
  const sim = simSettings();
  return {
    now: now(),
    roles: ROLES,
    sapOffline: sim.offline,
    freshness: a.role === 'VEN' ? [] : freshness().map((f) => ({ id: f.id, name: f.name, lastSuccess: f.lastSuccess, stale: f.stale, thresholdMinutes: f.thresholdMinutes, ageMinutes: f.ageMinutes })),
    lists: {
      delayReasons: cfg<string[]>('po.delay_reasons'),
      disputeTypes: ['Shortage', 'Excess', 'Damage', 'Transit damage', 'Transit loss', 'Accidental loss', 'Wrong material', 'Quality rejection', 'Document mismatch'],
      ticketCategories: Object.keys(cfg<Record<string, string>>('tickets.routing')),
      routes: ['ARC/OA', 'VMI', 'FDS', 'Fixed supplier', 'RFQ', 'Urgent/BD', 'Class 1', 'Capex', 'Service', 'Exception'],
      priorities: ['Normal', 'Urgent', 'BD', 'Class 1'],
      urgencyTypes: ['BD', 'Urgent', 'General stock', 'Class 1'],
      gstRates: [0, 5, 12, 18, 28],
    },
    channels: cfg('notify.channels'),
    sealed: cfg<boolean>('rfq.sealed'),
  };
}));

// ---------------------------------------------------------------- notifications
/**
 * Single-user mode keeps two inboxes on one account: the internal workspace sees internal notifications, and the
 * vendor portal (acting as a vendor) sees only that vendor's. Multi-user mode has per-user inboxes already.
 */
const inboxScope = (a: { role: string; vendorId: number | null }) =>
  !SINGLE_USER ? '' : a.role === 'VEN' ? `AND vendor_id = ${Number(a.vendorId)}` : 'AND vendor_id IS NULL';

coreRouter.get('/notifications', requireAuth, h((req) => {
  const a = actorOf(req);
  const unreadOnly = req.query.unread === '1';
  const scope = inboxScope(a);
  const items = all(
    `SELECT * FROM notifications WHERE user_id = ? ${scope} ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT 150`, a.id,
  );
  const unread = get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? ${scope} AND read_at IS NULL`, a.id)!.n;
  return { items, unread };
}));
coreRouter.post('/notifications/:id/read', requireAuth, h((req) => {
  const a = actorOf(req);
  run(`UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? ${inboxScope(a)} AND read_at IS NULL`, now(), idParam(req), a.id);
  return { ok: true };
}));
coreRouter.post('/notifications/read-all', requireAuth, h((req) => {
  const a = actorOf(req);
  run(`UPDATE notifications SET read_at = ? WHERE user_id = ? ${inboxScope(a)} AND read_at IS NULL`, now(), a.id);
  return { ok: true };
}));
coreRouter.get('/me/preferences', requireAuth, h((req) => {
  const u = get<{ notif_prefs: Record<string, string> | null }>('SELECT notif_prefs_json FROM users WHERE id = ?', actorOf(req).id)!;
  return { prefs: u.notif_prefs ?? {}, mandatory: [...MANDATORY_EVENTS], channels: cfg('notify.channels') };
}));
coreRouter.put('/me/preferences', requireAuth, h((req) => {
  const a = actorOf(req);
  const { prefs } = parse(z.object({ prefs: z.record(z.string(), z.enum(['immediate', 'digest', 'in_app_only'])) }), req.body);
  for (const k of Object.keys(prefs)) if (MANDATORY_EVENTS.has(k) && prefs[k] !== 'immediate') throw badRequest(`${k} is a mandatory notification and cannot be changed.`);
  run('UPDATE users SET notif_prefs_json = ? WHERE id = ?', J(prefs), a.id);
  audit(a, { action: 'user.preferences_updated', objectType: 'user', objectId: a.id, after: prefs });
  return { ok: true };
}));
coreRouter.get('/outbox', requirePerm('adm.config', 'sap.monitor'), h(() => all('SELECT * FROM outbox ORDER BY id DESC LIMIT 300')));

// ---------------------------------------------------------------- files
coreRouter.post('/files', requireAuth, upload.array('files', 10), h((req) => {
  const a = actorOf(req);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw badRequest('Choose at least one file to upload.');
  const ownerType = (req.body.owner_type as string) || null;
  const ownerId = req.body.owner_id ? Number(req.body.owner_id) : null;
  if (ownerType && ownerId && !canAccessObject(a, ownerType, ownerId)) throw notFound();
  const out = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      const s = storeFile(f, a, { ownerType: ownerType ?? undefined, ownerId, label: req.body.label, vendorVisible: req.body.vendor_visible !== '0' });
      audit(a, { action: 'file.uploaded', objectType: 'attachment', objectId: s.id, after: { filename: s.filename, owner: ownerType ? `${ownerType}:${ownerId}` : null, size: s.size } });
      out.push(s);
    } catch (e) {
      if (e instanceof HttpError) errors.push(e.message);
      else throw e;
    }
  }
  if (!out.length) throw badRequest(errors.join(' '));
  return { files: out, errors };
}));

coreRouter.get('/files', requireAuth, h((req) => {
  const a = actorOf(req);
  const ownerType = String(req.query.owner_type ?? '');
  const ownerId = Number(req.query.owner_id);
  if (!ownerType || !ownerId) throw badRequest('owner_type and owner_id are required.');
  if (!canAccessObject(a, ownerType, ownerId)) throw notFound();
  return all(
    `SELECT a.id, a.label, a.filename, a.mime, a.size, a.scan_status, a.scan_note, a.created_at, a.vendor_visible, u.name AS uploaded_by_name
     FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.owner_type = ? AND a.owner_id = ? ${a.role === 'VEN' ? 'AND a.vendor_visible = 1' : ''} ORDER BY a.id`,
    ownerType, ownerId,
  );
}));

coreRouter.get('/files/:id/download', requireAuth, h((req, res) => {
  const a = actorOf(req);
  const att = getAttachment(idParam(req));
  if (!att || !canReadFile(a, att)) throw notFound('File');
  if (att.scan_status !== 'Available' || !att.storage_path) throw new HttpError(410, 'unavailable', 'This file is quarantined and cannot be downloaded.');
  const p = filePath(att);
  if (!fs.existsSync(p)) throw notFound('File');
  audit(a, { action: 'file.downloaded', objectType: 'attachment', objectId: att.id, after: { filename: att.filename, owner: `${att.owner_type}:${att.owner_id}` } });
  res.setHeader('Content-Type', att.mime);
  res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${att.filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(p).pipe(res);
}));

// ---------------------------------------------------------------- comments (clarification threads)
coreRouter.get('/comments', requireAuth, h((req) => {
  const a = actorOf(req);
  const t = String(req.query.object_type ?? '');
  const id = Number(req.query.object_id);
  if (!t || !id || !canAccessObject(a, t, id)) throw notFound();
  return all(
    `SELECT c.id, c.body, c.internal, c.created_at, c.user_id, u.name AS user_name, u.roles AS user_roles
     FROM comments c JOIN users u ON u.id = c.user_id WHERE c.object_type = ? AND c.object_id = ? ${a.role === 'VEN' ? 'AND c.internal = 0' : ''} ORDER BY c.id`,
    t, id,
  );
}));
coreRouter.post('/comments', requireAuth, h((req) => {
  const a = actorOf(req);
  const b = parse(z.object({ object_type: z.string().min(1), object_id: z.number().int().positive(), body: z.string().trim().min(2, 'Write a message').max(2000), internal: z.boolean().optional() }), req.body);
  if (!canAccessObject(a, b.object_type, b.object_id)) throw notFound();
  const internal = a.role === 'VEN' ? 0 : b.internal === false ? 0 : 1;
  const id = insert('comments', { object_type: b.object_type, object_id: b.object_id, user_id: a.id, body: b.body, internal, created_at: now() });
  audit(a, { action: 'comment.posted', objectType: b.object_type, objectId: b.object_id, after: { comment_id: id, internal } });
  return { id };
}));

// ---------------------------------------------------------------- global search
coreRouter.get('/search', requireAuth, h((req) => {
  const a = actorOf(req);
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return [];
  const like = `%${q}%`;
  const out: { type: string; ref: string; title: string; subtitle?: string; link: string }[] = [];
  const has = (p: string) => a.perms.has(p as never);
  const ven = a.role === 'VEN' ? a.vendorId : null;
  if (has('pr.view') || has('pr.view_own')) {
    for (const r of all<{ id: number; pr_no: string; item: number; description: string; status: string }>(
      `SELECT id, pr_no, item, description, status FROM pr_lines WHERE (pr_no LIKE ? OR description LIKE ? OR material_code LIKE ?) ${has('pr.view') ? '' : 'AND requisitioner_id = ' + a.id} LIMIT 8`, like, like, like,
    )) out.push({ type: 'PR line', ref: `${r.pr_no}/${r.item}`, title: r.description, subtitle: r.status, link: has('pr.view') ? `/pr/${r.id}` : `/my-requirements?focus=${r.id}` });
  }
  if (has('rfq.view') || has('rfq.vendor')) {
    for (const r of all<{ id: number; rfq_no: string; title: string; status: string }>(
      ven ? 'SELECT r.id, r.rfq_no, r.title, r.status FROM rfqs r JOIN rfq_invitations i ON i.rfq_id = r.id AND i.vendor_id = ? WHERE r.status != \'Draft\' AND (r.rfq_no LIKE ? OR r.title LIKE ?) LIMIT 8'
        : 'SELECT id, rfq_no, title, status FROM rfqs WHERE rfq_no LIKE ? OR title LIKE ? LIMIT 8',
      ...(ven ? [ven, like, like] : [like, like]),
    )) out.push({ type: 'RFQ', ref: r.rfq_no, title: r.title, subtitle: r.status, link: ven ? `/vendor/rfqs/${r.id}` : `/rfqs/${r.id}` });
  }
  if (has('po.view') || has('po.vendor') || has('po.view_own_pr')) {
    const own = !has('po.view') && !ven ? `AND p.id IN (SELECT l.po_id FROM po_lines l JOIN pr_lines pr ON pr.id = l.pr_line_id WHERE pr.requisitioner_id = ${a.id})` : '';
    for (const r of all<{ id: number; po_no: string; vendor: string; status: string }>(
      `SELECT p.id, p.po_no, v.name AS vendor, p.status FROM pos p JOIN vendors v ON v.id = p.vendor_id WHERE (p.po_no LIKE ? OR v.name LIKE ?) ${ven ? 'AND p.vendor_id = ' + Number(ven) : ''} ${own} LIMIT 8`, like, like,
    )) out.push({ type: 'PO', ref: r.po_no, title: r.vendor, subtitle: r.status, link: ven ? `/vendor/pos/${r.id}` : has('po.view') ? `/pos/${r.id}` : `/my-requirements` });
  }
  if (has('asn.view') || has('asn.vendor')) {
    for (const r of all<{ id: number; asn_no: string; status: string; lr_no: string }>(
      `SELECT id, asn_no, status, lr_no FROM asns WHERE (asn_no LIKE ? OR lr_no LIKE ? OR eway_bill LIKE ?) ${ven ? 'AND vendor_id = ' + Number(ven) : ''} LIMIT 6`, like, like, like,
    )) out.push({ type: 'ASN', ref: r.asn_no, title: `LR ${r.lr_no ?? '—'}`, subtitle: r.status, link: ven ? `/vendor/asns/${r.id}` : `/asns/${r.id}` });
  }
  if (has('inv.view') || has('inv.vendor')) {
    for (const r of all<{ id: number; inv_ref: string; vendor_invoice_no: string; status: string }>(
      `SELECT id, inv_ref, vendor_invoice_no, status FROM invoices WHERE (inv_ref LIKE ? OR vendor_invoice_no LIKE ?) ${ven ? 'AND vendor_id = ' + Number(ven) : ''} LIMIT 6`, like, like,
    )) out.push({ type: 'Invoice', ref: r.inv_ref, title: `Vendor invoice ${r.vendor_invoice_no ?? '—'}`, subtitle: r.status, link: ven ? `/vendor/invoices/${r.id}` : `/invoices/${r.id}` });
  }
  if (has('dsp.view') || has('dsp.vendor')) {
    for (const r of all<{ id: number; dsp_no: string; type: string; status: string }>(
      `SELECT id, dsp_no, type, status FROM disputes WHERE (dsp_no LIKE ? OR type LIKE ?) ${ven ? 'AND po_id IN (SELECT id FROM pos WHERE vendor_id = ' + Number(ven) + ')' : ''} LIMIT 6`, like, like,
    )) out.push({ type: 'Dispute', ref: r.dsp_no, title: r.type, subtitle: r.status, link: ven ? `/vendor/disputes/${r.id}` : `/disputes/${r.id}` });
  }
  if (has('tkt.raise') || has('tkt.handle')) {
    for (const r of all<{ id: number; tkt_no: string; subject: string; status: string }>(
      `SELECT id, tkt_no, subject, status FROM tickets WHERE (tkt_no LIKE ? OR subject LIKE ?) ${ven ? 'AND vendor_id = ' + Number(ven) : ''} LIMIT 6`, like, like,
    )) out.push({ type: 'Ticket', ref: r.tkt_no, title: r.subject, subtitle: r.status, link: ven ? `/vendor/tickets/${r.id}` : `/tickets/${r.id}` });
  }
  if (has('vendor.view')) {
    for (const r of all<{ id: number; name: string; sap_code: string; city: string }>(
      'SELECT id, name, sap_code, city FROM vendors WHERE name LIKE ? OR sap_code LIKE ? OR gstin LIKE ? LIMIT 6', like, like, like,
    )) out.push({ type: 'Vendor', ref: r.sap_code ?? 'No SAP code', title: r.name, subtitle: r.city, link: `/vendors/${r.id}` });
  }
  if (has('con.view') || has('con.vendor')) {
    for (const r of all<{ id: number; contract_no: string; title: string; status: string }>(
      `SELECT id, contract_no, title, status FROM contracts WHERE (contract_no LIKE ? OR title LIKE ? OR sap_oa_no LIKE ?) ${ven ? 'AND vendor_id = ' + Number(ven) : ''} LIMIT 6`, like, like, like,
    )) out.push({ type: 'Contract', ref: r.contract_no, title: r.title, subtitle: r.status, link: ven ? `/vendor/contracts` : `/contracts/${r.id}` });
  }
  if (a.role !== 'VEN') {
    for (const r of all<{ id: number; code: string; description: string }>('SELECT id, code, description FROM materials WHERE code LIKE ? OR description LIKE ? LIMIT 5', like, like)) {
      if (has('pr.view')) out.push({ type: 'Material', ref: r.code, title: r.description, link: `/pr?material=${encodeURIComponent(r.code)}` });
    }
  }
  return out;
}));

// ---------------------------------------------------------------- audit
const AUDIT_SCOPE: Partial<Record<Role, string[]>> = {
  FIN: ['invoice', 'advance', 'payment', 'config', 'dispute', 'vendor_change'],
  SAP: ['integration_flow', 'integration_error', 'sapsim'],
  APR: ['approval', 'pr_line', 'rfq', 'comparison', 'contract', 'po', 'po_amendment', 'dispute', 'vendor', 'config'],
};
coreRouter.get('/audit', requirePerm('audit.view'), h((req) => {
  const a = actorOf(req);
  const q = req.query as Record<string, string | undefined>;
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.object_type && q.object_id) {
    if (!canAccessObject(a, q.object_type, Number(q.object_id))) throw notFound();
    where.push('object_type = ? AND object_id = ?');
    params.push(q.object_type, q.object_id);
  } else if (!a.perms.has('audit.view_all')) {
    const types = AUDIT_SCOPE[a.role];
    if (types) {
      where.push(`(actor_id = ? OR object_type IN (${types.map(() => '?').join(',')}))`);
      params.push(a.id, ...types);
    } else {
      where.push('actor_id = ?');
      params.push(a.id);
    }
  }
  if (q.action) { where.push('action LIKE ?'); params.push(`%${q.action}%`); }
  if (q.actor) { where.push('actor_name LIKE ?'); params.push(`%${q.actor}%`); }
  if (q.object) { where.push('(object_ref LIKE ? OR object_type LIKE ?)'); params.push(`%${q.object}%`, `%${q.object}%`); }
  if (q.from) { where.push('ts >= ?'); params.push(q.from); }
  if (q.to) { where.push('ts <= ?'); params.push(q.to + 'T23:59:59Z'); }
  const limit = Math.min(Number(q.limit ?? 500), 2000);
  const rows = all(`SELECT * FROM audit_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`, ...params);
  if (q.format === 'csv') {
    audit(a, { action: 'audit.exported', objectType: 'audit', after: { count: rows.length } });
    return sendCsv(req.res!, 'audit-log.csv', rows as Record<string, unknown>[], [
      { key: 'id', label: 'Event' }, { key: 'ts', label: 'Time (UTC)' }, { key: 'actor_name', label: 'User' }, { key: 'role', label: 'Role' },
      { key: 'action', label: 'Action' }, { key: 'object_type', label: 'Object' }, { key: 'object_ref', label: 'Reference' }, { key: 'object_id', label: 'Object id' },
      { key: 'before', label: 'Before' }, { key: 'after', label: 'After' }, { key: 'reason', label: 'Reason' }, { key: 'channel', label: 'Channel' }, { key: 'ip', label: 'IP' }, { key: 'hash', label: 'Hash' },
    ]);
  }
  return rows;
}));
coreRouter.get('/audit/verify', requirePerm('audit.view_all'), h(() => verifyChain()));

// ---------------------------------------------------------------- configuration
coreRouter.get('/config', requireAuth, h((req) => {
  const a = actorOf(req);
  if (a.role === 'VEN') throw forbidden();
  const pending = all<{ key: string; id: number; value: unknown; requested_by: number; reason: string; requested_at: string; approvals: unknown }>(
    "SELECT h.*, u.name AS requested_by_name FROM config_history h LEFT JOIN users u ON u.id = h.requested_by WHERE h.status = 'Pending'",
  );
  return { items: listConfig(), pending };
}));
coreRouter.get('/config/:key/history', requireAuth, h((req) => {
  if (actorOf(req).role === 'VEN') throw forbidden();
  return all("SELECT h.*, u.name AS requested_by_name FROM config_history h LEFT JOIN users u ON u.id = h.requested_by WHERE key = ? ORDER BY id DESC", req.params.key);
}));
coreRouter.put('/config/:key', requirePerm('adm.config'), h((req) => {
  const a = actorOf(req);
  const key = String(req.params.key);
  const row = get<{ key: string; value: unknown; requires_approval: number; label: string }>('SELECT key, value_json, requires_approval, label FROM config WHERE key = ?', key);
  if (!row) throw notFound('Setting');
  const body = parse(z.object({ value: z.unknown(), reason: reasonSchema }), req.body);
  if (JSON.stringify(body.value) === JSON.stringify(row.value)) throw badRequest('The new value is the same as the current value.');
  validateConfigValue(key, body.value, row.value);
  if (row.requires_approval) {
    const pending = get('SELECT id FROM config_history WHERE key = ? AND status = ?', key, 'Pending');
    if (pending) throw conflict('A change to this setting is already waiting for approval.');
    const hid = insert('config_history', { key, value_json: J(body.value), status: 'Pending', reason: body.reason, requested_by: a.id, requested_at: now() });
    const ap = createApproval(a, {
      type: 'config.tolerance', objectType: 'config_change', objectId: hid, title: `Change ${row.label}`,
      summary: `${JSON.stringify(row.value)} → ${JSON.stringify(body.value)}`, reason: body.reason,
      context: { key, from: row.value, to: body.value },
    });
    audit(a, { action: 'config.change_requested', objectType: 'config', objectId: key, before: row.value, after: body.value, reason: body.reason });
    return { status: 'Pending approval', approval: ap.req_no, message: 'Change saved as pending. Matching keeps using the active version until finance and procurement approve.' };
  }
  const version = applyConfig(key, body.value, a.id, body.reason);
  audit(a, { action: 'config.updated', objectType: 'config', objectId: key, before: row.value, after: body.value, reason: body.reason });
  return { status: 'Active', version };
}));

function validateConfigValue(key: string, value: unknown, current: unknown) {
  const sameShape = (x: unknown, y: unknown): boolean => {
    if (Array.isArray(y)) return Array.isArray(x);
    if (y && typeof y === 'object') return !!x && typeof x === 'object' && !Array.isArray(x);
    return typeof x === typeof y;
  };
  if (!sameShape(value, current)) throw badRequest(`Value for ${key} has the wrong format.`);
  if (key === 'tolerance.3wm') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v !== 'number' || v < 0) throw badRequest(`Tolerance ${k} must be a number ≥ 0.`);
  }
}

onDecision('config.tolerance', (ap, outcome, actor) => {
  const hid = ap.object_id;
  const hrow = get<{ key: string; value: unknown; reason: string }>('SELECT key, value_json, reason FROM config_history WHERE id = ?', hid);
  if (!hrow) return;
  if (outcome === 'Approved') {
    applyConfig(hrow.key, hrow.value, actor?.id ?? ap.requester_id, hrow.reason, hid);
    audit(actor, { action: 'config.change_approved', objectType: 'config', objectId: hrow.key, after: hrow.value, reason: `Approved via ${ap.req_no}` });
  } else {
    run('UPDATE config_history SET status = ?, decided_at = ? WHERE id = ?', outcome === 'Withdrawn' ? 'Withdrawn' : 'Rejected', now(), hid);
  }
});

// ---------------------------------------------------------------- saved views (FR-PLT-05)
coreRouter.get('/views', requireAuth, h((req) => all('SELECT * FROM saved_views WHERE user_id = ? AND screen = ? ORDER BY name', actorOf(req).id, String(req.query.screen ?? ''))));
coreRouter.post('/views', requireAuth, h((req) => {
  const b = parse(z.object({ screen: z.string().min(1), name: z.string().trim().min(1, 'Name the view').max(60), state: z.record(z.string(), z.unknown()) }), req.body);
  const id = insert('saved_views', { user_id: actorOf(req).id, screen: b.screen, name: b.name, state_json: J(b.state), created_at: now() });
  return { id };
}));
coreRouter.delete('/views/:id', requireAuth, h((req) => {
  run('DELETE FROM saved_views WHERE id = ? AND user_id = ?', idParam(req), actorOf(req).id);
  return { ok: true };
}));

// ---------------------------------------------------------------- jobs
coreRouter.get('/jobs', requirePerm('adm.config', 'sap.monitor'), h(() => ({ jobs: listJobs(), runs: all('SELECT * FROM job_runs ORDER BY id DESC LIMIT 100') })));
coreRouter.post('/jobs/:name/run', requirePerm('adm.config', 'sap.monitor'), h((req) => {
  const a = actorOf(req);
  const r = runJob(String(req.params.name));
  audit(a, { action: 'job.run_manual', objectType: 'job', objectId: String(req.params.name), after: r });
  return r;
}));

/** Badge counts for the navigation rail — what needs this user's attention. */
coreRouter.get('/nav-counts', requireAuth, h((req) => {
  const a = actorOf(req);
  const n = (sql: string, ...p: unknown[]) => (get<{ n: number }>(sql, ...p)?.n ?? 0);
  if (a.role === 'VEN') {
    const v = a.vendorId ?? -1;
    return {
      v_rfq: n("SELECT COUNT(*) AS n FROM rfq_invitations i JOIN rfqs r ON r.id = i.rfq_id WHERE i.vendor_id = ? AND r.status IN ('Published','Extended') AND i.status IN ('Invited','Viewed')", v),
      v_po: n("SELECT COUNT(DISTINCT p.id) AS n FROM pos p JOIN po_lines l ON l.po_id = p.id WHERE p.vendor_id = ? AND l.ack_status IN ('Pending','Pending re-acknowledgement') AND p.status NOT IN ('Cancelled','Closed')", v),
      v_inv: n("SELECT COUNT(*) AS n FROM invoices WHERE vendor_id = ? AND status = 'Exception'", v),
      v_dsp: n("SELECT COUNT(*) AS n FROM disputes d JOIN pos p ON p.id = d.po_id WHERE p.vendor_id = ? AND d.status IN ('Raised','Assigned','Awaiting response') AND d.owner_party = 'Vendor'", v),
      v_tkt: n("SELECT COUNT(*) AS n FROM tickets WHERE vendor_id = ? AND status = 'Awaiting vendor'", v),
    };
  }
  const out: Record<string, number> = {};
  if (a.perms.has('pr.work')) out.pr = n("SELECT COUNT(*) AS n FROM pr_lines WHERE buyer_id = ? AND status IN ('Assigned','Under review','Clarification pending')", a.id);
  if (a.perms.has('pr.assign') && a.role === 'APR') out.pr = n("SELECT COUNT(*) AS n FROM pr_lines WHERE status = 'Unassigned'");
  if (a.merged) out.pr = (out.pr ?? 0) + n("SELECT COUNT(*) AS n FROM pr_lines WHERE status = 'Unassigned'");
  if (a.perms.has('rfq.manage')) out.rfq = n("SELECT COUNT(*) AS n FROM rfqs WHERE buyer_id = ? AND status IN ('Closed')", a.id);
  if (a.perms.has('apr.decide')) {
    // The merged Administrator holds every approver role; a plain approver holds just the active one.
    const roles: string[] = a.merged ? ['APR', 'FIN', 'MGT'] : [a.role];
    out.approvals = n(`SELECT COUNT(DISTINCT s.approval_id) AS n FROM approval_steps s JOIN approvals ap ON ap.id = s.approval_id WHERE s.status = 'Pending' AND ap.status = 'Pending' AND s.approver_role IN (${roles.map(() => '?').join(',')}) AND ap.requester_id != ?`, ...roles, a.id);
  }
  if (a.perms.has('po.followup')) out.po = n("SELECT COUNT(DISTINCT p.id) AS n FROM pos p JOIN po_lines l ON l.po_id = p.id WHERE p.buyer_id = ? AND (l.ack_status IN ('Pending','Rejected','Pending re-acknowledgement') OR (l.status NOT IN ('Received','Closed','Cancelled') AND COALESCE(l.commit_date, l.delivery_date) < date('now'))) AND p.status NOT IN ('Cancelled','Closed')", a.id);
  if (a.perms.has('con.manage')) out.contracts = n("SELECT COUNT(*) AS n FROM contracts WHERE status = 'Expiring'");
  if (a.perms.has('dsp.manage') || a.perms.has('dsp.hold')) out.disputes = n("SELECT COUNT(*) AS n FROM disputes WHERE status NOT IN ('Closed','Resolved')");
  if (a.perms.has('inv.review')) out.invoices = n("SELECT COUNT(*) AS n FROM invoices WHERE status = 'Exception'");
  if (a.perms.has('vendor.review_kyc') || a.perms.has('vendor.onboard')) out.vendors = n("SELECT COUNT(*) AS n FROM vendors WHERE onboarding_status IN ('Submitted','Under review')") + n("SELECT COUNT(*) AS n FROM vendor_change_requests WHERE status = 'Pending'");
  if (a.perms.has('tkt.handle')) out.tickets = n("SELECT COUNT(*) AS n FROM tickets WHERE status IN ('Open','In progress') AND assignee_role = ?", a.role);
  if (a.perms.has('sap.monitor')) out.integration = n("SELECT COUNT(*) AS n FROM integration_errors WHERE status IN ('Queued','Retrying','Failed')");
  return out;
}));

/** List exports happen client-side from already-authorised data; record them as audit events. */
coreRouter.post('/audit-export', requireAuth, h((req) => {
  const b = parse(z.object({ screen: z.string().max(80), rows: z.number().int().min(0) }), req.body);
  audit(actorOf(req), { action: 'export.csv', objectType: 'screen', objectId: b.screen, after: { rows: b.rows } });
  return { ok: true };
}));

coreRouter.get('/permissions', requireAuth, h(() => ({ roles: ROLES, permissions: ROLE_PERMISSIONS })));
