import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, PDF, type Client } from './helpers.ts';

let t: Awaited<ReturnType<typeof startApp>>;
let seedLib: typeof import('../modules/invoices/seed.ts');
let sap: typeof import('../core/sap.ts');
let config: typeof import('../core/config.ts');
let india: typeof import('../core/india.ts');
let n = 0;
const clients = new Map<string, Promise<Client>>();
const who = (local: string) => { if (!clients.has(local)) clients.set(local, t.login(local)); return clients.get(local)!; };

beforeAll(async () => {
  t = await startApp();
  seedLib = await import('../modules/invoices/seed.ts');
  sap = await import('../core/sap.ts');
  config = await import('../core/config.ts');
  india = await import('../core/india.ts');
  // Core rate-limits sign-ins and uploads on one shared counter; sign every persona in before the uploads start.
  for (const p of ['meera.iyer', 'kiran.shah', 'amit.kulkarni', 'vikram.joshi', 'anjali.verma', 'neha.gupta', 'imran', 'manoj.kale', 'pooja.malhotra', 'divya.raman', 'nitin', 'sanjay']) await who(p);
});
afterAll(async () => { await t.close(); });

const invId = (ref: string) => t.db.get<{ id: number }>('SELECT id FROM invoices WHERE inv_ref = ?', ref)!.id;
const byNo = (no: string) => t.db.get<{ id: number; inv_ref: string }>('SELECT id, inv_ref FROM invoices WHERE vendor_invoice_no = ?', no)!;
const poId = (no: string) => t.db.get<{ id: number }>('SELECT id FROM pos WHERE po_no = ?', no)!.id;
const uniqPdf = () => Buffer.concat([PDF, Buffer.from(`% ${++n} ${Math.random()}\n`)]);

type Over = { header?: Record<string, unknown>; lines?: Record<string, unknown>[] };
/** Upload a PDF and create an invoice from PO-derived values (what the vendor's invoice says), with overrides. */
async function submit(c: Client, poNo: string, no: string, spec: { item: number; qty: number; rate?: number }[], over: Over = {}, extra: { freight?: number } = {}) {
  const x = seedLib.invoiceValues(poNo, no, '2026-10-10', spec, extra)!;
  const f = await c.upload('/api/files', [{ name: `${no.replace(/\W/g, '_')}.pdf`, content: uniqPdf(), type: 'application/pdf' }], { label: 'Invoice' });
  expect(f.status).toBe(200);
  const lines = x.lines.map((l, i) => ({ ...l, ...(over.lines?.[i] ?? {}) }));
  const r = await c.post('/api/invoices', { po_id: x.po.id, attachment_id: f.body.files[0].id, header: { ...x.header, ...(over.header ?? {}) }, lines });
  return r;
}
const detail = async (c: Client, id: number) => (await c.get(`/api/invoices/${id}`)).body;
const reasons = (d: any) => d.exceptions.filter((e: any) => e.status === 'Open').map((e: any) => e.reason);

