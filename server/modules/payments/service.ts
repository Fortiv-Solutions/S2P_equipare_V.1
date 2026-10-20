/**
 * Module 11 — Payment status and advance payment tracking (PRD 7.11, FR-PAY-01..07, WF-11, AC-PAY-01..05).
 * Payments are executed in SAP only; the platform shows SAP-synchronised status (INT-M12) and tracks
 * advance requests through the approval engine (Module 5).
 */
import { all, get, insert, update, now, tx, round2, daysBetween } from '../../core/db.ts';
import { audit } from '../../core/audit.ts';
import { notify } from '../../core/notify.ts';
import { cfg } from '../../core/config.ts';
import { badRequest, conflict, forbidden, notFound } from '../../core/http.ts';
import { assertVendorScope, plantAllowed, type Actor } from '../../core/auth.ts';
import { createApproval, getApproval, withdraw, type ApprovalRow } from '../../core/approvals.ts';
import { nextNo } from '../../core/numbering.ts';
import { revalidatePo, getInvoice } from '../invoices/service.ts';
import { advicePdf } from '../invoices/docs.ts';

let clock: string | null = null;
export function withClock<T>(iso: string, fn: () => T): T {
  const prev = clock;
  clock = iso;
  try { return fn(); } finally { clock = prev; }
}
const ts = () => clock ?? now();

export interface AdvanceRow {
  id: number; adv_no: string; po_id: number | null; contract_id: number | null; vendor_id: number; amount: number; reason: string; status: string;
  approval_id: number | null; requested_by: number; paid_date: string | null; sap_doc: string | null; adjusted_amount: number; created_at: string; cancel_reason: string | null;
}
export const ADV_OPEN = ['Paid', 'Partially adjusted'];
export type AdvView = AdvanceRow & { vendor_name: string | null; vendor_code: string | null; po_no: string | null; plant: string | null; po_value: number | null; contract_no: string | null; contract_type: string | null; requested_by_name: string | null; approval_no: string | null; approval_status: string | null };

// ------------------------------------------------------------------ ageing (FR-PAY-03, AC-PAY-03, KPI-15)
export function bucketsOf() {
  const b = cfg<number[]>('pay.advance_buckets');
  const labels = b.map((x, i) => `${i === 0 ? 0 : b[i - 1] + 1}–${x} days`);
  labels.push(`> ${b[b.length - 1]} days`);
  return { bounds: b, labels };
}
export function bucketFor(age: number) {
  const { bounds, labels } = bucketsOf();
  const i = bounds.findIndex((x) => age <= x);
  return labels[i === -1 ? labels.length - 1 : i];
}

function decorate(a: AdvView) {
  const outstanding = ADV_OPEN.includes(a.status) ? round2(a.amount - (a.adjusted_amount ?? 0)) : 0;
  const age = a.paid_date ? daysBetween(a.paid_date) : null;
  return { ...a, outstanding, age_days: age, bucket: outstanding > 0 && age != null ? bucketFor(age) : null };
}

const ADV_SELECT = `SELECT a.*, v.name AS vendor_name, v.sap_code AS vendor_code, p.po_no, p.plant, p.total_value AS po_value, c.contract_no, c.type AS contract_type,
  u.name AS requested_by_name, ap.req_no AS approval_no, ap.status AS approval_status
  FROM advances a LEFT JOIN vendors v ON v.id = a.vendor_id LEFT JOIN pos p ON p.id = a.po_id LEFT JOIN contracts c ON c.id = a.contract_id
  LEFT JOIN users u ON u.id = a.requested_by LEFT JOIN approvals ap ON ap.id = a.approval_id`;

export function listAdvances(actor: Actor, q: Record<string, string | undefined> = {}) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (actor.role === 'VEN') { where.push('a.vendor_id = ?'); p.push(actor.vendorId ?? -1); }
  if (q.vendor) { where.push('a.vendor_id = ?'); p.push(Number(q.vendor)); }
  if (q.po) { where.push('a.po_id = ?'); p.push(Number(q.po)); }
  const rows = all<AdvView>(`${ADV_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC`, ...p)
    .filter((r) => actor.role === 'VEN' || plantAllowed(actor, r.plant));
  return rows.map(decorate);
}

