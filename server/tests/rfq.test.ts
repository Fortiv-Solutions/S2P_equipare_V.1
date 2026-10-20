import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, PDF, type Client } from './helpers.ts';

let t: Awaited<ReturnType<typeof startApp>>;
let amit: Client, vikram: Client, sneha: Client, manoj: Client, imran: Client, divya: Client, anjali: Client;
beforeAll(async () => {
  t = await startApp();
  [amit, vikram, sneha, manoj, imran, divya, anjali] = await Promise.all(['amit.kulkarni', 'vikram.joshi', 'sneha.patil', 'manoj.kale', 'imran', 'divya.raman', 'anjali.verma'].map((u) => t.login(u)));
}, 60000);
afterAll(async () => { await t.close(); });

const line = (pr: string, item: number) => t.db.get<{ id: number }>('SELECT id FROM pr_lines WHERE pr_no = ? AND item = ?', pr, item)!.id;
const vid = (code: string) => t.db.get<{ id: number }>('SELECT id FROM vendors WHERE sap_code = ?', code)!.id;
const uid = (local: string) => t.db.get<{ id: number }>('SELECT id FROM users WHERE email LIKE ?', `${local}@%`)!.id;
const rfqByTitle = (like: string) => t.db.get<{ id: number }>('SELECT id FROM rfqs WHERE title LIKE ?', `%${like}%`)!.id;
const notes = (local: string, event: string, rfqId: number) => t.db.all<{ id: number; title: string }>('SELECT id, title FROM notifications WHERE user_id = ? AND event = ? AND object_id = ?', uid(local), event, rfqId);
async function route(c: Client, id: number) {
  const chk = await c.post(`/api/pr/lines/${id}/checks`);
  expect(chk.status).toBe(200);
  const r = await c.post(`/api/pr/lines/${id}/route`, { route: chk.body.route_proposed, acknowledge_stale: true });
  expect(r.status).toBe(200);
  expect(r.body.status).toBe('Route decided');
}
const fullLine = (rfq_line_id: number, extra: Record<string, unknown> = {}) => ({ rfq_line_id, basic_price: 1000, discount_pct: 5, gst_rate: 18, freight: 200, packing: 50, delivery_days: 10, make_brand: 'OEM', warranty: '12 months', remarks: 'ok', ...extra });
const validity = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);

let X: number; // RFQ built from three PRs
let xl: { id: number; line_no: number; pr_line_id: number }[];

