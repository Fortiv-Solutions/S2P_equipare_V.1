import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers.ts';

let t: Awaited<ReturnType<typeof startApp>>;
let S: typeof import('../modules/po/service.ts');
let sap: typeof import('../core/sap.ts');
let approvals: typeof import('../core/approvals.ts');
let ctx: typeof import('../seed/ctx.ts');

beforeAll(async () => {
  t = await startApp();
  S = await import('../modules/po/service.ts');
  sap = await import('../core/sap.ts');
  approvals = await import('../core/approvals.ts');
  ctx = await import('../seed/ctx.ts');
});
afterAll(async () => { await t.close(); });

// Sign-in is rate limited (20/min): reuse one session per persona.
const sessions = new Map<string, Awaited<ReturnType<typeof t.login>>>();
const login = async (who: string) => { if (!sessions.has(who)) sessions.set(who, await t.login(who)); return sessions.get(who)!; };

const poId = (no: string) => t.db.get<{ id: number }>('SELECT id FROM pos WHERE po_no = ?', no)!.id;
const lineOf = (no: string, item: number) => t.db.get<any>('SELECT l.* FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE p.po_no = ? AND l.item = ?', no, item)!;
const setCfg = (key: string, value: unknown) => t.db.run('UPDATE config SET value_json = ? WHERE key = ?', JSON.stringify(value), key);
const DAY = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

/** Put a new released PO into the SAP simulator and run the INT-M07 sync. */
function newSapPo(no: string, vendor: string, items: { item: number; code: string; qty: number; price: number }[], extra: Record<string, unknown> = {}) {
  sap.sapPut('PO', no, {
    po_no: no, vendor_sap_code: vendor, buyer_email: 'amit.kulkarni@equipcare.test', plant: 'PUN1', po_date: DAY(0), released: true, version: 1,
    delivery_terms: 'FOR destination', payment_terms: '45 days from GRN', urgency: 'General stock',
    items: items.map((i) => ({ item: i.item, material_code: i.code, description: `Test item ${i.code}`, qty: i.qty, uom: 'EA', unit_price: i.price, gst_rate: 18, delivery_date: DAY(10) })),
    ...extra,
  }, 'Test');
  sap.syncEvent('PO');
  return poId(no);
}

/** Approve every pending step of an approval as the given persona until it closes. */
function approveAll(approvalId: number, personas: string[]) {
  for (const p of personas) {
    const a = approvals.getApproval(approvalId)!;
    if (a.status !== 'Pending') break;
    approvals.act(ctx.actorFor(p), approvalId, 'approve', null);
  }
  return approvals.getApproval(approvalId)!;
}

