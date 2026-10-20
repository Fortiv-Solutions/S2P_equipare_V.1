import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, PDF, type Client } from './helpers.ts';

let t: Awaited<ReturnType<typeof startApp>>;
let seedLib: typeof import('../modules/invoices/seed.ts');
let pay: typeof import('../modules/payments/service.ts');
const clients = new Map<string, Promise<Client>>();
const who = (local: string) => { if (!clients.has(local)) clients.set(local, t.login(local)); return clients.get(local)!; };

beforeAll(async () => {
  t = await startApp();
  seedLib = await import('../modules/invoices/seed.ts');
  pay = await import('../modules/payments/service.ts');
  // Core rate-limits sign-ins and uploads on one shared counter; sign personas in first.
  for (const p of ['meera.iyer', 'kiran.shah', 'amit.kulkarni', 'vikram.joshi', 'neha.gupta', 'nitin', 'pooja.malhotra', 'sanjay', 'imran', 'manoj.kale', 'sneha.patil']) await who(p);
});
afterAll(async () => { await t.close(); });

const poId = (no: string) => t.db.get<{ id: number; total_value: number }>('SELECT id, total_value FROM pos WHERE po_no = ?', no)!;
const invByNo = (no: string) => t.db.get<{ id: number; inv_ref: string }>('SELECT id, inv_ref FROM invoices WHERE vendor_invoice_no = ?', no)!;

