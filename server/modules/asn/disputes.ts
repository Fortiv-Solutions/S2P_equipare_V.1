/**
 * Module 8 — receipt discrepancies and dispute management (PRD 7.8: FR-DSP-01..07, AC-DSP-01..03, WF-14, RPT-08).
 *  - Raised from a receipt (stores) or an invoice exception (finance); value defaults from PO price × qty.
 *  - Default owner from the delivery-term responsibility matrix (DEC-24); reassign with reason.
 *  - Timeline in dispute_events; internal notes are never shown to vendors (GOV-C08).
 *  - Vendor responds with documents (AC-VPT-07 notifies the owner); outcome per FR-DSP-07; closure approval when configured (Q 7.8).
 *  - Ageing escalation to the Procurement Manager (NTF-23).
 */
import { all, get, insert, update, run, now, tx, round2, daysBetween } from '../../core/db.ts';
import { audit } from '../../core/audit.ts';
import { notify } from '../../core/notify.ts';
import { cfg } from '../../core/config.ts';
import { badRequest, conflict, forbidden, notFound } from '../../core/http.ts';
import { assertVendorScope, plantAllowed, type Actor } from '../../core/auth.ts';
import { linkAttachments } from '../../core/files.ts';
import { createApproval, getApproval } from '../../core/approvals.ts';
import { nextNo } from '../../core/numbering.ts';
import { releaseDisputeHolds } from '../invoices/service.ts';
import { getPo, getAsn, termKey, acceptedQty, isOwnPrOnly, ownPrPoIds, assertPoAccess, type PoLineRow, type Term } from './service.ts';

export const DISPUTE_TYPES = ['Shortage', 'Excess', 'Damage', 'Transit damage', 'Transit loss', 'Accidental loss', 'Wrong material', 'Quality rejection', 'Document mismatch'] as const;
export const OUTCOMES = ['Replacement', 'Credit note', 'Debit note', 'Transporter claim', 'Insurance claim', 'Accepted as-is', 'Claim rejected'] as const;
export const OWNER_PARTIES = ['Vendor', 'Procurement', 'Logistics', 'Stores', 'Finance'] as const;
export const EVIDENCE_LABELS = ['Photo', 'GRN note', 'Rejection note', 'Shortage report', 'Transporter claim', 'Insurance claim', 'Vendor response', 'Credit / debit note', 'Other'];
export const DSP_OPEN = ['Raised', 'Assigned', 'Awaiting response', 'Under resolution', 'Reopened'];
export type DisputeType = (typeof DISPUTE_TYPES)[number];
export type OwnerParty = (typeof OWNER_PARTIES)[number];

export interface DisputeRow {
  id: number; dsp_no: string; po_id: number; po_line_id: number; asn_id: number | null; grn_id: number | null; invoice_id: number | null;
  type: string; qty: number; value: number | null; delivery_term: Term; owner_party: OwnerParty; owner_user_id: number | null; status: string;
  description: string | null; outcome: string | null; outcome_note: string | null; outcome_amount: number | null; raised_by: number; source: string;
  created_at: string; due_at: string | null; resolved_at: string | null; closed_at: string | null; closed_by: number | null; closure_approval_id: number | null;
}

export function getDispute(id: number) {
  return get<DisputeRow>('SELECT * FROM disputes WHERE id = ?', id);
}
function mustDispute(id: number) {
  const d = getDispute(id);
  if (!d) throw notFound('Dispute');
  return d;
}
function lineOf(id: number) {
  return get<PoLineRow>('SELECT l.*, m.code AS material_code FROM po_lines l LEFT JOIN materials m ON m.id = l.material_id WHERE l.id = ?', id);
}

/** Object access for files / threads on disputes (vendor: own PO only; requisitioner: own PR; stores: own plants). */
export function canAccessDispute(actor: Actor, id: number) {
  const d = getDispute(id);
  if (!d) return false;
  const po = getPo(d.po_id);
  if (!po) return false;
  if (actor.role === 'VEN') return actor.vendorId === po.vendor_id;
  if (!actor.perms.has('dsp.view')) return false;
  if (isOwnPrOnly(actor)) return ownPrPoIds(actor).includes(po.id);
  return plantAllowed(actor, po.plant);
}

function assertAccess(actor: Actor, d: DisputeRow) {
  const po = getPo(d.po_id)!;
  assertPoAccess(actor, po, 'dispute', d.id);
  return po;
}

// ------------------------------------------------------------------ owner resolution (FR-DSP-02/03, DEC-24)
export function defaultOwner(term: Term, type: string): OwnerParty {
  const m = cfg<Record<string, Record<string, string>>>('dispute.responsibility');
  const v = m[term]?.[type];
  return (OWNER_PARTIES as readonly string[]).includes(v ?? '') ? (v as OwnerParty) : 'Procurement';
}

function storesUserFor(plant: string) {
  const users = all<{ id: number; plant_scope: string | null }>("SELECT id, plant_scope FROM users WHERE active = 1 AND vendor_id IS NULL AND (',' || roles || ',') LIKE '%,STO,%' ORDER BY id");
  return (users.find((u) => u.plant_scope && u.plant_scope !== '*' && u.plant_scope.split(',').includes(plant)) ?? users.find((u) => !u.plant_scope || u.plant_scope === '*'))?.id ?? null;
}

/** Vendor → vendor users (notified by vendorId); Procurement / Logistics → PO buyer; Stores → plant stores user; Finance → FIN role. */
export function ownerUserFor(party: OwnerParty, po: { buyer_id: number | null; plant: string }) {
  if (party === 'Procurement' || party === 'Logistics') return po.buyer_id;
  if (party === 'Stores') return storesUserFor(po.plant);
  return null;
}

function ownerLabel(d: Pick<DisputeRow, 'owner_party' | 'owner_user_id'>, vendorName?: string) {
  const u = d.owner_user_id ? get<{ name: string }>('SELECT name FROM users WHERE id = ?', d.owner_user_id)?.name : null;
  if (d.owner_party === 'Vendor') return vendorName ?? 'Vendor';
  if (d.owner_party === 'Finance' && !u) return 'Finance team';
  return u ? `${d.owner_party} — ${u}` : d.owner_party;
}

function event(disputeId: number, actor: Actor | null, kind: string, body: string, vendorVisible: boolean, at = now()) {
  insert('dispute_events', { dispute_id: disputeId, user_id: actor?.id ?? null, kind, body, vendor_visible: vendorVisible ? 1 : 0, created_at: at });
}

