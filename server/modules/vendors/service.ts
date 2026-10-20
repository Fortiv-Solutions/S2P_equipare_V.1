/**
 * Module 9 — Vendor portal, onboarding / KYC, vendor management and vendor tickets
 * (PRD 7.9 FR-VPT-01..15, WF-06, NTF-24/25/26).
 *
 * SAP holds the legal vendor record. The platform holds onboarding applications, KYC documents,
 * portal users, capability mapping and tickets. Master fields of a vendor that has an SAP code are
 * never written here: requested changes are reviewed, passed to the SAP team and only show once the
 * VENDOR sync (INT-M01) returns the new value (FR-VPT-02, AC-VPT-04).
 */
import crypto from 'node:crypto';
import { all, get, insert, update, run, J, now, addDays, addHours, tx, scalar } from '../../core/db.ts';
import { audit, diff } from '../../core/audit.ts';
import { notify } from '../../core/notify.ts';
import { cfg } from '../../core/config.ts';
import { badRequest, conflict, forbidden, notFound, HttpError } from '../../core/http.ts';
import { createApproval, approvalForObject, type ApprovalRow } from '../../core/approvals.ts';
import { assertVendorScope, hashPassword, type Actor } from '../../core/auth.ts';
import { linkAttachments, storeGenerated } from '../../core/files.ts';
import { staleInfo } from '../../core/sap.ts';
import { nextNo } from '../../core/numbering.ts';
import { validateGstin, validPan, panFromGstin, PAN_RE, IFSC_RE } from '../../core/india.ts';
import type { Role } from '../../core/permissions.ts';
import { SINGLE_USER } from '../../core/mode.ts';
import { adminId } from '../../core/singleuser.ts';

// ------------------------------------------------------------------ types & constants
export interface Onboarding {
  invite?: { category: string | null; contact_name: string; email: string; phone: string | null; invited_at: string; invited_by: number | null };
  contacts?: { name: string; role: string; email: string; phone: string }[];
  bank_account_last4?: string;
  registered_at?: string;
  submitted_at?: string;
  resubmissions?: number;
  reviews?: { procurement?: Review; finance?: Review };
  approval_id?: number;
  approved_at?: string;
  rejected_reason?: string;
  rejected_at?: string;
  clarification?: { note: string; at: string; by: number; by_name: string };
  sap_requested_at?: string;
  sap_linked_at?: string;
}
interface Review { by: number; by_name: string; at: string; note: string | null }

export interface VendorRow {
  id: number; sap_code: string | null; name: string; legal_name: string | null; pan: string | null; gstin: string | null;
  msme_no: string | null; msme_category: string | null; address: string | null; city: string | null; state: string | null;
  contact_name: string | null; contact_email: string | null; contact_phone: string | null;
  bank_name: string | null; bank_account_masked: string | null; bank_ifsc: string | null; sap_blocked: number;
  onboarding_status: string; portal_status: string; performance_score: number | null;
  invited_by: number | null; invite_token: string | null; invite_expires_at: string | null; created_at: string | null; synced_at: string | null;
  onboarding: Onboarding | null;
}

/** Statuses in which the vendor may still edit its application (SCR-VPT-11). */
const EDITABLE = ['Invited', 'Registration in progress', 'Clarification requested'];
const REVIEWABLE = ['Submitted', 'Under review'];

/** GST state codes (first two digits of a GSTIN). */
export const GST_STATES: Record<string, string> = {
  'Jammu and Kashmir': '01', 'Himachal Pradesh': '02', Punjab: '03', Chandigarh: '04', Uttarakhand: '05', Haryana: '06', Delhi: '07',
  Rajasthan: '08', 'Uttar Pradesh': '09', Bihar: '10', Sikkim: '11', 'Arunachal Pradesh': '12', Nagaland: '13', Manipur: '14',
  Mizoram: '15', Tripura: '16', Meghalaya: '17', Assam: '18', 'West Bengal': '19', Jharkhand: '20', Odisha: '21', Chhattisgarh: '22',
  'Madhya Pradesh': '23', Gujarat: '24', 'Dadra and Nagar Haveli and Daman and Diu': '26', Maharashtra: '27', Karnataka: '29', Goa: '30',
  Lakshadweep: '31', Kerala: '32', 'Tamil Nadu': '33', Puducherry: '34', 'Andaman and Nicobar Islands': '35', Telangana: '36',
  'Andhra Pradesh': '37', Ladakh: '38',
};

/** Fields a vendor may ask to change (FR-VPT-02). SAP-owned fields only change when SAP sync returns them. */
export const CHANGE_FIELDS: Record<string, { label: string; owner: 'sap' | 'platform'; highRisk?: boolean }> = {
  bank_account: { label: 'Bank account', owner: 'sap', highRisk: true },
  legal_name: { label: 'Legal name', owner: 'sap' },
  address: { label: 'Registered address', owner: 'sap' },
  city: { label: 'City', owner: 'sap' },
  state: { label: 'State', owner: 'sap' },
  msme_no: { label: 'MSME / Udyam number', owner: 'sap' },
  msme_category: { label: 'MSME category', owner: 'sap' },
  contact_name: { label: 'Primary contact name', owner: 'platform' },
  contact_email: { label: 'Primary contact e-mail', owner: 'platform' },
  contact_phone: { label: 'Primary contact phone', owner: 'platform' },
};

export const SUPPLIER_ROLES = ['Manufacturer', 'Authorised distributor', 'Dealer', 'Trader', 'Reman service', 'Service provider'];
export const MSME_CATEGORIES = ['Micro', 'Small', 'Medium'];
const UDYAM_RE = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;
const SIM_EMAIL = 'Simulated — not sent (no e-mail provider connected)';

// ------------------------------------------------------------------ helpers
export const getVendor = (id: number) => get<VendorRow>('SELECT * FROM vendors WHERE id = ?', id);
export function mustVendor(id: number) {
  const v = getVendor(id);
  if (!v) throw notFound('Vendor');
  return v;
}
export function myVendorId(actor: Actor) {
  if (actor.role !== 'VEN' || !actor.vendorId) throw forbidden('Only vendor users can do this.');
  return actor.vendorId;
}
const userName = (id: number | null | undefined) => (id ? get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? null : null);
const ob = (v: VendorRow): Onboarding => v.onboarding ?? {};
function saveOb(id: number, o: Onboarding, extra: Record<string, unknown> = {}) {
  update('vendors', id, { onboarding_json: J(o), ...extra });
}
export const maskAccount = (acc: string) => `${'X'.repeat(Math.max(4, acc.length - 4))}${acc.slice(-4)}`;
export const maskPan = (pan: string | null) => (pan && pan.length === 10 ? `${pan.slice(0, 3)}XXXX${pan.slice(7)}` : pan);
export const isVendorActive = (vendorId: number) => get<{ onboarding_status: string }>('SELECT onboarding_status FROM vendors WHERE id = ?', vendorId)?.onboarding_status === 'Active';
const today = () => now().slice(0, 10);
const plusDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

export function mandatoryDocTypes(v: Pick<VendorRow, 'msme_no'>) {
  const base = cfg<string[]>('vendor.mandatory_documents');
  return v.msme_no ? [...base, 'MSME / Udyam certificate'] : base;
}

export interface DocRow {
  id: number; vendor_id: number; doc_type: string; doc_no: string | null; attachment_id: number | null; issued_on: string | null;
  expiry_date: string | null; status: string; mandatory: number; review_note: string | null; reviewed_by: number | null; created_at: string;
  filename?: string | null; reviewed_by_name?: string | null;
}
export function documentsOf(vendorId: number) {
  return all<DocRow>(
    `SELECT d.*, a.filename, u.name AS reviewed_by_name FROM vendor_documents d LEFT JOIN attachments a ON a.id = d.attachment_id
     LEFT JOIN users u ON u.id = d.reviewed_by WHERE d.vendor_id = ? ORDER BY d.doc_type, d.id DESC`, vendorId,
  );
}

/** KYC state for a vendor from its mandatory documents (FR-VPT-11/12). */
export function kycState(v: Pick<VendorRow, 'id' | 'msme_no'>, docs = documentsOf(v.id)) {
  const lead = cfg<number>('kyc.expiry_lead_days');
  const t = today();
  const soon = plusDays(lead);
  const missing: string[] = [];
  const expired: string[] = [];
  const pending: string[] = [];
  const rejected: string[] = [];
  const expiring: string[] = [];
  for (const type of mandatoryDocTypes(v)) {
    const rows = docs.filter((d) => d.doc_type === type && d.status !== 'Superseded');
    const valid = rows.find((d) => d.status === 'Valid' && (!d.expiry_date || d.expiry_date >= t));
    if (valid) {
      if (valid.expiry_date && valid.expiry_date <= soon) expiring.push(type);
      continue;
    }
    if (rows.some((d) => d.status === 'Pending review')) pending.push(type);
    else if (rows.some((d) => d.status === 'Expired' || (d.status === 'Valid' && d.expiry_date && d.expiry_date < t))) expired.push(type);
    else if (rows.some((d) => d.status === 'Rejected')) rejected.push(type);
    else missing.push(type);
  }
  const state = expired.length ? 'Expired' : rejected.length ? 'Rejected' : missing.length ? 'Incomplete' : pending.length ? 'Pending review' : expiring.length ? 'Expiring' : 'Complete';
  return { state, missing, expired, pending, rejected, expiring };
}

function outboxEmail(to: string, subject: string, body: string, template: string) {
  insert('outbox', { channel: 'email', recipient: to, subject, body, template, status: SIM_EMAIL, created_at: now() });
}

/** Procurement contacts for a vendor: buyer owners of its capabilities, else all buyers. */
function procurementUsers(vendorId: number) {
  return all<{ id: number }>(
    "SELECT DISTINCT buyer_owner_id AS id FROM vendor_capabilities WHERE vendor_id = ? AND status = 'Approved' AND buyer_owner_id IS NOT NULL", vendorId,
  ).map((r) => r.id);
}

// ------------------------------------------------------------------ lists (SCR-VPT internal)
export function listVendors() {
  const rows = all<VendorRow & { categories: string | null; proposed_caps: number; pending_changes: number; portal_users: number }>(
    `SELECT v.*,
       (SELECT GROUP_CONCAT(DISTINCT c.category) FROM vendor_capabilities c WHERE c.vendor_id = v.id AND c.status = 'Approved') AS categories,
       (SELECT COUNT(*) FROM vendor_capabilities c WHERE c.vendor_id = v.id AND c.status = 'Proposed') AS proposed_caps,
       (SELECT COUNT(*) FROM vendor_change_requests r WHERE r.vendor_id = v.id AND r.status IN ('Pending','Approved','Sent to SAP')) AS pending_changes,
       (SELECT COUNT(*) FROM users u WHERE u.vendor_id = v.id AND u.active = 1) AS portal_users
     FROM vendors v ORDER BY v.name`,
  );
  const allDocs = all<DocRow>('SELECT * FROM vendor_documents');
  return rows.map((v) => {
    const k = kycState(v, allDocs.filter((d) => d.vendor_id === v.id));
    const { invite_token: _t, onboarding, ...rest } = v;
    return {
      ...rest, kyc_state: k.state, kyc_issues: [...k.expired, ...k.rejected, ...k.missing, ...k.pending, ...k.expiring],
      invited_category: onboarding?.invite?.category ?? null, submitted_at: onboarding?.submitted_at ?? null,
      invite_expired: v.onboarding_status === 'Invited' && !!v.invite_expires_at && v.invite_expires_at < now(),
    };
  });
}