describe('Module 7 — PO publication and acknowledgement', () => {
  it('AC-POM-01: released POs are published to the vendor with NTF-16; an unreleased PO (4500021011) is not visible', async () => {
    expect(t.db.get('SELECT id FROM pos WHERE po_no = ?', '4500021011')).toBeUndefined();
    const imran = await login('imran');
    const list = await imran.get('/api/po/vendor/pos');
    expect(list.status).toBe(200);
    const nos = list.body.map((p: any) => p.po_no);
    expect(nos).toContain('4500021004');
    expect(nos).not.toContain('4500021011');
    const n = t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.event = 'NTF-16' AND n.object_id = ? AND u.email LIKE 'imran@%'", poId('4500021004'))!;
    expect(n.n).toBe(1);
    // Releasing it in SAP publishes it.
    const p = sap.sapGet<any>('PO', '4500021011')!.payload;
    sap.sapPut('PO', '4500021011', { ...p, released: true }, 'Test');
    sap.syncEvent('PO');
    const after = await imran.get('/api/po/vendor/pos');
    expect(after.body.map((x: any) => x.po_no)).toContain('4500021011');
    expect(after.body[0].to_acknowledge).toBe(true); // "to acknowledge" first
  });

  it('first vendor open sets viewed_at (4500021010) and the PO document downloads as PDF', async () => {
    const manoj = await login('manoj.kale');
    const id = poId('4500021010');
    expect(t.db.get<any>('SELECT viewed_at FROM pos WHERE id = ?', id).viewed_at).toBeNull();
    const r = await manoj.get(`/api/po/vendor/pos/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.viewed_at).toBeTruthy();
    const pdf = await fetch(`${t.base}/api/po/vendor/pos/${id}/pdf`, { headers: { cookie: (manoj as any).cookie } });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toContain('application/pdf');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('AC-POM-02: accept / partial 40 of 50 / reject with reason; reject alerts the buyer immediately', async () => {
    const id = newSapPo('4500029001', '100101', [{ item: 10, code: 'HYD-1001', qty: 50, price: 18000 }, { item: 20, code: 'HYD-1003', qty: 50, price: 3900 }, { item: 30, code: 'HYD-1005', qty: 50, price: 2600 }]);
    const [l10, l20, l30] = [10, 20, 30].map((i) => lineOf('4500029001', i));
    const manoj = await login('manoj.kale');
    const url = `/api/po/vendor/pos/${id}/acknowledge`;
    const noReason = await manoj.post(url, { lines: [{ line_id: l20.id, decision: 'partial', accepted_qty: 40, commit_date: DAY(8) }] });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.fields['lines.0.reason']).toBeTruthy();
    const fullQty = await manoj.post(url, { lines: [{ line_id: l20.id, decision: 'partial', accepted_qty: 50, commit_date: DAY(8), reason: 'Testing an invalid partial quantity' }] });
    expect(fullQty.body.error.fields['lines.0.accepted_qty']).toBeTruthy();
    const rejectNoReason = await manoj.post(url, { lines: [{ line_id: l30.id, decision: 'reject' }] });
    expect(rejectNoReason.status).toBe(400);
    const ok = await manoj.post(url, { lines: [
      { line_id: l10.id, decision: 'accept', commit_date: DAY(7), remarks: 'Packed in two cartons' },
      { line_id: l20.id, decision: 'partial', accepted_qty: 40, commit_date: DAY(8), reason: 'Only 40 hose assemblies in stock this month' },
      { line_id: l30.id, decision: 'reject', reason: 'This O-ring kit is discontinued by the OEM' },
    ] });
    expect(ok.status).toBe(200);
    expect(ok.body.sap_mode).toBe('platform'); // DEC-25 off: platform is the record
    expect(lineOf('4500029001', 10)).toMatchObject({ ack_status: 'Accepted', accepted_qty: 50, commit_date: DAY(7), first_commit_date: DAY(7) });
    expect(lineOf('4500029001', 20)).toMatchObject({ ack_status: 'Partially accepted', accepted_qty: 40 });
    expect(lineOf('4500029001', 30)).toMatchObject({ ack_status: 'Rejected', accepted_qty: 0 });
    const alert = t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.event = 'NTF-19' AND n.object_id = ? AND u.email LIKE 'amit.kulkarni@%' AND n.title LIKE 'Vendor rejected%'", id)!;
    expect(alert.n).toBe(1);
    const again = await manoj.post(url, { lines: [{ line_id: l10.id, decision: 'accept', commit_date: DAY(9) }] });
    expect(again.status).toBe(400); // already acknowledged — use Update commitment
    const fu = t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM po_followups WHERE po_id = ? AND kind = 'Vendor update'", id)!;
    expect(fu.n).toBe(3);
  });

  it('INT-M08: when sap.write.ack is on, the acknowledgement is written to SAP with an idempotency key and its real status', async () => {
    setCfg('sap.write.ack', true);
    const id = newSapPo('4500029002', '100101', [{ item: 10, code: 'HYD-1001', qty: 5, price: 18000 }]);
    const manoj = await login('manoj.kale');
    const r = await manoj.post(`/api/po/vendor/pos/${id}/acknowledge`, { lines: [{ line_id: lineOf('4500029002', 10).id, decision: 'accept', commit_date: DAY(5) }] });
    expect(r.status).toBe(200);
    expect(r.body.results[0].sap).toMatchObject({ key: 'POACK:4500029002:10:1', status: 'Written' });
    const d = await manoj.get(`/api/po/vendor/pos/${id}`);
    expect(d.body.lines[0].sap_ack.status).toBe('Written');
    setCfg('sap.write.ack', false);
  });

  it('AC-VPT-02: vendor A requesting vendor B\'s PO gets not-found and the attempt is audited', async () => {
    const manoj = await login('manoj.kale');
    const id = poId('4500021002'); // Shakti's PO
    const r = await manoj.get(`/api/po/vendor/pos/${id}`);
    expect(r.status).toBe(404);
    const pdf = await manoj.get(`/api/po/vendor/pos/${id}/pdf`);
    expect(pdf.status).toBe(404);
    const ev = t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'security.cross_vendor_access_denied' AND object_type = 'po' AND object_id = ?", String(id))!;
    expect(ev.n).toBeGreaterThanOrEqual(2);
    expect((await manoj.get('/api/po/lines')).status).toBe(403);
  });

  it('FR-POM-11: a requisitioner sees a PO for their own PR lines without prices, and not other POs', async () => {
    const priya = await login('priya.nair');
    const r = await priya.get(`/api/po/pos/${poId('4500021001')}`);
    expect(r.status).toBe(200);
    expect(r.body.view).toBe('requisitioner');
    expect(r.body.total_value).toBeNull();
    expect(r.body.lines.every((l: any) => l.unit_price === null && l.line_value === null && l.commit_date)).toBe(true);
    expect((await priya.get(`/api/po/pos/${poId('4500021003')}`)).status).toBe(404); // Rahul's PR
    expect((await priya.get(`/api/po/pos/${poId('4500021001')}/pdf`)).status).toBe(403);
  });
});

describe('Module 7 — open PO follow-up', () => {
  it('AC-POM-04/05: Class 1 filter works and the newest PO comes first', async () => {
    const amit = await login('amit.kulkarni');
    const c1 = await amit.get('/api/po/lines?urgency=Class%201');
    expect(c1.status).toBe(200);
    expect(c1.body.length).toBeGreaterThan(0);
    expect(c1.body.every((r: any) => r.urgency === 'Class 1')).toBe(true);
    expect(c1.body.map((r: any) => r.po_no)).toContain('4500021005');
    const all = await amit.get('/api/po/lines?tab=all');
    const dates = all.body.map((r: any) => r.po_date);
    expect([...dates].sort().reverse()).toEqual(dates);
    const ranged = await amit.get(`/api/po/lines?po_from=${DAY(-10)}&po_to=${DAY(-4)}`);
    expect(ranged.body.every((r: any) => r.po_date >= DAY(-10) && r.po_date <= DAY(-4))).toBe(true);
    const rfq = await amit.get(`/api/po/lines?rfq_from=${DAY(-30)}`);
    expect(rfq.body.every((r: any) => r.rfq_date && r.rfq_date >= DAY(-30))).toBe(true);
  });

  it('AC-POM-06: follow-up history keeps old and new commitment, delay reason and next action date', async () => {
    const sneha = await login('sneha.patil');
    const r = await sneha.get(`/api/po/pos/${poId('4500021003')}`);
    const l = r.body.lines[0];
    expect(l.commitment_history.length).toBe(2);
    expect(l.first_commit_date).toBe(DAY(-6));
    expect(l.commit_date).toBe(DAY(2));
    expect(l.delay_reason).toBe('Transport unavailable');
    expect(l.next_action_date).toBe(DAY(1));
    expect(r.body.followups.some((f: any) => f.kind === 'Call' && f.next_action_date === DAY(1))).toBe(true);
    // Later commitment changes need a delay reason code.
    const sanjay = await login('sanjay');
    const bad = await sanjay.post(`/api/po/vendor/lines/${l.id}/commitment`, { commit_date: DAY(4), delay_reason: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.delay_reason).toBeTruthy();
    const ok = await sanjay.post(`/api/po/vendor/lines/${l.id}/commitment`, { commit_date: DAY(4), delay_reason: 'Transport unavailable' });
    expect(ok.status).toBe(200);
    const again = await sneha.get(`/api/po/pos/${poId('4500021003')}`);
    expect(again.body.lines[0].commitment_history.length).toBe(3);
    expect(again.body.lines[0].first_commit_date).toBe(DAY(-6));
    // Buyer logs a follow-up with commitment, delay reason and next action date.
    const fu = await sneha.post(`/api/po/pos/${poId('4500021003')}/followups`, { po_line_id: l.id, kind: 'Call', note: 'Vendor confirmed truck booked', commit_date: DAY(5), delay_reason: 'Transport unavailable', next_action_date: DAY(3) });
    expect(fu.status).toBe(200);
    expect(lineOf('4500021003', 10)).toMatchObject({ commit_date: DAY(5), next_action_date: DAY(3) });
  });

  it('AC-POM-07: one automatic acknowledgement reminder is logged, and manual reminders are logged too', async () => {
    const id = newSapPo('4500029003', '100101', [{ item: 10, code: 'HYD-1001', qty: 2, price: 18000 }]);
    const past = new Date(Date.now() - 30 * 3600000).toISOString();
    t.db.run('UPDATE pos SET published_at = ?, ack_due_at = ? WHERE id = ?', past, past, id);
    t.db.run('UPDATE po_publications SET published_at = ? WHERE po_id = ?', past, id);
    S.followupJob();
    S.followupJob();
    const n = t.db.all<any>("SELECT * FROM po_followups WHERE po_id = ? AND kind = 'Reminder'", id);
    expect(n.length).toBe(1);
    expect(n[0].meta.type).toBe('ack');
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE event = 'NTF-17' AND object_id = ?", id)!.n).toBe(1);
    const amit = await login('amit.kulkarni');
    const m = await amit.post('/api/po/remind', { po_ids: [id, poId('4500021006')] });
    expect(m.body.succeeded).toBe(1); // 21006 is closed — nothing to remind
    expect(m.body.failed).toBe(1);
    const lines = await amit.get(`/api/po/lines?po_id=${id}`);
    expect(lines.body[0].reminders).toBe(2);
    expect(lines.body[0].needs_action).toBe(true);
  });

  it('FR-POM-08: escalation goes to the buyer\'s manager at level 2 and Management at level 3; requisitioner informed', async () => {
    const id = poId('4500021005');
    expect(t.db.get<any>("SELECT meta_json FROM po_followups WHERE po_id = ? AND kind = 'Escalation'", id)).toBeTruthy(); // seeded level 2
    const amit = await login('amit.kulkarni');
    const noReason = await amit.post(`/api/po/pos/${id}/escalate`, { reason: 'short' });
    expect(noReason.status).toBe(400);
    const r = await amit.post(`/api/po/pos/${id}/escalate`, { reason: 'Class 1 bearing still not acknowledged after calls' });
    expect(r.status).toBe(200);
    expect(r.body.level).toBe(3);
    const mgt = t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.event = 'NTF-19' AND n.object_id = ? AND u.email LIKE 'rajesh.menon@%'", id)!;
    expect(mgt.n).toBe(1);
    const req = t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.event = 'NTF-19' AND n.object_id = ? AND u.email LIKE 'farhan.qureshi@%'", id)!;
    expect(req.n).toBeGreaterThan(0);
    expect((await amit.post(`/api/po/pos/${id}/escalate`, { reason: 'Trying beyond the last escalation level' })).status).toBe(409);
  });

  it('AC-POM-03: deemed acceptance (DEC-16, off by default) marks lines Deemed accepted and still lists them as non-response', async () => {
    const id = newSapPo('4500029004', '100102', [{ item: 10, code: 'UCG-2003', qty: 10, price: 7600 }]);
    const past = new Date(Date.now() - 80 * 3600000).toISOString();
    t.db.run('UPDATE po_publications SET published_at = ? WHERE po_id = ?', past, id);
    t.db.run('UPDATE pos SET ack_due_at = ? WHERE id = ?', past, id);
    S.followupJob();
    expect(lineOf('4500029004', 10).ack_status).toBe('Pending'); // off by default
    setCfg('po.deemed_acceptance', { enabled: true, hours: 72 });
    S.followupJob();
    expect(lineOf('4500029004', 10).ack_status).toBe('Deemed accepted');
    expect(t.db.get<any>('SELECT deemed_accepted FROM pos WHERE id = ?', id).deemed_accepted).toBe(1);
    const amit = await login('amit.kulkarni');
    const rep = await amit.get('/api/po/reports/non-response');
    expect(rep.body.some((r: any) => r.po_no === '4500029004' && r.ack_status === 'Deemed accepted')).toBe(true);
    setCfg('po.deemed_acceptance', { enabled: false, hours: 72 });
  });
});

describe('Module 7 — amendments and cancellation (FR-POM-09, WF-13)', () => {
  it('quantity amendment: request → approval → SAP change → Republished → vendor re-acknowledges', async () => {
    const amit = await login('amit.kulkarni');
    const id = poId('4500021004');
    const line = lineOf('4500021004', 10);
    const bad = await amit.post(`/api/po/pos/${id}/amendments`, { type: 'Quantity', reason: 'short', lines: [{ line_id: line.id, qty: 2 }] });
    expect(bad.status).toBe(400);
    const r = await amit.post(`/api/po/pos/${id}/amendments`, { type: 'Quantity', reason: 'Second turbocharger needed for the standby engine', lines: [{ line_id: line.id, qty: 2 }] });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('Requested');
    const dup = await amit.post(`/api/po/pos/${id}/amendments`, { type: 'Date', reason: 'Another change while the first is open', lines: [{ line_id: line.id, delivery_date: DAY(5) }] });
    expect(dup.status).toBe(409);
    const ap = approvals.getApproval(r.body.approval_id)!;
    expect(ap.type).toBe('po.amendment');
    expect(() => approvals.act(ctx.actorFor('amit.kulkarni'), ap.id, 'approve', null)).toThrow(); // SoD
    approveAll(ap.id, ['vikram.joshi']);
    expect(S.getAmendment(r.body.id)!.status).toBe('Approved');
    expect(t.db.get<any>('SELECT sap_change_pending FROM pos WHERE id = ?', id).sap_change_pending).toBe(1);
    const prep = await amit.post(`/api/po/amendments/${r.body.id}/sap-request`);
    expect(prep.status).toBe(200);
    expect(prep.body.body.changes).toEqual([{ item: 10, qty: 2 }]);
    // Simulate the SAP side: new version with the changed quantity.
    const p = sap.sapGet<any>('PO', '4500021004')!.payload;
    sap.sapPut('PO', '4500021004', { ...p, version: 2, amendment_id: r.body.id, items: p.items.map((i: any) => ({ ...i, qty: 2 })) }, 'Test');
    sap.syncEvent('PO');
    const amd = S.getAmendment(r.body.id)!;
    expect(amd.status).toBe('Republished');
    expect(amd.sap_changed_at).toBeTruthy();
    expect(lineOf('4500021004', 10).ack_status).toBe('Pending re-acknowledgement');
    expect(t.db.get<any>('SELECT sap_change_pending, version FROM pos WHERE id = ?', id)).toMatchObject({ sap_change_pending: 0, version: 2 });
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE event = 'NTF-20' AND object_id = ? AND title LIKE '%version 2%'", id)!.n).toBeGreaterThan(0);
    const imran = await login('imran');
    const ack = await imran.post(`/api/po/vendor/pos/${id}/acknowledge`, { lines: [{ line_id: line.id, decision: 'accept', commit_date: DAY(3) }] });
    expect(ack.status).toBe(200);
    expect(S.getAmendment(r.body.id)!.status).toBe('Re-acknowledged');
  });

  it('price amendment needs po.amendment and exc.price_amendment approvals (seeded 4500021002/20, ₹38,000 → ₹39,500)', async () => {
    const amd = t.db.get<any>("SELECT a.* FROM po_amendments a JOIN pos p ON p.id = a.po_id WHERE p.po_no = '4500021002' AND a.type = 'Price'")!;
    const changes = amd.changes;
    expect(changes.lines[0]).toMatchObject({ item: 20, old: { unit_price: 38000 }, new: { unit_price: 39500 } });
    approveAll(amd.approval_id, ['vikram.joshi']);
    expect(S.getAmendment(amd.id)!.status).toBe('Requested');
    const exc = t.db.get<any>("SELECT * FROM approvals WHERE object_type = 'po_amendment' AND object_id = ? AND type = 'exc.price_amendment'", amd.id)!;
    expect(exc.category).toBe('exception');
    approveAll(exc.id, ['vikram.joshi', 'meera.iyer']);
    expect(S.getAmendment(amd.id)!.status).toBe('Approved');
  });

  it('cancellation after partial GRN needs stores and vendor confirmation before it can go to SAP', async () => {
    const amit = await login('amit.kulkarni');
    const id = poId('4500021001');
    const l20 = lineOf('4500021001', 20); // 20 of 24 received
    const r = await amit.post(`/api/po/pos/${id}/amendments`, { type: 'Cancel', reason: 'Balance 4 hoses no longer required after the redesign', lines: [{ line_id: l20.id }] });
    expect(r.status).toBe(200);
    expect(r.body.changes.requires_confirmation).toBe(true);
    expect(r.body.approval_id).toBeTruthy();
    expect(approvals.getApproval(r.body.approval_id)!.type).toBe('po.cancellation');
    approveAll(r.body.approval_id, ['vikram.joshi']);
    const blocked = await amit.post(`/api/po/amendments/${r.body.id}/sap-request`);
    expect(blocked.status).toBe(409);
    const suresh = await login('suresh.pawar');
    expect((await suresh.post(`/api/po/amendments/${r.body.id}/confirm`, { party: 'stores' })).status).toBe(200);
    const manoj = await login('manoj.kale');
    expect((await manoj.post(`/api/po/vendor/amendments/${r.body.id}/confirm`, {})).status).toBe(200);
    const conf = S.getAmendment(r.body.id)!.changes.confirmations;
    expect(conf.stores?.name).toBe('Suresh Pawar');
    expect(conf.vendor?.name).toBe('Manoj Kale');
    expect(conf.stores?.at).toBeTruthy();
    const ok = await amit.post(`/api/po/amendments/${r.body.id}/sap-request`);
    expect(ok.status).toBe(200);
    expect(ok.body.body.changes).toEqual([{ item: 20, deleted: true }]);
  });

  it('vendor-raised deviation request goes to the buyer, who can send it for approval', async () => {
    const divya = await login('divya.raman');
    const id = newSapPo('4500029005', '100102', [{ item: 10, code: 'UCG-2003', qty: 10, price: 7600 }]);
    const line = lineOf('4500029005', 10);
    const r = await divya.post(`/api/po/vendor/pos/${id}/deviation`, { type: 'Date', reason: 'Forging lot delayed; can deliver a week later', lines: [{ line_id: line.id, delivery_date: DAY(17) }] });
    expect(r.status).toBe(200);
    expect(r.body.raised_by_vendor).toBe(1);
    expect(r.body.approval_id).toBeNull();
    const amit = await login('amit.kulkarni');
    const f = await amit.post(`/api/po/amendments/${r.body.id}/forward`);
    expect(f.status).toBe(200);
    expect(f.body.approval_id).toBeTruthy();
  });
});
