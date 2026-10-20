/**
 * Module 3 — Vendor quotation entry (PRD 7.3: FR-QTN-01..08, AC-QTN-01..06).
 * Quotation contract (ENGINEERING.md): quotations.lines_json entries
 *   { rfq_line_id, no_quote, quoted_qty, basic_price, discount_pct, gst_rate, freight, packing, delivery_days,
 *     make_brand, warranty, alternate, partial, remarks }  + header payment_terms, credit_days, delivery_terms, validity_date, remarks.
 * Every submission is a numbered `quotation_versions` row with the changed fields; at close (and at the end of a reopen
 * window) the latest submitted version is what gets locked.
 */
import { all, get, insert, update, J, now } from '../../core/db.ts';
import { audit } from '../../core/audit.ts';
import { notify } from '../../core/notify.ts';
import { HttpError, badRequest, conflict } from '../../core/http.ts';
import { assertVendorScope, type Actor } from '../../core/auth.ts';
import { nextNo } from '../../core/numbering.ts';
import { mustRfq, getRfq, ensureDue, linesOf, openReopenFor, fmtIST, isSealedNow, GST_RATES, DELIVERY_TERMS, type Rfq, type RfqLine, type Invitation } from './service.ts';

export interface QLine {
  rfq_line_id: number; no_quote: boolean; quoted_qty: number | null; basic_price: number | null; discount_pct: number | null; gst_rate: number | null;
  freight: number | null; packing: number | null; delivery_days: number | null; make_brand: string | null; warranty: string | null;
  alternate: boolean; partial: boolean; remarks: string | null;
}
export interface QHeader { payment_terms: string | null; credit_days: number | null; delivery_terms: string | null; validity_date: string | null; remarks: string | null }
export interface QuoteRow extends QHeader { id: number; rfq_id: number; vendor_id: number; status: string; version: number; ref_no: string | null; submitted_at: string | null; lines: QLine[] | null; updated_at: string | null; created_at: string | null }
export interface QuoteInput { header?: Partial<QHeader>; lines?: Partial<QLine>[] }

const HEADER_KEYS: (keyof QHeader)[] = ['payment_terms', 'credit_days', 'delivery_terms', 'validity_date', 'remarks'];
const LINE_KEYS: (keyof QLine)[] = ['no_quote', 'quoted_qty', 'basic_price', 'discount_pct', 'gst_rate', 'freight', 'packing', 'delivery_days', 'make_brand', 'warranty', 'alternate', 'partial', 'remarks'];
const LABEL: Record<string, string> = {
  no_quote: 'not quoted', quoted_qty: 'quoted quantity', basic_price: 'basic price', discount_pct: 'discount %', gst_rate: 'GST rate', freight: 'freight', packing: 'packing & forwarding',
  delivery_days: 'delivery days', make_brand: 'make / brand', warranty: 'warranty', alternate: 'alternate make', partial: 'partial quantity', remarks: 'remarks',
  payment_terms: 'payment terms', credit_days: 'credit days', delivery_terms: 'delivery terms', validity_date: 'validity date',
};

const quoteOf = (rfqId: number, vendorId: number) => get<QuoteRow>('SELECT * FROM quotations WHERE rfq_id = ? AND vendor_id = ?', rfqId, vendorId);
const quotable = (rfqId: number) => linesOf(rfqId).filter((l) => l.status !== 'Removed');

/** Latest submitted version of a quotation (what buyers and the comparison see). */
export function restoreLatest(qid: number) {
  const v = get<{ version: number; lines: QLine[] | null; header: (QHeader & { _ref?: string; _changes?: unknown[] }) | null; created_at: string }>(
    'SELECT version, lines_json, header_json, created_at FROM quotation_versions WHERE quotation_id = ? ORDER BY version DESC LIMIT 1', qid,
  );
  if (!v) return null;
  const header: QHeader = { payment_terms: v.header?.payment_terms ?? null, credit_days: v.header?.credit_days ?? null, delivery_terms: v.header?.delivery_terms ?? null, validity_date: v.header?.validity_date ?? null, remarks: v.header?.remarks ?? null };
  return { version: v.version, header, lines: v.lines ?? [], created_at: v.created_at, ref_no: v.header?._ref ?? null };
}

