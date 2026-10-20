/**
 * Module 10 demo scenarios. SAP-side statuses are simulated with sapPut('INVSTATUS', …) + syncEvent,
 * exactly as the SAP simulator would; the platform only receives them through the INT-M12 sync.
 */
import crypto from 'node:crypto';
import { all, get, insert, run, tx, round2 } from '../../core/db.ts';
import { sapPut, syncEvent } from '../../core/sap.ts';
import { storeFile } from '../../core/files.ts';
import { nextNo } from '../../core/numbering.ts';
import { actorFor, D, DAY } from '../../seed/ctx.ts';
import type { Actor } from '../../core/auth.ts';
import { invoicePdf, photoPng } from './docs.ts';
import { simulateOcr, thresholdFor, HEADER_FIELDS, LINE_FIELDS } from './ocr.ts';
import * as S from './service.ts';
import { DEMO_EXTRA } from '../../core/mode.ts';
import { seedExtra } from './seed_extra.ts';

type Spec = { item: number; qty: number; rate?: number };

/** Build entered invoice values from the PO and masters (what the vendor's invoice says). */
export function invoiceValues(poNo: string, invoiceNo: string, date: string, spec: Spec[], extra: { freight?: number; other?: number } = {}) {
  const po = get<{ id: number; vendor_id: number; plant: string; payment_terms: string | null }>('SELECT id, vendor_id, plant, payment_terms FROM pos WHERE po_no = ?', poNo);
  if (!po) return null;
  const v = get<{ name: string; gstin: string; bank_account_masked: string; bank_ifsc: string; address: string | null }>('SELECT name, gstin, bank_account_masked, bank_ifsc, address FROM vendors WHERE id = ?', po.vendor_id)!;
  const plant = get<{ name: string; gstin: string; ship_to_address: string }>('SELECT name, gstin, ship_to_address FROM plants WHERE code = ?', po.plant)!;
  const lines = spec.map((s) => {
    const l = S.poLinesOf(po.id).find((x) => x.item === s.item)!;
    const rate = s.rate ?? l.unit_price;
    const taxable = round2(s.qty * rate);
    return { po_item: s.item, material_code: l.material_code, description: l.description, hsn: l.hsn, qty: s.qty, rate, taxable_value: taxable, gst_rate: l.gst_rate, gst_amount: round2((taxable * l.gst_rate) / 100) };
  });
  const taxable = round2(lines.reduce((s, l) => s + l.taxable_value, 0));
  const gst = round2(lines.reduce((s, l) => s + l.gst_amount, 0));
  const header = {
    invoice_no: invoiceNo, invoice_date: date, vendor_gstin: v.gstin, buyer_gstin: plant.gstin, po_no: poNo, payment_terms: po.payment_terms,
    eway_bill: `${3100 + po.id}${String(po.id * 7919).padStart(8, '0')}`.slice(0, 12), bank_account: `5020009${String(po.vendor_id).padStart(3, '0')}${(v.bank_account_masked ?? '').slice(-4)}`,
    bank_ifsc: v.bank_ifsc, taxable_value: taxable, gst_amount: gst, freight: extra.freight ?? 0, other_charges: extra.other ?? 0,
    total_value: round2(taxable + gst + (extra.freight ?? 0) + (extra.other ?? 0)),
  };
  return { po, header, lines, vendor: v.name, vendorAddress: v.address ?? '', billTo: `Knowteq Equipcare LLP — ${plant.name}, ${plant.ship_to_address}` };
}

function fileFor(actor: Actor, name: string, buf: Buffer) {
  return storeFile({ originalname: name, buffer: buf, size: buf.length } as Express.Multer.File, actor, { label: 'Invoice (original)' }).id;
}

function upload(by: string, at: string, poNo: string, invoiceNo: string, date: string, spec: Spec[], extra: { freight?: number; other?: number; photoNonce?: number } = {}) {
  const x = invoiceValues(poNo, invoiceNo, date, spec, extra);
  if (!x) return null;
  const actor = actorFor(by);
  return S.withClock(at, () => {
    const buf = extra.photoNonce != null ? photoPng(extra.photoNonce) : invoicePdf({ vendor: x.vendor, vendorAddress: x.vendorAddress, header: x.header, lines: x.lines, billTo: x.billTo });
    const att = fileFor(actor, extra.photoNonce != null ? `IMG_${invoiceNo.replace(/\W/g, '')}.png` : `${invoiceNo.replace(/\W/g, '_')}.pdf`, buf);
    return S.createInvoice(actor, { po_id: x.po.id, attachment_id: att, header: x.header, lines: x.lines });
  });
}

/** The inbound sync reads documents changed after its watermark; make sure each simulated SAP update has a later millisecond. */
export function tick() {
  const t = Date.now();
  while (Date.now() === t) { /* wait for the next millisecond */ }
}