function notifyOwner(d: DisputeRow, title: string, body: string, opts: { severity?: 'info' | 'warning' | 'danger' | 'success'; dedupe?: string; includeBuyer?: boolean; exclude?: number[] } = {}) {
  const po = getPo(d.po_id)!;
  if (d.owner_party === 'Vendor') {
    notify({ event: 'NTF-22', title, body, link: `/vendor/disputes/${d.id}`, vendorId: po.vendor_id, objectType: 'dispute', objectId: d.id, severity: opts.severity ?? 'warning', dedupeKey: opts.dedupe ? `${opts.dedupe}:v` : undefined });
  } else if (d.owner_party === 'Finance' && !d.owner_user_id) {
    notify({ event: 'NTF-22', title, body, link: `/disputes/${d.id}`, roles: ['FIN'], objectType: 'dispute', objectId: d.id, severity: opts.severity ?? 'warning', dedupeKey: opts.dedupe, exclude: opts.exclude });
  } else {
    notify({ event: 'NTF-22', title, body, link: `/disputes/${d.id}`, users: [d.owner_user_id], objectType: 'dispute', objectId: d.id, severity: opts.severity ?? 'warning', dedupeKey: opts.dedupe, exclude: opts.exclude });
  }
  if (opts.includeBuyer && po.buyer_id && po.buyer_id !== d.owner_user_id) {
    notify({ event: 'NTF-22', title, body, link: `/disputes/${d.id}`, users: [po.buyer_id], objectType: 'dispute', objectId: d.id, severity: opts.severity ?? 'info', dedupeKey: opts.dedupe ? `${opts.dedupe}:b` : undefined, exclude: opts.exclude });
  }
}

// ------------------------------------------------------------------ capture context (SCR-ASN-04 prefill)
export function photoRule() {
  return cfg<{ types: string[]; min_photos: number }>('dispute.photo_rule');
}

export function captureContext(actor: Actor, q: { po_line?: number; asn?: number; invoice?: number; po?: number }) {
  let poId: number | null = null;
  const asn = q.asn ? getAsn(q.asn) : undefined;
  if (q.asn && !asn) throw notFound('ASN');
  const invoice = q.invoice ? get<{ id: number; inv_ref: string; po_id: number | null; vendor_invoice_no: string | null; status: string }>('SELECT id, inv_ref, po_id, vendor_invoice_no, status FROM invoices WHERE id = ?', q.invoice) : undefined;
  if (q.invoice && !invoice) throw notFound('Invoice');
  const line = q.po_line ? lineOf(q.po_line) : undefined;
  if (q.po_line && !line) throw notFound('PO line');
  poId = line?.po_id ?? asn?.po_id ?? invoice?.po_id ?? q.po ?? null;
  if (!poId) throw badRequest('Open the capture from a receipt, ASN, PO line or invoice so the PO is known.');
  const po = getPo(poId);
  if (!po) throw notFound('Purchase order');
  if (asn && asn.po_id !== po.id) throw badRequest('The ASN belongs to a different PO than the line.');
  if (invoice && invoice.po_id && invoice.po_id !== po.id) throw badRequest('The invoice belongs to a different PO than the line.');
  if (!plantAllowed(actor, po.plant)) throw forbidden(`PO ${po.po_no} is for plant ${po.plant}, outside your plant scope.`);
  const term: Term = asn?.delivery_terms ?? termKey(po.delivery_terms);
  const shipped = new Map((asn?.lines ?? []).map((l) => [l.po_line_id, l.qty]));
  const lines = all<PoLineRow>('SELECT l.*, m.code AS material_code FROM po_lines l LEFT JOIN materials m ON m.id = l.material_id WHERE l.po_id = ? ORDER BY l.item', po.id)
    .filter((l) => !asn || shipped.has(l.id) || l.id === line?.id)
    .map((l) => {
      const grn = get<{ id: number; grn_no: string; qty: number; posting_date: string }>('SELECT id, grn_no, qty, posting_date FROM grns WHERE po_line_id = ? ORDER BY posting_date DESC, id DESC LIMIT 1', l.id);
      const shippedQty = shipped.get(l.id) ?? null;
      const short = shippedQty != null && asn?.status === 'Delivered' ? Math.max(0, round2(shippedQty - (all<{ qty: number }>('SELECT g.qty FROM grns g WHERE g.po_line_id = ? AND (g.asn_id = ? OR g.grn_no IN (SELECT grn_no FROM asn_grns WHERE asn_id = ?))', l.id, asn.id, asn.id).reduce((s, x) => s + x.qty, 0)))) : null;
      return {
        po_line_id: l.id, item: l.item, description: l.description, material_code: l.material_code ?? null, uom: l.uom, ordered: l.qty, accepted: acceptedQty(l),
        received: l.received_qty ?? 0, shipped: shippedQty, suggested_shortage: short, unit_price: l.unit_price, gst_rate: l.gst_rate,
        last_grn: grn ?? null, open_disputes: all<{ dsp_no: string; type: string }>(`SELECT dsp_no, type FROM disputes WHERE po_line_id = ? AND status IN (${DSP_OPEN.map(() => '?').join(',')})`, l.id, ...DSP_OPEN),
      };
    });
  const matrix = Object.fromEntries(DISPUTE_TYPES.map((t) => [t, defaultOwner(term, t)]));
  return {
    po: { id: po.id, po_no: po.po_no, plant: po.plant, vendor_name: po.vendor_name, delivery_terms_text: po.delivery_terms, buyer_name: po.buyer_name },
    asn: asn ? { id: asn.id, asn_no: asn.asn_no, status: asn.status, transporter: asn.transporter, lr_no: asn.lr_no } : null,
    invoice: invoice ?? null,
    term, lines, selected_line: line?.id ?? (lines.length === 1 ? lines[0].po_line_id : null),
    types: DISPUTE_TYPES, owner_by_type: matrix, photo_rule: photoRule(), evidence_labels: EVIDENCE_LABELS,
  };
}

// ------------------------------------------------------------------ raise (FR-DSP-01, AC-DSP-01/02)
export interface RaiseInput {
  po_line_id: number; asn_id?: number | null; grn_id?: number | null; invoice_id?: number | null;
  type: string; qty: number; value?: number | null; description?: string | null; attachment_ids?: number[];
}