/** Lock at close / end of reopen: the latest submitted version becomes the record (FR-QTN-05). */
export function lockQuotations(rfqId: number, vendorIds: number[] | null) {
  const qs = all<QuoteRow>("SELECT * FROM quotations WHERE rfq_id = ? AND status IN ('Not started','Draft','Submitted','Reopened')", rfqId)
    .filter((q) => !vendorIds || vendorIds.includes(q.vendor_id));
  let n = 0;
  for (const q of qs) {
    const latest = q.version > 0 ? restoreLatest(q.id) : null;
    if (latest) {
      update('quotations', q.id, { status: 'Locked', lines_json: J(latest.lines), ...latest.header, ref_no: latest.ref_no ?? q.ref_no, updated_at: now() });
      n++;
    } else if (q.status === 'Reopened') update('quotations', q.id, { status: 'Not started', updated_at: now() });
  }
  return n;
}

// ------------------------------------------------------------------ editability
export function editState(r: Rfq, vendorId: number): { editable: boolean; mode: 'open' | 'reopen' | null; until: string | null; reason: string | null } {
  if (r.status === 'Published' && new Date(r.closing_at).getTime() > Date.now()) return { editable: true, mode: 'open', until: r.closing_at, reason: null };
  const ro = ['Closed', 'Under comparison'].includes(r.status) ? openReopenFor(r.id, vendorId) : null;
  if (ro) return { editable: true, mode: 'reopen', until: ro.reopen_until, reason: null };
  const reason = r.status === 'Cancelled' ? 'This RFQ was cancelled.' : r.status === 'Re-floated' ? 'This RFQ was re-floated as a new RFQ.' : 'The RFQ has closed and quotations are locked. Changes are possible only if Equipcare reopens the RFQ for you.';
  return { editable: false, mode: null, until: null, reason };
}

function vendorContext(actor: Actor, rfqId: number) {
  const r0 = getRfq(rfqId);
  const inv = r0 && actor.vendorId ? get<Invitation>('SELECT * FROM rfq_invitations WHERE rfq_id = ? AND vendor_id = ? AND sent_at IS NOT NULL', rfqId, actor.vendorId) : undefined;
  // Vendor isolation (GOV-C09): not invited (or not yet published) → 404, attempt audited.
  if (!r0 || !inv || ['Draft', 'Pending approval'].includes(r0.status)) assertVendorScope(actor, null, 'rfq', rfqId);
  const r = ensureDue(r0!);
  return { r, inv: get<Invitation>('SELECT * FROM rfq_invitations WHERE id = ?', inv!.id)!, vendorId: actor.vendorId! };
}

const vendorStatusOf = (r: Rfq, edit: { editable: boolean; mode: string | null }) =>
  edit.mode === 'reopen' ? 'Reopened for you' : r.status === 'Published' ? 'Open' : r.status === 'Cancelled' ? 'Cancelled' : r.status === 'Re-floated' ? 'Re-floated' : 'Closed';

