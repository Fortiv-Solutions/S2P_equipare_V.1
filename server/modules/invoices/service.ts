/**
 * Module 10 — Invoice upload, simulated OCR, validation, three-way match and exception queue
 * (PRD 7.10, FR-INV-01..19, WF-09, WF-10, AC-INV-01..14).
 *
 * Status vocabulary (shared with Module 11, STATUS.invoice): Uploaded → OCR pending → Validation pending →
 * Exception (sub-reason) → Matched → Parked → Posted → Payment due → Payment released | Payment blocked | Rejected.
 * The platform never parks, posts or pays: after finance approval it either writes the parking request
 * through the INT-M11 adapter (only when DEC-06 allows) or hands over for manual entry; every later status
 * arrives from SAP through the INT-M12 sync.
 */
import { all, get, insert, update, run, J, now, tx, scalar, round2, daysBetween, financialYear, db } from '../../core/db.ts';
import { audit } from '../../core/audit.ts';
import { notify } from '../../core/notify.ts';
import { cfg } from '../../core/config.ts';
import { badRequest, conflict, forbidden, notFound, HttpError } from '../../core/http.ts';
import { assertVendorScope, plantAllowed, type Actor } from '../../core/auth.ts';
import { getAttachment, linkAttachments } from '../../core/files.ts';
import { nextNo } from '../../core/numbering.ts';
import { sapWrite, staleInfo } from '../../core/sap.ts';
import { normalizeInvoiceNo, validateGstin, panFromGstin } from '../../core/india.ts';
import { openDisputesForPo } from '../asn/service.ts';
import { expectedFdsPrice } from '../contracts/service.ts';
import type { Role } from '../../core/permissions.ts';
import {
  HEADER_FIELDS, LINE_FIELDS, OCR_ENGINE, OCR_NOTE, simulateOcr, valuesFrom, accuracy, thresholdFor, normalizeValue, fieldDef,
  type Entered, type Extracted, type Val,
} from './ocr.ts';

// ------------------------------------------------------------------ clock (seed back-dating)
let clock: string | null = null;
/** Seed helper: run fn with module timestamps fixed to `iso` (platform records only; audit keeps real time). */
export function withClock<T>(iso: string, fn: () => T): T {
  const prev = clock;
  clock = iso;
  try { return fn(); } finally { clock = prev; }
}
const ts = () => clock ?? now();

// ------------------------------------------------------------------ schema additions (module-owned)
export function ensureSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS invoice_events (
    id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL, status TEXT, title TEXT NOT NULL, note TEXT, vendor_note TEXT,
    vendor_visible INTEGER DEFAULT 1, user_id INTEGER, created_at TEXT);
    CREATE INDEX IF NOT EXISTS ix_inv_events ON invoice_events(invoice_id);
    CREATE INDEX IF NOT EXISTS ix_inv_exc ON invoice_exceptions(invoice_id, status);`);
  const add = (table: string, cols: [string, string][]) => {
    const have = new Set(all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));
    for (const [c, type] of cols) if (!have.has(c)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} ${type}`);
  };
  add('invoices', [['values_json', 'TEXT'], ['final_json', 'TEXT'], ['parking_json', 'TEXT'], ['approval_note', 'TEXT']]);
  add('invoice_exceptions', [['reason', 'TEXT'], ['line_item', 'INTEGER'], ['ex_key', 'TEXT'], ['owner_user_id', 'INTEGER'], ['vendor_message', 'TEXT'], ['auto_clear', 'INTEGER DEFAULT 1'], ['updated_at', 'TEXT'], ['assigned_at', 'TEXT']]);
}

// ------------------------------------------------------------------ types
export interface Values extends Entered { verified: string[] }
export interface InvoiceRow {
  id: number; inv_ref: string; vendor_id: number; po_id: number; asn_id: number | null;
  vendor_invoice_no: string | null; normalized_no: string | null; invoice_date: string | null; fy: string | null;
  status: string; sub_reason: string | null; taxable_value: number | null; gst_amount: number | null; total_value: number | null;
  freight: number; other_charges: number; currency: string; extracted: Extracted | null; match: MatchResult | null;
  ocr_engine: string | null; ocr_at: string | null; on_behalf: number; uploaded_by: number | null; attachment_id: number | null; is_service: number;
  approved_by: number | null; approved_at: string | null; sap_doc_no: string | null; parked_at: string | null; posted_at: string | null;
  due_date: string | null; paid_at: string | null; payment_ref: string | null; payment_advice: Record<string, unknown> | null;
  deductions: { label: string; amount: number }[] | null; tds: number | null; retention: number | null; advance_adjusted: number | null;
  block_reason_internal: string | null; vendor_reason: string | null; dispute_hold: number; duplicate_of: number | null; rejected_reason: string | null;
  created_at: string; updated_at: string | null; values: Values | null; final: Record<string, unknown> | null;
  parking: { mode: 'sap' | 'manual'; status?: string; message: string; at: string; by: number } | null; approval_note: string | null;
}
export interface ExceptionRow {
  id: number; invoice_id: number; rule: string; severity: string; message: string; expected: string | null; actual: string | null; tolerance: string | null;
  owner_role: string; status: string; resolution: string | null; resolved_by: number | null; resolved_at: string | null; created_at: string;
  reason: string; line_item: number | null; ex_key: string; owner_user_id: number | null; vendor_message: string; auto_clear: number; updated_at: string | null; assigned_at: string | null;
}
export interface RuleResult {
  rule: string; label: string; status: 'pass' | 'fail' | 'info' | 'waiting' | 'skipped';
  summary: string; checks: { item?: number | null; check: string; expected: string; actual: string; tolerance?: string; ok: boolean; note?: string }[];
}
export interface MatchResult {
  ran_at: string; trigger: string; tolerance: Record<string, number>; tolerance_version: number; tolerance_status: string;
  hold_rule: string; duplicate_scope: string; results: RuleResult[];
  advance: { advances: { id: number; adv_no: string; amount: number; adjusted: number; outstanding: number; status: string; basis: string }[]; outstanding: number; proposed_adjustment: number; balance_payable: number } | null;
  fds: { contract_no: string; applied: boolean } | null;
}
interface Finding {
  rule: string; key: string; reason: string; severity: 'high' | 'medium' | 'low'; message: string; expected?: string; actual?: string; tolerance?: string;
  owner_role: Role; owner_user_id?: number | null; vendor_message: string; line_item?: number | null; auto_clear?: boolean;
}

export const AUTO_CLEARED = 'Cleared on re-validation';
export const EDITABLE = ['Uploaded', 'OCR pending', 'Validation pending', 'Exception', 'Matched'];
export const LOCKED = ['Parked', 'Posted', 'Payment due', 'Payment released', 'Payment blocked'];
const RULE_ORDER = ['FIELD_MISSING', 'DUP', 'GSTIN', 'BUYER_GSTIN', 'PO_VENDOR', 'BANK', 'OCR_CONF', 'DISPUTE_HOLD', '3WM-01', 'FDS', '3WM-02', '3WM-03', '3WM-04', '3WM-05'];
export const RULE_LABELS: Record<string, string> = {
  FIELD_MISSING: 'Mandatory field not found', DUP: 'Duplicate invoice (FR-INV-03)', GSTIN: 'Vendor GSTIN (FR-INV-04)', BUYER_GSTIN: 'Buyer GSTIN = plant GSTIN',
  PO_VENDOR: 'PO / vendor mapping', BANK: 'Bank details vs SAP vendor master (FR-INV-09)', OCR_CONF: 'OCR confidence (FR-INV-05)',
  DISPUTE_HOLD: '3WM-07 Dispute hold', '3WM-01': '3WM-01 PO vs invoice', FDS: 'FDS price check (FR-INV-18)', '3WM-02': '3WM-02 GRN/SES vs invoice',
  '3WM-03': '3WM-03 PO vs GRN/SES line mapping', '3WM-04': '3WM-04 Tax (GST rate, HSN/SAC)', '3WM-05': '3WM-05 Freight / other charges', '3WM-06': '3WM-06 Advance adjustment',
};