export function listChangeRequests(q: { status?: string; vendorId?: number }) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (q.vendorId) { where.push('r.vendor_id = ?'); p.push(q.vendorId); }
  if (q.status === 'open') where.push("r.status IN ('Pending','Approved','Sent to SAP')");
  else if (q.status) { where.push('r.status = ?'); p.push(q.status); }
  return all<Record<string, unknown> & { id: number; field: string; approval_id: number | null }>(
    `SELECT r.*, v.name AS vendor_name, v.sap_code, u.name AS requested_by_name, d.name AS decided_by_name,
            a.req_no AS approval_no, a.status AS approval_status
     FROM vendor_change_requests r JOIN vendors v ON v.id = r.vendor_id LEFT JOIN users u ON u.id = r.requested_by
     LEFT JOIN users d ON d.id = r.decided_by LEFT JOIN approvals a ON a.id = r.approval_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC`, ...p,
  ).map((r) => ({ ...r, field_label: CHANGE_FIELDS[r.field]?.label ?? r.field, sap_owned: CHANGE_FIELDS[r.field]?.owner === 'sap' }));
}

export function listCapabilities(q: { status?: string; vendorId?: number }) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (q.vendorId) { where.push('c.vendor_id = ?'); p.push(q.vendorId); }
  if (q.status) { where.push('c.status = ?'); p.push(q.status); }
  return all(
    `SELECT c.*, v.name AS vendor_name, v.sap_code, v.onboarding_status, sc.name AS category_name, b.name AS buyer_owner_name, d.name AS decided_by_name
     FROM vendor_capabilities c JOIN vendors v ON v.id = c.vendor_id LEFT JOIN spend_categories sc ON sc.code = c.category
     LEFT JOIN users b ON b.id = c.buyer_owner_id LEFT JOIN users d ON d.id = c.decided_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.id DESC`, ...p,
  );
}

/** Current (not superseded) documents expiring within the lead time or already expired. */
export function expiringDocuments() {
  const soon = plusDays(cfg<number>('kyc.expiry_lead_days'));
  return all<DocRow & { vendor_name: string; sap_code: string | null }>(
    `SELECT d.*, v.name AS vendor_name, v.sap_code, a.filename FROM vendor_documents d JOIN vendors v ON v.id = d.vendor_id
     LEFT JOIN attachments a ON a.id = d.attachment_id
     WHERE d.status IN ('Valid','Expired') AND d.expiry_date IS NOT NULL AND d.expiry_date <= ? ORDER BY d.expiry_date`, soon,
  ).map((d) => ({ ...d, days_left: Math.ceil((new Date(`${d.expiry_date}T00:00:00Z`).getTime() - new Date(`${today()}T00:00:00Z`).getTime()) / 86400000) }));
}

// ------------------------------------------------------------------ vendor 360
export function vendorDetail(actor: Actor, id: number) {
  const v = mustVendor(id);
  const docs = documentsOf(id);
  const o = ob(v);
  const approval = o.approval_id ? get<{ id: number; req_no: string; status: string; current_level: number }>('SELECT id, req_no, status, current_level FROM approvals WHERE id = ?', o.approval_id) : null;
  const canInvite = actor.perms.has('vendor.onboard');
  const rfqs = all('SELECT r.id, r.rfq_no, r.title, r.status, r.closing_at, i.status AS invitation_status FROM rfq_invitations i JOIN rfqs r ON r.id = i.rfq_id WHERE i.vendor_id = ? ORDER BY r.id DESC LIMIT 25', id);
  const pos = all('SELECT id, po_no, po_date, status, total_value, plant FROM pos WHERE vendor_id = ? ORDER BY po_date DESC, id DESC LIMIT 25', id);
  const invoices = all('SELECT id, inv_ref, vendor_invoice_no, status, total_value, invoice_date FROM invoices WHERE vendor_id = ? ORDER BY id DESC LIMIT 25', id);
  const users = all(
    'SELECT id, name, email, phone, vendor_role, title, active, locked, failed_attempts, last_login, created_at FROM users WHERE vendor_id = ? ORDER BY active DESC, name', id,
  );
  const tickets = all('SELECT id, tkt_no, subject, category, status, created_at FROM tickets WHERE vendor_id = ? ORDER BY id DESC LIMIT 10', id);
  const counts = {
    rfqs: scalar<number>('SELECT COUNT(*) FROM rfq_invitations WHERE vendor_id = ?', id) ?? 0,
    pos: scalar<number>('SELECT COUNT(*) FROM pos WHERE vendor_id = ?', id) ?? 0,
    invoices: scalar<number>('SELECT COUNT(*) FROM invoices WHERE vendor_id = ?', id) ?? 0,
    contracts: scalar<number>('SELECT COUNT(*) FROM contracts WHERE vendor_id = ?', id) ?? 0,
    disputes: scalar<number>('SELECT COUNT(*) FROM disputes d JOIN pos p ON p.id = d.po_id WHERE p.vendor_id = ?', id) ?? 0,
  };
  const { invite_token, onboarding, ...rest } = v;
  return {
    ...rest,
    onboarding: o,
    invited_by_name: userName(v.invited_by),
    invite_link: canInvite && invite_token && v.onboarding_status === 'Invited' ? `/register?token=${invite_token}` : null,
    invite_expired: v.onboarding_status === 'Invited' && !!v.invite_expires_at && v.invite_expires_at < now(),
    freshness: v.sap_code ? staleInfo('INT-M01', v.synced_at) : null,
    documents: docs,
    mandatory_types: mandatoryDocTypes(v),
    kyc: kycState(v, docs),
    capabilities: listCapabilities({ vendorId: id }),
    change_requests: listChangeRequests({ vendorId: id }),
    approval,
    users,
    tickets,
    rfqs,
    pos,
    invoices,
    counts,
  };
}

// ------------------------------------------------------------------ invitation (WF-06)
export function inviteVendor(actor: Actor, b: { legal_name: string; contact_name: string; email: string; phone?: string | null; category: string }) {
  const email = b.email.trim().toLowerCase();
  if (get('SELECT id FROM users WHERE lower(email) = ?', email)) throw conflict('A portal user with this e-mail already exists. Use a different contact e-mail or ask the administrator.');
  const dupe = get<{ id: number; name: string; onboarding_status: string }>("SELECT id, name, onboarding_status FROM vendors WHERE lower(contact_email) = ? AND onboarding_status != 'Rejected'", email);
  if (dupe) throw conflict(`${dupe.name} already uses this contact e-mail (${dupe.onboarding_status}). Open that vendor instead of inviting again.`);
  if (get("SELECT id FROM vendors WHERE lower(name) = lower(?) AND onboarding_status != 'Rejected'", b.legal_name.trim())) {
    throw conflict('A vendor with this name already exists. Check the vendor list before inviting.');
  }
  if (!get('SELECT code FROM spend_categories WHERE code = ?', b.category)) throw badRequest('Choose a spend category from the list.', { category: 'Unknown category' });
  const token = crypto.randomBytes(24).toString('base64url');
  const days = cfg<number>('vendor.invite_valid_days');
  const ts = now();
  const o: Onboarding = { invite: { category: b.category, contact_name: b.contact_name.trim(), email, phone: b.phone?.trim() || null, invited_at: ts, invited_by: actor.id } };
  const id = insert('vendors', {
    name: b.legal_name.trim(), legal_name: b.legal_name.trim(), contact_name: b.contact_name.trim(), contact_email: email, contact_phone: b.phone?.trim() || null,
    onboarding_status: 'Invited', portal_status: 'Invited', invited_by: actor.id, invite_token: token, invite_expires_at: addDays(ts, days),
    onboarding_json: J(o), created_at: ts,
  });
  sendInvite(id, actor);
  audit(actor, { action: 'vendor.invited', objectType: 'vendor', objectId: id, objectRef: b.legal_name, after: { contact: email, category: b.category, valid_days: days } });
  return { id, link: `/register?token=${token}`, expires_at: addDays(ts, days) };
}

function sendInvite(id: number, actor: Actor) {
  const v = mustVendor(id);
  outboxEmail(
    v.contact_email!, `Invitation to register as an Equipcare vendor — ${v.name}`,
    `Dear ${v.contact_name}, ${actor.name} has invited ${v.name} to register on the Equipcare vendor portal. Open /register?token=${v.invite_token} before ${v.invite_expires_at?.slice(0, 10)} to set your password and complete onboarding.`,
    'VENDOR-INVITE.v1',
  );
}

export function resendInvite(actor: Actor, id: number) {
  const v = mustVendor(id);
  if (v.onboarding_status !== 'Invited') throw conflict(`The vendor has already registered (${v.onboarding_status}). A new invitation is not needed.`);
  const token = crypto.randomBytes(24).toString('base64url');
  const exp = addDays(now(), cfg<number>('vendor.invite_valid_days'));
  update('vendors', id, { invite_token: token, invite_expires_at: exp });
  sendInvite(id, actor);
  audit(actor, { action: 'vendor.invite_resent', objectType: 'vendor', objectId: id, objectRef: v.name, after: { expires_at: exp }, reason: 'Previous link replaced' });
  return { link: `/register?token=${token}`, expires_at: exp };
}

/** Public: what the registration page shows for a token. */
export function inviteInfo(token: string) {
  const v = get<VendorRow>('SELECT * FROM vendors WHERE invite_token = ?', token);
  if (!v) throw notFound('Invitation');
  const expired = !v.invite_expires_at || v.invite_expires_at < now();
  return { vendor: v.name, contact_name: v.contact_name, email: v.contact_email, expires_at: v.invite_expires_at, expired, status: v.onboarding_status, single_user: SINGLE_USER };
}

/** Public: accept the invitation by setting a password. Creates the vendor administrator user. */
export function acceptInvite(b: { token: string; name: string; password: string; phone?: string | null }, ip?: string) {
  return tx(() => {
    const v = get<VendorRow>('SELECT * FROM vendors WHERE invite_token = ?', b.token);
    if (!v) throw notFound('Invitation');
    if (v.onboarding_status !== 'Invited') throw conflict('This invitation has already been used. Sign in with your e-mail and password.');
    if (!v.invite_expires_at || v.invite_expires_at < now()) throw new HttpError(410, 'expired', 'This invitation link has expired. Ask your Equipcare buyer to send a new one.');
    const email = v.contact_email!;
    // Single-user mode has no vendor accounts: the invitation is accepted for the vendor company and the
    // Administrator completes the registration from the vendor portal view. No password is stored.
    if (!SINGLE_USER && get('SELECT id FROM users WHERE lower(email) = ?', email)) throw conflict('An account with this e-mail already exists. Sign in instead.');
    const uid = SINGLE_USER ? adminId() : insert('users', {
      name: b.name.trim(), email, phone: b.phone?.trim() || v.contact_phone, roles: 'VEN', title: 'Vendor administrator', vendor_id: v.id,
      vendor_role: 'Vendor administrator', password_hash: hashPassword(b.password), created_at: now(),
    });
    const o = ob(v);
    o.registered_at = now();
    saveOb(v.id, o, { onboarding_status: 'Registration in progress', invite_token: null });
    const actor = { id: uid, name: SINGLE_USER ? `${b.name.trim()} (via invitation link, ${v.name})` : b.name.trim(), role: 'VEN' as Role, ip, channel: 'web' } as Actor;
    audit(actor, { action: 'vendor.registration_accepted', objectType: 'vendor', objectId: v.id, objectRef: v.name, before: { onboarding_status: 'Invited' }, after: { onboarding_status: 'Registration in progress', user_id: uid } });
    notify({ event: 'NTF-24', title: `${v.name} accepted the invitation`, body: 'Registration in progress — the vendor is completing the onboarding form.', link: `/vendors/${v.id}`, users: [v.invited_by], objectType: 'vendor', objectId: v.id });
    return { email, single_user: SINGLE_USER };
  });
}