// ------------------------------------------------------------------ vendor reads (SCR-VPT-03, SCR-VPT-04)
export function vendorInbox(actor: Actor) {
  const rows = all<Rfq & { inv_status: string; viewed_at: string | null; responded_at: string | null; declined_at: string | null; sent_at: string; buyer_name: string }>(
    `SELECT r.*, i.status AS inv_status, i.viewed_at, i.responded_at, i.declined_at, i.sent_at, u.name AS buyer_name
     FROM rfq_invitations i JOIN rfqs r ON r.id = i.rfq_id LEFT JOIN users u ON u.id = r.buyer_id
     WHERE i.vendor_id = ? AND i.sent_at IS NOT NULL AND r.status NOT IN ('Draft','Pending approval') ORDER BY i.sent_at DESC`,
    actor.vendorId,
  );
  return rows.map((row) => {
    const r = row.status === 'Published' && new Date(row.closing_at).getTime() <= Date.now() ? ensureDue(row) : row;
    const q = quoteOf(r.id, actor.vendorId!);
    const edit = editState(r, actor.vendorId!);
    return {
      id: r.id, rfq_no: r.rfq_no, title: r.title, kind: r.kind ?? 'Spot', closing_at: r.closing_at, buyer_name: row.buyer_name, sent_at: row.sent_at,
      rfq_status: vendorStatusOf(r, edit), editable: edit.editable, edit_until: edit.until,
      invitation_status: get<{ status: string }>('SELECT status FROM rfq_invitations WHERE rfq_id = ? AND vendor_id = ?', r.id, actor.vendorId)!.status,
      quotation_status: q ? q.status : 'Not started', version: q?.version ?? 0, submitted_at: q?.submitted_at ?? null, ref_no: q?.ref_no ?? null,
      lines: quotable(r.id).length, hours_to_close: Math.round((new Date(r.closing_at).getTime() - Date.now()) / 3600000),
    };
  });
}

function vendorLineView(l: RfqLine) {
  const m = l.material_id ? get<{ code: string; hsn: string | null; brand: string | null }>('SELECT code, hsn, brand FROM materials WHERE id = ?', l.material_id) : undefined;
  const files = all('SELECT a.id, a.label, a.filename, a.size, a.mime, a.created_at FROM attachments a JOIN users u ON u.id = a.uploaded_by WHERE a.owner_type = ? AND a.owner_id = ? AND a.vendor_visible = 1 AND u.vendor_id IS NULL AND a.scan_status = ? ORDER BY a.id', 'rfq_line', l.id, 'Available');
  return {
    id: l.id, line_no: l.line_no, material_code: m?.code ?? null, hsn: m?.hsn ?? null, brand: m?.brand ?? null, description: l.description, qty: l.qty, uom: l.uom,
    required_date: l.required_date, due_at: l.due_at, plant: l.plant, ship_to: l.ship_to, gst_rate: l.gst_rate, valuation_type: l.valuation_type,
    transport_req: l.transport_req, specs: l.specs, flagged: l.status === 'Flagged', files,
  };
}

export function vendorView(actor: Actor, rfqId: number) {
  const { r, inv, vendorId } = vendorContext(actor, rfqId);
  const ts = now();
  // FR-RFQ-08 / AC-RFQ-08: first open marks the invitation Viewed with a timestamp.
  if (inv.status === 'Invited') {
    update('rfq_invitations', inv.id, { status: 'Viewed', viewed_at: ts });
    audit(actor, { action: 'rfq.viewed_by_vendor', objectType: 'rfq', objectId: r.id, objectRef: r.rfq_no, before: { status: 'Invited' }, after: { status: 'Viewed', viewed_at: ts } });
  } else if (!inv.viewed_at) update('rfq_invitations', inv.id, { viewed_at: ts });
  const edit = editState(r, vendorId);
  let q = quoteOf(r.id, vendorId);
  if (!q && edit.editable) {
    insert('quotations', { rfq_id: r.id, vendor_id: vendorId, status: 'Not started', version: 0, created_at: ts, updated_at: ts });
    q = quoteOf(r.id, vendorId);
  }
  const fresh = get<Invitation>('SELECT * FROM rfq_invitations WHERE id = ?', inv.id)!;
  const files = all('SELECT a.id, a.label, a.filename, a.size, a.mime, a.created_at FROM attachments a JOIN users u ON u.id = a.uploaded_by WHERE a.owner_type = ? AND a.owner_id = ? AND a.vendor_visible = 1 AND u.vendor_id IS NULL AND a.scan_status = ? ORDER BY a.id', 'rfq', r.id, 'Available');
  const docs = q ? all('SELECT a.id, a.label, a.filename, a.size, a.mime, a.created_at, a.scan_status FROM attachments a WHERE a.owner_type = ? AND a.owner_id = ? ORDER BY a.id', 'quotation', q.id) : [];
  const versions = q ? all<{ version: number; created_at: string; header: Record<string, unknown> | null; note: string | null }>('SELECT version, created_at, header_json, note FROM quotation_versions WHERE quotation_id = ? ORDER BY version DESC', q.id)
    .map((v) => ({ version: v.version, created_at: v.created_at, note: v.note, ref_no: (v.header?._ref as string) ?? null, changes: (v.header?._changes as unknown[]) ?? [] })) : [];
  const buyer = get<{ name: string; email: string; phone: string | null }>('SELECT name, email, phone FROM users WHERE id = ?', r.buyer_id);
  return {
    id: r.id, rfq_no: r.rfq_no, title: r.title, kind: r.kind ?? 'Spot', status: vendorStatusOf(r, edit), closing_at: r.closing_at, published_at: r.published_at,
    delivery_terms: r.delivery_terms, payment_terms: r.payment_terms, warranty: r.warranty, packing: r.packing, documents_required: r.documents_required,
    standard_terms: r.standard_terms, ship_to: r.ship_to, extensions: (r.extensions ?? []).map((e) => ({ from: e.from, to: e.to, at: e.at })),
    buyer: buyer ? { name: buyer.name, email: buyer.email } : null,
    invitation: { status: fresh.status, sent_at: fresh.sent_at, viewed_at: fresh.viewed_at, responded_at: fresh.responded_at, declined_at: fresh.declined_at, decline_reason: fresh.decline_reason },
    edit, lines: quotable(r.id).map(vendorLineView), files,
    quotation: q ? { id: q.id, status: q.status, version: q.version, ref_no: q.ref_no, submitted_at: q.submitted_at, updated_at: q.updated_at, header: pickHeader(q), lines: q.lines ?? [] } : null,
    documents: docs, versions, gst_rates: GST_RATES, delivery_terms_options: DELIVERY_TERMS,
  };
}

