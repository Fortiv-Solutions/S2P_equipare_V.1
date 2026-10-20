import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers.ts';

let t: Awaited<ReturnType<typeof startApp>>;
let sap: typeof import('../core/sap.ts');
// Sign-in is rate limited per IP, so each persona signs in once.
const sessions = new Map<string, ReturnType<typeof t.login>>();
const login = (u: string) => { if (!sessions.has(u)) sessions.set(u, t.login(u)); return sessions.get(u)!; };
beforeAll(async () => {
  t = await startApp();
  sap = await import('../core/sap.ts');
});
afterAll(async () => { await t.close(); });

const countDocs = (type: string, key: string) => t.db.scalar<number>('SELECT COUNT(*) FROM sap_documents WHERE doc_type = ? AND doc_key = ?', type, key);
const errFor = (key: string) => t.db.get<any>('SELECT * FROM integration_errors WHERE idempotency_key = ? ORDER BY id DESC', key);

describe('Module 12 — SAP integration (AC-SAP-01..05)', () => {
  it('AC-SAP-01: a PO created and released in SAP is published to the platform at once and the flow is fresh', async () => {
    const amit = await login('amit.kulkarni');
    const vendor = t.db.get<{ id: number }>("SELECT id FROM vendors WHERE sap_code = '100101'")!.id;
    const buyer = t.db.get<{ id: number }>("SELECT id FROM users WHERE email LIKE 'amit.kulkarni@%'")!.id;
    const r = await amit.post('/api/sap/sim/po', { source: 'manual', vendor_id: vendor, plant: 'PUN1', buyer_id: buyer, release: true, items: [{ material_code: 'HYD-1005', qty: 3, unit_price: 2600, delivery_date: '2026-12-01' }] });
    expect(r.status).toBe(200);
    expect(r.body.po_no).toMatch(/^45000220\d\d$/);
    expect(r.body.sync.synced).toBe(true);
    const po = t.db.get<{ status: string; sap_released: number; synced_at: string }>('SELECT status, sap_released, synced_at FROM pos WHERE po_no = ?', r.body.po_no);
    expect(po).toMatchObject({ status: 'Published', sap_released: 1 });
    const neha = await login('neha.gupta');
    const flows = await neha.get('/api/sap/flows');
    const m07 = flows.body.flows.find((f: any) => f.id === 'INT-M07');
    expect(m07.freshness.stale).toBe(false);
    // An unreleased PO is not published (AC-POM-01).
    const draft = await amit.post('/api/sap/sim/po', { source: 'manual', vendor_id: vendor, plant: 'PUN1', buyer_id: buyer, release: false, items: [{ material_code: 'HYD-1005', qty: 1, unit_price: 2600, delivery_date: '2026-12-01' }] });
    expect(t.db.get('SELECT id FROM pos WHERE po_no = ?', draft.body.po_no)).toBeUndefined();
    const rel = await amit.post(`/api/sap/sim/po/${draft.body.po_no}/release`);
    expect(rel.status).toBe(200);
    expect(t.db.get('SELECT id FROM pos WHERE po_no = ?', draft.body.po_no)).toBeTruthy();
  });

  it('AC-SAP-02: a write that timed out after SAP committed gives exactly one SAP document when retried', async () => {
    const neha = await login('neha.gupta');
    const key = 'POACK:TEST-TIMEOUT:10:v1';
    const set = await neha.put('/api/sap/sim/settings', { fail: { 'INT-M08': 'timeout_after_commit' } });
    expect(set.status).toBe(200);
    const w = sap.sapWrite('INT-M08', 'POACK', key, { po_no: 'TEST', item: 10 }, null);
    expect(w.status).toBe('Queued');
    expect(countDocs('POACK', key)).toBe(1); // SAP did commit
    const e = errFor(key);
    expect(e).toMatchObject({ error_type: 'transient', status: 'Retrying' });
    const replay = await neha.post(`/api/sap/errors/${e.id}/replay`, {});
    expect(replay.status).toBe(200);
    expect(countDocs('POACK', key)).toBe(1); // still exactly one
    expect(t.db.get<any>('SELECT status FROM sap_outbound WHERE idempotency_key = ?', key).status).toBe('Written');
    expect(errFor(key).status).not.toBe('Retrying');
    // Replaying again is a harmless duplicate.
    expect(sap.sapWrite('INT-M08', 'POACK', key, {}, null).status).toBe('Duplicate');
    expect(countDocs('POACK', key)).toBe(1);
  });

  it('AC-SAP-03: a business error is queued, never retried automatically, and alerts SAP/IT', async () => {
    const neha = await login('neha.gupta');
    await neha.put('/api/sap/sim/settings', { fail: { 'INT-M08': 'business' } });
    const key = 'POACK:TEST-BUSINESS:10:v1';
    const w = sap.sapWrite('INT-M08', 'POACK', key, { po_no: 'TEST2' }, null);
    expect(w.status).toBe('Failed');
    const e = errFor(key);
    expect(e).toMatchObject({ error_type: 'business', status: 'Failed', attempts: 1 });
    expect(e.next_retry_at).toBeNull();
    sap.retryOutbound();
    expect(errFor(key)).toMatchObject({ status: 'Failed', attempts: 1 });
    expect(countDocs('POACK', key)).toBe(0);
    const n = t.db.get('SELECT id FROM notifications WHERE event = ? AND dedupe_key = ? AND user_id = (SELECT id FROM users WHERE email LIKE ?)', 'NTF-32', `NTF-32:${key}`, 'neha.gupta@%');
    expect(n).toBeTruthy();
    // SAP/IT discards with a reason (audited); a short reason is refused.
    expect((await neha.post(`/api/sap/errors/${e.id}/discard`, { reason: 'too short' })).status).toBe(400);
    const d = await neha.post(`/api/sap/errors/${e.id}/discard`, { reason: 'Locked document no longer needed after SAP clean-up' });
    expect(d.status).toBe(200);
    expect(d.body.status).toBe('Discarded');
    expect(t.db.get("SELECT id FROM audit_events WHERE action = 'integration.discard' AND object_id = ?", String(e.id))).toBeTruthy();
  });

  it('AC-SAP-03 (seed): the inbound GRN for an unknown PO sits in the queue as a business error', async () => {
    const neha = await login('neha.gupta');
    const r = await neha.get('/api/sap/errors?status=open');
    const grn = r.body.find((e: any) => e.doc_key === '5000299999-2026');
    expect(grn).toMatchObject({ flow: 'INT-M10', error_type: 'business', status: 'Failed', direction: 'SAP → S2P', editable: false });
    expect(r.body.some((e: any) => e.doc_key?.startsWith('POACK:4500021006') && e.status === 'Retrying')).toBe(true);
    expect((await neha.get('/api/sap/errors?status=Resolved')).body.length).toBeGreaterThan(0);
  });

  it('AC-SAP-04: the seeded one-line GRN difference is listed by reconciliation, and re-sync after the PO exists clears it', async () => {
    const neha = await login('neha.gupta');
    const run = await neha.post('/api/sap/reconcile');
    expect(run.status).toBe(200);
    const diff = run.body.diffs.find((d: any) => d.object === 'GRN line' && d.key === '5000299999/4500029999/10');
    expect(diff).toBeTruthy();
    expect(diff.issue).toMatch(/missing in platform/);
    expect(diff.action).toMatchObject({ flow: 'INT-M10', doc_type: 'GRN', key: '5000299999-2026' });
    expect(run.body.counts.find((c: any) => c.object === 'GRN / SES lines').sap).toBeGreaterThan(run.body.counts.find((c: any) => c.object === 'GRN / SES lines').platform);
    // Document re-sync from the reconciliation action still fails (PO unknown) and reports the real error.
    const rs = await neha.post('/api/sap/resync', { flow: 'INT-M10', mode: 'document', doc_type: 'GRN', key: '5000299999-2026' });
    expect(rs.status).toBe(200);
    expect(rs.body.ok).toBe(false);
    expect(rs.body.error.error).toMatch(/4500029999/);
    // Unknown key is refused with guidance.
    expect((await neha.post('/api/sap/resync', { flow: 'INT-M10', mode: 'document', doc_type: 'GRN', key: 'nope' })).status).toBe(400);
    // From-date and full re-sync run and are audited.
    expect((await neha.post('/api/sap/resync', { flow: 'INT-M07', mode: 'from_date', from: '2026-01-01' })).body.ok).toBe(true);
    expect((await neha.post('/api/sap/resync', { flow: 'INT-M07', mode: 'full' })).body.ok).toBe(true);
    expect(t.db.get("SELECT id FROM audit_events WHERE action = 'integration.resync_full'")).toBeTruthy();
  });

  it('AC-SAP-05: with SAP offline writes are queued and processed after SAP returns; the platform stays usable', async () => {
    const neha = await login('neha.gupta');
    expect((await neha.put('/api/sap/sim/settings', { offline: true })).status).toBe(200);
    const meta = await neha.get('/api/meta');
    expect(meta.body.sapOffline).toBe(true);
    const key = 'POACK:TEST-OFFLINE:10:v1';
    expect(sap.sapWrite('INT-M08', 'POACK', key, { po_no: 'TEST3' }, null).status).toBe('Queued');
    expect(countDocs('POACK', key)).toBe(0);
    expect(errFor(key).status).toBe('Retrying');
    const back = await neha.put('/api/sap/sim/settings', { offline: false });
    expect(back.status).toBe(200);
    expect(back.body.recovery.queue.written).toBeGreaterThanOrEqual(1);
    expect(countDocs('POACK', key)).toBe(1);
    expect(t.db.get<any>('SELECT status FROM sap_outbound WHERE idempotency_key = ?', key).status).toBe('Written');
    expect((await neha.get('/api/meta')).body.sapOffline).toBe(false);
  });

  it('edit-and-replay corrects an outbound payload and keeps before/after in the audit trail', async () => {
    const neha = await login('neha.gupta');
    await neha.put('/api/sap/sim/settings', { fail: { 'INT-M08': 'business' } });
    const key = 'POACK:TEST-EDIT:10:v1';
    sap.sapWrite('INT-M08', 'POACK', key, { po_no: 'WRONG', item: 10 }, null);
    const e = errFor(key);
    const r = await neha.post(`/api/sap/errors/${e.id}/replay`, { payload: { po_no: 'RIGHT', item: 10 } });
    expect(r.status).toBe(200);
    expect(sap.sapGet<any>('POACK', key)?.payload.po_no).toBe('RIGHT');
    const ev = t.db.get<any>("SELECT before_json, after_json FROM audit_events WHERE action = 'integration.payload_corrected' AND object_id = ?", String(e.id));
    expect(ev.before.po_no).toBe('WRONG');
    expect(ev.after.po_no).toBe('RIGHT');
  });
});

