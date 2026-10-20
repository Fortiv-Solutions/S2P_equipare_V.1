import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ModuleDef } from '../types.ts';
import { all, get, run, update } from '../../core/db.ts';
import { h, parse, idParam, reasonSchema, HttpError, forbidden, notFound, conflict, sendCsv } from '../../core/http.ts';
import { requirePerm, actorOf, revokeUserSessions } from '../../core/auth.ts';
import { audit } from '../../core/audit.ts';
import { onDecision } from '../../core/approvals.ts';
import { onSynced } from '../../core/sap.ts';
import { registerObjectAccess } from '../../core/files.ts';
import { registerJob } from '../../core/scheduler.ts';
import { registerConfig, cfg } from '../../core/config.ts';
import { SINGLE_USER } from '../../core/mode.ts';
import { createUser } from '../admin/service.ts';
import { U, V, D, DAY, actorFor } from '../../seed/ctx.ts';
import { DEMO_EXTRA } from '../../core/mode.ts';
import { seedExtra } from './seed_extra.ts';
import * as S from './service.ts';

const router = Router();

const passwordSchema = z.string().min(10, 'Use at least 10 characters').regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number');
const noteSchema = z.string().trim().max(500).nullish();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date (YYYY-MM-DD)');

/** Small per-IP limit for the public registration endpoints. */
const hits = new Map<string, number[]>();
function limit(req: Request, _res: Response, next: NextFunction) {
  const key = `${req.path}:${req.ip}`;
  const t = Date.now();
  const list = (hits.get(key) ?? []).filter((x) => t - x < 60000);
  list.push(t);
  hits.set(key, list);
  if (list.length > 30) return next(new HttpError(429, 'rate_limited', 'Too many attempts. Wait a minute and try again.'));
  next();
}

// ------------------------------------------------------------------ public: invitation acceptance
router.get('/register/:token', limit, h((req) => S.inviteInfo(String(req.params.token))));
router.post('/register', limit, h((req) => {
  // Single-user mode stores no vendor password: the invitation only records who accepted it.
  const b = parse(z.object({ token: z.string().min(10, 'The link is incomplete'), name: z.string().trim().min(2, 'Enter your full name').max(120), password: SINGLE_USER ? z.string().optional().default('') : passwordSchema, confirm: z.string().optional().default(''), phone: z.string().trim().max(30).nullish() }), req.body);
  if (!SINGLE_USER && b.password !== b.confirm) throw new HttpError(400, 'validation_failed', 'The two passwords do not match.', { confirm: 'Passwords do not match' });
  return S.acceptInvite(b, req.ip);
}));