const pickHeader = (q: QHeader): QHeader => ({ payment_terms: q.payment_terms ?? null, credit_days: q.credit_days ?? null, delivery_terms: q.delivery_terms ?? null, validity_date: q.validity_date ?? null, remarks: q.remarks ?? null });

// ------------------------------------------------------------------ normalise & validate (rules 7.3)
function normalise(rfqLines: RfqLine[], input: QuoteInput, current: QuoteRow | undefined) {
  const header: QHeader = { ...pickHeader(current ?? ({} as QHeader)), ...Object.fromEntries(HEADER_KEYS.filter((k) => input.header && k in input.header).map((k) => [k, (input.header as Record<string, unknown>)[k] ?? null])) } as QHeader;
  for (const k of ['payment_terms', 'remarks', 'validity_date', 'delivery_terms'] as const) if (typeof header[k] === 'string') header[k] = (header[k] as string).trim() || null;
  const existing = new Map((current?.lines ?? []).map((x) => [x.rfq_line_id, x]));
  const incoming = new Map((input.lines ?? []).filter((x) => x.rfq_line_id).map((x) => [x.rfq_line_id!, x]));
  const lines: QLine[] = rfqLines.map((l) => {
    const base = existing.get(l.id);
    const inc = incoming.get(l.id);
    const e: QLine = {
      rfq_line_id: l.id, no_quote: false, quoted_qty: null, basic_price: null, discount_pct: null, gst_rate: l.gst_rate ?? null, freight: null, packing: null,
      delivery_days: null, make_brand: null, warranty: null, alternate: false, partial: false, remarks: null, ...(base ?? {}), ...(inc ?? {}),
    } as QLine;
    e.no_quote = !!e.no_quote;
    e.alternate = !!e.alternate;
    for (const k of ['make_brand', 'warranty', 'remarks'] as const) if (typeof e[k] === 'string') e[k] = (e[k] as string).trim() || null;
    if (e.quoted_qty == null && !e.no_quote) e.quoted_qty = l.qty;
    e.partial = !e.no_quote && e.quoted_qty != null && e.quoted_qty < l.qty;
    return e;
  });
  return { header, lines };
}

