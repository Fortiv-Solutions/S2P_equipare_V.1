/**
 * Module 8 — ASN, dispatch and logistics (PRD 7.8: FR-ASN-01..05, AC-ASN-01..03, WF-08).
 *  - ASN against acknowledged / deemed-accepted PO lines; qty ≤ acknowledged open qty + tolerance (FR-ASN-04).
 *  - Delivery terms, freight and transit risk defaulted from the PO (FR-ASN-02); LR/AWB mandatory per term (AC-ASN-01).
 *  - Equipcare-arranged pickup for Ex-Works with pickup date / status and an overdue alert (FR-ASN-03, AC-ASN-03).
 *  - Submitted → In transit → Delivered when the GRN arrives from SAP (INT-M10); edits create versions; cancel with reason.
 * Disputes live in ./disputes.ts; `openDisputesForPo` is re-exported here for the invoice module (3WM-07, FR-DSP-05).
 */
import { all, get, insert, update, run, J, now, tx, round2, db } from '../../core/db.ts';
import { audit, diff } from '../../core/audit.ts';
import { notify } from '../../core/notify.ts';
import { cfg } from '../../core/config.ts';
import { badRequest, conflict, forbidden, notFound } from '../../core/http.ts';
import { assertVendorScope, plantAllowed, type Actor } from '../../core/auth.ts';
import { linkAttachments } from '../../core/files.ts';
import { nextNo } from '../../core/numbering.ts';

export { openDisputesForPo } from './disputes.ts';

export const ASN_OPEN = ['Submitted', 'In transit'];
export const ACK_OK = ['Accepted', 'Partially accepted', 'Deemed accepted'];
export const PICKUP_STATUSES = ['Requested', 'Scheduled', 'Picked up', 'Failed'];
export type Term = 'FOR' | 'Ex-Works';