// ------------------------------------------------------------------ vendor-side onboarding (SCR-VPT-11)
export function myOnboarding(actor: Actor) {
  const vid = myVendorId(actor);
  const v = mustVendor(vid);
  const docs = documentsOf(vid);
  const o = ob(v);
  return {
    vendor: {
      id: v.id, name: v.name, legal_name: v.legal_name, address: v.address, city: v.city, state: v.state, pan: v.pan, gstin: v.gstin,
      msme_no: v.msme_no, msme_category: v.msme_category, bank_name: v.bank_name, bank_ifsc: v.bank_ifsc, bank_account_masked: v.bank_account_masked,
      contact_name: v.contact_name, contact_email: v.contact_email, contact_phone: v.contact_phone, onboarding_status: v.onboarding_status,
      portal_status: v.portal_status, sap_code: v.sap_code,
    },
    contacts: o.contacts ?? (v.contact_name ? [{ name: v.contact_name, role: 'Primary contact', email: v.contact_email ?? '', phone: v.contact_phone ?? '' }] : []),
    invited_category: o.invite?.category ?? null,
    submitted_at: o.submitted_at ?? null,
    clarification: o.clarification ?? null,
    rejected_reason: o.rejected_reason ?? null,
    editable: EDITABLE.includes(v.onboarding_status),
    documents: docs.map(({ reviewed_by: _r, ...d }) => d),
    mandatory_types: mandatoryDocTypes(v),
    document_types: cfg<string[]>('vendor.document_types'),
    capabilities: all("SELECT c.id, c.category, sc.name AS category_name, c.sub_category, c.supplier_role, c.brand, c.region, c.status, c.decision_note FROM vendor_capabilities c LEFT JOIN spend_categories sc ON sc.code = c.category WHERE c.vendor_id = ? ORDER BY c.id", vid),
    categories: all('SELECT code, name FROM spend_categories ORDER BY name'),
    states: Object.keys(GST_STATES).sort(),
    supplier_roles: SUPPLIER_ROLES,
    checklist: submissionProblems(v, docs),
  };
}

function assertEditable(v: VendorRow) {
  if (!EDITABLE.includes(v.onboarding_status)) {
    throw conflict(v.onboarding_status === 'Active'
      ? 'Your company is active. Use Profile › Request a change; master data changes go to Equipcare for approval.'
      : `Your application is ${v.onboarding_status.toLowerCase()}. It can be edited again only if Equipcare asks for a clarification.`);
  }
}

export type OnboardingSection =
  | { section: 'company'; legal_name: string; name: string; address: string; city: string; state: string }
  | { section: 'tax'; gstin: string; pan: string }
  | { section: 'msme'; registered: boolean; msme_no?: string | null; msme_category?: string | null }
  | { section: 'bank'; bank_name: string; bank_ifsc: string; account_no: string; account_confirm: string }
  | { section: 'contacts'; contacts: { name: string; role: string; email: string; phone: string }[] };

/** Validate GSTIN and PAN together: format, check digit, PAN inside GSTIN, state code (FR-INV-04 rules reused). */
export function checkTaxIds(gstinRaw: string, panRaw: string, state: string | null, selfId?: number) {
  const gstin = gstinRaw.trim().toUpperCase();
  const pan = panRaw.trim().toUpperCase();
  const fields: Record<string, string> = {};
  if (!PAN_RE.test(pan)) fields.pan = 'PAN must be 5 letters, 4 digits and a letter, e.g. AAPFO6120K.';
  const g = validateGstin(gstin);
  if (!g.ok) fields.gstin = g.reason === 'GSTIN check digit invalid'
    ? 'GSTIN check digit (15th character) does not match. Re-check the number on your GST certificate.'
    : 'GSTIN must be 15 characters: 2-digit state code, 10-character PAN, entity number, Z, check character.';
  if (!fields.pan && !fields.gstin && panFromGstin(gstin) !== pan) fields.gstin = `Characters 3–12 of the GSTIN (${panFromGstin(gstin)}) must equal the PAN (${pan}).`;
  if (!fields.gstin && state && GST_STATES[state] && gstin.slice(0, 2) !== GST_STATES[state]) fields.gstin = `GSTIN state code ${gstin.slice(0, 2)} does not match ${state} (${GST_STATES[state]}). Use the GSTIN registered in your state.`;
  const dupe = get<{ id: number; name: string }>('SELECT id, name FROM vendors WHERE (pan = ? OR gstin = ?) AND id != ?', pan, gstin, selfId ?? 0);
  if (!fields.pan && !fields.gstin && dupe) fields.pan = 'This PAN/GSTIN is already registered with Equipcare. Contact procurement instead of registering again.';
  if (Object.keys(fields).length) throw badRequest(Object.values(fields)[0], fields);
  return { gstin, pan };
}

export function saveOnboarding(actor: Actor, b: OnboardingSection) {
  const vid = myVendorId(actor);
  const v = mustVendor(vid);
  assertEditable(v);
  if (v.sap_code) throw conflict('Your SAP vendor code is already linked; master data comes from SAP.');
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const o = ob(v);
  const set = (k: keyof VendorRow, val: unknown) => { before[k] = v[k]; after[k] = val; };
  if (b.section === 'company') {
    if (!GST_STATES[b.state]) throw badRequest('Choose your registered state from the list.', { state: 'Choose a state' });
    set('legal_name', b.legal_name.trim()); set('name', b.name.trim() || b.legal_name.trim()); set('address', b.address.trim()); set('city', b.city.trim()); set('state', b.state);
  } else if (b.section === 'tax') {
    const t = checkTaxIds(b.gstin, b.pan, v.state, vid);
    set('gstin', t.gstin); set('pan', t.pan);
  } else if (b.section === 'msme') {
    if (b.registered) {
      const no = (b.msme_no ?? '').trim().toUpperCase();
      if (!UDYAM_RE.test(no)) throw badRequest('Udyam number must look like UDYAM-MH-26-0071234.', { msme_no: 'Format UDYAM-XX-00-0000000' });
      if (!MSME_CATEGORIES.includes(b.msme_category ?? '')) throw badRequest('Choose the MSME category on your Udyam certificate.', { msme_category: 'Choose Micro, Small or Medium' });
      set('msme_no', no); set('msme_category', b.msme_category);
    } else { set('msme_no', null); set('msme_category', null); }
  } else if (b.section === 'bank') {
    const ifsc = b.bank_ifsc.trim().toUpperCase();
    const acc = b.account_no.replace(/\s/g, '');
    const fields: Record<string, string> = {};
    if (!IFSC_RE.test(ifsc)) fields.bank_ifsc = 'IFSC is 11 characters: 4 letters, 0, then 6 letters or digits (e.g. HDFC0001234).';
    if (!/^\d{9,18}$/.test(acc)) fields.account_no = 'Account number must be 9 to 18 digits.';
    else if (acc !== b.account_confirm.replace(/\s/g, '')) fields.account_confirm = 'The two account numbers do not match.';
    if (!b.bank_name.trim()) fields.bank_name = 'Enter the bank name.';
    if (Object.keys(fields).length) throw badRequest(Object.values(fields)[0], fields);
    // Only the masked number is kept by the platform; the full number is entered in SAP from the cancelled cheque.
    set('bank_name', b.bank_name.trim()); set('bank_ifsc', ifsc); set('bank_account_masked', maskAccount(acc));
    o.bank_account_last4 = acc.slice(-4);
  } else if (b.section === 'contacts') {
    if (!b.contacts.length) throw badRequest('Add at least one contact.', { contacts: 'Add a contact' });
    o.contacts = b.contacts.map((c) => ({ name: c.name.trim(), role: c.role.trim(), email: c.email.trim().toLowerCase(), phone: c.phone.trim() }));
    set('contact_name', o.contacts[0].name); set('contact_email', o.contacts[0].email); set('contact_phone', o.contacts[0].phone);
  }
  const status = v.onboarding_status === 'Invited' ? 'Registration in progress' : v.onboarding_status;
  saveOb(vid, o, { ...after, onboarding_status: status });
  audit(actor, { action: `vendor.onboarding_${b.section}_saved`, objectType: 'vendor', objectId: vid, objectRef: v.name, ...diff(before, after) });
  return myOnboarding(actor);
}

function submissionProblems(v: VendorRow, docs: DocRow[]) {
  const o = ob(v);
  const items: { key: string; label: string; ok: boolean; hint?: string }[] = [
    { key: 'company', label: 'Company details', ok: !!(v.legal_name && v.address && v.city && v.state), hint: 'Legal name, address, city and state' },
    { key: 'tax', label: 'GSTIN and PAN', ok: !!(v.gstin && v.pan && validateGstin(v.gstin).ok && validPan(v.pan)), hint: 'Valid GSTIN with matching PAN' },
    { key: 'bank', label: 'Bank account', ok: !!(v.bank_name && v.bank_ifsc && v.bank_account_masked), hint: 'Bank, IFSC and account number' },
    { key: 'contacts', label: 'Contacts', ok: !!(o.contacts?.length || v.contact_email), hint: 'At least one contact' },
  ];
  for (const t of mandatoryDocTypes(v)) {
    const has = docs.some((d) => d.doc_type === t && d.attachment_id && ['Pending review', 'Valid'].includes(d.status));
    items.push({ key: `doc:${t}`, label: t, ok: has, hint: 'Upload the document' });
  }
  const caps = scalar<number>("SELECT COUNT(*) FROM vendor_capabilities WHERE vendor_id = ? AND status != 'Rejected'", v.id) ?? 0;
  items.push({ key: 'capabilities', label: 'What you supply', ok: caps > 0, hint: 'At least one capability row' });
  return items;
}

export function submitOnboarding(actor: Actor) {
  const vid = myVendorId(actor);
  const v = mustVendor(vid);
  assertEditable(v);
  const problems = submissionProblems(v, documentsOf(vid)).filter((p) => !p.ok);
  if (problems.length) throw badRequest(`Complete these before submitting: ${problems.map((p) => p.label).join(', ')}.`, Object.fromEntries(problems.map((p) => [p.key, p.hint ?? 'Required'])));
  const o = ob(v);
  const resubmit = v.onboarding_status === 'Clarification requested';
  o.submitted_at = now();
  if (resubmit) o.resubmissions = (o.resubmissions ?? 0) + 1;
  const asker = o.clarification?.by;
  delete o.clarification;
  saveOb(vid, o, { onboarding_status: 'Submitted', portal_status: 'Registration submitted' });
  audit(actor, { action: resubmit ? 'vendor.onboarding_resubmitted' : 'vendor.onboarding_submitted', objectType: 'vendor', objectId: vid, objectRef: v.name, before: { onboarding_status: v.onboarding_status }, after: { onboarding_status: 'Submitted' } });
  notify({
    event: 'NTF-24', title: `${v.name} ${resubmit ? 'resubmitted' : 'submitted'} onboarding`, body: 'Review documents, capabilities and bank details.',
    link: `/vendors/${vid}`, users: [v.invited_by, asker], roles: ['APR'], objectType: 'vendor', objectId: vid, dedupeKey: `NTF-24:submit:${vid}:${o.submitted_at}`,
  });
  notify({ event: 'NTF-24', title: 'Onboarding application received', body: 'Equipcare procurement and finance will review it. You will be notified of the outcome.', link: '/vendor/onboarding', vendorId: vid, objectType: 'vendor', objectId: vid, dedupeKey: `NTF-24:ack:${vid}:${o.submitted_at}` });
  return myOnboarding(actor);
}

export function respondClarification(actor: Actor, message: string) {
  const vid = myVendorId(actor);
  const v = mustVendor(vid);
  if (v.onboarding_status !== 'Clarification requested') throw conflict('No clarification is open on your application.');
  insert('comments', { object_type: 'vendor', object_id: vid, user_id: actor.id, body: message, internal: 0, created_at: now() });
  audit(actor, { action: 'vendor.clarification_answered', objectType: 'vendor', objectId: vid, objectRef: v.name, reason: message });
  notify({ event: 'NTF-24', title: `${v.name} answered your clarification`, body: message.slice(0, 140), link: `/vendors/${vid}`, users: [ob(v).clarification?.by, v.invited_by], objectType: 'vendor', objectId: vid, dedupeKey: `NTF-24:answer:${vid}:${now()}` });
  return { ok: true };
}

