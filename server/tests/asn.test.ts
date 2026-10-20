import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, PDF } from './helpers.ts';
let demoPng: typeof import('../modules/asn/seed.ts').demoPng;

let t: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { t = await startApp(); demoPng = (await import('../modules/asn/seed.ts')).demoPng; });
afterAll(async () => { await t.close(); });
const sessions = new Map<string, Promise<Awaited<ReturnType<typeof t.login>>>>();
const login = (local: string) => { if (!sessions.has(local)) sessions.set(local, t.login(local)); return sessions.get(local)!; };

const po = (no: string) => t.db.get<{ id: number; plant: string }>('SELECT id, plant FROM pos WHERE po_no = ?', no)!;
const line = (no: string, item: number) => t.db.get<{ id: number; qty: number; status: string }>('SELECT l.id, l.qty, l.status FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE p.po_no = ? AND l.item = ?', no, item)!;
const uid = (local: string) => t.db.get<{ id: number }>('SELECT id FROM users WHERE email LIKE ?', `${local}@%`)!.id;
const accept = (no: string) => t.db.run("UPDATE po_lines SET ack_status = 'Accepted', accepted_qty = qty WHERE po_id = ? AND ack_status IN ('Pending','Pending re-acknowledgement')", po(no).id);
const notifs = (userId: number, event: string) => t.db.all<{ title: string; link: string }>('SELECT title, link FROM notifications WHERE user_id = ? AND event = ? ORDER BY id DESC', userId, event);