/** Advance register with ageing buckets by vendor (AC-PAY-03, RPT-10). */
export function register(actor: Actor) {
  const rows = listAdvances(actor);
  const { labels } = bucketsOf();
  const byVendor = new Map<string, { vendor: string; vendor_id: number; outstanding: number; buckets: number[]; count: number }>();
  for (const r of rows) {
    if (!r.outstanding) continue;
    const k = String(r.vendor_id);
    const row = byVendor.get(k) ?? { vendor: String(r.vendor_name ?? '—'), vendor_id: r.vendor_id, outstanding: 0, buckets: labels.map(() => 0), count: 0 };
    row.outstanding = round2(row.outstanding + r.outstanding);
    row.buckets[labels.indexOf(r.bucket!)] = round2(row.buckets[labels.indexOf(r.bucket!)] + r.outstanding);
    row.count++;
    byVendor.set(k, row);
  }
  const sum = (s: string[]) => round2(rows.filter((r) => s.includes(r.status)).reduce((t, r) => t + r.amount, 0));
  return {
    buckets: labels, rows, by_vendor: [...byVendor.values()].sort((a, b) => b.outstanding - a.outstanding),
    totals: {
      requested: sum(['Requested', 'Pending approval']), approved: sum(['Approved']), paid: sum(['Paid', 'Partially adjusted', 'Fully adjusted']),
      adjusted: round2(rows.reduce((t, r) => t + (r.adjusted_amount ?? 0), 0)), outstanding: round2(rows.reduce((t, r) => t + r.outstanding, 0)),
      bucket_totals: labels.map((l) => round2(rows.filter((r) => r.bucket === l).reduce((t, r) => t + r.outstanding, 0))),
    },
    baseline: 'Baseline: to be measured', target: 'Target: pending approval',
  };
}

export function getAdvance(id: number) {
  return get<AdvanceRow>('SELECT * FROM advances WHERE id = ?', id);
}

export function advanceDetail(actor: Actor, id: number) {
  const a = get<AdvView>(`${ADV_SELECT} WHERE a.id = ?`, id);
  if (!a) throw notFound('Advance');
  if (actor.role === 'VEN') assertVendorScope(actor, a.vendor_id, 'advance', id);
  else if (!plantAllowed(actor, a.plant)) throw notFound('Advance');
  const approval = a.approval_id ? getApproval(a.approval_id) : null;
  const steps = a.approval_id ? all('SELECT s.level, s.approver_role, s.status, s.comment, s.acted_at, u.name AS acted_by_name FROM approval_steps s LEFT JOIN users u ON u.id = s.acted_by WHERE s.approval_id = ? ORDER BY s.level, s.id', a.approval_id) : [];
  const invoices = a.po_id
    ? all("SELECT id, inv_ref, vendor_invoice_no, status, total_value, advance_adjusted, paid_at FROM invoices WHERE po_id = ? AND status != 'Rejected' ORDER BY id", a.po_id)
    : a.contract_id ? all("SELECT i.id, i.inv_ref, i.vendor_invoice_no, i.status, i.total_value, i.advance_adjusted, i.paid_at FROM invoices i JOIN pos p ON p.id = i.po_id WHERE p.contract_id = ? AND i.status != 'Rejected' ORDER BY i.id", a.contract_id) : [];
  const d = decorate(a);
  if (actor.role === 'VEN') {
    return { id: d.id, adv_no: d.adv_no, po_no: d.po_no, contract_no: d.contract_no, amount: d.amount, status: d.status, paid_date: d.paid_date, adjusted_amount: d.adjusted_amount, outstanding: d.outstanding, created_at: d.created_at };
  }
  return { ...d, approval: approval ? { id: approval.id, req_no: approval.req_no, status: approval.status, outcome: approval.outcome, decided_at: approval.decided_at } : null, steps, invoices, can_cancel: ['Requested', 'Pending approval', 'Approved'].includes(a.status) && (a.requested_by === actor.id || actor.perms.has('adv.manage')), can_resubmit: a.status === 'Requested' && a.requested_by === actor.id };
}