// ------------------------------------------------------------------ documents & capabilities (vendor side)
export function addDocument(actor: Actor, b: { doc_type: string; doc_no?: string | null; issued_on?: string | null; expiry_date?: string | null; attachment_id: number }) {
  const vid = myVendorId(actor);
  const v = mustVendor(vid);
  if (!cfg<string[]>('vendor.document_types').includes(b.doc_type)) throw badRequest('Choose a document type from the list.', { doc_type: 'Unknown type' });
  const att = get<{ id: number; owner_type: string | null; owner_id: number | null; uploaded_by: number | null }>('SELECT id, owner_type, owner_id, uploaded_by FROM attachments WHERE id = ?', b.attachment_id);
  if (!att || (att.uploaded_by !== actor.id && !(att.owner_type === 'vendor' && att.owner_id === vid))) throw badRequest('Upload the file first, then save the document.', { attachment_id: 'Upload the file' });
  if (b.expiry_date && b.expiry_date < today()) throw badRequest('This document has already expired. Upload the current version.', { expiry_date: 'Date is in the past' });
  if (b.issued_on && b.expiry_date && b.expiry_date < b.issued_on) throw badRequest('Expiry date must be after the issue date.', { expiry_date: 'Before issue date' });
  linkAttachments([b.attachment_id], 'vendor', vid);
  run("UPDATE attachments SET label = ? WHERE id = ? AND (label IS NULL OR label = '')", b.doc_type, b.attachment_id);
  const prev = get<{ id: number; status: string }>("SELECT id, status FROM vendor_documents WHERE vendor_id = ? AND doc_type = ? AND status = 'Pending review' ORDER BY id DESC LIMIT 1", vid, b.doc_type);
  // A newer upload replaces an earlier one that is still waiting for review.
  if (prev) update('vendor_documents', prev.id, { status: 'Superseded', review_note: 'Replaced by a newer upload before review' });
  const id = insert('vendor_documents', {
    vendor_id: vid, doc_type: b.doc_type, doc_no: b.doc_no?.trim() || null, attachment_id: b.attachment_id, issued_on: b.issued_on || null,
    expiry_date: b.expiry_date || null, status: 'Pending review', mandatory: mandatoryDocTypes(v).includes(b.doc_type) ? 1 : 0, created_at: now(),
  });
  audit(actor, { action: 'vendor.document_uploaded', objectType: 'vendor', objectId: vid, objectRef: v.name, after: { document_id: id, doc_type: b.doc_type, expiry_date: b.expiry_date ?? null } });
  if (!EDITABLE.includes(v.onboarding_status)) {
    notify({ event: 'NTF-25', title: `${v.name} uploaded a new ${b.doc_type}`, body: 'Review the document so KYC stays current.', link: `/vendors/${vid}`, users: [...procurementUsers(vid)], roles: procurementUsers(vid).length ? undefined : ['BUY'], objectType: 'vendor', objectId: vid, dedupeKey: `NTF-25:upload:${id}` });
  }
  return { id };
}

export function addCapability(actor: Actor, b: { category: string; sub_category?: string | null; supplier_role?: string | null; brand?: string | null; region?: string | null }) {
  const vid = myVendorId(actor);
  const v = mustVendor(vid);
  if (!get('SELECT code FROM spend_categories WHERE code = ?', b.category)) throw badRequest('Choose a category from the list.', { category: 'Unknown category' });
  const dupe = get("SELECT id FROM vendor_capabilities WHERE vendor_id = ? AND category = ? AND COALESCE(sub_category,'') = ? AND status != 'Rejected'", vid, b.category, (b.sub_category ?? '').trim());
  if (dupe) throw conflict('You already proposed this category and sub-category.');
  const id = insert('vendor_capabilities', {
    vendor_id: vid, category: b.category, sub_category: b.sub_category?.trim() || null, supplier_role: b.supplier_role || null, brand: b.brand?.trim() || null,
    region: b.region?.trim() || null, criticality: ['HYD', 'UCG', 'ENG'].includes(b.category) ? 'High' : 'Medium', status: 'Proposed', created_at: now(),
  });
  audit(actor, { action: 'vendor.capability_proposed', objectType: 'vendor', objectId: vid, objectRef: v.name, after: { capability_id: id, category: b.category, sub_category: b.sub_category ?? null } });
  if (v.onboarding_status === 'Active') {
    notify({ event: 'NTF-24', title: `${v.name} proposed a new capability`, body: `${b.category}${b.sub_category ? ' · ' + b.sub_category : ''} — approve before it is used for RFQ suggestions.`, link: '/vendors?tab=capabilities', users: procurementUsers(vid), roles: procurementUsers(vid).length ? undefined : ['BUY'], objectType: 'vendor', objectId: vid, dedupeKey: `NTF-24:cap:${id}` });
  }
  return { id };
}

export function removeCapability(actor: Actor, capId: number) {
  const vid = myVendorId(actor);
  const c = get<{ id: number; vendor_id: number; status: string; category: string }>('SELECT * FROM vendor_capabilities WHERE id = ?', capId);
  if (!c) throw notFound('Capability');
  assertVendorScope(actor, c.vendor_id, 'vendor_capability', capId);
  if (c.status !== 'Proposed') throw conflict('Only proposals that are still waiting for approval can be withdrawn.');
  run('DELETE FROM vendor_capabilities WHERE id = ?', capId);
  audit(actor, { action: 'vendor.capability_withdrawn', objectType: 'vendor', objectId: vid, before: { capability_id: capId, category: c.category } });
  return { ok: true };
}

// ------------------------------------------------------------------ internal review (procurement + finance)
function startReviewIfSubmitted(actor: Actor, v: VendorRow) {
  if (v.onboarding_status !== 'Submitted') return;
  update('vendors', v.id, { onboarding_status: 'Under review' });
  audit(actor, { action: 'vendor.review_started', objectType: 'vendor', objectId: v.id, objectRef: v.name, before: { onboarding_status: 'Submitted' }, after: { onboarding_status: 'Under review' } });
}

export function startReview(actor: Actor, id: number) {
  const v = mustVendor(id);
  if (v.onboarding_status !== 'Submitted') throw conflict(`Review can start only on a submitted application (now ${v.onboarding_status}).`);
  startReviewIfSubmitted(actor, v);
  return vendorDetail(actor, id);
}

export function reviewDocument(actor: Actor, docId: number, decision: 'Valid' | 'Rejected', note: string | null) {
  const d = get<DocRow>('SELECT * FROM vendor_documents WHERE id = ?', docId);
  if (!d) throw notFound('Document');
  if (d.status !== 'Pending review') throw conflict(`This document is already ${d.status.toLowerCase()}.`);
  if (decision === 'Rejected' && (!note || note.trim().length < 10)) throw badRequest('Say why the document is rejected (at least 10 characters) so the vendor can fix it.', { note: 'Reason is required' });
  const v = mustVendor(d.vendor_id);
  tx(() => {
    update('vendor_documents', docId, { status: decision, review_note: note, reviewed_by: actor.id });
    if (decision === 'Valid') {
      run("UPDATE vendor_documents SET status = 'Superseded' WHERE vendor_id = ? AND doc_type = ? AND id != ? AND status IN ('Valid','Expired','Rejected')", d.vendor_id, d.doc_type, docId);
    }
    startReviewIfSubmitted(actor, v);
    audit(actor, { action: decision === 'Valid' ? 'vendor.document_approved' : 'vendor.document_rejected', objectType: 'vendor', objectId: d.vendor_id, objectRef: v.name, before: { document_id: docId, status: d.status }, after: { document_id: docId, doc_type: d.doc_type, status: decision }, reason: note });
  });
  if (decision === 'Rejected') {
    notify({ event: v.onboarding_status === 'Active' ? 'NTF-25' : 'NTF-24', title: `${d.doc_type} was not accepted`, body: `${note} Upload a corrected document.`, link: v.onboarding_status === 'Active' ? '/vendor/profile' : '/vendor/onboarding', vendorId: v.id, objectType: 'vendor', objectId: v.id, dedupeKey: `NTF-25:rej:${docId}`, severity: 'warning' });
  }
  return { ok: true };
}

export function decideCapability(actor: Actor, capId: number, decision: 'Approved' | 'Rejected', note: string | null, buyerOwnerId?: number | null) {
  const c = get<{ id: number; vendor_id: number; status: string; category: string; sub_category: string | null }>('SELECT * FROM vendor_capabilities WHERE id = ?', capId);
  if (!c) throw notFound('Capability');
  if (c.status !== 'Proposed') throw conflict(`This capability is already ${c.status.toLowerCase()}.`);
  if (decision === 'Rejected' && (!note || note.trim().length < 10)) throw badRequest('Give a reason of at least 10 characters for rejecting the capability.', { note: 'Reason is required' });
  const v = mustVendor(c.vendor_id);
  let owner = buyerOwnerId ?? null;
  if (decision === 'Approved' && !owner) owner = get<{ buyer_id: number }>("SELECT buyer_id FROM buyer_matrix WHERE category = ? AND active = 1 ORDER BY (plant = '*') DESC LIMIT 1", c.category)?.buyer_id ?? null;
  update('vendor_capabilities', capId, { status: decision, decided_by: actor.id, decided_at: now(), decision_note: note, buyer_owner_id: owner ?? undefined });
  startReviewIfSubmitted(actor, v);
  audit(actor, { action: decision === 'Approved' ? 'vendor.capability_approved' : 'vendor.capability_rejected', objectType: 'vendor', objectId: c.vendor_id, objectRef: v.name, before: { capability_id: capId, status: 'Proposed' }, after: { capability_id: capId, category: c.category, status: decision, buyer_owner_id: owner }, reason: note });
  notify({ event: 'NTF-24', title: `Capability ${decision.toLowerCase()}: ${c.category}${c.sub_category ? ' · ' + c.sub_category : ''}`, body: decision === 'Rejected' ? note ?? undefined : 'It can now be used when Equipcare selects vendors for RFQs.', link: v.onboarding_status === 'Active' ? '/vendor/profile' : '/vendor/onboarding', vendorId: v.id, objectType: 'vendor', objectId: v.id, dedupeKey: `NTF-24:capd:${capId}` });
  return { ok: true };
}

export function completeReview(actor: Actor, id: number, area: 'procurement' | 'finance', note: string | null) {
  const v = mustVendor(id);
  if (!REVIEWABLE.includes(v.onboarding_status)) throw conflict(`The application is ${v.onboarding_status.toLowerCase()} — reviews can be recorded only while it is submitted or under review.`);
  if (area === 'procurement') {
    if (!actor.perms.has('vendor.onboard')) throw forbidden('Procurement review is recorded by procurement.');
    const proposed = scalar<number>("SELECT COUNT(*) FROM vendor_capabilities WHERE vendor_id = ? AND status = 'Proposed'", id) ?? 0;
    const approved = scalar<number>("SELECT COUNT(*) FROM vendor_capabilities WHERE vendor_id = ? AND status = 'Approved'", id) ?? 0;
    if (proposed) throw conflict(`Approve or reject the ${proposed} proposed capability row(s) first.`);
    if (!approved) throw conflict('At least one capability must be approved before procurement review is complete.');
  } else {
    if (!actor.perms.has('vendor.review_bank')) throw forbidden('Bank and KYC review is recorded by finance.');
    if (!v.bank_account_masked || !v.bank_ifsc) throw conflict('The vendor has not given bank details yet. Ask for a clarification.');
    const cheque = get("SELECT id FROM vendor_documents WHERE vendor_id = ? AND doc_type = 'Cancelled cheque' AND status = 'Valid'", id);
    if (!cheque) throw conflict('Approve the cancelled cheque document before completing the finance review.');
  }
  const o = ob(v);
  o.reviews = { ...(o.reviews ?? {}), [area]: { by: actor.id, by_name: actor.name, at: now(), note } };
  saveOb(id, o, v.onboarding_status === 'Submitted' ? { onboarding_status: 'Under review' } : {});
  audit(actor, { action: `vendor.${area}_review_completed`, objectType: 'vendor', objectId: id, objectRef: v.name, after: { area }, reason: note });
  return vendorDetail(actor, id);
}

