/**
 * Module 7 — PO publication, vendor acknowledgement, open-PO follow-up, reminders / escalation and
 * PO amendment / cancellation (PRD 7.7: FR-POM-01..11, WF-07, WF-13, FR-APR-07; RPT-04 / RPT-05 data).
 *
 * SAP is the system of record for the PO itself (header, items, quantities, prices, version). The
 * platform owns publication, acknowledgement, commitments, follow-ups, reminders, escalations and the
 * amendment request workflow. Amended / cancelled POs only change when SAP sends a new version.
 */
import { all, get, insert, update, run, J, now, addHours, daysBetween, tx, scalar, db, round2 } from '../../core/db.ts';
import { audit } from '../../core/audit.ts';
import { notify } from '../../core/notify.ts';
import { cfg } from '../../core/config.ts';
import { badRequest, conflict, forbidden, notFound, HttpError } from '../../core/http.ts';
import { createApproval, getApproval, withdraw as withdrawApproval, type ApprovalRow } from '../../core/approvals.ts';
import { sapWrite, staleInfo } from '../../core/sap.ts';
import { assertVendorScope, plantAllowed, type Actor } from '../../core/auth.ts';
import { permsFor, type Role } from '../../core/permissions.ts';
import { nextNo } from '../../core/numbering.ts';

// ------------------------------------------------------------------ vocabulary
export const PENDING_ACK = ['Pending', 'Pending re-acknowledgement'];
export const ACKED = ['Accepted', 'Partially accepted', 'Deemed accepted'];
const DONE_LINE = ['Received', 'Closed', 'Cancelled'];
export const OPEN_PO = ['Published', 'Partially received'];
export const FOLLOWUP_KINDS = ['Call', 'E-mail', 'Meeting / visit', 'Vendor update', 'Note'] as const;
export const AMEND_TYPES = ['Quantity', 'Price', 'Date', 'Terms', 'Cancel'] as const;
export type AmendType = (typeof AMEND_TYPES)[number];
const OPEN_AMD = ['Requested', 'Approved', 'Changed in SAP'];
const ASN_LIVE = ['Submitted', 'In transit', 'Delivered'];

export interface PoRow {
  id: number; po_no: string; vendor_id: number; buyer_id: number | null; plant: string; po_date: string; status: string;
  sap_released: number; version: number; urgency: string; delivery_terms: string | null; payment_terms: string | null;
  currency: string; total_value: number; contract_id: number | null; rfq_id: number | null; comparison_id: number | null;
  rfq_date: string | null; published_at: string | null; viewed_at: string | null; ack_due_at: string | null;
  deemed_accepted: number; sap_change_pending: number; freight_terms: string | null; synced_at: string | null; closed_at: string | null;
}
export interface PoLine {
  id: number; po_id: number; item: number; pr_line_id: number | null; material_id: number | null; description: string;
  qty: number; uom: string; unit_price: number; gst_rate: number; freight: number; delivery_date: string;
  ack_status: string; accepted_qty: number | null; commit_date: string | null; first_commit_date: string | null;
  ack_remarks: string | null; ack_at: string | null; received_qty: number; invoiced_qty: number; status: string;
  delay_reason: string | null; next_action_date: string | null; contract_item_id: number | null;
}
interface FollowupRow {
  id: number; po_id: number; po_line_id: number | null; user_id: number | null; kind: string; note: string | null;
  commit_date: string | null; delay_reason: string | null; next_action_date: string | null; created_at: string;
  meta: Record<string, any> | null;
}
interface AmdConf { user_id: number; name: string; role: string; at: string; on_behalf: boolean; note: string | null }
export interface AmdLineChange {
  line_id: number; item: number; description: string; uom: string;
  old: { qty: number; unit_price: number; delivery_date: string };
  new: { qty?: number; unit_price?: number; delivery_date?: string; deleted?: boolean };
}
export interface AmdChanges {
  lines: AmdLineChange[];
  terms?: { old: Record<string, string | null>; new: Record<string, string | null> };
  scope?: 'po' | 'lines';
  requires_confirmation: boolean;
  confirmation_reason?: string;
  confirmations: { stores?: AmdConf; vendor?: AmdConf };
  value_delta: number;
  forwarded_by?: { user_id: number; name: string; at: string };
  sap_request?: { at: string; by: number; by_name: string };
}
export interface AmendmentRow {
  id: number; amd_no: string; po_id: number; type: AmendType; changes: AmdChanges; reason: string; status: string;
  approval_id: number | null; requested_by: number; raised_by_vendor: number; created_at: string;
  sap_changed_at: string | null; reack_at: string | null;
}