function check(r: Rfq, rfqLines: RfqLine[], h: QHeader, lines: QLine[], strict: boolean, previous: QLine[] | null) {
  const f: Record<string, string> = {};
  const tag = (l: RfqLine) => `Line ${l.line_no} (${l.description.slice(0, 40)})`;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  rfqLines.forEach((l, i) => {
    const e = lines[i];
    const k = (x: string) => `lines.${l.line_no}.${x}`;
    if (e.no_quote) return;
    if (e.basic_price != null && (!num(e.basic_price) || e.basic_price < 0)) f[k('basic_price')] = `${tag(l)}: basic price must be zero or more`;
    if (e.discount_pct != null && (!num(e.discount_pct) || e.discount_pct < 0 || e.discount_pct > 100)) f[k('discount_pct')] = `${tag(l)}: discount must be between 0 and 100%`;
    if (e.gst_rate != null && !GST_RATES.includes(e.gst_rate)) f[k('gst_rate')] = `${tag(l)}: GST rate must be one of ${GST_RATES.join(', ')}%`;
    for (const x of ['freight', 'packing'] as const) if (e[x] != null && (!num(e[x]) || (e[x] as number) < 0)) f[k(x)] = `${tag(l)}: ${LABEL[x]} must be zero or more`;
    if (e.delivery_days != null && (!Number.isInteger(e.delivery_days) || e.delivery_days < 0)) f[k('delivery_days')] = `${tag(l)}: delivery days must be a whole number of days`;
    if (e.quoted_qty != null && (!num(e.quoted_qty) || e.quoted_qty <= 0)) f[k('quoted_qty')] = `${tag(l)}: quoted quantity must be more than zero`;
    if (e.quoted_qty != null && e.quoted_qty > l.qty) f[k('quoted_qty')] = `${tag(l)}: quoted quantity cannot exceed the RFQ quantity (${l.qty} ${l.uom})`;
    if (!strict) return;
    if (e.basic_price == null) f[k('basic_price')] = `${tag(l)}: basic price is required — or mark the line "Not quoting"`;
    if (e.gst_rate == null) f[k('gst_rate')] = `${tag(l)}: GST rate is required`;
    if (e.delivery_days == null) f[k('delivery_days')] = `${tag(l)}: delivery days are required`;
    if (e.alternate && !e.make_brand) f[k('make_brand')] = `${tag(l)}: name the alternate make / brand you are offering`;
  });
  if (strict) {
    // Lines past their own quote due date cannot be changed after that date.
    rfqLines.forEach((l, i) => {
      if (!l.due_at || new Date(l.due_at).getTime() > Date.now() || new Date(l.due_at).getTime() >= new Date(r.closing_at).getTime()) return;
      const prev = previous?.find((x) => x.rfq_line_id === l.id);
      const same = prev ? LINE_KEYS.every((k) => JSON.stringify(prev[k]) === JSON.stringify(lines[i][k])) : lines[i].no_quote;
      if (!same) f[`lines.${l.line_no}.due_at`] = `${tag(l)}: quotes for this line were due ${fmtIST(l.due_at)} — it cannot be changed now`;
    });
    if (lines.every((e) => e.no_quote)) f.lines = 'Quote at least one line, or decline the RFQ with a reason';
    if (!h.validity_date) f['header.validity_date'] = 'Validity date is required';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(h.validity_date)) f['header.validity_date'] = 'Validity date must be a date (YYYY-MM-DD)';
    else if (h.validity_date < r.closing_at.slice(0, 10)) f['header.validity_date'] = `Validity must be on or after the RFQ closing date (${r.closing_at.slice(0, 10)})`;
    if (!h.delivery_terms) f['header.delivery_terms'] = 'Delivery terms are required (FOR or Ex-Works)';
    if (!h.payment_terms) f['header.payment_terms'] = 'Payment terms are required';
  }
  if (h.delivery_terms && !DELIVERY_TERMS.includes(h.delivery_terms as never)) f['header.delivery_terms'] = 'Delivery terms must be FOR or Ex-Works';
  if (h.credit_days != null && (!Number.isInteger(h.credit_days) || h.credit_days < 0)) f['header.credit_days'] = 'Credit days must be a whole number of days';
  if (Object.keys(f).length) {
    const msgs = Object.values(f);
    throw new HttpError(400, 'validation_failed', `${msgs[0]}${msgs.length > 1 ? ` (and ${msgs.length - 1} more)` : ''}.`, f);
  }
}