export function raiseDispute(actor: Actor, input: RaiseInput, opts: { at?: string } = {}) {
  const line = lineOf(input.po_line_id);
  if (!line) throw notFound('PO line');
  const po = getPo(line.po_id)!;
  if (!plantAllowed(actor, po.plant)) throw forbidden(`PO ${po.po_no} is for plant ${po.plant}, outside your plant scope.`);
  const fields: Record<string, string> = {};
  if (!(DISPUTE_TYPES as readonly string[]).includes(input.type)) fields.type = 'Choose the discrepancy type';
  if (!(input.qty > 0)) fields.qty = 'Enter the affected quantity (above 0)';
  else if (input.type !== 'Excess' && input.qty > line.qty) fields.qty = `Quantity cannot exceed the PO line quantity (${line.qty} ${line.uom})`;
  const asn = input.asn_id ? getAsn(input.asn_id) : undefined;
  if (input.asn_id && (!asn || asn.po_id !== po.id)) fields.asn_id = 'The ASN does not belong to this PO';
  let grnId = input.grn_id ?? null;
  if (grnId) {
    const g = get<{ po_line_id: number }>('SELECT po_line_id FROM grns WHERE id = ?', grnId);
    if (!g || g.po_line_id !== line.id) fields.grn_id = 'The GRN is not for this PO line';
  } else grnId = get<{ id: number }>('SELECT id FROM grns WHERE po_line_id = ? ORDER BY posting_date DESC, id DESC LIMIT 1', line.id)?.id ?? null;
  let source = 'Receipt';
  if (input.invoice_id) {
    const inv = get<{ po_id: number | null }>('SELECT po_id FROM invoices WHERE id = ?', input.invoice_id);
    if (!inv) fields.invoice_id = 'Invoice not found';
    else if (inv.po_id && inv.po_id !== po.id) fields.invoice_id = 'The invoice is for a different PO';
    source = 'Invoice exception';
  }
  // Photo rule for damage types (SCR-ASN-04, Q 7.8)
  const rule = photoRule();
  const ids = [...new Set(input.attachment_ids ?? [])];
  if (rule.types.includes(input.type)) {
    const photos = ids.length ? all<{ id: number }>(`SELECT id FROM attachments WHERE id IN (${ids.map(() => '?').join(',')}) AND mime LIKE 'image/%' AND scan_status = 'Available'`, ...ids).length : 0;
    if (photos < rule.min_photos) fields.attachment_ids = `${input.type} needs at least ${rule.min_photos} photo${rule.min_photos > 1 ? 's' : ''} of the material. Use Take photo on your phone, or attach image files.`;
  }
  if (ids.length) {
    const owned = all<{ id: number; uploaded_by: number | null; owner_id: number | null }>(`SELECT id, uploaded_by, owner_id FROM attachments WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    if (owned.length !== ids.length || owned.some((f) => f.owner_id != null || (f.uploaded_by !== actor.id && actor.channel !== 'seed'))) fields.attachment_ids = 'One or more files could not be attached. Upload them again.';
  }
  const keys = Object.keys(fields);
  if (keys.length) throw badRequest(fields[keys[0]], fields);

  return tx(() => {
    const ts = opts.at ?? now();
    const term: Term = asn?.delivery_terms ?? termKey(po.delivery_terms);
    const party = defaultOwner(term, input.type);
    const ownerUser = ownerUserFor(party, po);
    const value = input.value != null && input.value >= 0 ? round2(input.value) : round2(line.unit_price * input.qty);
    const dspNo = nextNo('DSP');
    const dueDays = cfg<number>('dispute.ageing_escalate_days');
    const id = insert('disputes', {
      dsp_no: dspNo, po_id: po.id, po_line_id: line.id, asn_id: asn?.id ?? null, grn_id: grnId, invoice_id: input.invoice_id ?? null,
      type: input.type, qty: input.qty, value, delivery_term: term, owner_party: party, owner_user_id: ownerUser,
      status: 'Raised', description: input.description?.trim() || null, raised_by: actor.id, source, created_at: ts,
      due_at: new Date(new Date(ts).getTime() + dueDays * 86400000).toISOString(),
    });
    if (ids.length) linkAttachments(ids, 'dispute', id);
    const role = actor.role === 'STO' ? 'Stores' : actor.role === 'FIN' ? 'Finance' : 'Procurement';
    event(id, actor, 'raised', `${input.type}: ${input.qty} ${line.uom} on PO ${po.po_no}/${line.item} (${line.description}) recorded by ${actor.name} (${role})${source === 'Invoice exception' ? ' from an invoice exception' : ''}.${input.description?.trim() ? ` ${input.description.trim()}` : ''}${ids.length ? ` ${ids.length} document(s) attached.` : ''}`, true, ts);
    const status = party === 'Vendor' ? 'Awaiting response' : 'Assigned';
    update('disputes', id, { status });
    const d = getDispute(id)!;
    event(id, null, 'assigned', `Default owner ${ownerLabel(d, po.vendor_name)} from the ${term} responsibility matrix (DEC-24).${party === 'Vendor' ? ' Waiting for the vendor to respond.' : ''}`, true, ts);
    audit(actor, { action: 'dispute.raised', objectType: 'dispute', objectId: id, objectRef: dspNo, after: { po_no: po.po_no, item: line.item, type: input.type, qty: input.qty, value, delivery_term: term, owner_party: party, owner_user_id: ownerUser, source, evidence: ids.length } });
    const body = `${input.type} · ${input.qty} ${line.uom} of ${line.description} · PO ${po.po_no}/${line.item} · ${po.plant}`;
    notifyOwner(d, party === 'Vendor' ? `Equipcare raised ${dspNo}: please respond` : `Dispute ${dspNo} assigned to ${party}`, body, { includeBuyer: true, exclude: [actor.id], dedupe: `NTF-22:${id}:raised` });
    return d;
  });
}

// ------------------------------------------------------------------ workflow (WF-14)
function assertInternalActor(actor: Actor) {
  if (actor.role === 'VEN') throw forbidden();
}
function canManage(actor: Actor, d: DisputeRow) {
  return actor.perms.has('dsp.manage') || (d.owner_user_id === actor.id && actor.role !== 'VEN');
}
function mustOpen(d: DisputeRow) {
  if (!DSP_OPEN.includes(d.status)) throw conflict(`${d.dsp_no} is ${d.status.toLowerCase()}. Reopen it first.`);
}

export function reassign(actor: Actor, id: number, input: { owner_party: string; owner_user_id?: number | null; reason: string }) {
  const d = mustDispute(id);
  assertInternalActor(actor);
  const po = assertAccess(actor, d);
  if (!actor.perms.has('dsp.manage')) throw forbidden('Only procurement can reassign a dispute.');
  mustOpen(d);
  if (!(OWNER_PARTIES as readonly string[]).includes(input.owner_party)) throw badRequest('Choose the owner.', { owner_party: 'Choose an owner' });
  const party = input.owner_party as OwnerParty;
  let userId: number | null = null;
  if (input.owner_user_id) {
    if (party === 'Vendor') throw badRequest('A vendor owner is the vendor company; do not pick an Equipcare user.', { owner_user_id: 'Not applicable' });
    const u = get<{ id: number; active: number; vendor_id: number | null }>('SELECT id, active, vendor_id FROM users WHERE id = ?', input.owner_user_id);
    if (!u || !u.active || u.vendor_id) throw badRequest('Choose an active Equipcare user.', { owner_user_id: 'Not a valid user' });
    userId = u.id;
  } else userId = ownerUserFor(party, po);
  if (party === d.owner_party && userId === d.owner_user_id) throw badRequest('The dispute already has this owner.');
  return tx(() => {
    const status = party === 'Vendor' ? 'Awaiting response' : 'Assigned';
    update('disputes', id, { owner_party: party, owner_user_id: userId, status });
    const fresh = getDispute(id)!;
    event(id, actor, 'reassigned', `Owner changed from ${ownerLabel(d, po.vendor_name)} to ${ownerLabel(fresh, po.vendor_name)}. Reason: ${input.reason}`, false);
    if (party === 'Vendor' || d.owner_party === 'Vendor') event(id, actor, 'assigned', party === 'Vendor' ? 'Equipcare has asked you to respond to this dispute.' : 'Equipcare is handling this dispute internally.', true);
    audit(actor, { action: 'dispute.reassigned', objectType: 'dispute', objectId: id, objectRef: d.dsp_no, before: { owner_party: d.owner_party, owner_user_id: d.owner_user_id, status: d.status }, after: { owner_party: party, owner_user_id: userId, status }, reason: input.reason });
    notifyOwner(fresh, party === 'Vendor' ? `Equipcare asks you to respond to ${d.dsp_no}` : `Dispute ${d.dsp_no} assigned to you`, `${d.type} · PO ${po.po_no} · ${party === 'Vendor' ? 'Please send your response with documents.' : input.reason}`, { exclude: [actor.id], dedupe: `NTF-22:${id}:assign:${now()}` });
    return fresh;
  });
}

export function addNote(actor: Actor, id: number, input: { body: string; vendor_visible?: boolean }) {
  const d = mustDispute(id);
  assertInternalActor(actor);
  assertAccess(actor, d);
  insert('dispute_events', { dispute_id: id, user_id: actor.id, kind: input.vendor_visible ? 'message' : 'note', body: input.body.trim(), vendor_visible: input.vendor_visible ? 1 : 0, created_at: now() });
  audit(actor, { action: input.vendor_visible ? 'dispute.message_to_vendor' : 'dispute.internal_note', objectType: 'dispute', objectId: id, objectRef: d.dsp_no, after: { vendor_visible: !!input.vendor_visible } });
  if (input.vendor_visible) {
    const po = getPo(d.po_id)!;
    notify({ event: 'NTF-22', title: `Message from Equipcare on ${d.dsp_no}`, body: input.body.slice(0, 160), link: `/vendor/disputes/${id}`, vendorId: po.vendor_id, objectType: 'dispute', objectId: id, dedupeKey: `NTF-22:${id}:msg:${now()}` });
  }
  return { ok: true };
}

export function addEvidence(actor: Actor, id: number, input: { attachment_ids: number[]; note?: string | null }) {
  const d = mustDispute(id);
  assertInternalActor(actor);
  assertAccess(actor, d);
  const ids = [...new Set(input.attachment_ids)];
  const files = all<{ id: number; uploaded_by: number | null; owner_id: number | null; filename: string; label: string | null; vendor_visible: number }>(`SELECT id, uploaded_by, owner_id, filename, label, vendor_visible FROM attachments WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  if (!files.length || files.some((f) => f.uploaded_by !== actor.id || (f.owner_id != null && f.owner_id !== id))) throw badRequest('Upload the files again, then add them to the dispute.');
  linkAttachments(ids, 'dispute', id);
  const visible = files.filter((f) => f.vendor_visible).length;
  const names = files.map((f) => (f.label ? `${f.label}: ${f.filename}` : f.filename)).join(', ');
  if (visible) event(id, actor, 'evidence', `Added ${visible} document(s)${input.note ? ` — ${input.note}` : ''}.`, true);
  event(id, actor, 'evidence', `Evidence added: ${names}${input.note ? ` — ${input.note}` : ''}.`, false);
  audit(actor, { action: 'dispute.evidence_added', objectType: 'dispute', objectId: id, objectRef: d.dsp_no, after: { files: ids, vendor_visible: visible } });
  return { ok: true, added: ids.length };
}

export function requestResponse(actor: Actor, id: number, message: string) {
  const d = mustDispute(id);
  assertInternalActor(actor);
  const po = assertAccess(actor, d);
  if (!canManage(actor, d)) throw forbidden('Only the dispute owner or procurement can ask the vendor to respond.');
  mustOpen(d);
  update('disputes', id, { status: 'Awaiting response' });
  event(id, actor, 'response_requested', message, true);
  audit(actor, { action: 'dispute.response_requested', objectType: 'dispute', objectId: id, objectRef: d.dsp_no, before: { status: d.status }, after: { status: 'Awaiting response' }, reason: message });
  notify({ event: 'NTF-22', title: `Equipcare asks you to respond to ${d.dsp_no}`, body: message.slice(0, 200), link: `/vendor/disputes/${id}`, vendorId: po.vendor_id, objectType: 'dispute', objectId: id, severity: 'warning', dedupeKey: `NTF-22:${id}:req:${now()}` });
  return getDispute(id)!;
}

/** SCR-VPT-09 / FR-VPT-08: vendor response with documents. AC-VPT-07: owner notified, appears on the timeline. */
export function vendorRespond(actor: Actor, id: number, input: { body: string; attachment_ids?: number[] }) {
  const d = mustDispute(id);
  const po = getPo(d.po_id)!;
  assertVendorScope(actor, po.vendor_id, 'dispute', id);
  if (actor.role !== 'VEN') throw forbidden();
  mustOpen(d);
  const ids = [...new Set(input.attachment_ids ?? [])];
  if (ids.length) {
    const files = all<{ id: number; uploaded_by: number | null; owner_id: number | null }>(`SELECT id, uploaded_by, owner_id FROM attachments WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    if (files.length !== ids.length || files.some((f) => f.uploaded_by !== actor.id || (f.owner_id != null && f.owner_id !== id))) throw badRequest('One or more documents could not be attached. Upload them again.', { attachment_ids: 'Upload again' });
  }
  return tx(() => {
    if (ids.length) {
      linkAttachments(ids, 'dispute', id);
      run(`UPDATE attachments SET vendor_visible = 1, label = COALESCE(label, 'Vendor response') WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    }
    event(id, actor, 'vendor_response', `${input.body.trim()}${ids.length ? `\n(${ids.length} document${ids.length > 1 ? 's' : ''} attached)` : ''}`, true);
    const status = 'Under resolution';
    update('disputes', id, { status });
    audit(actor, { action: 'dispute.vendor_responded', objectType: 'dispute', objectId: id, objectRef: d.dsp_no, before: { status: d.status }, after: { status, documents: ids.length } });
    // Notify the owner; when the vendor itself owns the dispute, the buyer and the person who raised it act on the response.
    const recipients = d.owner_party === 'Vendor' || !d.owner_user_id ? [po.buyer_id, d.raised_by] : [d.owner_user_id, d.raised_by];
    notify({ event: 'NTF-22', title: `${po.vendor_name} responded to ${d.dsp_no}`, body: input.body.slice(0, 200), link: `/disputes/${id}`, users: recipients, ...(d.owner_party === 'Finance' && !d.owner_user_id ? { roles: ['FIN' as const] } : {}), objectType: 'dispute', objectId: id, severity: 'info', dedupeKey: `NTF-22:${id}:resp:${now()}` });
    return getDispute(id)!;
  });
}

export function markUnderResolution(actor: Actor, id: number, note?: string | null) {
  const d = mustDispute(id);
  assertInternalActor(actor);
  assertAccess(actor, d);
  if (!canManage(actor, d)) throw forbidden('Only the dispute owner or procurement can change the status.');
  if (!['Assigned', 'Awaiting response', 'Reopened', 'Raised'].includes(d.status)) throw conflict(`${d.dsp_no} is ${d.status.toLowerCase()}.`);
  update('disputes', id, { status: 'Under resolution' });
  event(id, actor, 'status', `Under resolution${note ? ` — ${note}` : ''}`, true);
  audit(actor, { action: 'dispute.under_resolution', objectType: 'dispute', objectId: id, objectRef: d.dsp_no, before: { status: d.status }, after: { status: 'Under resolution' }, reason: note ?? null });
  return getDispute(id)!;
}

/** FR-DSP-07 closure outcome. Invoices linked to the line are released / adjusted by the invoice module once the dispute is no longer open. */
export function recordOutcome(actor: Actor, id: number, input: { outcome: string; note: string; amount?: number | null }) {
  const d = mustDispute(id);
  assertInternalActor(actor);
  const po = assertAccess(actor, d);
  if (!canManage(actor, d)) throw forbidden('Only the dispute owner or procurement can record the outcome.');
  mustOpen(d);
  if (!(OUTCOMES as readonly string[]).includes(input.outcome)) throw badRequest('Choose the outcome.', { outcome: 'Choose an outcome' });
  const needsAmount = ['Credit note', 'Debit note', 'Transporter claim', 'Insurance claim'].includes(input.outcome);
  if (needsAmount && !(input.amount != null && input.amount > 0)) throw badRequest(`Enter the ${input.outcome.toLowerCase()} amount in rupees.`, { amount: 'Amount is required' });
  return tx(() => {
    update('disputes', id, { status: 'Resolved', outcome: input.outcome, outcome_note: input.note, outcome_amount: input.amount ?? null, resolved_at: now() });
    event(id, actor, 'outcome', `Outcome: ${input.outcome}${input.amount ? ` (₹${input.amount.toLocaleString('en-IN')})` : ''}. ${input.note}`, true);
    audit(actor, { action: 'dispute.resolved', objectType: 'dispute', objectId: id, objectRef: d.dsp_no, before: { status: d.status }, after: { status: 'Resolved', outcome: input.outcome, amount: input.amount ?? null }, reason: input.note });
    notify({ event: 'NTF-22', title: `${d.dsp_no} resolved: ${input.outcome}`, body: input.note.slice(0, 200), link: `/vendor/disputes/${id}`, vendorId: po.vendor_id, objectType: 'dispute', objectId: id, severity: 'success', dedupeKey: `NTF-22:${id}:outcome:v:${now()}` });
    notify({ event: 'NTF-22', title: `${d.dsp_no} resolved: ${input.outcome}`, body: `PO ${po.po_no} — invoices held for this dispute can be released or adjusted.`, link: `/disputes/${id}`, users: [d.raised_by], roles: ['FIN'], exclude: [actor.id], objectType: 'dispute', objectId: id, severity: 'success', dedupeKey: `NTF-22:${id}:outcome:${now()}` });
    releaseHolds(po.id);
    return getDispute(id)!;
  });
}

/** Re-run invoice matching for the PO so holds linked to this dispute release when it is no longer open (3WM-07). */
function releaseHolds(poId: number) {
  try {
    releaseDisputeHolds(poId);
  } catch (e) {
    console.error('releaseDisputeHolds failed', e);
  }
}

function doClose(actor: Actor | null, d: DisputeRow, note: string | null) {
  const po = getPo(d.po_id)!;
  update('disputes', d.id, { status: 'Closed', closed_at: now(), closed_by: actor?.id ?? null, closure_approval_id: d.closure_approval_id });
  event(d.id, actor, 'closed', `Dispute closed${note ? ` — ${note}` : ''}.`, true);
  audit(actor, { action: 'dispute.closed', objectType: 'dispute', objectId: d.id, objectRef: d.dsp_no, before: { status: d.status }, after: { status: 'Closed', outcome: d.outcome }, reason: note });
  notify({ event: 'NTF-22', title: `${d.dsp_no} closed`, body: `Outcome: ${d.outcome ?? '—'}`, link: `/vendor/disputes/${d.id}`, vendorId: po.vendor_id, objectType: 'dispute', objectId: d.id, severity: 'success', dedupeKey: `NTF-22:${d.id}:closed:${now()}` });
  releaseHolds(d.po_id);
}

export function closeDispute(actor: Actor, id: number, note: string | null) {
  const d = mustDispute(id);
  assertInternalActor(actor);
  const po = assertAccess(actor, d);
  if (!actor.perms.has('dsp.manage')) throw forbidden('Only procurement can close a dispute.');
  if (d.status !== 'Resolved') throw conflict(d.status === 'Closed' ? `${d.dsp_no} is already closed.` : `Record the outcome before closing ${d.dsp_no}.`);
  if (d.closure_approval_id) {
    const ap = getApproval(d.closure_approval_id);
    if (ap && ['Pending', 'Clarification requested'].includes(ap.status)) throw conflict(`Closure is already waiting for approval (${ap.req_no}).`);
  }
  return tx(() => {
    if (cfg<boolean>('dispute.closure_approval')) {
      const ap = createApproval(actor, {
        type: 'dispute.closure', objectType: 'dispute', objectId: id, title: `Close dispute ${d.dsp_no} (${d.type})`,
        summary: `PO ${po.po_no} · ${po.vendor_name} · outcome ${d.outcome}${d.outcome_amount ? ` ₹${d.outcome_amount}` : ''}`, value: d.value ?? 0,
        reason: note ?? d.outcome_note ?? undefined, plant: po.plant, context: { dsp_no: d.dsp_no, outcome: d.outcome, po_no: po.po_no },
      });
      update('disputes', id, { closure_approval_id: ap.id });
      event(id, actor, 'closure_requested', `Closure sent for approval (${ap.req_no}).`, false);
      audit(actor, { action: 'dispute.closure_requested', objectType: 'dispute', objectId: id, objectRef: d.dsp_no, after: { approval: ap.req_no }, reason: note });
      return { dispute: getDispute(id)!, pending_approval: ap.req_no };
    }
    doClose(actor, d, note);
    return { dispute: getDispute(id)!, pending_approval: null };
  });
}

export function onClosureDecision(approvalId: number, objectId: number, outcome: string, actor: Actor | null, comment: string | null) {
  const d = getDispute(objectId);
  if (!d || d.closure_approval_id !== approvalId || d.status !== 'Resolved') return;
  if (outcome === 'Approved') doClose(actor, d, comment ? `approved: ${comment}` : 'closure approved');
  else {
    event(d.id, actor, 'closure_rejected', `Closure ${outcome.toLowerCase()}${comment ? `: ${comment}` : ''}.`, false);
    audit(actor, { action: `dispute.closure_${outcome.toLowerCase()}`, objectType: 'dispute', objectId: d.id, objectRef: d.dsp_no, reason: comment });
    const po = getPo(d.po_id)!;
    notify({ event: 'NTF-22', title: `Closure of ${d.dsp_no} ${outcome.toLowerCase()}`, body: comment ?? '', link: `/disputes/${d.id}`, users: [po.buyer_id, d.owner_user_id], objectType: 'dispute', objectId: d.id, severity: 'warning', dedupeKey: `NTF-22:${d.id}:closure:${approvalId}` });
  }
}

export function reopenDispute(actor: Actor, id: number, reason: string) {
  const d = mustDispute(id);
  assertInternalActor(actor);
  const po = assertAccess(actor, d);
  if (!actor.perms.has('dsp.manage') && !actor.perms.has('dsp.raise')) throw forbidden();
  if (!['Resolved', 'Closed'].includes(d.status)) throw conflict(`${d.dsp_no} is still open.`);
  return tx(() => {
    update('disputes', id, { status: 'Reopened', closed_at: null, closed_by: null, resolved_at: null, outcome: null, outcome_note: null, outcome_amount: null, closure_approval_id: null });
    event(id, actor, 'reopened', `Reopened by ${actor.name}: ${reason}${d.outcome ? ` (previous outcome: ${d.outcome})` : ''}`, true);
    audit(actor, { action: 'dispute.reopened', objectType: 'dispute', objectId: id, objectRef: d.dsp_no, before: { status: d.status, outcome: d.outcome }, after: { status: 'Reopened' }, reason });
    const fresh = getDispute(id)!;
    notifyOwner(fresh, `${d.dsp_no} reopened`, reason, { includeBuyer: true, exclude: [actor.id], dedupe: `NTF-22:${id}:reopen:${now()}` });
    if (fresh.owner_party !== 'Vendor') notify({ event: 'NTF-22', title: `${d.dsp_no} reopened`, body: reason.slice(0, 200), link: `/vendor/disputes/${id}`, vendorId: po.vendor_id, objectType: 'dispute', objectId: id, dedupeKey: `NTF-22:${id}:reopen-v:${now()}` });
    return fresh;
  });
}

// ------------------------------------------------------------------ ageing (FR-DSP-03, AC-DSP-03, NTF-23, RPT-08)
export function bucketsDef() {
  const b = cfg<number[]>('dispute.ageing_buckets');
  const labels = b.map((x, i) => (i === 0 ? `0–${x} days` : `${b[i - 1] + 1}–${x} days`));
  labels.push(`> ${b[b.length - 1]} days`);
  return { bounds: b, labels };
}
export function bucketOf(age: number) {
  const { bounds, labels } = bucketsDef();
  const i = bounds.findIndex((x) => age <= x);
  return { index: i === -1 ? bounds.length : i, label: labels[i === -1 ? bounds.length : i] };
}

export function ageingJob() {
  const days = cfg<number>('dispute.ageing_escalate_days');
  const rows = all<DisputeRow & { po_no: string; vendor_name: string; buyer_id: number | null }>(
    `SELECT d.*, p.po_no, v.name AS vendor_name, p.buyer_id FROM disputes d JOIN pos p ON p.id = d.po_id JOIN vendors v ON v.id = p.vendor_id
     WHERE d.status IN (${DSP_OPEN.map(() => '?').join(',')})`, ...DSP_OPEN,
  );
  let escalated = 0;
  for (const d of rows) {
    const age = daysBetween(d.created_at);
    if (age < days) continue;
    const already = get("SELECT id FROM dispute_events WHERE dispute_id = ? AND kind = 'escalated' AND created_at >= ?", d.id, d.created_at);
    if (already) continue;
    event(d.id, null, 'escalated', `Open ${age} days (threshold ${days} days, DEC-15). Escalated to the Procurement Manager.`, false);
    audit(null, { action: 'dispute.escalated', objectType: 'dispute', objectId: d.id, objectRef: d.dsp_no, after: { age_days: age, threshold: days } });
    notify({ event: 'NTF-23', title: `Dispute ${d.dsp_no} open ${age} days`, body: `${d.type} · ${d.vendor_name} · PO ${d.po_no} · owner ${ownerLabel(d, d.vendor_name)} · ${d.status}`, link: `/disputes/${d.id}`, roles: ['APR'], users: [d.owner_user_id], objectType: 'dispute', objectId: d.id, severity: 'danger', dedupeKey: `NTF-23:${d.id}` });
    escalated++;
  }
  return `${rows.length} open disputes checked, ${escalated} escalated`;
}

// ------------------------------------------------------------------ queries
function scope(actor: Actor) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (actor.role === 'VEN') { where.push('p.vendor_id = ?'); p.push(actor.vendorId ?? -1); }
  else {
    if (isOwnPrOnly(actor)) { const ids = ownPrPoIds(actor); where.push(ids.length ? `d.po_id IN (${ids.map(() => '?').join(',')})` : '1 = 0'); p.push(...ids); }
    if (actor.plants !== '*') { where.push(`p.plant IN (${actor.plants.map(() => '?').join(',')})`); p.push(...actor.plants); }
  }
  return { where, p };
}