export function requestClarification(actor: Actor, id: number, message: string) {
  const v = mustVendor(id);
  if (!REVIEWABLE.includes(v.onboarding_status)) throw conflict(`Clarification can be requested only on a submitted application (now ${v.onboarding_status}).`);
  const o = ob(v);
  o.clarification = { note: message, at: now(), by: actor.id, by_name: actor.name };
  o.reviews = {}; // reviews restart after the vendor changes the application
  saveOb(id, o, { onboarding_status: 'Clarification requested' });
  insert('comments', { object_type: 'vendor', object_id: id, user_id: actor.id, body: `Clarification requested: ${message}`, internal: 0, created_at: now() });
  audit(actor, { action: 'vendor.clarification_requested', objectType: 'vendor', objectId: id, objectRef: v.name, before: { onboarding_status: v.onboarding_status }, after: { onboarding_status: 'Clarification requested' }, reason: message });
  notify({ event: 'NTF-24', title: 'Equipcare needs more information', body: message.slice(0, 200), link: '/vendor/onboarding', vendorId: id, objectType: 'vendor', objectId: id, dedupeKey: `NTF-24:clar:${id}:${o.clarification.at}`, severity: 'warning' });
  return vendorDetail(actor, id);
}

export function submitForApproval(actor: Actor, id: number) {
  const v = mustVendor(id);
  if (v.onboarding_status !== 'Under review') throw conflict(`Only an application under review can go for approval (now ${v.onboarding_status}).`);
  const o = ob(v);
  const missing: string[] = [];
  if (!o.reviews?.procurement) missing.push('procurement review');
  if (!o.reviews?.finance) missing.push('finance bank/KYC review');
  const k = kycState(v);
  const notValid = [...k.missing, ...k.pending, ...k.rejected, ...k.expired];
  if (notValid.length) missing.push(`approved documents (${notValid.join(', ')})`);
  if (missing.length) throw conflict(`Complete before sending for approval: ${missing.join('; ')}.`);
  const ap = createApproval(actor, {
    type: 'vendor.onboarding', objectType: 'vendor', objectId: id, title: `Onboard ${v.name}`,
    summary: `${v.city ?? ''}${v.state ? ', ' + v.state : ''} · GSTIN ${v.gstin} · ${scalar<number>("SELECT COUNT(*) FROM vendor_capabilities WHERE vendor_id = ? AND status = 'Approved'", id)} approved capability row(s)`,
    reason: 'Procurement and finance reviews complete; documents verified.', categoryCode: o.invite?.category ?? null,
    context: { vendor_id: id, gstin: v.gstin, pan: v.pan, procurement_review: o.reviews?.procurement, finance_review: o.reviews?.finance },
  });
  o.approval_id = ap.id;
  saveOb(id, o);
  audit(actor, { action: 'vendor.onboarding_sent_for_approval', objectType: 'vendor', objectId: id, objectRef: v.name, after: { approval: ap.req_no } });
  return vendorDetail(actor, id);
}

export function rejectOnboarding(actor: Actor, id: number, reason: string) {
  const v = mustVendor(id);
  if (['Active', 'Rejected', 'Pending SAP code', 'Approved'].includes(v.onboarding_status)) throw conflict(`An application that is ${v.onboarding_status.toLowerCase()} cannot be rejected here.`);
  if (v.onboarding?.approval_id) {
    const ap = get<{ status: string }>('SELECT status FROM approvals WHERE id = ?', v.onboarding.approval_id);
    if (ap && ['Pending', 'Clarification requested'].includes(ap.status)) throw conflict('An approval request is open. Ask the approver to decide or withdraw it first.');
  }
  applyRejection(actor, v, reason);
  return vendorDetail(actor, id);
}

function applyRejection(actor: Actor | null, v: VendorRow, reason: string) {
  const o = ob(v);
  o.rejected_reason = reason;
  o.rejected_at = now();
  saveOb(v.id, o, { onboarding_status: 'Rejected', invite_token: null });
  insert('comments', { object_type: 'vendor', object_id: v.id, user_id: actor?.id ?? v.invited_by ?? 1, body: `Application rejected: ${reason}`, internal: 0, created_at: now() });
  audit(actor, { action: 'vendor.onboarding_rejected', objectType: 'vendor', objectId: v.id, objectRef: v.name, before: { onboarding_status: v.onboarding_status }, after: { onboarding_status: 'Rejected' }, reason });
  notify({ event: 'NTF-24', title: 'Onboarding application not approved', body: reason, link: '/vendor/onboarding', vendorId: v.id, objectType: 'vendor', objectId: v.id, dedupeKey: `NTF-24:rej:${v.id}`, severity: 'warning' });
}

/** Approval outcome for vendor.onboarding (APR then FIN). */
export function onOnboardingDecision(ap: ApprovalRow, outcome: string, actor: Actor | null, comment: string | null) {
  const v = getVendor(ap.object_id);
  if (!v) return;
  if (outcome === 'Approved') {
    const o = ob(v);
    o.approved_at = now();
    o.sap_requested_at = now();
    saveOb(v.id, o, { onboarding_status: 'Pending SAP code' });
    audit(actor, { action: 'vendor.onboarding_approved', objectType: 'vendor', objectId: v.id, objectRef: v.name, before: { onboarding_status: v.onboarding_status }, after: { onboarding_status: 'Approved' }, reason: `Approved via ${ap.req_no}` });
    audit(actor, { action: 'vendor.sap_creation_requested', objectType: 'vendor', objectId: v.id, objectRef: v.name, before: { onboarding_status: 'Approved' }, after: { onboarding_status: 'Pending SAP code' } });
    notify({ event: 'NTF-24', title: `Create SAP vendor for ${v.name}`, body: `Onboarding approved (${ap.req_no}). Create the vendor master in SAP; the code links automatically on the next vendor sync by PAN/GSTIN.`, link: `/vendors/${v.id}`, roles: ['SAP'], objectType: 'vendor', objectId: v.id, dedupeKey: `NTF-24:sap:${v.id}`, severity: 'warning' });
    notify({ event: 'NTF-24', title: 'Onboarding approved', body: 'Equipcare is creating your vendor code in SAP. Full portal access opens once the code is linked.', link: '/vendor/onboarding', vendorId: v.id, users: [v.invited_by], objectType: 'vendor', objectId: v.id, dedupeKey: `NTF-24:appr:${v.id}`, severity: 'success' });
  } else if (outcome === 'Rejected') {
    applyRejection(actor, v, comment ?? 'Rejected by approver');
  } else {
    update('vendors', v.id, { onboarding_status: 'Under review' });
    audit(actor, { action: `vendor.onboarding_${outcome.toLowerCase()}`, objectType: 'vendor', objectId: v.id, objectRef: v.name, after: { onboarding_status: 'Under review' }, reason: comment });
  }
}

/** INT-M01 hook: SAP vendor master linked to an onboarded vendor, and change requests applied by SAP. */
export function onVendorSynced(rows: { id: number; isNew: boolean }[]) {
  for (const r of rows) {
    const v = getVendor(r.id);
    if (!v) continue;
    const o = ob(v);
    if (v.sap_code && v.onboarding && !o.sap_linked_at && (o.submitted_at || o.invite)) {
      o.sap_linked_at = now();
      saveOb(v.id, o, { onboarding_status: 'Active', portal_status: 'Active' });
      audit(null, { action: 'vendor.sap_code_linked', objectType: 'vendor', objectId: v.id, objectRef: v.name, before: { sap_code: null }, after: { sap_code: v.sap_code, onboarding_status: 'Active', portal_status: 'Active' }, channel: 'integration' });
      notify({ event: 'NTF-24', title: `Welcome — vendor code ${v.sap_code} is active`, body: 'Your SAP vendor code is linked. RFQs, purchase orders, invoices and payments are now open in the portal.', link: '/vendor', vendorId: v.id, objectType: 'vendor', objectId: v.id, dedupeKey: `NTF-24:active:${v.id}`, severity: 'success' });
      notify({ event: 'NTF-24', title: `${v.name} is active with SAP code ${v.sap_code}`, body: 'Approved capabilities are now used for RFQ suggestions.', link: `/vendors/${v.id}`, users: [v.invited_by, ...procurementUsers(v.id)], objectType: 'vendor', objectId: v.id, dedupeKey: `NTF-24:activei:${v.id}` });
    }
    for (const cr of all<{ id: number; field: string; new_value: string; status: string; applied_at: string | null; high_risk: number; requested_by: number }>(
      "SELECT * FROM vendor_change_requests WHERE vendor_id = ? AND (status = 'Sent to SAP' OR (status = 'Applied' AND applied_at IS NULL))", v.id,
    )) {
      const current = cr.field === 'bank_account' ? v.bank_account_masked : (v as unknown as Record<string, unknown>)[cr.field];
      const matches = cr.status === 'Applied' || (cr.field === 'bank_account' ? String(current ?? '').slice(-4) === cr.new_value.slice(-4) : String(current ?? '') === cr.new_value);
      if (!matches) continue;
      update('vendor_change_requests', cr.id, { status: 'Applied', applied_at: now(), decided_at: now() });
      audit(null, { action: cr.high_risk ? 'vendor.bank_change_applied' : 'vendor.change_applied', objectType: 'vendor_change', objectId: cr.id, objectRef: v.name, after: { field: cr.field, value_from_sap: current, status: 'Applied' }, channel: 'integration' });
      notify({ event: 'NTF-24', title: `${CHANGE_FIELDS[cr.field]?.label ?? cr.field} updated from SAP`, body: 'Your change request is applied — SAP now holds the new value.', link: '/vendor/profile', vendorId: v.id, objectType: 'vendor', objectId: v.id, dedupeKey: `NTF-24:cr:${cr.id}`, severity: 'success' });
    }
  }
}