function assertEditable(r: Rfq, vendorId: number, what: string) {
  const edit = editState(r, vendorId);
  if (!edit.editable) throw new HttpError(409, 'rfq_closed', `${what} rejected: ${edit.reason} Nothing was saved.`);
  return edit;
}

// ------------------------------------------------------------------ vendor actions
export function saveDraft(actor: Actor, rfqId: number, input: QuoteInput) {
  const { r, inv, vendorId } = vendorContext(actor, rfqId);
  const edit = assertEditable(r, vendorId, 'Saving');
  const q = quoteOf(r.id, vendorId);
  const rl = quotable(r.id);
  const { header, lines } = normalise(rl, input, q);
  check(r, rl, header, lines, false, null);
  const ts = now();
  const status = edit.mode === 'reopen' ? 'Reopened' : 'Draft';
  if (q) update('quotations', q.id, { ...header, lines_json: J(lines), status, updated_at: ts });
  else insert('quotations', { rfq_id: r.id, vendor_id: vendorId, ...header, lines_json: J(lines), status, version: 0, created_at: ts, updated_at: ts });
  if (inv.status === 'Declined') update('rfq_invitations', inv.id, { status: inv.viewed_at ? 'Viewed' : 'Invited', declined_at: null, decline_reason: null });
  audit(actor, { action: 'qtn.draft_saved', objectType: 'rfq', objectId: r.id, objectRef: r.rfq_no, after: { lines_filled: lines.filter((l) => l.no_quote || l.basic_price != null).length, of: lines.length } });
  return vendorView(actor, rfqId);
}

export function submit(actor: Actor, rfqId: number, input: QuoteInput) {
  const { r, inv, vendorId } = vendorContext(actor, rfqId);
  const edit = assertEditable(r, vendorId, 'Submission');
  const q = quoteOf(r.id, vendorId);
  const rl = quotable(r.id);
  const { header, lines } = normalise(rl, input, q);
  const prev = q && q.version > 0 ? restoreLatest(q.id) : null;
  check(r, rl, header, lines, true, prev?.lines ?? null);
  const ts = now();
  const version = (q?.version ?? 0) + 1;
  const ref = nextNo('QTN');
  // FR-QTN-06: changed values against the previous submitted version.
  const changes: { line: number | null; field: string; label: string; from: unknown; to: unknown }[] = [];
  if (prev) {
    for (const k of HEADER_KEYS) if (JSON.stringify(prev.header[k] ?? null) !== JSON.stringify(header[k] ?? null)) changes.push({ line: null, field: k, label: LABEL[k], from: prev.header[k] ?? null, to: header[k] ?? null });
    rl.forEach((l, i) => {
      const p = prev.lines.find((x) => x.rfq_line_id === l.id);
      for (const k of LINE_KEYS) {
        const a = p ? p[k] ?? null : null;
        const b = lines[i][k] ?? null;
        if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ line: l.line_no, field: k, label: LABEL[k], from: a, to: b });
      }
    });
  }
  const status = edit.mode === 'reopen' ? 'Reopened' : 'Submitted';
  let qid = q?.id;
  if (qid) update('quotations', qid, { ...header, lines_json: J(lines), status, version, ref_no: ref, submitted_at: ts, updated_at: ts });
  else qid = insert('quotations', { rfq_id: r.id, vendor_id: vendorId, ...header, lines_json: J(lines), status, version, ref_no: ref, submitted_at: ts, created_at: ts, updated_at: ts });
  insert('quotation_versions', {
    quotation_id: qid, version, lines_json: J(lines), header_json: J({ ...header, _ref: ref, _changes: changes, _mode: edit.mode }), created_at: ts, created_by: actor.id,
    note: version === 1 ? 'First submission' : `${changes.length} field${changes.length === 1 ? '' : 's'} changed${edit.mode === 'reopen' ? ' (reopened)' : ''}`,
  });
  update('rfq_invitations', inv.id, { status: 'Responded', responded_at: ts, declined_at: null, decline_reason: null });
  // Audit without prices: the audit log is readable by internal roles before the sealed RFQ closes.
  audit(actor, { action: version === 1 ? 'qtn.submitted' : 'qtn.revised', objectType: 'rfq', objectId: r.id, objectRef: r.rfq_no, after: { quotation: qid, version, ref, submitted_at: ts, lines_quoted: lines.filter((l) => !l.no_quote).length, alternate: lines.filter((l) => l.alternate).length, partial: lines.filter((l) => l.partial).length, changed_fields: changes.map((c) => `${c.line ? `line ${c.line} ` : ''}${c.label}`), mode: edit.mode } });
  const fresh = getRfq(r.id)!;
  const sent = all<{ status: string }>('SELECT status FROM rfq_invitations WHERE rfq_id = ? AND sent_at IS NOT NULL', r.id);
  const responded = sent.filter((x) => x.status === 'Responded').length;
  const vendor = get<{ name: string }>('SELECT name FROM vendors WHERE id = ?', vendorId)!;
  const sealed = isSealedNow(fresh);
  notify({
    event: 'NTF-08', title: sealed ? `Quotation received on ${r.rfq_no}: ${responded} of ${sent.length} responded` : `${vendor.name} ${version > 1 ? 'revised' : 'submitted'} a quotation on ${r.rfq_no}`,
    body: sealed ? 'Sealed RFQ — prices are visible after closing.' : `Version ${version} · ${lines.filter((l) => !l.no_quote).length} line(s) quoted.`,
    link: `/rfqs/${r.id}`, users: [r.buyer_id], objectType: 'rfq', objectId: r.id, dedupeKey: `NTF-08:${r.id}:${responded}:${version}:${vendorId}`,
  });
  return { ack: { ref_no: ref, submitted_at: ts, version, rfq_no: r.rfq_no, lines_quoted: lines.filter((l) => !l.no_quote).length, editable_until: edit.until }, view: vendorView(actor, rfqId) };
}