type ListRow = DisputeRow & { po_no: string; plant: string; vendor_id: number; vendor_name: string; item: number; description: string; uom: string; owner_name: string | null; raised_by_name: string; asn_no: string | null; escalated: number; last_vendor_event: string | null };

function decorate(r: ListRow, vendor: boolean) {
  const end = r.closed_at ?? (r.status === 'Resolved' ? r.resolved_at : null);
  const age = daysBetween(r.created_at, end ?? new Date());
  const b = bucketOf(age);
  const out = {
    id: r.id, dsp_no: r.dsp_no, type: r.type, status: r.status, po_id: r.po_id, po_no: r.po_no, po_line_id: r.po_line_id, item: r.item, description: r.description, uom: r.uom,
    plant: r.plant, vendor_id: r.vendor_id, vendor_name: r.vendor_name, qty: r.qty, value: r.value, delivery_term: r.delivery_term, owner_party: r.owner_party,
    owner_name: vendor ? null : r.owner_name, owner_label: r.owner_party === 'Vendor' ? r.vendor_name : r.owner_name ? `${r.owner_party} · ${r.owner_name}` : r.owner_party,
    raised_by_name: r.raised_by_name, created_at: r.created_at, source: r.source, outcome: r.outcome, asn_id: r.asn_id, asn_no: r.asn_no,
    age_days: age, bucket: b.label, bucket_index: b.index, open: DSP_OPEN.includes(r.status), escalated: vendor ? false : !!r.escalated,
    closed_at: r.closed_at, resolved_at: r.resolved_at, closure_tat_days: r.closed_at ? daysBetween(r.created_at, r.closed_at) : null,
    awaiting_you: vendor && r.status === 'Awaiting response' && r.owner_party === 'Vendor',
  };
  return out;
}