/** Tables this module needs beyond core/schema.ts (created idempotently at init). */
export function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS asn_versions (
      id INTEGER PRIMARY KEY, asn_id INTEGER NOT NULL, version INTEGER NOT NULL, snapshot_json TEXT, reason TEXT,
      created_by INTEGER, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS asn_grns (
      id INTEGER PRIMARY KEY, asn_id INTEGER NOT NULL, grn_no TEXT NOT NULL, matched_by TEXT, linked_at TEXT,
      UNIQUE (asn_id, grn_no)
    );
    CREATE INDEX IF NOT EXISTS ix_asns_po ON asns(po_id, status);
    CREATE INDEX IF NOT EXISTS ix_disputes_po ON disputes(po_id, status);
    CREATE INDEX IF NOT EXISTS ix_dispute_events ON dispute_events(dispute_id);
  `);
  const cols = all<{ name: string }>('PRAGMA table_info(disputes)').map((c) => c.name);
  if (!cols.includes('outcome_amount')) db.exec('ALTER TABLE disputes ADD COLUMN outcome_amount REAL');
}

// ------------------------------------------------------------------ types
export interface AsnLineInput { po_line_id: number; qty: number; packing?: string | null }
export interface AsnLineStored { po_line_id: number; item: number; qty: number; packing?: string | null }
export interface AsnRow {
  id: number; asn_no: string; po_id: number; vendor_id: number; plant: string; status: string;
  dispatch_date: string | null; expected_date: string | null; transporter: string | null; lr_no: string | null; vehicle_no: string | null;
  eway_bill: string | null; invoice_ref: string | null; packing_details: string | null; delivery_terms: Term; freight_mode: string | null;
  transit_risk: string | null; pickup_by: string; pickup_date: string | null; pickup_status: string | null; lines: AsnLineStored[] | null;
  version: number; cancel_reason: string | null; created_by: number | null; created_at: string; submitted_at: string | null; delivered_at: string | null;
}
interface PoRow {
  id: number; po_no: string; vendor_id: number; buyer_id: number | null; plant: string; po_date: string; status: string; delivery_terms: string | null;
  freight_terms: string | null; payment_terms: string | null; urgency: string; sap_change_pending: number; version: number; vendor_name: string; buyer_name: string | null;
}
export interface PoLineRow {
  id: number; po_id: number; item: number; pr_line_id: number | null; description: string; qty: number; uom: string; unit_price: number; gst_rate: number;
  delivery_date: string; ack_status: string; accepted_qty: number | null; commit_date: string | null; received_qty: number; status: string; material_code?: string | null;
}

export const termKey = (t?: string | null): Term => (/ex[\s-]?works|exw/i.test(t ?? '') ? 'Ex-Works' : 'FOR');
const today = () => now().slice(0, 10);
const isDate = (s?: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime());

export function getAsn(id: number) {
  return get<AsnRow>('SELECT * FROM asns WHERE id = ?', id);
}
function mustAsn(id: number) {
  const a = getAsn(id);
  if (!a) throw notFound('ASN');
  return a;
}
export function getPo(id: number) {
  return get<PoRow>('SELECT p.*, v.name AS vendor_name, b.name AS buyer_name FROM pos p JOIN vendors v ON v.id = p.vendor_id LEFT JOIN users b ON b.id = p.buyer_id WHERE p.id = ?', id);
}
export function poLines(poId: number) {
  return all<PoLineRow>('SELECT l.*, m.code AS material_code FROM po_lines l LEFT JOIN materials m ON m.id = l.material_id WHERE l.po_id = ? ORDER BY l.item', poId);
}

/** Requisitioners see ASNs / disputes only for POs carrying their own PR lines ("V own PR", PRD 6.2). */
export function ownPrPoIds(actor: Actor) {
  return all<{ po_id: number }>('SELECT DISTINCT l.po_id FROM po_lines l JOIN pr_lines pr ON pr.id = l.pr_line_id WHERE pr.requisitioner_id = ?', actor.id).map((r) => r.po_id);
}
export const isOwnPrOnly = (actor: Actor) => actor.role === 'REQ';

/** Throws 404 when the actor may not see this PO's logistics records (vendor isolation, own-PR, plant scope). */
export function assertPoAccess(actor: Actor, po: { id: number; vendor_id: number; plant: string }, objectType: string, objectId: number) {
  if (actor.role === 'VEN') return assertVendorScope(actor, po.vendor_id, objectType, objectId);
  if (isOwnPrOnly(actor) && !ownPrPoIds(actor).includes(po.id)) throw notFound(objectType === 'dispute' ? 'Dispute' : 'ASN');
  if (!plantAllowed(actor, po.plant)) throw notFound(objectType === 'dispute' ? 'Dispute' : 'ASN');
}

export function canAccessAsn(actor: Actor, asnId: number) {
  const a = getAsn(asnId);
  if (!a) return false;
  if (actor.role === 'VEN') return actor.vendorId === a.vendor_id;
  if (!actor.perms.has('asn.view')) return false;
  if (isOwnPrOnly(actor)) return ownPrPoIds(actor).includes(a.po_id);
  return plantAllowed(actor, a.plant);
}

// ------------------------------------------------------------------ quantities (FR-ASN-04)
export function acceptedQty(l: Pick<PoLineRow, 'ack_status' | 'accepted_qty' | 'qty'>) {
  if (!ACK_OK.includes(l.ack_status)) return 0;
  if (l.ack_status === 'Deemed accepted') return l.qty;
  return l.accepted_qty ?? l.qty;
}

/** Qty on other open ASNs (Submitted / In transit) for each PO line of a PO. */
function reservedByLine(poId: number, excludeAsnId?: number) {
  const map = new Map<number, number>();
  for (const a of all<{ id: number; lines: AsnLineStored[] | null }>(`SELECT id, lines_json FROM asns WHERE po_id = ? AND status IN ('Submitted','In transit')`, poId)) {
    if (a.id === excludeAsnId) continue;
    for (const l of a.lines ?? []) map.set(l.po_line_id, (map.get(l.po_line_id) ?? 0) + l.qty);
  }
  return map;
}

export function availability(poId: number, excludeAsnId?: number) {
  const tol = cfg<number>('asn.qty_tolerance_pct');
  const reserved = reservedByLine(poId, excludeAsnId);
  return poLines(poId).map((l) => {
    const accepted = acceptedQty(l);
    const inTransit = reserved.get(l.id) ?? 0;
    const open = Math.max(0, round2(accepted - (l.received_qty ?? 0) - inTransit));
    const max = Math.floor(open * (1 + tol / 100) * 1000) / 1000;
    let reason: string | null = null;
    if (l.status === 'Cancelled' || l.ack_status === 'Cancelled') reason = 'Line cancelled in SAP';
    else if (l.ack_status === 'Rejected') reason = 'You rejected this line';
    else if (!ACK_OK.includes(l.ack_status)) reason = l.ack_status === 'Pending re-acknowledgement' ? 'Re-acknowledge the amended line first' : 'Acknowledge this line first';
    else if (open <= 0) reason = inTransit > 0 ? 'Remaining quantity is already on another ASN' : 'Fully received';
    return {
      po_line_id: l.id, item: l.item, description: l.description, material_code: l.material_code ?? null, uom: l.uom, ordered: l.qty, ack_status: l.ack_status,
      accepted, received: l.received_qty ?? 0, in_transit: inTransit, open, max, delivery_date: l.commit_date ?? l.delivery_date, unit_price: l.unit_price,
      eligible: !reason, reason,
    };
  });
}

// ------------------------------------------------------------------ defaults from PO (FR-ASN-02)
export interface TermDefaults { freight_mode: string; transit_risk: string; pickup_by: string }
export function termDefaults(po: Pick<PoRow, 'delivery_terms' | 'freight_terms'>) {
  const term = termKey(po.delivery_terms);
  const map = cfg<Record<Term, TermDefaults>>('asn.term_defaults');
  const d = map[term] ?? { freight_mode: 'Paid', transit_risk: 'Vendor', pickup_by: 'Vendor' };
  // The PO's own freight term wins over the generic default.
  const freight = /to pay|payable/i.test(po.freight_terms ?? '') ? 'To pay' : /paid/i.test(po.freight_terms ?? '') ? 'Paid' : d.freight_mode;
  return { delivery_terms: term, freight_mode: freight, transit_risk: d.transit_risk, pickup_by: d.pickup_by };
}
export const lrMandatory = (term: Term) => !!cfg<Record<Term, boolean>>('asn.lr_mandatory')[term];

export function prefill(actor: Actor, poId: number, excludeAsnId?: number) {
  const po = getPo(poId);
  if (!po) throw notFound('Purchase order');
  assertVendorScope(actor, po.vendor_id, 'po', poId);
  const plant = get<{ code: string; name: string; ship_to_address: string | null }>('SELECT code, name, ship_to_address FROM plants WHERE code = ?', po.plant);
  const d = termDefaults(po);
  const lines = availability(poId, excludeAsnId);
  return {
    po: { id: po.id, po_no: po.po_no, plant: po.plant, plant_name: plant?.name ?? po.plant, ship_to: plant?.ship_to_address ?? null, po_date: po.po_date, status: po.status, urgency: po.urgency, delivery_terms_text: po.delivery_terms, freight_terms_text: po.freight_terms, payment_terms: po.payment_terms, buyer_name: po.buyer_name, vendor_name: po.vendor_name, sap_change_pending: !!po.sap_change_pending },
    defaults: d,
    lr_mandatory: lrMandatory(d.delivery_terms),
    tolerance_pct: cfg<number>('asn.qty_tolerance_pct'),
    lines,
    blocked: po.status === 'Cancelled' ? 'This PO is cancelled in SAP.' : po.status === 'Closed' ? 'This PO is fully received and closed.' : po.sap_change_pending ? 'A change to this PO is pending in SAP. Create the ASN after the amended PO arrives.' : !lines.some((l) => l.eligible) ? 'No line has an acknowledged open quantity to dispatch.' : null,
  };
}

/** Vendor's POs that still have quantity to dispatch (SCR-VPT-06 entry). */
export function eligiblePos(actor: Actor) {
  const pos = all<{ id: number; po_no: string; plant: string; po_date: string; delivery_terms: string | null; urgency: string; status: string }>(
    "SELECT id, po_no, plant, po_date, delivery_terms, urgency, status FROM pos WHERE vendor_id = ? AND status NOT IN ('Cancelled','Closed') ORDER BY po_date DESC", actor.vendorId ?? -1,
  );
  return pos.map((p) => {
    const av = availability(p.id);
    return { ...p, term: termKey(p.delivery_terms), lines: av.length, dispatchable: av.filter((l) => l.eligible).length, open_qty: round2(av.reduce((s, l) => s + (l.eligible ? l.open : 0), 0)), pending_ack: av.filter((l) => !ACK_OK.includes(l.ack_status) && l.ack_status !== 'Rejected' && l.ack_status !== 'Cancelled').length };
  });
}

// ------------------------------------------------------------------ create / submit / revise (FR-ASN-01..04)
export interface AsnInput {
  po_id: number;
  dispatch_date?: string | null;
  expected_date?: string | null;
  transporter?: string | null;
  lr_no?: string | null;
  vehicle_no?: string | null;
  eway_bill?: string | null;
  invoice_ref?: string | null;
  packing_details?: string | null;
  pickup_by?: 'Vendor' | 'Equipcare' | null;
  lines: AsnLineInput[];
  attachment_ids?: number[];
}

const clean = (s?: string | null) => (s == null ? null : s.trim() || null);

function validate(po: PoRow, input: AsnInput, submit: boolean, excludeAsnId?: number) {
  const fields: Record<string, string> = {};
  if (po.status === 'Cancelled') throw conflict('This PO is cancelled in SAP. No ASN can be created against it.');
  if (po.status === 'Closed') throw conflict('This PO is fully received and closed.');
  if (po.sap_change_pending) throw conflict('A change to this PO is pending in SAP. Create or edit the ASN after the amended PO arrives.');
  const d = termDefaults(po);
  const pickupBy = d.delivery_terms === 'Ex-Works' ? (input.pickup_by ?? d.pickup_by) : 'Vendor';
  if (!input.lines?.length) throw badRequest('Add at least one PO line with a dispatch quantity.', { lines: 'Add a line' });
  const seen = new Set<number>();
  const av = new Map(availability(po.id, excludeAsnId).map((l) => [l.po_line_id, l]));
  const lines: AsnLineStored[] = [];
  input.lines.forEach((l, i) => {
    const a = av.get(l.po_line_id);
    if (!a) { fields[`lines.${i}.po_line_id`] = 'Line is not on this PO'; return; }
    if (seen.has(l.po_line_id)) { fields[`lines.${i}.po_line_id`] = `Line ${a.item} is listed twice`; return; }
    seen.add(l.po_line_id);
    if (!(l.qty > 0)) { fields[`lines.${i}.qty`] = `Enter a quantity above 0 for line ${a.item}`; return; }
    if (!a.eligible) { fields[`lines.${i}.qty`] = `Line ${a.item}: ${a.reason}`; return; }
    if (l.qty > a.max) {
      fields[`lines.${i}.qty`] = `Line ${a.item}: ${l.qty} ${a.uom} is more than the acknowledged open quantity (${a.open} ${a.uom}${a.max > a.open ? `, ${a.max} with tolerance` : ''}). Reduce the quantity or ask the buyer to amend the PO.`;
      return;
    }
    lines.push({ po_line_id: l.po_line_id, item: a.item, qty: l.qty, packing: clean(l.packing) });
  });
  const dispatch = clean(input.dispatch_date);
  const expected = clean(input.expected_date);
  if (dispatch && !isDate(dispatch)) fields.dispatch_date = 'Enter a valid date';
  if (expected && !isDate(expected)) fields.expected_date = 'Enter a valid date';
  if (dispatch && expected && expected < dispatch) fields.expected_date = 'Expected delivery cannot be before the dispatch date';
  if (submit) {
    if (!dispatch) fields.dispatch_date = pickupBy === 'Equipcare' ? 'Enter the date the material is ready for pickup' : 'Enter the dispatch date';
    if (!expected) fields.expected_date = 'Enter the expected delivery date';
    // AC-ASN-01: LR/AWB mandatory per delivery term (Q 7.8). With Equipcare pickup the LR comes from Equipcare's transporter.
    if (pickupBy === 'Vendor' && lrMandatory(d.delivery_terms)) {
      if (!clean(input.lr_no)) fields.lr_no = `LR / AWB number is mandatory for ${d.delivery_terms} dispatches`;
      if (!clean(input.transporter)) fields.transporter = 'Enter the transporter or courier';
    }
  }
  const keys = Object.keys(fields);
  if (keys.length) {
    const first = fields[keys[0]];
    throw badRequest(keys.length > 1 ? `${first} (and ${keys.length - 1} more problem${keys.length > 2 ? 's' : ''})` : first, fields);
  }
  return { lines, d, pickupBy, dispatch, expected };
}

function fieldsFrom(po: PoRow, input: AsnInput, v: ReturnType<typeof validate>) {
  return {
    po_id: po.id, vendor_id: po.vendor_id, plant: po.plant,
    dispatch_date: v.dispatch, expected_date: v.expected, transporter: clean(input.transporter), lr_no: clean(input.lr_no), vehicle_no: clean(input.vehicle_no)?.toUpperCase() ?? null,
    eway_bill: clean(input.eway_bill), invoice_ref: clean(input.invoice_ref), packing_details: clean(input.packing_details),
    delivery_terms: v.d.delivery_terms, freight_mode: v.d.freight_mode, transit_risk: v.d.transit_risk, pickup_by: v.pickupBy,
    lines_json: J(v.lines),
  };
}

export function createAsn(actor: Actor, input: AsnInput, submit: boolean) {
  const po = getPo(input.po_id);
  if (!po) throw notFound('Purchase order');
  assertVendorScope(actor, po.vendor_id, 'po', po.id);
  const v = validate(po, input, submit);
  return tx(() => {
    const ts = now();
    const asnNo = nextNo('ASN');
    const id = insert('asns', { asn_no: asnNo, ...fieldsFrom(po, input, v), status: 'Draft', version: 1, created_by: actor.id, created_at: ts, pickup_status: v.pickupBy === 'Equipcare' ? 'Requested' : null });
    if (input.attachment_ids?.length) linkAttachments(input.attachment_ids, 'asn', id);
    audit(actor, { action: 'asn.created', objectType: 'asn', objectId: id, objectRef: asnNo, after: { po_no: po.po_no, lines: v.lines, delivery_terms: v.d.delivery_terms, pickup_by: v.pickupBy, documents: input.attachment_ids?.length ?? 0 } });
    if (submit) doSubmit(actor, id);
    return getAsn(id)!;
  });
}

function doSubmit(actor: Actor, id: number) {
  const a = getAsn(id)!;
  update('asns', id, { status: 'Submitted', submitted_at: now(), pickup_status: a.pickup_by === 'Equipcare' ? a.pickup_status ?? 'Requested' : a.pickup_status });
  refreshLineStatuses(a.po_id);
  audit(actor, { action: 'asn.submitted', objectType: 'asn', objectId: id, objectRef: a.asn_no, before: { status: a.status }, after: { status: 'Submitted', expected_date: a.expected_date } });
  notifyAsn(id, 'submitted');
}

export function submitAsn(actor: Actor, id: number) {
  const a = mustAsn(id);
  assertVendorScope(actor, a.vendor_id, 'asn', id);
  if (a.status !== 'Draft') throw conflict(`ASN ${a.asn_no} is already ${a.status.toLowerCase()}.`);
  const po = getPo(a.po_id)!;
  validate(po, inputFrom(a), true, id);
  return tx(() => { doSubmit(actor, id); return getAsn(id)!; });
}

function inputFrom(a: AsnRow): AsnInput {
  return {
    po_id: a.po_id, dispatch_date: a.dispatch_date, expected_date: a.expected_date, transporter: a.transporter, lr_no: a.lr_no, vehicle_no: a.vehicle_no,
    eway_bill: a.eway_bill, invoice_ref: a.invoice_ref, packing_details: a.packing_details, pickup_by: a.pickup_by as 'Vendor' | 'Equipcare',
    lines: (a.lines ?? []).map((l) => ({ po_line_id: l.po_line_id, qty: l.qty, packing: l.packing })),
  };
}

function snapshot(a: AsnRow) {
  const { id: _id, created_by: _c, ...rest } = a;
  return rest;
}

/** Edit: a draft is changed in place; a submitted / in-transit ASN gets a new version (audited, reason required). */
export function reviseAsn(actor: Actor, id: number, input: AsnInput, reason: string | undefined) {
  const a = mustAsn(id);
  assertVendorScope(actor, a.vendor_id, 'asn', id);
  if (!['Draft', ...ASN_OPEN].includes(a.status)) throw conflict(`ASN ${a.asn_no} is ${a.status.toLowerCase()} and can no longer be changed.`);
  if (input.po_id !== a.po_id) throw badRequest('An ASN cannot be moved to another PO. Cancel it and create a new one.');
  const po = getPo(a.po_id)!;
  const isDraft = a.status === 'Draft';
  if (!isDraft && (!reason || reason.trim().length < 10)) throw badRequest('Say why the dispatch details changed (at least 10 characters). Stores and the buyer see the new version.', { reason: 'Reason is required' });
  const v = validate(po, input, !isDraft, id);
  return tx(() => {
    const f = fieldsFrom(po, input, v);
    const before = snapshot(a) as Record<string, unknown>;
    if (isDraft) {
      update('asns', id, f);
    } else {
      insert('asn_versions', { asn_id: id, version: a.version, snapshot_json: J(before), reason: reason!.trim(), created_by: actor.id, created_at: now() });
      update('asns', id, { ...f, version: a.version + 1 });
    }
    if (input.attachment_ids?.length) linkAttachments(input.attachment_ids, 'asn', id);
    const after = snapshot(getAsn(id)!) as Record<string, unknown>;
    const d = diff(before, after);
    audit(actor, { action: isDraft ? 'asn.draft_updated' : 'asn.revised', objectType: 'asn', objectId: id, objectRef: a.asn_no, before: d.before, after: { ...d.after, ...(isDraft ? {} : { version: a.version + 1 }) }, reason: reason ?? null });
    if (!isDraft) {
      refreshLineStatuses(a.po_id);
      notifyAsn(id, 'revised', reason);
    }
    return getAsn(id)!;
  });
}

/** Vendor marks a vendor-arranged consignment as dispatched (Submitted → In transit). */
export function markDispatched(actor: Actor, id: number, input: { transporter?: string | null; lr_no?: string | null; vehicle_no?: string | null }) {
  const a = mustAsn(id);
  assertVendorScope(actor, a.vendor_id, 'asn', id);
  if (a.status !== 'Submitted') throw conflict(`ASN ${a.asn_no} is ${a.status.toLowerCase()}; only a submitted ASN can be marked dispatched.`);
  if (a.pickup_by === 'Equipcare') throw conflict('Equipcare arranges pickup for this ASN. The buyer records the pickup.');
  const lr = clean(input.lr_no) ?? a.lr_no;
  const transporter = clean(input.transporter) ?? a.transporter;
  if (lrMandatory(a.delivery_terms) && !lr) throw badRequest(`LR / AWB number is mandatory for ${a.delivery_terms} dispatches.`, { lr_no: 'LR / AWB is required' });
  update('asns', id, { status: 'In transit', lr_no: lr, transporter, vehicle_no: clean(input.vehicle_no)?.toUpperCase() ?? a.vehicle_no, dispatch_date: a.dispatch_date && a.dispatch_date <= today() ? a.dispatch_date : today() });
  audit(actor, { action: 'asn.in_transit', objectType: 'asn', objectId: id, objectRef: a.asn_no, before: { status: a.status, lr_no: a.lr_no }, after: { status: 'In transit', lr_no: lr } });
  return getAsn(id)!;
}

/** Equipcare-arranged pickup (FR-ASN-03): schedule, record pickup (→ In transit) or failure. */
export function updatePickup(actor: Actor, id: number, input: { action: 'schedule' | 'picked_up' | 'failed'; pickup_date?: string | null; transporter?: string | null; lr_no?: string | null; vehicle_no?: string | null; note?: string | null }) {
  const a = mustAsn(id);
  if (!canAccessAsn(actor, id)) throw notFound('ASN');
  if (a.pickup_by !== 'Equipcare') throw conflict('The vendor arranges transport for this ASN; there is no Equipcare pickup to update.');
  if (a.status !== 'Submitted') throw conflict(`ASN ${a.asn_no} is ${a.status.toLowerCase()}; pickup can only be updated before the material is collected.`);
  const po = getPo(a.po_id)!;
  return tx(() => {
    const before = { pickup_status: a.pickup_status, pickup_date: a.pickup_date, status: a.status };
    if (input.action === 'schedule') {
      if (!isDate(input.pickup_date)) throw badRequest('Choose the pickup date.', { pickup_date: 'Pickup date is required' });
      update('asns', id, { pickup_status: 'Scheduled', pickup_date: input.pickup_date, transporter: clean(input.transporter) ?? a.transporter });
      notify({ event: 'NTF-18', title: `Pickup scheduled for ${a.asn_no}`, body: `Equipcare will collect PO ${po.po_no} on ${input.pickup_date}${clean(input.transporter) ? ` (${clean(input.transporter)})` : ''}.`, link: `/vendor/asns/${id}`, vendorId: a.vendor_id, objectType: 'asn', objectId: id, dedupeKey: `NTF-18:pickup:${id}:${input.pickup_date}` });
    } else if (input.action === 'picked_up') {
      const lr = clean(input.lr_no) ?? a.lr_no;
      if (!lr) throw badRequest('Enter the LR / AWB number issued by the transporter at pickup.', { lr_no: 'LR / AWB is required' });
      update('asns', id, { pickup_status: 'Picked up', status: 'In transit', pickup_date: isDate(input.pickup_date) ? input.pickup_date : today(), lr_no: lr, transporter: clean(input.transporter) ?? a.transporter, vehicle_no: clean(input.vehicle_no)?.toUpperCase() ?? a.vehicle_no });
    } else {
      if (!input.note || input.note.trim().length < 10) throw badRequest('Say why the pickup failed (at least 10 characters).', { note: 'Reason is required' });
      update('asns', id, { pickup_status: 'Failed' });
      notify({ event: 'NTF-18', title: `Pickup failed: ${a.asn_no}`, body: input.note.trim(), link: `/asns/${id}`, users: [po.buyer_id], roles: ['STO'], plant: a.plant, objectType: 'asn', objectId: id, severity: 'danger', dedupeKey: `NTF-18:pickupfail:${id}:${now()}` });
    }
    const fresh = getAsn(id)!;
    audit(actor, { action: `asn.pickup_${input.action}`, objectType: 'asn', objectId: id, objectRef: a.asn_no, before, after: { pickup_status: fresh.pickup_status, pickup_date: fresh.pickup_date, status: fresh.status, lr_no: fresh.lr_no }, reason: clean(input.note) });
    return fresh;
  });
}

export function cancelAsn(actor: Actor, id: number, reason: string) {
  const a = mustAsn(id);
  if (actor.role === 'VEN') assertVendorScope(actor, a.vendor_id, 'asn', id);
  else if (!canAccessAsn(actor, id)) throw notFound('ASN');
  if (!['Draft', ...ASN_OPEN].includes(a.status)) throw conflict(`ASN ${a.asn_no} is ${a.status.toLowerCase()} and cannot be cancelled.`);
  return tx(() => {
    update('asns', id, { status: 'Cancelled', cancel_reason: reason });
    refreshLineStatuses(a.po_id);
    audit(actor, { action: 'asn.cancelled', objectType: 'asn', objectId: id, objectRef: a.asn_no, before: { status: a.status }, after: { status: 'Cancelled' }, reason });
    if (a.status !== 'Draft') notifyAsn(id, 'cancelled', reason, actor.role !== 'VEN');
    return getAsn(id)!;
  });
}

function notifyAsn(id: number, kind: 'submitted' | 'revised' | 'cancelled', reason?: string, byEquipcare = false) {
  const a = getAsn(id)!;
  const po = getPo(a.po_id)!;
  const qty = (a.lines ?? []).reduce((s, l) => s + l.qty, 0);
  const what = kind === 'submitted' ? 'ASN submitted' : kind === 'revised' ? `ASN revised (v${a.version})` : 'ASN cancelled';
  const body = kind === 'cancelled'
    ? `${po.vendor_name} · PO ${po.po_no} · ${reason ?? ''}`
    : `${po.vendor_name} · PO ${po.po_no} · ${(a.lines ?? []).length} line(s), ${qty} units · expected ${a.expected_date ?? '—'} at ${a.plant}${a.pickup_by === 'Equipcare' ? ' · Equipcare pickup' : ''}${reason ? ` · ${reason}` : ''}`;
  // NTF-21: plant stores users and the buyer.
  notify({ event: 'NTF-21', title: `${what}: ${a.asn_no}`, body, link: `/asns/${id}`, users: [po.buyer_id], roles: ['STO'], plant: a.plant, objectType: 'asn', objectId: id, severity: kind === 'cancelled' ? 'warning' : 'info', dedupeKey: `NTF-21:${id}:${kind}:${a.version}` });
  if (kind === 'cancelled' && byEquipcare) notify({ event: 'NTF-21', title: `Equipcare cancelled ${a.asn_no}`, body: reason ?? '', link: `/vendor/asns/${id}`, vendorId: a.vendor_id, objectType: 'asn', objectId: id, severity: 'warning' });
}

// ------------------------------------------------------------------ PO line status "In dispatch" (PRD 7.7 states)
export function refreshLineStatuses(poId: number) {
  const reserved = reservedByLine(poId);
  for (const l of poLines(poId)) {
    if (['Cancelled', 'Closed'].includes(l.status)) continue;
    const open = (reserved.get(l.id) ?? 0) > 0;
    const base = l.received_qty >= l.qty ? 'Received' : l.received_qty > 0 ? 'Partially received' : 'Published';
    if (open && ['Published', 'Partially received'].includes(l.status) && base !== 'Received') update('po_lines', l.id, { status: 'In dispatch' });
    else if (!open && l.status === 'In dispatch') update('po_lines', l.id, { status: base });
  }
}

// ------------------------------------------------------------------ GRN from SAP → Delivered (INT-M10)
/** Called from onSynced('GRN'): link each new GRN to its ASN (by asn_id, else by PO and plant) and mark it Delivered. */
export function onGrnSynced(rows: { id: number; isNew: boolean; payload: any }[]) {
  const seen = new Set<string>();
  for (const r of rows) {
    const p = r.payload ?? {};
    const key = `${p.grn_no}|${p.po_no}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const po = get<{ id: number }>('SELECT id FROM pos WHERE po_no = ?', p.po_no);
    if (!po) continue;
    let asn: AsnRow | undefined;
    let matchedBy = 'asn_id';
    if (p.asn_id) asn = getAsn(Number(p.asn_id));
    if (!asn) {
      matchedBy = 'po_plant';
      const items = new Set<number>((p.items ?? []).map((i: any) => Number(i.po_item)));
      const open = all<AsnRow>(`SELECT * FROM asns WHERE po_id = ? AND plant = ? AND status IN ('Submitted','In transit') ORDER BY COALESCE(expected_date, '9999'), id`, po.id, p.plant);
      asn = open.find((a) => (a.lines ?? []).some((l) => items.has(l.item))) ?? open[0];
    }
    if (!asn || asn.po_id !== po.id) continue;
    const already = get('SELECT id FROM asn_grns WHERE asn_id = ? AND grn_no = ?', asn.id, String(p.grn_no));
    if (!already) insert('asn_grns', { asn_id: asn.id, grn_no: String(p.grn_no), matched_by: matchedBy, linked_at: now() });
    if (asn.status !== 'Cancelled' && asn.status !== 'Delivered') {
      update('asns', asn.id, { status: 'Delivered', delivered_at: now() });
      audit(null, { action: 'asn.delivered', objectType: 'asn', objectId: asn.id, objectRef: asn.asn_no, before: { status: asn.status }, after: { status: 'Delivered', grn_no: p.grn_no, matched_by: matchedBy } });
    }
    refreshLineStatuses(po.id);
  }
}