function sapStatus(at: string, ref: string, payload: Record<string, unknown>) {
  tick();
  const prev = (get<{ payload: Record<string, unknown> }>("SELECT payload_json FROM sap_documents WHERE doc_type = 'INVSTATUS' AND doc_key = ?", ref)?.payload) ?? {};
  S.withClock(at, () => {
    sapPut('INVSTATUS', ref, { ...prev, ...payload }, 'Seed');
    syncEvent('INVSTATUS');
  });
}

/** Use the dispute module's dispute when it seeded one; otherwise record a minimal receipt dispute so the hold scenario exists. */
function ensureDispute(poNo: string, item: number, type: string, qty: number, party: string, ownerLocal: string, raisedBy: string, days: number, description: string) {
  const line = get<{ id: number; po_id: number; unit_price: number }>('SELECT l.id, l.po_id, l.unit_price FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE p.po_no = ? AND l.item = ?', poNo, item);
  if (!line) return null;
  const ex = get<{ id: number }>("SELECT id FROM disputes WHERE po_line_id = ? AND status NOT IN ('Resolved','Closed')", line.id);
  if (ex) return ex.id;
  const po = get<{ delivery_terms: string }>('SELECT delivery_terms FROM pos WHERE id = ?', line.po_id)!;
  const grn = get<{ id: number }>('SELECT id FROM grns WHERE po_line_id = ? ORDER BY id DESC', line.id);
  const id = insert('disputes', {
    dsp_no: nextNo('DSP'), po_id: line.po_id, po_line_id: line.id, grn_id: grn?.id ?? null, type, qty, value: round2(qty * line.unit_price),
    delivery_term: /ex/i.test(po.delivery_terms) ? 'Ex-Works' : 'FOR', owner_party: party, owner_user_id: get<{ id: number }>('SELECT id FROM users WHERE email LIKE ?', `${ownerLocal}@%`)?.id ?? null,
    status: 'Assigned', description, raised_by: get<{ id: number }>('SELECT id FROM users WHERE email LIKE ?', `${raisedBy}@%`)?.id ?? null, source: 'Receipt', created_at: D(days), due_at: D(days + 7),
  });
  insert('dispute_events', { dispute_id: id, kind: 'raised', body: description, vendor_visible: 1, created_at: D(days) });
  return id;
}

/** Choose a phone photo whose simulated read leaves only the vendor GSTIN below threshold. */
function photoNonceFor(poNo: string, invoiceNo: string, date: string, spec: Spec[]) {
  const x = invoiceValues(poNo, invoiceNo, date, spec)!;
  for (let n = 1; n < 400; n++) {
    const buf = photoPng(n);
    const sha = awaitSha(buf);
    const r = simulateOcr({ header: x.header, lines: x.lines }, sha, 'image/png');
    const lowHeader = HEADER_FIELDS.filter((f) => f.critical && r.header[f.key].found && r.header[f.key].confidence < thresholdFor(f.key)).map((f) => f.key);
    const lowLines = r.lines.some((l) => LINE_FIELDS.some((f) => f.critical && l[f.key].found && l[f.key].confidence < thresholdFor(f.key)));
    if (lowHeader.length === 1 && lowHeader[0] === 'vendor_gstin' && !lowLines) return n;
  }
  return 1;
}
const awaitSha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

function scenario(name: string, fn: () => void) {
  try {
    tx(fn);
  } catch (e) {
    console.warn(`[invoices seed] skipped "${name}": ${(e as Error).message}`);
  }
}