describe('Module 2 — RFQ automation', () => {
  it('AC-RFQ-01 / AC-RFQ-06: lines from three PRs keep their PR line; GST, valuation, plant and ship-to are pre-filled', async () => {
    const ids = [line('10045509', 10), line('10045511', 20), line('10045507', 10)];
    for (const id of ids) await route(amit, id);
    const pv = await amit.post('/api/rfq/preview', { pr_line_ids: ids });
    expect(pv.status).toBe(200);
    expect(pv.body.ok).toBe(true);
    const r = await amit.post('/api/rfq/rfqs', { pr_line_ids: ids });
    expect(r.status).toBe(200);
    X = r.body.id;
    const d = await amit.get(`/api/rfq/rfqs/${X}`);
    xl = d.body.lines;
    expect(d.body.status).toBe('Draft');
    expect(xl.map((l) => l.pr_line_id).sort()).toEqual([...ids].sort());
    expect(new Set(d.body.lines.map((l: any) => l.pr_ref.split('/')[0])).size).toBe(3);
    const plant = t.db.get<{ ship_to_address: string }>('SELECT ship_to_address FROM plants WHERE code = ?', 'DHN1')!;
    const hyd = d.body.lines.find((l: any) => l.pr_ref === '10045509/10');
    expect(hyd.gst_rate).toBe(18);
    expect(hyd.ship_to).toBe(plant.ship_to_address);
    expect(hyd.valuation_type).toBe('Standard');
    expect(hyd.transport_req).toBeTruthy();
    for (const id of ids) expect(t.db.get<{ status: string; rfq_id: number }>('SELECT status, rfq_id FROM pr_lines WHERE id = ?', id)).toMatchObject({ status: 'RFQ in progress', rfq_id: X });
    // A line already in an active RFQ cannot be put in another one (WF-05).
    expect((await amit.post('/api/rfq/rfqs', { pr_line_ids: [ids[0]] })).status).toBe(400);
  });

  it('AC-RFQ-06: buyer edits of auto-filled values are audited as overrides', async () => {
    const r = await amit.put(`/api/rfq/rfqs/${X}/lines/${xl[0].id}`, { transport_req: 'Courier — small parcel', reason: 'Small item, courier is faster' });
    expect(r.status).toBe(200);
    const ev = t.db.get<{ action: string }>("SELECT action FROM audit_events WHERE object_type = 'rfq' AND object_id = ? AND action = 'rfq.line_autofill_overridden'", String(X));
    expect(ev).toBeTruthy();
  });

  it('AC-RFQ-02: approved, unblocked vendors mapped to the category are suggested with reasons; blocked 100113 is excluded', async () => {
    const A = rfqByTitle('Hydraulic seal kits');
    const s = await amit.get(`/api/rfq/rfqs/${A}/suggestions`);
    expect(s.status).toBe(200);
    const codes = s.body.vendors.map((v: any) => v.sap_code);
    expect(codes).toEqual(expect.arrayContaining(['100101', '100116', '100106']));
    expect(codes).not.toContain('100113');
    expect(s.body.vendors[0].reasons.map((x: any) => x.code)).toContain('category');
    expect(s.body.vendors.find((v: any) => v.sap_code === '100101').reasons.some((x: any) => x.code === 'sub_category')).toBe(true);
    const ex = s.body.excluded.find((e: any) => e.sap_code === '100113');
    expect(ex.reasons.join(' ')).toMatch(/Blocked in SAP/);
    // The blocked vendor cannot be added manually either.
    expect((await amit.post(`/api/rfq/rfqs/${X}/invitations`, { vendor_id: vid('100113'), justification: 'Trying a blocked vendor anyway' })).status).toBe(400);
  });

  it('AC-RFQ-03 / AC-RFQ-05: publish is blocked naming the missing field and the non-suggested vendor without justification', async () => {
    for (const c of ['100101', '100106']) expect((await amit.post(`/api/rfq/rfqs/${X}/invitations`, { vendor_id: vid(c) })).status).toBe(200);
    const add = await amit.post(`/api/rfq/rfqs/${X}/invitations`, { vendor_id: vid('100104') });
    expect(add.status).toBe(200);
    expect(add.body.suggested).toBe(0);
    await amit.put(`/api/rfq/rfqs/${X}/lines/${xl[1].id}`, { ship_to: '', required_date: null });
    const p = await amit.post(`/api/rfq/rfqs/${X}/publish`, {});
    expect(p.status).toBe(400);
    expect(p.body.error.message).toMatch(/shipping location/);
    expect(p.body.error.message).toMatch(/required date/);
    expect(p.body.error.fields[`lines.${xl[1].line_no}.ship_to`]).toBeTruthy();
    expect(p.body.error.fields[`vendors.${vid('100104')}.justification`]).toMatch(/Western Lubricants/);
    await amit.put(`/api/rfq/rfqs/${X}/lines/${xl[1].id}`, { ship_to: 'Plot B-14, MIDC Chakan Phase II, Pune 410501', required_date: '2026-12-01' });
    const inv = t.db.get<{ id: number }>('SELECT id FROM rfq_invitations WHERE rfq_id = ? AND vendor_id = ?', X, vid('100104'))!;
    expect((await amit.put(`/api/rfq/rfqs/${X}/invitations/${inv.id}`, { justification: 'Requested by plant for comparison on price' })).status).toBe(200);
  });

  it('AC-RFQ-04: publishing records each invitation, send time and e-mail delivery status in the audit; INT-M05 is reference only', async () => {
    const p = await amit.post(`/api/rfq/rfqs/${X}/publish`, {});
    expect(p.status).toBe(200);
    expect(p.body.status).toBe('Published');
    const ev = t.db.get<{ after: any }>("SELECT after_json FROM audit_events WHERE object_type = 'rfq' AND object_id = ? AND action = 'rfq.published'", String(X))!;
    expect(ev.after.invitations).toHaveLength(3);
    for (const i of ev.after.invitations) { expect(i.sent_at).toBeTruthy(); expect(i.delivery_status).toBeTruthy(); }
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE template = 'NTF-04.v1' AND recipient = 'sanjay@westernlube.test'")).toBeTruthy();
    expect(notes('manoj.kale', 'NTF-04', X)).toHaveLength(1);
    const d = await amit.get(`/api/rfq/rfqs/${X}`);
    expect(d.body.sap.enabled).toBe(false);
    expect(d.body.sap.decision).toBe('DEC-04');
  });

  it('FR-RFQ-11: below the category minimum needs a justification and a limited-source approval; a vendor without e-mail is "Delivery failed"', async () => {
    const D = rfqByTitle('Welding electrodes');
    t.db.run('UPDATE vendors SET contact_email = NULL WHERE sap_code = ?', '100107');
    const noReason = await sneha.post(`/api/rfq/rfqs/${D}/publish`, {});
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('exception_justification_required');
    const ok = await sneha.post(`/api/rfq/rfqs/${D}/publish`, { exception_reason: 'Only approved welding consumables source for Nagpur' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('Pending approval');
    const ap = t.db.get<{ id: number; type: string }>("SELECT id, type FROM approvals WHERE object_type = 'rfq' AND object_id = ?", D)!;
    expect(ap.type).toBe('exc.single_source');
    expect((await sneha.get(`/api/rfq/rfqs/${D}`)).body.invitations[0].sent_at).toBeNull();
    const { act } = await import('../core/approvals.ts');
    const { actorFor } = await import('../seed/ctx.ts');
    act(actorFor('vikram.joshi', 'APR'), ap.id, 'approve', 'Approved');
    const after = await sneha.get(`/api/rfq/rfqs/${D}`);
    expect(after.body.status).toBe('Published');
    expect(after.body.invitations[0].delivery_status).toBe('Delivery failed');
    expect(notes('sneha.patil', 'NTF-04', D).some((n) => /not delivered/.test(n.title))).toBe(true);
  });

  it('AC-RFQ-08: a vendor opening the RFQ is marked Viewed with a timestamp', async () => {
    const v = await manoj.get(`/api/rfq/vendor/rfqs/${X}`);
    expect(v.status).toBe(200);
    expect(v.body.lines).toHaveLength(3);
    const inv = t.db.get<{ status: string; viewed_at: string }>('SELECT status, viewed_at FROM rfq_invitations WHERE rfq_id = ? AND vendor_id = ?', X, vid('100101'))!;
    expect(inv.status).toBe('Viewed');
    expect(inv.viewed_at).toBeTruthy();
    expect(t.db.get("SELECT id FROM audit_events WHERE action = 'rfq.viewed_by_vendor' AND object_id = ?", String(X))).toBeTruthy();
  });

  it('GOV-C09: a vendor that is not invited gets 404 and the attempt is audited', async () => {
    const r = await divya.get(`/api/rfq/vendor/rfqs/${X}`);
    expect(r.status).toBe(404);
    expect(t.db.get("SELECT id FROM audit_events WHERE action = 'security.cross_vendor_access_denied' AND object_type = 'rfq' AND object_id = ?", String(X))).toBeTruthy();
    expect((await divya.get('/api/rfq/vendor/rfqs')).body.some((x: any) => x.id === X)).toBe(false);
    expect((await divya.put(`/api/rfq/vendor/rfqs/${X}/quotation`, { lines: [] })).status).toBe(404);
    expect((await manoj.get('/api/rfq/rfqs')).status).toBe(403);
  });

  it('AC-RFQ-10: a 15 MB drawing is downloadable by invited vendors and the download is logged', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(15 * 1024 * 1024, 0x20)]);
    const up = await amit.upload('/api/files', [{ name: 'idler-drawing.pdf', content: big, type: 'application/pdf' }], { owner_type: 'rfq', owner_id: String(X), label: 'Drawing' });
    expect(up.status).toBe(200);
    const fid = up.body.files[0].id;
    const dl = await manoj.get(`/api/files/${fid}/download`);
    expect(dl.status).toBe(200);
    expect(t.db.get("SELECT id FROM audit_events WHERE action = 'file.downloaded' AND object_id = ? AND actor_name = 'Manoj Kale'", String(fid))).toBeTruthy();
    expect((await divya.get(`/api/files/${fid}/download`)).status).toBe(404);
    expect((await manoj.get(`/api/rfq/vendor/rfqs/${X}`)).body.files.some((f: any) => f.id === fid)).toBe(true);
  });

  it('RFQ PDF per vendor downloads for the buyer and the invited vendor', async () => {
    const b = await amit.get(`/api/rfq/rfqs/${X}/pdf?vendor_id=${vid('100101')}`);
    expect(b.status).toBe(200);
    expect(b.headers.get('content-type')).toMatch(/pdf/);
    expect((await manoj.get(`/api/rfq/vendor/rfqs/${X}/pdf`)).status).toBe(200);
  });
});