// ------------------------------------------------------------------ vendor self-service (portal)
router.get('/me', requirePerm('vendor.self'), h((req) => S.myProfile(actorOf(req))));
router.get('/me/home', requirePerm('vendor.self'), h((req) => S.vendorHome(actorOf(req))));
router.get('/me/onboarding', requirePerm('vendor.self'), h((req) => S.myOnboarding(actorOf(req))));
const contactSchema = z.object({ name: z.string().trim().min(2, 'Enter the contact name'), role: z.string().trim().min(2, 'Enter the role, e.g. Sales'), email: z.string().trim().email('Enter a valid e-mail'), phone: z.string().trim().regex(/^[+\d][\d\s-]{7,18}$/, 'Enter a phone number, e.g. +91 98220 41100') });
const sectionSchema = z.discriminatedUnion('section', [
  z.object({ section: z.literal('company'), legal_name: z.string().trim().min(3, 'Enter the legal name as on the GST certificate'), name: z.string().trim().max(120), address: z.string().trim().min(8, 'Enter the full registered address'), city: z.string().trim().min(2, 'Enter the city'), state: z.string().min(2, 'Choose a state') }),
  z.object({ section: z.literal('tax'), gstin: z.string().trim().min(1, 'Enter the GSTIN'), pan: z.string().trim().min(1, 'Enter the PAN') }),
  z.object({ section: z.literal('msme'), registered: z.boolean(), msme_no: z.string().nullish(), msme_category: z.string().nullish() }),
  z.object({ section: z.literal('bank'), bank_name: z.string().trim(), bank_ifsc: z.string().trim(), account_no: z.string(), account_confirm: z.string() }),
  z.object({ section: z.literal('contacts'), contacts: z.array(contactSchema).min(1, 'Add at least one contact').max(8) }),
]);
router.put('/me/onboarding', requirePerm('vendor.self'), h((req) => S.saveOnboarding(actorOf(req), parse(sectionSchema, req.body))));
router.post('/me/onboarding/submit', requirePerm('vendor.self'), h((req) => S.submitOnboarding(actorOf(req))));
router.post('/me/onboarding/respond', requirePerm('vendor.self'), h((req) => S.respondClarification(actorOf(req), parse(z.object({ message: z.string().trim().min(5, 'Write your answer').max(2000) }), req.body).message)));
router.post('/me/documents', requirePerm('vendor.self'), h((req) => S.addDocument(actorOf(req), parse(z.object({
  doc_type: z.string().min(1, 'Choose the document type'), doc_no: z.string().max(60).nullish(), issued_on: dateSchema.nullish().or(z.literal('')), expiry_date: dateSchema.nullish().or(z.literal('')),
  attachment_id: z.number({ error: 'Upload the file first' }).int().positive(),
}), req.body))));
router.post('/me/capabilities', requirePerm('vendor.self'), h((req) => S.addCapability(actorOf(req), parse(z.object({
  category: z.string().min(1, 'Choose a category'), sub_category: z.string().trim().max(80).nullish(), supplier_role: z.string().nullish(), brand: z.string().trim().max(80).nullish(), region: z.string().trim().max(60).nullish(),
}), req.body))));
router.delete('/me/capabilities/:id', requirePerm('vendor.self'), h((req) => S.removeCapability(actorOf(req), idParam(req))));
router.post('/me/change-requests', requirePerm('vendor.self'), h((req) => S.requestChange(actorOf(req), parse(z.object({
  field: z.string().min(1, 'Choose what to change'), new_value: z.string().max(300).nullish(), reason: reasonSchema,
  bank: z.object({ bank_name: z.string(), bank_ifsc: z.string(), account_no: z.string(), account_confirm: z.string() }).nullish(),
  attachment_ids: z.array(z.number().int().positive()).max(5).optional(),
}), req.body))));
router.post('/me/change-requests/:id/withdraw', requirePerm('vendor.self'), h((req) => S.withdrawChange(actorOf(req), idParam(req))));

/** FR-VPT-15: the vendor administrator manages colleagues with vendor roles. */
function vendorAdmin(req: Request) {
  const a = actorOf(req);
  const vid = S.myVendorId(a);
  const me = get<{ vendor_role: string | null }>('SELECT vendor_role FROM users WHERE id = ?', a.id);
  if (me?.vendor_role !== 'Vendor administrator') throw forbidden('Only your company\'s vendor administrator can manage portal users.');
  return { a, vid };
}
function colleague(vid: number, a: ReturnType<typeof actorOf>, id: number) {
  const u = get<{ id: number; vendor_id: number | null; active: number; email: string; name: string }>('SELECT id, vendor_id, active, email, name FROM users WHERE id = ?', id);
  if (!u || u.vendor_id !== vid) {
    audit(a, { action: 'security.cross_vendor_access_denied', objectType: 'user', objectId: id, after: { actor_vendor: vid } });
    throw notFound('User');
  }
  if (u.id === a.id) throw conflict('You cannot change your own account here.');
  return u;
}
router.get('/me/users', requirePerm('vendor.users'), h((req) => {
  const { vid } = vendorAdmin(req);
  return all('SELECT id, name, email, phone, vendor_role, active, locked, last_login, created_at FROM users WHERE vendor_id = ? ORDER BY active DESC, name', vid);
}));
router.post('/me/users', requirePerm('vendor.users'), h((req) => {
  const { a, vid } = vendorAdmin(req);
  const b = parse(z.object({ name: z.string().trim().min(2, 'Enter the full name'), email: z.string().trim().email('Enter a valid e-mail'), phone: z.string().trim().max(30).nullish(), vendor_role: z.string().min(1, 'Choose a role') }), req.body);
  return createUser(a, { ...b, vendor_id: vid, title: b.vendor_role }, { vendorSelf: true });
}));
router.post('/me/users/:id/deactivate', requirePerm('vendor.users'), h((req) => {
  const { a, vid } = vendorAdmin(req);
  const u = colleague(vid, a, idParam(req));
  const { reason } = parse(z.object({ reason: reasonSchema }), req.body);
  if (!u.active) throw conflict('The user is already deactivated.');
  update('users', u.id, { active: 0 });
  revokeUserSessions(u.id);
  audit(a, { action: 'user.deactivated', objectType: 'user', objectId: u.id, objectRef: u.email, before: { active: 1 }, after: { active: 0, sessions_revoked: true }, reason });
  return { ok: true };
}));
router.post('/me/users/:id/reactivate', requirePerm('vendor.users'), h((req) => {
  const { a, vid } = vendorAdmin(req);
  const u = colleague(vid, a, idParam(req));
  if (u.active) throw conflict('The user is already active.');
  update('users', u.id, { active: 1, failed_attempts: 0 });
  audit(a, { action: 'user.reactivated', objectType: 'user', objectId: u.id, objectRef: u.email, before: { active: 0 }, after: { active: 1 } });
  return { ok: true };
}));

