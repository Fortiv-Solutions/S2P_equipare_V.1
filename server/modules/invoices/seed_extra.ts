/**
 * Extended demo data for Module 10 (invoices): a working year of accounts-payable traffic on the extra POs
 * (4500030001+ historic, 4500031001+ open) plus three small FDS POs for the price check.
 *
 * Everything goes through the real service functions as the right persona (vendor upload or finance on behalf, finance
 * review and approval) and SAP-side statuses arrive through sapPut('INVSTATUS') + the inbound sync, exactly like the
 * base seed. Dates are back-dated with the module clock (S.withClock) so ageing and KPI-10/11 look real. Deterministic:
 * a seeded RNG drives every choice. Gated on DEMO_EXTRA by seedInvoices().
 */
import crypto from 'node:crypto';
import { all, get, insert, run, tx, round2 } from '../../core/db.ts';
import { sapPut, syncEvent } from '../../core/sap.ts';
import { storeFile } from '../../core/files.ts';
import { nextNo } from '../../core/numbering.ts';
import { validateGstin } from '../../core/india.ts';
import { actorFor, D, DAY, M, U } from '../../seed/ctx.ts';
import { EXTRA } from '../../seed/base_extra.ts';
import { openDisputesForPo } from '../asn/service.ts';
import { expectedFdsPrice } from '../contracts/service.ts';
import { invoicePdf, photoPng } from './docs.ts';
import { simulateOcr, thresholdFor, HEADER_FIELDS, LINE_FIELDS } from './ocr.ts';
import { invoiceValues, tick } from './seed.ts';
import * as S from './service.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Spec = { item: number; qty: number; rate?: number };
type Built = NonNullable<ReturnType<typeof invoiceValues>>;
type Kind = 'clean' | 'price' | 'excess' | 'tax' | 'freight' | 'gstin' | 'bank' | 'buyer' | 'total' | 'photo_low' | 'photo_ok' | 'dispute' | 'pending' | 'fds';
type To = 'matched' | 'exception' | 'approved' | 'parked' | 'posted' | 'due' | 'paid' | 'blocked' | 'rejected' | 'uploaded' | 'ocr';
type Pool = 'hist' | 'nogrn' | 'partial' | 'full';
interface PoLine { id: number; item: number; qty: number; unit_price: number; gst_rate: number; received: number }
interface PoInfo {
  id: number; po_no: string; vendor_id: number; vendor: string; plant: string; po_date: string; terms: string | null; contract_id: number | null;
  lines: PoLine[]; grn: string | null; days: number; fromGrn: boolean; vendorUser: string | null; service: boolean; used: boolean;
}
interface Plan {
  tag: string; kind: Kind; to: To; age: [number, number]; pool?: Pool;
  resolve?: 'approve-exc' | 'credit' | 'correct' | 'verify' | 'reject'; resubmit?: To; assign?: string;
  dueOff?: [number, number]; variant?: number;
}
interface Flow { inv: S.InvoiceRow; po: PoInfo; up: { by: string; approver: string; onBehalf: boolean }; upDay: string; invDate: string; spec: Spec[]; no: string }

// ------------------------------------------------------------------ dates
const todayMs = () => Date.parse(`${DAY(0)}T00:00:00Z`);
const offOf = (date: string) => Math.round((Date.parse(`${date.slice(0, 10)}T00:00:00Z`) - todayMs()) / 86400000);
const addD = (date: string, n: number) => DAY(offOf(date) + n);
/** Timestamp for a date at an IST hour, never in the future. */
const atDate = (date: string, hour = 10, min = 0) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCHours(hour - 5, 30 + min, 0, 0);
  return new Date(Math.min(d.getTime(), Date.now() - 60000)).toISOString();
};
const fyOf = (d: string) => { const y = Number(d.slice(0, 4)); const s = Number(d.slice(5, 7)) >= 4 ? y : y - 1; return `${String(s).slice(2)}-${String(s + 1).slice(2)}`; };

// ------------------------------------------------------------------ SAP side
function sapStatus(at: string, ref: string, payload: Record<string, unknown>) {
  tick();
  const prev = (get<{ payload: Record<string, unknown> }>("SELECT payload_json FROM sap_documents WHERE doc_type = 'INVSTATUS' AND doc_key = ?", ref)?.payload) ?? {};
  S.withClock(at, () => {
    sapPut('INVSTATUS', ref, { ...prev, ...payload }, 'Seed');
    syncEvent('INVSTATUS');
  });
}

