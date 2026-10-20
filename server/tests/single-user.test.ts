/**
 * Single-user mode: no sign-in, one Administrator account holding every internal module, vendor portal reached by
 * acting as a vendor company. Runs against the seeded demo data after the merge.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type Client } from './helpers.ts';

let t: Awaited<ReturnType<typeof startApp>>;
let admin: Client;
beforeAll(async () => {
  t = await startApp({ singleUser: true });
  admin = await t.login('anyone');
});
afterAll(async () => { await t.close(); });

const vendorId = (code: string) => t.db.get<{ id: number }>('SELECT id FROM vendors WHERE sap_code = ?', code)!.id;

describe('Single-user mode — one Administrator, no sign-in', () => {
  it('serves every request as the Administrator without a session', async () => {
    const me = await admin.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ singleUser: true, merged: true, email: 'admin@equipcare.test', roleLabel: 'Administrator — all modules' });
    expect(me.body.roles).toHaveLength(1);
    // Every internal module's permissions at once…
    for (const p of ['pr.work', 'rfq.manage', 'cmp.manage', 'apr.decide', 'con.manage', 'po.followup', 'asn.receive', 'inv.review', 'adv.manage', 'sap.replay', 'sapsim.all', 'adm.users', 'adm.config', 'rpt.finance', 'audit.view_all']) {
      expect(me.body.perms, p).toContain(p);
    }
    // …but never the vendor portal's.
    expect(me.body.perms).not.toContain('po.vendor');
  });

  it('has exactly one account, and the sign-in endpoints are switched off', async () => {
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n).toBe(1);
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE vendor_id IS NOT NULL')!.n).toBe(0);
    const login = await t.anon().post('/api/auth/login', { email: 'admin@equipcare.test', password: 'whatever' });
    expect(login.status).toBe(409);
    expect(login.body.error.code).toBe('single_user_mode');
    expect((await admin.get('/api/auth/demo-users')).body).toEqual([]);
    expect((await admin.post('/api/auth/password', { current: 'a', next: 'b' })).status).toBe(409);
    const create = await admin.post('/api/admin/users', { name: 'Second Person', email: 'second@equipcare.test', roles: ['BUY'] });
    expect(create.status).toBe(409);
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n).toBe(1);
  });

  it('merged the demo history: ownership belongs to the Administrator and nothing points at a removed account', async () => {
    const id = t.db.get<{ id: number }>("SELECT id FROM users WHERE email = 'admin@equipcare.test'")!.id;
    const dangling = (sql: string) => t.db.get<{ n: number }>(sql, id)!.n;
    expect(dangling('SELECT COUNT(*) AS n FROM pr_lines WHERE buyer_id IS NOT NULL AND buyer_id != ?')).toBe(0);
    expect(dangling('SELECT COUNT(*) AS n FROM pr_lines WHERE requisitioner_id IS NOT NULL AND requisitioner_id != ?')).toBe(0);
    expect(dangling('SELECT COUNT(*) AS n FROM pos WHERE buyer_id IS NOT NULL AND buyer_id != ?')).toBe(0);
    expect(dangling('SELECT COUNT(*) AS n FROM buyer_matrix WHERE buyer_id != ?')).toBe(0);
    expect(dangling('SELECT COUNT(*) AS n FROM notifications WHERE user_id != ?')).toBe(0);
    // Segregation-of-duties history is kept as authored, so historic requests do not become "self-raised".
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM approvals WHERE requester_id != ?', id)!.n).toBeGreaterThan(0);
    // The audit trail still verifies and records the merge.
    expect((await admin.get('/api/audit/verify')).body).toMatchObject({ ok: true });
    expect(t.db.get('SELECT id FROM audit_events WHERE action = ?', 'system.single_user_merge')).toBeTruthy();
    // Running the merge again changes nothing.
    const again = (await import('../core/singleuser.ts')).mergeIntoAdmin();
    expect(again.merged).toBe(false);
  });

  it('the Administrator works the PR workbench, home and reports as every role at once', async () => {
    const lines = await admin.get('/api/pr/lines?view=mine');
    expect(lines.status).toBe(200);
    expect(lines.body.length).toBeGreaterThan(5);
    const mine = await admin.get('/api/pr/mine');
    expect(mine.status).toBe(200);
    expect(mine.body.length).toBeGreaterThan(0); // requisitioner view of the merged requisitioners
    const home = await admin.get('/api/home');
    expect(home.body.tiles.length).toBe(8);
    expect(home.body.tasks.length).toBeGreaterThan(0);
    const rep = await admin.get('/api/reports/catalogue');
    expect(rep.body.reports).toHaveLength(12);
    expect(rep.body.kpis).toBe(true);
    expect((await admin.get('/api/reports/kpis')).status).toBe(200);
    const counts = await admin.get('/api/nav-counts');
    expect(counts.body.approvals).toBeGreaterThan(0);
  });

  it('acts on a historic approval raised by someone else, across approver roles', async () => {
    const waiting = t.db.all<{ id: number }>("SELECT a.id FROM approvals a WHERE a.status = 'Pending' ORDER BY a.id");
    expect(waiting.length).toBeGreaterThan(0);
    const detail = await admin.get(`/api/approvals/${waiting[0].id}`);
    expect(detail.body.can_act).toBe(true);
    const ok = await admin.post(`/api/approvals/${waiting[0].id}/approve`, { comment: 'Approved as Administrator' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('segregation of duties still applies: the Administrator cannot approve a request it raised itself', async () => {
    const id = t.db.get<{ id: number }>("SELECT id FROM users WHERE email = 'admin@equipcare.test'")!.id;
    t.db.run("INSERT INTO approvals (req_no, type, category, object_type, object_id, title, requester_id, status, current_level, context_json, created_at) VALUES ('APR-TEST-SOD', 'exc.urgent', 'exception', 'pr_line', 1, 'Own request', ?, 'Pending', 1, '{}', datetime('now'))", id);
    const ap = t.db.get<{ id: number }>("SELECT id FROM approvals WHERE req_no = 'APR-TEST-SOD'")!.id;
    t.db.run("INSERT INTO approval_steps (approval_id, level, approver_role, status) VALUES (?, 1, 'APR', 'Pending')", ap);
    const r = await admin.post(`/api/approvals/${ap}/approve`, { comment: 'Trying to approve my own request' });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/segregation of duties/);
  });
});

describe('Single-user mode — vendor portal by acting as a vendor', () => {
  it('lists vendor companies and switches into the portal for one of them', async () => {
    const list = await admin.get('/api/auth/acting-vendors');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(10);
    const hydrotech = vendorId('100101');
    expect((await admin.post('/api/auth/switch-role', { role: 'VEN' })).status).toBe(400); // must choose a vendor
    expect((await admin.post('/api/auth/switch-role', { role: 'VEN', vendor_id: hydrotech })).status).toBe(200);
    const me = await admin.get('/api/auth/me');
    expect(me.body).toMatchObject({ role: 'VEN', merged: false });
    expect(me.body.vendor.sap_code).toBe('100101');
    expect(me.body.perms).toContain('po.vendor');
    expect(me.body.perms).not.toContain('pr.work');
  });

  it('keeps the workspace per browser: another browser stays in the administrator workspace and a stale tab can recover', async () => {
    // `admin` is now in a vendor's portal; a different browser (no cookie) must be unaffected.
    const other = t.anon();
    expect((await other.get('/api/pr/lines')).status).toBe(200);
    expect((await other.get('/api/auth/me')).body.role).toBe('ADM');
    // A tab of the vendor-view browser that still asks for an administrator screen gets a recoverable error, not a dead end.
    const stale = await admin.get('/api/pr/lines');
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('wrong_workspace');
    // And the other way round.
    const vendorCall = await other.get('/api/po/vendor/pos');
    expect(vendorCall.status).toBe(403);
    expect(vendorCall.body.error.code).toBe('wrong_workspace');
  });

  it('shows only that vendor\'s data, with isolation enforced and audited', async () => {
    const mine = await admin.get('/api/po/vendor/pos');
    expect(mine.status).toBe(200);
    expect(mine.body.length).toBeGreaterThan(0);
    const others = t.db.get<{ id: number }>("SELECT p.id FROM pos p JOIN vendors v ON v.id = p.vendor_id WHERE v.sap_code = '100102' LIMIT 1")!.id;
    const denied = await admin.get(`/api/po/vendor/pos/${others}`);
    expect(denied.status).toBe(404);
    expect(t.db.get('SELECT id FROM audit_events WHERE action = ?', 'security.cross_vendor_access_denied')).toBeTruthy();
    // Internal APIs are closed while acting as a vendor.
    expect((await admin.get('/api/pr/lines')).status).toBe(403);
    expect((await admin.get('/api/admin/users')).status).toBe(403);
  });

  it('keeps the vendor inbox separate from the internal inbox', async () => {
    const vendorInbox = await admin.get('/api/notifications');
    expect(vendorInbox.body.items.length).toBeGreaterThan(0);
    expect(vendorInbox.body.items.every((n: any) => n.vendor_id === vendorId('100101'))).toBe(true);
    await admin.post('/api/auth/switch-role', { role: 'ADM' });
    const internal = await admin.get('/api/notifications');
    expect(internal.body.items.length).toBeGreaterThan(0);
    expect(internal.body.items.every((n: any) => n.vendor_id == null)).toBe(true);
  });

  it('a vendor still being onboarded can only use onboarding, profile and help', async () => {
    const orion = t.db.get<{ id: number }>("SELECT id FROM vendors WHERE name LIKE 'Orion Seal%'")!.id;
    expect((await admin.post('/api/auth/switch-role', { role: 'VEN', vendor_id: orion })).status).toBe(200);
    const po = await admin.get('/api/po/vendor/pos');
    expect(po.status).toBe(403);
    expect(po.body.error.code).toBe('vendor_not_active');
    expect((await admin.get('/api/notifications')).status).toBe(200);
    await admin.post('/api/auth/switch-role', { role: 'ADM' });
    expect((await admin.get('/api/auth/me')).body.role).toBe('ADM');
    expect(t.db.get('SELECT id FROM audit_events WHERE action = ?', 'auth.exited_vendor_portal')).toBeTruthy();
  });
});

describe('Single-user mode — no sign-in means local access only', () => {
  const hit = (host: string, origin?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const u = new URL(t.base);
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/auth/me', method: 'GET', headers: { Host: host, ...(origin ? { Origin: origin } : {}) } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });

  it('refuses requests for any host name other than localhost', async () => {
    expect((await hit('localhost:4000')).status).toBe(200);
    expect((await hit('127.0.0.1:4000')).status).toBe(200);
    const evil = await hit('evil.example.com');
    expect(evil.status).toBe(403);
    expect(evil.body).toContain('bad_host');
  });

  it('refuses state-changing requests from another origin', async () => {
    const r = await fetch(`${t.base}/api/auth/switch-role`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' }, body: JSON.stringify({ role: 'ADM' }) });
    expect(r.status).toBe(403);
  });
});
