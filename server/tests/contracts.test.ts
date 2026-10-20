import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers.ts';

let t: Awaited<ReturnType<typeof startApp>>;
let S: typeof import('../modules/contracts/service.ts');
let sap: typeof import('../core/sap.ts');
let approvals: typeof import('../core/approvals.ts');
let ctx: typeof import('../seed/ctx.ts');

beforeAll(async () => {
  t = await startApp();
  S = await import('../modules/contracts/service.ts');
  sap = await import('../core/sap.ts');
  approvals = await import('../core/approvals.ts');
  ctx = await import('../seed/ctx.ts');
});
afterAll(async () => { await t.close(); });

const byOa = (oa: string) => t.db.get<{ id: number; status: string; valid_to: string; contract_no: string }>('SELECT * FROM contracts WHERE sap_oa_no = ?', oa)!;
const mid = (code: string) => t.db.get<{ id: number }>('SELECT id FROM materials WHERE code = ?', code)!.id;
const uid = (local: string) => t.db.get<{ id: number }>('SELECT id FROM users WHERE email LIKE ?', `${local}@%`)!.id;
const approvalFor = (type: string, objectType: string, objectId: number) =>
  t.db.get<{ id: number; status: string }>('SELECT id, status FROM approvals WHERE type = ? AND object_type = ? AND object_id = ? ORDER BY id DESC', type, objectType, objectId)!;
/** Approve every level of an approval request with the seeded approvers. */
function approveAll(id: number) {
  const apr = ctx.actorFor('vikram.joshi', 'APR');
  const fin = ctx.actorFor('meera.iyer');
  for (let i = 0; i < 4; i++) {
    const a = approvals.getApproval(id)!;
    if (a.status !== 'Pending') return a;
    const role = t.db.get<{ approver_role: string }>("SELECT approver_role FROM approval_steps WHERE approval_id = ? AND status = 'Pending' LIMIT 1", id)!.approver_role;
    approvals.act(role === 'FIN' ? fin : apr, id, 'approve', 'Approved in test');
  }
  return approvals.getApproval(id)!;
}
/** SAP simulator stand-in: write the OA for a platform contract and sync it. */
function simulateOa(contractId: number, oaNo?: string) {
  const p = S.sapOaPayload(contractId);
  sap.sapPut('OA', p.key ?? oaNo!, p.payload, 'Test');
  sap.syncEvent('OA');
}