// ------------------------------------------------------------------ tickets (FR-VPT-09)
router.get('/tickets/meta', requirePerm('tkt.raise', 'tkt.handle'), h(() => ({
  categories: Object.keys(cfg<Record<string, string>>('tickets.routing')), routing: cfg('tickets.routing'), sla_hours: cfg('tickets.sla_hours'),
  teams: [{ code: 'BUY', label: 'Procurement' }, { code: 'APR', label: 'Procurement management' }, { code: 'FIN', label: 'Finance / accounts' }, { code: 'STO', label: 'Stores' }, { code: 'SAP', label: 'SAP / IT' }, { code: 'ADM', label: 'Portal administration' }],
})));
router.get('/tickets', requirePerm('tkt.raise', 'tkt.handle'), h((req) => S.listTickets(actorOf(req), req.query as Record<string, string>)));
router.post('/tickets', requirePerm('tkt.raise'), h((req) => S.createTicket(actorOf(req), parse(z.object({
  category: z.string().min(1, 'Choose a category'), subject: z.string().trim().min(5, 'Write a short subject (at least 5 characters)').max(140),
  body: z.string().trim().min(10, 'Describe the problem (at least 10 characters)').max(4000), priority: z.string().default('Normal'),
  object_ref: z.string().trim().max(60).nullish(), attachment_ids: z.array(z.number().int().positive()).max(5).optional(),
}), req.body))));
router.get('/tickets/:id', requirePerm('tkt.raise', 'tkt.handle'), h((req) => S.ticketDetail(actorOf(req), idParam(req))));
router.post('/tickets/:id/messages', requirePerm('tkt.raise', 'tkt.handle'), h((req) => {
  const b = parse(z.object({ body: z.string().trim().min(3, 'Write a message').max(4000), internal: z.boolean().optional() }), req.body);
  return S.replyTicket(actorOf(req), idParam(req), b.body, !!b.internal);
}));
router.post('/tickets/:id/status', requirePerm('tkt.raise', 'tkt.handle'), h((req) => {
  const b = parse(z.object({ status: z.string(), note: noteSchema }), req.body);
  return S.setTicketStatus(actorOf(req), idParam(req), b.status, b.note ?? null);
}));
router.post('/tickets/:id/assign', requirePerm('tkt.handle'), h((req) => S.assignTicket(actorOf(req), idParam(req), parse(z.object({ user_id: z.number().int().positive().nullish() }), req.body).user_id ?? null)));
router.post('/tickets/:id/route', requirePerm('tkt.handle'), h((req) => {
  const b = parse(z.object({ role: z.string(), reason: reasonSchema }), req.body);
  return S.rerouteTicket(actorOf(req), idParam(req), b.role, b.reason);
}));