// ------------------------------------------------------------------ advance request (FR-PAY-02, FR-PAY-06, SCR-PAY-02)
export function advanceContext(actor: Actor, poId: number) {
  const po = get<{ id: number; po_no: string; vendor_id: number; plant: string; total_value: number; po_date: string; urgency: string; payment_terms: string | null; contract_id: number | null; status: string }>('SELECT * FROM pos WHERE id = ?', poId);
  if (!po || !plantAllowed(actor, po.plant)) throw notFound('Purchase order');
  const vendor = get<{ name: string; sap_code: string }>('SELECT name, sap_code FROM vendors WHERE id = ?', po.vendor_id)!;
  const existing = listAdvances(actor, { po: String(po.id) });
  const committed = round2(existing.filter((a) => !['Rejected', 'Cancelled'].includes(a.status)).reduce((s, a) => s + a.amount, 0));
  return { po: { ...po, vendor_name: vendor.name, vendor_code: vendor.sap_code }, existing, committed, available: round2((po.total_value ?? 0) - committed) };
}

export function poOptions(actor: Actor) {
  return all<{ id: number; po_no: string; vendor_name: string; plant: string; total_value: number; status: string; urgency: string }>(
    "SELECT p.id, p.po_no, v.name AS vendor_name, p.plant, p.total_value, p.status, p.urgency FROM pos p JOIN vendors v ON v.id = p.vendor_id WHERE p.status NOT IN ('Cancelled','Closed') ORDER BY p.po_date DESC",
  ).filter((p) => plantAllowed(actor, p.plant));
}

export interface AdvanceInput { po_id?: number | null; contract_id?: number | null; amount: number; reason: string }

export function requestAdvance(actor: Actor, input: AdvanceInput) {
  if (!actor.perms.has('adv.request')) throw forbidden('Your role cannot request advances.');
  if (!input.reason || input.reason.trim().length < 10) throw badRequest('Give the reason for the advance (at least 10 characters).', { reason: 'Reason is required' });
  if (!(input.amount > 0)) throw badRequest('Enter an advance amount greater than zero.', { amount: 'Enter an amount' });
  let vendorId: number;
  let cap: number;
  let plant: string | null = null;
  let label: string;
  let urgency: string | null = null;
  if (input.po_id) {
    const c = advanceContext(actor, input.po_id);
    if (['Cancelled', 'Closed'].includes(c.po.status)) throw conflict(`PO ${c.po.po_no} is ${c.po.status.toLowerCase()}; advances are not possible.`);
    vendorId = c.po.vendor_id;
    cap = c.available;
    plant = c.po.plant;
    urgency = c.po.urgency;
    label = `PO ${c.po.po_no}`;
    if (input.amount > cap + 0.005) throw badRequest(`The advance cannot exceed the PO value. ${c.committed ? `₹${c.committed.toLocaleString('en-IN')} is already requested or paid; ` : ''}up to ₹${cap.toLocaleString('en-IN')} is available.`, { amount: `Maximum ₹${cap.toLocaleString('en-IN')}` });
  } else if (input.contract_id) {
    const k = get<{ id: number; contract_no: string; vendor_id: number; value_cap: number | null; consumed_value: number; status: string }>('SELECT * FROM contracts WHERE id = ?', input.contract_id);
    if (!k) throw notFound('Contract');
    if (!['Active', 'Expiring'].includes(k.status)) throw conflict(`Contract ${k.contract_no} is ${k.status.toLowerCase()}; advances are not possible.`);
    const committed = round2(all<{ amount: number }>("SELECT amount FROM advances WHERE contract_id = ? AND status NOT IN ('Rejected','Cancelled')", k.id).reduce((s, a) => s + a.amount, 0));
    cap = round2((k.value_cap ?? 0) - k.consumed_value - committed);
    vendorId = k.vendor_id;
    label = `contract ${k.contract_no}`;
    if (k.value_cap != null && input.amount > cap + 0.005) throw badRequest(`The advance cannot exceed the remaining contract value (₹${cap.toLocaleString('en-IN')}).`, { amount: 'Too high' });
  } else throw badRequest('Choose the PO or contract the advance is for.', { po_id: 'Choose a PO' });

  return tx(() => {
    const no = nextNo('ADV');
    const id = insert('advances', { adv_no: no, po_id: input.po_id ?? null, contract_id: input.po_id ? null : input.contract_id ?? null, vendor_id: vendorId, amount: round2(input.amount), reason: input.reason.trim(), status: 'Requested', requested_by: actor.id, adjusted_amount: 0, created_at: ts() });
    audit(actor, { action: 'advance.requested', objectType: 'advance', objectId: id, objectRef: no, after: { amount: input.amount, against: label }, reason: input.reason });
    submitForApproval(actor, id);
    return getAdvance(id)!;
  });
}