// ------------------------------------------------------------------ schema additions (module-owned)
/** po_publications: one row per PO version published to the vendor; po_followups.meta_json: reminder/escalation details. */
export function ensureSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS po_publications (
    id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL, version INTEGER NOT NULL, kind TEXT, amendment_id INTEGER,
    published_at TEXT, recipients INTEGER DEFAULT 0, UNIQUE (po_id, version)
  )`);
  const cols = all<{ name: string }>('PRAGMA table_info(po_followups)');
  if (!cols.some((c) => c.name === 'meta_json')) db.exec('ALTER TABLE po_followups ADD COLUMN meta_json TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS ix_po_followups_po ON po_followups(po_id)');
}

// ------------------------------------------------------------------ helpers
const today = (at?: string) => (at ?? now()).slice(0, 10);
const isDate = (s?: string | null): s is string => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const fmtD = (d?: string | null) => (d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const lineRef = (po: Pick<PoRow, 'po_no'>, l: Pick<PoLine, 'item'>) => `${po.po_no}/${l.item}`;

export function getPo(id: number) {
  return get<PoRow>('SELECT * FROM pos WHERE id = ?', id);
}
export function getPoByNo(no: string) {
  return get<PoRow>('SELECT * FROM pos WHERE po_no = ?', no);
}
export function linesOf(poId: number) {
  return all<PoLine>('SELECT * FROM po_lines WHERE po_id = ? ORDER BY item', poId);
}
export function getAmendment(id: number) {
  return get<AmendmentRow>('SELECT * FROM po_amendments WHERE id = ?', id);
}
function getLine(id: number) {
  return get<PoLine>('SELECT * FROM po_lines WHERE id = ?', id);
}

/** Requisitioners whose PR lines are on this PO (FR-POM-11). */
function requisitionersOf(poId: number) {
  return all<{ id: number }>('SELECT DISTINCT pr.requisitioner_id AS id FROM po_lines l JOIN pr_lines pr ON pr.id = l.pr_line_id WHERE l.po_id = ? AND pr.requisitioner_id IS NOT NULL', poId).map((r) => r.id);
}

/** Read access to a PO: internal po.view (plant scope), requisitioner via own PR lines, vendor own POs only. */
export function canSeePo(actor: Actor, poId: number) {
  const po = getPo(poId);
  if (!po) return false;
  if (actor.role === 'VEN') return actor.vendorId === po.vendor_id && actor.perms.has('po.vendor');
  if (actor.perms.has('po.view')) return plantAllowed(actor, po.plant);
  if (actor.perms.has('po.view_own_pr')) return requisitionersOf(poId).includes(actor.id);
  return false;
}

/** Throws 404 (and audits cross-vendor attempts) unless the actor may read the PO. */
function mustSee(actor: Actor, poId: number) {
  const po = getPo(poId);
  if (!po) throw notFound('Purchase order');
  if (actor.role === 'VEN') {
    assertVendorScope(actor, po.vendor_id, 'po', poId);
    return po;
  }
  if (!canSeePo(actor, poId)) throw notFound('Purchase order');
  return po;
}

/** Builds an Actor for a stored user (used when the platform acts on a requester's behalf, e.g. chained approvals). */
function actorById(id: number): Actor | null {
  const u = get<{ id: number; name: string; email: string; roles: string; vendor_id: number | null; plant_scope: string | null; categories: string | null; department: string | null }>('SELECT * FROM users WHERE id = ?', id);
  if (!u) return null;
  const roles = u.roles.split(',') as Role[];
  const role = (roles.includes('BUY') ? 'BUY' : roles[0]) as Role;
  return {
    id: u.id, name: u.name, email: u.email, roles, role, perms: permsFor(role), vendorId: role === 'VEN' ? u.vendor_id : null,
    plants: !u.plant_scope || u.plant_scope === '*' ? '*' : u.plant_scope.split(','), categories: u.categories ? u.categories.split(',') : [],
    department: u.department, sessionId: 'system', channel: 'system',
  };
}

function addFollowup(poId: number, lineId: number | null, userId: number | null, kind: string, note: string, extra: { commit_date?: string | null; delay_reason?: string | null; next_action_date?: string | null; meta?: Record<string, unknown>; at?: string } = {}) {
  return insert('po_followups', {
    po_id: poId, po_line_id: lineId, user_id: userId, kind, note, commit_date: extra.commit_date ?? null, delay_reason: extra.delay_reason ?? null,
    next_action_date: extra.next_action_date ?? null, meta_json: extra.meta ? J(extra.meta) : null, created_at: extra.at ?? now(),
  });
}

function followupsOf(poId: number) {
  return all<FollowupRow>('SELECT * FROM po_followups WHERE po_id = ? ORDER BY created_at, id', poId);
}

/** Start of the current publication cycle (latest version published). Reminders and escalations count from here (WF-13 reset). */
export function cycleStart(po: PoRow) {
  return scalar<string>('SELECT published_at FROM po_publications WHERE po_id = ? ORDER BY version DESC LIMIT 1', po.id) ?? po.published_at ?? po.synced_at ?? now();
}

export function escalationLevel(po: PoRow, fus = followupsOf(po.id)) {
  const cs = cycleStart(po);
  return fus.filter((f) => f.kind === 'Escalation' && f.created_at >= cs).reduce((m, f) => Math.max(m, Number(f.meta?.level ?? 0)), 0);
}

const reminderCfg = () => cfg<{ ack_after_hours: number; dispatch_days_before: number; overdue_days_after: number }>('po.reminders');

/** Whether the vendor has submitted an ASN for this PO (In dispatch). */
function hasLiveAsn(poId: number) {
  return (scalar<number>(`SELECT COUNT(*) FROM asns WHERE po_id = ? AND status IN (${ASN_LIVE.map(() => '?').join(',')})`, poId, ...ASN_LIVE) ?? 0) > 0;
}

// ------------------------------------------------------------------ line state (FR-POM-06, RPT-04)
export interface LineState {
  open_qty: number;
  commitment: string;
  overdue: boolean;
  overdue_days: number;
  ack_overdue: boolean;
  dispatch_due: boolean;
  active: boolean;
  next_action: string;
  needs_action: boolean;
}

export function lineState(l: PoLine, po: Pick<PoRow, 'status' | 'ack_due_at' | 'sap_change_pending'>, opts: { asn?: boolean; buyerTouchedAfterAck?: boolean; amendmentStatus?: string | null } = {}): LineState {
  const t = today();
  const rem = reminderCfg();
  const active = OPEN_PO.includes(po.status) && !DONE_LINE.includes(l.status) && !['Rejected', 'Cancelled'].includes(l.ack_status);
  const commitment = l.commit_date ?? l.delivery_date;
  const committedQty = l.ack_status === 'Rejected' ? 0 : l.accepted_qty ?? l.qty;
  const open_qty = Math.max(0, round2(committedQty - (l.received_qty ?? 0)));
  const pending = PENDING_ACK.includes(l.ack_status);
  const overdue = active && !pending && open_qty > 0 && commitment < t;
  const overdue_days = overdue ? daysBetween(commitment, t) : 0;
  const ack_overdue = active && pending && !!po.ack_due_at && po.ack_due_at < now();
  const daysToCommit = daysBetween(t, commitment);
  const dispatch_due = active && ACKED.includes(l.ack_status) && open_qty > 0 && !overdue && daysToCommit <= rem.dispatch_days_before && !opts.asn;
  const followDue = !!l.next_action_date && l.next_action_date <= t && active;
  let next = 'None';
  let needs = false;
  if (OPEN_PO.includes(po.status) && opts.amendmentStatus === 'Approved') { next = 'Apply the approved amendment in SAP'; needs = true; }
  else if (OPEN_PO.includes(po.status) && opts.amendmentStatus === 'Requested') next = 'Amendment awaiting approval';
  if (!active) {
    if (l.ack_status === 'Rejected' && OPEN_PO.includes(po.status)) { next = 'Re-source or amend the rejected line'; needs = true; }
    else if (next === 'None') next = l.status === 'Received' ? 'None — received' : 'None';
  } else if (next === 'None' || next === 'Amendment awaiting approval') {
    if (pending) { next = ack_overdue ? 'Chase acknowledgement — overdue' : `Vendor to acknowledge by ${fmtD(po.ack_due_at)}`; needs = ack_overdue; }
    else if (overdue) { next = `Chase delivery — ${overdue_days} d past commitment`; needs = true; }
    else if (l.ack_status === 'Partially accepted' && !opts.buyerTouchedAfterAck) { next = `Arrange balance ${round2(l.qty - (l.accepted_qty ?? 0))} ${l.uom} (amend or re-source)`; needs = true; }
    else if (followDue) { next = `Follow up today (${fmtD(l.next_action_date)})`; needs = true; }
    else if (dispatch_due) next = `Vendor to dispatch by ${fmtD(commitment)}`;
    else if (l.next_action_date) next = `Follow up on ${fmtD(l.next_action_date)}`;
    else if (opts.asn) next = 'In dispatch — awaiting receipt';
    else next = (l.received_qty ?? 0) > 0 ? 'Awaiting balance delivery' : 'Awaiting dispatch';
  }
  if (followDue) needs = true;
  return { open_qty, commitment, overdue, overdue_days, ack_overdue, dispatch_due, active, next_action: next, needs_action: needs };
}

// ------------------------------------------------------------------ INT-M08 acknowledgement write (FR-POM-10, DEC-25)
function writeAckToSap(actor: Actor | null, po: PoRow, l: PoLine, payload: Record<string, unknown>) {
  if (!cfg<boolean>('sap.write.ack')) return null;
  const n = (scalar<number>("SELECT COUNT(*) FROM sap_outbound WHERE flow = 'INT-M08' AND idempotency_key LIKE ?", `POACK:${po.po_no}:${l.item}:%`) ?? 0) + 1;
  const key = `POACK:${po.po_no}:${l.item}:${n}`;
  const r = sapWrite('INT-M08', 'POACK', key, { po_no: po.po_no, item: l.item, version: po.version, ...payload }, actor);
  return { key, status: r.status, message: r.message };
}

/** Current INT-M08 status for a line: the real outbound status of the latest write, or null when DEC-25 keeps the platform as record. */
function sapAckStatus(po: PoRow, l: PoLine) {
  const row = get<{ idempotency_key: string; status: string; attempts: number; completed_at: string | null; created_at: string }>(
    "SELECT idempotency_key, status, attempts, completed_at, created_at FROM sap_outbound WHERE flow = 'INT-M08' AND idempotency_key LIKE ? ORDER BY id DESC LIMIT 1",
    `POACK:${po.po_no}:${l.item}:%`,
  );
  if (!row) return null;
  const err = get<{ error: string; status: string }>("SELECT error, status FROM integration_errors WHERE idempotency_key = ? ORDER BY id DESC LIMIT 1", row.idempotency_key);
  return { key: row.idempotency_key, status: row.status === 'Pending' ? 'Queued' : row.status, attempts: row.attempts, at: row.completed_at ?? row.created_at, error: row.status === 'Written' ? null : err?.error ?? null };
}

// ------------------------------------------------------------------ publication (FR-POM-01, NTF-16 / NTF-20)
function vendorRecipients(vendorId: number) {
  return scalar<number>('SELECT COUNT(*) FROM users WHERE vendor_id = ? AND active = 1', vendorId) ?? 0;
}

function publishNew(po: PoRow) {
  const ts = po.published_at ?? now();
  const rem = reminderCfg();
  const due = addHours(ts, rem.ack_after_hours);
  run('INSERT OR IGNORE INTO po_publications (po_id, version, kind, published_at, recipients) VALUES (?,?,?,?,?)', po.id, po.version, 'Published', ts, vendorRecipients(po.vendor_id));
  update('pos', po.id, { ack_due_at: due, published_at: ts });
  const lines = linesOf(po.id);
  notify({
    event: 'NTF-16', title: `New purchase order ${po.po_no}`,
    body: `${lines.length} line${lines.length === 1 ? '' : 's'} for ${po.plant}. Acknowledge each line with your delivery commitment by ${fmtD(due)}.`,
    link: `/vendor/pos/${po.id}`, vendorId: po.vendor_id, objectType: 'po', objectId: po.id, dedupeKey: `NTF-16:${po.id}:v${po.version}`,
  });
  audit(null, { action: 'po.published', objectType: 'po', objectId: po.id, objectRef: po.po_no, after: { version: po.version, ack_due_at: due, vendor_users: vendorRecipients(po.vendor_id) } });
}

/** A new SAP version of an existing PO arrived: close the SAP step of the amendment and republish (WF-13). */
function republish(po: PoRow, payload: any) {
  const ts = now();
  const amd = (payload?.amendment_id ? get<AmendmentRow>("SELECT * FROM po_amendments WHERE id = ? AND po_id = ? AND status IN ('Approved','Changed in SAP')", Number(payload.amendment_id), po.id) : undefined)
    ?? get<AmendmentRow>("SELECT * FROM po_amendments WHERE po_id = ? AND status IN ('Approved','Changed in SAP') ORDER BY id LIMIT 1", po.id);
  if (amd) {
    update('po_amendments', amd.id, { status: 'Changed in SAP', sap_changed_at: ts });
    audit(null, { action: 'po.amendment_changed_in_sap', objectType: 'po', objectId: po.id, objectRef: `${po.po_no} ${amd.amd_no}`, before: { status: amd.status }, after: { status: 'Changed in SAP', version: po.version } });
  }
  const cancelled = po.status === 'Cancelled';
  if (cancelled) run("UPDATE po_lines SET ack_status = 'Cancelled' WHERE po_id = ? AND status NOT IN ('Received','Closed')", po.id);
  if (amd?.type === 'Terms' && !cancelled) {
    run("UPDATE po_lines SET ack_status = 'Pending re-acknowledgement' WHERE po_id = ? AND status NOT IN ('Received','Closed','Cancelled') AND ack_status NOT IN ('Rejected','Cancelled')", po.id);
  }
  run('INSERT OR IGNORE INTO po_publications (po_id, version, kind, amendment_id, published_at, recipients) VALUES (?,?,?,?,?,?)', po.id, po.version, cancelled ? 'Cancelled' : 'Republished', amd?.id ?? null, ts, vendorRecipients(po.vendor_id));
  const rem = reminderCfg();
  const due = addHours(ts, rem.ack_after_hours);
  // Commitments and reminders reset for the new version (WF-13): new ack due date, deemed flag cleared.
  update('pos', po.id, { ack_due_at: due, deemed_accepted: 0 });
  const reack = linesOf(po.id).filter((l) => l.ack_status === 'Pending re-acknowledgement');
  addFollowup(po.id, null, null, 'System', cancelled ? `PO cancelled in SAP (version ${po.version}) and republished to the vendor.` : `PO version ${po.version} synchronised from SAP and republished${reack.length ? ` — ${reack.length} line(s) need re-acknowledgement` : ''}.`, { meta: { type: 'republished', version: po.version, amendment_id: amd?.id ?? null } });
  notify({
    event: 'NTF-20',
    title: cancelled ? `PO ${po.po_no} cancelled` : `PO ${po.po_no} amended — version ${po.version}`,
    body: cancelled
      ? 'Equipcare has cancelled this purchase order in SAP. Open it to confirm you have received the cancellation.'
      : reack.length ? `Status: ${reack.length} changed line(s) need your re-acknowledgement by ${fmtD(due)}.` : 'Status: updated terms published. No re-acknowledgement is needed.',
    link: `/vendor/pos/${po.id}`, vendorId: po.vendor_id, objectType: 'po', objectId: po.id, dedupeKey: `NTF-20:${po.id}:v${po.version}`, severity: 'warning',
  });
  if (amd) {
    let status = 'Republished';
    if (!cancelled && reack.length === 0) status = 'Re-acknowledged';
    update('po_amendments', amd.id, { status, ...(status === 'Re-acknowledged' ? { reack_at: ts } : {}) });
    audit(null, { action: 'po.amendment_republished', objectType: 'po', objectId: po.id, objectRef: `${po.po_no} ${amd.amd_no}`, before: { status: 'Changed in SAP' }, after: { status, version: po.version, reack_lines: reack.map((l) => l.item) } });
    notify({ event: 'NTF-20', title: `${amd.amd_no}: PO ${po.po_no} version ${po.version} is in SAP`, body: cancelled ? 'Cancellation republished to the vendor.' : `Republished to the vendor${reack.length ? '; waiting for re-acknowledgement' : ''}.`, link: `/pos/${po.id}`, users: [amd.requested_by, po.buyer_id], objectType: 'po', objectId: po.id, dedupeKey: `NTF-20b:${amd.id}:v${po.version}` });
  } else {
    audit(null, { action: 'po.republished', objectType: 'po', objectId: po.id, objectRef: po.po_no, after: { version: po.version, note: 'New SAP version without a platform amendment request' } });
  }
  if (cancelled || amd?.type === 'Date') {
    notify({ event: 'NTF-20', title: cancelled ? `PO ${po.po_no} for your requirement was cancelled` : `Delivery date changed on PO ${po.po_no}`, body: 'Open the PO for details.', link: `/pos/${po.id}`, users: requisitionersOf(po.id), objectType: 'po', objectId: po.id, dedupeKey: `NTF-20r:${po.id}:v${po.version}` });
  }
}

/** INT-M07 sync hook: notify the vendor for new POs (NTF-16) and amended versions (NTF-20). */
export function onPoSynced(rows: { id: number; isNew: boolean; payload: any }[]) {
  for (const r of rows) {
    if (!r.isNew) continue;
    const po = getPo(r.id);
    if (!po || !po.sap_released) continue;
    const last = get<{ version: number }>('SELECT version FROM po_publications WHERE po_id = ? ORDER BY version DESC LIMIT 1', po.id);
    if (!last) publishNew(po);
    else if (po.version > last.version) republish(po, r.payload);
  }
}

// ------------------------------------------------------------------ vendor view (FR-VPT-04)
export function markViewed(actor: Actor, poId: number) {
  const po = getPo(poId);
  if (!po || po.viewed_at || actor.role !== 'VEN') return;
  const ts = now();
  update('pos', poId, { viewed_at: ts });
  audit(actor, { action: 'po.viewed', objectType: 'po', objectId: poId, objectRef: po.po_no, after: { viewed_at: ts } });
}

// ------------------------------------------------------------------ acknowledgement (FR-POM-02, AC-POM-02)
export interface AckInput {
  line_id: number;
  decision: 'accept' | 'partial' | 'reject';
  accepted_qty?: number | null;
  commit_date?: string | null;
  reason?: string | null;
  remarks?: string | null;
}

export function acknowledge(actor: Actor, poId: number, input: AckInput[], opts: { onBehalf?: string; at?: string; allowClosed?: boolean } = {}) {
  const po = mustSee(actor, poId);
  const internal = actor.role !== 'VEN';
  if (internal) {
    if (!actor.perms.has('po.followup')) throw forbidden('Only the buyer can record an acknowledgement on the vendor\'s behalf.');
    if (!opts.onBehalf || opts.onBehalf.trim().length < 10) throw badRequest('Say how the vendor acknowledged (for example "E-mail from Arindam Bose, 14 Oct"). At least 10 characters.', { source: 'Source is required' });
  }
  if (!OPEN_PO.includes(po.status) && !opts.allowClosed) throw conflict(`PO ${po.po_no} is ${po.status.toLowerCase()}; it can no longer be acknowledged.`);
  if (!input.length) throw badRequest('Choose a decision for at least one line.');
  const ts = opts.at ?? now();
  const t = today(ts);
  const fields: Record<string, string> = {};
  const lines = input.map((x, i) => {
    const l = getLine(x.line_id);
    if (!l || l.po_id !== poId) throw badRequest(`Line ${i + 1} does not belong to PO ${po.po_no}.`);
    const k = `lines.${i}`;
    if (!PENDING_ACK.includes(l.ack_status)) fields[`${k}.decision`] = `Line ${l.item} is already ${l.ack_status.toLowerCase()}. Use "Update commitment" to change the date.`;
    const reason = x.reason?.trim() ?? '';
    if (x.decision !== 'reject') {
      if (!isDate(x.commit_date)) fields[`${k}.commit_date`] = `Line ${l.item}: enter the delivery commitment date.`;
      else if (x.commit_date < t) fields[`${k}.commit_date`] = `Line ${l.item}: the commitment date cannot be in the past.`;
    }
    if (x.decision === 'partial') {
      const q = Number(x.accepted_qty);
      if (!Number.isFinite(q) || q <= 0 || q >= l.qty) fields[`${k}.accepted_qty`] = `Line ${l.item}: accepted quantity must be more than 0 and less than the ordered ${l.qty} ${l.uom}.`;
      if (reason.length < 10) fields[`${k}.reason`] = `Line ${l.item}: say why only part of the quantity is accepted (at least 10 characters).`;
    }
    if (x.decision === 'reject' && reason.length < 10) fields[`${k}.reason`] = `Line ${l.item}: a rejection needs a reason of at least 10 characters.`;
    if ((x.remarks?.length ?? 0) > 500) fields[`${k}.remarks`] = 'Deviation remarks must be 500 characters or fewer.';
    return { l, x, reason };
  });
  if (Object.keys(fields).length) throw badRequest(Object.values(fields)[0], fields);

  return tx(() => {
    const results: { line_id: number; item: number; ack_status: string; sap: { key: string; status: string; message: string } | null }[] = [];
    for (const { l, x, reason } of lines) {
      const ack_status = x.decision === 'accept' ? 'Accepted' : x.decision === 'partial' ? 'Partially accepted' : 'Rejected';
      const accepted_qty = x.decision === 'accept' ? l.qty : x.decision === 'partial' ? Number(x.accepted_qty) : 0;
      const commit = x.decision === 'reject' ? null : x.commit_date!;
      const remarks = x.remarks?.trim() || null;
      const ack_remarks = [reason || null, remarks ? (reason ? `Deviation: ${remarks}` : remarks) : null].filter(Boolean).join(' · ') || null;
      const reack = l.ack_status === 'Pending re-acknowledgement';
      const after = { ack_status, accepted_qty, commit_date: commit, first_commit_date: l.first_commit_date ?? commit, ack_remarks, ack_at: ts, ...(reack ? { delay_reason: null } : {}) };
      update('po_lines', l.id, after);
      const sap = writeAckToSap(actor, po, l, { ack_status, accepted_qty, commit_date: commit, remarks: ack_remarks });
      const verb = ack_status === 'Accepted' ? `Accepted ${l.qty} ${l.uom}` : ack_status === 'Partially accepted' ? `Partially accepted ${accepted_qty} of ${l.qty} ${l.uom}` : 'Rejected';
      addFollowup(po.id, l.id, actor.id, 'Vendor update',
        `Line ${l.item}: ${reack ? 'Re-acknowledged — ' : ''}${verb}${commit ? `, commitment ${fmtD(commit)}` : ''}${reason ? `. Reason: ${reason}` : ''}${remarks && reason ? `. Deviation: ${remarks}` : remarks ? `. ${remarks}` : ''}${internal ? ` (recorded by ${actor.name}: ${opts.onBehalf})` : ''}`,
        { commit_date: commit, at: ts, meta: { type: 'ack', decision: x.decision, reack, accepted_qty, reason: reason || null, remarks, on_behalf: internal ? opts.onBehalf : null, sap } });
      audit(actor, { action: reack ? 'po.line_reacknowledged' : 'po.line_acknowledged', objectType: 'po', objectId: po.id, objectRef: lineRef(po, l), before: { ack_status: l.ack_status, accepted_qty: l.accepted_qty, commit_date: l.commit_date }, after: { ack_status, accepted_qty, commit_date: commit, on_behalf: internal ? opts.onBehalf : undefined, sap_write: sap?.status ?? 'Not written (DEC-25)' }, reason: reason || null });
      if (ack_status !== 'Accepted') {
        notify({
          event: 'NTF-19', title: ack_status === 'Rejected' ? `Vendor rejected line ${lineRef(po, l)}` : `Vendor partially accepted ${lineRef(po, l)} (${accepted_qty}/${l.qty})`,
          body: `${l.description}. Reason: ${reason}`, link: `/pos/${po.id}`, users: [po.buyer_id], objectType: 'po', objectId: po.id,
          severity: ack_status === 'Rejected' ? 'danger' : 'warning', dedupeKey: `ack:${l.id}:${ts}`,
        });
      }
      results.push({ line_id: l.id, item: l.item, ack_status, sap });
    }
    if (!po.viewed_at && actor.role === 'VEN') update('pos', po.id, { viewed_at: ts });
    completeReack(po.id, actor, ts);
    return { po_id: po.id, po_no: po.po_no, results, sap_mode: cfg<boolean>('sap.write.ack') ? 'write' : 'platform' };
  });
}

/** Amendment Republished → Re-acknowledged once no changed line is waiting for the vendor (WF-13). */
function completeReack(poId: number, actor: Actor | null, ts = now()) {
  const amd = get<AmendmentRow>("SELECT * FROM po_amendments WHERE po_id = ? AND status = 'Republished' AND type != 'Cancel' ORDER BY id DESC LIMIT 1", poId);
  if (!amd) return;
  const waiting = scalar<number>("SELECT COUNT(*) FROM po_lines WHERE po_id = ? AND ack_status = 'Pending re-acknowledgement'", poId) ?? 0;
  if (waiting) return;
  const po = getPo(poId)!;
  update('po_amendments', amd.id, { status: 'Re-acknowledged', reack_at: ts });
  audit(actor, { action: 'po.amendment_reacknowledged', objectType: 'po', objectId: poId, objectRef: `${po.po_no} ${amd.amd_no}`, before: { status: 'Republished' }, after: { status: 'Re-acknowledged' } });
  notify({ event: 'NTF-20', title: `${amd.amd_no}: vendor re-acknowledged PO ${po.po_no}`, body: `Version ${po.version} is acknowledged.`, link: `/pos/${poId}`, users: [amd.requested_by, po.buyer_id], objectType: 'po', objectId: poId, dedupeKey: `NTF-20ra:${amd.id}`, severity: 'success' });
}

// ------------------------------------------------------------------ commitment changes (FR-POM-06, AC-POM-06)
export interface CommitInput { commit_date: string; delay_reason: string; note?: string | null }

function applyCommitment(actor: Actor, po: PoRow, l: PoLine, input: CommitInput, opts: { kind: string; at?: string; nextAction?: string | null; extraNote?: string | null }) {
  const ts = opts.at ?? now();
  const reasons = cfg<string[]>('po.delay_reasons');
  const fields: Record<string, string> = {};
  if (!ACKED.includes(l.ack_status)) throw conflict(`Line ${l.item} is ${l.ack_status.toLowerCase()}. Acknowledge the line before changing its commitment.`);
  if (!isDate(input.commit_date)) fields.commit_date = 'Enter the new commitment date.';
  else if (input.commit_date < today(ts)) fields.commit_date = 'The new commitment date cannot be in the past.';
  else if (input.commit_date === (l.commit_date ?? null)) fields.commit_date = `${fmtD(input.commit_date)} is already the commitment date.`;
  if (!input.delay_reason || !reasons.includes(input.delay_reason)) fields.delay_reason = 'Choose a delay reason from the list — a commitment change after acknowledgement needs one.';
  if (input.delay_reason === 'Other' && (input.note?.trim().length ?? 0) < 10) fields.note = 'Describe the reason (at least 10 characters) when you choose "Other".';
  if (Object.keys(fields).length) throw badRequest(Object.values(fields)[0], fields);
  const old = l.commit_date ?? l.delivery_date;
  update('po_lines', l.id, { commit_date: input.commit_date, first_commit_date: l.first_commit_date ?? l.commit_date ?? input.commit_date, delay_reason: input.delay_reason, ...(opts.nextAction !== undefined ? { next_action_date: opts.nextAction } : {}) });
  const sap = writeAckToSap(actor, po, l, { ack_status: l.ack_status, accepted_qty: l.accepted_qty, commit_date: input.commit_date, delay_reason: input.delay_reason });
  const note = `Line ${l.item}: commitment ${fmtD(old)} → ${fmtD(input.commit_date)} (${input.delay_reason})${input.note?.trim() ? `. ${input.note.trim()}` : ''}${opts.extraNote ? `. ${opts.extraNote}` : ''}`;
  addFollowup(po.id, l.id, actor.id, opts.kind, note, { commit_date: input.commit_date, delay_reason: input.delay_reason, next_action_date: opts.nextAction ?? null, at: ts, meta: { type: 'commitment', old, new: input.commit_date, by_vendor: actor.role === 'VEN', sap } });
  audit(actor, { action: 'po.commitment_changed', objectType: 'po', objectId: po.id, objectRef: lineRef(po, l), before: { commit_date: l.commit_date, delay_reason: l.delay_reason }, after: { commit_date: input.commit_date, delay_reason: input.delay_reason, sap_write: sap?.status ?? 'Not written (DEC-25)' }, reason: input.note ?? input.delay_reason });
  const later = input.commit_date > old;
  if (actor.role === 'VEN') notify({ event: 'NTF-19', title: `Commitment revised for ${lineRef(po, l)}`, body: `${fmtD(old)} → ${fmtD(input.commit_date)} · ${input.delay_reason}`, link: `/pos/${po.id}`, users: [po.buyer_id], objectType: 'po', objectId: po.id, severity: later ? 'warning' : 'info', dedupeKey: `commit:${l.id}:${input.commit_date}` });
  if (later) notify({ event: 'NTF-19', title: `Delivery for your requirement moved to ${fmtD(input.commit_date)}`, body: `${l.description} on PO ${po.po_no}: ${input.delay_reason}.`, link: `/pos/${po.id}`, users: requisitionersOf(po.id), objectType: 'po', objectId: po.id, dedupeKey: `commit-r:${l.id}:${input.commit_date}` });
  return { sap };
}

export function updateCommitment(actor: Actor, lineId: number, input: CommitInput, opts: { at?: string } = {}) {
  const l = getLine(lineId);
  if (!l) throw notFound('PO line');
  const po = mustSee(actor, l.po_id);
  if (actor.role !== 'VEN' && !actor.perms.has('po.followup')) throw forbidden();
  if (!OPEN_PO.includes(po.status)) throw conflict(`PO ${po.po_no} is ${po.status.toLowerCase()}.`);
  if (DONE_LINE.includes(l.status)) throw conflict(`Line ${l.item} is ${l.status.toLowerCase()}; no commitment change is needed.`);
  return tx(() => ({ ...applyCommitment(actor, po, l, input, { kind: 'Vendor update', at: opts.at }), line: getLine(lineId) }));
}

// ------------------------------------------------------------------ buyer follow-up log (FR-POM-06, AC-POM-06)
export interface FollowupInput {
  po_line_id?: number | null;
  kind: string;
  note: string;
  commit_date?: string | null;
  delay_reason?: string | null;
  next_action_date?: string | null;
}

export function logFollowup(actor: Actor, poId: number, input: FollowupInput, opts: { at?: string } = {}) {
  const po = mustSee(actor, poId);
  if (!actor.perms.has('po.followup')) throw forbidden();
  const ts = opts.at ?? now();
  const fields: Record<string, string> = {};
  if (!(FOLLOWUP_KINDS as readonly string[]).includes(input.kind)) fields.kind = 'Choose the kind of follow-up.';
  if (!input.note || input.note.trim().length < 5) fields.note = 'Write what was discussed or agreed (at least 5 characters).';
  const line = input.po_line_id ? getLine(input.po_line_id) : null;
  if (input.po_line_id && (!line || line.po_id !== poId)) fields.po_line_id = 'Choose a line of this PO.';
  if (input.commit_date && !line) fields.commit_date = 'Choose the line the new commitment applies to.';
  if (input.next_action_date && (!isDate(input.next_action_date) || input.next_action_date < today(ts))) fields.next_action_date = 'Next action date must be today or later.';
  if (input.delay_reason && !cfg<string[]>('po.delay_reasons').includes(input.delay_reason)) fields.delay_reason = 'Choose a delay reason from the list.';
  if (Object.keys(fields).length) throw badRequest(Object.values(fields)[0], fields);
  return tx(() => {
    const targets = line ? [line] : linesOf(poId).filter((l) => lineState(l, po).active);
    if (input.commit_date && line) {
      applyCommitment(actor, po, line, { commit_date: input.commit_date, delay_reason: input.delay_reason ?? '', note: input.note }, { kind: input.kind, at: ts, nextAction: input.next_action_date ?? undefined, extraNote: `Logged by ${actor.name}` });
    } else {
      for (const l of targets) update('po_lines', l.id, { ...(input.next_action_date ? { next_action_date: input.next_action_date } : {}), ...(input.delay_reason ? { delay_reason: input.delay_reason } : {}) });
      addFollowup(poId, line?.id ?? null, actor.id, input.kind, input.note.trim(), { delay_reason: input.delay_reason ?? null, next_action_date: input.next_action_date ?? null, at: ts, meta: { type: 'followup', lines: targets.map((l) => l.item) } });
    }
    audit(actor, { action: 'po.followup_logged', objectType: 'po', objectId: poId, objectRef: line ? lineRef(po, line) : po.po_no, after: { kind: input.kind, commit_date: input.commit_date ?? null, delay_reason: input.delay_reason ?? null, next_action_date: input.next_action_date ?? null } });
    return { ok: true };
  });
}

// ------------------------------------------------------------------ reminders (FR-POM-07, AC-POM-07) and escalation (FR-POM-08)
type ReminderType = 'ack' | 'dispatch' | 'overdue' | 'documents';
const REMINDER_LABEL: Record<ReminderType, string> = { ack: 'Acknowledgement reminder', dispatch: 'Dispatch reminder', overdue: 'Delivery overdue reminder', documents: 'Pending documents reminder' };

export function remind(actor: Actor | null, poId: number, opts: { manual?: boolean; type?: ReminderType; lineIds?: number[]; at?: string } = {}) {
  const po = actor ? mustSee(actor, poId) : getPo(poId);
  if (!po) throw notFound('Purchase order');
  if (actor && !actor.perms.has('po.followup')) throw forbidden();
  if (!OPEN_PO.includes(po.status)) throw conflict(`PO ${po.po_no} is ${po.status.toLowerCase()}; there is nothing to remind the vendor about.`);
  const ts = opts.at ?? now();
  const asn = hasLiveAsn(po.id);
  const all_ = linesOf(po.id).map((l) => ({ l, s: lineState(l, po, { asn }) }));
  const active = all_.filter((x) => x.s.active);
  let type = opts.type;
  if (!type) {
    if (active.some((x) => PENDING_ACK.includes(x.l.ack_status))) type = 'ack';
    else if (active.some((x) => x.s.overdue)) type = 'overdue';
    else if (active.some((x) => x.s.open_qty > 0)) type = 'dispatch';
  }
  if (!type) throw conflict(`Nothing to remind about on PO ${po.po_no}: every line is acknowledged and delivered, rejected or cancelled.`);
  const pick = (x: { l: PoLine; s: LineState }) =>
    type === 'ack' ? PENDING_ACK.includes(x.l.ack_status) : type === 'overdue' ? x.s.overdue : type === 'dispatch' ? x.s.open_qty > 0 && !PENDING_ACK.includes(x.l.ack_status) : true;
  const targets = (type === 'documents' ? all_ : active).filter((x) => (!opts.lineIds || opts.lineIds.includes(x.l.id)) && pick(x));
  if (!targets.length) throw conflict(`No line of PO ${po.po_no} is waiting for this reminder.`);
  const items = targets.map((x) => x.l.item).join(', ');
  const event = type === 'ack' ? 'NTF-17' : 'NTF-18';
  const title = type === 'ack' ? `Please acknowledge PO ${po.po_no}` : type === 'overdue' ? `Delivery overdue on PO ${po.po_no}` : type === 'dispatch' ? `Dispatch due on PO ${po.po_no}` : `Documents pending on PO ${po.po_no}`;
  const body = type === 'ack' ? `Line(s) ${items} are waiting for your acceptance and delivery commitment.`
    : type === 'overdue' ? `Line(s) ${items} are past the committed date. Dispatch now or update the commitment with a delay reason.`
    : type === 'dispatch' ? `Line(s) ${items}: dispatch by ${fmtD(targets[0].s.commitment)} and submit the ASN.`
    : `Goods received on line(s) ${items}. Upload the invoice and dispatch documents.`;
  const created = notify({ event, title, body, link: `/vendor/pos/${po.id}`, vendorId: po.vendor_id, objectType: 'po', objectId: po.id, severity: type === 'overdue' ? 'danger' : 'warning', dedupeKey: opts.manual ? `${event}:${po.id}:${type}:${ts}` : `${event}:${po.id}:${type}:${targets.map((x) => `${x.l.id}@${x.s.commitment}`).join('|')}` });
  const count = all<FollowupRow>('SELECT * FROM po_followups WHERE po_id = ? AND kind = ?', po.id, 'Reminder').length + 1;
  addFollowup(po.id, targets.length === 1 ? targets[0].l.id : null, actor?.id ?? null, 'Reminder',
    `${REMINDER_LABEL[type]} ${opts.manual ? 'sent by ' + (actor?.name ?? 'buyer') : 'sent automatically'} for line(s) ${items}${created.length ? ` to ${created.length} vendor user(s)` : ' — vendor has no portal user; contact the vendor directly'}.`,
    { at: ts, meta: { type, manual: !!opts.manual, lines: targets.map((x) => x.l.id), commitments: targets.map((x) => x.s.commitment), recipients: created.length, count } });
  audit(actor, { action: 'po.reminder_sent', objectType: 'po', objectId: po.id, objectRef: po.po_no, after: { type, manual: !!opts.manual, lines: targets.map((x) => x.l.item), recipients: created.length } });
  return { po_id: po.id, po_no: po.po_no, type, lines: targets.length, recipients: created.length };
}

export function escalate(actor: Actor | null, poId: number, opts: { reason?: string; at?: string; manual?: boolean } = {}) {
  const po = actor ? mustSee(actor, poId) : getPo(poId);
  if (!po) throw notFound('Purchase order');
  if (actor && !actor.perms.has('po.followup')) throw forbidden();
  if (!OPEN_PO.includes(po.status)) throw conflict(`PO ${po.po_no} is ${po.status.toLowerCase()}; there is nothing to escalate.`);
  if (opts.manual && (!opts.reason || opts.reason.trim().length < 10)) throw badRequest('Say why you are escalating (at least 10 characters).', { reason: 'Reason is required' });
  const ts = opts.at ?? now();
  const current = escalationLevel(po);
  const level = Math.max(2, current + 1);
  if (level > 3) throw conflict(`PO ${po.po_no} is already escalated to level 3 (department head).`);
  const buyer = po.buyer_id ? get<{ id: number; name: string; manager_id: number | null }>('SELECT id, name, manager_id FROM users WHERE id = ?', po.buyer_id) : undefined;
  const manager = buyer?.manager_id ? get<{ id: number; name: string }>('SELECT id, name FROM users WHERE id = ? AND active = 1', buyer.manager_id) : undefined;
  const asn = hasLiveAsn(po.id);
  const st = linesOf(po.id).map((l) => ({ l, s: lineState(l, po, { asn }) })).filter((x) => x.s.active);
  const pendingAck = st.filter((x) => PENDING_ACK.includes(x.l.ack_status)).map((x) => x.l.item);
  const overdue = st.filter((x) => x.s.overdue).map((x) => x.l.item);
  const issue = [pendingAck.length ? `acknowledgement pending on line(s) ${pendingAck.join(', ')}` : '', overdue.length ? `delivery overdue on line(s) ${overdue.join(', ')}` : ''].filter(Boolean).join('; ') || 'follow-up without vendor response';
  const vendor = get<{ name: string }>('SELECT name FROM vendors WHERE id = ?', po.vendor_id)!;
  const to = level === 2 ? (manager ? `${manager.name} (buyer's manager)` : 'Procurement Manager (buyer has no manager on record)') : 'Management (department head)';
  const n = notify({
    event: 'NTF-19', title: `Escalation level ${level}: PO ${po.po_no} — ${vendor.name}`, body: `${issue}${opts.reason ? `. ${opts.reason}` : ''}`,
    link: `/pos/${po.id}`, ...(level === 2 ? (manager ? { users: [manager.id] } : { roles: ['APR'] as Role[] }) : { roles: ['MGT'] as Role[] }),
    objectType: 'po', objectId: po.id, severity: 'danger', dedupeKey: `NTF-19:${po.id}:L${level}:${cycleStart(po)}`,
  });
  notify({ event: 'NTF-19', title: `PO ${po.po_no} escalated to level ${level}`, body: `Sent to ${to}: ${issue}.`, link: `/pos/${po.id}`, users: [po.buyer_id], exclude: actor ? [actor.id] : [], objectType: 'po', objectId: po.id, severity: 'warning', dedupeKey: `NTF-19b:${po.id}:L${level}:${ts}` });
  notify({ event: 'NTF-19', title: `Delivery of your requirement is escalated (PO ${po.po_no})`, body: `${vendor.name}: ${issue}. Procurement is following up.`, link: `/pos/${po.id}`, users: requisitionersOf(po.id), objectType: 'po', objectId: po.id, dedupeKey: `NTF-19r:${po.id}:L${level}:${cycleStart(po)}` });
  addFollowup(po.id, null, actor?.id ?? null, 'Escalation', `Escalated to level ${level} — ${to}: ${issue}${opts.reason ? `. ${opts.reason}` : ''}.`, { at: ts, meta: { level, manual: !!opts.manual, to, recipients: n.length, reason: opts.reason ?? null } });
  audit(actor, { action: 'po.escalated', objectType: 'po', objectId: po.id, objectRef: po.po_no, before: { level: current }, after: { level, to, issue }, reason: opts.reason ?? null });
  return { po_id: po.id, po_no: po.po_no, level, to };
}