// ------------------------------------------------------------------ internal vendor management
router.get('/', requirePerm('vendor.view'), h((req, res) => {
  const rows = S.listVendors();
  if (req.query.format === 'csv') {
    return sendCsv(res, 'vendors.csv', rows as unknown as Record<string, unknown>[], [
      { key: 'sap_code', label: 'SAP code' }, { key: 'name', label: 'Vendor' }, { key: 'city', label: 'City' }, { key: 'state', label: 'State' },
      { key: 'categories', label: 'Categories' }, { key: 'portal_status', label: 'Portal' }, { key: 'onboarding_status', label: 'Onboarding' },
      { key: 'kyc_state', label: 'KYC' }, { key: 'performance_score', label: 'Score' }, { key: 'sap_blocked', label: 'Blocked in SAP' },
    ]);
  }
  return rows;
}));
router.get('/meta', requirePerm('vendor.view'), h(() => ({ categories: all('SELECT code, name FROM spend_categories ORDER BY name'), invite_valid_days: cfg('vendor.invite_valid_days'), kyc_lead_days: cfg('kyc.expiry_lead_days') })));
router.get('/change-requests', requirePerm('vendor.view'), h((req) => S.listChangeRequests({ status: (req.query.status as string) || 'open' })));
router.get('/capabilities', requirePerm('vendor.view'), h((req) => S.listCapabilities({ status: (req.query.status as string) || 'Proposed' })));
router.get('/documents/expiring', requirePerm('vendor.view'), h(() => S.expiringDocuments()));
router.post('/invite', requirePerm('vendor.onboard'), h((req) => S.inviteVendor(actorOf(req), parse(z.object({
  legal_name: z.string().trim().min(3, 'Enter the vendor\'s legal name'), contact_name: z.string().trim().min(2, 'Enter the contact person'),
  email: z.string().trim().email('Enter a valid e-mail address'), phone: z.string().trim().max(30).nullish(), category: z.string().min(1, 'Choose a spend category'),
}), req.body))));
router.post('/documents/:id/review', requirePerm('vendor.review_kyc', 'vendor.onboard', 'vendor.review_bank'), h((req) => {
  const b = parse(z.object({ decision: z.enum(['Valid', 'Rejected']), note: noteSchema }), req.body);
  return S.reviewDocument(actorOf(req), idParam(req), b.decision, b.note ?? null);
}));
router.post('/capabilities/:id/decide', requirePerm('vendor.onboard'), h((req) => {
  const b = parse(z.object({ decision: z.enum(['Approved', 'Rejected']), note: noteSchema, buyer_owner_id: z.number().int().positive().nullish() }), req.body);
  return S.decideCapability(actorOf(req), idParam(req), b.decision, b.note ?? null, b.buyer_owner_id ?? null);
}));
router.post('/change-requests/:id/decide', requirePerm('vendor.onboard', 'vendor.review_kyc'), h((req) => {
  const b = parse(z.object({ decision: z.enum(['Approved', 'Rejected']), note: noteSchema }), req.body);
  return S.decideChange(actorOf(req), idParam(req), b.decision, b.note ?? null);
}));
router.post('/change-requests/:id/send-for-approval', requirePerm('vendor.review_bank'), h((req) => S.sendBankChangeForApproval(actorOf(req), idParam(req), parse(z.object({ note: reasonSchema }), req.body).note)));
router.get('/:id', requirePerm('vendor.view'), h((req) => S.vendorDetail(actorOf(req), idParam(req))));
router.post('/:id/invite/resend', requirePerm('vendor.onboard'), h((req) => S.resendInvite(actorOf(req), idParam(req))));
router.post('/:id/onboarding/start-review', requirePerm('vendor.onboard', 'vendor.review_kyc', 'vendor.review_bank'), h((req) => S.startReview(actorOf(req), idParam(req))));
router.post('/:id/onboarding/review', requirePerm('vendor.onboard', 'vendor.review_bank'), h((req) => {
  const b = parse(z.object({ area: z.enum(['procurement', 'finance']), note: noteSchema }), req.body);
  return S.completeReview(actorOf(req), idParam(req), b.area, b.note ?? null);
}));
router.post('/:id/onboarding/clarify', requirePerm('vendor.onboard', 'vendor.review_kyc', 'vendor.review_bank'), h((req) => S.requestClarification(actorOf(req), idParam(req), parse(z.object({ message: z.string().trim().min(10, 'Say what the vendor must clarify (at least 10 characters)').max(2000) }), req.body).message)));
router.post('/:id/onboarding/submit-approval', requirePerm('vendor.onboard'), h((req) => S.submitForApproval(actorOf(req), idParam(req))));
router.post('/:id/onboarding/reject', requirePerm('vendor.onboard'), h((req) => S.rejectOnboarding(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));

// ------------------------------------------------------------------ init & seed
function init() {
  for (const [t, c, type] of [
    ['vendors', 'onboarding_json', 'TEXT'], ['vendor_change_requests', 'details_json', 'TEXT'], ['vendor_change_requests', 'approval_id', 'INTEGER'],
    ['vendor_change_requests', 'sent_to_sap_at', 'TEXT'], ['vendor_change_requests', 'applied_at', 'TEXT'],
  ] as const) {
    const cols = all<{ name: string }>(`PRAGMA table_info(${t})`).map((x) => x.name);
    if (!cols.includes(c)) run(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`);
  }
  registerConfig(
    { key: 'vendor.invite_valid_days', label: 'Vendor invitation validity (days)', group: 'Vendors', description: 'A registration link expires after this many days; the buyer can send a new one.', value: 14, decision: 'DEC-08' },
    { key: 'vendor.mandatory_documents', label: 'Mandatory KYC documents', group: 'Vendors', description: 'Documents every vendor must hold (the MSME certificate is added when the vendor declares MSME). Expired mandatory documents stop new RFQ suggestions (FR-VPT-12).', value: ['GST certificate', 'PAN card', 'Cancelled cheque'], decision: 'DEC-08' },
    { key: 'vendor.document_types', label: 'Vendor document types', group: 'Vendors', description: 'Document types a vendor can upload in onboarding and profile.', value: ['GST certificate', 'PAN card', 'Cancelled cheque', 'MSME / Udyam certificate', 'ISO 9001 certificate', 'Certificate of incorporation', 'Authorised dealer / OEM letter', 'Other'] },
    { key: 'vendor.roles', label: 'Vendor portal roles', group: 'Vendors', description: 'Roles a vendor administrator can give colleagues (FR-VPT-15). Role-specific screen limits are pending the question in PRD 7.9.', value: ['Vendor administrator', 'Sales', 'Dispatch', 'Accounts'], decision: 'Q FR-VPT-15' },
    { key: 'tickets.sla_hours', label: 'Vendor ticket SLA (hours)', group: 'Vendors', description: 'Response target per ticket priority; tickets past it show as SLA breached.', value: { Normal: 48, High: 24, Urgent: 8 }, decision: 'DEC-15' },
  );
  registerObjectAccess('vendor', (a, id) => (a.role === 'VEN' ? a.vendorId === id : a.perms.has('vendor.view')));
  registerObjectAccess('vendor_change', (a, id) => {
    const cr = get<{ vendor_id: number }>('SELECT vendor_id FROM vendor_change_requests WHERE id = ?', id);
    if (!cr) return false;
    return a.role === 'VEN' ? a.vendorId === cr.vendor_id : a.perms.has('vendor.view');
  });
  registerObjectAccess('ticket', (a, id) => {
    const t = get<{ vendor_id: number | null }>('SELECT vendor_id FROM tickets WHERE id = ?', id);
    if (!t) return false;
    return a.role === 'VEN' ? a.vendorId === t.vendor_id : a.perms.has('tkt.handle');
  });
  onDecision('vendor.onboarding', S.onOnboardingDecision);
  onDecision('vendor.bank_change', S.onBankChangeDecision);
  onSynced('VENDOR', S.onVendorSynced);
  registerJob({ name: 'vendors.kyc_expiry', label: 'KYC document expiry reminders and expiry (NTF-25)', everyMinutes: 1440, run: S.kycExpiryJob });
}

function seed() {
  const amit = actorFor('amit.kulkarni');
  // 1. Invitation for a new vendor (WF-06) — valid token, link visible on the vendor record.
  S.inviteVendor(amit, { legal_name: 'Pune Precision Hydraulics LLP', contact_name: 'Kunal Mehta', email: 'kunal.mehta@puneprecision.test', phone: '+91 98230 77215', category: 'HYD' });

  // 2. Orion Seal Technologies — already submitted and under review; documents waiting for review.
  const orion = get<{ id: number }>("SELECT id FROM vendors WHERE name = 'Orion Seal Technologies LLP'");
  if (orion) {
    const ravi = get<{ id: number }>("SELECT id FROM users WHERE email = 'ravi.teja@orionseal.test'")?.id ?? null;
    run("UPDATE vendors SET invited_by = ?, onboarding_json = ? WHERE id = ?", U('amit.kulkarni'), JSON.stringify({
      invite: { category: 'HYD', contact_name: 'Ravi Teja', email: 'ravi.teja@orionseal.test', phone: '+91 98222 61540', invited_at: D(-12), invited_by: U('amit.kulkarni') },
      contacts: [{ name: 'Ravi Teja', role: 'Director', email: 'ravi.teja@orionseal.test', phone: '+91 98222 61540' }, { name: 'Sunita Rao', role: 'Accounts', email: 'accounts@orionseal.test', phone: '+91 98222 61541' }],
      bank_account_last4: '4417', registered_at: D(-10), submitted_at: D(-6),
    }), orion.id);
    for (const d of all<{ id: number; doc_type: string }>('SELECT id, doc_type FROM vendor_documents WHERE vendor_id = ? AND attachment_id IS NULL', orion.id)) {
      const att = S.attachDemoPdf(orion.id, `${d.doc_type} — Orion Seal Technologies LLP`, ravi);
      run('UPDATE vendor_documents SET attachment_id = ?, doc_no = ? WHERE id = ?', att, d.doc_type === 'GST certificate' ? '27AAPFO6120K1Z' : null, d.id);
    }
    run("UPDATE vendor_documents SET expiry_date = ? WHERE vendor_id = ? AND doc_type = 'MSME / Udyam certificate'", DAY(700), orion.id);
  }

  // 3. Hydrotech bank change — pending; finance verified it and it waits for a second finance approver.
  try {
    const manoj = actorFor('manoj.kale');
    const hydro = V('100101');
    const att = S.attachDemoPdf(hydro, 'Cancelled cheque — new account, Hydrotech Seals', manoj.id);
    const cr = S.requestChange(manoj, {
      field: 'bank_account', reason: 'Moving our collections to a new current account at Axis Bank from next month.',
      bank: { bank_name: 'Axis Bank', bank_ifsc: 'UTIB0000418', account_no: '920020045521763', account_confirm: '920020045521763' }, attachment_ids: [att],
    });
    run('UPDATE vendor_change_requests SET created_at = ? WHERE id = ?', D(-2), cr.id);
    run("UPDATE attachments SET owner_type = 'vendor_change', owner_id = ? WHERE id = ?", cr.id, att);
    S.sendBankChangeForApproval(actorFor('meera.iyer'), cr.id, 'Cancelled cheque matches the new account; called the vendor on the registered number to confirm.');
  } catch (e) {
    console.warn('seed vendors: bank change skipped', (e as Error).message);
  }

  // 4. Tickets
  const ticket = (who: string, b: Parameters<typeof S.createTicket>[1], days: number) => {
    const t = S.createTicket(actorFor(who), b);
    run('UPDATE tickets SET created_at = ?, updated_at = ?, sla_due = ? WHERE id = ?', D(days), D(days), new Date(new Date(D(days)).getTime() + 48 * 3600000).toISOString(), t.id);
    run('UPDATE ticket_messages SET created_at = ? WHERE ticket_id = ?', D(days), t.id);
    return t.id;
  };
  try {
    const t1 = ticket('sanjay', { category: 'Payment query', subject: 'Payment status for PO 4500021003 lubricant supply', body: 'We delivered 10 drums of 15W-40 against PO 4500021003 and the GRN was done. The payment due date has passed but we have not received the amount. Please share the status.', priority: 'High', object_ref: '4500021003' }, -1);
    const meera = actorFor('meera.iyer');
    S.assignTicket(meera, t1, null);
    S.replyTicket(meera, t1, 'Thank you, Sanjay. We are checking the invoice status with our accounts team and will update you within one working day.', false);
    S.replyTicket(meera, t1, 'Internal: invoice is held for the GRN quantity difference (6 received vs 10 billed). Do not share hold details until stores confirm.', true);
    run('UPDATE ticket_messages SET created_at = ? WHERE ticket_id = ? AND id = (SELECT MAX(id) FROM ticket_messages WHERE ticket_id = ?)', D(0), t1, t1);
    ticket('divya.raman', { category: 'PO visibility', subject: 'Second line of PO 4500021002 not visible in the portal', body: 'PO 4500021002 shows only the bucket teeth line on our side. Our sales copy also lists track rollers. Could you check whether the roller line is released?', priority: 'Normal', object_ref: '4500021002' }, -1);
    const t3 = ticket('nitin', { category: 'Login / access', subject: 'Colleague cannot sign in after password attempts', body: 'Our dispatch colleague tried a wrong password several times and is now locked out. Please unlock the account.', priority: 'Normal' }, -8);
    const anjali = actorFor('anjali.verma');
    S.assignTicket(anjali, t3, null);
    S.setTicketStatus(anjali, t3, 'Resolved', 'The account was unlocked and the failed-attempt counter reset. Please ask your colleague to sign in again.');
    run("UPDATE tickets SET updated_at = ?, resolved_at = ? WHERE id = ?", D(-7), D(-7), t3);
  } catch (e) {
    console.warn('seed vendors: tickets skipped', (e as Error).message);
  }

  // 5. KYC expiry reminders (Hydrotech ISO ~24 days, Western MSME ~18 days, Sudarshan ISO expired).
  S.kycExpiryJob();

  if (DEMO_EXTRA) seedExtra();
}

export const module: ModuleDef = { path: 'vendors', router, init, seed };