const LIST_SQL = `SELECT d.*, p.po_no, p.plant, p.vendor_id, v.name AS vendor_name, l.item, l.description, l.uom, ou.name AS owner_name, ru.name AS raised_by_name, a.asn_no,
  (SELECT COUNT(*) FROM dispute_events e WHERE e.dispute_id = d.id AND e.kind = 'escalated') AS escalated,
  (SELECT MAX(created_at) FROM dispute_events e WHERE e.dispute_id = d.id AND e.vendor_visible = 1) AS last_vendor_event
  FROM disputes d JOIN pos p ON p.id = d.po_id JOIN vendors v ON v.id = p.vendor_id JOIN po_lines l ON l.id = d.po_line_id
  LEFT JOIN users ou ON ou.id = d.owner_user_id LEFT JOIN users ru ON ru.id = d.raised_by LEFT JOIN asns a ON a.id = d.asn_id`;

export function listDisputes(actor: Actor, q: Record<string, string | undefined>) {
  const { where, p } = scope(actor);
  if (q.status === 'open') { where.push(`d.status IN (${DSP_OPEN.map(() => '?').join(',')})`); p.push(...DSP_OPEN); }
  else if (q.status) { where.push('d.status = ?'); p.push(q.status); }
  if (q.po) { where.push('(d.po_id = ? OR p.po_no = ?)'); p.push(Number(q.po) || -1, q.po); }
  if (q.asn) { where.push('d.asn_id = ?'); p.push(Number(q.asn)); }
  if (q.mine === '1') { where.push('d.owner_user_id = ?'); p.push(actor.id); }
  const rows = all<ListRow>(`${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE WHEN d.status IN ('Resolved','Closed') THEN 1 ELSE 0 END, d.created_at`, ...p);
  return rows.map((r) => decorate(r, actor.role === 'VEN'));
}