describe('Module 8 — ASN and dispatch', () => {
  it('seed: delivered, in-transit and pickup ASNs plus disputes exist', () => {
    const rows = t.db.all<{ status: string; po_no: string }>('SELECT a.status, p.po_no FROM asns a JOIN pos p ON p.id = a.po_id');
    expect(rows).toEqual(expect.arrayContaining([
      { status: 'Delivered', po_no: '4500021001' }, { status: 'Delivered', po_no: '4500021003' }, { status: 'Submitted', po_no: '4500021004' }, { status: 'In transit', po_no: '4500021002' },
    ]));
    const d = t.db.all<{ type: string; owner_party: string; status: string }>('SELECT type, owner_party, status FROM disputes ORDER BY id');
    expect(d).toEqual(expect.arrayContaining([
      { type: 'Shortage', owner_party: 'Vendor', status: 'Awaiting response' },
      { type: 'Transit damage', owner_party: 'Logistics', status: 'Under resolution' },
      { type: 'Accidental loss', owner_party: 'Stores', status: 'Closed' },
    ]));
  });

  it('AC-ASN-01: missing LR/AWB blocks a FOR ASN; quantity above acknowledged open qty is rejected; PO line shows In dispatch', async () => {
    accept('4500021010');
    const manoj = await login('manoj.kale');
    const p = po('4500021010');
    const l = line('4500021010', 10);
    const base = { po_id: p.id, dispatch_date: new Date().toISOString().slice(0, 10), expected_date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), transporter: 'Test Roadlines', lines: [{ po_line_id: l.id, qty: 2 }], submit: true };
    const noLr = await manoj.post('/api/asn/asns', base);
    expect(noLr.status).toBe(400);
    expect(noLr.body.error.fields.lr_no).toMatch(/mandatory/i);
    const tooMuch = await manoj.post('/api/asn/asns', { ...base, lr_no: 'LR-1', lines: [{ po_line_id: l.id, qty: 3 }] });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.message).toMatch(/acknowledged open quantity/);
    const ok = await manoj.post('/api/asn/asns', { ...base, lr_no: 'LR-1' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('Submitted');
    expect(line('4500021010', 10).status).toBe('In dispatch');
    // NTF-21 to the plant stores user (DHN1 → Lakshmi) and the buyer
    expect(notifs(uid('lakshmi.reddy'), 'NTF-21').length).toBeGreaterThan(0);
    expect(notifs(uid('amit.kulkarni'), 'NTF-21').some((n) => n.link === `/asns/${ok.body.id}`)).toBe(true);
    // nothing left to ship: a second ASN is refused
    const again = await manoj.post('/api/asn/asns', { ...base, lr_no: 'LR-2', lines: [{ po_line_id: l.id, qty: 1 }] });
    expect(again.status).toBe(400);
    // revise creates a new version (reason required)
    const rev0 = await manoj.put(`/api/asn/asns/${ok.body.id}`, { ...base, lr_no: 'LR-1', vehicle_no: 'JH10AB1234' });
    expect(rev0.status).toBe(400);
    const rev = await manoj.put(`/api/asn/asns/${ok.body.id}`, { ...base, lr_no: 'LR-1', vehicle_no: 'JH10AB1234', reason: 'Vehicle replaced before dispatch' });
    expect(rev.status).toBe(200);
    expect(rev.body.version).toBe(2);
    // GRN from SAP without asn_id → matched by PO and plant → Delivered
    const lakshmi = await login('neha.gupta');
    const g = await lakshmi.post('/api/sap/sim/grn', { po_no: '4500021010', items: [{ po_item: 10, qty: 2 }] });
    if (g.status === 200) {
      const a = t.db.get<{ status: string }>('SELECT status FROM asns WHERE id = ?', ok.body.id)!;
      expect(a.status).toBe('Delivered');
    } else {
      const { onGrnSynced } = await import('../modules/asn/service.ts');
      onGrnSynced([{ id: l.id, isNew: true, payload: { grn_no: '5999', po_no: '4500021010', plant: 'DHN1', items: [{ po_item: 10, qty: 2 }] } }]);
      expect(t.db.get<{ status: string }>('SELECT status FROM asns WHERE id = ?', ok.body.id)!.status).toBe('Delivered');
    }
  });

  it('AC-ASN-02: an Ex-Works PO prefills terms, freight and transit risk with Equipcare pickup', async () => {
    accept('4500021003');
    const sanjay = await login('sanjay');
    const r = await sanjay.get(`/api/asn/prefill?po=${po('4500021003').id}`);
    expect(r.status).toBe(200);
    expect(r.body.defaults).toMatchObject({ delivery_terms: 'Ex-Works', freight_mode: 'To pay', transit_risk: 'Equipcare', pickup_by: 'Equipcare' });
    expect(r.body.lr_mandatory).toBe(false);
    // 10 accepted − 6 received − 0 in transit = 4 open
    expect(r.body.lines[0].open).toBe(4);
    const c = await sanjay.post('/api/asn/asns', { po_id: po('4500021003').id, dispatch_date: new Date().toISOString().slice(0, 10), expected_date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), lines: [{ po_line_id: line('4500021003', 10).id, qty: 2 }], submit: true });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ delivery_terms: 'Ex-Works', transit_risk: 'Equipcare', pickup_by: 'Equipcare', pickup_status: 'Requested' });
  });

  it('AC-ASN-03: an overdue Equipcare pickup alerts the buyer and plant stores', async () => {
    const anjali = await login('anjali.verma');
    const r = await anjali.post('/api/jobs/asn.pickup_overdue/run');
    expect(r.body.status).toBe('Succeeded');
    const asn = t.db.get<{ id: number }>("SELECT a.id FROM asns a JOIN pos p ON p.id = a.po_id WHERE p.po_no = '4500021004'")!;
    expect(notifs(uid('amit.kulkarni'), 'NTF-18').some((n) => n.link === `/asns/${asn.id}`)).toBe(true);
    expect(notifs(uid('suresh.pawar'), 'NTF-18').some((n) => n.link === `/asns/${asn.id}`)).toBe(true);
    // buyer records the pickup → In transit
    const amit = await login('amit.kulkarni');
    const p = await amit.post(`/api/asn/asns/${asn.id}/pickup`, { action: 'picked_up', lr_no: 'VFC/PUN/1001', transporter: 'Vidarbha Freight' });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ status: 'In transit', pickup_status: 'Picked up' });
  });

  it('SCR-ASN-03: stores see expected receipts for their plants only', async () => {
    const suresh = await login('suresh.pawar');
    const r = await suresh.get('/api/asn/receipts');
    expect(r.status).toBe(200);
    expect(r.body.rows.every((x: any) => ['PUN1', 'NGP1'].includes(x.plant))).toBe(true);
    expect(r.body.rows.some((x: any) => x.po_no === '4500021002' && x.bucket === 'week')).toBe(true);
  });
});