/** Scheduler (FR-POM-03/07/08): deemed acceptance, reminders, escalations. Returns a count summary. */
export function followupJob() {
  const rem = reminderCfg();
  const esc = cfg<{ level2_days: number; level3_days: number }>('po.escalation');
  const deemedCfg = cfg<{ enabled: boolean; hours: number }>('po.deemed_acceptance');
  const docCfg = cfg<{ enabled: boolean; days_after_grn: number }>('po.document_reminder');
  const t = today();
  const c = { deemed: 0, ack: 0, dispatch: 0, overdue: 0, documents: 0, escalations: 0 };
  const pos = all<PoRow>(`SELECT * FROM pos WHERE status IN (${OPEN_PO.map(() => '?').join(',')}) AND sap_released = 1`, ...OPEN_PO);
  for (const po of pos) {
    try {
      const cs = cycleStart(po);
      const fus = followupsOf(po.id);
      const asn = hasLiveAsn(po.id);
      const st = linesOf(po.id).map((l) => ({ l, s: lineState(l, po, { asn }) }));
      const active = st.filter((x) => x.s.active);
      // Deemed acceptance (DEC-16): only when switched on; non-response is still reported.
      const pending = active.filter((x) => PENDING_ACK.includes(x.l.ack_status));
      if (deemedCfg.enabled && pending.length && addHours(cs, deemedCfg.hours) < now()) {
        tx(() => {
          for (const x of pending) {
            update('po_lines', x.l.id, { ack_status: 'Deemed accepted', accepted_qty: x.l.qty, ack_at: now(), ack_remarks: `Deemed accepted after ${deemedCfg.hours} h without response (DEC-16)` });
            audit(null, { action: 'po.line_deemed_accepted', objectType: 'po', objectId: po.id, objectRef: lineRef(po, x.l), before: { ack_status: x.l.ack_status }, after: { ack_status: 'Deemed accepted', hours: deemedCfg.hours } });
          }
          update('pos', po.id, { deemed_accepted: 1 });
          addFollowup(po.id, null, null, 'System', `Line(s) ${pending.map((x) => x.l.item).join(', ')} deemed accepted after ${deemedCfg.hours} hours without vendor response (DEC-16). Listed in the non-response report.`, { meta: { type: 'deemed', lines: pending.map((x) => x.l.id) } });
          notify({ event: 'NTF-17', title: `PO ${po.po_no} deemed accepted`, body: `No acknowledgement within ${deemedCfg.hours} hours. Delivery dates on the PO now apply.`, link: `/vendor/pos/${po.id}`, vendorId: po.vendor_id, objectType: 'po', objectId: po.id, dedupeKey: `deemed:${po.id}:${cs}` });
          notify({ event: 'NTF-17', title: `PO ${po.po_no} deemed accepted — no vendor response`, body: `Line(s) ${pending.map((x) => x.l.item).join(', ')}`, link: `/pos/${po.id}`, users: [po.buyer_id], objectType: 'po', objectId: po.id, dedupeKey: `deemed-b:${po.id}:${cs}`, severity: 'warning' });
          completeReack(po.id, null);
        });
        c.deemed += pending.length;
        continue;
      }
      const sent = (type: ReminderType) => fus.filter((f) => f.kind === 'Reminder' && f.meta?.type === type && f.created_at >= cs);
      // Acknowledgement pending after N hours (NTF-17): one automatic reminder per publication cycle.
      if (pending.length && addHours(cs, rem.ack_after_hours) < now() && !sent('ack').length) { remind(null, po.id, { type: 'ack' }); c.ack++; }
      // Dispatch due N days before commitment and delivery overdue N days after (NTF-18): once per line and commitment date.
      const already = (type: ReminderType, x: { l: PoLine; s: LineState }) => sent(type).some((f) => (f.meta?.lines ?? []).includes(x.l.id) && (f.meta?.commitments ?? [])[(f.meta?.lines ?? []).indexOf(x.l.id)] === x.s.commitment);
      const dispatchDue = active.filter((x) => x.s.dispatch_due && !already('dispatch', x));
      if (dispatchDue.length) { remind(null, po.id, { type: 'dispatch', lineIds: dispatchDue.map((x) => x.l.id) }); c.dispatch++; }
      const overdue = active.filter((x) => x.s.overdue && x.s.overdue_days >= rem.overdue_days_after && !already('overdue', x));
      if (overdue.length) {
        remind(null, po.id, { type: 'overdue', lineIds: overdue.map((x) => x.l.id) });
        notify({ event: 'NTF-18', title: `Delivery overdue: PO ${po.po_no}`, body: `Line(s) ${overdue.map((x) => x.l.item).join(', ')} past the committed date.`, link: `/pos/${po.id}`, users: [po.buyer_id], objectType: 'po', objectId: po.id, severity: 'warning', dedupeKey: `NTF-18b:${po.id}:${overdue.map((x) => `${x.l.id}@${x.s.commitment}`).join('|')}` });
        c.overdue++;
      }
      // Pending documents: goods received but no invoice uploaded after N days (FR-POM-07).
      if (docCfg.enabled && !fus.some((f) => f.kind === 'Reminder' && f.meta?.type === 'documents')) {
        const lastGrn = scalar<string>('SELECT MAX(posting_date) FROM grns WHERE po_id = ?', po.id);
        const invoices = scalar<number>("SELECT COUNT(*) FROM invoices WHERE po_id = ? AND status != 'Rejected'", po.id) ?? 0;
        if (lastGrn && !invoices && daysBetween(lastGrn, t) >= docCfg.days_after_grn) {
          const received = st.filter((x) => (x.l.received_qty ?? 0) > 0).map((x) => x.l.id);
          if (received.length) { remind(null, po.id, { type: 'documents', lineIds: received }); c.documents++; }
        }
      }
      // Escalation matrix: no vendor response N days after the first reminder of an open issue.
      const fresh = followupsOf(po.id);
      const issueReminders = fresh.filter((f) => f.kind === 'Reminder' && ['ack', 'overdue'].includes(f.meta?.type) && f.created_at >= cs);
      const stillOpen = active.some((x) => PENDING_ACK.includes(x.l.ack_status) || x.s.overdue);
      if (issueReminders.length && stillOpen) {
        const first = issueReminders[0].created_at;
        const responded = fresh.some((f) => f.kind === 'Vendor update' && f.created_at > first);
        if (!responded) {
          const age = (Date.now() - new Date(first).getTime()) / 86400000;
          const target = age >= esc.level3_days ? 3 : age >= esc.level2_days ? 2 : 0;
          let level = escalationLevel(po, fresh);
          while (target && level < target) {
            escalate(null, po.id, {});
            level = escalationLevel(po);
            c.escalations++;
          }
        }
      }
    } catch (e) {
      console.error(`po follow-up job failed for ${po.po_no}`, e);
    }
  }
  return `deemed ${c.deemed}, ack reminders ${c.ack}, dispatch ${c.dispatch}, overdue ${c.overdue}, documents ${c.documents}, escalations ${c.escalations}`;
}