// ------------------------------------------------------------------ pickup overdue job (AC-ASN-03)
export function pickupOverdueJob() {
  const t = today();
  const rows = all<AsnRow & { po_no: string; buyer_id: number | null; vendor_name: string }>(
    `SELECT a.*, p.po_no, p.buyer_id, v.name AS vendor_name FROM asns a JOIN pos p ON p.id = a.po_id JOIN vendors v ON v.id = a.vendor_id
     WHERE a.pickup_by = 'Equipcare' AND a.status = 'Submitted' AND COALESCE(a.pickup_status, 'Requested') IN ('Requested','Scheduled','Failed')
       AND COALESCE(a.pickup_date, a.dispatch_date) < ?`, t,
  );
  let n = 0;
  for (const a of rows) {
    const due = a.pickup_date ?? a.dispatch_date;
    n += notify({
      event: 'NTF-18', title: `Pickup overdue: ${a.asn_no} (PO ${a.po_no})`,
      body: `${a.vendor_name} — Equipcare pickup ${a.pickup_status === 'Scheduled' ? `scheduled for ${due}` : `requested from ${due}`} is not recorded as collected. Arrange the vehicle or update the pickup.`,
      link: `/asns/${a.id}`, users: [a.buyer_id], roles: ['STO'], plant: a.plant, objectType: 'asn', objectId: a.id, severity: 'danger', dedupeKey: `NTF-18:pickup-overdue:${a.id}:${t}`,
    }).length;
  }
  return `${rows.length} overdue Equipcare pickups, ${n} alerts`;
}