// ------------------------------------------------------------------ change requests (FR-VPT-02, AC-VPT-04)
export function requestChange(actor: Actor, b: { field: string; new_value?: string | null; reason: string; bank?: { bank_name: string; bank_ifsc: string; account_no: string; account_confirm: string } | null; attachment_ids?: number[] }) {
  const vid = myVendorId(actor);
  const v = mustVendor(vid);
  if (v.onboarding_status !== 'Active') throw conflict('Change requests open once your vendor code is active. Until then, update the onboarding form.');
  const def = CHANGE_FIELDS[b.field];
  if (!def) throw badRequest('Choose what you want to change from the list.', { field: 'Unknown field' });
  const open = get("SELECT id FROM vendor_change_requests WHERE vendor_id = ? AND field = ? AND status IN ('Pending','Approved','Sent to SAP')", vid, b.field);
  if (open) throw conflict(`A change to ${def.label.toLowerCase()} is already in progress. Wait for it to finish or withdraw it.`);
  let newValue = (b.new_value ?? '').trim();
  let oldValue: string | null = (v as unknown as Record<string, string | null>)[b.field] ?? null;
  let details: Record<string, unknown> | null = null;
  if (b.field === 'bank_account') {
    if (!b.bank) throw badRequest('Enter the new bank details.', { bank: 'Required' });
    const ifsc = b.bank.bank_ifsc.trim().toUpperCase();
    const acc = b.bank.account_no.replace(/\s/g, '');
    const fields: Record<string, string> = {};
    if (!b.bank.bank_name.trim()) fields['bank.bank_name'] = 'Enter the bank name.';
    if (!IFSC_RE.test(ifsc)) fields['bank.bank_ifsc'] = 'IFSC is 11 characters: 4 letters, 0, then 6 letters or digits (e.g. HDFC0001234).';
    if (!/^\d{9,18}$/.test(acc)) fields['bank.account_no'] = 'Account number must be 9 to 18 digits.';
    else if (acc !== b.bank.account_confirm.replace(/\s/g, '')) fields['bank.account_confirm'] = 'The two account numbers do not match.';
    if (!b.attachment_ids?.length) fields.attachment_ids = 'Attach a cancelled cheque or bank letter for the new account.';
    if (Object.keys(fields).length) throw badRequest(Object.values(fields)[0], fields);
    if (v.bank_account_masked && v.bank_account_masked.slice(-4) === acc.slice(-4) && v.bank_ifsc === ifsc) throw badRequest('These are the bank details SAP already holds.');
    newValue = maskAccount(acc);
    oldValue = v.bank_account_masked;
    details = { bank_name: b.bank.bank_name.trim(), bank_ifsc: ifsc, bank_account_masked: newValue, account_last4: acc.slice(-4), old: { bank_name: v.bank_name, bank_ifsc: v.bank_ifsc, bank_account_masked: v.bank_account_masked } };
  } else {
    if (!newValue) throw badRequest('Enter the new value.', { new_value: 'Required' });
    if (b.field === 'state' && !GST_STATES[newValue]) throw badRequest('Choose a state from the list.', { new_value: 'Unknown state' });
    if (b.field === 'msme_no' && !UDYAM_RE.test(newValue.toUpperCase())) throw badRequest('Udyam number must look like UDYAM-MH-26-0071234.', { new_value: 'Format UDYAM-XX-00-0000000' });
    if (b.field === 'msme_category' && !MSME_CATEGORIES.includes(newValue)) throw badRequest('Choose Micro, Small or Medium.', { new_value: 'Invalid category' });
    if (b.field === 'contact_email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newValue)) throw badRequest('Enter a valid e-mail address.', { new_value: 'Invalid e-mail' });
    if (b.field === 'msme_no') newValue = newValue.toUpperCase();
    if (newValue === (oldValue ?? '')) throw badRequest('The new value is the same as the current one.');
  }
  const id = insert('vendor_change_requests', {
    vendor_id: vid, field: b.field, old_value: oldValue, new_value: newValue, reason: b.reason, status: 'Pending', requested_by: actor.id,
    high_risk: def.highRisk ? 1 : 0, details_json: details ? J(details) : null, created_at: now(),
  });
  if (b.attachment_ids?.length) linkAttachments(b.attachment_ids, 'vendor_change', id);
  audit(actor, {
    action: def.highRisk ? 'vendor.bank_change_requested' : 'vendor.change_requested', objectType: 'vendor_change', objectId: id, objectRef: v.name,
    before: { [b.field]: oldValue }, after: { [b.field]: newValue, ...(details ? { bank_name: details.bank_name, bank_ifsc: details.bank_ifsc, high_risk: true } : {}) }, reason: b.reason,
  });
  notify({
    event: 'NTF-24', title: `${v.name} requests a ${def.label.toLowerCase()} change`, body: def.highRisk ? 'High-risk change — finance verifies the document and sends it for approval.' : 'Procurement reviews the request.',
    link: `/vendors/${vid}?tab=changes`, roles: def.highRisk ? ['FIN'] : undefined, users: def.highRisk ? [] : procurementUsers(vid), objectType: 'vendor_change', objectId: id, severity: def.highRisk ? 'warning' : 'info',
  });
  return { id, status: 'Pending' };
}

export function withdrawChange(actor: Actor, crId: number) {
  myVendorId(actor);
  const cr = get<{ id: number; vendor_id: number; status: string; approval_id: number | null; field: string }>('SELECT * FROM vendor_change_requests WHERE id = ?', crId);
  if (!cr) throw notFound('Change request');
  assertVendorScope(actor, cr.vendor_id, 'vendor_change', crId);
  if (cr.status !== 'Pending') throw conflict('Only a pending request can be withdrawn. Once approved it is with the SAP team.');
  if (cr.approval_id) {
    const ap = get<{ status: string }>('SELECT status FROM approvals WHERE id = ?', cr.approval_id);
    if (ap && ['Pending', 'Clarification requested'].includes(ap.status)) throw conflict('Finance is approving this request; contact Equipcare finance to stop it.');
  }
  update('vendor_change_requests', crId, { status: 'Rejected', decision_note: 'Withdrawn by vendor', decided_at: now() });
  audit(actor, { action: 'vendor.change_withdrawn', objectType: 'vendor_change', objectId: crId, after: { status: 'Withdrawn' } });
  return { ok: true };
}

/** Finance verifies a bank change and sends it to the approval engine (maker-checker: a second finance user approves). */
export function sendBankChangeForApproval(actor: Actor, crId: number, note: string) {
  const cr = get<{ id: number; vendor_id: number; status: string; field: string; old_value: string | null; new_value: string; details: Record<string, unknown> | null; approval_id: number | null }>('SELECT * FROM vendor_change_requests WHERE id = ?', crId);
  if (!cr) throw notFound('Change request');
  if (cr.field !== 'bank_account') throw badRequest('Only bank changes go through finance approval.');
  if (cr.status !== 'Pending') throw conflict(`This request is ${cr.status.toLowerCase()}.`);
  const v = mustVendor(cr.vendor_id);
  const ap = createApproval(actor, {
    type: 'vendor.bank_change', objectType: 'vendor_change', objectId: crId, title: `Bank change — ${v.name}`,
    summary: `${cr.old_value ?? '—'} (${v.bank_ifsc ?? '—'}) → ${cr.new_value} (${String(cr.details?.bank_ifsc ?? '')}, ${String(cr.details?.bank_name ?? '')})`,
    reason: note, context: { vendor_id: v.id, high_risk: true, verified_by: actor.id },
  });
  update('vendor_change_requests', crId, { approval_id: ap.id });
  audit(actor, { action: 'vendor.bank_change_verified', objectType: 'vendor_change', objectId: crId, objectRef: v.name, after: { approval: ap.req_no, high_risk: true }, reason: note });
  return { approval_id: ap.id, req_no: ap.req_no };
}

function afterChangeApproved(actor: Actor | null, crId: number) {
  const cr = get<{ id: number; vendor_id: number; field: string; new_value: string; high_risk: number }>('SELECT * FROM vendor_change_requests WHERE id = ?', crId)!;
  const v = mustVendor(cr.vendor_id);
  const def = CHANGE_FIELDS[cr.field];
  if (def?.owner === 'platform') {
    // Contact details are platform-owned (not in the SAP vendor master): apply on approval.
    update('vendors', v.id, { [cr.field]: cr.new_value });
    update('vendor_change_requests', crId, { status: 'Applied', applied_at: now() });
    audit(actor, { action: 'vendor.change_applied', objectType: 'vendor_change', objectId: crId, objectRef: v.name, before: { [cr.field]: (v as unknown as Record<string, unknown>)[cr.field] }, after: { [cr.field]: cr.new_value } });
    notify({ event: 'NTF-24', title: `${def.label} updated`, body: 'Your change request was approved and applied.', link: '/vendor/profile', vendorId: v.id, objectType: 'vendor', objectId: v.id, dedupeKey: `NTF-24:cr:${crId}`, severity: 'success' });
    return;
  }
  update('vendor_change_requests', crId, { status: 'Sent to SAP', sent_to_sap_at: now() });
  audit(actor, { action: 'vendor.change_sent_to_sap', objectType: 'vendor_change', objectId: crId, objectRef: v.name, after: { field: cr.field, status: 'Sent to SAP' } });
  notify({ event: 'NTF-24', title: `Update SAP vendor ${v.sap_code}: ${def?.label ?? cr.field}`, body: 'Approved change request — apply it in SAP. The platform shows the new value after the next vendor sync.', link: `/vendors/${v.id}?tab=changes`, roles: ['SAP'], objectType: 'vendor_change', objectId: crId, dedupeKey: `NTF-24:sap-cr:${crId}`, severity: 'warning' });
  notify({ event: 'NTF-24', title: `${def?.label ?? cr.field} change approved`, body: 'Sent to the SAP team. Your profile shows the new value once SAP is updated.', link: '/vendor/profile', vendorId: v.id, objectType: 'vendor', objectId: v.id, dedupeKey: `NTF-24:cra:${crId}` });
}

/** Procurement decides non-bank change requests. */
export function decideChange(actor: Actor, crId: number, decision: 'Approved' | 'Rejected', note: string | null) {
  const cr = get<{ id: number; vendor_id: number; status: string; field: string }>('SELECT * FROM vendor_change_requests WHERE id = ?', crId);
  if (!cr) throw notFound('Change request');
  if (cr.field === 'bank_account') throw conflict('Bank changes are approved by finance through the approval workflow.');
  if (cr.status !== 'Pending') throw conflict(`This request is already ${cr.status.toLowerCase()}.`);
  if (decision === 'Rejected' && (!note || note.trim().length < 10)) throw badRequest('Give the vendor a reason of at least 10 characters.', { note: 'Reason is required' });
  const v = mustVendor(cr.vendor_id);
  update('vendor_change_requests', crId, { status: decision, decided_by: actor.id, decided_at: now(), decision_note: note });
  audit(actor, { action: decision === 'Approved' ? 'vendor.change_approved' : 'vendor.change_rejected', objectType: 'vendor_change', objectId: crId, objectRef: v.name, before: { status: 'Pending' }, after: { status: decision }, reason: note });
  if (decision === 'Approved') afterChangeApproved(actor, crId);
  else notify({ event: 'NTF-24', title: `${CHANGE_FIELDS[cr.field]?.label ?? cr.field} change not approved`, body: note ?? undefined, link: '/vendor/profile', vendorId: v.id, objectType: 'vendor', objectId: v.id, dedupeKey: `NTF-24:crr:${crId}`, severity: 'warning' });
  return { ok: true };
}

export function onBankChangeDecision(ap: ApprovalRow, outcome: string, actor: Actor | null, comment: string | null) {
  const cr = get<{ id: number; vendor_id: number; status: string }>('SELECT * FROM vendor_change_requests WHERE id = ?', ap.object_id);
  if (!cr || cr.status !== 'Pending') return;
  if (outcome === 'Approved') {
    update('vendor_change_requests', cr.id, { status: 'Approved', decided_by: actor?.id ?? null, decided_at: now(), decision_note: comment });
    audit(actor, { action: 'vendor.bank_change_approved', objectType: 'vendor_change', objectId: cr.id, before: { status: 'Pending' }, after: { status: 'Approved', high_risk: true }, reason: `Approved via ${ap.req_no}` });
    afterChangeApproved(actor, cr.id);
  } else if (outcome === 'Rejected') {
    update('vendor_change_requests', cr.id, { status: 'Rejected', decided_by: actor?.id ?? null, decided_at: now(), decision_note: comment });
    audit(actor, { action: 'vendor.bank_change_rejected', objectType: 'vendor_change', objectId: cr.id, after: { status: 'Rejected', high_risk: true }, reason: comment });
    notify({ event: 'NTF-24', title: 'Bank change not approved', body: 'Equipcare finance did not approve the new bank details. Contact finance or raise a ticket for details.', link: '/vendor/profile', vendorId: cr.vendor_id, objectType: 'vendor', objectId: cr.vendor_id, dedupeKey: `NTF-24:bankrej:${cr.id}`, severity: 'warning' });
  } else {
    // Returned / withdrawn: request stays pending with finance.
    update('vendor_change_requests', cr.id, { approval_id: null });
    audit(actor, { action: `vendor.bank_change_${outcome.toLowerCase()}`, objectType: 'vendor_change', objectId: cr.id, reason: comment });
  }
}

// ------------------------------------------------------------------ vendor profile (SCR-VPT-02)
export function myProfile(actor: Actor) {
  const vid = myVendorId(actor);
  const v = mustVendor(vid);
  const docs = documentsOf(vid);
  const me = get<{ vendor_role: string | null }>('SELECT vendor_role FROM users WHERE id = ?', actor.id);
  const isAdmin = me?.vendor_role === 'Vendor administrator';
  return {
    vendor: {
      id: v.id, name: v.name, legal_name: v.legal_name, sap_code: v.sap_code, address: v.address, city: v.city, state: v.state,
      gstin: v.gstin, pan: maskPan(v.pan), msme_no: v.msme_no, msme_category: v.msme_category, bank_name: v.bank_name, bank_ifsc: v.bank_ifsc,
      bank_account_masked: v.bank_account_masked, contact_name: v.contact_name, contact_email: v.contact_email, contact_phone: v.contact_phone,
      onboarding_status: v.onboarding_status, portal_status: v.portal_status, sap_blocked: v.sap_blocked, synced_at: v.synced_at,
      gstin_valid: v.gstin ? validateGstin(v.gstin).ok : false,
    },
    contacts: ob(v).contacts ?? [],
    kyc: kycState(v, docs),
    documents: docs.filter((d) => d.status !== 'Superseded' || true).map(({ reviewed_by: _r, ...d }) => d),
    mandatory_types: mandatoryDocTypes(v),
    document_types: cfg<string[]>('vendor.document_types'),
    capabilities: all("SELECT c.id, c.category, sc.name AS category_name, c.sub_category, c.supplier_role, c.brand, c.region, c.status, c.decision_note, c.created_at FROM vendor_capabilities c LEFT JOIN spend_categories sc ON sc.code = c.category WHERE c.vendor_id = ? ORDER BY c.status, c.category", vid),
    change_requests: all<Record<string, unknown> & { field: string }>(
      'SELECT id, field, old_value, new_value, reason, status, decision_note, high_risk, created_at, decided_at, applied_at FROM vendor_change_requests WHERE vendor_id = ? ORDER BY id DESC', vid,
    ).map((r) => ({ ...r, field_label: CHANGE_FIELDS[r.field]?.label ?? r.field })),
    change_fields: Object.entries(CHANGE_FIELDS).map(([key, d]) => ({ key, label: d.label, high_risk: !!d.highRisk, sap_owned: d.owner === 'sap' })),
    categories: all('SELECT code, name FROM spend_categories ORDER BY name'),
    states: Object.keys(GST_STATES).sort(),
    supplier_roles: SUPPLIER_ROLES,
    vendor_roles: cfg<string[]>('vendor.roles'),
    is_vendor_admin: isAdmin,
    users: isAdmin
      ? all('SELECT id, name, email, phone, vendor_role, active, locked, last_login, created_at FROM users WHERE vendor_id = ? ORDER BY active DESC, name', vid)
      : [],
    freshness: v.sap_code ? staleInfo('INT-M01', v.synced_at) : null,
  };
}

// ------------------------------------------------------------------ vendor home (SCR-VPT-01)
export function vendorHome(actor: Actor) {
  const vid = myVendorId(actor);
  const v = mustVendor(vid);
  if (v.onboarding_status !== 'Active') return { active: false, onboarding_status: v.onboarding_status, vendor: { id: v.id, name: v.name } };
  const t = today();
  const lead = cfg<number>('kyc.expiry_lead_days');
  const rfqs = all<{ id: number; rfq_no: string; title: string; closing_at: string; invitation_status: string }>(
    `SELECT r.id, r.rfq_no, r.title, r.closing_at, i.status AS invitation_status FROM rfq_invitations i JOIN rfqs r ON r.id = i.rfq_id
     WHERE i.vendor_id = ? AND r.status = 'Published' AND i.status IN ('Invited','Viewed') ORDER BY r.closing_at LIMIT 10`, vid,
  );
  const pos = all<{ id: number; po_no: string; po_date: string; plant: string; total_value: number; pending: number }>(
    `SELECT p.id, p.po_no, p.po_date, p.plant, p.total_value, COUNT(l.id) AS pending FROM pos p JOIN po_lines l ON l.po_id = p.id
     WHERE p.vendor_id = ? AND p.status NOT IN ('Cancelled','Closed') AND l.ack_status IN ('Pending','Pending re-acknowledgement')
     GROUP BY p.id ORDER BY p.po_date DESC LIMIT 10`, vid,
  );
  const asnDue = all<{ id: number; po_no: string; item: number; description: string; due: string; open_qty: number; uom: string }>(
    `SELECT p.id, p.po_no, l.item, l.description, COALESCE(l.commit_date, l.delivery_date) AS due, (COALESCE(l.accepted_qty, l.qty) - l.received_qty) AS open_qty, l.uom
     FROM po_lines l JOIN pos p ON p.id = l.po_id
     WHERE p.vendor_id = ? AND p.status NOT IN ('Cancelled','Closed') AND l.status = 'Published'
       AND l.ack_status IN ('Accepted','Partially accepted','Deemed accepted') AND COALESCE(l.commit_date, l.delivery_date) <= ?
     ORDER BY due LIMIT 10`, vid, plusDays(7),
  );
  const invoices = all<{ id: number; inv_ref: string; vendor_invoice_no: string | null; total_value: number | null; vendor_reason: string | null; updated_at: string | null }>(
    "SELECT id, inv_ref, vendor_invoice_no, total_value, vendor_reason, updated_at FROM invoices WHERE vendor_id = ? AND status = 'Exception' ORDER BY id DESC LIMIT 10", vid,
  );
  const payments = all<{ id: number; inv_ref: string; vendor_invoice_no: string | null; total_value: number | null; paid_at: string | null; payment_ref: string | null }>(
    "SELECT id, inv_ref, vendor_invoice_no, total_value, paid_at, payment_ref FROM invoices WHERE vendor_id = ? AND status = 'Payment released' ORDER BY paid_at DESC LIMIT 6", vid,
  );
  const disputes = all<{ id: number; dsp_no: string; type: string; status: string; po_no: string; due_at: string | null }>(
    `SELECT d.id, d.dsp_no, d.type, d.status, p.po_no, d.due_at FROM disputes d JOIN pos p ON p.id = d.po_id
     WHERE p.vendor_id = ? AND d.status IN ('Raised','Assigned','Awaiting response') AND d.owner_party = 'Vendor' ORDER BY d.created_at LIMIT 10`, vid,
  );
  const docs = all<{ id: number; doc_type: string; expiry_date: string; status: string }>(
    "SELECT id, doc_type, expiry_date, status FROM vendor_documents WHERE vendor_id = ? AND status IN ('Valid','Expired') AND expiry_date IS NOT NULL AND expiry_date <= ? ORDER BY expiry_date", vid, plusDays(lead),
  );
  const tickets = all<{ id: number; tkt_no: string; subject: string; status: string; updated_at: string }>(
    "SELECT id, tkt_no, subject, status, updated_at FROM tickets WHERE vendor_id = ? AND status IN ('Awaiting vendor','Resolved') ORDER BY updated_at DESC LIMIT 6", vid,
  );
  return {
    active: true,
    vendor: { id: v.id, name: v.name, sap_code: v.sap_code, sap_blocked: v.sap_blocked, performance_score: v.performance_score },
    today: t,
    rfqs, pos, asn_due: asnDue, invoices, payments, disputes, documents: docs, tickets,
  };
}

// ------------------------------------------------------------------ KYC expiry job (FR-VPT-12, NTF-25)
export function kycExpiryJob() {
  const lead = cfg<number>('kyc.expiry_lead_days');
  const t = today();
  let expired = 0;
  let reminded = 0;
  for (const d of all<{ id: number; vendor_id: number; doc_type: string; expiry_date: string; mandatory: number; vendor_name: string }>(
    "SELECT d.id, d.vendor_id, d.doc_type, d.expiry_date, d.mandatory, v.name AS vendor_name FROM vendor_documents d JOIN vendors v ON v.id = d.vendor_id WHERE d.status = 'Valid' AND d.expiry_date IS NOT NULL AND d.expiry_date < ?", t,
  )) {
    update('vendor_documents', d.id, { status: 'Expired' });
    expired++;
    audit(null, { action: 'vendor.document_expired', objectType: 'vendor', objectId: d.vendor_id, objectRef: d.vendor_name, before: { document_id: d.id, status: 'Valid' }, after: { document_id: d.id, doc_type: d.doc_type, status: 'Expired', mandatory: !!d.mandatory } });
    sendExpiryNotice(d, true);
  }
  // Documents already marked Expired that never got a notice (e.g. seeded or imported).
  for (const d of all<{ id: number; vendor_id: number; doc_type: string; expiry_date: string; mandatory: number; vendor_name: string }>(
    "SELECT d.id, d.vendor_id, d.doc_type, d.expiry_date, d.mandatory, v.name AS vendor_name FROM vendor_documents d JOIN vendors v ON v.id = d.vendor_id WHERE d.status = 'Expired' AND d.expiry_date IS NOT NULL",
  )) sendExpiryNotice(d, true);
  for (const d of all<{ id: number; vendor_id: number; doc_type: string; expiry_date: string; mandatory: number; vendor_name: string }>(
    "SELECT d.id, d.vendor_id, d.doc_type, d.expiry_date, d.mandatory, v.name AS vendor_name FROM vendor_documents d JOIN vendors v ON v.id = d.vendor_id WHERE d.status = 'Valid' AND d.expiry_date IS NOT NULL AND d.expiry_date >= ? AND d.expiry_date <= ?", t, plusDays(lead),
  )) if (sendExpiryNotice(d, false)) reminded++;
  return `expired ${expired}, reminders ${reminded} (lead ${lead} days)`;
}

/** One notice per document and expiry date, to the vendor and procurement (AC-VPT-03). Returns true if sent. */
function sendExpiryNotice(d: { id: number; vendor_id: number; doc_type: string; expiry_date: string; mandatory: number; vendor_name: string }, isExpired: boolean) {
  const key = `NTF-25:${isExpired ? 'expired' : 'expiring'}:${d.id}:${d.expiry_date}`;
  if (get('SELECT id FROM notifications WHERE dedupe_key = ? LIMIT 1', key)) return false;
  const days = Math.ceil((new Date(`${d.expiry_date}T00:00:00Z`).getTime() - new Date(`${today()}T00:00:00Z`).getTime()) / 86400000);
  const when = isExpired ? `expired on ${d.expiry_date}` : `expires on ${d.expiry_date} (in ${days} day${days === 1 ? '' : 's'})`;
  notify({
    event: 'NTF-25', title: `${d.doc_type} ${isExpired ? 'has expired' : 'is expiring'}`,
    body: `Your ${d.doc_type} ${when}. Upload the renewed document in Profile & documents.${isExpired && d.mandatory ? ' New RFQ invitations are paused until it is renewed.' : ''}`,
    link: '/vendor/profile', vendorId: d.vendor_id, objectType: 'vendor', objectId: d.vendor_id, dedupeKey: key, severity: isExpired ? 'danger' : 'warning',
  });
  const buyers = procurementUsers(d.vendor_id);
  notify({
    event: 'NTF-25', title: `${d.vendor_name}: ${d.doc_type} ${isExpired ? 'expired' : 'expiring'}`,
    body: `${d.doc_type} ${when}.${isExpired && d.mandatory ? ' Mandatory document — the vendor is excluded from RFQ suggestions until renewed.' : ''}`,
    link: `/vendors/${d.vendor_id}`, users: buyers, roles: buyers.length ? undefined : ['BUY'], objectType: 'vendor', objectId: d.vendor_id, dedupeKey: key, severity: isExpired ? 'danger' : 'warning',
  });
  return true;
}

// ------------------------------------------------------------------ tickets (FR-VPT-09, SCR-VPT-10, AC-VPT-05/06)
export interface TicketRow {
  id: number; tkt_no: string; vendor_id: number | null; raised_by: number | null; category: string; subject: string; status: string;
  assignee_role: string | null; assignee_id: number | null; priority: string; object_type: string | null; object_ref: string | null;
  sla_due: string | null; created_at: string; updated_at: string; resolved_at: string | null;
}
const TICKET_STATUSES = ['Open', 'In progress', 'Awaiting vendor', 'Resolved', 'Closed'];
const getTicket = (id: number) => get<TicketRow>('SELECT * FROM tickets WHERE id = ?', id);

function mustTicket(actor: Actor, id: number) {
  const t = getTicket(id);
  if (!t) throw notFound('Ticket');
  assertVendorScope(actor, t.vendor_id, 'ticket', id);
  return t;
}

export function createTicket(actor: Actor, b: { category: string; subject: string; body: string; priority: string; object_ref?: string | null; attachment_ids?: number[] }) {
  const vid = myVendorId(actor);
  const routing = cfg<Record<string, string>>('tickets.routing');
  const role = routing[b.category];
  if (!role) throw badRequest('Choose a ticket category from the list.', { category: 'Unknown category' });
  const sla = cfg<Record<string, number>>('tickets.sla_hours');
  if (!sla[b.priority]) throw badRequest('Choose a priority from the list.', { priority: 'Unknown priority' });
  const ts = now();
  const tktNo = nextNo('TKT');
  const id = tx(() => {
    const tid = insert('tickets', {
      tkt_no: tktNo, vendor_id: vid, raised_by: actor.id, category: b.category, subject: b.subject.trim(), status: 'Open', assignee_role: role,
      priority: b.priority, object_ref: b.object_ref?.trim() || null, sla_due: addHours(ts, sla[b.priority]), created_at: ts, updated_at: ts,
    });
    insert('ticket_messages', { ticket_id: tid, user_id: actor.id, body: b.body.trim(), internal: 0, created_at: ts });
    if (b.attachment_ids?.length) linkAttachments(b.attachment_ids, 'ticket', tid);
    audit(actor, { action: 'ticket.created', objectType: 'ticket', objectId: tid, objectRef: tktNo, after: { category: b.category, routed_to: role, priority: b.priority, sla_due: addHours(ts, sla[b.priority]) } });
    return tid;
  });
  const v = mustVendor(vid);
  notify({ event: 'NTF-26', title: `New vendor ticket ${tktNo}: ${b.subject.trim()}`, body: `${v.name} · ${b.category} · ${b.priority}`, link: `/tickets/${id}`, roles: [role as Role], objectType: 'ticket', objectId: id, severity: b.priority === 'Normal' ? 'info' : 'warning' });
  return { id, tkt_no: tktNo, routed_to: role };
}

export function listTickets(actor: Actor, q: { queue?: string; status?: string }) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (actor.role === 'VEN') { where.push('t.vendor_id = ?'); p.push(actor.vendorId ?? -1); }
  else if (q.queue === 'mine') { where.push('t.assignee_id = ?'); p.push(actor.id); }
  else if (q.queue === 'role') { where.push('t.assignee_role = ?'); p.push(actor.role); }
  if (q.status === 'open') where.push("t.status NOT IN ('Resolved','Closed')");
  else if (q.status) { where.push('t.status = ?'); p.push(q.status); }
  const internalFilter = actor.role === 'VEN' ? 'AND m.internal = 0' : '';
  return all<TicketRow & { vendor_name: string; raised_by_name: string; assignee_name: string | null; messages: number; last_message_at: string | null }>(
    `SELECT t.*, v.name AS vendor_name, v.sap_code, r.name AS raised_by_name, a.name AS assignee_name,
       (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id ${internalFilter}) AS messages,
       (SELECT MAX(m.created_at) FROM ticket_messages m WHERE m.ticket_id = t.id ${internalFilter}) AS last_message_at
     FROM tickets t LEFT JOIN vendors v ON v.id = t.vendor_id LEFT JOIN users r ON r.id = t.raised_by LEFT JOIN users a ON a.id = t.assignee_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.updated_at DESC`, ...p,
  ).map((t) => ({ ...t, sla_breached: !!t.sla_due && !['Resolved', 'Closed'].includes(t.status) && t.sla_due < now(), ...(actor.role === 'VEN' ? { assignee_name: null } : {}) }));
}