// ------------------------------------------------------------------ amendments / cancellation (FR-POM-09, FR-APR-07, WF-13)
export interface AmendInput {
  type: AmendType;
  reason: string;
  lines?: { line_id: number; qty?: number | null; unit_price?: number | null; delivery_date?: string | null }[];
  terms?: { payment_terms?: string | null; delivery_terms?: string | null };
}

function buildChanges(po: PoRow, input: AmendInput, vendorRaised: boolean): AmdChanges {
  const lines = linesOf(po.id);
  const fields: Record<string, string> = {};
  if (!AMEND_TYPES.includes(input.type)) throw badRequest('Choose the amendment type: Quantity, Price, Date, Terms or Cancel.', { type: 'Choose a type' });
  if (!input.reason || input.reason.trim().length < 10) fields.reason = 'Give the reason for the change (at least 10 characters).';
  const out: AmdLineChange[] = [];
  let delta = 0;
  const picked = input.lines ?? [];
  for (const [i, c] of picked.entries()) {
    const l = lines.find((x) => x.id === c.line_id);
    if (!l) { fields[`lines.${i}`] = 'This line is not on the PO.'; continue; }
    if (l.status === 'Cancelled' || l.ack_status === 'Cancelled') { fields[`lines.${i}`] = `Line ${l.item} is already cancelled.`; continue; }
    const old = { qty: l.qty, unit_price: l.unit_price, delivery_date: l.delivery_date };
    const base = { line_id: l.id, item: l.item, description: l.description, uom: l.uom, old };
    if (input.type === 'Quantity') {
      if (c.qty == null) continue;
      const q = Number(c.qty);
      if (!Number.isFinite(q) || q <= 0) fields[`lines.${i}.qty`] = `Line ${l.item}: enter a quantity above 0 (use Cancel to remove a line).`;
      else if (q < (l.received_qty ?? 0)) fields[`lines.${i}.qty`] = `Line ${l.item}: ${l.received_qty} ${l.uom} are already received. Enter at least ${l.received_qty}.`;
      else if (q !== l.qty) { out.push({ ...base, new: { qty: q } }); delta += (q - l.qty) * l.unit_price; }
    } else if (input.type === 'Price') {
      if (c.unit_price == null) continue;
      const p = Number(c.unit_price);
      if (!Number.isFinite(p) || p <= 0) fields[`lines.${i}.unit_price`] = `Line ${l.item}: enter a unit price above 0.`;
      else if (p !== l.unit_price) { out.push({ ...base, new: { unit_price: round2(p) } }); delta += (p - l.unit_price) * l.qty; }
    } else if (input.type === 'Date') {
      if (!c.delivery_date) continue;
      if (!isDate(c.delivery_date) || c.delivery_date < today()) fields[`lines.${i}.delivery_date`] = `Line ${l.item}: the new delivery date must be today or later.`;
      else if (c.delivery_date !== l.delivery_date) out.push({ ...base, new: { delivery_date: c.delivery_date } });
    } else if (input.type === 'Cancel') {
      if ((l.received_qty ?? 0) >= l.qty) fields[`lines.${i}`] = `Line ${l.item} is fully received and cannot be cancelled.`;
      else { out.push({ ...base, new: { deleted: true } }); delta -= (l.qty - (l.received_qty ?? 0)) * l.unit_price; }
    }
  }
  let terms: AmdChanges['terms'];
  let scope: AmdChanges['scope'];
  if (input.type === 'Terms') {
    const nt = { payment_terms: input.terms?.payment_terms?.trim() || null, delivery_terms: input.terms?.delivery_terms?.trim() || null };
    const ot = { payment_terms: po.payment_terms, delivery_terms: po.delivery_terms };
    const changed = (Object.keys(nt) as (keyof typeof nt)[]).filter((k) => nt[k] && nt[k] !== ot[k]);
    if (!changed.length) fields.terms = 'Change the payment terms or delivery terms.';
    terms = { old: Object.fromEntries(changed.map((k) => [k, ot[k]])), new: Object.fromEntries(changed.map((k) => [k, nt[k]])) };
  } else if (input.type === 'Cancel') {
    scope = picked.length === 0 || out.length === lines.filter((l) => l.status !== 'Cancelled').length ? 'po' : 'lines';
    if (scope === 'po' && !picked.length) {
      for (const l of lines.filter((x) => x.status !== 'Cancelled' && x.ack_status !== 'Cancelled')) {
        if ((l.received_qty ?? 0) >= l.qty) continue;
        out.push({ line_id: l.id, item: l.item, description: l.description, uom: l.uom, old: { qty: l.qty, unit_price: l.unit_price, delivery_date: l.delivery_date }, new: { deleted: true } });
        delta -= (l.qty - (l.received_qty ?? 0)) * l.unit_price;
      }
      if (!out.length) fields.lines = 'Every line is fully received — there is nothing left to cancel.';
    }
  } else if (!out.length && !Object.keys(fields).some((k) => k.startsWith('lines'))) {
    fields.lines = input.type === 'Quantity' ? 'Change the quantity on at least one line.' : input.type === 'Price' ? 'Change the unit price on at least one line.' : 'Change the delivery date on at least one line.';
  }
  if (Object.keys(fields).length) throw badRequest(Object.values(fields)[0], fields);
  let requires = false;
  let why = '';
  if (input.type === 'Cancel') {
    const asn = scalar<string>(`SELECT asn_no FROM asns WHERE po_id = ? AND status IN (${ASN_LIVE.map(() => '?').join(',')}) LIMIT 1`, po.id, ...ASN_LIVE);
    const partial = out.some((c) => (lines.find((l) => l.id === c.line_id)?.received_qty ?? 0) > 0);
    requires = !!asn || partial;
    why = asn ? `ASN ${asn} exists for this PO` : partial ? 'goods are already partly received' : '';
  }
  void vendorRaised;
  return { lines: out, terms, scope, requires_confirmation: requires, confirmation_reason: why || undefined, confirmations: {}, value_delta: round2(delta) };
}