const DIMS: Record<string, (r: ReturnType<typeof decorate>) => string> = {
  owner: (r) => r.owner_party,
  type: (r) => r.type,
  vendor: (r) => r.vendor_name,
  delivery_term: (r) => r.delivery_term,
  plant: (r) => r.plant,
};

/** RPT-08 dispute ageing: count, value, ageing buckets per owner / type / vendor / delivery term, plus closure TAT (KPI-12). */
export function ageingReport(actor: Actor, by: string) {
  const dim = DIMS[by] ? by : 'owner';
  const all_ = listDisputes(actor, {});
  const open = all_.filter((r) => r.open);
  const { labels } = bucketsDef();
  const map = new Map<string, { key: string; count: number; value: number; counts: number[]; ids: number[][]; max_age: number; closed: number; tat_total: number }>();
  for (const r of all_) {
    const k = DIMS[dim](r);
    const row = map.get(k) ?? { key: k, count: 0, value: 0, counts: labels.map(() => 0), ids: labels.map(() => []), max_age: 0, closed: 0, tat_total: 0 };
    if (r.open) {
      row.count++;
      row.value += r.value ?? 0;
      row.counts[r.bucket_index]++;
      row.ids[r.bucket_index].push(r.id);
      row.max_age = Math.max(row.max_age, r.age_days);
    } else if (r.closure_tat_days != null) {
      row.closed++;
      row.tat_total += r.closure_tat_days;
    }
    map.set(k, row);
  }
  const closed = all_.filter((r) => r.closure_tat_days != null);
  const tats = closed.map((r) => r.closure_tat_days!).sort((a, b) => a - b);
  return {
    by: dim, buckets: labels,
    rows: [...map.values()].map((r) => ({ ...r, value: round2(r.value), avg_closure_days: r.closed ? round2(r.tat_total / r.closed) : null })).sort((a, b) => b.count - a.count || b.closed - a.closed),
    totals: {
      open: open.length, value: round2(open.reduce((s, r) => s + (r.value ?? 0), 0)), escalated: open.filter((r) => r.escalated).length,
      closed: closed.length, avg_closure_days: tats.length ? round2(tats.reduce((s, x) => s + x, 0) / tats.length) : null, median_closure_days: tats.length ? tats[Math.floor((tats.length - 1) / 2)] : null,
      over_threshold: open.filter((r) => r.age_days >= cfg<number>('dispute.ageing_escalate_days')).length,
    },
    threshold_days: cfg<number>('dispute.ageing_escalate_days'),
  };
}