describe('Module 12 — SAP simulator', () => {
  it('is permission-scoped: buyers PO, stores GRN, finance invoices, SAP/IT everything, others nothing', async () => {
    const [amit, suresh, meera, neha, manoj, priya, rajesh] = await Promise.all(['amit.kulkarni', 'suresh.pawar', 'meera.iyer', 'neha.gupta', 'manoj.kale', 'priya.nair', 'rajesh.menon'].map((u) => login(u)));
    // buyer
    expect((await amit.get('/api/sap/sim/po-sources')).status).toBe(200);
    expect((await amit.post('/api/sap/sim/grn', { po_no: '4500021002', items: [{ po_item: 10, qty: 1 }] })).status).toBe(403);
    expect((await amit.post('/api/sap/sim/invoice/INV-26-00005/park')).status).toBe(403);
    expect((await amit.post('/api/sap/sim/pr', { requisitioner_email: 'priya.nair@equipcare.test', items: [] })).status).toBe(403);
    expect((await amit.put('/api/sap/sim/settings', { offline: true })).status).toBe(403);
    // stores
    expect((await suresh.post('/api/sap/sim/po', { source: 'manual' })).status).toBe(403);
    expect((await suresh.get('/api/sap/sim/grn-sources')).status).toBe(200);
    // finance
    expect((await meera.post('/api/sap/sim/po', { source: 'manual' })).status).toBe(403);
    expect((await meera.post('/api/sap/sim/grn', { po_no: '4500021002', items: [] })).status).toBe(403);
    expect((await meera.get('/api/sap/sim/invoices')).status).toBe(200);
    // SAP/IT
    expect((await neha.get('/api/sap/sim/vendors')).status).toBe(200);
    expect((await neha.get('/api/sap/sim/invoices')).status).toBe(200);
    // vendor, requisitioner and management have no simulator
    for (const c of [manoj, priya, rajesh]) expect((await c.get('/api/sap/sim/settings')).status).toBe(403);
    // monitor endpoints: SAP/IT only act; management and finance cannot even view
    expect((await meera.get('/api/sap/flows')).status).toBe(403);
    expect((await amit.post('/api/sap/reconcile')).status).toBe(403);
    const anjali = await login('anjali.verma');
    expect((await anjali.get('/api/sap/flows')).status).toBe(200); // administrator views
    expect((await anjali.post('/api/sap/reconcile')).status).toBe(403); // but cannot act
  });

  it('stores post a GRN for an open PO line (qty <= open), the platform updates, over-receipt is refused', async () => {
    const suresh = await login('suresh.pawar');
    const over = await suresh.post('/api/sap/sim/grn', { po_no: '4500021002', items: [{ po_item: 20, qty: 5 }] });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toMatch(/open/);
    const ok = await suresh.post('/api/sap/sim/grn', { po_no: '4500021002', items: [{ po_item: 20, qty: 1 }] });
    expect(ok.status).toBe(200);
    expect(ok.body.grn_no).toMatch(/^50002000\d\d$/);
    expect(ok.body.sync.synced).toBe(true);
    const line = t.db.get<{ received_qty: number; status: string }>("SELECT l.received_qty, l.status FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE p.po_no = '4500021002' AND l.item = 20");
    expect(line).toMatchObject({ received_qty: 1, status: 'Partially received' });
    // Stores outside the plant scope are refused (Dhanbad PO, Chakan/Nagpur stores).
    expect((await suresh.post('/api/sap/sim/grn', { po_no: '4500021005', items: [{ po_item: 10, qty: 1 }] })).status).toBe(403);
  });

  it('finance control applies in the simulator: park/post refused without finance approval, and the refusal is audited', async () => {
    const meera = await login('meera.iyer');
    const inv = t.db.get<{ inv_ref: string; id: number }>("SELECT inv_ref, id FROM invoices WHERE approved_by IS NULL AND status IN ('Matched','Exception') ORDER BY id")!;
    for (const a of ['park', 'post']) {
      const r = await meera.post(`/api/sap/sim/invoice/${inv.inv_ref}/${a}`);
      expect(r.status).toBe(409);
      expect(r.body.error.message).toMatch(/finance approval/);
    }
    expect(t.db.get('SELECT id FROM sap_documents WHERE doc_type = ? AND doc_key = ?', 'INVSTATUS', inv.inv_ref)).toBeUndefined();
    expect(t.db.get("SELECT id FROM audit_events WHERE action = 'sapsim.invoice_park_refused' AND object_ref = ?", inv.inv_ref)).toBeTruthy();
    // Once finance approves a matched invoice, the simulator parks, posts with a due date and pays.
    const neha = await login('neha.gupta');
    const matched = t.db.get<{ id: number; inv_ref: string }>("SELECT id, inv_ref FROM invoices WHERE status = 'Matched' ORDER BY id")!;
    t.db.run('UPDATE invoices SET approved_by = (SELECT id FROM users WHERE email LIKE ?), approved_at = ? WHERE id = ?', 'meera.iyer@%', new Date().toISOString(), matched.id);
    t.db.run("UPDATE invoice_exceptions SET status = 'Resolved' WHERE invoice_id = ?", matched.id);
    const park = await meera.post(`/api/sap/sim/invoice/${matched.inv_ref}/park`);
    expect(park.status).toBe(200);
    expect(t.db.get<any>('SELECT status FROM invoices WHERE id = ?', matched.id).status).toBe('Parked');
    const post = await meera.post(`/api/sap/sim/invoice/${matched.inv_ref}/post`);
    expect(post.status).toBe(200);
    expect(post.body.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(t.db.get<any>('SELECT status, due_date FROM invoices WHERE id = ?', matched.id)).toMatchObject({ status: 'Posted', due_date: post.body.due_date });
    const blocked = await meera.post(`/api/sap/sim/invoice/${matched.inv_ref}/block`, { reason_internal: 'Short shipment under review by stores', vendor_reason: 'Payment on hold pending delivery confirmation' });
    expect(blocked.status).toBe(200);
    expect(t.db.get<any>('SELECT status, vendor_reason, block_reason_internal FROM invoices WHERE id = ?', matched.id)).toMatchObject({ status: 'Payment blocked', vendor_reason: 'Payment on hold pending delivery confirmation' });
    expect((await meera.post(`/api/sap/sim/invoice/${matched.inv_ref}/unblock`, { reason: 'Stores confirmed full delivery' })).status).toBe(200);
    const pay = await meera.post(`/api/sap/sim/invoice/${matched.inv_ref}/pay`, { tds: 100, deductions: [{ label: 'Debit note DN-1', amount: 50 }] });
    expect(pay.status).toBe(200);
    expect(t.db.get<any>('SELECT status, tds, payment_ref FROM invoices WHERE id = ?', matched.id)).toMatchObject({ status: 'Payment released', tds: 100 });
    void neha;
  });

  it('creates one PO per awarded vendor from a Released-for-PO comparison with RFQ, comparison and PR references', async () => {
    const amit = await login('amit.kulkarni');
    t.db.run("UPDATE comparisons SET status = 'Released for PO' WHERE id = 1");
    const before = (await amit.get('/api/sap/sim/po-sources')).body.comparisons.find((c: any) => c.id === 1);
    expect(before.pending).toBe(2);
    const r = await amit.post('/api/sap/sim/po', { source: 'comparison', comparison_id: 1, release: true });
    expect(r.status).toBe(200);
    expect(r.body.po_nos).toHaveLength(2);
    for (const no of r.body.po_nos) {
      const po = t.db.get<any>('SELECT * FROM pos WHERE po_no = ?', no);
      expect(po).toMatchObject({ comparison_id: 1, rfq_id: 3 });
      expect(po.rfq_date).toBeTruthy();
      const line = t.db.get<any>('SELECT pr_line_id FROM po_lines WHERE po_id = ?', po.id);
      expect(line.pr_line_id).toBeTruthy();
    }
    const again = await amit.post('/api/sap/sim/po', { source: 'comparison', comparison_id: 1 });
    expect(again.status).toBe(409);
    // Not released → refused.
    t.db.run("UPDATE comparisons SET status = 'Approved' WHERE id = 1");
    expect((await amit.post('/api/sap/sim/po', { source: 'comparison', comparison_id: 1 })).status).toBe(409);
  });

  it('PO change and cancel create a new SAP version and republish', async () => {
    const amit = await login('amit.kulkarni');
    const before = t.db.get<{ version: number }>("SELECT version FROM pos WHERE po_no = '4500021010'")!.version;
    const ch = await amit.post('/api/sap/sim/po/4500021010/change', { changes: [{ item: 10, qty: 3, unit_price: 24000 }] });
    expect(ch.status).toBe(200);
    expect(ch.body.version).toBe(before + 1);
    expect(t.db.get<any>("SELECT l.qty, p.version FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE p.po_no = '4500021010'")).toMatchObject({ qty: 3, version: before + 1 });
    // Cannot reduce below received / cancel a PO with receipts.
    expect((await amit.post('/api/sap/sim/po/4500021006/change', { cancel: true })).status).toBe(409);
    expect((await amit.post('/api/sap/sim/po/4500021010/change', { changes: [] })).status).toBe(400);
    const cancel = await amit.post('/api/sap/sim/po/4500021010/change', { changes: [], cancel: true });
    expect(cancel.status).toBe(200);
    expect(t.db.get<any>("SELECT status FROM pos WHERE po_no = '4500021010'").status).toBe('Cancelled');
  });

  it('creates SAP vendor codes and outline agreements only for approved records, and applies stock', async () => {
    const neha = await login('neha.gupta');
    const orion = t.db.get<{ id: number }>("SELECT id FROM vendors WHERE name LIKE 'Orion%'")!.id;
    const early = await neha.post('/api/sap/sim/vendor', { vendor_id: orion });
    expect(early.status).toBe(409); // still Under review
    t.db.run("UPDATE vendors SET onboarding_status = 'Pending SAP code' WHERE id = ?", orion);
    const ok = await neha.post('/api/sap/sim/vendor', { vendor_id: orion });
    expect(ok.status).toBe(200);
    expect(ok.body.sap_code).toMatch(/^1002\d\d$/);
    expect(t.db.get<any>('SELECT sap_code, onboarding_status FROM vendors WHERE id = ?', orion)).toMatchObject({ sap_code: ok.body.sap_code, onboarding_status: 'Active' });
    const suresh = await login('suresh.pawar');
    const st = await suresh.post('/api/sap/sim/stock', { material_code: 'HYD-1001', plant: 'PUN1', unrestricted: 9 });
    expect(st.status).toBe(200);
    const mid = t.db.get<{ id: number }>("SELECT id FROM materials WHERE code = 'HYD-1001'")!.id;
    expect(t.db.get<any>("SELECT unrestricted FROM stock WHERE material_id = ? AND plant = 'PUN1'", mid).unrestricted).toBe(9);
    const amit = await login('amit.kulkarni');
    const oa = t.db.get<{ id: number }>("SELECT id FROM contracts WHERE status = 'Pending SAP'");
    if (oa) {
      const r = await amit.post('/api/sap/sim/oa', { contract_id: oa.id });
      expect(r.status).toBe(200);
      expect(r.body.oa_no).toMatch(/^55000002\d\d$/);
      expect(t.db.get<any>('SELECT sap_oa_no FROM contracts WHERE id = ?', oa.id).sap_oa_no).toBe(r.body.oa_no);
    }
  });

  it('a PR raised in SAP reaches the PR workbench and is assigned a buyer', async () => {
    const neha = await login('neha.gupta');
    const past = await neha.post('/api/sap/sim/pr', { requisitioner_email: 'priya.nair@equipcare.test', items: [{ material_code: 'FLT-4001', qty: 5, plant: 'PUN1', required_date: '2020-01-01' }] });
    expect(past.status).toBe(400);
    const r = await neha.post('/api/sap/sim/pr', { requisitioner_email: 'priya.nair@equipcare.test', items: [{ material_code: 'FLT-4001', qty: 5, plant: 'PUN1', required_date: '2030-01-01', priority: 'Urgent' }] });
    expect(r.status).toBe(200);
    expect(t.db.get<any>('SELECT status, buyer_id, priority FROM pr_lines WHERE pr_no = ?', r.body.pr_no)).toMatchObject({ status: 'Assigned', priority: 'Urgent' });
  });
});