function changeSummary(type: AmendType, ch: AmdChanges) {
  if (type === 'Terms') return Object.keys(ch.terms?.new ?? {}).map((k) => `${k.replace('_', ' ')}: ${ch.terms!.old[k] ?? '—'} → ${ch.terms!.new[k]}`).join('; ');
  if (type === 'Cancel') return ch.scope === 'po' ? 'Cancel the whole PO' : `Cancel line(s) ${ch.lines.map((c) => c.item).join(', ')}`;
  return ch.lines.map((c) => type === 'Quantity' ? `Line ${c.item} qty ${c.old.qty} → ${c.new.qty} ${c.uom}` : type === 'Price' ? `Line ${c.item} unit price ${inr(c.old.unit_price)} → ${inr(c.new.unit_price!)}` : `Line ${c.item} delivery ${fmtD(c.old.delivery_date)} → ${fmtD(c.new.delivery_date)}`).join('; ');
}

function assertAmendable(po: PoRow) {
  if (!OPEN_PO.includes(po.status)) throw conflict(`PO ${po.po_no} is ${po.status.toLowerCase()} and cannot be amended.`);
  const open = get<{ amd_no: string; status: string }>(`SELECT amd_no, status FROM po_amendments WHERE po_id = ? AND status IN (${OPEN_AMD.map(() => '?').join(',')})`, po.id, ...OPEN_AMD);
  if (open) throw conflict(`Amendment ${open.amd_no} is still ${open.status.toLowerCase()} on this PO. Finish or withdraw it before raising another.`);
}

function routeForApproval(actor: Actor, po: PoRow, amd: AmendmentRow, kind: 'main' | 'price') {
  const vendor = get<{ name: string; sap_code: string }>('SELECT name, sap_code FROM vendors WHERE id = ?', po.vendor_id)!;
  const summary = changeSummary(amd.type, amd.changes);
  const type = kind === 'price' ? 'exc.price_amendment' : amd.type === 'Cancel' ? 'po.cancellation' : 'po.amendment';
  const title = kind === 'price' ? `Price amendment on PO ${po.po_no} (${amd.amd_no})` : amd.type === 'Cancel' ? `Cancel PO ${po.po_no} (${amd.amd_no})` : `Amend PO ${po.po_no}: ${amd.type.toLowerCase()} (${amd.amd_no})`;
  return createApproval(actor, {
    type, objectType: 'po_amendment', objectId: amd.id, title, summary: `${vendor.name} · ${summary}`, value: Math.abs(amd.changes.value_delta), reason: amd.reason,
    context: {
      po_id: po.id, po_no: po.po_no, amd_no: amd.amd_no, amendment_type: amd.type, vendor: vendor.name, vendor_code: vendor.sap_code, link: `/pos/${po.id}`,
      changes: amd.changes.lines.map((c) => ({ item: c.item, description: c.description, old: c.old, new: c.new })), terms: amd.changes.terms ?? null,
      value_delta: amd.changes.value_delta, raised_by_vendor: !!amd.raised_by_vendor, requires_confirmation: amd.changes.requires_confirmation,
      ...(amd.raised_by_vendor ? {} : {}),
    },
    urgency: po.urgency, plant: po.plant,
  });
}

export function requestAmendment(actor: Actor, poId: number, input: AmendInput) {
  const po = mustSee(actor, poId);
  const vendorRaised = actor.role === 'VEN';
  if (!vendorRaised && !actor.perms.has('po.amend')) throw forbidden('Only buyers can request PO amendments.');
  assertAmendable(po);
  const changes = buildChanges(po, input, vendorRaised);
  return tx(() => {
    const amdNo = nextNo('AMD');
    const id = insert('po_amendments', { amd_no: amdNo, po_id: po.id, type: input.type, changes_json: J(changes), reason: input.reason.trim(), status: 'Requested', requested_by: actor.id, raised_by_vendor: vendorRaised ? 1 : 0, created_at: now() });
    let amd = getAmendment(id)!;
    audit(actor, { action: vendorRaised ? 'po.deviation_requested' : 'po.amendment_requested', objectType: 'po', objectId: po.id, objectRef: `${po.po_no} ${amdNo}`, after: { type: input.type, summary: changeSummary(amd.type, changes), value_delta: changes.value_delta, requires_confirmation: changes.requires_confirmation }, reason: input.reason });
    if (vendorRaised) {
      notify({ event: 'NTF-20', title: `Vendor requested a ${input.type.toLowerCase()} change on PO ${po.po_no}`, body: `${changeSummary(amd.type, changes)}. Reason: ${input.reason.trim()}`, link: `/pos/${po.id}`, users: [po.buyer_id], objectType: 'po', objectId: po.id, severity: 'warning', dedupeKey: `NTF-20v:${id}` });
    } else {
      const ap = routeForApproval(actor, po, amd, 'main');
      update('po_amendments', id, { approval_id: ap.id });
      amd = getAmendment(id)!;
    }
    return amd;
  });
}

/** Buyer takes a vendor-raised deviation request into the approval workflow. */
export function forwardVendorRequest(actor: Actor, amdId: number) {
  const amd = getAmendment(amdId);
  if (!amd) throw notFound('Amendment request');
  const po = mustSee(actor, amd.po_id);
  if (!amd.raised_by_vendor || amd.approval_id || amd.status !== 'Requested') throw conflict('Only a new vendor request can be sent for approval.');
  return tx(() => {
    const changes = { ...amd.changes, forwarded_by: { user_id: actor.id, name: actor.name, at: now() } };
    update('po_amendments', amdId, { changes_json: J(changes) });
    const ap = routeForApproval(actor, po, { ...amd, changes }, 'main');
    update('po_amendments', amdId, { approval_id: ap.id });
    audit(actor, { action: 'po.deviation_forwarded', objectType: 'po', objectId: po.id, objectRef: `${po.po_no} ${amd.amd_no}`, after: { approval: ap.req_no } });
    notify({ event: 'NTF-20', title: `Your change request ${amd.amd_no} is with Equipcare for approval`, body: changeSummary(amd.type, amd.changes), link: `/vendor/pos/${po.id}`, vendorId: po.vendor_id, objectType: 'po', objectId: po.id, dedupeKey: `NTF-20vf:${amdId}` });
    return getAmendment(amdId)!;
  });
}