// ------------------------------------------------------------------ helpers
export function getInvoice(id: number) {
  return get<InvoiceRow>('SELECT * FROM invoices WHERE id = ?', id);
}
function mustInvoice(id: number) {
  const i = getInvoice(id);
  if (!i) throw notFound('Invoice');
  return i;
}
const money = (n: number | null | undefined) => (n == null ? '—' : `₹${round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const num = (v: Val | undefined) => (v == null || v === '' ? null : Number(v));
const last4 = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '').slice(-4);
const normTerms = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

interface PoRow { id: number; po_no: string; vendor_id: number; buyer_id: number | null; plant: string; po_date: string; status: string; payment_terms: string | null; delivery_terms: string | null; freight_terms: string | null; total_value: number | null; contract_id: number | null; synced_at: string | null }
interface PoLineRow { id: number; item: number; material_id: number | null; material_code: string | null; description: string; qty: number; uom: string; unit_price: number; gst_rate: number; freight: number; hsn: string | null; is_service: number; status: string }
const getPo = (id: number) => get<PoRow>('SELECT * FROM pos WHERE id = ?', id);
export const poLinesOf = (poId: number) => all<PoLineRow>(
  'SELECT l.id, l.item, l.material_id, m.code AS material_code, l.description, l.qty, l.uom, l.unit_price, l.gst_rate, l.freight, m.hsn, COALESCE(m.is_service, 0) AS is_service, l.status FROM po_lines l LEFT JOIN materials m ON m.id = l.material_id WHERE l.po_id = ? ORDER BY l.item', poId,
);
const received = (poLineId: number) => get<{ qty: number; value: number; n: number; grns: string | null }>(
  "SELECT COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(value),0) AS value, COUNT(*) AS n, GROUP_CONCAT(grn_no, ', ') AS grns FROM grns WHERE po_line_id = ?", poLineId,
)!;
/** Quantity of a PO item already billed on other live invoices of the same PO. */
function billedElsewhere(inv: InvoiceRow, item: number) {
  let q = 0;
  let v = 0;
  for (const o of all<{ id: number; values: Values | null }>("SELECT id, values_json FROM invoices WHERE po_id = ? AND id != ? AND status != 'Rejected' AND duplicate_of IS NULL", inv.po_id, inv.id)) {
    for (const l of o.values?.lines ?? []) if (Number(l.po_item) === item) { q += Number(l.qty ?? 0); v += Number(l.qty ?? 0) * Number(l.rate ?? 0); }
  }
  return { qty: q, value: v };
}
function vendorUsers(vendorId: number) {
  return all<{ id: number }>('SELECT id FROM users WHERE vendor_id = ? AND active = 1', vendorId).map((u) => u.id);
}

export function event(invId: number, title: string, opts: { status?: string; note?: string | null; vendorNote?: string | null; vendorVisible?: boolean; userId?: number | null } = {}) {
  insert('invoice_events', {
    invoice_id: invId, status: opts.status ?? null, title, note: opts.note ?? null, vendor_note: opts.vendorNote ?? null,
    vendor_visible: opts.vendorVisible === false ? 0 : 1, user_id: opts.userId ?? null, created_at: ts(),
  });
}

/** Map a dispute's owner party to an exception owner role (WF-10: dispute → dispute owner). */
function disputeOwner(d: { owner_party: string }, buyerId: number | null): { role: Role; user: number | null } {
  if (d.owner_party === 'Stores') return { role: 'STO', user: null };
  if (d.owner_party === 'Finance') return { role: 'FIN', user: null };
  return { role: 'BUY', user: buyerId };
}

function openDisputes(poId: number) {
  try {
    return openDisputesForPo(poId);
  } catch {
    return all<{ id: number; dsp_no: string; po_line_id: number; item: number; type: string; status: string; qty: number; value: number | null; owner_party: string; uom: string; description: string; created_at: string; reason: string }>(
      `SELECT d.id, d.dsp_no, d.po_line_id, l.item, d.type, d.status, d.qty, d.value, d.owner_party, l.uom, l.description, d.created_at, '' AS reason
       FROM disputes d JOIN po_lines l ON l.id = d.po_line_id WHERE d.po_id = ? AND d.status NOT IN ('Resolved','Closed')`, poId,
    );
  }
}

/** FDS expected price: contracts module first, else the contract item net price (CON-05, AC-CON-05). */
function fdsExpected(contractId: number, materialId: number, poDate: string) {
  const r = expectedFdsPrice(contractId, materialId, poDate);
  if (r) return { expected: r.expected_price, basis: `Price list v${r.version} ${money(r.list_price)} less ${r.discount_pct}%` };
  const ci = get<{ unit_price: number; discount_pct: number | null }>('SELECT unit_price, discount_pct FROM contract_items WHERE contract_id = ? AND material_id = ?', contractId, materialId);
  if (!ci) return null;
  return { expected: ci.unit_price, basis: `Contract net price${ci.discount_pct ? ` (${ci.discount_pct}% discount applied)` : ''} — no price list on file` };
}

/** Advances that apply to an invoice's PO (directly or through the PO's contract) — 3WM-06. */
export function advancesForPo(po: Pick<PoRow, 'id' | 'contract_id'>) {
  return all<{ id: number; adv_no: string; amount: number; adjusted_amount: number; status: string; po_id: number | null; contract_id: number | null }>(
    `SELECT id, adv_no, amount, adjusted_amount, status, po_id, contract_id FROM advances
     WHERE status IN ('Approved','Paid','Partially adjusted','Fully adjusted') AND (po_id = ? OR (contract_id IS NOT NULL AND contract_id = ?)) ORDER BY id`,
    po.id, po.contract_id ?? -1,
  );
}

// ------------------------------------------------------------------ upload (FR-INV-01, FR-INV-10, WF-09)
export interface UploadInput {
  po_id: number; attachment_id: number; asn_id?: number | null;
  header: Record<string, Val | undefined>; lines: Record<string, Val | undefined>[];
}

export function createInvoice(actor: Actor, input: UploadInput) {
  const po = getPo(input.po_id);
  if (!po) throw notFound('Purchase order');
  const isVendor = actor.role === 'VEN';
  if (isVendor) assertVendorScope(actor, po.vendor_id, 'po', po.id);
  else {
    if (!actor.perms.has('inv.upload_behalf')) throw forbidden('Your role cannot upload invoices on a vendor’s behalf.');
    if (!cfg<boolean>('inv.upload_on_behalf')) throw new HttpError(403, 'on_behalf_disabled', 'Uploading invoices on a vendor’s behalf is switched off in Business rules (decision Q 7.10). Ask the vendor to upload it in the portal.');
    if (!plantAllowed(actor, po.plant)) throw forbidden(`You do not have access to plant ${po.plant}.`);
  }
  if (po.status === 'Cancelled') throw conflict(`PO ${po.po_no} is cancelled in SAP; invoices cannot be submitted against it.`);
  const att = getAttachment(input.attachment_id);
  if (!att || att.uploaded_by !== actor.id) throw badRequest('Upload the invoice file again — the file was not found.', { attachment_id: 'Upload the invoice file' });
  if (att.owner_id != null) throw badRequest('This file is already attached to another record. Upload the invoice file again.', { attachment_id: 'File already used' });
  if (att.scan_status !== 'Available') throw badRequest('The file did not pass the file check. Upload a clean copy.', { attachment_id: 'File not available' });
  if (!/^(application\/pdf|image\/(png|jpeg|webp))$/.test(att.mime)) throw badRequest('Upload the invoice as a PDF or a photo (JPG, PNG or WebP).', { attachment_id: 'PDF or image only' });
  if (input.asn_id) {
    const asn = get<{ po_id: number }>('SELECT po_id FROM asns WHERE id = ?', input.asn_id);
    if (!asn || asn.po_id !== po.id) throw badRequest('The ASN does not belong to this PO.', { asn_id: 'Choose an ASN of this PO' });
  }
  if (!input.lines.length) throw badRequest('Enter at least one invoice line.', { lines: 'Add a line' });
  const lines = poLinesOf(po.id);
  const isService = lines.length > 0 && lines.every((l) => l.is_service) ? 1 : 0;
  const sha = get<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id = ?', att.id)!.sha256;

  return tx(() => {
    const at = ts();
    const ref = nextNo('INV');
    const id = insert('invoices', {
      inv_ref: ref, vendor_id: po.vendor_id, po_id: po.id, asn_id: input.asn_id ?? null, status: 'Uploaded', currency: 'INR',
      on_behalf: isVendor ? 0 : 1, uploaded_by: actor.id, attachment_id: att.id, is_service: isService, created_at: at, updated_at: at,
      freight: 0, other_charges: 0, dispute_hold: 0,
    });
    linkAttachments([att.id], 'invoice', id);
    run('UPDATE attachments SET label = ? WHERE id = ?', 'Invoice (original)', att.id);
    event(id, isVendor ? 'Uploaded by vendor' : 'Uploaded by finance on the vendor’s behalf', {
      status: 'Uploaded', userId: actor.id, note: `${att.filename} against PO ${po.po_no}`,
      vendorNote: isVendor ? 'Invoice received' : 'Invoice received — uploaded by Equipcare accounts on your behalf',
    });
    audit(actor, { action: 'invoice.uploaded', objectType: 'invoice', objectId: id, objectRef: ref, after: { po: po.po_no, file: att.filename, on_behalf: !isVendor } });

    // WF-09: OCR (simulated) → values → validation.
    update('invoices', id, { status: 'OCR pending' });
    const extracted = simulateOcr({ header: input.header as Entered['header'], lines: input.lines as Entered['lines'] }, sha, att.mime);
    const values: Values = { ...valuesFrom(extracted), verified: [] };
    update('invoices', id, { status: 'Validation pending', extracted_json: J(extracted), values_json: J(values), ocr_engine: OCR_ENGINE, ocr_at: at });
    syncHeaderColumns(id, values);
    const notFoundCount = Object.values(extracted.header).filter((f) => !f.found).length;
    event(id, 'Details read (simulated OCR)', { status: 'Validation pending', note: `${OCR_NOTE}. Capture: ${extracted.capture}. ${notFoundCount} header field(s) not found.`, vendorNote: 'Invoice details captured; validation in progress' });
    audit(null, { action: 'invoice.ocr_simulated', objectType: 'invoice', objectId: id, objectRef: ref, after: { engine: OCR_ENGINE, capture: extracted.capture } });

    const buyer = po.buyer_id;
    notify({ event: 'NTF-27', title: `Invoice received: ${ref}`, body: `${vendorName(po.vendor_id)} · PO ${po.po_no}${isVendor ? '' : ' · uploaded by finance on the vendor’s behalf'}`, link: `/invoices/${id}`, roles: ['FIN'], users: [buyer], exclude: [actor.id], objectType: 'invoice', objectId: id });
    if (!isVendor) notify({ event: 'NTF-27', title: `Invoice ${input.header.invoice_no ?? ref} received by Equipcare`, body: `Uploaded by Equipcare accounts on your behalf against PO ${po.po_no}.`, link: `/vendor/invoices/${id}`, vendorId: po.vendor_id, objectType: 'invoice', objectId: id });
    validate(id, null, 'upload');
    return getInvoice(id)!;
  });
}

const vendorName = (vendorId: number) => get<{ name: string }>('SELECT name FROM vendors WHERE id = ?', vendorId)?.name ?? 'Vendor';

/** Keep the invoice header columns in step with the working values. */
function syncHeaderColumns(id: number, v: Values) {
  const h = v.header;
  const no = h.invoice_no != null ? String(h.invoice_no) : null;
  const date = h.invoice_date != null ? String(h.invoice_date) : null;
  update('invoices', id, {
    vendor_invoice_no: no, normalized_no: no ? normalizeInvoiceNo(no) : null, invoice_date: date,
    fy: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? financialYear(date) : financialYear(ts()),
    taxable_value: num(h.taxable_value), gst_amount: num(h.gst_amount), total_value: num(h.total_value),
    freight: num(h.freight) ?? 0, other_charges: num(h.other_charges) ?? 0, updated_at: ts(),
  });
}

// ------------------------------------------------------------------ validation and 3-way match (WF-09, WF-10)
export function validate(invId: number, actor: Actor | null, trigger: string) {
  const inv = mustInvoice(invId);
  if (!EDITABLE.includes(inv.status)) return inv;
  const v = inv.values!;
  const h = v.header;
  const po = getPo(inv.po_id)!;
  const vendor = get<{ id: number; name: string; pan: string | null; gstin: string | null; bank_account_masked: string | null; bank_ifsc: string | null; sap_code: string | null }>('SELECT * FROM vendors WHERE id = ?', inv.vendor_id)!;
  const plant = get<{ code: string; gstin: string | null }>('SELECT code, gstin FROM plants WHERE code = ?', po.plant);
  const tol = cfg<Record<string, number>>('tolerance.3wm');
  const tolRow = get<{ version: number; status: string }>("SELECT version, status FROM config WHERE key = 'tolerance.3wm'");
  const holdRule = cfg<string>('dispute.hold_rule');
  const dupScope = cfg<string>('ocr.duplicate_scope');
  const poLines = poLinesOf(po.id);
  const byItem = new Map(poLines.map((l) => [l.item, l]));
  const findings: Finding[] = [];
  const results: RuleResult[] = [];
  const corrected = new Set(all<{ field: string }>('SELECT field FROM invoice_corrections WHERE invoice_id = ?', inv.id).map((c) => c.field));
  const priceTol = (base: number) => Math.max((base * (tol.price_pct ?? 0)) / 100, tol.price_abs ?? 0);
  const tolText = `${tol.price_pct ?? 0}% or ${money(tol.price_abs ?? 0)} (DEC-07)`;

  // --- mandatory fields (AC-INV-02: populated or "not found")
  const missing = HEADER_FIELDS.filter((f) => f.mandatory && (h[f.key] == null || h[f.key] === ''));
  const lineMissing: string[] = [];
  v.lines.forEach((l, i) => { for (const f of LINE_FIELDS) if (f.mandatory && (l[f.key] == null || l[f.key] === '')) lineMissing.push(`line ${i + 1} ${f.label.toLowerCase()}`); });
  for (const f of missing) findings.push({ rule: 'FIELD_MISSING', key: `FIELD_MISSING:${f.key}`, reason: 'Field not found', severity: 'high', message: `${f.label} was not found on the invoice. Correct the field from the document.`, expected: 'A value', actual: 'Not found', owner_role: 'FIN', vendor_message: `${f.label} could not be read from your invoice. Accounts is checking it.` });
  if (lineMissing.length) findings.push({ rule: 'FIELD_MISSING', key: 'FIELD_MISSING:lines', reason: 'Field not found', severity: 'high', message: `Not found: ${lineMissing.join(', ')}.`, expected: 'A value', actual: 'Not found', owner_role: 'FIN', vendor_message: 'Some line details could not be read from your invoice. Accounts is checking them.' });
  results.push({ rule: 'FIELD_MISSING', label: RULE_LABELS.FIELD_MISSING, status: missing.length || lineMissing.length ? 'fail' : 'pass', summary: missing.length || lineMissing.length ? `Not found: ${[...missing.map((f) => f.label), ...lineMissing].join(', ')}` : 'All mandatory fields found', checks: [] });

  // --- duplicate (FR-INV-03, AC-INV-03) — blocks matching
  const normalized = h.invoice_no != null ? normalizeInvoiceNo(String(h.invoice_no)) : null;
  const fy = inv.fy;
  const dup = normalized ? get<{ id: number; inv_ref: string; vendor_invoice_no: string; status: string }>(
    `SELECT id, inv_ref, vendor_invoice_no, status FROM invoices WHERE vendor_id = ? AND normalized_no = ? AND id < ? AND status != 'Rejected' ${dupScope === 'financial_year' ? 'AND fy = ?' : ''} ORDER BY id LIMIT 1`,
    inv.vendor_id, normalized, inv.id, ...(dupScope === 'financial_year' ? [fy] : []),
  ) : undefined;
  if (dup) {
    findings.push({ rule: 'DUP', key: 'DUP', reason: 'Duplicate invoice', severity: 'high', message: `Invoice number "${h.invoice_no}" normalises to ${normalized}, the same as ${dup.inv_ref} ("${dup.vendor_invoice_no}") from this vendor in FY ${fy}. Matching is blocked.`, expected: 'Unique number per vendor per financial year', actual: `Same as ${dup.inv_ref}`, owner_role: 'FIN', vendor_message: `An invoice with number ${dup.vendor_invoice_no} was already submitted this financial year (${dup.inv_ref}). It will not be processed twice.`, auto_clear: true });
  }
  update('invoices', inv.id, { duplicate_of: dup?.id ?? null });
  results.push({ rule: 'DUP', label: RULE_LABELS.DUP, status: dup ? 'fail' : 'pass', summary: dup ? `Duplicate of ${dup.inv_ref}` : `No other invoice ${normalized ?? '—'} from this vendor in ${dupScope === 'financial_year' ? `FY ${fy}` : 'any year'}`, checks: [{ check: 'Normalised number', expected: 'Unique', actual: normalized ?? 'Not found', ok: !dup }] });

  // --- vendor GSTIN (FR-INV-04, AC-INV-04)
  const gChecks: RuleResult['checks'] = [];
  if (h.vendor_gstin) {
    const g = validateGstin(String(h.vendor_gstin));
    gChecks.push({ check: 'Structure and check digit', expected: 'Valid GSTIN', actual: g.ok ? 'Valid' : g.reason!, ok: g.ok });
    if (!g.ok) findings.push({ rule: 'GSTIN', key: 'GSTIN', reason: 'GSTIN invalid', severity: 'high', message: `Vendor GSTIN ${h.vendor_gstin}: ${g.reason}.`, expected: 'Valid GSTIN (structure + check digit)', actual: String(h.vendor_gstin), owner_role: 'FIN', vendor_message: 'The GSTIN on your invoice is not valid. Please send a corrected invoice.' });
    else {
      const pan = panFromGstin(String(h.vendor_gstin));
      const ok = !!vendor.pan && pan === vendor.pan;
      gChecks.push({ check: 'PAN in GSTIN = vendor PAN', expected: vendor.pan ?? 'PAN on vendor master', actual: pan, ok });
      if (!ok) findings.push({ rule: 'GSTIN', key: 'GSTIN', reason: 'GSTIN not of this vendor', severity: 'high', message: `PAN ${pan} in GSTIN ${h.vendor_gstin} does not match vendor PAN ${vendor.pan ?? '(none on master)'}.`, expected: vendor.pan ?? '—', actual: pan, owner_role: 'FIN', vendor_message: 'The GSTIN on your invoice does not match your registered PAN. Please send a corrected invoice.' });
    }
  }
  results.push({ rule: 'GSTIN', label: RULE_LABELS.GSTIN, status: !h.vendor_gstin ? 'skipped' : gChecks.every((c) => c.ok) ? 'pass' : 'fail', summary: !h.vendor_gstin ? 'Vendor GSTIN not found' : gChecks.every((c) => c.ok) ? 'Valid and belongs to the vendor' : gChecks.find((c) => !c.ok)!.actual, checks: gChecks });

  // --- buyer GSTIN = plant GSTIN
  const bChecks: RuleResult['checks'] = [];
  if (h.buyer_gstin) {
    const g = validateGstin(String(h.buyer_gstin));
    const ok = g.ok && String(h.buyer_gstin) === plant?.gstin;
    bChecks.push({ check: `Buyer GSTIN = ${po.plant} GSTIN`, expected: plant?.gstin ?? '—', actual: String(h.buyer_gstin), ok });
    if (!ok) findings.push({ rule: 'BUYER_GSTIN', key: 'BUYER_GSTIN', reason: 'Buyer GSTIN mismatch', severity: 'high', message: g.ok ? `Billed to GSTIN ${h.buyer_gstin}; plant ${po.plant} is registered as ${plant?.gstin}.` : `Buyer GSTIN ${h.buyer_gstin}: ${g.reason}.`, expected: plant?.gstin ?? '—', actual: String(h.buyer_gstin), owner_role: 'FIN', vendor_message: `The invoice is not billed to the GSTIN of the delivery plant (${po.plant}). Please send a corrected invoice.` });
  }
  results.push({ rule: 'BUYER_GSTIN', label: RULE_LABELS.BUYER_GSTIN, status: !h.buyer_gstin ? 'skipped' : bChecks.every((c) => c.ok) ? 'pass' : 'fail', summary: !h.buyer_gstin ? 'Buyer GSTIN not found' : bChecks[0].ok ? `Matches ${po.plant}` : 'Does not match the plant', checks: bChecks });

  // --- PO and vendor mapping
  const pChecks: RuleResult['checks'] = [
    { check: 'PO number on invoice', expected: po.po_no, actual: h.po_no != null ? String(h.po_no) : 'Not found', ok: String(h.po_no ?? '') === po.po_no },
    { check: 'Vendor code', expected: vendor.sap_code ?? '—', actual: vendor.sap_code ?? '—', ok: po.vendor_id === inv.vendor_id },
  ];
  const badItems = v.lines.filter((l) => l.po_item != null && !byItem.has(Number(l.po_item))).map((l) => l.po_item);
  pChecks.push({ check: 'Invoice items exist on PO', expected: poLines.map((l) => l.item).join(', '), actual: v.lines.map((l) => l.po_item ?? '?').join(', '), ok: badItems.length === 0 });
  if (h.po_no && String(h.po_no) !== po.po_no) findings.push({ rule: 'PO_VENDOR', key: 'PO_VENDOR:po', reason: 'PO number mismatch', severity: 'high', message: `Invoice quotes PO ${h.po_no} but was submitted against ${po.po_no}.`, expected: po.po_no, actual: String(h.po_no), owner_role: 'FIN', vendor_message: `The PO number on the invoice does not match PO ${po.po_no}.` });
  if (badItems.length) findings.push({ rule: 'PO_VENDOR', key: 'PO_VENDOR:items', reason: 'Item not on PO', severity: 'high', message: `PO ${po.po_no} has no item ${badItems.join(', ')}.`, expected: poLines.map((l) => l.item).join(', '), actual: badItems.join(', '), owner_role: 'BUY', owner_user_id: po.buyer_id, vendor_message: `The invoice bills item(s) ${badItems.join(', ')} that are not on PO ${po.po_no}.` });
  results.push({ rule: 'PO_VENDOR', label: RULE_LABELS.PO_VENDOR, status: pChecks.every((c) => c.ok) ? 'pass' : 'fail', summary: pChecks.every((c) => c.ok) ? `PO ${po.po_no} of ${vendor.name}` : 'Mapping problem', checks: pChecks });

  // --- bank details (FR-INV-09) — high severity, never auto-cleared
  if (h.bank_account) {
    const okAcc = last4(String(h.bank_account)) === last4(vendor.bank_account_masked);
    const okIfsc = !h.bank_ifsc || String(h.bank_ifsc) === vendor.bank_ifsc;
    const checks = [{ check: 'Account (last 4 digits)', expected: vendor.bank_account_masked ?? '—', actual: `XXXX${last4(String(h.bank_account))}`, ok: okAcc }, { check: 'IFSC', expected: vendor.bank_ifsc ?? '—', actual: h.bank_ifsc ? String(h.bank_ifsc) : 'Not found', ok: okIfsc }];
    if (!okAcc || !okIfsc) findings.push({ rule: 'BANK', key: 'BANK', reason: 'Bank details mismatch', severity: 'high', message: `Invoice bank details (${checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.actual}`).join('; ')}) differ from the SAP vendor master. Never cleared automatically — finance must decide.`, expected: `${vendor.bank_account_masked} / ${vendor.bank_ifsc}`, actual: `XXXX${last4(String(h.bank_account))} / ${h.bank_ifsc ?? '—'}`, owner_role: 'FIN', vendor_message: 'The bank account on your invoice differs from the account registered with Equipcare. Payment is made only to the registered account; accounts will contact you.', auto_clear: false });
    results.push({ rule: 'BANK', label: RULE_LABELS.BANK, status: okAcc && okIfsc ? 'pass' : 'fail', summary: okAcc && okIfsc ? 'Matches SAP vendor master' : 'Differs from SAP vendor master', checks });
  } else results.push({ rule: 'BANK', label: RULE_LABELS.BANK, status: 'skipped', summary: 'Bank details not found on the invoice — payment goes to the SAP vendor master account', checks: [] });

  // --- OCR confidence (FR-INV-05, FR-INV-08)
  const low: { path: string; label: string; c: number; t: number }[] = [];
  const x = inv.extracted;
  if (x) {
    const check = (path: string, key: string, label: string, f: { found: boolean; confidence: number }, critical?: boolean) => {
      if (!critical || !f.found || v.verified.includes(path) || corrected.has(path)) return;
      const t = thresholdFor(key);
      if (f.confidence < t) low.push({ path, label, c: f.confidence, t });
    };
    for (const d of HEADER_FIELDS) check(d.key, d.key, d.label, x.header[d.key], d.critical);
    x.lines.forEach((l, i) => { for (const d of LINE_FIELDS) if (l[d.key]) check(`lines.${i}.${d.key}`, d.key, `Line ${i + 1} ${d.label.toLowerCase()}`, l[d.key], d.critical); });
  }
  for (const l of low) findings.push({ rule: 'OCR_CONF', key: `OCR_CONF:${l.path}`, reason: 'Low OCR confidence', severity: 'medium', message: `${l.label} read with ${(l.c * 100).toFixed(1)}% confidence; threshold ${(l.t * 100).toFixed(0)}%. Verify against the document or correct it.`, expected: `≥ ${(l.t * 100).toFixed(0)}%`, actual: `${(l.c * 100).toFixed(1)}%`, tolerance: 'cfg ocr.confidence', owner_role: 'FIN', vendor_message: 'Some details could not be read clearly. Accounts is verifying them against your invoice.' });
  results.push({ rule: 'OCR_CONF', label: RULE_LABELS.OCR_CONF, status: low.length ? 'fail' : 'pass', summary: low.length ? `${low.length} field(s) below threshold` : 'All critical fields at or above threshold (or verified)', checks: low.map((l) => ({ check: l.label, expected: `≥ ${(l.t * 100).toFixed(0)}%`, actual: `${(l.c * 100).toFixed(1)}%`, ok: false })) });

  // ----------------------------------------------------------- 3-way match, WF-10 rule order
  const blocked = !!dup;
  const skip = (rule: string) => results.push({ rule, label: RULE_LABELS[rule], status: 'skipped', summary: 'Not run — duplicate invoice blocks matching', checks: [] });
  let advance: MatchResult['advance'] = null;
  let fdsInfo: MatchResult['fds'] = null;
  let waiting = false;
  if (blocked) {
    for (const r of ['DISPUTE_HOLD', '3WM-01', 'FDS', '3WM-02', '3WM-03', '3WM-04', '3WM-05', '3WM-06']) skip(r);
  } else {
    const invItems = new Set(v.lines.map((l) => Number(l.po_item)));
    // 3WM-07 dispute hold (DEC-20)
    const disputes = openDisputes(po.id);
    const dChecks: RuleResult['checks'] = [];
    for (const d of disputes) {
      const billed = invItems.has(d.item);
      const applies = holdRule === 'full' || billed;
      dChecks.push({ item: d.item, check: `${d.dsp_no} ${d.type} (${d.status})`, expected: 'No open dispute', actual: `${d.qty} ${d.uom} disputed, owner ${d.owner_party}`, ok: !applies, note: applies ? (holdRule === 'full' ? 'Whole invoice held (DEC-20: full)' : 'Disputed line held (DEC-20: partial)') : 'Line not billed on this invoice' });
      if (!applies) continue;
      const o = disputeOwner(d, po.buyer_id);
      const ownerUser = get<{ owner_user_id: number | null }>('SELECT owner_user_id FROM disputes WHERE id = ?', d.id)?.owner_user_id ?? o.user;
      const line = v.lines.find((l) => Number(l.po_item) === d.item);
      findings.push({
        rule: 'DISPUTE_HOLD', key: `DSP:${d.id}`, reason: 'Dispute hold', severity: holdRule === 'full' ? 'high' : 'medium', line_item: d.item,
        message: `Open ${d.type.toLowerCase()} dispute ${d.dsp_no} on PO item ${d.item} (${d.qty} ${d.uom}, owner ${d.owner_party}). ${holdRule === 'full' ? 'The whole invoice is on hold' : `Item ${d.item}${line ? ` (${money(Number(line.qty) * Number(line.rate))})` : ''} is held`} until the dispute is resolved (DEC-20: ${holdRule}).`,
        expected: 'No open dispute', actual: `${d.dsp_no} open`, tolerance: `Hold rule: ${holdRule}`, owner_role: o.role, owner_user_id: ownerUser,
        vendor_message: `Payment is on hold until the open delivery dispute ${d.dsp_no} (item ${d.item}) is resolved.`,
      });
    }
    results.push({ rule: 'DISPUTE_HOLD', label: RULE_LABELS.DISPUTE_HOLD, status: dChecks.some((c) => !c.ok) ? 'fail' : disputes.length ? 'info' : 'pass', summary: dChecks.some((c) => !c.ok) ? `On hold: ${disputes.map((d) => d.dsp_no).join(', ')} (rule ${holdRule})` : disputes.length ? 'Open disputes on lines not billed here' : 'No open disputes on this PO', checks: dChecks });

    // 3WM-01 PO vs invoice: rate, payment terms, value
    const c1: RuleResult['checks'] = [];
    for (const l of v.lines) {
      const pl = byItem.get(Number(l.po_item));
      if (!pl) continue;
      const rate = Number(l.rate ?? 0);
      const diff = round2(rate - pl.unit_price);
      const allowed = priceTol(pl.unit_price);
      const ok = diff <= allowed + 0.005;
      c1.push({ item: pl.item, check: 'Rate', expected: money(pl.unit_price), actual: money(rate), tolerance: tolText, ok, note: diff > 0 ? `${((diff / pl.unit_price) * 100).toFixed(2)}% above PO` : undefined });
      if (!ok) findings.push({ rule: '3WM-01', key: `3WM-01:rate:${pl.item}`, reason: 'Price variance', severity: 'medium', line_item: pl.item, message: `Item ${pl.item}: billed ${money(rate)}, PO rate ${money(pl.unit_price)} (+${((diff / pl.unit_price) * 100).toFixed(2)}%); allowed ${tolText}.`, expected: money(pl.unit_price), actual: money(rate), tolerance: tolText, owner_role: 'BUY', owner_user_id: po.buyer_id, vendor_message: `The rate billed on item ${pl.item} is higher than the purchase order rate. Please send a credit note or a revised invoice.` });
      const lineTaxable = num(l.taxable_value);
      if (lineTaxable != null && Math.abs(lineTaxable - round2(Number(l.qty ?? 0) * rate)) > Math.max(1, tol.total_abs ?? 0)) {
        c1.push({ item: pl.item, check: 'Line value = qty × rate', expected: money(Number(l.qty ?? 0) * rate), actual: money(lineTaxable), ok: false });
        findings.push({ rule: '3WM-01', key: `3WM-01:value:${pl.item}`, reason: 'Line value error', severity: 'medium', line_item: pl.item, message: `Item ${pl.item}: taxable value ${money(lineTaxable)} is not qty × rate (${money(Number(l.qty ?? 0) * rate)}).`, expected: money(Number(l.qty ?? 0) * rate), actual: money(lineTaxable), tolerance: money(Math.max(1, tol.total_abs ?? 0)), owner_role: 'FIN', vendor_message: `The value on item ${pl.item} does not equal quantity × rate.` });
      }
    }
    if (h.payment_terms) {
      const ok = normTerms(String(h.payment_terms)) === normTerms(po.payment_terms);
      c1.push({ check: 'Payment terms', expected: po.payment_terms ?? '—', actual: String(h.payment_terms), ok });
      if (!ok) findings.push({ rule: '3WM-01', key: '3WM-01:terms', reason: 'Payment terms differ', severity: 'low', message: `Invoice states "${h.payment_terms}"; PO terms are "${po.payment_terms}". SAP pays on PO terms.`, expected: po.payment_terms ?? '—', actual: String(h.payment_terms), owner_role: 'BUY', owner_user_id: po.buyer_id, vendor_message: 'The payment terms on the invoice differ from the purchase order terms. Payment follows the PO terms.' });
    }
    const computed = round2(v.lines.reduce((s, l) => s + Number(l.qty ?? 0) * Number(l.rate ?? 0) * (1 + Number(l.gst_rate ?? 0) / 100), 0) + (num(h.freight) ?? 0) + (num(h.other_charges) ?? 0));
    const total = num(h.total_value);
    if (total != null) {
      const ok = Math.abs(total - computed) <= Math.max(1, tol.total_abs ?? 0);
      c1.push({ check: 'Invoice total = lines + GST + charges', expected: money(computed), actual: money(total), tolerance: money(Math.max(1, tol.total_abs ?? 0)), ok });
      if (!ok) findings.push({ rule: '3WM-01', key: '3WM-01:total', reason: 'Invoice total mismatch', severity: 'medium', message: `Invoice total ${money(total)} differs from lines + GST + charges ${money(computed)}.`, expected: money(computed), actual: money(total), tolerance: money(Math.max(1, tol.total_abs ?? 0)), owner_role: 'FIN', vendor_message: 'The invoice total does not add up to the line values, GST and charges.' });
    }
    results.push({ rule: '3WM-01', label: RULE_LABELS['3WM-01'], status: c1.every((c) => c.ok) ? 'pass' : 'fail', summary: c1.every((c) => c.ok) ? 'Rates, terms and value agree with the PO' : `${c1.filter((c) => !c.ok).length} difference(s)`, checks: c1 });

    // FDS price check (FR-INV-18, CON-05)
    const contract = po.contract_id ? get<{ id: number; contract_no: string; type: string; invoice_validation: number }>('SELECT id, contract_no, type, invoice_validation FROM contracts WHERE id = ?', po.contract_id) : undefined;
    if (contract?.type === 'FDS' && contract.invoice_validation) {
      fdsInfo = { contract_no: contract.contract_no, applied: true };
      const cf: RuleResult['checks'] = [];
      for (const l of v.lines) {
        const pl = byItem.get(Number(l.po_item));
        if (!pl?.material_id) continue;
        const e = fdsExpected(contract.id, pl.material_id, po.po_date);
        if (!e) { cf.push({ item: pl.item, check: 'FDS price', expected: 'Price list entry', actual: 'No price for this material', ok: true, note: 'Not on price list' }); continue; }
        const rate = Number(l.rate ?? 0);
        const ok = rate - e.expected <= priceTol(e.expected) + 0.005;
        cf.push({ item: pl.item, check: 'Rate = list price × (1 − discount)', expected: money(e.expected), actual: money(rate), tolerance: tolText, ok, note: e.basis });
        if (!ok) findings.push({ rule: 'FDS', key: `FDS:${pl.item}`, reason: 'FDS price variance', severity: 'medium', line_item: pl.item, message: `Item ${pl.item}: billed ${money(rate)}, FDS ${contract.contract_no} expects ${money(e.expected)} (${e.basis}).`, expected: money(e.expected), actual: money(rate), tolerance: tolText, owner_role: 'BUY', owner_user_id: po.buyer_id, vendor_message: `The rate on item ${pl.item} does not follow the agreed price list and discount. Please send a credit note or a revised invoice.` });
      }
      results.push({ rule: 'FDS', label: RULE_LABELS.FDS, status: cf.every((c) => c.ok) ? 'pass' : 'fail', summary: cf.every((c) => c.ok) ? `Rates follow ${contract.contract_no}` : 'Rates differ from the FDS price', checks: cf });
    } else results.push({ rule: 'FDS', label: RULE_LABELS.FDS, status: 'skipped', summary: contract?.type === 'FDS' ? `${contract.contract_no} does not have invoice validation switched on` : 'PO is not under a fixed discount structure', checks: [] });

    // 3WM-03 mapping first (it decides whether 3WM-02 applies to a line), reported in WF-10 order.
    const c3: RuleResult['checks'] = [];
    const mismatched = new Set<number>();
    for (const l of v.lines) {
      const pl = byItem.get(Number(l.po_item));
      if (!pl) continue;
      const code = l.material_code ? String(l.material_code) : null;
      if (code && pl.material_code && code !== pl.material_code) {
        const other = poLines.find((x) => x.material_code === code);
        mismatched.add(pl.item);
        c3.push({ item: pl.item, check: 'Material on PO item', expected: pl.material_code, actual: code, ok: false });
        findings.push({ rule: '3WM-03', key: `3WM-03:${pl.item}`, reason: 'PO/GRN line mismatch', severity: 'medium', line_item: pl.item, message: `Invoice item ${pl.item} carries ${code}, but PO item ${pl.item} is ${pl.material_code}${other ? `; ${code} is PO item ${other.item}` : ''}.`, expected: pl.material_code, actual: code, owner_role: 'STO', vendor_message: `Item ${pl.item} on the invoice does not match the material on that PO line.` });
        continue;
      }
      const rec = received(pl.id);
      if (rec.qty === 0) {
        const wrong = poLines.filter((x) => x.item !== pl.item && !invItems.has(x.item)).map((x) => ({ x, r: received(x.id), b: billedElsewhere(inv, x.item) })).find((o) => o.r.qty - o.b.qty > 0);
        if (wrong) {
          mismatched.add(pl.item);
          c3.push({ item: pl.item, check: 'GRN/SES on billed line', expected: `GRN on item ${pl.item}`, actual: `GRN ${wrong.r.grns} on item ${wrong.x.item}`, ok: false });
          findings.push({ rule: '3WM-03', key: `3WM-03:${pl.item}`, reason: 'PO/GRN line mismatch', severity: 'medium', line_item: pl.item, message: `Invoice bills PO item ${pl.item}, which has no GRN; GRN ${wrong.r.grns} (${wrong.r.qty} ${wrong.x.uom}) was posted against item ${wrong.x.item}. Check the GRN line in SAP.`, expected: `GRN on item ${pl.item}`, actual: `GRN on item ${wrong.x.item}`, owner_role: 'STO', vendor_message: `The goods receipt for item ${pl.item} is recorded on a different PO line. Equipcare stores is checking it.` });
          continue;
        }
      }
      c3.push({ item: pl.item, check: 'Line mapping', expected: pl.material_code ?? pl.description, actual: code ?? 'As PO', ok: true });
    }

    // 3WM-02 GRN/SES vs invoice
    const c2: RuleResult['checks'] = [];
    for (const l of v.lines) {
      const pl = byItem.get(Number(l.po_item));
      if (!pl || mismatched.has(pl.item)) continue;
      const rec = received(pl.id);
      const before = billedElsewhere(inv, pl.item);
      const avail = round2(rec.qty - before.qty);
      const qty = Number(l.qty ?? 0);
      const allowedQty = (avail * (tol.qty_pct ?? 0)) / 100;
      const doc = inv.is_service || pl.is_service ? 'SES' : 'GRN';
      if (rec.qty === 0) {
        waiting = true;
        c2.push({ item: pl.item, check: `${doc} quantity`, expected: `≥ ${qty} ${pl.uom}`, actual: `No ${doc} yet`, ok: false, note: 'Waiting — re-matches automatically when SAP posts it' });
        findings.push({ rule: '3WM-02', key: `3WM-02:pending:${pl.item}`, reason: `Pending ${doc}`, severity: 'low', line_item: pl.item, message: `No ${doc} posted in SAP for PO item ${pl.item} yet. The invoice waits and re-matches automatically on the next ${doc} sync.`, expected: `${doc} for ${qty} ${pl.uom}`, actual: 'None', owner_role: 'STO', vendor_message: `Waiting for the goods / service receipt for item ${pl.item} at the plant.` });
        continue;
      }
      const short = rec.qty < pl.qty;
      const ok = qty <= avail + allowedQty + 1e-9;
      c2.push({ item: pl.item, check: `${doc} quantity`, expected: `≤ ${avail} ${pl.uom}`, actual: `${qty} ${pl.uom}`, tolerance: `${tol.qty_pct ?? 0}% (DEC-07)`, ok, note: `${doc} ${rec.grns}: ${rec.qty} of ${pl.qty} received${short ? ' (short receipt)' : ''}${before.qty ? `; ${before.qty} billed on other invoices` : ''}` });
      if (!ok) findings.push({ rule: '3WM-02', key: `3WM-02:qty:${pl.item}`, reason: 'Excess billing', severity: 'medium', line_item: pl.item, message: `Item ${pl.item}: invoice bills ${qty} ${pl.uom}; ${doc} ${rec.grns} received ${rec.qty} of ${pl.qty}${short ? ' (short receipt)' : ''}${before.qty ? ` and ${before.qty} are already billed` : ''} — ${round2(qty - avail)} ${pl.uom} billed in excess.`, expected: `≤ ${avail} ${pl.uom}`, actual: `${qty} ${pl.uom}`, tolerance: `${tol.qty_pct ?? 0}%`, owner_role: 'BUY', owner_user_id: po.buyer_id, vendor_message: `The quantity billed on item ${pl.item} (${qty}) is more than the quantity received (${avail}). Please send a credit note or a revised invoice.` });
      if (doc === 'SES' && rec.value > 0) {
        const lineVal = qty * Number(l.rate ?? 0);
        const availVal = round2(rec.value - before.value);
        const okV = lineVal <= availVal + priceTol(availVal) + 0.005;
        c2.push({ item: pl.item, check: 'SES value', expected: `≤ ${money(availVal)}`, actual: money(lineVal), ok: okV });
        if (!okV) findings.push({ rule: '3WM-02', key: `3WM-02:value:${pl.item}`, reason: 'Excess billing', severity: 'medium', line_item: pl.item, message: `Item ${pl.item}: billed ${money(lineVal)} exceeds the accepted service value ${money(availVal)} on SES ${rec.grns}.`, expected: money(availVal), actual: money(lineVal), owner_role: 'BUY', owner_user_id: po.buyer_id, vendor_message: `The value billed on item ${pl.item} is more than the accepted service entry.` });
      }
    }
    results.push({ rule: '3WM-02', label: RULE_LABELS['3WM-02'], status: c2.some((c) => !c.ok && c.note?.startsWith('Waiting')) && c2.every((c) => c.ok || c.note?.startsWith('Waiting')) ? 'waiting' : c2.every((c) => c.ok) ? 'pass' : 'fail', summary: c2.every((c) => c.ok) ? `Billed quantities within ${inv.is_service ? 'SES' : 'GRN'}` : c2.filter((c) => !c.ok).map((c) => `Item ${c.item}: ${c.note?.startsWith('Waiting') ? 'pending receipt' : 'excess billing'}`).join('; '), checks: c2 });
    results.push({ rule: '3WM-03', label: RULE_LABELS['3WM-03'], status: c3.every((c) => c.ok) ? 'pass' : 'fail', summary: c3.every((c) => c.ok) ? 'Invoice lines map to the PO and GRN/SES lines' : 'Line mapping problem', checks: c3 });

    // 3WM-04 Tax
    const c4: RuleResult['checks'] = [];
    for (const l of v.lines) {
      const pl = byItem.get(Number(l.po_item));
      if (!pl) continue;
      const rate = num(l.gst_rate);
      if (rate != null) {
        const ok = rate === pl.gst_rate;
        c4.push({ item: pl.item, check: 'GST rate', expected: `${pl.gst_rate}%`, actual: `${rate}%`, ok });
        if (!ok) findings.push({ rule: '3WM-04', key: `3WM-04:rate:${pl.item}`, reason: 'Tax mismatch', severity: 'medium', line_item: pl.item, message: `Item ${pl.item}: GST ${rate}% on invoice, ${pl.gst_rate}% on PO.`, expected: `${pl.gst_rate}%`, actual: `${rate}%`, owner_role: 'FIN', vendor_message: `The GST rate on item ${pl.item} does not match the purchase order. Please send a corrected invoice.` });
      }
      const hsn = l.hsn ? String(l.hsn).replace(/\s/g, '') : null;
      if (hsn && pl.hsn) {
        const ok = pl.hsn.startsWith(hsn) || hsn.startsWith(pl.hsn);
        c4.push({ item: pl.item, check: 'HSN / SAC', expected: pl.hsn, actual: hsn, ok });
        if (!ok) findings.push({ rule: '3WM-04', key: `3WM-04:hsn:${pl.item}`, reason: 'Tax mismatch', severity: 'medium', line_item: pl.item, message: `Item ${pl.item}: HSN/SAC ${hsn} on invoice, ${pl.hsn} on the material master.`, expected: pl.hsn, actual: hsn, owner_role: 'FIN', vendor_message: `The HSN/SAC code on item ${pl.item} does not match the material. Please send a corrected invoice.` });
      }
      const gstAmt = num(l.gst_amount);
      if (gstAmt != null && rate != null) {
        const exp = round2(Number(l.qty ?? 0) * Number(l.rate ?? 0) * rate / 100);
        const ok = Math.abs(gstAmt - exp) <= Math.max(1, tol.tax_abs ?? 0);
        c4.push({ item: pl.item, check: 'GST amount', expected: money(exp), actual: money(gstAmt), tolerance: money(Math.max(1, tol.tax_abs ?? 0)), ok });
        if (!ok) findings.push({ rule: '3WM-04', key: `3WM-04:amt:${pl.item}`, reason: 'Tax mismatch', severity: 'medium', line_item: pl.item, message: `Item ${pl.item}: GST amount ${money(gstAmt)}, expected ${money(exp)}.`, expected: money(exp), actual: money(gstAmt), tolerance: money(Math.max(1, tol.tax_abs ?? 0)), owner_role: 'FIN', vendor_message: `The GST amount on item ${pl.item} is not correct.` });
      }
    }
    results.push({ rule: '3WM-04', label: RULE_LABELS['3WM-04'], status: c4.every((c) => c.ok) ? 'pass' : 'fail', summary: c4.every((c) => c.ok) ? 'GST rate, HSN/SAC and tax value agree with the PO' : 'Tax difference', checks: c4 });

    // 3WM-05 Freight / other charges vs PO terms
    const c5: RuleResult['checks'] = [];
    const freight = num(h.freight) ?? 0;
    const poFreight = round2(poLines.reduce((s, l) => s + (l.freight ?? 0), 0));
    if (freight > 0) {
      const ok = poFreight > 0 && freight <= poFreight + (tol.freight_abs ?? 0);
      c5.push({ check: 'Freight', expected: poFreight > 0 ? `≤ ${money(poFreight)} (${po.freight_terms ?? po.delivery_terms ?? 'PO terms'})` : `Not in PO terms (${po.delivery_terms ?? '—'}, ${po.freight_terms ?? '—'})`, actual: money(freight), tolerance: money(tol.freight_abs ?? 0), ok });
      if (!ok) findings.push({ rule: '3WM-05', key: '3WM-05:freight', reason: poFreight > 0 ? 'Freight above PO terms' : 'Unapproved freight', severity: 'medium', message: poFreight > 0 ? `Freight ${money(freight)} exceeds PO freight ${money(poFreight)}. On hold until approved.` : `Freight ${money(freight)} is billed but PO ${po.po_no} carries no freight (${po.delivery_terms ?? '—'}). On hold until an approved deviation.`, expected: money(poFreight), actual: money(freight), tolerance: money(tol.freight_abs ?? 0), owner_role: 'BUY', owner_user_id: po.buyer_id, vendor_message: 'Freight on the invoice is not in the purchase order terms. That amount is on hold until Equipcare approves it.' });
    } else c5.push({ check: 'Freight', expected: poFreight ? `≤ ${money(poFreight)}` : 'None', actual: money(0), ok: true });
    const other = num(h.other_charges) ?? 0;
    if (other > 0) {
      c5.push({ check: 'Other charges', expected: 'Not in PO terms', actual: money(other), ok: false });
      findings.push({ rule: '3WM-05', key: '3WM-05:other', reason: 'Unapproved other charges', severity: 'medium', message: `Other charges ${money(other)} are not in the PO terms. On hold until an approved deviation.`, expected: money(0), actual: money(other), owner_role: 'BUY', owner_user_id: po.buyer_id, vendor_message: 'Other charges on the invoice are not in the purchase order terms and are on hold.' });
    }
    results.push({ rule: '3WM-05', label: RULE_LABELS['3WM-05'], status: c5.every((c) => c.ok) ? 'pass' : 'fail', summary: c5.every((c) => c.ok) ? 'Charges within PO terms' : 'Charges on hold', checks: c5 });

    // 3WM-06 Advance adjustment (information for finance; SAP clears the advance)
    const advs = advancesForPo(po);
    const list = advs.map((a) => ({ id: a.id, adv_no: a.adv_no, amount: a.amount, adjusted: a.adjusted_amount ?? 0, outstanding: ['Paid', 'Partially adjusted'].includes(a.status) ? round2(a.amount - (a.adjusted_amount ?? 0)) : 0, status: a.status, basis: a.po_id === po.id ? `PO ${po.po_no}` : 'Contract of this PO' }));
    const outstanding = round2(list.reduce((s, a) => s + a.outstanding, 0));
    const invTotal = total ?? computed;
    const proposed = round2(Math.min(outstanding, invTotal));
    advance = { advances: list, outstanding, proposed_adjustment: proposed, balance_payable: round2(invTotal - proposed) };
    results.push({ rule: '3WM-06', label: RULE_LABELS['3WM-06'], status: list.length ? 'info' : 'pass', summary: list.length ? `Unadjusted advance ${money(outstanding)} → adjust ${money(proposed)}, balance payable ${money(advance.balance_payable)}` : 'No advance on this PO', checks: list.map((a) => ({ check: `${a.adv_no} (${a.status})`, expected: `Paid ${money(a.amount)}`, actual: `Adjusted ${money(a.adjusted)}`, ok: true, note: `Outstanding ${money(a.outstanding)} · ${a.basis}` })) });
  }

  const match: MatchResult = {
    ran_at: ts(), trigger, tolerance: tol, tolerance_version: tolRow?.version ?? 1, tolerance_status: tolRow?.status ?? 'Active', hold_rule: holdRule,
    duplicate_scope: dupScope, results, advance, fds: fdsInfo,
  };
  return applyFindings(inv, findings, match, actor, waiting);
}