describe('Module 6 — contracts', () => {
  it('AC-CON-01: a synced OA shows vendor, scope, price, validity, documents and SAP OA number', async () => {
    const sneha = await t.login('sneha.patil');
    const c = byOa('5500000101');
    const r = await sneha.get(`/api/contracts/${c.id}`);
    expect(r.status).toBe(200);
    expect(r.body.sap_oa_no).toBe('5500000101');
    expect(r.body.vendor.name).toBeTruthy();
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items[0].unit_price).toBeGreaterThan(0);
    expect(r.body.valid_from).toBe('2026-04-01');
    expect(r.body.utilisation.pct).toBeGreaterThan(0);
    const docs = await sneha.get(`/api/files?owner_type=contract&owner_id=${c.id}`);
    expect(docs.body.length).toBeGreaterThan(0);
    const list = await sneha.get('/api/contracts?tab=all');
    expect(list.body.find((x: any) => x.sap_oa_no === '5500000101').scope).toContain('LUB-5001');
  });

  it('AC-CON-02: the opportunity job lists HYD-1001 and WLD-6001 with frequency, value and vendor count', async () => {
    const amit = await t.login('amit.kulkarni');
    const r = await amit.get('/api/contracts/opportunities');
    const hyd = r.body.find((o: any) => o.material_code === 'HYD-1001');
    const wld = r.body.find((o: any) => o.material_code === 'WLD-6001');
    expect(hyd).toBeTruthy();
    expect(wld).toBeTruthy();
    expect(hyd.frequency).toBeGreaterThanOrEqual(3);
    expect(hyd.vendor_count).toBeGreaterThanOrEqual(3);
    expect(wld.vendor_count).toBe(1);
    expect(wld.annual_value).toBeGreaterThan(100000);
    expect(r.body.find((o: any) => o.material_code === 'UCG-2003')).toBeFalsy(); // covered by the Shakti ARC
    // Reject needs a reason; accept creates a prefilled Draft ARC and the RFQ link.
    expect((await amit.post(`/api/contracts/opportunities/${hyd.id}/reject`, { reason: 'short' })).status).toBe(400);
    const acc = await amit.post(`/api/contracts/opportunities/${wld.id}/accept`, {});
    expect(acc.status).toBe(200);
    expect(acc.body.rfq_link).toBe(`/rfqs/new?opportunity=${wld.id}`);
    const draft = t.db.get<{ status: string; type: string }>('SELECT status, type FROM contracts WHERE id = ?', acc.body.contract_id)!;
    expect(draft).toMatchObject({ status: 'Draft', type: 'ARC' });
    const rej = await amit.post(`/api/contracts/opportunities/${hyd.id}/reject`, { reason: 'OEM-only seal kits; ARC not feasible this year' });
    expect(rej.body.status).toBe('Rejected');
  });

  it('AC-CON-03: a synced SAP PO without OA reference for a covered material raises an off-contract alert (NTF-14)', async () => {
    const alert = t.db.get<{ id: number; status: string; contract_id: number }>("SELECT * FROM contract_alerts WHERE po_no = '4500021012'")!;
    expect(alert).toBeTruthy();
    expect(alert.contract_id).toBe(byOa('5500000104').id);
    const notes = t.db.all<{ user_id: number }>("SELECT user_id FROM notifications WHERE event = 'NTF-14' AND object_type = 'contract_alert' AND object_id = ?", alert.id).map((n) => n.user_id);
    expect(notes).toEqual(expect.arrayContaining([uid('amit.kulkarni'), uid('vikram.joshi')]));
    // A PO referencing the OA does not raise an alert.
    const before = t.db.scalar<number>('SELECT COUNT(*) FROM contract_alerts');
    sap.sapPut('PO', '4500029901', { po_no: '4500029901', vendor_sap_code: '100102', buyer_email: 'amit.kulkarni@equipcare.test', plant: 'PUN1', po_date: ctx.DAY(0), released: true, version: 1, oa_no: '5500000104', items: [{ item: 10, material_code: 'UCG-2003', description: 'x', qty: 5, uom: 'EA', unit_price: 7600, gst_rate: 18, delivery_date: ctx.DAY(7) }] }, 'Test');
    sap.syncEvent('PO');
    expect(t.db.scalar<number>('SELECT COUNT(*) FROM contract_alerts')).toBe(before);
    // Justification needs a reason and goes to off-contract exception approval.
    const amit = await t.login('amit.kulkarni');
    expect((await amit.post(`/api/contracts/alerts/${alert.id}/justify`, { reason: 'too short' })).status).toBe(400);
    const j = await amit.post(`/api/contracts/alerts/${alert.id}/justify`, { reason: 'Shakti could not deliver within the breakdown window' });
    expect(j.body.status).toBe('Justification pending approval');
    const ap = approvalFor('exc.off_contract', 'contract_alert', alert.id);
    approveAll(ap.id);
    expect(t.db.get<{ status: string }>('SELECT status FROM contract_alerts WHERE id = ?', alert.id)!.status).toBe('Justified');
  });

  it('AC-CON-04: a contract within the renewal lead time is shown Expiring and owner + manager are notified (NTF-13)', async () => {
    const c = byOa('5500000104');
    expect(c.status).toBe('Expiring');
    const users = t.db.all<{ user_id: number }>("SELECT user_id FROM notifications WHERE event = 'NTF-13' AND object_id = ?", c.id).map((n) => n.user_id);
    expect(users).toEqual(expect.arrayContaining([uid('amit.kulkarni'), uid('vikram.joshi')]));
    const amit = await t.login('amit.kulkarni');
    const ren = await amit.get('/api/contracts/renewals');
    expect(ren.body.rows.find((r: any) => r.id === c.id).bucket).toBe('31–45 days');
    // Running the job again does not duplicate the notification.
    const n = t.db.scalar<number>("SELECT COUNT(*) FROM notifications WHERE event = 'NTF-13' AND object_id = ?", c.id);
    await amit.post('/api/contracts/renewals/run');
    expect(t.db.scalar<number>("SELECT COUNT(*) FROM notifications WHERE event = 'NTF-13' AND object_id = ?", c.id)).toBe(n);
  });

  it('AC-CON-05: FDS 12% on price list v3 → expected invoice price is v3 less 12%; earlier PO dates use earlier versions', () => {
    const c = byOa('5500000103');
    const e = S.expectedFdsPrice(c.id, mid('TLS-7002'), '2026-09-21')!;
    expect(e.version).toBe(3);
    expect(e.discount_pct).toBe(12);
    expect(e.expected_price).toBe(30360); // 34,500 × 0.88
    expect(S.expectedFdsPrice(c.id, mid('TLS-7002'), '2026-01-15')!.version).toBe(2);
    expect(S.expectedFdsPrice(c.id, mid('PPE-8001'), '2025-05-01')!.expected_price).toBe(1355.2); // 1,540 × 0.88
    expect(S.expectedFdsPrice(c.id, mid('TLS-7002'), '2025-01-01')).toBeNull();
  });

  it('price-list versions: a new version on an active FDS needs approval and only applies from its effective date', async () => {
    const c = byOa('5500000103');
    const sneha = await t.login('sneha.patil');
    const bad = await sneha.post(`/api/contracts/${c.id}/price-lists`, { effective_from: '2027-01-01', items: [{ material_id: mid('TLS-7002'), list_price: 36000 }] });
    expect(bad.status).toBe(400); // reason required on a contract in force
    const r = await sneha.post(`/api/contracts/${c.id}/price-lists`, { effective_from: '2027-01-01', items: [{ material_id: mid('TLS-7002'), list_price: 36000 }], reason: 'Vendor catalogue revision for Q4 FY27' });
    expect(r.body.status).toBe('Pending approval');
    expect(S.expectedFdsPrice(c.id, mid('TLS-7002'), '2027-02-01')!.version).toBe(3);
    approveAll(approvalFor('contract.approval', 'contract_change', r.body.id).id);
    expect(S.expectedFdsPrice(c.id, mid('TLS-7002'), '2027-02-01')).toMatchObject({ version: 4, expected_price: 31680 });
    expect(S.expectedFdsPrice(c.id, mid('TLS-7002'), S.priceListOn(c.id, '2026-10-16')!.effective_from)!.version).toBe(3);
  });

  it('AC-CON-06: VMI min 10, stock 8 → NTF-15 to vendor and buyer, once per day', async () => {
    const c = byOa('5500000102');
    t.db.run("DELETE FROM notifications WHERE event = 'NTF-15'");
    sap.sapPut('STOCK', 'FLT-4002|PUN1', { material_code: 'FLT-4002', plant: 'PUN1', unrestricted: 8, open_po_qty: 0, vmi: true }, 'Test');
    sap.sapPut('STOCK', 'FLT-4001|PUN1', { material_code: 'FLT-4001', plant: 'PUN1', unrestricted: 60, open_po_qty: 0, vmi: true }, 'Test');
    sap.syncEvent('STOCK');
    S.vmiJob();
    const users = t.db.all<{ user_id: number }>("SELECT user_id FROM notifications WHERE event = 'NTF-15' AND object_id = ?", c.id).map((n) => n.user_id);
    const pooja = uid('pooja.malhotra');
    expect(users).toEqual(expect.arrayContaining([pooja, uid('sneha.patil')]));
    expect(users.filter((u) => u === pooja).length).toBe(1);
    const status = S.vmiStatus(S.getContract(c.id)!);
    expect(status.find((s) => s.material_code === 'FLT-4002')).toMatchObject({ state: 'Below minimum', unrestricted: 8, min: 10 });
    expect(status.find((s) => s.material_code === 'FLT-4001')!.state).toBe('Within range');
  });

  it('FR-CON-09 / approval flow: a platform ARC goes Draft → approval → Pending SAP, cannot route PRs, and becomes Active when the OA syncs', async () => {
    const amit = await t.login('amit.kulkarni');
    // Seeded Bharat ARC is Pending SAP and not used by PR checks.
    const bharat = t.db.get<{ id: number; status: string; sap_oa_no: string | null }>("SELECT * FROM contracts WHERE title LIKE '%Bharat%'")!;
    expect(bharat).toMatchObject({ status: 'Pending SAP', sap_oa_no: null });
    const line = t.db.get<{ id: number }>("SELECT id FROM pr_lines WHERE pr_no = '10045484' AND item = 10")!.id;
    const chk = await amit.post(`/api/pr/lines/${line}/checks`);
    expect(chk.body.checks.contract.valid).toBe(false);
    const det = await amit.get(`/api/contracts/${bharat.id}`);
    expect(det.body.routable).toBe(false);

    // New contract through the API: validation, submit, SoD, return → Draft, resubmit → Pending SAP.
    const opts = await amit.get('/api/contracts/options');
    const vendor = opts.body.vendors.find((v: any) => v.sap_code === '100106').id;
    const invalid = await amit.post('/api/contracts', { type: 'ARC', vendor_id: vendor, title: 'Reman ARC', category: 'HYD', valid_from: '2026-11-01', valid_to: '2026-10-01', payment_terms: '30 days', delivery_terms: 'FOR', items: [{ material_id: mid('HYD-1002'), unit_price: 24000 }] });
    expect(invalid.status).toBe(400);
    const created = await amit.post('/api/contracts', { type: 'ARC', vendor_id: vendor, title: 'Reman ARC – hydraulic motors', category: 'HYD', valid_from: '2026-11-01', valid_to: '2027-10-31', value_cap: 500000, payment_terms: '30 days', delivery_terms: 'FOR destination', items: [{ material_id: mid('HYD-1002'), unit_price: 24000, qty_cap: 20 }], submit: true });
    expect(created.status).toBe(200);
    expect(created.body.status).toBe('Pending approval');
    const ap = approvalFor('contract.approval', 'contract', created.body.id);
    expect(() => approvals.act(ctx.actorFor('amit.kulkarni'), ap.id, 'approve', null)).toThrow();
    approvals.act(ctx.actorFor('vikram.joshi', 'APR'), ap.id, 'return', 'Add the reman warranty clause');
    expect(S.getContract(created.body.id)!.status).toBe('Draft');
    await amit.post(`/api/contracts/${created.body.id}/submit`, { note: 'Warranty clause added' });
    approveAll(approvalFor('contract.approval', 'contract', created.body.id).id);
    expect(S.getContract(created.body.id)!.status).toBe('Pending SAP');

    // SAP creates the OA for Bharat with platform_ref → Active and routable.
    simulateOa(bharat.id, '5500009001');
    const after = S.getContract(bharat.id)!;
    expect(after).toMatchObject({ status: 'Active', sap_oa_no: '5500009001' });
    const chk2 = await amit.post(`/api/pr/lines/${line}/checks`);
    expect(chk2.body.checks.contract).toMatchObject({ valid: true, contract_id: bharat.id });
    expect(t.db.scalar<number>("SELECT COUNT(*) FROM notifications WHERE dedupe_key = ?", `con-active:${bharat.id}`)).toBeGreaterThan(0);
  });

  it('terms change and extension on an active contract go through approval, then SAP; changes are audited before/after', async () => {
    const amit = await t.login('amit.kulkarni');
    const c = byOa('5500000104');
    const none = await amit.post(`/api/contracts/${c.id}/changes`, { fields: { payment_terms: '60 days from GRN' }, reason: 'No real change in this request' });
    expect(none.status).toBe(400);
    const ch = await amit.post(`/api/contracts/${c.id}/changes`, { fields: { payment_terms: '75 days from GRN' }, items: [{ material_id: mid('UCG-2003'), unit_price: 7450 }], reason: 'Volume rebate agreed with Shakti for H2' });
    expect(ch.status).toBe(200);
    const dup = await amit.post(`/api/contracts/${c.id}/extend`, { valid_to: '2027-06-30', reason: 'Bridge until the new ARC RFQ completes' });
    expect(dup.status).toBe(409); // one open change at a time
    approveAll(approvalFor('contract.approval', 'contract_change', ch.body.id).id);
    expect(t.db.get<{ status: string }>('SELECT status FROM contract_changes WHERE id = ?', ch.body.id)!.status).toBe('Pending SAP');
    expect(S.getContract(c.id)!.payment_terms).toBe('60 days from GRN'); // SAP still the record
    simulateOa(c.id);
    expect(t.db.get<{ status: string }>('SELECT status FROM contract_changes WHERE id = ?', ch.body.id)!.status).toBe('Applied');
    expect(S.getContract(c.id)!.payment_terms).toBe('75 days from GRN');
    const ev = t.db.get<{ before: unknown; after: unknown }>("SELECT before_json, after_json FROM audit_events WHERE action = 'contract.change_requested' AND object_id = ?", String(c.id))!;
    expect(JSON.stringify(ev.before)).toContain('60 days');
    expect(JSON.stringify(ev.after)).toContain('75 days');

    const ext = await amit.post(`/api/contracts/${c.id}/extend`, { valid_to: '2027-06-30', reason: 'Bridge until the new ARC RFQ completes' });
    approveAll(approvalFor('contract.renewal', 'contract_change', ext.body.id).id);
    simulateOa(c.id);
    expect(S.getContract(c.id)).toMatchObject({ valid_to: '2027-06-30', status: 'Active' });
  });

  it('renew creates a Draft copy that replaces the old contract for routing once its OA syncs', async () => {
    const sneha = await t.login('sneha.patil');
    const old = byOa('5500000101');
    const r = await sneha.post(`/api/contracts/${old.id}/renew`, { reason: 'Rates benchmarked; renew for FY 2027-28' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'Draft', renewed_from_id: old.id, valid_from: '2027-04-01' });
    expect((await sneha.post(`/api/contracts/${old.id}/renew`, {})).status).toBe(409);
    await sneha.post(`/api/contracts/${r.body.id}/submit`, {});
    approveAll(approvalFor('contract.approval', 'contract', r.body.id).id);
    simulateOa(r.body.id, '5500009002');
    expect(S.getContract(old.id)!.status).toBe('Renewed');
    expect(S.getContract(r.body.id)!.status).toBe('Active');
  });

  it('vendors see only their own contracts, read-only', async () => {
    const nitin = await t.login('nitin');
    const list = await nitin.get('/api/contracts/vendor');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(0);
    expect(list.body.every((c: any) => c.sap_oa_no === '5500000103' || c.contract_no)).toBe(true);
    const own = byOa('5500000103');
    const d = await nitin.get(`/api/contracts/vendor/${own.id}`);
    expect(d.status).toBe(200);
    expect(d.body.price_lists.length).toBe(4);
    expect(d.body.owner_id).toBeUndefined();
    expect((await nitin.get(`/api/contracts/vendor/${byOa('5500000101').id}`)).status).toBe(404);
    expect((await nitin.get(`/api/contracts/${own.id}`)).status).toBe(403);
    expect((await nitin.post(`/api/contracts/${own.id}/terminate`, { reason: 'Vendor trying to terminate' })).status).toBe(403);
  });
});