export function declineVendorRequest(actor: Actor, amdId: number, reason: string) {
  const amd = getAmendment(amdId);
  if (!amd) throw notFound('Amendment request');
  const po = mustSee(actor, amd.po_id);
  if (!amd.raised_by_vendor || amd.approval_id || amd.status !== 'Requested') throw conflict('Only a new vendor request can be declined here.');
  update('po_amendments', amdId, { status: 'Rejected' });
  audit(actor, { action: 'po.deviation_declined', objectType: 'po', objectId: po.id, objectRef: `${po.po_no} ${amd.amd_no}`, before: { status: 'Requested' }, after: { status: 'Rejected' }, reason });
  notify({ event: 'NTF-20', title: `Change request ${amd.amd_no} on PO ${po.po_no} declined`, body: reason, link: `/vendor/pos/${po.id}`, vendorId: po.vendor_id, objectType: 'po', objectId: po.id, dedupeKey: `NTF-20vd:${amdId}` });
  return getAmendment(amdId)!;
}

export function withdrawAmendment(actor: Actor, amdId: number, reason: string) {
  const amd = getAmendment(amdId);
  if (!amd) throw notFound('Amendment request');
  const po = mustSee(actor, amd.po_id);
  if (amd.status !== 'Requested') throw conflict(`${amd.amd_no} is ${amd.status.toLowerCase()} and can no longer be withdrawn.`);
  return tx(() => {
    const ap = get<ApprovalRow>("SELECT * FROM approvals WHERE object_type = 'po_amendment' AND object_id = ? AND status IN ('Pending','Clarification requested') ORDER BY id DESC LIMIT 1", amdId);
    if (ap) {
      if (ap.requester_id !== actor.id) throw forbidden('Only the person who sent the request for approval can withdraw it.');
      withdrawApproval(actor, ap.id, reason); // handler marks the amendment Withdrawn
    } else {
      if (amd.requested_by !== actor.id) throw forbidden('Only the requester can withdraw this request.');
      update('po_amendments', amdId, { status: 'Withdrawn' });
    }
    if (getAmendment(amdId)!.status !== 'Withdrawn') update('po_amendments', amdId, { status: 'Withdrawn' });
    audit(actor, { action: 'po.amendment_withdrawn', objectType: 'po', objectId: po.id, objectRef: `${po.po_no} ${amd.amd_no}`, before: { status: amd.status }, after: { status: 'Withdrawn' }, reason });
    return getAmendment(amdId)!;
  });
}

/** Approval outcome for po.amendment / po.cancellation / exc.price_amendment. Price changes need both (FR-APR-04). */
export function onAmendmentDecision(ap: ApprovalRow, outcome: string, actor: Actor | null, comment: string | null) {
  if (ap.object_type !== 'po_amendment') return;
  const amd = getAmendment(ap.object_id);
  if (!amd || amd.status !== 'Requested') return;
  const po = getPo(amd.po_id)!;
  const ref = `${po.po_no} ${amd.amd_no}`;
  if (outcome === 'Approved') {
    if (ap.type !== 'exc.price_amendment' && amd.type === 'Price') {
      const requester = actorById(ap.requester_id);
      if (requester) {
        const exc = routeForApproval(requester, po, amd, 'price');
        audit(actor, { action: 'po.amendment_price_exception_routed', objectType: 'po', objectId: po.id, objectRef: ref, after: { approval: exc.req_no } });
        return;
      }
    }
    update('po_amendments', amd.id, { status: 'Approved' });
    update('pos', po.id, { sap_change_pending: 1 });
    audit(actor, { action: 'po.amendment_approved', objectType: 'po', objectId: po.id, objectRef: ref, before: { status: 'Requested' }, after: { status: 'Approved', approval: ap.req_no, sap_change_pending: true }, reason: comment });
    notify({ event: 'NTF-20', title: `${amd.amd_no} approved — apply the change in SAP`, body: `${changeSummary(amd.type, amd.changes)}. The PO shows "Change pending in SAP" until the new version syncs.`, link: `/pos/${po.id}`, users: [ap.requester_id, po.buyer_id], objectType: 'po', objectId: po.id, severity: 'success', dedupeKey: `NTF-20ap:${amd.id}` });
  } else {
    const status = outcome === 'Withdrawn' ? 'Withdrawn' : 'Rejected';
    update('po_amendments', amd.id, { status });
    audit(actor, { action: `po.amendment_${status.toLowerCase()}`, objectType: 'po', objectId: po.id, objectRef: ref, before: { status: 'Requested' }, after: { status, approval: ap.req_no, outcome }, reason: comment });
    if (amd.raised_by_vendor && status === 'Rejected') notify({ event: 'NTF-20', title: `Change request ${amd.amd_no} on PO ${po.po_no} not approved`, body: comment ?? '', link: `/vendor/pos/${po.id}`, vendorId: po.vendor_id, objectType: 'po', objectId: po.id, dedupeKey: `NTF-20vr:${amd.id}` });
  }
}

/** Cancellation after ASN or partial GRN: stores and vendor confirmations recorded with user and time (WF-13). */
export function confirmCancellation(actor: Actor, amdId: number, party: 'stores' | 'vendor', note?: string | null) {
  const amd = getAmendment(amdId);
  if (!amd) throw notFound('Amendment request');
  const po = mustSee(actor, amd.po_id);
  if (amd.type !== 'Cancel' || !amd.changes.requires_confirmation) throw conflict('This request does not need stores or vendor confirmation.');
  if (!['Requested', 'Approved'].includes(amd.status)) throw conflict(`${amd.amd_no} is ${amd.status.toLowerCase()}.`);
  if (amd.changes.confirmations[party]) throw conflict(`${party === 'stores' ? 'Stores' : 'Vendor'} confirmation is already recorded.`);
  let onBehalf = false;
  if (party === 'stores') {
    if (!actor.perms.has('asn.receive')) throw forbidden('Stores confirms this step: sign in as the stores in-charge for the plant.');
    if (!plantAllowed(actor, po.plant)) throw forbidden(`Only stores for plant ${po.plant} can confirm.`);
  } else if (actor.role !== 'VEN') {
    if (!actor.perms.has('po.amend')) throw forbidden();
    if (!note || note.trim().length < 10) throw badRequest('Say how the vendor confirmed (for example "E-mail from Divya Raman, 15 Oct"). At least 10 characters.', { note: 'Required' });
    onBehalf = true;
  }
  const conf: AmdConf = { user_id: actor.id, name: actor.name, role: actor.role, at: now(), on_behalf: onBehalf, note: note?.trim() || null };
  const changes = { ...amd.changes, confirmations: { ...amd.changes.confirmations, [party]: conf } };
  update('po_amendments', amdId, { changes_json: J(changes) });
  audit(actor, { action: `po.cancellation_confirmed_${party}`, objectType: 'po', objectId: po.id, objectRef: `${po.po_no} ${amd.amd_no}`, after: conf, reason: note ?? null });
  if (party === 'stores') notify({ event: 'NTF-20', title: `Stores confirmed cancellation ${amd.amd_no}`, body: `PO ${po.po_no}`, link: `/pos/${po.id}`, users: [amd.requested_by, po.buyer_id], objectType: 'po', objectId: po.id, dedupeKey: `conf-s:${amdId}` });
  return getAmendment(amdId)!;
}

/** "Apply in SAP": validates the request and returns the SAP simulator change payload (contract in ENGINEERING.md). */
export function prepareSapChange(actor: Actor, amdId: number) {
  const amd = getAmendment(amdId);
  if (!amd) throw notFound('Amendment request');
  const po = mustSee(actor, amd.po_id);
  if (amd.status !== 'Approved') throw conflict(`${amd.amd_no} is ${amd.status.toLowerCase()}; only an approved request can be applied in SAP.`);
  const ch = amd.changes;
  if (amd.type === 'Cancel' && ch.requires_confirmation && (!ch.confirmations.stores || !ch.confirmations.vendor)) {
    throw new HttpError(409, 'confirmation_required', `Stores and vendor must both confirm before this cancellation goes to SAP (${ch.confirmation_reason}). Missing: ${[!ch.confirmations.stores ? 'stores' : '', !ch.confirmations.vendor ? 'vendor' : ''].filter(Boolean).join(' and ')}.`);
  }
  const body = {
    changes: ch.lines.map((c) => ({ item: c.item, ...(c.new.qty != null ? { qty: c.new.qty } : {}), ...(c.new.unit_price != null ? { unit_price: c.new.unit_price } : {}), ...(c.new.delivery_date ? { delivery_date: c.new.delivery_date } : {}), ...(c.new.deleted ? { deleted: true } : {}) })),
    cancel: amd.type === 'Cancel' && ch.scope === 'po',
    amendment_id: amd.id,
    ...(ch.terms ? { terms: ch.terms.new } : {}),
  };
  const changes = { ...ch, sap_request: { at: now(), by: actor.id, by_name: actor.name } };
  update('po_amendments', amdId, { changes_json: J(changes) });
  audit(actor, { action: 'po.amendment_sent_to_sap', objectType: 'po', objectId: po.id, objectRef: `${po.po_no} ${amd.amd_no}`, after: { endpoint: `/api/sap/sim/po/${po.po_no}/change`, body } });
  return { po_no: po.po_no, endpoint: `/sap/sim/po/${po.po_no}/change`, body };
}

/** Vendor confirms receipt of a republished cancellation → Re-acknowledged. */
export function acknowledgeCancellation(actor: Actor, amdId: number) {
  const amd = getAmendment(amdId);
  if (!amd) throw notFound('Amendment request');
  const po = mustSee(actor, amd.po_id);
  if (actor.role !== 'VEN') throw forbidden('The vendor confirms receipt of the cancellation.');
  if (amd.type !== 'Cancel' || amd.status !== 'Republished') throw conflict('There is no cancellation waiting for your confirmation.');
  const ts = now();
  update('po_amendments', amdId, { status: 'Re-acknowledged', reack_at: ts });
  addFollowup(po.id, null, actor.id, 'Vendor update', `Vendor confirmed receipt of cancellation ${amd.amd_no} (version ${po.version}).`, { meta: { type: 'cancel_ack', amendment_id: amdId } });
  audit(actor, { action: 'po.amendment_reacknowledged', objectType: 'po', objectId: po.id, objectRef: `${po.po_no} ${amd.amd_no}`, before: { status: 'Republished' }, after: { status: 'Re-acknowledged' } });
  notify({ event: 'NTF-20', title: `Vendor confirmed cancellation of PO ${po.po_no}`, body: amd.amd_no, link: `/pos/${po.id}`, users: [amd.requested_by, po.buyer_id], objectType: 'po', objectId: po.id, dedupeKey: `NTF-20ca:${amdId}` });
  return getAmendment(amdId)!;
}

// ------------------------------------------------------------------ queries
interface ListRow extends PoLine {
  po_no: string; po_date: string; rfq_date: string | null; po_status: string; urgency: string; plant: string; buyer_id: number | null; vendor_id: number;
  version: number; ack_due_at: string | null; published_at: string | null; viewed_at: string | null; deemed_accepted: number; sap_change_pending: number;
  delivery_terms: string | null; vendor_name: string; vendor_code: string | null; buyer_name: string | null; material_code: string | null; material_group: string | null;
  pr_no: string | null; pr_item: number | null; requisitioner_id: number | null; requisitioner_name: string | null; synced_at: string | null;
}

