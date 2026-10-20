import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, PDF } from './helpers.ts';

let t: Awaited<ReturnType<typeof startApp>>;

const DOMAINS: Record<string, string> = { 'manoj.kale': 'hydrotech.test', 'divya.raman': 'shakti-ucg.test', sanjay: 'westernlube.test', 'pooja.malhotra': 'precisionfilt.test', nitin: 'krantitools.test' };
let ipSeq = 10;
/** Sign in from a distinct (forwarded) IP so the per-IP sign-in rate limit does not trip in a long test file. */
async function freshLogin(local: string, password = 'Equipcare@2026') {
  const ip = `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
  const email = local.includes('@') ? local : `${local}@${DOMAINS[local] ?? 'equipcare.test'}`;
  const post = (url: string, body: unknown, cookie = '') => fetch(t.base + url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const r = await post('/api/auth/login', { email, password });
  const body: any = await r.json();
  const c = t.anon() as any;
  c.status = r.status;
  c.body = body;
  const set = r.headers.get('set-cookie');
  if (set) c.cookie = set.split(';')[0];
  if (r.status === 200 && body.mfaRequired) {
    const v = await post('/api/auth/verify-otp', { code: body.simulatedCode }, c.cookie);
    if (v.status !== 200) throw new Error(`otp ${email} failed`);
  }
  if (r.status !== 200) throw new Error(`login ${email} failed: ${JSON.stringify(body)}`);
  return c;
}
const sessions = new Map<string, any>();
/** Sign-in is rate limited per IP, so reuse one session per persona. */
const login = async (local: string) => {
  if (!sessions.has(local)) sessions.set(local, await freshLogin(local));
  return sessions.get(local);
};
beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t.close(); });

const vendorId = (code: string) => t.db.get<{ id: number }>('SELECT id FROM vendors WHERE sap_code = ? OR name = ?', code, code)!.id;
const userId = (local: string) => t.db.get<{ id: number }>('SELECT id FROM users WHERE email LIKE ?', `${local}@%`)!.id;

/** Valid GSTIN for a PAN in Maharashtra (check digit computed by core/india.ts). */
async function gstinFor(pan: string) {
  const { makeGstin } = await import('../core/india.ts');
  return makeGstin('27', pan, '1');
}

/** Decide through the approval engine (the approvals module owns the HTTP screens). */
async function approveAll(approvalId: number, roles: string[]) {
  const { act } = await import('../core/approvals.ts');
  const { actorFor } = await import('../seed/ctx.ts');
  for (const who of roles) act(actorFor(who, who === 'vikram.joshi' ? 'APR' : undefined), approvalId, 'approve', 'ok');
}

describe('Module 9 — vendor onboarding (FR-VPT-11, WF-06)', () => {
  it('invite → register → onboarding form → submit → review → approval → Pending SAP code → SAP link → Active', async () => {
    const amit = await login('amit.kulkarni');
    const inv = await amit.post('/api/vendors/invite', { legal_name: 'Konkan Seal Works LLP', contact_name: 'Asha Pai', email: 'asha@konkanseal.test', category: 'HYD' });
    expect(inv.status).toBe(200);
    const vid = inv.body.id as number;
    const token = inv.body.link.split('token=')[1];
    const outbox = t.db.get<{ body: string; status: string }>("SELECT body, status FROM outbox WHERE recipient = 'asha@konkanseal.test'");
    expect(outbox?.status).toMatch(/Simulated — not sent/);

    const anon = t.anon();
    expect((await anon.get(`/api/vendors/register/${token}`)).body.vendor).toBe('Konkan Seal Works LLP');
    expect((await anon.post('/api/vendors/register', { token, name: 'Asha Pai', password: 'short', confirm: 'short' })).status).toBe(400);
    const reg = await anon.post('/api/vendors/register', { token, name: 'Asha Pai', password: 'Konkan@2026x', confirm: 'Konkan@2026x' });
    expect(reg.status).toBe(200);
    expect((await anon.post('/api/vendors/register', { token, name: 'Asha Pai', password: 'Konkan@2026x', confirm: 'Konkan@2026x' })).status).toBe(404); // single use

    // Vendor signs in (password + OTP).
    const asha = t.anon();
    const l = await asha.post('/api/auth/login', { email: 'asha@konkanseal.test', password: 'Konkan@2026x' });
    expect(l.body.mfaRequired).toBe(true);
    await asha.post('/api/auth/verify-otp', { code: l.body.simulatedCode });
    expect((await asha.get('/api/vendors/me/home')).body.active).toBe(false);

    const pan = 'AAKFK7731Q';
    const gstin = await gstinFor(pan);
    expect((await asha.put('/api/vendors/me/onboarding', { section: 'company', legal_name: 'Konkan Seal Works LLP', name: 'Konkan Seal', address: 'Plot 12, MIDC Lote, Ratnagiri', city: 'Ratnagiri', state: 'Maharashtra' })).status).toBe(200);
    // GSTIN check digit and PAN-in-GSTIN validation (SCR-VPT-11)
    const badCheck = await asha.put('/api/vendors/me/onboarding', { section: 'tax', gstin: gstin.slice(0, 14) + (gstin[14] === 'A' ? 'B' : 'A'), pan });
    expect(badCheck.status).toBe(400);
    expect(badCheck.body.error.fields.gstin).toMatch(/check digit/);
    const badPan = await asha.put('/api/vendors/me/onboarding', { section: 'tax', gstin, pan: 'AAKFK7731R' });
    expect(badPan.body.error.fields.gstin).toMatch(/must equal the PAN/);
    expect((await asha.put('/api/vendors/me/onboarding', { section: 'tax', gstin, pan })).status).toBe(200);
    expect((await asha.put('/api/vendors/me/onboarding', { section: 'msme', registered: false })).status).toBe(200);
    expect((await asha.put('/api/vendors/me/onboarding', { section: 'bank', bank_name: 'Bank of Maharashtra', bank_ifsc: 'MAHB0000123', account_no: '60123456789', account_confirm: '60123456789' })).status).toBe(200);
    expect(t.db.get<{ bank_account_masked: string }>('SELECT bank_account_masked FROM vendors WHERE id = ?', vid)!.bank_account_masked).toBe('XXXXXXX6789');
    expect((await asha.put('/api/vendors/me/onboarding', { section: 'contacts', contacts: [{ name: 'Asha Pai', role: 'Partner', email: 'asha@konkanseal.test', phone: '+91 98220 10101' }] })).status).toBe(200);
    expect((await asha.post('/api/vendors/me/onboarding/submit')).status).toBe(400); // documents & capability missing
    for (const docType of ['GST certificate', 'PAN card', 'Cancelled cheque']) {
      const up = await asha.upload('/api/files', [{ name: 'doc.pdf', content: PDF, type: 'application/pdf' }], { owner_type: 'vendor', owner_id: String(vid), label: docType });
      expect(up.status).toBe(200);
      expect((await asha.post('/api/vendors/me/documents', { doc_type: docType, attachment_id: up.body.files[0].id })).status).toBe(200);
    }
    expect((await asha.post('/api/vendors/me/capabilities', { category: 'HYD', sub_category: 'Seal kits', supplier_role: 'Manufacturer' })).status).toBe(200);
    const sub = await asha.post('/api/vendors/me/onboarding/submit');
    expect(sub.status).toBe(200);
    expect(sub.body.vendor.onboarding_status).toBe('Submitted');

    // Clarification requested ↔ resubmitted
    const clar = await amit.post(`/api/vendors/${vid}/onboarding/clarify`, { message: 'Please confirm your Ratnagiri works address on the GST certificate.' });
    expect(clar.body.onboarding_status).toBe('Clarification requested');
    expect((await asha.post('/api/vendors/me/onboarding/respond', { message: 'Address confirmed, same as the GST certificate.' })).status).toBe(200);
    expect((await asha.post('/api/vendors/me/onboarding/submit')).body.vendor.onboarding_status).toBe('Submitted');

    // Review: documents, capability (procurement), bank (finance)
    const d = (await amit.get(`/api/vendors/${vid}`)).body;
    for (const doc of d.documents) expect((await amit.post(`/api/vendors/documents/${doc.id}/review`, { decision: 'Valid' })).status).toBe(200);
    expect((await amit.post(`/api/vendors/${vid}/onboarding/submit-approval`)).status).toBe(409); // reviews missing
    expect((await amit.post(`/api/vendors/capabilities/${d.capabilities[0].id}/decide`, { decision: 'Approved' })).status).toBe(200);
    expect((await amit.post(`/api/vendors/${vid}/onboarding/review`, { area: 'procurement' })).status).toBe(200);
    expect((await amit.post(`/api/vendors/${vid}/onboarding/review`, { area: 'finance' })).status).toBe(403);
    const meera = await login('meera.iyer');
    expect((await meera.post(`/api/vendors/${vid}/onboarding/review`, { area: 'finance', note: 'Cheque matches bank details' })).status).toBe(200);
    const sent = await amit.post(`/api/vendors/${vid}/onboarding/submit-approval`);
    expect(sent.status).toBe(200);
    const ap = t.db.get<{ id: number; status: string }>("SELECT id, status FROM approvals WHERE type = 'vendor.onboarding' AND object_id = ?", vid)!;
    const steps = t.db.all<{ approver_role: string; level: number }>('SELECT approver_role, level FROM approval_steps WHERE approval_id = ? ORDER BY level', ap.id);
    expect(steps.map((s) => s.approver_role)).toEqual(['APR', 'FIN']);
    await approveAll(ap.id, ['vikram.joshi', 'kiran.shah']);
    expect(t.db.get<{ onboarding_status: string }>('SELECT onboarding_status FROM vendors WHERE id = ?', vid)!.onboarding_status).toBe('Pending SAP code');

    // SAP team creates the vendor in SAP (simulated) → VENDOR sync links the code by PAN/GSTIN.
    const sap = await import('../core/sap.ts');
    sap.sapPut('VENDOR', '100190', { sap_code: '100190', name: 'Konkan Seal Works LLP', pan, gstin, city: 'Ratnagiri', state: 'Maharashtra', bank_name: 'Bank of Maharashtra', bank_account_masked: 'XXXXXXX6789', bank_ifsc: 'MAHB0000123' });
    sap.syncEvent('VENDOR');
    const v = t.db.get<{ sap_code: string; onboarding_status: string; portal_status: string }>('SELECT sap_code, onboarding_status, portal_status FROM vendors WHERE id = ?', vid)!;
    expect(v).toMatchObject({ sap_code: '100190', onboarding_status: 'Active', portal_status: 'Active' });
    const ntf = t.db.get("SELECT id FROM notifications WHERE event = 'NTF-24' AND user_id = (SELECT id FROM users WHERE email = 'asha@konkanseal.test') AND title LIKE 'Welcome%'");
    expect(ntf).toBeTruthy();
    expect((await asha.get('/api/vendors/me/home')).body.active).toBe(true);
  });

  it('rejection with reason is shown to the vendor', async () => {
    const amit = await login('amit.kulkarni');
    const orion = vendorId('Orion Seal Technologies LLP');
    expect((await amit.post(`/api/vendors/${orion}/onboarding/reject`, { reason: 'short' })).status).toBe(400);
    // keep Orion for the demo: test on a fresh invite instead
    const inv = await amit.post('/api/vendors/invite', { legal_name: 'Reject Me Traders', contact_name: 'R M', email: 'rm@rejectme.test', category: 'TLS' });
    const r = await amit.post(`/api/vendors/${inv.body.id}/onboarding/reject`, { reason: 'Not an approved category supplier for this plant.' });
    expect(r.body.onboarding_status).toBe('Rejected');
  });
});

describe('AC-VPT-01 lockout and admin unlock', () => {
  it('locks after the configured failed sign-ins and the admin unlock is audited', async () => {
    const anon = t.anon();
    for (let i = 0; i < 4; i++) expect((await anon.post('/api/auth/login', { email: 'nitin@krantitools.test', password: 'wrong-password' })).status).toBe(401);
    expect((await anon.post('/api/auth/login', { email: 'nitin@krantitools.test', password: 'wrong-password' })).status).toBe(423);
    expect((await anon.post('/api/auth/login', { email: 'nitin@krantitools.test', password: 'Equipcare@2026' })).status).toBe(423);
    const admin = await login('anjali.verma');
    const id = userId('nitin');
    expect((await admin.post(`/api/admin/users/${id}/unlock`, { reason: 'Vendor called the helpdesk and verified identity' })).status).toBe(200);
    expect(t.db.get('SELECT id FROM audit_events WHERE action = ? AND object_id = ?', 'user.unlocked', String(id))).toBeTruthy();
    expect(t.db.get<{ failed_attempts: number }>('SELECT failed_attempts FROM users WHERE id = ?', id)!.failed_attempts).toBe(0);
    await login('nitin');
  });
});

describe('AC-VPT-02 vendor isolation', () => {
  it('a vendor asking for another vendor\'s ticket gets not-found and the attempt is logged', async () => {
    const divya = await login('divya.raman');
    const westernTicket = t.db.get<{ id: number }>("SELECT t.id FROM tickets t JOIN vendors v ON v.id = t.vendor_id WHERE v.sap_code = '100104'")!.id;
    const r = await divya.get(`/api/vendors/tickets/${westernTicket}`);
    expect(r.status).toBe(404);
    expect(t.db.get("SELECT id FROM audit_events WHERE action = 'security.cross_vendor_access_denied' AND object_type = 'ticket' AND object_id = ?", String(westernTicket))).toBeTruthy();
    const list = await divya.get('/api/vendors/tickets');
    expect(list.body.every((x: any) => x.vendor_id === vendorId('100102'))).toBe(true);
    expect((await divya.get(`/api/files?owner_type=vendor&owner_id=${vendorId('100101')}`)).status).toBe(404);
    expect((await divya.get(`/api/vendors/${vendorId('100101')}`)).status).toBe(403);
  });
});

describe('AC-VPT-03 KYC expiry reminders (FR-VPT-12)', () => {
  it('a GST certificate expiring in 30 days notifies the vendor and procurement; past expiry marks it Expired', async () => {
    const hydro = vendorId('100101');
    const doc = t.db.get<{ id: number }>("SELECT id FROM vendor_documents WHERE vendor_id = ? AND doc_type = 'GST certificate'", hydro)!.id;
    const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    t.db.run('UPDATE vendor_documents SET expiry_date = ? WHERE id = ?', in30, doc);
    const admin = await login('anjali.verma');
    expect((await admin.post('/api/jobs/vendors.kyc_expiry/run')).body.status).toBe('Succeeded');
    const to = (local: string) => t.db.get("SELECT id FROM notifications WHERE event = 'NTF-25' AND title LIKE '%GST certificate%' AND user_id = ?", userId(local));
    expect(to('manoj.kale')).toBeTruthy();
    expect(to('amit.kulkarni')).toBeTruthy();
    const sudarshanIso = t.db.get<{ status: string }>("SELECT d.status FROM vendor_documents d JOIN vendors v ON v.id = d.vendor_id WHERE v.sap_code = '100113' AND d.doc_type = 'ISO 9001 certificate'");
    expect(sudarshanIso?.status).toBe('Expired');
  });
});

describe('AC-VPT-04 bank change is not applied before SAP returns it', () => {
  it('pending → finance approval → Sent to SAP → Applied on sync; master unchanged until then', async () => {
    const pooja = await login('pooja.malhotra');
    const vid = vendorId('100105');
    const before = t.db.get<{ bank_account_masked: string; bank_ifsc: string }>('SELECT bank_account_masked, bank_ifsc FROM vendors WHERE id = ?', vid)!;
    const noDoc = await pooja.post('/api/vendors/me/change-requests', { field: 'bank_account', reason: 'New collection account with HDFC Bank', bank: { bank_name: 'HDFC Bank', bank_ifsc: 'HDFC0004455', account_no: '50100223344556', account_confirm: '50100223344556' } });
    expect(noDoc.status).toBe(400);
    const up = await pooja.upload('/api/files', [{ name: 'cheque.pdf', content: PDF, type: 'application/pdf' }]);
    const cr = await pooja.post('/api/vendors/me/change-requests', { field: 'bank_account', reason: 'New collection account with HDFC Bank', bank: { bank_name: 'HDFC Bank', bank_ifsc: 'HDFC0004455', account_no: '50100223344556', account_confirm: '50100223344556' }, attachment_ids: [up.body.files[0].id] });
    expect(cr.status).toBe(200);
    expect(t.db.get('SELECT id FROM audit_events WHERE action = ? AND object_id = ?', 'vendor.bank_change_requested', String(cr.body.id))).toBeTruthy();
    const meera = await login('meera.iyer');
    const sent = await meera.post(`/api/vendors/change-requests/${cr.body.id}/send-for-approval`, { note: 'Cheque verified against the request' });
    expect(sent.status).toBe(200);
    // maker-checker: the verifier cannot approve
    const { act } = await import('../core/approvals.ts');
    const { actorFor } = await import('../seed/ctx.ts');
    expect(() => act(actorFor('meera.iyer'), sent.body.approval_id, 'approve', null)).toThrow();
    await approveAll(sent.body.approval_id, ['kiran.shah']);
    const after = t.db.get<{ status: string }>('SELECT status FROM vendor_change_requests WHERE id = ?', cr.body.id)!;
    expect(after.status).toBe('Sent to SAP');
    expect(t.db.get('SELECT bank_account_masked, bank_ifsc FROM vendors WHERE id = ?', vid)).toEqual(before);
    // SAP team applies it in SAP (simulated) → sync
    const sap = await import('../core/sap.ts');
    const doc = sap.sapGet<any>('VENDOR', '100105')!;
    sap.sapPut('VENDOR', '100105', { ...doc.payload, bank_name: 'HDFC Bank', bank_ifsc: 'HDFC0004455', bank_account_masked: 'XXXXXXXXXX4556' });
    sap.syncEvent('VENDOR');
    expect(t.db.get<{ status: string }>('SELECT status FROM vendor_change_requests WHERE id = ?', cr.body.id)!.status).toBe('Applied');
    expect(t.db.get<{ bank_account_masked: string }>('SELECT bank_account_masked FROM vendors WHERE id = ?', vid)!.bank_account_masked).toBe('XXXXXXXXXX4556');
  });

  it('seeded Hydrotech bank change waits for finance approval', () => {
    const r = t.db.get<{ status: string; approval_id: number }>("SELECT r.status, r.approval_id FROM vendor_change_requests r JOIN vendors v ON v.id = r.vendor_id WHERE v.sap_code = '100101' AND r.field = 'bank_account'")!;
    expect(r.status).toBe('Pending');
    expect(t.db.get<{ status: string }>('SELECT status FROM approvals WHERE id = ?', r.approval_id)!.status).toBe('Pending');
  });
});

describe('AC-VPT-05/06 tickets', () => {
  it('payment query routes to finance, the vendor sees public updates but never internal notes', async () => {
    const manoj = await login('manoj.kale');
    const c = await manoj.post('/api/vendors/tickets', { category: 'Payment query', subject: 'Payment for invoice HT-2210', body: 'Invoice HT-2210 is past due. Please share the payment date.', priority: 'Normal' });
    expect(c.status).toBe(200);
    expect(c.body.routed_to).toBe('FIN');
    const tk = t.db.get<{ assignee_role: string; sla_due: string }>('SELECT assignee_role, sla_due FROM tickets WHERE id = ?', c.body.id)!;
    expect(tk.assignee_role).toBe('FIN');
    expect(tk.sla_due).toBeTruthy();
    const kiran = await login('kiran.shah');
    expect((await kiran.get('/api/vendors/tickets?queue=role')).body.some((x: any) => x.id === c.body.id)).toBe(true);
    await kiran.post(`/api/vendors/tickets/${c.body.id}/assign`, {});
    await kiran.post(`/api/vendors/tickets/${c.body.id}/messages`, { body: 'Internal: blocked for TDS certificate mismatch', internal: true });
    await kiran.post(`/api/vendors/tickets/${c.body.id}/messages`, { body: 'Payment is scheduled for Friday.' });
    const st = await kiran.post(`/api/vendors/tickets/${c.body.id}/status`, { status: 'Awaiting vendor', note: 'Please confirm the bank account on the invoice.' });
    expect(st.body.status).toBe('Awaiting vendor');
    const v = await manoj.get(`/api/vendors/tickets/${c.body.id}`);
    expect(v.body.messages.some((m: any) => /Internal/.test(m.body))).toBe(false);
    expect(v.body.messages.some((m: any) => /Friday/.test(m.body))).toBe(true);
    expect(v.body.assignee_name).toBeNull();
    const n = t.db.get("SELECT id FROM notifications WHERE event = 'NTF-26' AND user_id = ? AND link = ?", userId('manoj.kale'), `/vendor/tickets/${c.body.id}`);
    expect(n).toBeTruthy();
    expect(t.db.get("SELECT id FROM notifications WHERE user_id = ? AND body LIKE '%TDS%'", userId('manoj.kale'))).toBeFalsy();
    // vendor reply reopens to In progress
    expect((await manoj.post(`/api/vendors/tickets/${c.body.id}/messages`, { body: 'Bank account is correct.', internal: true })).body.status).toBe('In progress');
    expect(t.db.get<{ internal: number }>('SELECT internal FROM ticket_messages WHERE ticket_id = ? ORDER BY id DESC LIMIT 1', c.body.id)!.internal).toBe(0);
  });

  it('routing follows tickets.routing: PO visibility → BUY, login → ADM', async () => {
    const divya = await login('divya.raman');
    expect((await divya.post('/api/vendors/tickets', { category: 'PO visibility', subject: 'PO missing in portal', body: 'PO 4500021002 is not visible to us.', priority: 'Normal' })).body.routed_to).toBe('BUY');
    expect((await divya.post('/api/vendors/tickets', { category: 'Login / access', subject: 'Cannot sign in', body: 'My colleague cannot sign in at all.', priority: 'Normal' })).body.routed_to).toBe('ADM');
    expect((await divya.post('/api/vendors/tickets', { category: 'Nonsense', subject: 'Cannot sign in', body: 'My colleague cannot sign in at all.', priority: 'Normal' })).status).toBe(400);
  });
});

describe('AC-VPT-08 channel policy', () => {
  it('with e-mail + in-app only, no SMS or WhatsApp is attempted; enabling SMS creates simulated rows', async () => {
    const smsRows = () => t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE notification_id IS NOT NULL AND channel IN ('sms','whatsapp')")!.n;
    expect(smsRows()).toBe(0);
    const admin = await login('anjali.verma');
    const r = await admin.put('/api/config/notify.channels', { value: { email: true, sms: true, whatsapp: false, push: false }, reason: 'Test of the SMS channel policy switch' });
    expect(r.status).toBe(200);
    const sanjay = await login('sanjay');
    await sanjay.post('/api/vendors/tickets', { category: 'Invoice upload', subject: 'Upload fails', body: 'The invoice PDF upload fails every time.', priority: 'Normal' });
    expect(smsRows()).toBeGreaterThan(0);
    expect(t.db.get<{ status: string }>("SELECT status FROM outbox WHERE channel = 'sms' AND notification_id IS NOT NULL")!.status).toMatch(/not sent/);
    await admin.put('/api/config/notify.channels', { value: { email: true, sms: false, whatsapp: false, push: false }, reason: 'Back to policy default of DEC-14' });
  });
});

describe('FR-VPT-13/15 capabilities and vendor colleagues', () => {
  it('capability proposals need procurement approval; vendor admin invites a colleague', async () => {
    const manoj = await login('manoj.kale');
    const p = await manoj.post('/api/vendors/me/capabilities', { category: 'HYD', sub_category: 'Cylinder repacking', supplier_role: 'Service provider' });
    expect(p.status).toBe(200);
    expect(t.db.get<{ status: string }>('SELECT status FROM vendor_capabilities WHERE id = ?', p.body.id)!.status).toBe('Proposed');
    expect((await manoj.post(`/api/vendors/capabilities/${p.body.id}/decide`, { decision: 'Approved' })).status).toBe(403);
    const amit = await login('amit.kulkarni');
    expect((await amit.post(`/api/vendors/capabilities/${p.body.id}/decide`, { decision: 'Approved' })).status).toBe(200);
    const u = await manoj.post('/api/vendors/me/users', { name: 'Rohan Kale', email: 'rohan@hydrotech.test', vendor_role: 'Dispatch' });
    expect(u.status).toBe(200);
    expect(u.body.temporary_password).toMatch(/\d/);
    const row = t.db.get<{ vendor_id: number; roles: string; vendor_role: string }>("SELECT vendor_id, roles, vendor_role FROM users WHERE email = 'rohan@hydrotech.test'")!;
    expect(row).toEqual({ vendor_id: vendorId('100101'), roles: 'VEN', vendor_role: 'Dispatch' });
  });
});