export function isPickupOverdue(a: Pick<AsnRow, 'pickup_by' | 'status' | 'pickup_status' | 'pickup_date' | 'dispatch_date'>) {
  const due = a.pickup_date ?? a.dispatch_date;
  return a.pickup_by === 'Equipcare' && a.status === 'Submitted' && ['Requested', 'Scheduled', 'Failed', null].includes(a.pickup_status) && !!due && due < today();
}

// ------------------------------------------------------------------ queries
function scopeWhere(actor: Actor, alias = 'a') {
  const where: string[] = [];
  const p: unknown[] = [];
  if (actor.role === 'VEN') { where.push(`${alias}.vendor_id = ?`); p.push(actor.vendorId ?? -1); }
  else {
    if (isOwnPrOnly(actor)) {
      const ids = ownPrPoIds(actor);
      where.push(ids.length ? `${alias}.po_id IN (${ids.map(() => '?').join(',')})` : '1 = 0');
      p.push(...ids);
    }
    if (actor.plants !== '*') { where.push(`${alias}.plant IN (${actor.plants.map(() => '?').join(',')})`); p.push(...actor.plants); }
  }
  return { where, p };
}

function decorateAsn<T extends AsnRow>(a: T) {
  const lines = a.lines ?? [];
  const overdue = ASN_OPEN.includes(a.status) && !!a.expected_date && a.expected_date < today();
  return {
    ...a,
    line_count: lines.length,
    total_qty: round2(lines.reduce((s, l) => s + l.qty, 0)),
    pickup_overdue: isPickupOverdue(a),
    delivery_overdue: overdue,
  };
}