export function disputeDetail(actor: Actor, id: number) {
  const d = mustDispute(id);
  const po = assertAccess(actor, d);
  const vendor = actor.role === 'VEN';
  const row = all<ListRow>(`${LIST_SQL} WHERE d.id = ?`, id)[0];
  const base = decorate(row, vendor);
  const line = lineOf(d.po_line_id)!;
  const events = all<{ id: number; kind: string; body: string; vendor_visible: number; created_at: string; user_name: string | null; user_role: string | null; is_vendor: number }>(
    `SELECT e.id, e.kind, e.body, e.vendor_visible, e.created_at, u.name AS user_name, u.roles AS user_role, CASE WHEN u.vendor_id IS NOT NULL THEN 1 ELSE 0 END AS is_vendor
     FROM dispute_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.dispute_id = ? ${vendor ? 'AND e.vendor_visible = 1' : ''} ORDER BY e.created_at, e.id`, id,
  );
  const asn = d.asn_id ? get<{ id: number; asn_no: string; status: string; transporter: string | null; lr_no: string | null; dispatch_date: string | null; delivered_at: string | null; delivery_terms: string; transit_risk: string | null; freight_mode: string | null }>('SELECT id, asn_no, status, transporter, lr_no, dispatch_date, delivered_at, delivery_terms, transit_risk, freight_mode FROM asns WHERE id = ?', d.asn_id) : null;
  const grn = d.grn_id ? get<{ id: number; grn_no: string; qty: number; posting_date: string }>('SELECT id, grn_no, qty, posting_date FROM grns WHERE id = ?', d.grn_id) : null;
  const invoices = all<{ id: number; inv_ref: string; vendor_invoice_no: string | null; status: string; sub_reason: string | null; dispute_hold: number; total_value: number | null; invoice_date: string | null }>(
    `SELECT id, inv_ref, vendor_invoice_no, status, sub_reason, dispute_hold, total_value, invoice_date FROM invoices WHERE po_id = ? ${vendor ? 'AND vendor_id = ' + Number(actor.vendorId) : ''} ORDER BY id`, d.po_id,
  ).map((i) => (vendor ? { id: i.id, inv_ref: i.inv_ref, vendor_invoice_no: i.vendor_invoice_no, status: i.status, total_value: i.total_value, invoice_date: i.invoice_date, sub_reason: null, dispute_hold: 0 } : i));
  const approval = !vendor && d.closure_approval_id ? get<{ id: number; req_no: string; status: string }>('SELECT id, req_no, status FROM approvals WHERE id = ?', d.closure_approval_id) : null;
  const isOpen = DSP_OPEN.includes(d.status);
  const manage = !vendor && canManage(actor, d);
  const closurePending = approval && ['Pending', 'Clarification requested'].includes(approval.status);
  return {
    ...base,
    description_text: d.description, outcome_note: d.outcome_note, outcome_amount: d.outcome_amount, due_at: d.due_at,
    owner_user_id: vendor ? null : d.owner_user_id, raised_by: vendor ? null : d.raised_by,
    po: { id: po.id, po_no: po.po_no, delivery_terms_text: po.delivery_terms, buyer_name: po.buyer_name, plant: po.plant, vendor_name: po.vendor_name },
    line: { id: line.id, item: line.item, description: line.description, material_code: line.material_code ?? null, qty: line.qty, uom: line.uom, unit_price: vendor ? line.unit_price : actor.role === 'REQ' ? null : line.unit_price, received_qty: line.received_qty },
    asn, grn, invoices, approval: approval ?? null, events,
    default_owner: defaultOwner(d.delivery_term, d.type),
    threshold_days: cfg<number>('dispute.ageing_escalate_days'),
    closure_approval: cfg<boolean>('dispute.closure_approval'),
    actions: {
      respond: vendor && isOpen,
      reassign: !vendor && actor.perms.has('dsp.manage') && isOpen,
      note: !vendor && (actor.perms.has('dsp.raise') || actor.perms.has('dsp.manage') || actor.perms.has('dsp.hold')),
      evidence: !vendor && (actor.perms.has('dsp.raise') || actor.perms.has('dsp.manage') || actor.perms.has('dsp.hold')),
      request_response: manage && isOpen,
      under_resolution: manage && ['Assigned', 'Awaiting response', 'Reopened', 'Raised'].includes(d.status),
      outcome: manage && isOpen,
      close: !vendor && actor.perms.has('dsp.manage') && d.status === 'Resolved' && !closurePending,
      reopen: !vendor && (actor.perms.has('dsp.manage') || actor.perms.has('dsp.raise')) && ['Resolved', 'Closed'].includes(d.status),
    },
  };
}