function submitForApproval(actor: Actor, id: number) {
  const a = getAdvance(id)!;
  const ctx = a.po_id ? get<{ po_no: string; plant: string; urgency: string }>('SELECT po_no, plant, urgency FROM pos WHERE id = ?', a.po_id) : undefined;
  const k = a.contract_id ? get<{ contract_no: string; category: string | null }>('SELECT contract_no, category FROM contracts WHERE id = ?', a.contract_id) : undefined;
  const vendor = get<{ name: string }>('SELECT name FROM vendors WHERE id = ?', a.vendor_id)!.name;
  const ap = createApproval(actor, {
    type: 'adv.request', objectType: 'advance', objectId: id, title: `Advance ${a.adv_no} — ${vendor}`,
    summary: `₹${a.amount.toLocaleString('en-IN')} against ${ctx ? `PO ${ctx.po_no}` : `contract ${k?.contract_no}`}`, value: a.amount, reason: a.reason,
    context: { adv_no: a.adv_no, po_no: ctx?.po_no ?? null, contract_no: k?.contract_no ?? null }, plant: ctx?.plant ?? null, urgency: ctx?.urgency ?? null, categoryCode: k?.category ?? null,
  });
  update('advances', id, { status: 'Pending approval', approval_id: ap.id });
}

export function resubmitAdvance(actor: Actor, id: number, input: { amount?: number; reason?: string }) {
  const a = getAdvance(id);
  if (!a) throw notFound('Advance');
  if (a.requested_by !== actor.id) throw forbidden('Only the requester can resubmit this advance.');
  if (a.status !== 'Requested') throw conflict(`Advance ${a.adv_no} is ${a.status.toLowerCase()}.`);
  const amount = input.amount ?? a.amount;
  const reason = input.reason?.trim() || a.reason;
  if (reason.length < 10) throw badRequest('Give the reason for the advance (at least 10 characters).', { reason: 'Reason is required' });
  if (a.po_id) {
    const c = advanceContext(actor, a.po_id);
    const avail = round2(c.available + a.amount);
    if (amount > avail + 0.005) throw badRequest(`The advance cannot exceed the PO value; up to ₹${avail.toLocaleString('en-IN')} is available.`, { amount: 'Too high' });
  }
  return tx(() => {
    update('advances', id, { amount: round2(amount), reason });
    audit(actor, { action: 'advance.resubmitted', objectType: 'advance', objectId: id, objectRef: a.adv_no, before: { amount: a.amount, reason: a.reason }, after: { amount, reason } });
    submitForApproval(actor, id);
    return getAdvance(id)!;
  });
}