export function listAsns(actor: Actor, q: Record<string, string | undefined>) {
  const { where, p } = scopeWhere(actor);
  if (actor.role === 'VEN' || q.include_drafts === '1') { /* vendors see their drafts */ } else where.push("a.status != 'Draft'");
  if (q.status) { where.push('a.status = ?'); p.push(q.status); }
  if (q.plant) { where.push('a.plant = ?'); p.push(q.plant); }
  if (q.po) { where.push('(a.po_id = ? OR p.po_no = ?)'); p.push(Number(q.po) || -1, q.po); }
  const rows = all<AsnRow & { po_no: string; vendor_name: string; vendor_code: string | null; buyer_name: string | null; open_disputes: number; doc_count: number; grn_nos: string | null }>(
    `SELECT a.*, p.po_no, v.name AS vendor_name, v.sap_code AS vendor_code, b.name AS buyer_name,
       (SELECT COUNT(*) FROM disputes d WHERE d.asn_id = a.id AND d.status NOT IN ('Resolved','Closed')) AS open_disputes,
       (SELECT COUNT(*) FROM attachments f WHERE f.owner_type = 'asn' AND f.owner_id = a.id ${actor.role === 'VEN' ? 'AND f.vendor_visible = 1' : ''}) AS doc_count,
       (SELECT GROUP_CONCAT(grn_no, ', ') FROM asn_grns g WHERE g.asn_id = a.id) AS grn_nos
     FROM asns a JOIN pos p ON p.id = a.po_id JOIN vendors v ON v.id = a.vendor_id LEFT JOIN users b ON b.id = p.buyer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE a.status WHEN 'Draft' THEN 0 WHEN 'Submitted' THEN 1 WHEN 'In transit' THEN 2 WHEN 'Delivered' THEN 3 ELSE 4 END, COALESCE(a.expected_date, a.created_at) ASC`,
    ...p,
  );
  return rows.map(decorateAsn);
}