describe('Module 10 — invoice upload, simulated OCR, validation, 3-way match', () => {
  it('AC-INV-01: a vendor uploads a PDF against a PO; it links vendor + PO and stores the file', async () => {
    const imran = await who('imran');
    const r = await submit(imran, '4500021004', 'DRW/26/0001', [{ item: 10, qty: 1 }]);
    expect(r.status).toBe(200);
    const fin = await who('meera.iyer');
    const d = await detail(fin, r.body.id);
    expect(d.vendor.sap_code).toBe('100106');
    expect(d.po.po_no).toBe('4500021004');
    expect(d.attachment.filename).toMatch(/pdf$/);
    expect(d.on_behalf).toBe(0);
    const dl = await fin.get(`/api/files/${d.attachment.id}/download`);
    expect(dl.status).toBe(200);
    // vendor cannot upload against another vendor's PO (isolation)
    const manoj = await who('manoj.kale');
    const bad = await submit(manoj, '4500021004', 'X/1', [{ item: 10, qty: 1 }]);
    expect(bad.status).toBe(404);
  });

  it('AC-INV-02: every OCR-02 field is populated or "not found" with confidence; accuracy is reported (KPI-10)', async () => {
    const imran = await who('imran');
    const r = await submit(imran, '4500021004', 'DRW/26/0002', [{ item: 10, qty: 1 }], { header: { eway_bill: '' } });
    const d = await detail(await who('meera.iyer'), r.body.id);
    expect(d.extracted.simulated).toBe(true);
    expect(d.ocr_note).toMatch(/Simulated OCR/);
    for (const f of d.header_fields) {
      const x = d.extracted.header[f.key];
      expect(x).toBeTruthy();
      expect(typeof x.found).toBe('boolean');
      expect(x.confidence).toBeGreaterThanOrEqual(0);
    }
    expect(d.extracted.header.eway_bill.found).toBe(false);
    expect(d.extracted.lines[0].hsn.found).toBe(true);
    expect(d.accuracy.extracted).toBeGreaterThan(10);
    expect(d.accuracy.accuracy).toBe(1);
    // deterministic: same inputs give same confidence
    const again = (await import('../modules/invoices/ocr.ts')).confidenceFor('abc', 'vendor_gstin', 'vendor_gstin', 'X', 'pdf');
    expect(again).toBe((await import('../modules/invoices/ocr.ts')).confidenceFor('abc', 'vendor_gstin', 'vendor_gstin', 'X', 'pdf'));
  });

  it('AC-INV-03: "INV-001" then "inv 001" for the same vendor is a duplicate; matching is blocked', async () => {
    expect(india.normalizeInvoiceNo('INV-001')).toBe(india.normalizeInvoiceNo('inv 001'));
    const pooja = await who('pooja.malhotra');
    const r = await submit(pooja, '4500021006', 'pfi 2026 3345', [{ item: 10, qty: 80 }]); // seeded PFI/2026/3345
    const d = await detail(await who('meera.iyer'), r.body.id);
    expect(d.status).toBe('Exception');
    expect(d.sub_reason).toBe('Duplicate invoice');
    expect(reasons(d)).toContain('Duplicate invoice');
    expect(d.duplicate.vendor_invoice_no).toBe('PFI/2026/3345');
    expect(d.match.results.find((x: any) => x.rule === '3WM-01').status).toBe('skipped');
    const fin = await who('meera.iyer');
    const dupEx = d.exceptions.find((e: any) => e.rule === 'DUP');
    expect((await fin.post(`/api/invoices/exceptions/${dupEx.id}/approve`, { reason: 'Trying to approve a duplicate anyway' })).status).toBe(409);
    expect((await fin.post(`/api/invoices/${d.id}/approve`, {})).status).toBe(409);
    // seeded scenario: Hydrotech "inv 0457" vs "INV-457"
    const seeded = await detail(fin, byNo('INV 0457').id);
    expect(seeded.sub_reason).toBe('Duplicate invoice');
  });

  it('AC-INV-04: a bad GSTIN check digit raises "GSTIN invalid"', async () => {
    const imran = await who('imran');
    const good = t.db.get<{ gstin: string }>("SELECT gstin FROM vendors WHERE sap_code = '100106'")!.gstin;
    const bad = good.slice(0, 14) + (good[14] === 'A' ? 'B' : 'A');
    const r = await submit(imran, '4500021004', 'DRW/26/0004', [{ item: 10, qty: 1 }], { header: { vendor_gstin: bad } });
    const d = await detail(await who('meera.iyer'), r.body.id);
    expect(d.status).toBe('Exception');
    expect(reasons(d)).toContain('GSTIN invalid');
  });

  it('AC-INV-05: a correction records old, new, user, time and reason in the audit; validation re-runs', async () => {
    const imran = await who('imran');
    const good = t.db.get<{ gstin: string }>("SELECT gstin FROM vendors WHERE sap_code = '100106'")!.gstin;
    const bad = good.slice(0, 14) + (good[14] === 'A' ? 'B' : 'A');
    const r = await submit(imran, '4500021004', 'DRW/26/0005', [{ item: 10, qty: 1 }], { header: { vendor_gstin: bad } });
    const fin = await who('meera.iyer');
    expect((await fin.post(`/api/invoices/${r.body.id}/correct`, { field: 'vendor_gstin', value: good, reason: 'short' })).status).toBe(400);
    const c = await fin.post(`/api/invoices/${r.body.id}/correct`, { field: 'vendor_gstin', value: good, reason: 'GSTIN misread; checked against the PDF.' });
    expect(c.status).toBe(200);
    const d = await detail(fin, r.body.id);
    expect(d.corrections[0]).toMatchObject({ field: 'vendor_gstin', old_value: bad, new_value: good, user_name: 'Meera Iyer' });
    expect(d.corrections[0].created_at).toBeTruthy();
    expect(reasons(d)).not.toContain('GSTIN invalid');
    expect(d.accuracy.corrected).toBe(1);
    expect(d.accuracy.accuracy).toBeLessThan(1);
    const audit = t.db.all<{ before: any; after: any; reason: string; actor_name: string }>("SELECT before_json, after_json, reason, actor_name FROM audit_events WHERE action = 'invoice.field_corrected' AND object_id = ?", String(r.body.id));
    expect(audit[0]).toMatchObject({ reason: 'GSTIN misread; checked against the PDF.', actor_name: 'Meera Iyer' });
    expect(audit[0].before.vendor_gstin).toBe(bad);
    expect(audit[0].after.vendor_gstin).toBe(good);
    // buyers and vendors cannot correct
    expect((await (await who('amit.kulkarni')).post(`/api/invoices/${r.body.id}/correct`, { field: 'freight', value: 1, reason: 'Buyer trying to edit' })).status).toBe(403);
    expect((await imran.post(`/api/invoices/${r.body.id}/correct`, { field: 'freight', value: 1, reason: 'Vendor trying to edit' })).status).toBe(403);
  });

  it('AC-INV-06 + AC-INV-14: rate 2% above PO with a 1% tolerance is a price variance; tolerance changes stay pending until finance and procurement approve', async () => {
    // zero tolerance until approved (DEC-07)
    expect(config.cfg<any>('tolerance.3wm').price_pct).toBe(0);
    const admin = await who('anjali.verma');
    const put = await admin.put('/api/config/tolerance.3wm', { value: { price_pct: 1, price_abs: 0, qty_pct: 0, tax_abs: 0, freight_abs: 0, total_abs: 0 }, reason: 'Proposed 1% price tolerance for the pilot' });
    expect(put.status).toBe(200);
    expect(put.body.status).toBe('Pending approval');
    expect(config.cfg<any>('tolerance.3wm').price_pct).toBe(0); // AC-INV-14: still pending
    const ap = t.db.get<{ id: number }>("SELECT id FROM approvals WHERE type = 'config.tolerance' AND status = 'Pending'")!;
    expect((await (await who('vikram.joshi')).post(`/api/approvals/${ap.id}/approve`, { comment: 'Procurement agrees' })).status).toBe(200);
    expect(config.cfg<any>('tolerance.3wm').price_pct).toBe(0); // finance still has to approve
    expect((await (await who('meera.iyer')).post(`/api/approvals/${ap.id}/approve`, { comment: 'Finance agrees' })).status).toBe(200);
    expect(config.cfg<any>('tolerance.3wm').price_pct).toBe(1);

    const divya = await who('divya.raman');
    const fin = await who('meera.iyer');
    const over = await submit(divya, '4500021002', 'SUC/0101', [{ item: 10, qty: 80, rate: 7752 }]); // +2.0%
    expect(reasons(await detail(fin, over.body.id))).toContain('Price variance');
    const within = await submit(divya, '4500021002', 'SUC/0102', [{ item: 20, qty: 1, rate: 38190 }]); // +0.5%
    expect(reasons(await detail(fin, within.body.id))).not.toContain('Price variance');
    config.applyConfig('tolerance.3wm', { price_pct: 0, price_abs: 0, qty_pct: 0, tax_abs: 0, freight_abs: 0, total_abs: 0 }, 1, 'Test reset');
  });

  it('AC-INV-07: invoice qty above the GRN is "excess billing" (seeded: 10 billed, GRN 6)', async () => {
    const fin = await who('meera.iyer');
    const d = await detail(fin, byNo('WLD/0921').id);
    expect(reasons(d)).toContain('Excess billing');
    const ex = d.exceptions.find((e: any) => e.reason === 'Excess billing');
    expect(ex).toMatchObject({ rule: '3WM-02', owner_role: 'BUY' });
    expect(ex.expected).toContain('6');
    expect(ex.actual).toContain('10');
    // generic 80 / 100 case on a fresh PO
    sap.sapPut('PO', '4500029902', { po_no: '4500029902', vendor_sap_code: '100106', buyer_email: 'amit.kulkarni@equipcare.test', plant: 'PUN1', po_date: '2026-10-01', released: true, version: 1, delivery_terms: 'FOR destination', payment_terms: '45 days from GRN', freight_terms: 'Freight paid', items: [{ item: 10, material_code: 'HYD-1005', description: 'O-ring kit', qty: 100, uom: 'SET', unit_price: 2650, gst_rate: 18, delivery_date: '2026-10-20' }] });
    sap.syncEvent('PO');
    sap.sapPut('GRN', '5000109902-2026', { grn_no: '5000109902', year: '2026', po_no: '4500029902', posting_date: '2026-10-05', plant: 'PUN1', items: [{ po_item: 10, qty: 80, value: 212000 }] });
    sap.syncEvent('GRN');
    const r = await submit(await who('imran'), '4500029902', 'DRW/26/0902', [{ item: 10, qty: 100 }]);
    const d2 = await detail(fin, r.body.id);
    expect(reasons(d2)).toContain('Excess billing');
    expect(d2.exceptions.find((e: any) => e.reason === 'Excess billing').owner_role).toBe('BUY');
  });

  it('AC-INV-08: freight that is not in the PO terms is put on hold', async () => {
    const r = await submit(await who('pooja.malhotra'), '4500021006', 'PFI/2026/8888', [{ item: 10, qty: 1 }], {}, { freight: 4500 });
    const d = await detail(await who('meera.iyer'), r.body.id);
    const ex = d.exceptions.find((e: any) => e.rule === '3WM-05');
    expect(ex).toBeTruthy();
    expect(ex.reason).toBe('Unapproved freight');
    expect(ex.owner_role).toBe('BUY');
    expect(d.status).toBe('Exception');
  });

  it('AC-INV-09: an advance on the PO is adjusted; balance payable is shown and the unadjusted advance is listed', async () => {
    t.db.insert('advances', { adv_no: 'ADV-TEST-1', po_id: poId('4500021005'), vendor_id: t.db.get<{ id: number }>("SELECT id FROM vendors WHERE sap_code = '100103'")!.id, amount: 50000, reason: 'Test advance for matching', status: 'Paid', requested_by: 1, paid_date: '2026-10-01', adjusted_amount: 0, created_at: '2026-09-30T00:00:00Z' });
    const fin = await who('meera.iyer');
    const x = seedLib.invoiceValues('4500021005', 'BBT/26/0001', '2026-10-10', [{ item: 10, qty: 8 }])!;
    const f = await (await who('kiran.shah')).upload('/api/files', [{ name: 'bbt.pdf', content: uniqPdf(), type: 'application/pdf' }]);
    const r = await (await who('kiran.shah')).post('/api/invoices', { po_id: x.po.id, attachment_id: f.body.files[0].id, header: x.header, lines: x.lines });
    expect(r.status).toBe(200);
    const d = await detail(fin, r.body.id);
    const adv = d.match.advance;
    expect(adv.outstanding).toBe(50000);
    expect(adv.proposed_adjustment).toBe(50000);
    expect(adv.balance_payable).toBeCloseTo(d.total_value - 50000, 2);
    expect(adv.advances[0].adv_no).toBe('ADV-TEST-1');
    expect(d.match.results.find((x: any) => x.rule === '3WM-06').summary).toMatch(/Unadjusted advance/);
    expect(d.on_behalf).toBe(1); // FR-INV-10 marked
  });

  it('AC-INV-12: GRN on line 1 but the invoice bills line 2 → "PO/GRN line mismatch"', async () => {
    sap.sapPut('PO', '4500029901', { po_no: '4500029901', vendor_sap_code: '100106', buyer_email: 'amit.kulkarni@equipcare.test', plant: 'PUN1', po_date: '2026-10-01', released: true, version: 1, delivery_terms: 'FOR destination', payment_terms: '45 days from GRN', freight_terms: 'Freight paid', items: [
      { item: 10, material_code: 'HYD-1001', description: 'Seal kit', qty: 4, uom: 'EA', unit_price: 18450, gst_rate: 18, delivery_date: '2026-10-20' },
      { item: 20, material_code: 'HYD-1005', description: 'O-ring kit', qty: 4, uom: 'SET', unit_price: 2650, gst_rate: 18, delivery_date: '2026-10-20' }] });
    sap.syncEvent('PO');
    sap.sapPut('GRN', '5000109901-2026', { grn_no: '5000109901', year: '2026', po_no: '4500029901', posting_date: '2026-10-05', plant: 'PUN1', items: [{ po_item: 10, qty: 4, value: 73800 }] });
    sap.syncEvent('GRN');
    const r = await submit(await who('imran'), '4500029901', 'DRW/26/0901', [{ item: 20, qty: 4 }]);
    const d = await detail(await who('meera.iyer'), r.body.id);
    expect(reasons(d)).toContain('PO/GRN line mismatch');
    expect(d.exceptions.find((e: any) => e.rule === '3WM-03').owner_role).toBe('STO');
  });

  it('AC-INV-13: GST 12% vs 18%, or a different HSN, is a "tax mismatch" owned by finance', async () => {
    const imran = await who('imran');
    const fin = await who('meera.iyer');
    const a = await submit(imran, '4500021004', 'DRW/26/0013', [{ item: 10, qty: 1 }], { lines: [{ gst_rate: 12 }] });
    const da = await detail(fin, a.body.id);
    expect(reasons(da)).toContain('Tax mismatch');
    expect(da.exceptions.find((e: any) => e.rule === '3WM-04').owner_role).toBe('FIN');
    const b = await submit(imran, '4500021004', 'DRW/26/0014', [{ item: 10, qty: 1 }], { lines: [{ hsn: '99999999' }] });
    const db_ = await detail(fin, b.body.id);
    expect(db_.exceptions.find((e: any) => e.rule === '3WM-04').message).toMatch(/HSN/);
  });

  it('FR-INV-09: a bank-detail mismatch is a high-severity exception that is never auto-cleared', async () => {
    const imran = await who('imran');
    const fin = await who('meera.iyer');
    const good = t.db.get<{ bank_account_masked: string }>("SELECT bank_account_masked FROM vendors WHERE sap_code = '100106'")!.bank_account_masked.slice(-4);
    const r = await submit(imran, '4500021004', 'DRW/26/0020', [{ item: 10, qty: 1 }], { header: { bank_account: '50200099990001' } });
    let d = await detail(fin, r.body.id);
    const ex = d.exceptions.find((e: any) => e.rule === 'BANK');
    expect(ex.severity).toBe('high');
    // finance corrects the figure to match SAP; the exception stays open until a person decides
    await fin.post(`/api/invoices/${r.body.id}/correct`, { field: 'bank_account', value: `50200099990${good}`.slice(-14), reason: 'Vendor confirmed the account on the PDF stamp.' });
    d = await detail(fin, r.body.id);
    expect(d.exceptions.find((e: any) => e.rule === 'BANK').status).toBe('Open');
    expect(d.exceptions.find((e: any) => e.rule === 'BANK').owner_role).toBe('FIN');
  });

  it('FR-INV-05 / FR-INV-08: low OCR confidence goes to the exception queue; confirming the value clears it (seeded phone photo)', async () => {
    const fin = await who('meera.iyer');
    const inv = byNo('JMSR/SR/2611');
    let d = await detail(fin, inv.id);
    expect(d.sub_reason).toBe('Low OCR confidence');
    expect(d.extracted.capture).toBe('photo');
    expect(d.on_behalf).toBe(1);
    expect(d.exceptions[0].actual).toMatch(/%/);
    const v = await fin.post(`/api/invoices/${inv.id}/verify`, { field: 'vendor_gstin' });
    expect(v.status).toBe(200);
    d = await detail(fin, inv.id);
    expect(reasons(d)).not.toContain('Low OCR confidence');
    expect(d.status).toBe('Matched'); // SES posted, so a service invoice matches PO vs SES vs invoice
    expect(d.is_service).toBe(1);
  });

  it('WF-10: pending GRN waits and re-matches automatically when SAP posts the GRN', async () => {
    sap.sapPut('PO', '4500029903', { po_no: '4500029903', vendor_sap_code: '100106', buyer_email: 'amit.kulkarni@equipcare.test', plant: 'PUN1', po_date: '2026-10-01', released: true, version: 1, delivery_terms: 'FOR destination', payment_terms: '45 days from GRN', freight_terms: 'Freight paid', items: [{ item: 10, material_code: 'HYD-1005', description: 'O-ring kit', qty: 5, uom: 'SET', unit_price: 2650, gst_rate: 18, delivery_date: '2026-10-20' }] });
    sap.syncEvent('PO');
    const r = await submit(await who('imran'), '4500029903', 'DRW/26/0903', [{ item: 10, qty: 5 }]);
    const fin = await who('meera.iyer');
    let d = await detail(fin, r.body.id);
    expect(d.status).toBe('Validation pending');
    expect(d.sub_reason).toMatch(/Waiting for GRN/);
    sap.sapPut('GRN', '5000109903-2026', { grn_no: '5000109903', year: '2026', po_no: '4500029903', posting_date: '2026-10-06', plant: 'PUN1', items: [{ po_item: 10, qty: 5, value: 13250 }] });
    sap.syncEvent('GRN');
    d = await detail(fin, r.body.id);
    expect(d.status).toBe('Matched');
    expect(reasons(d)).toEqual([]);
  });

  it('3WM-07 / DEC-20: an open dispute holds the invoice (full rule) and finance sees the reason; the dispute owner is the exception owner', async () => {
    const fin = await who('meera.iyer');
    const d = await detail(fin, byNo('INV-457').id);
    expect(d.dispute_hold).toBe(1);
    const ex = d.exceptions.find((e: any) => e.rule === 'DISPUTE_HOLD');
    expect(ex.message).toMatch(/DSP-/);
    expect(ex.message).toMatch(/DEC-20/);
    expect(d.config.hold_rule).toBe('full');
  });

  it('FR-INV-18: FDS price check uses list price × (1 − discount) for contracts with invoice validation', async () => {
    const nitin = await who('nitin');
    const fin = await who('meera.iyer');
    const r = await submit(nitin, '4500021007', 'KIT/26-27/9999', [{ item: 10, qty: 1, rate: 31500 }]); // contract net price 30,360
    const d = await detail(fin, r.body.id);
    const ex = d.exceptions.find((e: any) => e.rule === 'FDS');
    expect(ex).toBeTruthy();
    expect(ex.reason).toBe('FDS price variance');
    expect(ex.owner_role).toBe('BUY');
  });

  it('AC-INV-10: no SAP parking without finance approval; non-finance cannot approve; approved invoices are parked per DEC-06', async () => {
    const fin = await who('meera.iyer');
    const inv = byNo('PFI/2026/3345');
    const before = t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sap_outbound WHERE flow = 'INT-M11'")!.n;
    // matched but not yet approved
    expect((await detail(fin, inv.id)).status).toBe('Matched');
    const early = await fin.post(`/api/invoices/${inv.id}/park`, {});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('finance_approval_required');
    const simEarly = await (await who('neha.gupta')).post(`/api/sap/sim/invoice/${inv.inv_ref}/park`, {});
    expect(simEarly.status).toBeGreaterThanOrEqual(400);
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sap_outbound WHERE flow = 'INT-M11'")!.n).toBe(before);
    expect(t.db.get<{ status: string }>('SELECT status FROM invoices WHERE id = ?', inv.id)!.status).toBe('Matched');
    // not for buyers / vendors
    expect((await (await who('amit.kulkarni')).post(`/api/invoices/${inv.id}/approve`, {})).status).toBe(403);
    expect((await (await who('pooja.malhotra')).post(`/api/invoices/${inv.id}/approve`, {})).status).toBe(403);
    // an exception invoice cannot be approved either (FR-INV-19)
    const exc = byNo('WLD/0921');
    const refuse = await fin.post(`/api/invoices/${exc.id}/approve`, {});
    expect(refuse.status).toBe(409);
    expect(refuse.body.error.code).toBe('not_matched');
    // finance approves → DEC-06 off → manual entry hand-over, no outbound write
    expect((await fin.post(`/api/invoices/${inv.id}/approve`, { note: 'Matched on PO, GRN and invoice.' })).status).toBe(200);
    const manual = await fin.post(`/api/invoices/${inv.id}/park`, {});
    expect(manual.status).toBe(200);
    expect(manual.body.result.status).toBe('Manual');
    expect(manual.body.result.message).toMatch(/manually/);
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sap_outbound WHERE flow = 'INT-M11'")!.n).toBe(before);
    // the simulator now accepts the approved invoice and the status returns only through the INT-M12 sync
    const park = await (await who('neha.gupta')).post(`/api/sap/sim/invoice/${inv.inv_ref}/park`, {});
    expect(park.status).toBe(200);
    expect((await detail(fin, inv.id)).status).toBe('Parked');
    // approved then edited: corrections are refused once released for parking
    expect((await fin.post(`/api/invoices/${inv.id}/correct`, { field: 'freight', value: 5, reason: 'Late correction attempt' })).status).toBe(409);
  });

  it('FR-INV-19 with DEC-06 on: parking is written through INT-M11 and the real result is shown', async () => {
    const fin = await who('meera.iyer');
    const x = seedLib.invoiceValues('4500021010', 'HYD/26/0950', '2026-10-10', [{ item: 10, qty: 2 }])!;
    sap.sapPut('GRN', '5000109950-2026', { grn_no: '5000109950', year: '2026', po_no: '4500021010', posting_date: '2026-10-08', plant: 'DHN1', items: [{ po_item: 10, qty: 2, value: 49000 }] });
    sap.syncEvent('GRN');
    const manoj = await who('manoj.kale');
    const f = await manoj.upload('/api/files', [{ name: 'w.pdf', content: uniqPdf(), type: 'application/pdf' }]);
    const r = await manoj.post('/api/invoices', { po_id: x.po.id, attachment_id: f.body.files[0].id, header: x.header, lines: x.lines });
    const d = await detail(fin, r.body.id);
    expect(d.status).toBe('Matched');
    expect((await fin.post(`/api/invoices/${r.body.id}/approve`, {})).status).toBe(200);
    config.applyConfig('sap.write.invoice_parking', true, 1, 'Test DEC-06 on');
    const p = await fin.post(`/api/invoices/${r.body.id}/park`, {});
    config.applyConfig('sap.write.invoice_parking', false, 1, 'Test DEC-06 off');
    expect(p.status).toBe(200);
    expect(p.body.result.status).toBe('Written');
    expect(t.db.get<{ status: string }>("SELECT status FROM sap_outbound WHERE idempotency_key = ?", `PARK:${d.inv_ref}`)!.status).toBe('Written');
    const again = await fin.post(`/api/invoices/${r.body.id}/park`, {});
    expect(again.status).toBe(409);
  });

  it('AC-INV-11: a posted invoice keeps original, extracted, corrected and final records and cannot be edited', async () => {
    const fin = await who('meera.iyer');
    const inv = byNo('KIT/26-27/0318');
    const d = await detail(fin, inv.id);
    expect(d.status).toBe('Payment released');
    expect(d.attachment.id).toBeTruthy();
    expect(d.extracted.header.invoice_no.value).toBe('KIT/26-27/0318');
    expect(d.values.header.invoice_no).toBe('KIT/26-27/0318');
    expect(d.final).toBeTruthy();
    expect(Array.isArray(d.corrections)).toBe(true);
    const edit = await fin.post(`/api/invoices/${inv.id}/correct`, { field: 'freight', value: 10, reason: 'Editing a posted invoice' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.message).toMatch(/AC-INV-11/);
    expect((await fin.post(`/api/invoices/${inv.id}/reject`, { vendor_reason: 'Trying to reject a posted invoice' })).status).toBe(409);
  });

  it('FR-INV-10: finance uploads on the vendor’s behalf (marked); switching the Q 7.10 setting off refuses it', async () => {
    const kiran = await who('kiran.shah');
    const ok = await submit(kiran, '4500021004', 'DRW/26/0030', [{ item: 10, qty: 1 }]);
    expect(ok.status).toBe(200);
    expect((await detail(kiran, ok.body.id)).on_behalf).toBe(1);
    const vend = await (await who('imran')).get(`/api/invoices/vendor/${ok.body.id}`);
    expect(vend.body.on_behalf).toBe(1);
    config.applyConfig('inv.upload_on_behalf', false, 1, 'Test setting off');
    const refused = await submit(kiran, '4500021004', 'DRW/26/0031', [{ item: 10, qty: 1 }]);
    config.applyConfig('inv.upload_on_behalf', true, 1, 'Test setting on');
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/Q 7\.10/);
    // buyers cannot upload at all
    expect((await submit(await who('amit.kulkarni'), '4500021004', 'DRW/26/0032', [{ item: 10, qty: 1 }])).status).toBe(403);
  });

  it('WF-10 resolutions: approve within authority needs a reason, assign owner, reject to vendor with a vendor-safe reason', async () => {
    const fin = await who('meera.iyer');
    const exc = byNo('WLD/0921');
    const d = await detail(fin, exc.id);
    const price = d.exceptions.find((e: any) => e.rule === '3WM-02');
    expect((await fin.post(`/api/invoices/exceptions/${price.id}/approve`, { reason: 'ok' })).status).toBe(400);
    const sneha = t.db.get<{ id: number }>("SELECT id FROM users WHERE email LIKE 'sneha.patil@%'")!.id;
    const as = await fin.post(`/api/invoices/exceptions/${price.id}/assign`, { user_id: sneha, note: 'Please confirm with the vendor' });
    expect(as.status).toBe(200);
    expect(as.body.owner_user_id).toBe(sneha);
    const q = await fin.get('/api/invoices/exceptions');
    expect(q.body.find((e: any) => e.id === price.id)).toMatchObject({ owner: 'Sneha Patil', age_bucket: expect.any(String) });
    expect(t.db.get('SELECT id FROM notifications WHERE user_id = ? AND event = ? AND title LIKE ?', sneha, 'NTF-28', '%assigned to you%')).toBeTruthy();
    // approving the excess-billing exception keeps the dispute hold open: still an exception
    await fin.post(`/api/invoices/exceptions/${price.id}/approve`, { reason: 'Vendor will supply the 4 drums later; paying 6 only.' });
    const after = await detail(fin, exc.id);
    expect(after.exceptions.find((e: any) => e.id === price.id).status).toBe('Approved');
    expect(after.status).toBe('Exception');
    expect((await fin.post(`/api/invoices/${exc.id}/approve`, {})).status).toBe(409);
    // reject with vendor-safe reason
    const rej = await fin.post(`/api/invoices/${byNo('JMSR/SR/2611').id}/reject`, { vendor_reason: 'Please send a clearer scan of the invoice.', internal_note: 'Phone photo too blurry' });
    expect(rej.status).toBe(200);
    expect(rej.body.status).toBe('Rejected');
  });

  it('GOV-C08: vendors see only vendor-safe reasons and statuses; no internal data, owners, tolerances or other vendors', async () => {
    const sanjay = await who('sanjay');
    const id = byNo('WLD/0921').id;
    const r = await sanjay.get(`/api/invoices/vendor/${id}`);
    expect(r.status).toBe(200);
    const txt = JSON.stringify(r.body);
    expect(r.body.exceptions.length).toBeGreaterThan(0);
    expect(r.body.exceptions.every((e: any) => e.status === 'Under review' && typeof e.vendor_message === 'string')).toBe(true);
    for (const leak of ['tolerance', 'owner_role', 'owner_user_id', 'expected', 'block_reason_internal', 'match_json', '"match"', 'DEC-20', 'Sneha', 'internal']) expect(txt).not.toContain(leak);
    expect(r.body.events.every((e: any) => !('note' in e) && !('user_name' in e))).toBe(true);
    expect(txt).toContain('Payment is on hold until the open delivery dispute');
    // list is vendor-scoped and vendor-safe
    const list = await sanjay.get('/api/invoices/vendor');
    expect(list.body.every((x: any) => x.po_no === '4500021003')).toBe(true);
    // internal endpoints are closed to vendors; other vendors get 404
    expect((await sanjay.get('/api/invoices')).status).toBe(403);
    expect((await sanjay.get(`/api/invoices/${id}`)).status).toBe(403);
    expect((await (await who('manoj.kale')).get(`/api/invoices/vendor/${id}`)).status).toBe(404);
    // attachment follows the object access rule
    const att = t.db.get<{ id: number }>('SELECT attachment_id AS id FROM invoices WHERE id = ?', id)!.id;
    expect((await sanjay.get(`/api/files/${att}/download`)).status).toBe(200);
    expect((await (await who('manoj.kale')).get(`/api/files/${att}/download`)).status).toBe(404);
  });

  it('NTF-27 / NTF-28: owner and vendor are notified, vendor wording is vendor-safe; NTF-29 ageing job runs', async () => {
    const ntf = t.db.all<{ event: string; user_id: number; body: string }>("SELECT n.event, n.user_id, n.body FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.vendor_id IS NOT NULL AND n.event = 'NTF-28'");
    expect(ntf.length).toBeGreaterThan(0);
    for (const x of ntf) expect(x.body ?? '').not.toMatch(/tolerance|owner|DEC-/);
    expect(t.db.get("SELECT id FROM notifications WHERE event = 'NTF-28' AND user_id IN (SELECT id FROM users WHERE roles LIKE '%FIN%')")).toBeTruthy();
    expect(t.db.get("SELECT id FROM notifications WHERE event = 'NTF-27'")).toBeTruthy();
    t.db.run("UPDATE invoice_exceptions SET created_at = '2026-09-01T00:00:00.000Z' WHERE status = 'Open'");
    const { exceptionAgeingJob } = await import('../modules/invoices/service.ts');
    expect(exceptionAgeingJob()).toMatch(/open exceptions/);
    expect(t.db.get("SELECT id FROM notifications WHERE event = 'NTF-29'")).toBeTruthy();
  });

  it('SCR-INV-01/02: lists carry tabs, owner and age; report data gives KPI-10 and KPI-11', async () => {
    const fin = await who('meera.iyer');
    const list = await fin.get('/api/invoices');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(8);
    expect(list.body[0]).toHaveProperty('tab');
    expect(list.body.find((i: any) => i.vendor_invoice_no === 'KIT/26-27/0318').status).toMatch(/Posted|Payment released/);
    const rep = await fin.get('/api/invoices/report');
    expect(rep.body.uploaded).toBeGreaterThan(8);
    expect(rep.body.kpi_10_field_accuracy).toBeGreaterThan(0.9);
    expect(rep.body.baseline).toMatch(/to be measured/);
    expect((await (await who('sanjay')).get('/api/invoices/report')).status).toBe(403);
  });
});