export function seedInvoices() {
  const meera = actorFor('meera.iyer');

  // Kranti 4500021007 — FDS price check passes, approved, posted and payment released with TDS and advice.
  scenario('Kranti paid', () => {
    const fds = get<{ id: number; invoice_validation: number }>("SELECT id, invoice_validation FROM contracts WHERE sap_oa_no = '5500000103'");
    if (fds && !fds.invoice_validation) run('UPDATE contracts SET invoice_validation = 1 WHERE id = ?', fds.id); // CON-05 flag (platform field)
    const inv = upload('nitin', D(-10), '4500021007', 'KIT/26-27/0318', DAY(-11), [{ item: 10, qty: 2 }, { item: 20, qty: 100 }]);
    if (!inv) return;
    S.withClock(D(-9), () => S.approveInvoice(meera, inv.id, 'FDS rates verified against price list.'));
    S.withClock(D(-9, 12), () => S.requestParking(meera, inv.id));
    sapStatus(D(-8), inv.inv_ref, { status: 'Parked', sap_doc_no: '5105600101', parked_at: D(-8) });
    sapStatus(D(-7), inv.inv_ref, { status: 'Posted', posted_at: D(-7), due_date: DAY(19) });
    const tds = round2((inv.taxable_value ?? 0) * 0.001);
    const gross = inv.total_value ?? 0;
    sapStatus(D(-2), inv.inv_ref, {
      status: 'Payment released', paid_at: D(-2), payment_ref: '1500003921', tds, deductions: [],
      payment_advice: { payment_ref: '1500003921', payment_date: DAY(-2), gross, tds, deductions: [], net_paid: round2(gross - tds), bank: 'Axis Bank XXXXXX1086', sap_doc_no: '5105600101' },
    });
  });

  // Apex 4500021009 — uploaded by finance on the vendor's behalf; paid (SAP gave no TDS → hidden, AC-PAY-05).
  scenario('Apex paid', () => {
    // The disputes seed may have an open dispute on this PO that was raised after the invoice was paid: hide it while the history is built.
    const open = all<{ id: number; status: string }>("SELECT d.id, d.status FROM disputes d JOIN pos p ON p.id = d.po_id WHERE p.po_no = '4500021009' AND d.status NOT IN ('Resolved','Closed')");
    for (const d of open) run("UPDATE disputes SET status = 'Closed' WHERE id = ?", d.id);
    const inv = upload('kiran.shah', D(-24), '4500021009', 'AWC/1187', DAY(-25), [{ item: 10, qty: 40 }]);
    if (!inv) return;
    S.withClock(D(-23), () => S.approveInvoice(meera, inv.id, null));
    S.withClock(D(-23, 12), () => S.requestParking(meera, inv.id));
    sapStatus(D(-22), inv.inv_ref, { status: 'Posted', sap_doc_no: '5105600088', posted_at: D(-22), due_date: DAY(-5) });
    const gross = inv.total_value ?? 0;
    sapStatus(D(-5), inv.inv_ref, { status: 'Payment released', paid_at: D(-5), payment_ref: '1500003804', payment_advice: { payment_ref: '1500003804', payment_date: DAY(-5), gross, deductions: [], net_paid: gross, bank: 'ICICI Bank', sap_doc_no: '5105600088' } });
    for (const d of open) run('UPDATE disputes SET status = ? WHERE id = ?', d.status, d.id);
  });

  // Western Lubricants 4500021003 — bills 10 drums, GRN 6 (excess billing) + dispute hold on the damaged drums.
  scenario('Western Lubricants exception', () => {
    ensureDispute('4500021003', 10, 'Transit damage', 4, 'Logistics', 'sneha.patil', 'suresh.pawar', -4, '4 of 10 drums arrived punctured; 6 accepted on GRN 5000100201.');
    upload('sanjay', D(-3), '4500021003', 'WLD/0921', DAY(-5), [{ item: 10, qty: 10 }], { freight: 6500 });
  });

  // Hydrotech 4500021001 — dispute hold on line 20 (shortage); later duplicate "inv 0457" vs "INV-457".
  scenario('Hydrotech hold + duplicate', () => {
    ensureDispute('4500021001', 20, 'Shortage', 4, 'Vendor', 'amit.kulkarni', 'suresh.pawar', -1, 'Received 20 of 24 hose assemblies on GRN 5000100205.');
    upload('manoj.kale', D(-1, 9), '4500021001', 'INV-457', DAY(-2), [{ item: 10, qty: 6 }, { item: 20, qty: 20 }]);
    upload('manoj.kale', D(0, 9), '4500021001', 'inv 0457', DAY(-2), [{ item: 10, qty: 6 }, { item: 20, qty: 20 }]);
  });

  // Precision 4500021006 — Matched, waiting for finance approval.
  scenario('Precision matched', () => {
    upload('pooja.malhotra', D(-1, 11), '4500021006', 'PFI/2026/3345', DAY(-2), [{ item: 10, qty: 80 }]);
  });

  // Jharkhand 4500021008 — service PO: SES posted in SAP, phone photo uploaded by finance, vendor GSTIN read with low confidence.
  scenario('Jharkhand SES low confidence', () => {
    const po = get<{ id: number }>("SELECT id FROM pos WHERE po_no = '4500021008'");
    if (!po) return;
    if (!get('SELECT id FROM grns WHERE po_id = ? AND is_service = 1', po.id)) {
      sapPut('GRN', '5000109001-2026', { grn_no: '5000109001', year: '2026', po_no: '4500021008', posting_date: DAY(-1), plant: 'DHN1', is_service: true, items: [{ po_item: 10, qty: 1, value: 125000 }] }, 'Seed');
      syncEvent('GRN');
    }
    const spec = [{ item: 10, qty: 1 }];
    upload('kiran.shah', D(0, 8), '4500021008', 'JMSR/SR/2611', DAY(-1), spec, { photoNonce: photoNonceFor('4500021008', 'JMSR/SR/2611', DAY(-1), spec) });
  });

  if (DEMO_EXTRA) seedExtra();
}