/** Merge findings into the exception register, decide the status, notify (NTF-28). */
function applyFindings(inv: InvoiceRow, findings: Finding[], match: MatchResult, actor: Actor | null, waiting: boolean) {
  const at = ts();
  const existing = all<ExceptionRow>('SELECT * FROM invoice_exceptions WHERE invoice_id = ? ORDER BY id', inv.id);
  const fresh: ExceptionRow[] = [];
  const seen = new Set<number>();
  const po = getPo(inv.po_id)!;
  for (const f of findings) {
    const prev = [...existing].reverse().find((e) => e.ex_key === f.key && e.status !== 'Rejected');
    if (prev?.status === 'Open') {
      seen.add(prev.id);
      update('invoice_exceptions', prev.id, { message: f.message, expected: f.expected ?? null, actual: f.actual ?? null, tolerance: f.tolerance ?? null, severity: f.severity, reason: f.reason, vendor_message: f.vendor_message, updated_at: at });
      continue;
    }
    // Approved / resolved by a person with the same actual value stays decided; anything new re-opens.
    if (prev && (prev.status === 'Approved' || (prev.status === 'Resolved' && prev.resolution !== AUTO_CLEARED)) && prev.actual === (f.actual ?? null)) { seen.add(prev.id); continue; }
    const id = insert('invoice_exceptions', {
      invoice_id: inv.id, rule: f.rule, severity: f.severity, message: f.message, expected: f.expected ?? null, actual: f.actual ?? null, tolerance: f.tolerance ?? null,
      owner_role: f.owner_role, owner_user_id: f.owner_user_id ?? null, status: 'Open', reason: f.reason, line_item: f.line_item ?? null, ex_key: f.key,
      vendor_message: f.vendor_message, auto_clear: f.auto_clear === false ? 0 : 1, created_at: at, updated_at: at,
    });
    seen.add(id);
    fresh.push(get<ExceptionRow>('SELECT * FROM invoice_exceptions WHERE id = ?', id)!);
  }
  for (const e of existing) {
    if (e.status !== 'Open' || seen.has(e.id)) continue;
    if (!e.auto_clear) continue; // FR-INV-09: bank mismatch is never cleared automatically
    update('invoice_exceptions', e.id, { status: 'Resolved', resolution: AUTO_CLEARED, resolved_by: actor?.id ?? null, resolved_at: at, updated_at: at });
  }
  const open = all<ExceptionRow>("SELECT * FROM invoice_exceptions WHERE invoice_id = ? AND status = 'Open'", inv.id)
    .sort((a, b) => RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule));
  const blocking = open.filter((e) => !(e.rule === '3WM-02' && e.reason.startsWith('Pending')));
  let status: string;
  let sub: string | null;
  if (open.some((e) => e.rule === 'DUP')) { status = 'Exception'; sub = 'Duplicate invoice'; }
  else if (blocking.length) { status = 'Exception'; sub = [...new Set(blocking.map((e) => e.reason))].join(' · '); }
  else if (open.length || waiting) { status = 'Validation pending'; sub = `Waiting for ${inv.is_service ? 'SES' : 'GRN'}`; }
  else { status = 'Matched'; sub = null; }
  const disputeHold = open.some((e) => e.rule === 'DISPUTE_HOLD') ? 1 : 0;
  const changes: Record<string, unknown> = { status, sub_reason: sub, match_json: J(match), dispute_hold: disputeHold, updated_at: at };
  let approvalCleared = false;
  if (status !== 'Matched' && inv.approved_at) { changes.approved_by = null; changes.approved_at = null; approvalCleared = true; }
  update('invoices', inv.id, changes);
  if (status !== inv.status || sub !== inv.sub_reason) {
    const vNote = status === 'Matched' ? 'Validated against PO and receipt; waiting for accounts approval'
      : status === 'Validation pending' ? 'Waiting for the goods / service receipt at the plant'
      : sub === 'Duplicate invoice' ? 'Not processed — duplicate invoice number' : 'Needs attention — see the reasons below';
    event(inv.id, status === 'Matched' ? 'Matched — waiting for finance approval' : status === 'Exception' ? `Exception: ${sub}` : `Validation pending — ${sub}`, { status, note: `Validation (${match.trigger})`, vendorNote: vNote, userId: actor?.id ?? null });
    audit(actor, { action: 'invoice.validated', objectType: 'invoice', objectId: inv.id, objectRef: inv.inv_ref, before: { status: inv.status, sub_reason: inv.sub_reason }, after: { status, sub_reason: sub, open_exceptions: open.length, trigger: match.trigger } });
  }
  if (approvalCleared) event(inv.id, 'Finance approval withdrawn — validation found new exceptions', { vendorVisible: false });
  if (fresh.length) notifyExceptions(inv, fresh, po);
  return getInvoice(inv.id)!;
}