export function ticketDetail(actor: Actor, id: number) {
  const t = mustTicket(actor, id);
  const vendor = t.vendor_id ? get<{ id: number; name: string; sap_code: string | null }>('SELECT id, name, sap_code FROM vendors WHERE id = ?', t.vendor_id) : null;
  const messages = all<{ id: number; body: string; internal: number; created_at: string; user_id: number; user_name: string; from_vendor: number }>(
    `SELECT m.id, m.body, m.internal, m.created_at, m.user_id, u.name AS user_name, CASE WHEN u.vendor_id IS NOT NULL THEN 1 ELSE 0 END AS from_vendor
     FROM ticket_messages m JOIN users u ON u.id = m.user_id WHERE m.ticket_id = ? ${actor.role === 'VEN' ? 'AND m.internal = 0' : ''} ORDER BY m.id`, id,
  );
  const base = {
    ...t, vendor, messages, raised_by_name: userName(t.raised_by),
    sla_breached: !!t.sla_due && !['Resolved', 'Closed'].includes(t.status) && t.sla_due < now(),
  };
  if (actor.role === 'VEN') {
    // Vendors see the team, not internal routing details or names.
    return { ...base, assignee_id: null, assignee_name: null, team: teamLabel(t.assignee_role) };
  }
  const assignees = t.assignee_role
    ? all<{ id: number; name: string }>("SELECT id, name FROM users WHERE active = 1 AND vendor_id IS NULL AND (',' || roles || ',') LIKE ? ORDER BY name", `%,${t.assignee_role},%`)
    : [];
  return { ...base, assignee_name: userName(t.assignee_id), team: teamLabel(t.assignee_role), assignees, statuses: TICKET_STATUSES, routing: cfg<Record<string, string>>('tickets.routing') };
}