describe('Module 3 — vendor quotation entry', () => {
  let qid: number;
  it('AC-QTN-02: missing GST blocks submission naming the line and field; nothing is submitted', async () => {
    const lines = xl.map((l) => fullLine(l.id));
    lines[1] = { ...lines[1], gst_rate: null as never };
    const r = await manoj.post(`/api/rfq/vendor/rfqs/${X}/quotation/submit`, { header: { payment_terms: '45 days', delivery_terms: 'FOR', validity_date: validity }, lines });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(new RegExp(`Line ${xl[1].line_no}.*GST rate is required`));
    expect(r.body.error.fields[`lines.${xl[1].line_no}.gst_rate`]).toBeTruthy();
    expect(t.db.get<{ version: number }>('SELECT version FROM quotations WHERE rfq_id = ? AND vendor_id = ?', X, vid('100101'))!.version).toBe(0);
    const badValidity = await manoj.post(`/api/rfq/vendor/rfqs/${X}/quotation/submit`, { header: { payment_terms: '45 days', delivery_terms: 'FOR', validity_date: '2026-01-01' }, lines: xl.map((l) => fullLine(l.id)) });
    expect(badValidity.status).toBe(400);
    expect(badValidity.body.error.fields['header.validity_date']).toMatch(/closing date/);
  });

  it('AC-QTN-01 / FR-QTN-08 / AC-QTN-04: entry with all QTN-02 fields, alternate + partial flags; submission returns reference and timestamp', async () => {
    const draft = await manoj.put(`/api/rfq/vendor/rfqs/${X}/quotation`, { header: { payment_terms: '45 days from GRN' }, lines: [fullLine(xl[0].id)] });
    expect(draft.status).toBe(200);
    expect(draft.body.quotation.status).toBe('Draft');
    const lines = xl.map((l, i) => fullLine(l.id, i === 0 ? { alternate: true, make_brand: 'Alt Seals Co', quoted_qty: 2 } : {}));
    const r = await manoj.post(`/api/rfq/vendor/rfqs/${X}/quotation/submit`, { header: { payment_terms: '45 days from GRN', credit_days: 45, delivery_terms: 'FOR', validity_date: validity, remarks: 'Firm prices' }, lines });
    expect(r.status).toBe(200);
    expect(r.body.ack.ref_no).toMatch(/^QTN-/);
    expect(r.body.ack.submitted_at).toBeTruthy();
    expect(r.body.ack.version).toBe(1);
    const q = r.body.view.quotation;
    qid = q.id;
    const first = q.lines.find((x: any) => x.rfq_line_id === xl[0].id);
    for (const k of ['basic_price', 'discount_pct', 'gst_rate', 'freight', 'packing', 'delivery_days', 'make_brand', 'warranty', 'remarks', 'quoted_qty']) expect(first[k]).not.toBeNull();
    expect(first).toMatchObject({ alternate: true, partial: true, quoted_qty: 2 });
    expect(t.db.get<{ status: string }>('SELECT status FROM rfq_invitations WHERE rfq_id = ? AND vendor_id = ?', X, vid('100101'))!.status).toBe('Responded');
  });

  it('FR-RFQ-12: while sealed the buyer sees who responded, never prices (NTF-08 is count only)', async () => {
    const d = await amit.get(`/api/rfq/rfqs/${X}`);
    expect(d.body.sealed_now).toBe(true);
    expect(d.body.quotations).toBeNull();
    expect(d.body.counts.responded).toBe(1);
    expect(JSON.stringify(d.body)).not.toMatch(/basic_price/);
    expect((await amit.get(`/api/files?owner_type=quotation&owner_id=${qid}`)).status).toBe(404);
    const n = notes('amit.kulkarni', 'NTF-08', X);
    expect(n[0].title).toMatch(/1 of 3 responded/);
    expect(n[0].title).not.toMatch(/Hydrotech/);
  });

  it('AC-QTN-03 (upload): the vendor uploads quotation documents while the RFQ is open', async () => {
    const up = await manoj.upload('/api/files', [{ name: 'signed-quotation.pdf', content: PDF, type: 'application/pdf' }], { owner_type: 'quotation', owner_id: String(qid), label: 'Signed quotation' });
    expect(up.status).toBe(200);
  });

  it('FR-QTN-07: a vendor declines with a reason', async () => {
    expect((await imran.post(`/api/rfq/vendor/rfqs/${X}/decline`, { reason: 'short' })).status).toBe(400);
    const r = await imran.post(`/api/rfq/vendor/rfqs/${X}/decline`, { reason: 'Engine and service lines are outside our current capacity' });
    expect(r.status).toBe(200);
    expect(r.body.invitation.status).toBe('Declined');
  });

  it('AC-RFQ-07: reminders go only to non-responders (manual and scheduled)', async () => {
    // Responded: Hydrotech; declined: Deccan; still open: Western Lubricants (no portal user).
    const r = await amit.post(`/api/rfq/rfqs/${X}/remind`, { message: 'Please quote by the closing date' });
    expect(r.body.reminded).toBe(1);
    expect(notes('manoj.kale', 'NTF-05', X)).toHaveLength(0);
    expect(notes('imran', 'NTF-05', X)).toHaveLength(0);
    expect(t.db.get<{ reminders_sent: number }>('SELECT reminders_sent FROM rfq_invitations WHERE rfq_id = ? AND vendor_id = ?', X, vid('100104'))!.reminders_sent).toBe(1);
    // Scheduled reminder: Hydrotech revises to Draft-in-progress but stays Responded; Deccan reopens interest → Viewed.
    const A = rfqByTitle('Hydraulic seal kits');
    t.db.run('UPDATE rfqs SET closing_at = ? WHERE id = ?', new Date(Date.now() + 20 * 3600000).toISOString(), A);
    const job = await anjali.post('/api/jobs/rfq.reminders/run');
    expect(job.body.status).toBe('Succeeded');
    expect(notes('manoj.kale', 'NTF-05', A).length).toBe(1); // Hydrotech only saved a draft on A — not a response
    expect(notes('imran', 'NTF-05', A)).toHaveLength(0); // Deccan submitted on A
    await anjali.post('/api/jobs/rfq.reminders/run');
    expect(notes('manoj.kale', 'NTF-05', A).length).toBe(1); // same schedule step is not repeated
  });

  it('AC-RFQ-09: extending without a reason is rejected; with a reason vendors are notified', async () => {
    const cur = t.db.get<{ closing_at: string }>('SELECT closing_at FROM rfqs WHERE id = ?', X)!.closing_at;
    const to = new Date(new Date(cur).getTime() + 2 * 86400000).toISOString();
    expect((await amit.post(`/api/rfq/rfqs/${X}/extend`, { closing_at: to })).status).toBe(400);
    const ok = await amit.post(`/api/rfq/rfqs/${X}/extend`, { closing_at: to, reason: 'Vendors asked for two more days' });
    expect(ok.status).toBe(200);
    expect(ok.body.closing_at).toBe(to);
    expect(notes('manoj.kale', 'NTF-06', X)).toHaveLength(1);
    expect((await amit.post(`/api/rfq/rfqs/${X}/close`)).status).toBe(409); // Western Lubricants has not responded
  });

  it('Auto-close at closing time: Closed, quotations Locked, non-responders Not responded, NTF-07 to buyer; AC-QTN-03 docs visible', async () => {
    t.db.run('UPDATE rfqs SET closing_at = ? WHERE id = ?', new Date(Date.now() - 60000).toISOString(), X);
    const job = await anjali.post('/api/jobs/rfq.lifecycle/run');
    expect(job.body.status).toBe('Succeeded');
    const d = await amit.get(`/api/rfq/rfqs/${X}`);
    expect(d.body.status).toBe('Closed');
    expect(d.body.invitations.find((i: any) => i.sap_code === '100104').status).toBe('Not responded');
    expect(t.db.get<{ status: string }>('SELECT status FROM quotations WHERE id = ?', qid)!.status).toBe('Locked');
    expect(notes('amit.kulkarni', 'NTF-07', X).length).toBeGreaterThan(0);
    const q = d.body.quotations.find((x: any) => x.sap_code === '100101');
    expect(q.lines[0].basic_price).toBe(1000);
    expect(q.documents.map((x: any) => x.filename)).toContain('signed-quotation.pdf');
    expect(d.body.comparison_link).toBe(`/comparisons/rfq/${X}`);
    const files = await amit.get(`/api/files?owner_type=quotation&owner_id=${qid}`);
    expect(files.status).toBe(200);
  });

  it('AC-QTN-05 / AC-QTN-06: edit after close rejected; after an approved reopen the revision is accepted and versioned with changed fields', async () => {
    const lines = xl.map((l) => fullLine(l.id, { basic_price: 950 }));
    const late = await manoj.post(`/api/rfq/vendor/rfqs/${X}/quotation/submit`, { header: { payment_terms: '45 days from GRN', delivery_terms: 'FOR', validity_date: validity }, lines });
    expect(late.status).toBe(409);
    expect(t.db.get<{ version: number }>('SELECT version FROM quotations WHERE id = ?', qid)!.version).toBe(1);
    const until = new Date(Date.now() + 2 * 86400000).toISOString();
    expect((await amit.post(`/api/rfq/rfqs/${X}/reopen`, { vendor_ids: [vid('100101')], reopen_until: until })).status).toBe(400);
    const req = await amit.post(`/api/rfq/rfqs/${X}/reopen`, { vendor_ids: [vid('100101')], reason: 'Clarified specification for line 10 after close', reopen_until: until });
    expect(req.status).toBe(200);
    const blocked = await manoj.post(`/api/rfq/vendor/rfqs/${X}/quotation/submit`, { header: { payment_terms: '45 days from GRN', delivery_terms: 'FOR', validity_date: validity }, lines });
    expect(blocked.status).toBe(409);
    const { act } = await import('../core/approvals.ts');
    const { actorFor } = await import('../seed/ctx.ts');
    act(actorFor('vikram.joshi', 'APR'), req.body.approval_id, 'approve', 'Approved reopen');
    expect(notes('manoj.kale', 'NTF-09', X)).toHaveLength(1);
    const rev = await manoj.post(`/api/rfq/vendor/rfqs/${X}/quotation/submit`, { header: { payment_terms: '45 days from GRN', credit_days: 45, delivery_terms: 'FOR', validity_date: validity }, lines });
    expect(rev.status).toBe(200);
    expect(rev.body.ack.version).toBe(2);
    const v2 = rev.body.view.versions[0];
    expect(v2.version).toBe(2);
    expect(v2.created_at).toBeTruthy();
    expect(v2.changes.some((c: any) => c.field === 'basic_price' && c.from === 1000 && c.to === 950)).toBe(true);
    const ro = t.db.get<{ id: number }>("SELECT id FROM rfq_reopens WHERE rfq_id = ? AND status = 'Open'", X)!;
    expect((await amit.post(`/api/rfq/rfqs/${X}/reopens/${ro.id}/lock`)).status).toBe(200);
    expect(t.db.get<{ status: string; version: number }>('SELECT status, version FROM quotations WHERE id = ?', qid)).toMatchObject({ status: 'Locked', version: 2 });
    expect((await manoj.put(`/api/rfq/vendor/rfqs/${X}/quotation`, { lines })).status).toBe(409);
  });
});