export function cancelAdvance(actor: Actor, id: number, reason: string) {
  const a = getAdvance(id);
  if (!a) throw notFound('Advance');
  if (a.requested_by !== actor.id && !actor.perms.has('adv.manage')) throw forbidden('Only the requester or finance can cancel this advance.');
  if (!['Requested', 'Pending approval', 'Approved'].includes(a.status)) throw conflict(`Advance ${a.adv_no} is ${a.status.toLowerCase()} and cannot be cancelled here. A paid advance is reversed in SAP.`);
  return tx(() => {
    const ap = a.approval_id ? getApproval(a.approval_id) : undefined;
    if (ap && ['Pending', 'Clarification requested'].includes(ap.status) && ap.requester_id === actor.id) withdraw(actor, ap.id, reason);
    update('advances', id, { status: 'Cancelled', cancel_reason: reason });
    audit(actor, { action: 'advance.cancelled', objectType: 'advance', objectId: id, objectRef: a.adv_no, before: { status: a.status }, after: { status: 'Cancelled' }, reason });
    return getAdvance(id)!;
  });
}

export function onAdvanceDecision(ap: ApprovalRow, outcome: string, actor: Actor | null, comment: string | null) {
  const a = getAdvance(ap.object_id);
  if (!a || a.status !== 'Pending approval') return;
  const status = outcome === 'Approved' ? 'Approved' : outcome === 'Rejected' ? 'Rejected' : outcome === 'Returned' ? 'Requested' : 'Cancelled';
  update('advances', a.id, { status, ...(status === 'Cancelled' ? { cancel_reason: comment ?? 'Approval withdrawn' } : {}) });
  audit(actor, { action: `advance.${status.toLowerCase().replace(/\s/g, '_')}`, objectType: 'advance', objectId: a.id, objectRef: a.adv_no, before: { status: a.status }, after: { status, approval: ap.req_no }, reason: comment });
  if (status === 'Approved') {
    notify({ event: 'NTF-12', title: `Advance ${a.adv_no} approved — pay in SAP`, body: `₹${a.amount.toLocaleString('en-IN')}. Execute the payment in SAP; the paid date syncs back (FR-PAY-06).`, link: `/advances/${a.id}`, roles: ['FIN'], objectType: 'advance', objectId: a.id, dedupeKey: `adv-ok:${a.id}` });
  }
  if (status === 'Requested') notify({ event: 'NTF-12', title: `Advance ${a.adv_no} returned for changes`, body: comment ?? undefined, link: `/advances/${a.id}`, users: [a.requested_by], objectType: 'advance', objectId: a.id, dedupeKey: `adv-ret:${a.id}:${ap.id}` });
}

/** ADVPAY sync (INT-M12): paid / adjusted in SAP. */
export function onAdvanceSynced(rows: { id: number; payload: any }[]) {
  for (const r of rows) {
    const a = getAdvance(r.id);
    if (!a) continue;
    audit(null, { action: 'advance.sap_status_synced', objectType: 'advance', objectId: a.id, objectRef: a.adv_no, after: { status: a.status, paid_date: a.paid_date, adjusted: a.adjusted_amount, sap_doc: a.sap_doc } });
    if (a.status === 'Paid' && (r.payload?.adjusted_amount ?? 0) === 0) {
      notify({ event: 'NTF-30', title: `Advance ${a.adv_no} paid`, body: `₹${a.amount.toLocaleString('en-IN')} paid in SAP on ${a.paid_date}.`, link: '/vendor/payments?tab=advances', vendorId: a.vendor_id, objectType: 'advance', objectId: a.id, severity: 'success', dedupeKey: `NTF-30a:${a.id}` });
      notify({ event: 'NTF-30', title: `Advance ${a.adv_no} paid in SAP`, body: `SAP document ${a.sap_doc}`, link: `/advances/${a.id}`, users: [a.requested_by], objectType: 'advance', objectId: a.id, dedupeKey: `NTF-30r:${a.id}` });
    }
    const po = a.po_id ? { id: a.po_id } : null;
    if (po) revalidatePo(po.id, 'advance status');
    else if (a.contract_id) for (const p of all<{ id: number }>('SELECT id FROM pos WHERE contract_id = ?', a.contract_id)) revalidatePo(p.id, 'advance status');
  }
}