/** For the invoice engineer (3WM-07, FR-DSP-05): open disputes on a PO with the PO line ids and a finance-readable reason. */
export function openDisputesForPo(poId: number) {
  return all<{ id: number; dsp_no: string; po_line_id: number; item: number; type: string; status: string; qty: number; value: number | null; owner_party: string; uom: string; description: string; created_at: string }>(
    `SELECT d.id, d.dsp_no, d.po_line_id, l.item, d.type, d.status, d.qty, d.value, d.owner_party, l.uom, l.description, d.created_at
     FROM disputes d JOIN po_lines l ON l.id = d.po_line_id WHERE d.po_id = ? AND d.status IN (${DSP_OPEN.map(() => '?').join(',')}) ORDER BY l.item, d.id`,
    poId, ...DSP_OPEN,
  ).map((d) => ({
    ...d,
    reason: `Open dispute ${d.dsp_no}: ${d.type} of ${d.qty} ${d.uom} on PO line ${d.item} (${d.status}; owner ${d.owner_party})`,
  }));
}

export function ownerCandidates() {
  return all<{ id: number; name: string; roles: string; plant_scope: string | null; title: string | null }>(
    "SELECT id, name, roles, plant_scope, title FROM users WHERE active = 1 AND vendor_id IS NULL AND ((',' || roles || ',') LIKE '%,BUY,%' OR (',' || roles || ',') LIKE '%,APR,%' OR (',' || roles || ',') LIKE '%,STO,%' OR (',' || roles || ',') LIKE '%,FIN,%') ORDER BY name",
  );
}