describe('RFQ lifecycle — cancel, re-float, flagged lines', () => {
  let Y: number;
  it('FR-RFQ-09: re-float creates a linked Draft copy carrying PR links; cancel releases PR lines', async () => {
    const pl = line('10045509', 20);
    await route(amit, pl);
    const r = await amit.post('/api/rfq/rfqs', { pr_line_ids: [pl] });
    Y = r.body.id;
    for (const c of ['100101', '100116', '100106']) await amit.post(`/api/rfq/rfqs/${Y}/invitations`, { vendor_id: vid(c) });
    // PR cancelled in SAP while in the RFQ → line flagged; publish blocked until the buyer decides.
    t.db.run("UPDATE rfq_lines SET status = 'Flagged', flag_reason = 'PR line deleted in SAP' WHERE rfq_id = ?", Y);
    const blocked = await amit.post(`/api/rfq/rfqs/${Y}/publish`, {});
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toMatch(/flagged/);
    const lid = t.db.get<{ id: number }>('SELECT id FROM rfq_lines WHERE rfq_id = ?', Y)!.id;
    expect((await amit.post(`/api/rfq/rfqs/${Y}/lines/${lid}/flag`, { action: 'keep', reason: 'Plant confirmed the need stands' })).status).toBe(200);
    expect((await amit.post(`/api/rfq/rfqs/${Y}/publish`, {})).body.status).toBe('Published');
    expect((await amit.post(`/api/rfq/rfqs/${Y}/refloat`, {})).status).toBe(400);
    const rf = await amit.post(`/api/rfq/rfqs/${Y}/refloat`, { reason: 'Specification revised by the plant' });
    expect(rf.status).toBe(200);
    expect(rf.body.status).toBe('Draft');
    expect(rf.body.parent_rfq_id).toBe(Y);
    expect(t.db.get<{ status: string }>('SELECT status FROM rfqs WHERE id = ?', Y)!.status).toBe('Re-floated');
    expect(t.db.get<{ rfq_id: number }>('SELECT rfq_id FROM pr_lines WHERE id = ?', pl)!.rfq_id).toBe(rf.body.id);
    expect(notes('manoj.kale', 'NTF-06', Y)).toHaveLength(1);
    const c = await amit.post(`/api/rfq/rfqs/${rf.body.id}/cancel`, { reason: 'Requirement withdrawn by plant' });
    expect(c.body.status).toBe('Cancelled');
    expect(t.db.get<{ status: string; rfq_id: number | null }>('SELECT status, rfq_id FROM pr_lines WHERE id = ?', pl)).toMatchObject({ status: 'Route decided', rfq_id: null });
  });

  it('ARC: an annual-rate RFQ is built from an opportunity without a PR link', async () => {
    const mid = t.db.get<{ id: number }>("SELECT id FROM materials WHERE code = 'WLD-6001'")!.id;
    let opp = t.db.get<{ id: number }>('SELECT id FROM opportunities WHERE material_id = ?', mid);
    if (!opp) t.db.run("INSERT INTO opportunities (material_id, category, frequency, annual_value, vendor_count, status, identified_at) VALUES (?, 'WLD', 4, 450000, 1, 'Identified', ?)", mid, new Date().toISOString());
    opp = t.db.get<{ id: number }>('SELECT id FROM opportunities WHERE material_id = ?', mid)!;
    t.db.run('UPDATE opportunities SET rfq_id = NULL WHERE id = ?', opp.id);
    const pv = await sneha.get(`/api/rfq/opportunities/${opp.id}`);
    expect(pv.body.annual_qty_estimate).toBeGreaterThan(0);
    const r = await sneha.post('/api/rfq/rfqs', { opportunity_id: opp.id, plant: 'NGP1' });
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('ARC');
    const d = await sneha.get(`/api/rfq/rfqs/${r.body.id}`);
    expect(d.body.lines[0].pr_line_id).toBeNull();
    expect(t.db.get<{ rfq_id: number }>('SELECT rfq_id FROM opportunities WHERE id = ?', opp.id)!.rfq_id).toBe(r.body.id);
  });
});