export function listLines(actor: Actor, q: Record<string, string | undefined>) {
  const where: string[] = ['p.sap_released = 1'];
  const p: unknown[] = [];
  if (actor.role === 'VEN') { where.push('p.vendor_id = ?'); p.push(actor.vendorId); }
  else if (!actor.perms.has('po.view')) { where.push('pr.requisitioner_id = ?'); p.push(actor.id); }
  else if (actor.plants !== '*') { where.push(`p.plant IN (${actor.plants.map(() => '?').join(',')})`); p.push(...actor.plants); }
  for (const [k, col] of [['plant', 'p.plant'], ['urgency', 'p.urgency'], ['material_group', 'm.material_group']] as const) if (q[k]) { where.push(`${col} = ?`); p.push(q[k]); }
  if (q.buyer) { where.push('p.buyer_id = ?'); p.push(Number(q.buyer)); }
  if (q.vendor) { where.push('p.vendor_id = ?'); p.push(Number(q.vendor)); }
  if (q.po_from) { where.push('p.po_date >= ?'); p.push(q.po_from); }
  if (q.po_to) { where.push('p.po_date <= ?'); p.push(q.po_to); }
  if (q.rfq_from) { where.push('p.rfq_date >= ?'); p.push(q.rfq_from); }
  if (q.rfq_to) { where.push('p.rfq_date <= ?'); p.push(q.rfq_to); }
  if (q.req_from) { where.push('l.delivery_date >= ?'); p.push(q.req_from); }
  if (q.req_to) { where.push('l.delivery_date <= ?'); p.push(q.req_to); }
  if (q.po_id) { where.push('p.id = ?'); p.push(Number(q.po_id)); }
  const rows = all<ListRow>(
    `SELECT l.*, p.po_no, p.po_date, p.rfq_date, p.status AS po_status, p.urgency, p.plant, p.buyer_id, p.vendor_id, p.version, p.ack_due_at, p.published_at,
            p.viewed_at, p.deemed_accepted, p.sap_change_pending, p.delivery_terms, p.synced_at, v.name AS vendor_name, v.sap_code AS vendor_code, b.name AS buyer_name,
            m.code AS material_code, m.material_group, pr.pr_no, pr.item AS pr_item, pr.requisitioner_id, r.name AS requisitioner_name
     FROM po_lines l JOIN pos p ON p.id = l.po_id JOIN vendors v ON v.id = p.vendor_id LEFT JOIN users b ON b.id = p.buyer_id
     LEFT JOIN materials m ON m.id = l.material_id LEFT JOIN pr_lines pr ON pr.id = l.pr_line_id LEFT JOIN users r ON r.id = pr.requisitioner_id
     WHERE ${where.join(' AND ')}
     ORDER BY p.po_date DESC, p.po_no DESC, l.item`,
    ...p,
  );
  const poIds = [...new Set(rows.map((r) => r.po_id))];
  const fus = poIds.length ? all<FollowupRow & { user_name: string | null }>(`SELECT f.*, u.name AS user_name FROM po_followups f LEFT JOIN users u ON u.id = f.user_id WHERE f.po_id IN (${poIds.map(() => '?').join(',')}) ORDER BY f.created_at, f.id`, ...poIds) : [];
  const pubs = poIds.length ? all<{ po_id: number; published_at: string }>(`SELECT po_id, MAX(published_at) AS published_at FROM po_publications WHERE po_id IN (${poIds.map(() => '?').join(',')}) GROUP BY po_id`, ...poIds) : [];
  const asnPos = new Set(poIds.length ? all<{ po_id: number }>(`SELECT DISTINCT po_id FROM asns WHERE status IN (${ASN_LIVE.map(() => '?').join(',')}) AND po_id IN (${poIds.map(() => '?').join(',')})`, ...ASN_LIVE, ...poIds).map((r) => r.po_id) : []);
  const amdStatus = new Map(poIds.length ? all<{ po_id: number; status: string; amd_no: string }>(`SELECT po_id, status, amd_no FROM po_amendments WHERE status IN ('Requested','Approved','Changed in SAP','Republished') AND po_id IN (${poIds.map(() => '?').join(',')}) ORDER BY id`, ...poIds).map((r) => [r.po_id, r] as const) : []);
  const pubMap = new Map(pubs.map((x) => [x.po_id, x.published_at]));
  const internal = actor.role !== 'VEN';
  const priced = actor.role === 'VEN' || actor.perms.has('po.view');
  const out = rows.map((r) => {
    const cs = pubMap.get(r.po_id) ?? r.published_at ?? '';
    const f = fus.filter((x) => x.po_id === r.po_id);
    const fl = f.filter((x) => x.po_line_id === r.id || x.po_line_id == null);
    const lastResponse = [...f].reverse().find((x) => x.kind === 'Vendor update');
    const last = [...fl].reverse().find((x) => internal || ['Vendor update', 'Reminder'].includes(x.kind));
    const buyerTouched = !!r.ack_at && f.some((x) => x.po_line_id === r.id && x.user_id === r.buyer_id && x.created_at > r.ack_at! && x.kind !== 'Reminder');
    const amd = amdStatus.get(r.po_id);
    const s = lineState(r, { status: r.po_status, ack_due_at: r.ack_due_at, sap_change_pending: r.sap_change_pending }, { asn: asnPos.has(r.po_id), buyerTouchedAfterAck: buyerTouched, amendmentStatus: amd?.status ?? null });
    const escLevel = f.filter((x) => x.kind === 'Escalation' && x.created_at >= cs).reduce((m, x) => Math.max(m, Number(x.meta?.level ?? 0)), 0);
    const reminders = f.filter((x) => x.kind === 'Reminder' && x.created_at >= cs).length;
    return {
      id: r.id, po_id: r.po_id, po_no: r.po_no, item: r.item, ref: `${r.po_no}/${r.item}`, po_date: r.po_date, rfq_date: r.rfq_date, po_status: r.po_status,
      version: r.version, urgency: r.urgency, plant: r.plant, buyer_id: r.buyer_id, buyer_name: r.buyer_name, vendor_id: r.vendor_id, vendor_name: r.vendor_name,
      vendor_code: r.vendor_code, material_code: r.material_code, material_group: r.material_group, description: r.description, qty: r.qty, uom: r.uom,
      unit_price: priced ? r.unit_price : null, line_value: priced ? round2(r.qty * r.unit_price) : null,
      delivery_date: r.delivery_date, ack_status: r.ack_status, accepted_qty: r.accepted_qty, commit_date: r.commit_date, first_commit_date: r.first_commit_date,
      ack_at: r.ack_at, ack_due_at: r.ack_due_at, viewed_at: r.viewed_at, received_qty: r.received_qty, invoiced_qty: r.invoiced_qty, status: r.status,
      delay_reason: r.delay_reason, next_action_date: r.next_action_date, pr_ref: r.pr_no ? `${r.pr_no}/${r.pr_item}` : null, pr_line_id: r.pr_line_id,
      requisitioner_name: internal ? r.requisitioner_name : null, deemed_accepted: r.deemed_accepted, sap_change_pending: r.sap_change_pending,
      amendment: amd ? { amd_no: amd.amd_no, status: amd.status } : null,
      ...s, escalation_level: escLevel, reminders, last_response_at: lastResponse?.created_at ?? null,
      last_followup: last ? { kind: last.kind, note: last.note, at: last.created_at, by: last.user_name ?? 'System' } : null,
      closed: !OPEN_PO.includes(r.po_status) || DONE_LINE.includes(r.status) || ['Rejected', 'Cancelled'].includes(r.ack_status),
      synced_at: r.synced_at,
    };
  });
  const tab = q.tab ?? 'all';
  const filtered = out.filter((r) => tab === 'needs' ? r.needs_action : tab === 'open' ? !r.closed || (r.ack_status === 'Rejected' && OPEN_PO.includes(r.po_status)) : tab === 'closed' ? r.closed && !(r.ack_status === 'Rejected' && OPEN_PO.includes(r.po_status)) : true);
  return filtered;
}
export type LineListRow = ReturnType<typeof listLines>[number];

export function summary(actor: Actor) {
  const rows = listLines(actor, {});
  const open = rows.filter((r) => !r.closed);
  return {
    needs_action: rows.filter((r) => r.needs_action).length,
    open_lines: open.length,
    open_pos: new Set(open.map((r) => r.po_id)).size,
    pending_ack: open.filter((r) => PENDING_ACK.includes(r.ack_status)).length,
    ack_overdue: open.filter((r) => r.ack_overdue).length,
    overdue: open.filter((r) => r.overdue).length,
    rejected: rows.filter((r) => r.ack_status === 'Rejected' && OPEN_PO.includes(r.po_status)).length,
    partial: open.filter((r) => r.ack_status === 'Partially accepted').length,
    deemed: rows.filter((r) => r.ack_status === 'Deemed accepted').length,
    escalated: new Set(open.filter((r) => r.escalation_level >= 2).map((r) => r.po_id)).size,
    amendments: scalar<number>("SELECT COUNT(*) FROM po_amendments WHERE status IN ('Requested','Approved','Changed in SAP','Republished')") ?? 0,
    counts: {
      needs: rows.filter((r) => r.needs_action).length,
      open: rows.filter((r) => !r.closed || (r.ack_status === 'Rejected' && OPEN_PO.includes(r.po_status))).length,
      closed: rows.filter((r) => r.closed && !(r.ack_status === 'Rejected' && OPEN_PO.includes(r.po_status))).length,
      all: rows.length,
    },
  };
}

/** Small read helper for other modules (ASN, invoices, disputes, reports). */
export function poSummary(poId: number) {
  const po = getPo(poId);
  if (!po) return null;
  const vendor = get<{ name: string; sap_code: string | null }>('SELECT name, sap_code FROM vendors WHERE id = ?', po.vendor_id);
  const lines = linesOf(poId).map((l) => ({
    id: l.id, item: l.item, description: l.description, qty: l.qty, uom: l.uom, unit_price: l.unit_price, gst_rate: l.gst_rate, freight: l.freight,
    delivery_date: l.delivery_date, ack_status: l.ack_status, accepted_qty: l.accepted_qty, commit_date: l.commit_date, received_qty: l.received_qty,
    invoiced_qty: l.invoiced_qty, status: l.status, open_qty: lineState(l, po).open_qty,
  }));
  return {
    id: po.id, po_no: po.po_no, version: po.version, status: po.status, vendor_id: po.vendor_id, vendor_name: vendor?.name ?? null, vendor_code: vendor?.sap_code ?? null,
    buyer_id: po.buyer_id, plant: po.plant, po_date: po.po_date, urgency: po.urgency, delivery_terms: po.delivery_terms, payment_terms: po.payment_terms,
    freight_terms: po.freight_terms, total_value: po.total_value, sap_change_pending: !!po.sap_change_pending, deemed_accepted: !!po.deemed_accepted,
    acknowledged: lines.every((l) => !PENDING_ACK.includes(l.ack_status)), lines,
  };
}

export function listVendorPos(actor: Actor) {
  const rows = all<PoRow & { plant_name: string | null }>("SELECT p.*, pl.name AS plant_name FROM pos p LEFT JOIN plants pl ON pl.code = p.plant WHERE p.vendor_id = ? AND p.sap_released = 1 ORDER BY p.po_date DESC, p.po_no DESC", actor.vendorId);
  return rows.map((po) => {
    const lines = linesOf(po.id);
    const pending = lines.filter((l) => PENDING_ACK.includes(l.ack_status) && OPEN_PO.includes(po.status) && l.status !== 'Cancelled');
    const open = lines.filter((l) => lineState(l, po).active);
    const nextDel = open.map((l) => l.commit_date ?? l.delivery_date).sort()[0] ?? null;
    const awaitingCancelAck = get<{ id: number; amd_no: string }>("SELECT id, amd_no FROM po_amendments WHERE po_id = ? AND type = 'Cancel' AND status = 'Republished'", po.id);
    return {
      id: po.id, po_no: po.po_no, po_date: po.po_date, status: po.status, version: po.version, urgency: po.urgency, plant: po.plant, plant_name: po.plant_name,
      total_value: po.total_value, lines: lines.length, pending_ack: pending.length, reack: pending.some((l) => l.ack_status === 'Pending re-acknowledgement'),
      ack_due_at: po.ack_due_at, viewed_at: po.viewed_at, next_delivery: nextDel, open_lines: open.length, delivery_terms: po.delivery_terms,
      to_acknowledge: pending.length > 0 || !!awaitingCancelAck, cancel_ack: awaitingCancelAck ? awaitingCancelAck.amd_no : null,
      ack_overdue: pending.length > 0 && !!po.ack_due_at && po.ack_due_at < now(),
    };
  }).sort((a, b) => Number(b.to_acknowledge) - Number(a.to_acknowledge) || (b.po_date.localeCompare(a.po_date)) || b.po_no.localeCompare(a.po_no));
}