export function asnSummary(actor: Actor) {
  const rows = listAsns(actor, {});
  const t = today();
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  return {
    open: rows.filter((r) => ASN_OPEN.includes(r.status)).length,
    due_week: rows.filter((r) => ASN_OPEN.includes(r.status) && r.expected_date && r.expected_date >= t && r.expected_date <= in7).length,
    delivery_overdue: rows.filter((r) => r.delivery_overdue).length,
    pickup_overdue: rows.filter((r) => r.pickup_overdue).length,
    with_disputes: rows.filter((r) => r.open_disputes > 0).length,
  };
}

export function asnDetail(actor: Actor, id: number) {
  const a = mustAsn(id);
  const po = getPo(a.po_id)!;
  assertPoAccess(actor, po, 'asn', id);
  if (actor.role !== 'VEN' && a.status === 'Draft') throw notFound('ASN');
  const pl = new Map(poLines(a.po_id).map((l) => [l.id, l]));
  const grnNos = all<{ grn_no: string; matched_by: string; linked_at: string }>('SELECT grn_no, matched_by, linked_at FROM asn_grns WHERE asn_id = ? ORDER BY id', id);
  const grnRows = all<{ id: number; grn_no: string; po_line_id: number; qty: number; value: number | null; posting_date: string; plant: string; item: number }>(
    `SELECT g.id, g.grn_no, g.po_line_id, g.qty, g.value, g.posting_date, g.plant, l.item FROM grns g JOIN po_lines l ON l.id = g.po_line_id
     WHERE g.asn_id = ? OR g.grn_no IN (SELECT grn_no FROM asn_grns WHERE asn_id = ?) ORDER BY g.posting_date, g.grn_no, l.item`, id, id,
  );
  const receivedOnAsn = new Map<number, number>();
  for (const g of grnRows) receivedOnAsn.set(g.po_line_id, (receivedOnAsn.get(g.po_line_id) ?? 0) + g.qty);
  const lines = (a.lines ?? []).map((l) => {
    const p = pl.get(l.po_line_id);
    return {
      ...l, description: p?.description ?? '—', material_code: p?.material_code ?? null, uom: p?.uom ?? '', ordered: p?.qty ?? 0, accepted: p ? acceptedQty(p) : 0,
      po_received: p?.received_qty ?? 0, received_on_asn: a.status === 'Delivered' ? receivedOnAsn.get(l.po_line_id) ?? 0 : null, line_status: p?.status ?? null,
      unit_price: actor.role === 'REQ' ? null : p?.unit_price ?? null,
    };
  });
  const disputes = all<{ id: number; dsp_no: string; type: string; status: string; qty: number; po_line_id: number; owner_party: string; created_at: string }>(
    'SELECT id, dsp_no, type, status, qty, po_line_id, owner_party, created_at FROM disputes WHERE asn_id = ? ORDER BY id', id,
  );
  const versions = all<{ id: number; version: number; snapshot: Record<string, unknown>; reason: string; created_at: string; created_by_name: string }>(
    'SELECT v.id, v.version, v.snapshot_json, v.reason, v.created_at, u.name AS created_by_name FROM asn_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.asn_id = ? ORDER BY v.version DESC', id,
  );
  const plant = get<{ name: string; ship_to_address: string | null }>('SELECT name, ship_to_address FROM plants WHERE code = ?', a.plant);
  const isVendor = actor.role === 'VEN';
  const open = ASN_OPEN.includes(a.status);
  return {
    ...decorateAsn(a),
    po: { id: po.id, po_no: po.po_no, po_date: po.po_date, status: po.status, urgency: po.urgency, delivery_terms_text: po.delivery_terms, freight_terms_text: po.freight_terms, payment_terms: po.payment_terms, buyer_name: po.buyer_name, vendor_name: po.vendor_name, version: po.version },
    plant_name: plant?.name ?? a.plant, ship_to: plant?.ship_to_address ?? null,
    lines, grns: grnRows, grn_links: grnNos, disputes, versions,
    lr_mandatory: lrMandatory(a.delivery_terms),
    actions: {
      submit: isVendor && a.status === 'Draft',
      edit: isVendor && ['Draft', ...ASN_OPEN].includes(a.status),
      cancel: (isVendor && ['Draft', ...ASN_OPEN].includes(a.status)) || (!isVendor && actor.perms.has('po.followup') && open),
      dispatch: isVendor && a.status === 'Submitted' && a.pickup_by === 'Vendor',
      pickup: !isVendor && actor.perms.has('po.followup') && a.status === 'Submitted' && a.pickup_by === 'Equipcare',
      raise_dispute: !isVendor && actor.perms.has('dsp.raise') && ['In transit', 'Delivered'].includes(a.status),
      post_grn: !isVendor && actor.perms.has('sapsim.grn') && open,
    },
  };
}