/** NTF-31: unadjusted advance beyond the alert age (WF-11 alternate). */
export function advanceAgeingJob() {
  const days = cfg<number>('pay.advance_alert_days');
  let n = 0;
  const open = all<AdvanceRow>("SELECT * FROM advances WHERE status IN ('Paid','Partially adjusted') AND paid_date IS NOT NULL");
  for (const a of open) {
    const age = daysBetween(a.paid_date!);
    if (age < days) continue;
    const out = round2(a.amount - (a.adjusted_amount ?? 0));
    n += notify({ event: 'NTF-31', title: `Advance ${a.adv_no} unadjusted for ${age} days`, body: `₹${out.toLocaleString('en-IN')} outstanding (${bucketFor(age)}).`, link: `/advances/${a.id}`, users: [a.requested_by], roles: ['FIN'], objectType: 'advance', objectId: a.id, severity: 'warning', dedupeKey: `NTF-31:${a.id}:${bucketFor(age)}` }).length;
  }
  return `${open.length} paid advances checked, ${n} notifications`;
}

// ------------------------------------------------------------------ invoice payment status (FR-PAY-01, FR-PAY-05, FR-PAY-07)
const PAY_STATUSES = ['Matched', 'Parked', 'Posted', 'Payment due', 'Payment released', 'Payment blocked'];

export function invoicePayments(actor: Actor) {
  return all<Record<string, any>>(
    `SELECT i.id, i.inv_ref, i.vendor_invoice_no, i.invoice_date, i.status, i.total_value, i.due_date, i.paid_at, i.payment_ref, i.tds, i.retention,
            i.deductions_json, i.advance_adjusted, i.sap_doc_no, i.posted_at, i.approved_at, i.block_reason_internal, i.vendor_reason, i.dispute_hold, i.match_json,
            v.name AS vendor_name, v.sap_code AS vendor_code, p.po_no, p.plant
     FROM invoices i JOIN vendors v ON v.id = i.vendor_id JOIN pos p ON p.id = i.po_id
     WHERE i.status IN (${PAY_STATUSES.map(() => '?').join(',')}) ORDER BY COALESCE(i.due_date, i.invoice_date) DESC`, ...PAY_STATUSES,
  ).filter((r) => plantAllowed(actor, r.plant)).map(({ match, ...r }) => ({ status: r.status as string,
    ...r, overdue: !!r.due_date && r.due_date < now().slice(0, 10) && !['Payment released'].includes(r.status),
    balance_payable: match?.advance?.balance_payable ?? r.total_value,
  }));
}

/** Vendor payment rows: whitelisted fields only, and only those SAP provided (hide, not zero — FR-PAY-05/07, DEC-19). */
export function vendorPayments(actor: Actor) {
  const allow = new Set(cfg<string[]>('pay.vendor_fields'));
  const rows = all<Record<string, any>>(
    `SELECT i.id, i.inv_ref, i.vendor_invoice_no, i.invoice_date, i.status, i.total_value, i.due_date, i.paid_at, i.payment_ref, i.tds, i.deductions_json,
            i.advance_adjusted, i.payment_advice_json, i.vendor_reason, i.retention, p.po_no
     FROM invoices i JOIN pos p ON p.id = i.po_id WHERE i.vendor_id = ? AND i.status IN (${PAY_STATUSES.map(() => '?').join(',')}) ORDER BY i.id DESC`, actor.vendorId ?? -1, ...PAY_STATUSES,
  );
  return rows.map((r) => vendorSafe(r, allow));
}

function vendorSafe(r: Record<string, any>, allow: Set<string>) {
  const out: Record<string, unknown> = { id: r.id, inv_ref: r.inv_ref, vendor_invoice_no: r.vendor_invoice_no, invoice_date: r.invoice_date, po_no: r.po_no, total_value: r.total_value };
  const put = (k: string, v: unknown) => { if (allow.has(k) && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0) && v !== '') out[k] = v; };
  put('status', r.status === 'Matched' ? 'Approved — awaiting posting' : r.status);
  put('due_date', r.due_date);
  put('paid_at', r.paid_at);
  put('payment_ref', r.payment_ref);
  put('tds', r.tds);
  put('deductions', r.deductions);
  put('advance_adjusted', r.advance_adjusted);
  if (r.status === 'Payment blocked') put('vendor_reason', r.vendor_reason || 'Payment is on hold. Contact Equipcare accounts.');
  if (allow.has('payment_advice') && r.status === 'Payment released') out.advice_available = true;
  return out;
}