/** PO detail for internal users, requisitioners (no prices) and vendors (vendor-safe). */
export function poDetail(actor: Actor, id: number) {
  const po = mustSee(actor, id);
  const vendorView = actor.role === 'VEN';
  const priced = vendorView || actor.perms.has('po.view');
  const ownPr = !vendorView && !actor.perms.has('po.view');
  const vendor = get<Record<string, unknown>>('SELECT id, name, sap_code, gstin, pan, address, city, state, contact_name, contact_email, contact_phone, msme_category FROM vendors WHERE id = ?', po.vendor_id)!;
  const plant = get<{ code: string; name: string; gstin: string; ship_to_address: string; city: string; state: string }>('SELECT * FROM plants WHERE code = ?', po.plant);
  const buyer = po.buyer_id ? get<{ id: number; name: string; email: string; phone: string; manager_id: number | null }>('SELECT id, name, email, phone, manager_id FROM users WHERE id = ?', po.buyer_id) : undefined;
  const manager = !vendorView && buyer?.manager_id ? get<{ id: number; name: string }>('SELECT id, name FROM users WHERE id = ?', buyer.manager_id) : undefined;
  const contract = po.contract_id ? get<{ id: number; contract_no: string; type: string; sap_oa_no: string }>('SELECT id, contract_no, type, sap_oa_no FROM contracts WHERE id = ?', po.contract_id) : undefined;
  const rfq = !vendorView && po.rfq_id ? get<{ id: number; rfq_no: string }>('SELECT id, rfq_no FROM rfqs WHERE id = ?', po.rfq_id) : undefined;
  const asn = hasLiveAsn(po.id);
  const fusAll = all<FollowupRow & { user_name: string | null; user_vendor: number | null }>('SELECT f.*, u.name AS user_name, u.vendor_id AS user_vendor FROM po_followups f LEFT JOIN users u ON u.id = f.user_id WHERE f.po_id = ? ORDER BY f.created_at DESC, f.id DESC', po.id);
  const amds = all<AmendmentRow & { requested_by_name: string | null }>('SELECT a.*, u.name AS requested_by_name FROM po_amendments a LEFT JOIN users u ON u.id = a.requested_by WHERE a.po_id = ? ORDER BY a.id DESC', po.id);
  const openAmd = amds.find((a) => ['Requested', 'Approved', 'Changed in SAP', 'Republished'].includes(a.status));
  const prMap = new Map(all<{ id: number; pr_no: string; item: number; requisitioner_id: number | null; requisitioner_name: string | null; priority: string }>(
    'SELECT pr.id, pr.pr_no, pr.item, pr.requisitioner_id, u.name AS requisitioner_name, pr.priority FROM pr_lines pr LEFT JOIN users u ON u.id = pr.requisitioner_id WHERE pr.id IN (SELECT pr_line_id FROM po_lines WHERE po_id = ?)', po.id,
  ).map((r) => [r.id, r] as const));
  const sapMode = cfg<boolean>('sap.write.ack');
  const lines = linesOf(po.id).map((l) => {
    const pr = l.pr_line_id ? prMap.get(l.pr_line_id) : undefined;
    const mat = l.material_id ? get<{ code: string; material_group: string; hsn: string }>('SELECT code, material_group, hsn FROM materials WHERE id = ?', l.material_id) : undefined;
    const buyerTouched = !!l.ack_at && fusAll.some((x) => x.po_line_id === l.id && x.user_id === po.buyer_id && x.created_at > l.ack_at! && x.kind !== 'Reminder');
    const st = lineState(l, po, { asn, buyerTouchedAfterAck: buyerTouched, amendmentStatus: openAmd?.status ?? null });
    const history = fusAll.filter((f) => f.po_line_id === l.id && f.commit_date).map((f) => ({ at: f.created_at, commit_date: f.commit_date, delay_reason: f.delay_reason, by: f.user_name ?? 'System', kind: f.kind, type: f.meta?.type ?? null, old: f.meta?.old ?? null })).reverse();
    return {
      ...l, unit_price: priced ? l.unit_price : null, freight: priced ? l.freight : null, line_value: priced ? round2(l.qty * l.unit_price) : null,
      material_code: mat?.code ?? null, material_group: mat?.material_group ?? null, hsn: mat?.hsn ?? null,
      pr_ref: pr ? `${pr.pr_no}/${pr.item}` : null, pr_line_id: l.pr_line_id, requisitioner_name: vendorView ? null : pr?.requisitioner_name ?? null,
      own_pr: ownPr ? pr?.requisitioner_id === actor.id : undefined,
      ...st, commitment_history: history, sap_ack: sapMode || sapAckStatus(po, l) ? sapAckStatus(po, l) : null,
    };
  });
  const visibleFollowups = fusAll.filter((f) => (!vendorView && !ownPr) || f.kind === 'Vendor update' || f.kind === 'Reminder' || (f.kind === 'System' && ['republished', 'deemed'].includes(f.meta?.type)));
  const asns = all<{ id: number; asn_no: string; status: string; dispatch_date: string | null; expected_date: string | null; transporter: string | null; lr_no: string | null; created_at: string }>(
    `SELECT id, asn_no, status, dispatch_date, expected_date, transporter, lr_no, created_at FROM asns WHERE po_id = ? ${vendorView ? '' : "AND status != 'Draft'"} ORDER BY id DESC`, po.id,
  );
  const grns = all<{ grn_no: string; posting_date: string; qty: number; value: number | null; item: number; is_service: number }>(
    'SELECT g.grn_no, g.posting_date, g.qty, g.value, l.item, g.is_service FROM grns g JOIN po_lines l ON l.id = g.po_line_id WHERE g.po_id = ? ORDER BY g.posting_date DESC, l.item', po.id,
  ).map((g) => ({ ...g, value: priced ? g.value : null }));
  const showInvoices = vendorView || actor.perms.has('inv.view');
  const invoices = showInvoices ? all<{ id: number; inv_ref: string; vendor_invoice_no: string | null; invoice_date: string | null; status: string; total_value: number | null }>(
    'SELECT id, inv_ref, vendor_invoice_no, invoice_date, status, total_value FROM invoices WHERE po_id = ? ORDER BY id DESC', po.id,
  ) : [];
  const disputes = (vendorView || actor.perms.has('dsp.view')) ? all<{ id: number; dsp_no: string; type: string; status: string; owner_party: string | null; item: number | null; created_at: string }>(
    'SELECT d.id, d.dsp_no, d.type, d.status, d.owner_party, l.item, d.created_at FROM disputes d LEFT JOIN po_lines l ON l.id = d.po_line_id WHERE d.po_id = ? ORDER BY d.id DESC', po.id,
  ) : [];
  const amendments = amds.filter((a) => !vendorView || a.raised_by_vendor || ['Changed in SAP', 'Republished', 'Re-acknowledged'].includes(a.status)).map((a) => {
    const approvals = vendorView ? [] : all<{ id: number; req_no: string; type: string; status: string; current_level: number; created_at: string; decided_at: string | null }>(
      "SELECT id, req_no, type, status, current_level, created_at, decided_at FROM approvals WHERE object_type = 'po_amendment' AND object_id = ? ORDER BY id", a.id,
    );
    const ch = a.changes;
    const lines_ = ownPr ? ch.lines.map((c) => ({ ...c, old: { ...c.old, unit_price: null }, new: { ...c.new, unit_price: c.new.unit_price != null ? null : undefined } })) : ch.lines;
    return {
      id: a.id, amd_no: a.amd_no, type: a.type, status: a.status, reason: a.reason, raised_by_vendor: !!a.raised_by_vendor, requested_by: a.requested_by,
      requested_by_name: a.requested_by_name, created_at: a.created_at, sap_changed_at: a.sap_changed_at, reack_at: a.reack_at, approvals,
      summary: ownPr && a.type === 'Price' ? 'Price change' : changeSummary(a.type, ch),
      changes: { ...ch, lines: lines_, value_delta: priced ? ch.value_delta : null, confirmations: vendorView ? { vendor: ch.confirmations.vendor } : ch.confirmations },
    };
  });
  const pubs = all<{ version: number; kind: string; published_at: string; amendment_id: number | null; recipients: number }>('SELECT version, kind, published_at, amendment_id, recipients FROM po_publications WHERE po_id = ? ORDER BY version', po.id);
  const goods = round2(linesOf(po.id).filter((l) => l.status !== 'Cancelled').reduce((s, l) => s + l.qty * l.unit_price, 0));
  const gst = round2(linesOf(po.id).filter((l) => l.status !== 'Cancelled').reduce((s, l) => s + l.qty * l.unit_price * (l.gst_rate ?? 0) / 100, 0));
  const freight = round2(linesOf(po.id).filter((l) => l.status !== 'Cancelled').reduce((s, l) => s + (l.freight ?? 0), 0));
  const fresh = staleInfo('INT-M07', po.synced_at);
  return {
    id: po.id, po_no: po.po_no, po_date: po.po_date, status: po.status, version: po.version, urgency: po.urgency, plant: po.plant,
    delivery_terms: po.delivery_terms, payment_terms: po.payment_terms, freight_terms: po.freight_terms, currency: po.currency,
    total_value: priced ? po.total_value : null, totals: priced ? { goods, gst, freight, total: round2(goods + gst + freight) } : null,
    rfq_date: po.rfq_date, published_at: po.published_at, viewed_at: po.viewed_at, ack_due_at: po.ack_due_at, deemed_accepted: !!po.deemed_accepted,
    sap_change_pending: !!po.sap_change_pending, synced_at: po.synced_at, closed_at: po.closed_at, stale: fresh.stale, freshness_minutes: fresh.thresholdMinutes,
    vendor: vendorView ? { id: vendor.id, name: vendor.name, sap_code: vendor.sap_code, gstin: vendor.gstin } : vendor,
    plant_info: plant ?? null, buyer: buyer ? { id: buyer.id, name: buyer.name, email: buyer.email, phone: vendorView ? null : buyer.phone } : null,
    buyer_manager: manager ?? null, contract: contract ?? null, rfq: rfq ?? null,
    lines, followups: visibleFollowups.map((f) => ({ id: f.id, po_line_id: f.po_line_id, item: lines.find((l) => l.id === f.po_line_id)?.item ?? null, kind: f.kind, note: f.note, commit_date: f.commit_date, delay_reason: f.delay_reason, next_action_date: f.next_action_date, created_at: f.created_at, user_name: f.user_name ?? 'System', by_vendor: !!f.user_vendor, meta: vendorView || ownPr ? { type: f.meta?.type ?? null } : f.meta })),
    amendments, publications: pubs, asns, grns, invoices, disputes,
    escalation_level: escalationLevel(po), reminders: fusAll.filter((f) => f.kind === 'Reminder' && f.created_at >= cycleStart(po)).length,
    in_dispatch: asn, open_amendment: openAmd ? { id: openAmd.id, amd_no: openAmd.amd_no, status: openAmd.status, type: openAmd.type } : null,
    config: {
      sap_write_ack: sapMode, deemed_acceptance: cfg<{ enabled: boolean; hours: number }>('po.deemed_acceptance'), reminders: reminderCfg(),
      escalation: cfg<{ level2_days: number; level3_days: number }>('po.escalation'), delay_reasons: cfg<string[]>('po.delay_reasons'),
    },
    view: vendorView ? 'vendor' : ownPr ? 'requisitioner' : 'internal',
  };
}
export type PoDetail = ReturnType<typeof poDetail>;

// ------------------------------------------------------------------ reports (RPT-04 / RPT-05 data)
/** RPT-04 open PO: vendor, buyer, plant, material, urgency, open qty, delivery date, commitment, delay reason, overdue. */
export function openPoReport(actor: Actor, q: Record<string, string | undefined> = {}) {
  return listLines(actor, { ...q, tab: 'open' }).map((r) => ({
    po_no: r.po_no, item: r.item, po_date: r.po_date, vendor: r.vendor_name, vendor_code: r.vendor_code, buyer: r.buyer_name, plant: r.plant,
    material_code: r.material_code, material_group: r.material_group, description: r.description, urgency: r.urgency, qty: r.qty, open_qty: r.open_qty, uom: r.uom,
    delivery_date: r.delivery_date, commitment: r.commit_date, first_commitment: r.first_commit_date, ack_status: r.ack_status, delay_reason: r.delay_reason,
    overdue: r.overdue, overdue_days: r.overdue_days, next_action: r.next_action, next_action_date: r.next_action_date, link: `/pos/${r.po_id}`,
  }));
}

/** RPT-05 vendor follow-up: pending ack, pending dispatch, reminder count, latest response, next action — per PO. */
export function followupReport(actor: Actor, q: Record<string, string | undefined> = {}) {
  const rows = listLines(actor, { ...q, tab: 'open' });
  const by = new Map<number, typeof rows>();
  for (const r of rows) by.set(r.po_id, [...(by.get(r.po_id) ?? []), r]);
  return [...by.values()].map((ls) => {
    const r = ls[0];
    const nextDates = ls.map((x) => x.next_action_date).filter(Boolean).sort();
    return {
      po_id: r.po_id, po_no: r.po_no, po_date: r.po_date, vendor: r.vendor_name, buyer: r.buyer_name, plant: r.plant, urgency: r.urgency,
      pending_ack: ls.filter((x) => PENDING_ACK.includes(x.ack_status)).length, pending_dispatch: ls.filter((x) => ACKED.includes(x.ack_status) && x.open_qty > 0).length,
      overdue: ls.filter((x) => x.overdue).length, reminders: r.reminders, escalation_level: r.escalation_level, latest_response: r.last_response_at,
      next_action: ls.find((x) => x.needs_action)?.next_action ?? ls[0].next_action, next_action_date: nextDates[0] ?? null, link: `/pos/${r.po_id}`,
    };
  });
}

/** FR-POM-03 non-response report: lines deemed accepted or still unacknowledged past the due time. */
export function nonResponseReport(actor: Actor) {
  return listLines(actor, {}).filter((r) => r.ack_status === 'Deemed accepted' || (PENDING_ACK.includes(r.ack_status) && r.ack_overdue)).map((r) => ({
    po_id: r.po_id, po_no: r.po_no, item: r.item, vendor: r.vendor_name, buyer: r.buyer_name, plant: r.plant, urgency: r.urgency, ack_status: r.ack_status,
    published: r.ack_due_at, ack_due_at: r.ack_due_at, reminders: r.reminders, escalation_level: r.escalation_level, link: `/pos/${r.po_id}`,
  }));
}