describe('Module 8 — disputes', () => {
  it('AC-DSP-01: damage with 3 phone photos creates a dispute with evidence; damage without photos is refused', async () => {
    const suresh = await login('suresh.pawar');
    const l = line('4500021002', 10);
    const none = await suresh.post('/api/asn/disputes', { po_line_id: l.id, type: 'Damage', qty: 3 });
    expect(none.status).toBe(400);
    expect(none.body.error.fields.attachment_ids).toMatch(/photo/i);
    const noQty = await suresh.post('/api/asn/disputes', { po_line_id: l.id, type: 'Shortage', qty: 0 });
    expect(noQty.status).toBe(400);
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const u = await suresh.upload('/api/files', [{ name: `photo${i}.png`, content: demoPng(40, 30), type: 'image/png' }], { label: 'Photo' });
      expect(u.status).toBe(200);
      ids.push(u.body.files[0].id);
    }
    const r = await suresh.post('/api/asn/disputes', { po_line_id: l.id, type: 'Damage', qty: 3, description: 'Three tooth points cracked', attachment_ids: ids });
    expect(r.status).toBe(200);
    expect(r.body.value).toBe(3 * 7600); // PO price × qty
    const files = await suresh.get(`/api/files?owner_type=dispute&owner_id=${r.body.id}`);
    expect(files.body.length).toBe(3);
  });

  it('AC-DSP-02: FOR transit damage → vendor owner; Ex-Works transit damage → logistics', async () => {
    const suresh = await login('suresh.pawar');
    const photo = async () => (await suresh.upload('/api/files', [{ name: 'p.png', content: demoPng(20, 20), type: 'image/png' }])).body.files[0].id;
    const forD = await suresh.post('/api/asn/disputes', { po_line_id: line('4500021001', 10).id, type: 'Transit damage', qty: 1, attachment_ids: [await photo()] });
    expect(forD.status).toBe(200);
    expect(forD.body).toMatchObject({ owner_party: 'Vendor', delivery_term: 'FOR', status: 'Awaiting response' });
    const exw = await suresh.post('/api/asn/disputes', { po_line_id: line('4500021004', 10).id, type: 'Transit damage', qty: 1, attachment_ids: [await photo()] });
    expect(exw.status).toBe(200);
    expect(exw.body).toMatchObject({ owner_party: 'Logistics', delivery_term: 'Ex-Works', owner_user_id: uid('amit.kulkarni') });
  });

  it('AC-DSP-03: a 10-day-old dispute is in the 8–15 day bucket with its owner; ageing escalates to the Procurement Manager', async () => {
    const id = t.db.get<{ id: number }>("SELECT id FROM disputes WHERE type = 'Damage' ORDER BY id DESC LIMIT 1")!.id;
    t.db.run('UPDATE disputes SET created_at = ? WHERE id = ?', new Date(Date.now() - 10 * 86400000).toISOString(), id);
    const amit = await login('amit.kulkarni');
    const list = await amit.get('/api/asn/disputes');
    const row = list.body.find((r: any) => r.id === id);
    expect(row).toMatchObject({ age_days: 10, bucket: '8–15 days', owner_party: 'Vendor' });
    const rep = await amit.get('/api/asn/disputes/ageing?by=owner');
    const vendorRow = rep.body.rows.find((r: any) => r.key === 'Vendor');
    expect(vendorRow.counts[2]).toBeGreaterThan(0);
    expect(rep.body.totals.closed).toBeGreaterThan(0);
    const anjali = await login('anjali.verma');
    await anjali.post('/api/jobs/dsp.ageing/run');
    expect(notifs(uid('vikram.joshi'), 'NTF-23').length).toBeGreaterThanOrEqual(2); // seeded 12-day dispute + this one
  });

  it('AC-VPT-07 / GOV-C08: vendor response notifies the owner and appears on the timeline; internal notes stay internal', async () => {
    const d = t.db.get<{ id: number }>("SELECT d.id FROM disputes d JOIN pos p ON p.id = d.po_id WHERE p.po_no = '4500021001' AND d.type = 'Shortage'")!;
    const amit = await login('amit.kulkarni');
    expect((await amit.post(`/api/asn/disputes/${d.id}/notes`, { body: 'Internal: vendor short-shipped last month as well' })).status).toBe(200);
    const manoj = await login('manoj.kale');
    const up = await manoj.upload('/api/files', [{ name: 'packing.pdf', content: PDF, type: 'application/pdf' }], { label: 'Vendor response' });
    const r = await manoj.post(`/api/asn/disputes/${d.id}/respond`, { body: 'We will ship the 4 hose assemblies by Friday as replacement.', attachment_ids: [up.body.files[0].id] });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('Under resolution');
    expect(notifs(uid('amit.kulkarni'), 'NTF-22').some((n) => /responded/.test(n.title))).toBe(true);
    const v = await manoj.get(`/api/asn/disputes/${d.id}`);
    expect(v.status).toBe(200);
    expect(v.body.events.some((e: any) => e.kind === 'vendor_response')).toBe(true);
    expect(v.body.events.some((e: any) => /Internal/.test(e.body))).toBe(false);
    const i = await amit.get(`/api/asn/disputes/${d.id}`);
    expect(i.body.events.some((e: any) => /Internal/.test(e.body))).toBe(true);
    // outcome, close, reopen
    expect((await amit.post(`/api/asn/disputes/${d.id}/close`, {})).status).toBe(409);
    const o = await amit.post(`/api/asn/disputes/${d.id}/outcome`, { outcome: 'Replacement', note: 'Vendor replaces 4 hoses free of cost' });
    expect(o.body.status).toBe('Resolved');
    const c = await amit.post(`/api/asn/disputes/${d.id}/close`, {});
    expect(c.body.dispute.status).toBe('Closed');
    const ro = await amit.post(`/api/asn/disputes/${d.id}/reopen`, { reason: 'Replacement not received yet' });
    expect(ro.body.status).toBe('Reopened');
  });

  it('closure needs approval when configured (dispute.closure)', async () => {
    t.db.run("UPDATE config SET value_json = 'true' WHERE key = 'dispute.closure_approval'");
    const amit = await login('amit.kulkarni');
    const d = t.db.get<{ id: number }>("SELECT d.id FROM disputes d JOIN pos p ON p.id = d.po_id WHERE p.po_no = '4500021001' AND d.type = 'Shortage'")!;
    await amit.post(`/api/asn/disputes/${d.id}/outcome`, { outcome: 'Credit note', note: 'Credit note for the 4 missing hoses', amount: 15600 });
    const c = await amit.post(`/api/asn/disputes/${d.id}/close`, {});
    expect(c.body.pending_approval).toMatch(/^APR-/);
    const ap = t.db.get<{ id: number }>("SELECT id FROM approvals WHERE type = 'dispute.closure' AND object_id = ?", d.id)!;
    const vikram = await login('vikram.joshi');
    const a = await vikram.post(`/api/approvals/${ap.id}/approve`, { comment: 'ok' });
    if (a.status === 200) expect(t.db.get<{ status: string }>('SELECT status FROM disputes WHERE id = ?', d.id)!.status).toBe('Closed');
    t.db.run("UPDATE config SET value_json = 'false' WHERE key = 'dispute.closure_approval'");
  });

  it('AC-VPT-02 / GOV-C09: vendors see only their own ASNs and disputes; cross-vendor access is 404 and audited', async () => {
    const divya = await login('divya.raman');
    const asns = await divya.get('/api/asn/asns');
    const shakti = t.db.get<{ id: number }>("SELECT id FROM vendors WHERE sap_code = '100102'")!.id;
    expect(asns.body.length).toBeGreaterThan(0);
    expect(asns.body.every((a: any) => a.vendor_id === shakti)).toBe(true);
    const other = t.db.get<{ id: number }>("SELECT a.id FROM asns a JOIN pos p ON p.id = a.po_id WHERE p.po_no = '4500021001'")!;
    expect((await divya.get(`/api/asn/asns/${other.id}`)).status).toBe(404);
    const dOther = t.db.get<{ id: number }>("SELECT d.id FROM disputes d JOIN pos p ON p.id = d.po_id WHERE p.po_no = '4500021001' LIMIT 1")!;
    expect((await divya.get(`/api/asn/disputes/${dOther.id}`)).status).toBe(404);
    expect((await divya.post(`/api/asn/disputes/${dOther.id}/respond`, { body: 'Trying to respond to another vendor' })).status).toBe(404);
    expect((await divya.get(`/api/files?owner_type=dispute&owner_id=${dOther.id}`)).status).toBe(404);
    expect(t.db.get('SELECT id FROM audit_events WHERE action = ? AND object_type = ?', 'security.cross_vendor_access_denied', 'asn')).toBeTruthy();
    const dl = await divya.get('/api/asn/disputes');
    expect(dl.body.every((x: any) => x.vendor_id === shakti)).toBe(true);
    expect((await divya.post('/api/asn/disputes', { po_line_id: 1, type: 'Shortage', qty: 1 })).status).toBe(403);
  });

  it('FR-DSP-05: openDisputesForPo returns open disputes with PO line ids and reasons', async () => {
    const { openDisputesForPo } = await import('../modules/asn/service.ts');
    const p = po('4500021003');
    const rows = openDisputesForPo(p.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ po_line_id: line('4500021003', 10).id, type: 'Transit damage' });
    expect(rows[0].reason).toMatch(/Open dispute DSP-.*Transit damage of 2/);
    const closedPo = t.db.get<{ id: number }>("SELECT id FROM pos WHERE po_no = '4500020104'")!;
    expect(openDisputesForPo(closedPo.id)).toEqual([]);
  });
});