/** SCR-ASN-03 — stores expected receipts by plant and date (FR-ASN-05). */
export function expectedReceipts(actor: Actor, q: Record<string, string | undefined>) {
  const { where, p } = scopeWhere(actor);
  if (q.plant) { where.push('a.plant = ?'); p.push(q.plant); }
  const recentFrom = new Date(Date.now() - 7 * 86400000).toISOString();
  where.push(`(a.status IN ('Submitted','In transit') OR (a.status = 'Delivered' AND a.delivered_at >= ?))`);
  p.push(recentFrom);
  const rows = all<AsnRow & { po_no: string; vendor_name: string; buyer_name: string | null; open_disputes: number; doc_count: number; grn_nos: string | null; plant_name: string }>(
    `SELECT a.*, p.po_no, v.name AS vendor_name, b.name AS buyer_name, pl.name AS plant_name,
       (SELECT COUNT(*) FROM disputes d WHERE d.asn_id = a.id AND d.status NOT IN ('Resolved','Closed')) AS open_disputes,
       (SELECT COUNT(*) FROM attachments f WHERE f.owner_type = 'asn' AND f.owner_id = a.id) AS doc_count,
       (SELECT GROUP_CONCAT(grn_no, ', ') FROM asn_grns g WHERE g.asn_id = a.id) AS grn_nos
     FROM asns a JOIN pos p ON p.id = a.po_id JOIN vendors v ON v.id = a.vendor_id LEFT JOIN users b ON b.id = p.buyer_id LEFT JOIN plants pl ON pl.code = a.plant
     WHERE ${where.join(' AND ')} ORDER BY COALESCE(a.expected_date, '9999'), a.id`,
    ...p,
  );
  const t = today();
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const out = rows.map((a) => {
    const pl = new Map(poLines(a.po_id).map((l) => [l.id, l]));
    const bucket = a.status === 'Delivered' ? 'received' : !a.expected_date ? 'later' : a.expected_date < t ? 'overdue' : a.expected_date === t ? 'today' : a.expected_date <= in7 ? 'week' : 'later';
    return {
      ...decorateAsn(a),
      bucket,
      lines: (a.lines ?? []).map((l) => ({ ...l, description: pl.get(l.po_line_id)?.description ?? '—', uom: pl.get(l.po_line_id)?.uom ?? '', material_code: pl.get(l.po_line_id)?.material_code ?? null, ordered: pl.get(l.po_line_id)?.qty ?? 0, received: pl.get(l.po_line_id)?.received_qty ?? 0 })),
    };
  });
  const plants = actor.plants === '*' ? all<{ code: string; name: string }>('SELECT code, name FROM plants ORDER BY code') : all<{ code: string; name: string }>(`SELECT code, name FROM plants WHERE code IN (${actor.plants.map(() => '?').join(',')}) ORDER BY code`, ...actor.plants);
  return {
    rows: out,
    plants,
    counts: { today: out.filter((r) => r.bucket === 'today').length, week: out.filter((r) => r.bucket === 'week').length, overdue: out.filter((r) => r.bucket === 'overdue').length, later: out.filter((r) => r.bucket === 'later').length, received: out.filter((r) => r.bucket === 'received').length },
    can_post_grn: actor.perms.has('sapsim.grn'),
    can_raise: actor.perms.has('dsp.raise'),
  };
}

export function asnPlantsFor(actor: Actor) {
  if (actor.plants === '*') return all<{ code: string; name: string }>('SELECT code, name FROM plants ORDER BY code');
  return all<{ code: string; name: string }>(`SELECT code, name FROM plants WHERE code IN (${actor.plants.map(() => '?').join(',')})`, ...actor.plants);
}

export function assertCanCreate(actor: Actor) {
  if (actor.role !== 'VEN' || !actor.vendorId) throw forbidden('Only vendor users create ASNs (SCR-VPT-06).');
}