const CHAIN: Record<To, number> = { matched: 0, exception: 0, uploaded: 0, ocr: 0, rejected: 1, approved: 1, parked: 2, posted: 3, due: 4, blocked: 5, paid: 6 };
const EXPECT: Record<Kind, string> = {
  clean: 'Matched', photo_ok: 'Matched', pending: 'Validation pending', price: 'Exception', excess: 'Exception', tax: 'Exception', freight: 'Exception', gstin: 'Exception',
  bank: 'Exception', buyer: 'Exception', total: 'Exception', photo_low: 'Exception', dispute: 'Exception', fds: 'Exception',
};
const BLOCKS = [
  { internal: 'Payment block R in SAP: GSTR-2B shows no matching supplier filing for this invoice.', vendor: 'Payment is on hold: your GST return for the invoice month is not visible to us yet. Please file GSTR-1 and share the acknowledgement.' },
  { internal: 'Blocked pending bank change verification (change request open on the SAP vendor master).', vendor: 'Payment is on hold until your bank details update is verified. Accounts will contact you.' },
  { internal: 'Quality hold: stores asked for re-inspection of two GRN lines before payment.', vendor: 'Payment is on hold pending a quality re-inspection of part of the delivery. Equipcare stores will contact you.' },
];

export function seedExtra() {
  const r = rng(20261021);
  const rand = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const billed = new Map<number, number>(); // po_line_id → quantity billed on live invoices of this seed
  const usedNos = new Set<string>();
  const usedNonces = new Set<number>();
  const paidRecs: Flow[] = [];
  let finToggle = 0;
  let sapDoc = 5105700100;
  let payRef = 1500010100;

  // ---------------------------------------------------------------- data access
  function loadPo(row: { id: number; po_no: string; vendor_id: number; plant: string; po_date: string; payment_terms: string | null; contract_id: number | null }): PoInfo {
    const lines = S.poLinesOf(row.id).map((l) => ({
      id: l.id, item: l.item, qty: l.qty, unit_price: l.unit_price, gst_rate: l.gst_rate,
      received: get<{ q: number }>('SELECT COALESCE(SUM(qty), 0) AS q FROM grns WHERE po_line_id = ?', l.id)!.q,
    }));
    const service = S.poLinesOf(row.id).every((l) => l.is_service);
    const grn = get<{ d: string | null }>('SELECT MAX(posting_date) AS d FROM grns WHERE po_id = ?', row.id)?.d ?? null;
    const v = get<{ name: string }>('SELECT name FROM vendors WHERE id = ?', row.vendor_id)!;
    const email = get<{ email: string }>('SELECT email FROM users WHERE vendor_id = ? AND active = 1 ORDER BY id LIMIT 1', row.vendor_id)?.email;
    const days = Number(/(\d+)\s*days/i.exec(row.payment_terms ?? '')?.[1] ?? 30);
    return {
      id: row.id, po_no: row.po_no, vendor_id: row.vendor_id, vendor: v.name, plant: row.plant, po_date: row.po_date, terms: row.payment_terms, contract_id: row.contract_id,
      lines, grn, days, fromGrn: /grn/i.test(row.payment_terms ?? ''), vendorUser: email ? email.split('@')[0] : null, service, used: false,
    };
  }
  const poRows = (from: number, to: number) => all<{ id: number; po_no: string; vendor_id: number; plant: string; po_date: string; payment_terms: string | null; contract_id: number | null }>(
    "SELECT id, po_no, vendor_id, plant, po_date, payment_terms, contract_id FROM pos WHERE po_no >= ? AND po_no < ? AND status != 'Cancelled' ORDER BY po_no", String(from), String(to));
  const hasOpenDispute = (po: PoInfo) => {
    try { return openDisputesForPo(po.id).length > 0; } catch { return !!get("SELECT id FROM disputes WHERE po_id = ? AND status NOT IN ('Resolved','Closed')", po.id); }
  };
  const avail = (po: PoInfo, l: PoLine) => round2(l.received - (billed.get(l.id) ?? 0));
  const fully = (po: PoInfo) => po.lines.every((l) => l.received >= l.qty);

  // ---------------------------------------------------------------- uploader, invoice numbers
  function uploaderFor(po: PoInfo, forceFinance = false) {
    if (po.vendorUser && !forceFinance && r() < 0.85) return { by: po.vendorUser, approver: finToggle++ % 2 ? 'kiran.shah' : 'meera.iyer', onBehalf: false };
    const by = finToggle++ % 2 ? 'meera.iyer' : 'kiran.shah';
    return { by, approver: by === 'meera.iyer' ? 'kiran.shah' : 'meera.iyer', onBehalf: true };
  }
  function invNo(po: PoInfo, date: string) {
    const ini = po.vendor.replace(/[^A-Za-z ]/g, '').split(/\s+/).filter((w) => w.length > 2).slice(0, 3).map((w) => w[0]).join('').toUpperCase() || 'INV';
    for (;;) {
      const n = `${ini}/${fyOf(date)}/${String(rand(100, 9800)).padStart(4, '0')}`;
      const key = `${po.vendor_id}|${n.replace(/\W/g, '')}`;
      if (!usedNos.has(key)) { usedNos.add(key); return n; }
    }
  }

  // ---------------------------------------------------------------- building and uploading an invoice
  function recompute(x: Built) {
    const taxable = round2(x.lines.reduce((s, l) => s + Number(l.taxable_value), 0));
    const gst = round2(x.lines.reduce((s, l) => s + Number(l.gst_amount), 0));
    x.header.taxable_value = taxable;
    x.header.gst_amount = gst;
    x.header.total_value = round2(taxable + gst + Number(x.header.freight ?? 0) + Number(x.header.other_charges ?? 0));
  }
  const badGstin = (g: string) => {
    for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') { const t = g.slice(0, 14) + c; if (c !== g[14] && !validateGstin(t).ok) return t; }
    return `${g.slice(0, 13)}XX`;
  };
  const PATCH: Partial<Record<Kind, (x: Built) => void>> = {
    tax: (x) => { const l = x.lines[0]; l.gst_rate = l.gst_rate === 18 ? 12 : 18; l.gst_amount = round2(Number(l.taxable_value) * Number(l.gst_rate) / 100); recompute(x); },
    gstin: (x) => { x.header.vendor_gstin = badGstin(String(x.header.vendor_gstin)); },
    bank: (x) => { const a = String(x.header.bank_account); x.header.bank_account = a.slice(0, -4) + String((Number(a.slice(-4)) + 3721) % 10000).padStart(4, '0'); },
    buyer: (x) => {
      const other = get<{ gstin: string }>('SELECT gstin FROM plants WHERE code != ? AND gstin IS NOT NULL AND gstin != ? ORDER BY code LIMIT 1', x.po.plant, String(x.header.buyer_gstin));
      if (other) x.header.buyer_gstin = other.gstin;
    },
    total: (x) => { x.header.total_value = round2(Number(x.header.total_value) + 850); },
  };

  function build(po: PoInfo, kind: Kind) {
    let spec: Spec[] = po.lines.filter((l) => avail(po, l) > 0).map((l) => ({ item: l.item, qty: avail(po, l) }));
    if (!spec.length && po.lines.every((l) => l.received === 0)) spec = po.lines.map((l) => ({ item: l.item, qty: l.qty })); // nothing received yet: the vendor bills what it shipped
    let freight: number | undefined;
    if (spec.length) {
      const l0 = po.lines.find((l) => l.item === spec[0].item)!;
      if (kind === 'price') spec[0].rate = round2(l0.unit_price * (1.03 + r() * 0.05));
      if (kind === 'excess') spec[0].qty = round2(spec[0].qty + Math.max(1, Math.ceil(l0.qty * 0.2)));
      if (kind === 'freight') freight = [2800, 3600, 4500, 6200][rand(0, 3)];
    }
    return { spec, freight, patch: PATCH[kind] };
  }

  function findNonce(po: PoInfo, no: string, date: string, b: ReturnType<typeof build>, low: boolean) {
    const x = invoiceValues(po.po_no, no, date, b.spec, { freight: b.freight })!;
    b.patch?.(x);
    for (let n = 1 + rand(0, 40); n < 8000; n++) {
      if (usedNonces.has(n)) continue;
      const sha = crypto.createHash('sha256').update(photoPng(n)).digest('hex');
      const rd = simulateOcr({ header: x.header, lines: x.lines }, sha, 'image/png');
      const lowH = HEADER_FIELDS.filter((f) => f.critical && rd.header[f.key].found && rd.header[f.key].confidence < thresholdFor(f.key)).length;
      const lowL = rd.lines.reduce((s, l) => s + LINE_FIELDS.filter((f) => f.critical && l[f.key].found && l[f.key].confidence < thresholdFor(f.key)).length, 0);
      const k = lowH + lowL;
      if (low ? k >= 1 && k <= 2 : k === 0) { usedNonces.add(n); return n; }
    }
    throw new Error('no phone photo found with the wanted read quality');
  }

  function upload(o: { by: string; at: string; po: PoInfo; no: string; date: string; spec: Spec[]; freight?: number; patch?: (x: Built) => void; photoNonce?: number }) {
    const x = invoiceValues(o.po.po_no, o.no, o.date, o.spec, { freight: o.freight });
    if (!x) throw new Error(`PO ${o.po.po_no} not found`);
    o.patch?.(x);
    const actor = actorFor(o.by);
    return S.withClock(o.at, () => {
      const buf = o.photoNonce != null ? photoPng(o.photoNonce) : invoicePdf({ vendor: x.vendor, vendorAddress: x.vendorAddress, header: x.header, lines: x.lines, billTo: x.billTo });
      const name = o.photoNonce != null ? `IMG_${o.no.replace(/\W/g, '')}.png` : `${o.no.replace(/\W/g, '_')}.pdf`;
      const att = storeFile({ originalname: name, buffer: buf, size: buf.length } as Express.Multer.File, actor, { label: 'Invoice (original)' }).id;
      return S.createInvoice(actor, { po_id: x.po.id, attachment_id: att, header: x.header, lines: x.lines });
    });
  }
  const want = (inv: S.InvoiceRow, status: string, why = '') => {
    const cur = S.getInvoice(inv.id)!;
    if (cur.status !== status) throw new Error(`${inv.inv_ref} is ${cur.status}${cur.sub_reason ? ` (${cur.sub_reason})` : ''}, expected ${status}${why ? ` ${why}` : ''}`);
    return cur;
  };
  const openExc = (invId: number) => all<{ id: number; rule: string; reason: string; ex_key: string }>("SELECT id, rule, reason, ex_key FROM invoice_exceptions WHERE invoice_id = ? AND status = 'Open' ORDER BY id", invId);

  // ---------------------------------------------------------------- lifecycle after matching
  /** Payment terms counted from the GRN or the invoice date; a late invoice is never due before it could have been processed. */
  function dueOf(po: PoInfo, invDate: string) {
    const d = addD(po.fromGrn && po.grn ? po.grn : invDate, po.days);
    const floor = addD(invDate, 10);
    return d < floor ? floor : d;
  }
  function payDetails(f: Flow, idx: number, paidDay: string) {
    const inv = S.getInvoice(f.inv.id)!;
    const taxable = inv.taxable_value ?? 0;
    const gross = inv.total_value ?? 0;
    const tdsRate = f.po.service ? 0.02 : [0.001, 0.01, 0.02, 0][idx % 4];
    const tds = tdsRate ? round2(taxable * tdsRate) : undefined;
    const deductions: { label: string; amount: number }[] = [];
    if (idx % 6 === 2) deductions.push({ label: 'Late delivery penalty (PO clause 9)', amount: round2(taxable * 0.02) });
    if (idx % 7 === 3) deductions.push({ label: 'Short-supply set-off', amount: round2(taxable * 0.015) });
    const retention = f.po.service ? round2(taxable * 0.05) : idx % 11 === 4 ? round2(taxable * 0.05) : undefined;
    const adjusted = f.po.contract_id && [7, 8].includes(f.po.contract_id) && paidDay >= DAY(-58) ? round2(gross * (0.1 + (idx % 3) * 0.05)) : undefined;
    const net = round2(gross - (tds ?? 0) - deductions.reduce((s, d) => s + d.amount, 0) - (retention ?? 0) - (adjusted ?? 0));
    return { gross, tds, deductions, retention, adjusted, net };
  }

  /** Approve → park → post → pay/due/block as SAP would report it, with dates relative to the upload day. */
  function finish(f: Flow, to: To, rd: number) {
    if (['matched', 'exception', 'rejected'].includes(to)) return;
    const s = (n: number) => addD(f.upDay, n);
    const ref = f.inv.inv_ref;
    const fin = actorFor(f.up.approver);
    if (to === 'uploaded' || to === 'ocr') {
      run('UPDATE invoices SET status = ?, sub_reason = NULL, match_json = NULL WHERE id = ?', to === 'uploaded' ? 'Uploaded' : 'OCR pending', f.inv.id);
      run("DELETE FROM invoice_events WHERE invoice_id = ? AND status IS NOT 'Uploaded'", f.inv.id);
      return;
    }
    S.withClock(atDate(s(1 + rd), 11), () => S.approveInvoice(fin, f.inv.id, ['FDS rates and GRN quantities verified.', 'Three-way match clean; approved for posting.', null][rand(0, 2)]));
    if (to === 'approved') return;
    S.withClock(atDate(s(1 + rd), 15), () => S.requestParking(fin, f.inv.id));
    const parked = atDate(s(2 + rd), 10);
    const doc = String(sapDoc++);
    sapStatus(parked, ref, { status: 'Parked', sap_doc_no: doc, parked_at: parked });
    let last = parked;
    if (to === 'parked') return finalise(f, last);
    const due = dueOf(f.po, f.invDate);
    const posted = atDate(s(3 + rd), 11);
    sapStatus(posted, ref, { status: 'Posted', posted_at: posted, due_date: due });
    last = posted;
    if (to === 'posted') return finalise(f, last);
    if (to === 'due') {
      let day = addD(due, -5);
      if (day < s(4 + rd)) day = s(4 + rd);
      if (day > DAY(0)) day = DAY(0);
      last = atDate(day, 9);
      sapStatus(last, ref, { status: 'Payment due', due_date: due });
      return finalise(f, last);
    }
    if (to === 'blocked') {
      const b = BLOCKS[(f.po.id + rd) % BLOCKS.length];
      last = atDate(s(5 + rd), 12);
      sapStatus(last, ref, { status: 'Payment blocked', block_reason: b.internal, vendor_reason: b.vendor });
      return finalise(f, last);
    }
    // paid
    let pd = addD(due, rand(-6, 4));
    if (pd < s(6 + rd)) pd = s(6 + rd);
    if (pd > DAY(-1)) pd = DAY(-1);
    const idx = f.po.id;
    const d = payDetails(f, idx, pd);
    const ref2 = String(payRef++);
    last = atDate(pd, 16);
    const v = get<{ bank_name: string; bank_account_masked: string }>('SELECT bank_name, bank_account_masked FROM vendors WHERE id = ?', f.po.vendor_id)!;
    sapStatus(last, ref, {
      status: 'Payment released', paid_at: last, payment_ref: ref2, tds: d.tds, deductions: d.deductions.length ? d.deductions : undefined, retention: d.retention, advance_adjusted: d.adjusted,
      payment_advice: {
        payment_ref: ref2, payment_date: pd, gross: d.gross, tds: d.tds, deductions: d.deductions, retention: d.retention, advance_adjusted: d.adjusted, net_paid: d.net,
        bank: `${v.bank_name} ${v.bank_account_masked}`, sap_doc_no: doc,
      },
    });
    finalise(f, last);
    paidRecs.push(f);
  }
  /** The inbound sync stamps updated_at with the wall clock; keep it at the last SAP event so terminal-status ages are right. */
  function finalise(f: Flow, last: string) { run('UPDATE invoices SET updated_at = ? WHERE id = ?', last, f.inv.id); }

  // ---------------------------------------------------------------- one plan on one PO
  const REASONS: Record<string, string> = {
    '3WM-05': 'Freight deviation accepted by the Procurement Manager for the urgent breakdown delivery.',
    '3WM-01': 'Rate difference accepted: PO rate to be corrected at the next price revision.',
  };
  function createDispute(po: PoInfo) {
    const line = po.lines.find((l) => l.received > 0)!;
    const grn = get<{ id: number }>('SELECT id FROM grns WHERE po_line_id = ? ORDER BY id DESC', line.id);
    const poRow = get<{ delivery_terms: string }>('SELECT delivery_terms FROM pos WHERE id = ?', po.id)!;
    const id = insert('disputes', {
      dsp_no: nextNo('DSP'), po_id: po.id, po_line_id: line.id, grn_id: grn?.id ?? null, type: 'Shortage', qty: 2, value: round2(2 * line.unit_price),
      delivery_term: /ex/i.test(poRow.delivery_terms) ? 'Ex-Works' : 'FOR', owner_party: 'Vendor', owner_user_id: U('amit.kulkarni'), status: 'Assigned',
      description: 'Two units short against the delivery note; stores holds the receipt open until the vendor replaces them.', raised_by: U('suresh.pawar'),
      source: 'Receipt', created_at: D(-9), due_at: D(-2),
    });
    insert('dispute_events', { dispute_id: id, kind: 'raised', body: 'Two units short against the delivery note.', vendor_visible: 1, created_at: D(-9) });
  }

  function exec(p: Plan, po: PoInfo, age: number, forced?: ReturnType<typeof uploaderFor>) {
    const photo = p.kind === 'photo_low' || p.kind === 'photo_ok';
    const up = forced ?? uploaderFor(po, photo);
    const upDay = DAY(-age);
    const invDate = (() => { const d = addD(upDay, -(po.id % 3)); const floor = po.grn ?? po.po_date; return d < floor ? floor : d; })();
    const b = build(po, p.kind);
    if (!b.spec.length) throw new Error(`PO ${po.po_no} has nothing left to bill`);
    const no = invNo(po, invDate);
    const nonce = photo ? findNonce(po, no, invDate, b, p.kind === 'photo_low') : undefined;
    const inv = upload({ by: up.by, at: atDate(upDay, 9 + (po.id % 7), po.id % 50), po, no, date: invDate, spec: b.spec, freight: b.freight, patch: b.patch, photoNonce: nonce });
    want(inv, EXPECT[p.kind]);
    const bill = (sign: 1 | -1) => { for (const s of b.spec) { const l = po.lines.find((x) => x.item === s.item)!; billed.set(l.id, round2((billed.get(l.id) ?? 0) + sign * s.qty)); } };
    bill(1);
    const f: Flow = { inv, po, up, upDay, invDate, spec: b.spec, no };
    const fin = actorFor('meera.iyer');
    let rd = 0;

    if (p.assign) {
      const owner = U(p.assign);
      S.withClock(atDate(addD(upDay, 1), 10), () => { const e = openExc(inv.id).find((x) => x.rule !== 'DUP'); if (e) S.assignException(fin, e.id, owner, 'Please confirm with the vendor and revert.'); });
    }
    if (p.resolve) {
      rd = 2;
      const at = atDate(addD(upDay, 1), 14);
      S.withClock(at, () => {
        const exc = openExc(inv.id);
        if (p.resolve === 'approve-exc') for (const e of exc) S.approveException(fin, e.id, REASONS[e.rule] ?? 'Within authority; difference accepted by finance.');
        else if (p.resolve === 'credit') for (const e of exc) S.resolveException(fin, e.id, 'Credit note received', `CN/${fyOf(invDate)}/${rand(100, 999)}`, 'Vendor issued a credit note for the rate difference.');
        else if (p.resolve === 'correct') S.correctField(fin, inv.id, 'vendor_gstin', get<{ gstin: string }>('SELECT gstin FROM vendors WHERE id = ?', po.vendor_id)!.gstin, 'The GSTIN was misread from the scan; corrected from the invoice image.');
        else if (p.resolve === 'verify') { for (const e of exc) if (e.ex_key.startsWith('OCR_CONF:')) S.verifyField(fin, inv.id, e.ex_key.slice(9)); }
        else if (p.resolve === 'reject') {
          const why = p.kind === 'tax' ? 'The GST rate on item 10 does not match the purchase order. Please send a corrected invoice.' : 'The rate billed is higher than the purchase order rate. Please send a credit note or a revised invoice.';
          S.rejectInvoice(fin, inv.id, why, 'Returned to vendor from the exception queue.');
        }
      });
      if (p.resolve === 'reject') {
        bill(-1);
        want(inv, 'Rejected');
        if (p.resubmit) exec({ ...p, kind: 'clean', to: p.resubmit, resolve: undefined, resubmit: undefined, assign: undefined }, po, age - 3, up);
        return;
      }
      want(inv, 'Matched', 'after resolving its exceptions');
    }
    finish(f, p.to, rd);
  }

  // ---------------------------------------------------------------- pools and planner
  const hist = poRows(EXTRA.poHistoricFrom, EXTRA.poOpenFrom).map(loadPo).filter((p) => p.grn && fully(p) && !hasOpenDispute(p));
  const open = poRows(EXTRA.poOpenFrom, EXTRA.poOpenFrom + 1000).map(loadPo).filter((p) => !hasOpenDispute(p));
  const pools: Record<Pool, PoInfo[]> = {
    hist,
    nogrn: open.filter((p) => p.lines.every((l) => l.received === 0)),
    partial: open.filter((p) => p.lines.some((l) => l.received > 0) && !fully(p)),
    full: open.filter((p) => p.grn && fully(p)),
  };
  const disputed = poRows(EXTRA.poHistoricFrom, EXTRA.poOpenFrom + 1000).map(loadPo).filter((p) => p.grn && fully(p) && hasOpenDispute(p));
  const floorAge = (po: PoInfo) => -offOf(po.grn ?? po.po_date);

  function pick(pool: PoInfo[], [lo, hi]: [number, number], dueOff?: [number, number], plain = false) {
    for (let t = 0; t < 60; t++) {
      const a = lo + Math.floor(r() * (hi - lo + 1)) + (t > 30 ? t - 30 : 0);
      const cands = pool.filter((p) => {
        if (p.used || floorAge(p) < a + 1 || (!p.grn && p.po_date > DAY(-a)) || (plain && p.contract_id)) return false;
        if (!dueOff) return true;
        const o = offOf(dueOf(p, DAY(-a)));
        return o >= dueOff[0] && o <= dueOff[1];
      });
      if (cands.length) { cands.sort((x, y) => floorAge(x) - floorAge(y)); cands[0].used = true; return { po: cands[0], age: a }; }
    }
    return null;
  }

  function scenario(name: string, fn: () => void) {
    const snap = new Map(billed);
    try { tx(fn); } catch (e) {
      billed.clear();
      for (const [k, v] of snap) billed.set(k, v);
      console.warn(`invoices seed_extra: skipped "${name}": ${(e as Error).message}`);
    }
  }

  function runPlan(p: Plan) {
    scenario(p.tag, () => {
      const rd = p.resolve ? 2 : 0;
      const chain = CHAIN[p.resubmit ?? p.to] + rd + (p.resubmit ? 3 : 0);
      const lo = Math.max(p.age[0], chain ? chain + 1 : 0);
      const hi = Math.max(p.age[1], lo);
      let sel: { po: PoInfo; age: number } | null = null;
      if (p.kind === 'dispute') {
        sel = pick(disputed, [lo, hi]);
        if (!sel) {
          sel = pick(hist, [Math.max(lo, 10), Math.max(hi, 10)]);
          if (sel) createDispute(sel.po);
        }
      } else {
        const plain = p.to === 'uploaded' || p.to === 'ocr'; // in-flight reads must not sit on a PO that later syncs re-validate
        sel = pick(pools[p.pool ?? 'hist'], [lo, hi], p.dueOff, plain);
        // Open-PO pools shrink when other seeds touch those POs; anything but a pending receipt can sit on a historic PO instead.
        if (!sel && p.pool && p.kind !== 'pending') sel = pick(hist, [Math.max(lo, 2), Math.max(hi, 4)], undefined, plain);
      }
      if (!sel) throw new Error('no purchase order fits this scenario');
      exec(p, sel.po, sel.age);
    });
  }

  // ---------------------------------------------------------------- the plans
  const plans: Plan[] = [];
  const add = (n: number, p: Omit<Plan, 'variant'>) => { for (let i = 0; i < n; i++) plans.push({ ...p, tag: `${p.tag} #${i + 1}`, variant: i }); };

  // Payment pipeline on the historic POs (constrained first: the due dates must fit the PO's payment terms).
  add(1, { tag: 'posted, overdue', kind: 'clean', to: 'posted', age: [40, 80], dueOff: [-25, -3] });
  add(2, { tag: 'payment due, overdue', kind: 'clean', to: 'due', age: [35, 80], dueOff: [-15, -1] });
  add(2, { tag: 'payment due soon', kind: 'clean', to: 'due', age: [10, 55], dueOff: [0, 9] });
  add(2, { tag: 'posted, due later', kind: 'clean', to: 'posted', age: [8, 45], dueOff: [3, 25] });
  add(3, { tag: 'payment blocked', kind: 'clean', to: 'blocked', age: [12, 50] });
  add(2, { tag: 'parked', kind: 'clean', to: 'parked', age: [4, 14] });
  add(1, { tag: 'approved, awaiting parking', kind: 'clean', to: 'approved', age: [2, 8] });
  add(3, { tag: 'matched, awaiting approval', kind: 'clean', to: 'matched', age: [1, 6] });
  add(1, { tag: 'rejected (tax)', kind: 'tax', to: 'rejected', age: [12, 22], resolve: 'reject' });
  add(1, { tag: 'rejected and resubmitted', kind: 'price', to: 'rejected', age: [16, 26], resolve: 'reject', resubmit: 'posted' });
  // Open exceptions, ageing across all buckets.
  add(1, { tag: 'exception: price variance', kind: 'price', to: 'exception', age: [22, 28], assign: 'sneha.patil' });
  add(1, { tag: 'exception: freight', kind: 'freight', to: 'exception', age: [16, 19], assign: 'amit.kulkarni' });
  add(1, { tag: 'exception: total mismatch', kind: 'total', to: 'exception', age: [18, 21] });
  add(1, { tag: 'exception: buyer GSTIN', kind: 'buyer', to: 'exception', age: [12, 15], assign: 'kiran.shah' });
  add(1, { tag: 'exception: low OCR confidence', kind: 'photo_low', to: 'exception', age: [8, 10] });
  add(1, { tag: 'exception: dispute hold', kind: 'dispute', to: 'exception', age: [5, 7] });
  add(1, { tag: 'exception: tax mismatch', kind: 'tax', to: 'exception', age: [3, 5] });
  add(1, { tag: 'uploaded', kind: 'clean', to: 'uploaded', age: [1, 1] });
  add(1, { tag: 'OCR pending', kind: 'clean', to: 'ocr', age: [1, 1] });
  // Open POs: pending receipts, partial receipts, charges on closed POs.
  add(2, { tag: 'pending GRN', kind: 'pending', to: 'exception', pool: 'nogrn', age: [0, 2] });
  add(1, { tag: 'exception: GSTIN invalid', kind: 'gstin', to: 'exception', pool: 'nogrn', age: [1, 2] });
  add(1, { tag: 'exception: bank mismatch', kind: 'bank', to: 'exception', pool: 'nogrn', age: [2, 3] });
  add(1, { tag: 'exception: excess billing', kind: 'excess', to: 'exception', pool: 'partial', age: [0, 2], assign: 'amit.kulkarni' });
  add(1, { tag: 'matched on partial receipt', kind: 'clean', to: 'matched', pool: 'partial', age: [0, 2] });
  add(1, { tag: 'closed PO, matched', kind: 'clean', to: 'matched', pool: 'full', age: [0, 1] });
  add(1, { tag: 'closed PO, freight', kind: 'freight', to: 'exception', pool: 'full', age: [0, 1], assign: 'amit.kulkarni' });
  // Paid history across the year (some via exception approval, credit note, OCR correction, photo verification).
  const paidVariants: Pick<Plan, 'kind' | 'resolve'>[] = [];
  for (let i = 0; i < 22; i++) paidVariants.push(i === 3 ? { kind: 'freight', resolve: 'approve-exc' } : i === 6 ? { kind: 'price', resolve: 'credit' } : i === 9 ? { kind: 'gstin', resolve: 'correct' } : i === 12 ? { kind: 'photo_low', resolve: 'verify' } : { kind: 'clean' });
  paidVariants.forEach((v, i) => plans.push({ tag: `paid #${i + 1}`, to: 'paid', age: [10 + i * 14, 23 + i * 14], ...v, variant: i }));

  for (const p of plans) runPlan(p);

  // ---------------------------------------------------------------- duplicates of paid invoices (open and rejected)
  [{ tag: 'duplicate, open', age: 4, reject: false }, { tag: 'duplicate, rejected', age: 9, reject: true }].forEach((d, i) => {
    scenario(d.tag, () => {
      const rec = paidRecs.filter((x) => !x.up.onBehalf && x.po.vendorUser)[i * 3] ?? paidRecs[i * 3];
      if (!rec) throw new Error('no paid invoice to duplicate');
      const orig = S.getInvoice(rec.inv.id)!;
      const dupNo = rec.no.replace(/\//g, ' ').toLowerCase();
      const upDay = DAY(-d.age);
      const inv = upload({ by: rec.up.by, at: atDate(upDay, 11), po: rec.po, no: dupNo, date: rec.invDate, spec: rec.spec });
      want(inv, 'Exception', `(duplicate of ${orig.inv_ref})`);
      if (!openExc(inv.id).some((e) => e.rule === 'DUP')) throw new Error('duplicate not detected');
      if (d.reject) S.withClock(atDate(addD(upDay, 1), 10), () => S.rejectInvoice(actorFor('meera.iyer'), inv.id, `This is a duplicate of invoice ${orig.vendor_invoice_no}, which is already paid. It will not be processed twice.`, 'Duplicate submission; original already paid.'));
    });
  });

  // ---------------------------------------------------------------- FDS price checks (three small SAP POs under the Kranti FDS agreement)
  scenario('FDS price checks', () => {
    const k = get<{ id: number; invoice_validation: number }>("SELECT id, invoice_validation FROM contracts WHERE sap_oa_no = '5500000103' AND type = 'FDS'");
    if (!k) throw new Error('FDS agreement 5500000103 not found');
    if (!k.invoice_validation) run('UPDATE contracts SET invoice_validation = 1 WHERE id = ?', k.id);
    const cases: { no: string; grn: string; age: number; mode: string; to: To; items: [string, number][] }[] = [
      { no: '4500032001', grn: '5000159001', age: 40, mode: 'pass', to: 'paid', items: [['TLS-7002', 4], ['PPE-8001', 60]] },
      { no: '4500032002', grn: '5000159002', age: 6, mode: 'variance', to: 'exception', items: [['TLS-7001', 1], ['PPE-8001', 40]] },
      { no: '4500032003', grn: '5000159003', age: 2, mode: 'pass', to: 'matched', items: [['TLS-7002', 2], ['PPE-8001', 120]] },
    ];
    for (const c of cases) {
      const poDate = DAY(-c.age - 14);
      const mats = c.items.map(([code]) => get<{ code: string; description: string; uom: string; gst_rate: number }>('SELECT code, description, uom, gst_rate FROM materials WHERE code = ?', code)!);
      const items = c.items.map(([code, qty], i) => {
        const e = expectedFdsPrice(k.id, M(code), poDate);
        if (!e) throw new Error(`no FDS price list entry for ${code}`);
        return { item: (i + 1) * 10, pr_no: null, pr_item: null, material_code: code, description: mats[i].description, qty, uom: mats[i].uom, unit_price: c.mode === 'variance' ? e.list_price : e.expected_price, gst_rate: mats[i].gst_rate, delivery_date: addD(poDate, 7) };
      });
      sapPut('PO', c.no, { po_no: c.no, vendor_sap_code: '100108', buyer_email: 'sneha.patil@equipcare.test', plant: 'PUN1', po_date: poDate, released: true, version: 1, delivery_terms: 'FOR destination', payment_terms: '30 days', freight_terms: 'Freight paid', oa_no: '5500000103', urgency: 'General stock', rfq_date: null, items }, 'Seed');
      syncEvent('PO');
      sapPut('GRN', `${c.grn}-2026`, { grn_no: c.grn, year: '2026', po_no: c.no, posting_date: addD(poDate, 8), plant: 'PUN1', is_service: false, items: items.map((it) => ({ po_item: it.item, qty: it.qty, value: Math.round(it.qty * it.unit_price) })) }, 'Seed');
      syncEvent('GRN');
      const row = get<any>('SELECT id, po_no, vendor_id, plant, po_date, payment_terms, contract_id FROM pos WHERE po_no = ?', c.no);
      if (!row) throw new Error(`PO ${c.no} did not sync`);
      const po = loadPo(row);
      exec({ tag: `FDS ${c.mode}`, kind: c.mode === 'variance' ? 'fds' : 'clean', to: c.to, age: [c.age, c.age] }, po, c.age);
      if (c.mode === 'variance' && !openExc(S.getInvoice(get<{ id: number }>('SELECT MAX(id) AS id FROM invoices')!.id)!.id).some((e) => e.rule === 'FDS')) throw new Error('FDS price variance not flagged');
    }
  });
}