function ownerLink(role: string, invId: number, poId: number) {
  return role === 'STO' ? `/pos/${poId}` : `/invoices/${invId}`;
}

function notifyExceptions(inv: InvoiceRow, fresh: ExceptionRow[], po: PoRow) {
  const groups = new Map<string, ExceptionRow[]>();
  for (const e of fresh) {
    const k = e.owner_user_id ? `u${e.owner_user_id}` : `r${e.owner_role}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  for (const [k, list] of groups) {
    const role = list[0].owner_role as Role;
    notify({
      event: 'NTF-28', title: `Invoice exception: ${inv.inv_ref} — ${[...new Set(list.map((e) => e.reason))].join(', ')}`,
      body: `${vendorName(inv.vendor_id)} · PO ${po.po_no} · ${list[0].message}`.slice(0, 300), link: ownerLink(role, inv.id, po.id),
      ...(k.startsWith('u') ? { users: [list[0].owner_user_id] } : { roles: [role], plant: po.plant }),
      objectType: 'invoice', objectId: inv.id, severity: list.some((e) => e.severity === 'high') ? 'danger' : 'warning', mandatory: true,
      dedupeKey: `NTF-28:${inv.id}:${list.map((e) => e.id).join(',')}`,
    });
    // Tax exceptions go to finance "with procurement" (WF-10).
    if (list.some((e) => e.rule === '3WM-04') && po.buyer_id) notify({ event: 'NTF-28', title: `Tax mismatch on ${inv.inv_ref} (for information)`, body: list.find((e) => e.rule === '3WM-04')!.message, link: `/invoices/${inv.id}`, users: [po.buyer_id], objectType: 'invoice', objectId: inv.id, dedupeKey: `NTF-28t:${inv.id}:${list[0].id}` });
  }
  const vendorMsgs = [...new Set(fresh.map((e) => e.vendor_message))];
  notify({ event: 'NTF-28', title: `Invoice ${inv.vendor_invoice_no ?? inv.inv_ref} needs attention`, body: vendorMsgs.join(' ').slice(0, 400), link: `/vendor/invoices/${inv.id}`, vendorId: inv.vendor_id, objectType: 'invoice', objectId: inv.id, severity: 'warning', mandatory: true, dedupeKey: `NTF-28v:${inv.id}:${fresh.map((e) => e.id).join(',')}` });
}

/** Re-run validation for open invoices of a PO (GRN sync, PO change, dispute closure, advances). */
export function revalidatePo(poId: number, trigger: string) {
  let n = 0;
  for (const i of all<{ id: number }>(`SELECT id FROM invoices WHERE po_id = ? AND status IN (${EDITABLE.map(() => '?').join(',')})`, poId, ...EDITABLE)) {
    validate(i.id, null, trigger);
    n++;
  }
  return n;
}
/** For the dispute module: call when a dispute on this PO is resolved or closed (FR-DSP-05). */
export const releaseDisputeHolds = (poId: number) => revalidatePo(poId, 'dispute change');

// ------------------------------------------------------------------ finance actions
function requireReview(actor: Actor) {
  if (!actor.perms.has('inv.review')) throw forbidden('Only finance can do this (OCR correction and exception resolution).');
}
function assertEditable(inv: InvoiceRow) {
  if (LOCKED.includes(inv.status)) throw new HttpError(409, 'locked', `Invoice ${inv.inv_ref} is ${inv.status.toLowerCase()} in SAP. Original, extracted, corrected and final records are kept and can no longer be changed (AC-INV-11).`);
  if (inv.status === 'Rejected') throw conflict(`Invoice ${inv.inv_ref} was rejected to the vendor and cannot be changed.`);
  if (inv.parking) throw conflict(`Invoice ${inv.inv_ref} has been released for parking. It can no longer be corrected here.`);
}

function getPath(v: Values, path: string): Val {
  const p = path.split('.');
  if (p[0] === 'lines') return v.lines[Number(p[1])]?.[p[2]] ?? null;
  return v.header[p[0]] ?? null;
}
function setPath(v: Values, path: string, value: Val) {
  const p = path.split('.');
  if (p[0] === 'lines') {
    const l = v.lines[Number(p[1])];
    if (!l) throw badRequest(`Line ${Number(p[1]) + 1} does not exist.`);
    l[p[2]] = value;
  } else v.header[p[0]] = value;
}

/** FR-INV-06, AC-INV-05: correction with old, new, user, time, reason; validation runs again. */
export function correctField(actor: Actor, invId: number, path: string, raw: unknown, reason: string) {
  requireReview(actor);
  const inv = mustInvoice(invId);
  assertEditable(inv);
  const def = fieldDef(path);
  if (!def) throw badRequest(`Unknown field ${path}.`, { field: 'Choose a field' });
  const v = inv.values!;
  const old = getPath(v, path);
  const value = normalizeValue(def, raw);
  if (def.mandatory && value === null) throw badRequest(`${def.label} cannot be empty.`, { value: 'Enter a value' });
  if ((def.kind === 'money' || def.kind === 'number' || def.kind === 'pct') && raw !== '' && raw != null && value === null) throw badRequest(`${def.label} must be a number.`, { value: 'Enter a number' });
  if (def.kind === 'date' && value && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw badRequest('Enter the date as YYYY-MM-DD.', { value: 'YYYY-MM-DD' });
  if (String(old ?? '') === String(value ?? '')) throw badRequest('The new value is the same as the current value. Use "Confirm as read" if the value is right.', { value: 'Unchanged' });
  return tx(() => {
    setPath(v, path, value);
    update('invoices', inv.id, { values_json: J(v) });
    syncHeaderColumns(inv.id, v);
    insert('invoice_corrections', { invoice_id: inv.id, field: path, old_value: old == null ? null : String(old), new_value: value == null ? null : String(value), reason, user_id: actor.id, created_at: ts() });
    audit(actor, { action: 'invoice.field_corrected', objectType: 'invoice', objectId: inv.id, objectRef: inv.inv_ref, before: { [path]: old }, after: { [path]: value }, reason });
    event(inv.id, `Corrected ${labelOf(path)}`, { note: `${old ?? 'not found'} → ${value ?? 'empty'} · ${reason}`, vendorVisible: false, userId: actor.id });
    return validate(inv.id, actor, 'correction');
  });
}

/** Finance confirms a low-confidence value is read correctly (no change; not counted as a correction). */
export function verifyField(actor: Actor, invId: number, path: string) {
  requireReview(actor);
  const inv = mustInvoice(invId);
  assertEditable(inv);
  if (!fieldDef(path)) throw badRequest(`Unknown field ${path}.`);
  const v = inv.values!;
  if (!v.verified.includes(path)) v.verified.push(path);
  update('invoices', inv.id, { values_json: J(v) });
  audit(actor, { action: 'invoice.field_verified', objectType: 'invoice', objectId: inv.id, objectRef: inv.inv_ref, after: { field: path, value: getPath(v, path) } });
  event(inv.id, `Confirmed ${labelOf(path)} as read`, { vendorVisible: false, userId: actor.id });
  return validate(inv.id, actor, 'verification');
}

export function labelOf(path: string) {
  const p = path.split('.');
  const d = fieldDef(path);
  return p[0] === 'lines' ? `line ${Number(p[1]) + 1} ${d?.label.toLowerCase() ?? p[2]}` : d?.label.toLowerCase() ?? path;
}

function mustException(id: number) {
  const e = get<ExceptionRow>('SELECT * FROM invoice_exceptions WHERE id = ?', id);
  if (!e) throw notFound('Exception');
  return e;
}

/** WF-10 resolution: approve within authority (reason required). Duplicates cannot be approved. */
export function approveException(actor: Actor, exId: number, reason: string) {
  requireReview(actor);
  const e = mustException(exId);
  const inv = mustInvoice(e.invoice_id);
  assertEditable(inv);
  if (e.status !== 'Open') throw conflict(`This exception is already ${e.status.toLowerCase()}.`);
  if (e.rule === 'DUP') throw conflict('A duplicate invoice cannot be approved. Reject it to the vendor, or correct the invoice number if it was read wrongly.');
  if (e.rule === 'FIELD_MISSING') throw conflict('A missing mandatory field cannot be approved. Correct the field from the document.');
  if (e.rule === '3WM-02' && e.reason.startsWith('Pending')) throw conflict('Pending receipt cannot be approved — the invoice re-matches automatically when SAP posts the GRN/SES.');
  return tx(() => {
    update('invoice_exceptions', e.id, { status: 'Approved', resolution: `Approved: ${reason}`, resolved_by: actor.id, resolved_at: ts(), updated_at: ts() });
    audit(actor, { action: 'invoice.exception_approved', objectType: 'invoice', objectId: inv.id, objectRef: inv.inv_ref, before: { exception: e.id, status: 'Open' }, after: { rule: e.rule, reason: e.reason, status: 'Approved', expected: e.expected, actual: e.actual }, reason });
    event(inv.id, `Exception approved: ${e.reason}`, { note: reason, vendorVisible: false, userId: actor.id });
    return validate(inv.id, actor, 'exception approved');
  });
}

/** WF-10 resolution: credit note / corrected in SAP / other, with reference and reason. */
export function resolveException(actor: Actor, exId: number, resolution: string, reference: string | null, reason: string) {
  requireReview(actor);
  const e = mustException(exId);
  const inv = mustInvoice(e.invoice_id);
  assertEditable(inv);
  if (e.status !== 'Open') throw conflict(`This exception is already ${e.status.toLowerCase()}.`);
  if (e.rule === 'DUP' || e.rule === 'FIELD_MISSING') throw conflict('This exception cannot be resolved this way. Reject the invoice or correct the field.');
  return tx(() => {
    update('invoice_exceptions', e.id, { status: 'Resolved', resolution: `${resolution}${reference ? ` ${reference}` : ''}: ${reason}`, resolved_by: actor.id, resolved_at: ts(), updated_at: ts() });
    audit(actor, { action: 'invoice.exception_resolved', objectType: 'invoice', objectId: inv.id, objectRef: inv.inv_ref, after: { exception: e.id, rule: e.rule, resolution, reference }, reason });
    event(inv.id, `Exception resolved: ${e.reason} — ${resolution}`, { note: reason, vendorNote: resolution === 'Credit note received' ? `Credit note${reference ? ` ${reference}` : ''} recorded` : null, vendorVisible: resolution === 'Credit note received', userId: actor.id });
    return validate(inv.id, actor, 'exception resolved');
  });
}

export function assignException(actor: Actor, exId: number, userId: number, note?: string) {
  requireReview(actor);
  const e = mustException(exId);
  if (e.status !== 'Open') throw conflict(`This exception is already ${e.status.toLowerCase()}.`);
  const u = get<{ id: number; name: string; roles: string; active: number; vendor_id: number | null }>('SELECT id, name, roles, active, vendor_id FROM users WHERE id = ?', userId);
  if (!u || !u.active || u.vendor_id) throw badRequest('Choose an active internal user.', { user_id: 'Choose a user' });
  const role = (['FIN', 'BUY', 'STO', 'APR'] as const).find((r) => u.roles.split(',').includes(r));
  if (!role) throw badRequest(`${u.name} is not in finance, procurement or stores.`, { user_id: 'Choose another user' });
  const inv = mustInvoice(e.invoice_id);
  update('invoice_exceptions', e.id, { owner_user_id: u.id, owner_role: role, assigned_at: ts(), updated_at: ts() });
  audit(actor, { action: 'invoice.exception_assigned', objectType: 'invoice', objectId: inv.id, objectRef: inv.inv_ref, before: { owner_user_id: e.owner_user_id, owner_role: e.owner_role }, after: { owner_user_id: u.id, owner_role: role }, reason: note ?? null });
  event(inv.id, `Exception "${e.reason}" assigned to ${u.name}`, { note: note ?? null, vendorVisible: false, userId: actor.id });
  notify({ event: 'NTF-28', title: `Invoice exception assigned to you: ${inv.inv_ref}`, body: `${e.reason} — ${e.message}`.slice(0, 300), link: ownerLink(role, inv.id, inv.po_id), users: [u.id], objectType: 'invoice', objectId: inv.id, severity: 'warning', mandatory: true, dedupeKey: `NTF-28a:${e.id}:${u.id}` });
  return mustException(e.id);
}

/** WF-10: reject to vendor with a vendor-safe reason. */
export function rejectInvoice(actor: Actor, invId: number, vendorReason: string, internalNote?: string | null) {
  requireReview(actor);
  const inv = mustInvoice(invId);
  assertEditable(inv);
  return tx(() => {
    run("UPDATE invoice_exceptions SET status = 'Rejected', resolution = 'Invoice rejected to vendor', resolved_by = ?, resolved_at = ?, updated_at = ? WHERE invoice_id = ? AND status = 'Open'", actor.id, ts(), ts(), inv.id);
    update('invoices', inv.id, { status: 'Rejected', sub_reason: null, rejected_reason: vendorReason, block_reason_internal: internalNote ?? null, approved_by: null, approved_at: null, dispute_hold: 0, updated_at: ts() });
    audit(actor, { action: 'invoice.rejected', objectType: 'invoice', objectId: inv.id, objectRef: inv.inv_ref, before: { status: inv.status }, after: { status: 'Rejected', vendor_reason: vendorReason }, reason: internalNote || vendorReason });
    event(inv.id, 'Rejected to vendor', { status: 'Rejected', note: internalNote ?? null, vendorNote: `Returned to you: ${vendorReason}`, userId: actor.id });
    notify({ event: 'NTF-28', title: `Invoice ${inv.vendor_invoice_no ?? inv.inv_ref} returned by Equipcare`, body: vendorReason, link: `/vendor/invoices/${inv.id}`, vendorId: inv.vendor_id, objectType: 'invoice', objectId: inv.id, severity: 'danger', mandatory: true, dedupeKey: `NTF-28r:${inv.id}` });
    return getInvoice(inv.id)!;
  });
}

/** FR-INV-19, AC-INV-10: finance approval — only for Matched invoices (exceptions approved or none). */
export function approveInvoice(actor: Actor, invId: number, note?: string | null) {
  requireReview(actor);
  const inv = mustInvoice(invId);
  assertEditable(inv);
  if (inv.status !== 'Matched') throw new HttpError(409, 'not_matched', `Invoice ${inv.inv_ref} is ${inv.status.toLowerCase()}${inv.sub_reason ? ` (${inv.sub_reason})` : ''}. Resolve or approve its exceptions until it is Matched, then approve it.`);
  if (inv.approved_at) throw conflict(`Invoice ${inv.inv_ref} is already approved by finance.`);
  if (inv.uploaded_by === actor.id) throw forbidden('You uploaded this invoice, so another finance user must approve it (segregation of duties).');
  return tx(() => {
    const exceptions = all<ExceptionRow>('SELECT id, rule, reason, status, resolution, resolved_by, resolved_at, expected, actual FROM invoice_exceptions WHERE invoice_id = ? ORDER BY id', inv.id);
    const final = { approved_by: actor.id, approved_by_name: actor.name, approved_at: ts(), note: note ?? null, values: inv.values, match: inv.match, exceptions };
    update('invoices', inv.id, { approved_by: actor.id, approved_at: ts(), approval_note: note ?? null, final_json: J(final), updated_at: ts() });
    audit(actor, { action: 'invoice.finance_approved', objectType: 'invoice', objectId: inv.id, objectRef: inv.inv_ref, after: { status: 'Matched', approved: true, total: inv.total_value, exceptions_approved: exceptions.filter((e) => e.status === 'Approved').length }, reason: note ?? null });
    event(inv.id, 'Approved by finance', { note: note ?? null, vendorNote: 'Approved by Equipcare accounts', userId: actor.id });
    return getInvoice(inv.id)!;
  });
}

/** After approval: write the parking request to SAP when DEC-06 allows, otherwise hand over for manual entry. */
export function requestParking(actor: Actor, invId: number) {
  requireReview(actor);
  const inv = mustInvoice(invId);
  if (inv.status !== 'Matched' || !inv.approved_at || !inv.approved_by) {
    throw new HttpError(409, 'finance_approval_required', `Invoice ${inv.inv_ref} cannot be sent for parking: it must be Matched (or have its exceptions approved) and approved by finance first (FR-INV-19).`);
  }
  if (inv.parking?.mode === 'sap' && ['Written', 'Duplicate'].includes(inv.parking.status ?? '')) throw conflict(`Invoice ${inv.inv_ref} was already written to SAP for parking.`);
  const writeEnabled = cfg<boolean>('sap.write.invoice_parking');
  if (!writeEnabled) {
    const parking = { mode: 'manual' as const, message: 'Enter this invoice in SAP manually (DEC-06: parking write-back is off). Its SAP status arrives through the INT-M12 sync.', at: ts(), by: actor.id };
    update('invoices', inv.id, { parking_json: J(parking), updated_at: ts() });
    audit(actor, { action: 'invoice.released_for_manual_sap_entry', objectType: 'invoice', objectId: inv.id, objectRef: inv.inv_ref, after: { mode: 'manual', decision: 'DEC-06' } });
    event(inv.id, 'Released for manual entry in SAP (DEC-06)', { note: parking.message, vendorNote: 'Sent to accounts for posting', userId: actor.id });
    return { invoice: getInvoice(inv.id)!, result: { status: 'Manual', message: parking.message } };
  }
  const v = inv.values!;
  const payload = {
    inv_ref: inv.inv_ref, vendor_invoice_no: inv.vendor_invoice_no, invoice_date: inv.invoice_date, po_no: getPo(inv.po_id)!.po_no,
    vendor_sap_code: get<{ sap_code: string }>('SELECT sap_code FROM vendors WHERE id = ?', inv.vendor_id)?.sap_code, taxable_value: inv.taxable_value,
    gst_amount: inv.gst_amount, freight: inv.freight, total_value: inv.total_value, lines: v.lines, approved_by: inv.approved_by, approved_at: inv.approved_at,
  };
  const r = sapWrite('INT-M11', 'PARK', `PARK:${inv.inv_ref}`, payload, actor);
  const parking = { mode: 'sap' as const, status: r.status, message: r.message, at: ts(), by: actor.id };
  update('invoices', inv.id, { parking_json: J(parking), updated_at: ts() });
  audit(actor, { action: 'invoice.parking_requested', objectType: 'invoice', objectId: inv.id, objectRef: inv.inv_ref, after: { flow: 'INT-M11', status: r.status, message: r.message } });
  event(inv.id, `Parking request to SAP: ${r.status}`, { note: r.message, vendorNote: r.status === 'Written' ? 'Sent to SAP for posting' : null, vendorVisible: r.status === 'Written', userId: actor.id });
  return { invoice: getInvoice(inv.id)!, result: r };
}

// ------------------------------------------------------------------ SAP status (INT-M12) and receipts
export const STATUS_TITLES: Record<string, { title: string; vendor: string }> = {
  Parked: { title: 'Parked in SAP', vendor: 'Recorded in Equipcare’s accounts' },
  Posted: { title: 'Posted in SAP', vendor: 'Posted in Equipcare’s accounts' },
  'Payment due': { title: 'Payment due', vendor: 'Payment scheduled' },
  'Payment released': { title: 'Payment released', vendor: 'Payment released — payment advice available' },
  'Payment blocked': { title: 'Payment blocked in SAP', vendor: 'Payment on hold — contact Equipcare accounts' },
};

export function onInvoiceStatus(rows: { id: number; isNew: boolean; payload: any }[]) {
  for (const r of rows) {
    if (!r.isNew) continue;
    const inv = getInvoice(r.id);
    if (!inv) continue;
    const t = STATUS_TITLES[inv.status] ?? { title: `SAP status: ${inv.status}`, vendor: inv.status };
    const vendorNote = inv.status === 'Payment blocked' ? (inv.vendor_reason ? `Payment on hold: ${inv.vendor_reason}` : t.vendor) : t.vendor;
    event(inv.id, t.title, { status: inv.status, note: `INT-M12 sync${inv.sap_doc_no ? ` · SAP document ${inv.sap_doc_no}` : ''}${inv.status === 'Payment blocked' && inv.block_reason_internal ? ` · ${inv.block_reason_internal}` : ''}`, vendorNote });
    audit(null, { action: 'invoice.sap_status_synced', objectType: 'invoice', objectId: inv.id, objectRef: inv.inv_ref, after: { status: inv.status, sap_doc_no: inv.sap_doc_no, flow: 'INT-M12' } });
    if (inv.status === 'Posted' && !inv.final) {
      update('invoices', inv.id, { final_json: J({ snapshot_at: ts(), values: inv.values, match: inv.match, note: 'Snapshot at SAP posting' }) });
    }
    if (inv.status === 'Payment released') {
      notify({ event: 'NTF-30', title: `Payment released: invoice ${inv.vendor_invoice_no ?? inv.inv_ref}`, body: `${inv.payment_ref ? `Payment ref ${inv.payment_ref}. ` : ''}The payment advice is ready to download.`, link: `/vendor/payments?invoice=${inv.id}`, vendorId: inv.vendor_id, objectType: 'invoice', objectId: inv.id, severity: 'success', dedupeKey: `NTF-30:${inv.id}` });
    }
    if (inv.status === 'Payment blocked') {
      notify({ event: 'NTF-28', title: `Payment blocked in SAP: ${inv.inv_ref}`, body: inv.block_reason_internal ?? 'Blocked in SAP', link: `/invoices/${inv.id}`, roles: ['FIN'], objectType: 'invoice', objectId: inv.id, severity: 'danger', dedupeKey: `NTF-28b:${inv.id}:${inv.updated_at}` });
    }
  }
}

export function onGrnSynced(rows: { id: number }[]) {
  const poIds = new Set<number>();
  for (const r of rows) {
    const p = get<{ po_id: number }>('SELECT po_id FROM po_lines WHERE id = ?', r.id);
    if (p) poIds.add(p.po_id);
  }
  for (const id of poIds) revalidatePo(id, 'GRN/SES sync');
}

// ------------------------------------------------------------------ ageing job (NTF-29)
export function exceptionAgeingJob() {
  const days = cfg<number>('inv.exception_ageing_days');
  const open = all<ExceptionRow & { inv_ref: string; po_id: number; plant: string }>(
    "SELECT e.*, i.inv_ref, i.po_id, p.plant FROM invoice_exceptions e JOIN invoices i ON i.id = e.invoice_id JOIN pos p ON p.id = i.po_id WHERE e.status = 'Open'",
  );
  let n = 0;
  for (const e of open) {
    const age = daysBetween(e.created_at);
    if (age < days) continue;
    const level = age >= days * 2 ? 2 : 1;
    n += notify({
      event: 'NTF-29', title: `Invoice exception ${age} days old: ${e.inv_ref}`, body: `${e.reason} — ${e.message}`.slice(0, 300), link: ownerLink(e.owner_role, e.invoice_id, e.po_id),
      ...(e.owner_user_id ? { users: [e.owner_user_id] } : { roles: [e.owner_role as Role], plant: e.plant }), objectType: 'invoice', objectId: e.invoice_id, severity: 'warning', dedupeKey: `NTF-29:${e.id}:${level}`,
    }).length;
    if (level === 2) n += notify({ event: 'NTF-29', title: `Escalation: invoice exception ${age} days old — ${e.inv_ref}`, body: `${e.reason}; owner ${e.owner_role}`, link: `/invoices/exceptions`, roles: e.owner_role === 'FIN' ? ['FIN'] : ['FIN', 'APR'], objectType: 'invoice', objectId: e.invoice_id, severity: 'danger', dedupeKey: `NTF-29e:${e.id}` }).length;
  }
  // Disputes may have closed since the hold was set: re-check held invoices.
  let released = 0;
  for (const i of all<{ id: number }>("SELECT id FROM invoices WHERE dispute_hold = 1 AND status = 'Exception'")) {
    if (validate(i.id, null, 'hold re-check').dispute_hold === 0) released++;
  }
  return `${open.length} open exceptions, ${n} notifications, ${released} dispute hold(s) released`;
}

// ------------------------------------------------------------------ queries
function scopePlants(actor: Actor) {
  return actor.plants === '*' ? '' : `AND p.plant IN (${actor.plants.map((x) => `'${x.replace(/'/g, '')}'`).join(',')})`;
}

const TERMINAL = ['Payment released', 'Rejected'];
export function tabOf(i: { status: string; approved_at: string | null; parking?: unknown }) {
  if (i.status === 'Matched') return i.approved_at ? 'approved' : 'matched';
  return ({ Uploaded: 'pending', 'OCR pending': 'pending', 'Validation pending': 'pending', Exception: 'exception', Parked: 'parked', Posted: 'posted', 'Payment due': 'posted', 'Payment released': 'paid', 'Payment blocked': 'blocked', Rejected: 'rejected' } as Record<string, string>)[i.status] ?? 'pending';
}

export function listInvoices(actor: Actor) {
  const rows = all<InvoiceRow & { vendor_name: string; vendor_code: string | null; po_no: string; plant: string; buyer_id: number | null; uploaded_by_name: string | null; approved_by_name: string | null; dup_ref: string | null }>(
    `SELECT i.*, v.name AS vendor_name, v.sap_code AS vendor_code, p.po_no, p.plant, p.buyer_id, u.name AS uploaded_by_name, a.name AS approved_by_name, d.inv_ref AS dup_ref
     FROM invoices i JOIN vendors v ON v.id = i.vendor_id JOIN pos p ON p.id = i.po_id LEFT JOIN users u ON u.id = i.uploaded_by
     LEFT JOIN users a ON a.id = i.approved_by LEFT JOIN invoices d ON d.id = i.duplicate_of WHERE 1 = 1 ${scopePlants(actor)} ORDER BY i.id DESC`,
  );
  const exc = all<{ invoice_id: number; reason: string; owner_role: string; owner_name: string | null }>(
    "SELECT e.invoice_id, e.reason, e.owner_role, u.name AS owner_name FROM invoice_exceptions e LEFT JOIN users u ON u.id = e.owner_user_id WHERE e.status = 'Open'",
  );
  return rows.map((r) => {
    const open = exc.filter((e) => e.invoice_id === r.id);
    const { extracted: _x, values: _v, match, final: _f, ...rest } = r;
    return {
      ...rest, tab: tabOf(r), open_exceptions: open.length, owners: [...new Set(open.map((e) => e.owner_name ?? e.owner_role))].join(', ') || null,
      age_days: daysBetween(r.created_at, TERMINAL.includes(r.status) ? r.updated_at ?? r.created_at : new Date()),
      balance_payable: match?.advance?.balance_payable ?? r.total_value, advance_outstanding: match?.advance?.outstanding ?? 0,
    };
  });
}

export function listExceptions(actor: Actor, status = 'Open') {
  const rows = all<ExceptionRow & { inv_ref: string; vendor_invoice_no: string | null; vendor_name: string; po_no: string; po_id: number; plant: string; total_value: number | null; inv_status: string; owner_name: string | null; resolved_by_name: string | null }>(
    `SELECT e.*, i.inv_ref, i.vendor_invoice_no, v.name AS vendor_name, p.po_no, p.id AS po_id, p.plant, i.total_value, i.status AS inv_status, u.name AS owner_name, r.name AS resolved_by_name
     FROM invoice_exceptions e JOIN invoices i ON i.id = e.invoice_id JOIN vendors v ON v.id = i.vendor_id JOIN pos p ON p.id = i.po_id
     LEFT JOIN users u ON u.id = e.owner_user_id LEFT JOIN users r ON r.id = e.resolved_by
     WHERE ${status === 'all' ? '1 = 1' : 'e.status = ?'} ${scopePlants(actor)} ORDER BY e.created_at`,
    ...(status === 'all' ? [] : [status]),
  );
  return rows.map((e) => {
    const age = daysBetween(e.created_at, e.resolved_at ?? new Date());
    return { ...e, age_days: age, age_bucket: age <= 2 ? '0–2 days' : age <= 7 ? '3–7 days' : age <= 15 ? '8–15 days' : '> 15 days', owner: e.owner_name ?? `${e.owner_role} team`, rule_label: RULE_LABELS[e.rule] ?? e.rule };
  });
}

export function assignees() {
  return all<{ id: number; name: string; roles: string; title: string | null }>(
    "SELECT id, name, roles, title FROM users WHERE active = 1 AND vendor_id IS NULL AND ((',' || roles || ',') LIKE '%,FIN,%' OR (',' || roles || ',') LIKE '%,BUY,%' OR (',' || roles || ',') LIKE '%,STO,%') ORDER BY name",
  );
}

function corrections(invId: number) {
  return all<{ id: number; field: string; old_value: string | null; new_value: string | null; reason: string; user_id: number; user_name: string; created_at: string }>(
    'SELECT c.*, u.name AS user_name FROM invoice_corrections c LEFT JOIN users u ON u.id = c.user_id WHERE c.invoice_id = ? ORDER BY c.id', invId,
  ).map((c) => ({ ...c, label: labelOf(c.field) }));
}

function poContext(po: PoRow, inv?: InvoiceRow) {
  return poLinesOf(po.id).map((l) => {
    const rec = received(l.id);
    const grns = all<{ grn_no: string; qty: number; value: number | null; posting_date: string; is_service: number }>('SELECT grn_no, qty, value, posting_date, is_service FROM grns WHERE po_line_id = ? ORDER BY posting_date', l.id);
    const billed = inv ? billedElsewhere(inv, l.item).qty : all<{ values: Values | null }>("SELECT values_json FROM invoices WHERE po_id = ? AND status != 'Rejected' AND duplicate_of IS NULL", po.id).reduce((s, o) => s + (o.values?.lines ?? []).filter((x) => Number(x.po_item) === l.item).reduce((t, x) => t + Number(x.qty ?? 0), 0), 0);
    return { ...l, received_qty: rec.qty, received_value: rec.value, grns, billed_elsewhere: billed, billable: round2(rec.qty - billed) };
  });
}

/** SCR-INV-03 data for internal users. */
export function invoiceDetail(actor: Actor, id: number) {
  let inv = mustInvoice(id);
  // A held invoice re-checks the dispute on open, so a closed dispute releases the hold straight away (FR-DSP-05).
  if (inv.dispute_hold && EDITABLE.includes(inv.status) && !inv.parking) inv = validate(id, null, 'dispute re-check on open');
  const po = getPo(inv.po_id)!;
  if (!plantAllowed(actor, po.plant)) throw notFound('Invoice');
  const vendor = get('SELECT id, name, sap_code, gstin, pan, bank_name, bank_account_masked, bank_ifsc, synced_at FROM vendors WHERE id = ?', inv.vendor_id);
  const plant = get('SELECT code, name, gstin FROM plants WHERE code = ?', po.plant);
  const buyer = po.buyer_id ? get<{ name: string }>('SELECT name FROM users WHERE id = ?', po.buyer_id)?.name : null;
  const att = inv.attachment_id ? getAttachment(inv.attachment_id) : undefined;
  const exceptions = all<ExceptionRow & { owner_name: string | null; resolved_by_name: string | null }>(
    'SELECT e.*, u.name AS owner_name, r.name AS resolved_by_name FROM invoice_exceptions e LEFT JOIN users u ON u.id = e.owner_user_id LEFT JOIN users r ON r.id = e.resolved_by WHERE e.invoice_id = ? ORDER BY e.id', id,
  ).map((e) => ({ ...e, age_days: daysBetween(e.created_at, e.resolved_at ?? new Date()), rule_label: RULE_LABELS[e.rule] ?? e.rule }));
  const events = all('SELECT ev.*, u.name AS user_name FROM invoice_events ev LEFT JOIN users u ON u.id = ev.user_id WHERE invoice_id = ? ORDER BY ev.created_at, ev.id', id);
  const corr = corrections(id);
  const disputes = all('SELECT d.id, d.dsp_no, d.type, d.status, d.qty, d.owner_party, d.created_at, l.item FROM disputes d LEFT JOIN po_lines l ON l.id = d.po_line_id WHERE d.po_id = ? ORDER BY d.id', po.id);
  const asn = inv.asn_id ? get('SELECT id, asn_no, status, dispatch_date, eway_bill FROM asns WHERE id = ?', inv.asn_id) : null;
  const dup = inv.duplicate_of ? get('SELECT id, inv_ref, vendor_invoice_no, status FROM invoices WHERE id = ?', inv.duplicate_of) : null;
  const contract = po.contract_id ? get('SELECT id, contract_no, type, sap_oa_no, invoice_validation, discount_pct FROM contracts WHERE id = ?', po.contract_id) : null;
  const users = get<{ up: string | null; ap: string | null }>('SELECT (SELECT name FROM users WHERE id = ?) AS up, (SELECT name FROM users WHERE id = ?) AS ap', inv.uploaded_by, inv.approved_by)!;
  const acc = accuracy(inv.extracted, new Set(corr.map((c) => c.field)));
  const review = actor.perms.has('inv.review');
  const editable = EDITABLE.includes(inv.status) && !inv.parking;
  const lastInvSync = get<{ last_success: string | null }>("SELECT last_success FROM sync_state WHERE flow = 'INT-M12:INVSTATUS'")?.last_success ?? null;
  const thresholds = cfg<Record<string, number>>('ocr.confidence');
  return {
    ...inv, vendor, plant, buyer_name: buyer, uploaded_by_name: users.up, approved_by_name: users.ap, asn, duplicate: dup, contract,
    po: { id: po.id, po_no: po.po_no, po_date: po.po_date, plant: po.plant, payment_terms: po.payment_terms, delivery_terms: po.delivery_terms, freight_terms: po.freight_terms, total_value: po.total_value, status: po.status, synced_at: po.synced_at, lines: poContext(po, inv) },
    attachment: att ? { id: att.id, filename: att.filename, mime: att.mime, size: att.size } : null,
    exceptions, events, corrections: corr, disputes, accuracy: acc, thresholds, header_fields: HEADER_FIELDS, line_fields: LINE_FIELDS, ocr_note: OCR_NOTE,
    config: {
      parking_write: cfg<boolean>('sap.write.invoice_parking'), hold_rule: cfg<string>('dispute.hold_rule'), tolerance: cfg('tolerance.3wm'),
      tolerance_pending: !!get("SELECT id FROM config_history WHERE key = 'tolerance.3wm' AND status = 'Pending'"),
    },
    freshness: { 'INT-M12': { last_success: lastInvSync, ...staleInfo('INT-M12', lastInvSync) } },
    can: {
      correct: review && editable, resolve: review && editable, approve: review && inv.status === 'Matched' && !inv.approved_at && inv.uploaded_by !== actor.id,
      approve_blocked_reason: inv.uploaded_by === actor.id ? 'You uploaded this invoice; another finance user must approve it.' : null,
      park: review && inv.status === 'Matched' && !!inv.approved_at && !(inv.parking?.mode === 'sap' && ['Written', 'Duplicate'].includes(inv.parking.status ?? '')),
      reject: review && editable, sim: (actor.perms.has('sapsim.fin') || actor.perms.has('sapsim.all')) && !!inv.approved_at && !!inv.parking,
      dispute: actor.perms.has('dsp.raise'), comment: actor.perms.has('inv.comment') || review,
    },
  };
}

// ------------------------------------------------------------------ vendor views (vendor-safe only, GOV-C08)
export function vendorInvoices(actor: Actor) {
  const rows = all<{ id: number; inv_ref: string; vendor_invoice_no: string | null; invoice_date: string | null; po_no: string; po_id: number; total_value: number | null; status: string; on_behalf: number; created_at: string; updated_at: string | null; rejected_reason: string | null; paid_at: string | null }>(
    `SELECT i.id, i.inv_ref, i.vendor_invoice_no, i.invoice_date, p.po_no, p.id AS po_id, i.total_value, i.status, i.on_behalf, i.created_at, i.updated_at, i.rejected_reason, i.paid_at
     FROM invoices i JOIN pos p ON p.id = i.po_id WHERE i.vendor_id = ? ORDER BY i.id DESC`, actor.vendorId ?? -1,
  );
  const msgs = all<{ invoice_id: number; vendor_message: string }>("SELECT e.invoice_id, e.vendor_message FROM invoice_exceptions e JOIN invoices i ON i.id = e.invoice_id WHERE i.vendor_id = ? AND e.status = 'Open'", actor.vendorId ?? -1);
  return rows.map((r) => ({ ...r, vendor_status: vendorStatus(r.status), action_needed: r.status === 'Exception' || r.status === 'Rejected', reasons: [...new Set(msgs.filter((m) => m.invoice_id === r.id).map((m) => m.vendor_message))] }));
}

/** Status shown to vendors: same vocabulary, with sub-reasons kept internal. */
export const vendorStatus = (s: string) => (s === 'Exception' ? 'Exception' : s);

export function vendorInvoiceDetail(actor: Actor, id: number) {
  const inv = getInvoice(id);
  if (!inv) throw notFound('Invoice');
  assertVendorScope(actor, inv.vendor_id, 'invoice', id);
  const po = getPo(inv.po_id)!;
  const exceptions = all<{ id: number; vendor_message: string; status: string; line_item: number | null; created_at: string; resolved_at: string | null }>(
    "SELECT id, vendor_message, status, line_item, created_at, resolved_at FROM invoice_exceptions WHERE invoice_id = ? AND status IN ('Open','Rejected') ORDER BY id", id,
  ).map((e) => ({ ...e, status: e.status === 'Open' ? 'Under review' : 'Returned' }));
  const events = all<{ id: number; status: string | null; vendor_note: string | null; title: string; created_at: string }>(
    'SELECT id, status, vendor_note, title, created_at FROM invoice_events WHERE invoice_id = ? AND vendor_visible = 1 ORDER BY created_at, id', id,
  ).map((e) => ({ id: e.id, status: e.status, title: e.vendor_note ?? e.title, created_at: e.created_at }));
  const att = inv.attachment_id ? getAttachment(inv.attachment_id) : undefined;
  return {
    id: inv.id, inv_ref: inv.inv_ref, vendor_invoice_no: inv.vendor_invoice_no, invoice_date: inv.invoice_date, status: vendorStatus(inv.status),
    on_behalf: inv.on_behalf, created_at: inv.created_at, total_value: inv.total_value, taxable_value: inv.taxable_value, gst_amount: inv.gst_amount, freight: inv.freight,
    po: { id: po.id, po_no: po.po_no, po_date: po.po_date, plant: po.plant },
    values: inv.values ? { header: inv.values.header, lines: inv.values.lines } : null,
    extracted: inv.extracted ? { capture: inv.extracted.capture, note: OCR_NOTE, engine: inv.extracted.engine } : null,
    rejected_reason: inv.status === 'Rejected' ? inv.rejected_reason : null,
    payment_blocked_reason: inv.status === 'Payment blocked' ? inv.vendor_reason ?? 'Payment is on hold. Contact Equipcare accounts.' : null,
    exceptions, events, attachment: att && att.vendor_visible ? { id: att.id, filename: att.filename, mime: att.mime } : null,
    header_fields: HEADER_FIELDS, line_fields: LINE_FIELDS,
  };
}

// ------------------------------------------------------------------ upload context
export function poOptions(actor: Actor) {
  const isVendor = actor.role === 'VEN';
  return all<{ id: number; po_no: string; vendor_name: string; vendor_id: number; plant: string; po_date: string; status: string; total_value: number | null }>(
    `SELECT p.id, p.po_no, v.name AS vendor_name, p.vendor_id, p.plant, p.po_date, p.status, p.total_value FROM pos p JOIN vendors v ON v.id = p.vendor_id
     WHERE p.status != 'Cancelled' ${isVendor ? 'AND p.vendor_id = ' + Number(actor.vendorId ?? -1) : scopePlants(actor)} ORDER BY p.po_date DESC`,
  );
}

export function uploadContext(actor: Actor, poId: number) {
  const po = getPo(poId);
  if (!po) throw notFound('Purchase order');
  if (actor.role === 'VEN') assertVendorScope(actor, po.vendor_id, 'po', po.id);
  else if (!plantAllowed(actor, po.plant)) throw notFound('Purchase order');
  const vendor = get<{ name: string; sap_code: string | null; gstin: string | null }>('SELECT name, sap_code, gstin FROM vendors WHERE id = ?', po.vendor_id)!;
  const plant = get<{ code: string; name: string; gstin: string | null }>('SELECT code, name, gstin FROM plants WHERE code = ?', po.plant);
  const asns = all("SELECT id, asn_no, status, dispatch_date, eway_bill FROM asns WHERE po_id = ? AND status NOT IN ('Draft','Cancelled') ORDER BY id DESC", po.id);
  const invoices = all("SELECT id, inv_ref, vendor_invoice_no, status, total_value FROM invoices WHERE po_id = ? AND status != 'Rejected' ORDER BY id DESC", po.id);
  return {
    po: { id: po.id, po_no: po.po_no, po_date: po.po_date, plant: po.plant, payment_terms: po.payment_terms, delivery_terms: po.delivery_terms, freight_terms: po.freight_terms, total_value: po.total_value, status: po.status },
    vendor: { name: vendor.name, sap_code: vendor.sap_code, gstin: vendor.gstin }, plant: actor.role === 'VEN' ? { code: plant?.code } : plant,
    // Vendors see their own PO lines only — no receipt quantities, billing balances or internal fields.
    lines: actor.role === 'VEN'
      ? poContext(po).map((l) => ({ id: l.id, item: l.item, material_code: l.material_code, description: l.description, qty: l.qty, uom: l.uom, unit_price: l.unit_price, gst_rate: l.gst_rate, hsn: l.hsn }))
      : poContext(po),
    asns, invoices,
    on_behalf_enabled: cfg<boolean>('inv.upload_on_behalf'), ocr_note: OCR_NOTE,
  };
}

// ------------------------------------------------------------------ RPT-09 data (KPI-10, KPI-11)
export function reportSummary(actor: Actor) {
  const inv = all<{ id: number; status: string; extracted: Extracted | null; parked_at: string | null; posted_at: string | null; plant: string }>(
    `SELECT i.id, i.status, i.extracted_json, i.parked_at, i.posted_at, p.plant FROM invoices i JOIN pos p ON p.id = i.po_id WHERE 1 = 1 ${scopePlants(actor)}`,
  );
  const ids = inv.map((i) => i.id);
  const corr = all<{ invoice_id: number; field: string }>('SELECT invoice_id, field FROM invoice_corrections');
  const everExc = new Set(all<{ invoice_id: number }>("SELECT DISTINCT invoice_id FROM invoice_exceptions WHERE NOT (rule = '3WM-02' AND reason LIKE 'Pending%')").map((r) => r.invoice_id));
  let extracted = 0;
  let corrected = 0;
  for (const i of inv) {
    const a = accuracy(i.extracted, new Set(corr.filter((c) => c.invoice_id === i.id).map((c) => c.field)));
    extracted += a.extracted;
    corrected += a.corrected;
  }
  const reasons = all<{ reason: string; open: number; total: number }>(
    `SELECT reason, SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END) AS open, COUNT(*) AS total FROM invoice_exceptions ${ids.length ? `WHERE invoice_id IN (${ids.join(',')})` : 'WHERE 0'} GROUP BY reason ORDER BY total DESC`,
  );
  const by = (s: string[]) => inv.filter((i) => s.includes(i.status)).length;
  return {
    uploaded: inv.length, ocr_success: inv.filter((i) => i.extracted).length, matched_first_pass: inv.filter((i) => !everExc.has(i.id) && i.status !== 'Rejected').length,
    kpi_11_match_success: inv.length ? round2((inv.filter((i) => !everExc.has(i.id) && i.status !== 'Rejected').length / inv.length) * 100) / 100 : null,
    kpi_10_field_accuracy: extracted ? Math.round(((extracted - corrected) / extracted) * 10000) / 10000 : null, fields_extracted: extracted, fields_corrected: corrected,
    pending: by(['Uploaded', 'OCR pending', 'Validation pending']), exception: by(['Exception']), matched: by(['Matched']), parked: by(['Parked']), posted: by(['Posted', 'Payment due']), paid: by(['Payment released']), blocked: by(['Payment blocked']), rejected: by(['Rejected']),
    reasons, baseline: 'Baseline: to be measured', target: 'Target: pending approval', simulated_ocr: OCR_NOTE,
  };
}