const TEAM: Record<string, string> = { ADM: 'Portal administration', BUY: 'Procurement', APR: 'Procurement management', FIN: 'Finance / accounts', STO: 'Stores', SAP: 'SAP / IT' };
const teamLabel = (role: string | null) => (role ? TEAM[role] ?? role : 'Unrouted');

export function replyTicket(actor: Actor, id: number, body: string, internalReq: boolean) {
  const t = mustTicket(actor, id);
  if (t.status === 'Closed') throw conflict('This ticket is closed. Raise a new ticket if you still need help.');
  const isVendor = actor.role === 'VEN';
  if (!isVendor && !actor.perms.has('tkt.handle')) throw forbidden();
  const internal = isVendor ? 0 : internalReq ? 1 : 0;
  const ts = now();
  insert('ticket_messages', { ticket_id: id, user_id: actor.id, body: body.trim(), internal, created_at: ts });
  const changes: Record<string, unknown> = { updated_at: ts };
  if (isVendor && ['Awaiting vendor', 'Resolved'].includes(t.status)) changes.status = 'In progress';
  if (!isVendor && !internal && t.status === 'Open') changes.status = 'In progress';
  if (!isVendor && !t.assignee_id) changes.assignee_id = actor.id;
  update('tickets', id, changes);
  audit(actor, { action: internal ? 'ticket.internal_note' : 'ticket.replied', objectType: 'ticket', objectId: id, objectRef: t.tkt_no, before: changes.status ? { status: t.status } : undefined, after: { internal: !!internal, ...(changes.status ? { status: changes.status } : {}) } });
  if (isVendor) {
    notify({ event: 'NTF-26', title: `Vendor replied on ${t.tkt_no}`, body: body.slice(0, 160), link: `/tickets/${id}`, users: t.assignee_id ? [t.assignee_id] : [], roles: t.assignee_id ? undefined : [t.assignee_role as Role], objectType: 'ticket', objectId: id, dedupeKey: `NTF-26:v:${id}:${ts}` });
  } else if (!internal) {
    notify({ event: 'NTF-26', title: `Update on ticket ${t.tkt_no}`, body: body.slice(0, 160), link: `/vendor/tickets/${id}`, vendorId: t.vendor_id, objectType: 'ticket', objectId: id, dedupeKey: `NTF-26:i:${id}:${ts}` });
  }
  return ticketDetail(actor, id);
}

export function setTicketStatus(actor: Actor, id: number, status: string, note: string | null) {
  const t = mustTicket(actor, id);
  if (!TICKET_STATUSES.includes(status)) throw badRequest('Choose a valid status.');
  if (t.status === status) throw badRequest(`The ticket is already ${status.toLowerCase()}.`);
  if (actor.role === 'VEN') {
    if (status !== 'Closed' || t.status !== 'Resolved') throw forbidden('You can close a ticket once Equipcare marks it resolved, or reply to reopen it.');
  } else if (t.status === 'Closed') throw conflict('Closed tickets cannot be changed. The vendor can raise a new ticket.');
  if (status === 'Resolved' && actor.role !== 'VEN' && (!note || note.trim().length < 10)) throw badRequest('Describe the resolution for the vendor (at least 10 characters).', { note: 'Resolution note is required' });
  const ts = now();
  update('tickets', id, { status, updated_at: ts, resolved_at: status === 'Resolved' ? ts : status === 'Closed' ? t.resolved_at ?? ts : null, assignee_id: actor.role !== 'VEN' && !t.assignee_id ? actor.id : undefined });
  if (note?.trim()) insert('ticket_messages', { ticket_id: id, user_id: actor.id, body: note.trim(), internal: 0, created_at: ts });
  audit(actor, { action: 'ticket.status_changed', objectType: 'ticket', objectId: id, objectRef: t.tkt_no, before: { status: t.status }, after: { status }, reason: note });
  if (actor.role !== 'VEN') {
    notify({ event: 'NTF-26', title: `Ticket ${t.tkt_no} is ${status.toLowerCase()}`, body: note?.slice(0, 160) ?? t.subject, link: `/vendor/tickets/${id}`, vendorId: t.vendor_id, objectType: 'ticket', objectId: id, dedupeKey: `NTF-26:s:${id}:${status}:${ts}`, severity: status === 'Resolved' ? 'success' : 'info' });
  }
  return ticketDetail(actor, id);
}

export function assignTicket(actor: Actor, id: number, userId: number | null) {
  const t = mustTicket(actor, id);
  if (t.status === 'Closed') throw conflict('Closed tickets cannot be reassigned.');
  const target = userId ?? actor.id;
  const u = get<{ id: number; name: string; roles: string; active: number; vendor_id: number | null }>('SELECT id, name, roles, active, vendor_id FROM users WHERE id = ?', target);
  if (!u || !u.active || u.vendor_id) throw badRequest('Choose an active Equipcare user.');
  if (t.assignee_role && !u.roles.split(',').includes(t.assignee_role)) throw badRequest(`${u.name} is not in the ${teamLabel(t.assignee_role)} team. Re-route the ticket first.`);
  update('tickets', id, { assignee_id: target, updated_at: now(), status: t.status === 'Open' ? 'In progress' : undefined });
  audit(actor, { action: 'ticket.assigned', objectType: 'ticket', objectId: id, objectRef: t.tkt_no, before: { assignee_id: t.assignee_id }, after: { assignee_id: target } });
  if (target !== actor.id) notify({ event: 'NTF-26', title: `Ticket ${t.tkt_no} assigned to you`, body: t.subject, link: `/tickets/${id}`, users: [target], objectType: 'ticket', objectId: id, dedupeKey: `NTF-26:a:${id}:${target}` });
  return ticketDetail(actor, id);
}

export function rerouteTicket(actor: Actor, id: number, role: string, reason: string) {
  const t = mustTicket(actor, id);
  if (t.status === 'Closed') throw conflict('Closed tickets cannot be re-routed.');
  if (!TEAM[role]) throw badRequest('Choose a team.');
  if (t.assignee_role === role) throw badRequest('The ticket is already with that team.');
  update('tickets', id, { assignee_role: role, assignee_id: null, updated_at: now() });
  insert('ticket_messages', { ticket_id: id, user_id: actor.id, body: `Re-routed from ${teamLabel(t.assignee_role)} to ${teamLabel(role)}: ${reason}`, internal: 1, created_at: now() });
  audit(actor, { action: 'ticket.rerouted', objectType: 'ticket', objectId: id, objectRef: t.tkt_no, before: { assignee_role: t.assignee_role }, after: { assignee_role: role }, reason });
  notify({ event: 'NTF-26', title: `Ticket ${t.tkt_no} routed to ${teamLabel(role)}`, body: t.subject, link: `/tickets/${id}`, roles: [role as Role], objectType: 'ticket', objectId: id, dedupeKey: `NTF-26:r:${id}:${role}` });
  return ticketDetail(actor, id);
}

// ------------------------------------------------------------------ demo helpers (seed)
/** A one-page PDF with a line of text — used for seeded KYC documents. */
export function tinyPdf(text: string) {
  const safe = text.replace(/[()\\]/g, '');
  const content = `BT /F1 16 Tf 72 760 Td (${safe}) Tj 0 -24 Td /F1 10 Tf (Demo document generated by the Equipcare S2P seed - fictional data) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function attachDemoPdf(vendorId: number, label: string, userId: number | null) {
  return storeGenerated(tinyPdf(label), `${label.replace(/[^\w]+/g, '-').toLowerCase()}.pdf`, 'application/pdf', { ownerType: 'vendor', ownerId: vendorId, label, actorId: userId });
}