/** FR-PAY-04, AC-PAY-04: payment advice PDF after release. */
export function adviceFor(actor: Actor, invId: number) {
  const inv = getInvoice(invId);
  if (!inv) throw notFound('Invoice');
  const isVendor = actor.role === 'VEN';
  if (isVendor) assertVendorScope(actor, inv.vendor_id, 'invoice', invId);
  else if (!actor.perms.has('pay.view') && !actor.perms.has('inv.view')) throw forbidden();
  if (inv.status !== 'Payment released') throw conflict('The payment advice is available once SAP shows the payment as released.');
  const allow = isVendor ? new Set(cfg<string[]>('pay.vendor_fields')) : null;
  if (allow && !allow.has('payment_advice')) throw forbidden('Payment advice is not in the vendor-visible fields (DEC-19).');
  const po = get<{ po_no: string }>('SELECT po_no FROM pos WHERE id = ?', inv.po_id)!;
  const v = get<{ name: string; sap_code: string | null }>('SELECT name, sap_code FROM vendors WHERE id = ?', inv.vendor_id)!;
  const adv = (inv.payment_advice ?? {}) as Record<string, any>;
  const money = (n: unknown) => `Rs ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const rows: [string, string][] = [];
  const add = (key: string, label: string, val: unknown, fmt: (x: unknown) => string = String) => {
    if (val === null || val === undefined || val === '') return;
    if (allow && !allow.has(key)) return;
    rows.push([label, fmt(val)]);
  };
  add('payment_ref', 'Payment reference', adv.payment_ref ?? inv.payment_ref);
  add('paid_at', 'Payment date', adv.payment_date ?? inv.paid_at?.slice(0, 10));
  rows.push(['Invoice amount (gross)', money(adv.gross ?? inv.total_value)]);
  add('tds', 'TDS deducted', adv.tds ?? inv.tds, money);
  add('advance_adjusted', 'Advance adjusted', adv.advance_adjusted ?? inv.advance_adjusted, money);
  add('retention', 'Retention', adv.retention ?? inv.retention, money);
  if (adv.net_paid != null) rows.push(['Net amount paid', money(adv.net_paid)]);
  if (adv.bank) rows.push(['Paid to', String(adv.bank)]);
  if (!isVendor && adv.sap_doc_no) rows.push(['SAP document', String(adv.sap_doc_no)]);
  const deductions = (!allow || allow.has('deductions')) ? ((adv.deductions ?? inv.deductions) as { label: string; amount: number }[] | null) : null;
  audit(actor, { action: 'payment.advice_downloaded', objectType: 'invoice', objectId: inv.id, objectRef: inv.inv_ref });
  return {
    filename: `payment-advice-${inv.inv_ref}.pdf`,
    buffer: advicePdf({ vendor: v.name, vendorCode: v.sap_code, invRef: inv.inv_ref, vendorInvoiceNo: inv.vendor_invoice_no, invoiceDate: inv.invoice_date, poNo: po.po_no, rows, deductions, generatedFor: isVendor ? 'the vendor (vendor-visible fields only, DEC-19)' : 'internal use' }),
  };
}

export function reportSummary(actor: Actor) {
  const r = register(actor);
  const pays = invoicePayments(actor);
  return {
    advances: r.totals, buckets: r.buckets, by_vendor: r.by_vendor,
    invoices: { awaiting_posting: pays.filter((p) => ['Matched', 'Parked'].includes(p.status)).length, posted: pays.filter((p) => ['Posted', 'Payment due'].includes(p.status)).length, released: pays.filter((p) => p.status === 'Payment released').length, blocked: pays.filter((p) => p.status === 'Payment blocked').length, overdue: pays.filter((p) => p.overdue).length },
    baseline: r.baseline, target: r.target,
  };
}