export function decline(actor: Actor, rfqId: number, reason: string) {
  const { r, inv, vendorId } = vendorContext(actor, rfqId);
  const edit = assertEditable(r, vendorId, 'Declining');
  if (edit.mode === 'reopen') throw conflict('The RFQ was reopened for a revision; submit your revised quotation or leave the locked one as it is.');
  const ts = now();
  const q = quoteOf(r.id, vendorId);
  if (q) update('quotations', q.id, { status: 'Declined', updated_at: ts });
  else insert('quotations', { rfq_id: r.id, vendor_id: vendorId, status: 'Declined', version: 0, created_at: ts, updated_at: ts });
  update('rfq_invitations', inv.id, { status: 'Declined', declined_at: ts, decline_reason: reason, responded_at: null });
  audit(actor, { action: 'qtn.declined', objectType: 'rfq', objectId: r.id, objectRef: r.rfq_no, before: { status: inv.status }, after: { status: 'Declined', withdrew_submitted: !!q && q.version > 0 }, reason });
  const vendor = get<{ name: string }>('SELECT name FROM vendors WHERE id = ?', vendorId)!;
  notify({ event: 'NTF-08', title: `${vendor.name} declined ${r.rfq_no}`, body: reason, link: `/rfqs/${r.id}`, users: [r.buyer_id], objectType: 'rfq', objectId: r.id, dedupeKey: `NTF-08d:${r.id}:${vendorId}:${ts}` });
  return vendorView(actor, rfqId);
}

/** Vendor access check for the RFQ PDF and documents. */
export function vendorRfq(actor: Actor, rfqId: number) {
  return vendorContext(actor, rfqId).r;
}

export function assertBuyerSees(rfqId: number) {
  const r = mustRfq(rfqId);
  if (isSealedNow(r)) throw conflict('Quotations are sealed until the RFQ closes (FR-RFQ-12).');
  return r;
}
export { badRequest };