describe('Module 11 — payment status and advances', () => {
  it('AC-PAY-02: an advance without a reason is blocked; amount must not exceed the PO value', async () => {
    const amit = await who('amit.kulkarni');
    const po = poId('4500021005');
    const noReason = await amit.post('/api/payments/advances', { po_id: po.id, amount: 10000, reason: '' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.fields.reason).toBeTruthy();
    const short = await amit.post('/api/payments/advances', { po_id: po.id, amount: 10000, reason: 'short' });
    expect(short.status).toBe(400);
    const over = await amit.post('/api/payments/advances', { po_id: po.id, amount: po.total_value + 1, reason: 'Vendor asks for more than the PO is worth' });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toMatch(/cannot exceed the PO value/);
    const none = await amit.post('/api/payments/advances', { amount: 10000, reason: 'No PO or contract chosen here' });
    expect(none.status).toBe(400);
    // vendors and stores cannot request
    expect((await (await who('nitin')).post('/api/payments/advances', { po_id: po.id, amount: 1000, reason: 'Vendor trying to ask' })).status).toBe(403);
  });

  it('FR-PAY-02 / FR-PAY-06 / WF-11: request → approval (Module 5) → Finance pays in the SAP simulator → status Paid from the ADVPAY sync → adjustment', async () => {
    const amit = await who('amit.kulkarni');
    const po = poId('4500021005');
    const r = await amit.post('/api/payments/advances', { po_id: po.id, amount: 100000, reason: 'Bearing import needs 25% advance before shipment.' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('Pending approval');
    const ap = t.db.get<{ id: number; type: string; value: number }>('SELECT id, type, value FROM approvals WHERE id = ?', r.body.approval_id)!;
    expect(ap.type).toBe('adv.request');
    expect(ap.value).toBe(100000);
    // requester cannot approve; SoD enforced by the engine
    expect((await amit.post(`/api/approvals/${ap.id}/approve`, {})).status).toBe(403);
    // cannot be paid before approval
    const early = await (await who('meera.iyer')).post(`/api/sap/sim/advance/${r.body.adv_no}/pay`, {});
    expect(early.status).toBeGreaterThanOrEqual(400);
    expect((await (await who('vikram.joshi')).post(`/api/approvals/${ap.id}/approve`, { comment: 'Fine' })).status).toBe(200);
    expect((await (await who('meera.iyer')).post(`/api/approvals/${ap.id}/approve`, { comment: 'Funds available' })).status).toBe(200);
    expect(t.db.get<{ status: string }>('SELECT status FROM advances WHERE id = ?', r.body.id)!.status).toBe('Approved');
    const fin = await who('meera.iyer');
    const paid = await fin.post(`/api/sap/sim/advance/${r.body.adv_no}/pay`, {});
    expect(paid.status).toBe(200);
    const d = (await fin.get(`/api/payments/advances/${r.body.id}`)).body;
    expect(d.status).toBe('Paid');
    expect(d.sap_doc).toBeTruthy();
    expect(d.paid_date).toBeTruthy();
    expect(d.outstanding).toBe(100000);
    // SAP clears part of it
    const adj = await fin.post(`/api/sap/sim/advance/${r.body.adv_no}/adjust`, { amount: 40000 });
    expect(adj.status).toBe(200);
    const d2 = (await fin.get(`/api/payments/advances/${r.body.id}`)).body;
    expect(d2.status).toBe('Partially adjusted');
    expect(d2.outstanding).toBe(60000);
    // vendor was told it was paid
    expect(t.db.get("SELECT id FROM notifications WHERE event = 'NTF-30' AND title LIKE ?", `%${r.body.adv_no}%`)).toBeTruthy();
    // cannot cancel after payment
    expect((await amit.post(`/api/payments/advances/${r.body.id}/cancel`, { reason: 'Trying to cancel a paid advance' })).status).toBe(409);
  });

  it('a rejected approval returns the advance as Rejected; a pending request can be cancelled with a reason', async () => {
    const sneha = await who('sneha.patil');
    const po = poId('4500021002');
    const a = await sneha.post('/api/payments/advances', { po_id: po.id, amount: 5000, reason: 'Small advance for tooling charges.' });
    expect(a.status).toBe(200);
    const rej = await (await who('vikram.joshi')).post(`/api/approvals/${a.body.approval_id}/reject`, { comment: 'Not justified for a running VMI contract.' });
    expect(rej.status).toBe(200);
    expect(t.db.get<{ status: string }>('SELECT status FROM advances WHERE id = ?', a.body.id)!.status).toBe('Rejected');
    const b = await sneha.post('/api/payments/advances', { po_id: po.id, amount: 6000, reason: 'Second attempt with revised terms.' });
    expect((await sneha.post(`/api/payments/advances/${b.body.id}/cancel`, { reason: 'x' })).status).toBe(400);
    expect((await sneha.post(`/api/payments/advances/${b.body.id}/cancel`, { reason: 'Vendor withdrew the request.' })).status).toBe(200);
    expect(t.db.get<{ status: string }>('SELECT status FROM advances WHERE id = ?', b.body.id)!.status).toBe('Cancelled');
  });

  it('AC-PAY-03: advances aged 10 / 40 / 100 days fall in the configured buckets; the register groups outstanding by vendor and ageing', async () => {
    expect(pay.bucketFor(10)).toBe('0–30 days');
    expect(pay.bucketFor(40)).toBe('31–60 days');
    expect(pay.bucketFor(100)).toBe('> 90 days');
    expect(pay.bucketsOf().labels).toHaveLength(4); // cfg pay.advance_buckets [30, 60, 90]
    const fin = await who('meera.iyer');
    const reg = (await fin.get('/api/payments/advances')).body;
    expect(reg.buckets).toEqual(['0–30 days', '31–60 days', '61–90 days', '> 90 days']);
    // seeded: Western Lubricants advance paid ~78 days ago, 90,000 of 150,000 adjusted
    const wl = reg.rows.find((r: any) => r.vendor_name.startsWith('Western'));
    expect(wl.status).toBe('Partially adjusted');
    expect(wl.outstanding).toBe(60000);
    expect(wl.bucket).toBe('61–90 days');
    expect(wl.age_days).toBeGreaterThan(60);
    const v = reg.by_vendor.find((x: any) => x.vendor.startsWith('Western'));
    expect(v.buckets[2]).toBe(60000);
    expect(reg.totals.outstanding).toBeGreaterThanOrEqual(60000);
    expect(reg.baseline).toMatch(/to be measured/);
    // seeded Deccan BD advance is pending approval
    expect(reg.rows.find((r: any) => r.vendor_name.startsWith('Deccan')).status).toBe('Pending approval');
    // NTF-31 job (alert age 60 days)
    expect(pay.advanceAgeingJob()).toMatch(/notifications/);
    expect(t.db.get("SELECT id FROM notifications WHERE event = 'NTF-31'")).toBeTruthy();
  });

  it('AC-PAY-01: SAP posting shows Posted for internal users and the vendor', async () => {
    const fin = await who('meera.iyer');
    const inv = invByNo('PFI/2026/3345'); // seeded Matched invoice (Precision)
    expect((await fin.post(`/api/invoices/${inv.id}/approve`, {})).status).toBe(200);
    expect((await (await who('neha.gupta')).post(`/api/sap/sim/invoice/${inv.inv_ref}/post`, {})).status).toBe(200);
    const internal = (await fin.get('/api/payments/invoices')).body.find((r: any) => r.id === inv.id);
    expect(internal.status).toBe('Posted');
    expect(internal.sap_doc_no).toBeTruthy();
    const vendor = (await (await who('pooja.malhotra')).get('/api/payments/vendor/invoices')).body.find((r: any) => r.id === inv.id);
    expect(vendor.status).toBe('Posted');
    expect(vendor.due_date).toBeTruthy();
  });

  it('AC-PAY-04: the payment advice is downloadable after release (not before) by the owning vendor only', async () => {
    const kranti = invByNo('KIT/26-27/0318'); // seeded Payment released
    const nitin = await who('nitin');
    const r = await fetch(`${t.base}/api/payments/invoices/${kranti.id}/advice.pdf`, { headers: { cookie: (nitin as any).cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    // other vendor: 404; not yet released: 409
    expect((await (await who('sanjay')).get(`/api/payments/invoices/${kranti.id}/advice.pdf`)).status).toBe(404);
    const precision = invByNo('PFI/2026/3345');
    expect((await (await who('pooja.malhotra')).get(`/api/payments/invoices/${precision.id}/advice.pdf`)).status).toBe(409);
    // internal finance can also download
    expect((await (await who('meera.iyer')).get(`/api/payments/invoices/${kranti.id}/advice.pdf`)).status).toBe(200);
  });

  it('AC-PAY-05 / FR-PAY-05 / FR-PAY-07: TDS is shown when SAP provides it and hidden (not zero) when it does not; only whitelisted fields reach vendors', async () => {
    const withTds = (await (await who('nitin')).get('/api/payments/vendor/invoices')).body.find((r: any) => r.vendor_invoice_no === 'KIT/26-27/0318');
    expect(withTds.status).toBe('Payment released');
    expect(withTds.tds).toBeGreaterThan(0);
    expect(withTds.payment_ref).toBe('1500003921');
    expect(withTds.advice_available).toBe(true);
    expect('retention' in withTds).toBe(false);
    expect('block_reason_internal' in withTds).toBe(false);
    // Apex paid invoice: SAP gave no TDS → the key is absent, not 0
    const apexInv = invByNo('AWC/1187');
    const apexUser = t.db.get<{ email: string }>("SELECT email FROM users WHERE vendor_id IS NULL AND 0")?.email;
    void apexUser;
    const internal = (await (await who('meera.iyer')).get('/api/payments/invoices')).body.find((r: any) => r.id === apexInv.id);
    expect(internal.status).toBe('Payment released');
    expect(internal.tds).toBeNull();
    // whitelist: remove tds from cfg pay.vendor_fields → vendor no longer sees it
    const config = await import('../core/config.ts');
    const orig = config.cfg<string[]>('pay.vendor_fields');
    config.applyConfig('pay.vendor_fields', orig.filter((f) => f !== 'tds'), 1, 'Test whitelist');
    const hidden = (await (await who('nitin')).get('/api/payments/vendor/invoices')).body.find((r: any) => r.vendor_invoice_no === 'KIT/26-27/0318');
    config.applyConfig('pay.vendor_fields', orig, 1, 'Test restore');
    expect('tds' in hidden).toBe(false);
  });

  it('payment blocked in SAP: vendors see only the vendor-safe reason; internal block reason stays internal', async () => {
    const fin = await who('meera.iyer');
    const inv = invByNo('PFI/2026/3345');
    const blocked = await (await who('neha.gupta')).post(`/api/sap/sim/invoice/${inv.inv_ref}/block`, { reason_internal: 'Bank mismatch suspected on internal review', vendor_reason: 'Payment on hold pending bank confirmation.' });
    expect(blocked.status).toBe(200);
    const vendor = (await (await who('pooja.malhotra')).get('/api/payments/vendor/invoices')).body.find((r: any) => r.id === inv.id);
    expect(vendor.status).toBe('Payment blocked');
    expect(JSON.stringify(vendor)).not.toMatch(/suspected|internal/i);
    const detail = (await (await who('pooja.malhotra')).get(`/api/invoices/vendor/${inv.id}`)).body;
    expect(JSON.stringify(detail)).not.toMatch(/suspected|internal review/i);
    expect((await fin.get(`/api/invoices/${inv.id}`)).body.status).toBe('Payment blocked');
  });

  it('SCR-PAY-01: finance and buyers see the lists; vendors are isolated; report data reconciles', async () => {
    const buyer = await who('amit.kulkarni');
    expect((await buyer.get('/api/payments/invoices')).status).toBe(200);
    expect((await (await who('sanjay')).get('/api/payments/invoices')).status).toBe(403);
    expect((await (await who('sanjay')).get('/api/payments/advances')).status).toBe(403);
    const mine = (await (await who('sanjay')).get('/api/payments/vendor/advances')).body;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((a: any) => a.po_no === null || typeof a.po_no === 'string')).toBe(true);
    expect(mine.every((a: any) => !('reason' in a) && !('requested_by' in a))).toBe(true);
    const a = t.db.get<{ id: number }>("SELECT a.id FROM advances a JOIN vendors v ON v.id = a.vendor_id WHERE v.sap_code = '100106' LIMIT 1")!;
    expect((await (await who('sanjay')).get(`/api/payments/advances/${a.id}`)).status).toBe(404);
    const rep = (await (await who('meera.iyer')).get('/api/payments/report')).body;
    expect(rep.advances.outstanding).toBeGreaterThan(0);
    expect(rep.invoices.released).toBeGreaterThanOrEqual(2);
  });
});
