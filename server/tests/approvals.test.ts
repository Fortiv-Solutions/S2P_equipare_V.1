import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers.ts';

let t: Awaited<ReturnType<typeof startApp>>;
const sessions = new Map<string, any>();
/** One session per persona (the API rate-limits sign-in). */
const login = async (local: string) => { if (!sessions.has(local)) sessions.set(local, await t.login(local)); return sessions.get(local); };
beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t.close(); });

let seq = 0;
/** Closed RFQ with two locked quotations on one line (independent of the RFQ module). */
function fixture(material: string, qty: number, prices: [number, number], days: [number, number] = [10, 10]) {
  const { db } = t;
  const buyer = db.get<{ id: number }>("SELECT id FROM users WHERE email LIKE 'amit.kulkarni@%'")!.id;
  const n = ++seq;
  const rfqId = db.insert('rfqs', { rfq_no: `RFQ-A-${String(n).padStart(4, '0')}`, title: `Approval test ${n}`, buyer_id: buyer, status: 'Closed', category: 'UCG', plant: 'DHN1', closing_at: db.now(), closed_at: db.now(), created_at: db.now() });
  const m = db.get<{ id: number; description: string; uom: string }>('SELECT id, description, uom FROM materials WHERE code = ?', material)!;
  const lineId = db.insert('rfq_lines', { rfq_id: rfqId, line_no: 10, material_id: m.id, description: m.description, qty, uom: m.uom, plant: 'DHN1', gst_rate: 18, required_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), status: 'Active' });
  const vendorIds = ['100102', '100115'].map((code, i) => {
    const vid = db.get<{ id: number }>('SELECT id FROM vendors WHERE sap_code = ?', code)!.id;
    db.insert('rfq_invitations', { rfq_id: rfqId, vendor_id: vid, status: 'Responded', sent_at: db.now() });
    db.insert('quotations', { rfq_id: rfqId, vendor_id: vid, status: 'Locked', version: 1, ref_no: `QTN-A-${n}-${i}`, lines_json: db.J([{ rfq_line_id: lineId, no_quote: false, quoted_qty: qty, basic_price: prices[i], discount_pct: 0, gst_rate: 18, freight: 0, packing: 0, delivery_days: days[i], alternate: false, partial: false }]), credit_days: 45, delivery_terms: 'FOR', updated_at: db.now(), created_at: db.now() });
    return vid;
  });
  return { rfqId, lineId, vendorIds };
}

/** Generate, recommend (vendor index) and submit as the given buyer client; returns the award approval id. */
async function submitted(buyer: any, f: ReturnType<typeof fixture>, pick = 0, reason?: string) {
  const id = (await buyer.post(`/api/cmp/rfq/${f.rfqId}/generate`)).body.id;
  const r = await buyer.put(`/api/cmp/${id}/recommendation`, { awards: [{ rfq_line_id: f.lineId, vendor_id: f.vendorIds[pick], reason }], justification: 'Award per comparative statement' });
  expect(r.status).toBe(200);
  const s = await buyer.post(`/api/cmp/${id}/submit`);
  expect(s.status).toBe(200);
  return { cmpId: id, award: s.body.summary.submission.award_approval_id as number, deviation: s.body.summary.submission.deviation_approval_id as number | null };
}

const steps = (id: number) => t.db.all<{ level: number; approver_role: string; status: string; acted_by: number | null; delegated_from: number | null; device: string | null }>('SELECT * FROM approval_steps WHERE approval_id = ? ORDER BY level, id', id);
const uid = (local: string) => t.db.get<{ id: number }>('SELECT id FROM users WHERE email LIKE ?', `${local}@%`)!.id;

describe('Module 5 — approval workflow', () => {
  it('AC-APR-01 / FR-APR-10: two value bands route to the configured approvers and store the matrix version', async () => {
    const amit = await login('amit.kulkarni');
    const small = await submitted(amit, fixture('UCG-2002', 2, [36000, 38000]));
    const big = await submitted(amit, fixture('UCG-2001', 1, [690000, 700000]));
    expect(steps(small.award).map((s) => `${s.level}:${s.approver_role}`)).toEqual(['1:APR']);
    expect(steps(big.award).map((s) => `${s.level}:${s.approver_role}`)).toEqual(['1:APR', '2:FIN']);
    const a = t.db.get<{ matrix_id: number; matrix_version: number }>('SELECT matrix_id, matrix_version FROM approvals WHERE id = ?', big.award)!;
    expect(a.matrix_id).toBeTruthy();
    expect(a.matrix_version).toBe(1);
    // Level 1 → level 2 → approved.
    const vikram = await login('vikram.joshi');
    expect((await vikram.post(`/api/approvals/${big.award}/approve`, { comment: 'OK' })).status).toBe(200);
    const meera = await login('meera.iyer');
    const inbox = await meera.get('/api/approvals?tab=mine');
    expect(inbox.body.some((r: any) => r.id === big.award && r.can_act)).toBe(true);
    expect((await meera.post(`/api/approvals/${big.award}/approve`, {})).status).toBe(200);
    expect(t.db.get<{ status: string }>('SELECT status FROM comparisons WHERE id = ?', big.cmpId)!.status).toBe('Approved');
  });

  it('AC-APR-02: decision screen data carries every APP-02 element', async () => {
    const amit = await login('amit.kulkarni');
    const s = await submitted(amit, fixture('UCG-2002', 2, [36000, 38000], [20, 2]), 1, 'Two-day delivery needed for breakdown');
    const vikram = await login('vikram.joshi');
    const d = (await vikram.get(`/api/approvals/${s.award}`)).body;
    expect(d.panel.kind).toBe('comparison');
    const line = d.panel.lines[0];
    for (const k of ['selected_vendor', 'lowest_vendor', 'selected_unit_landed', 'lowest_unit_landed', 'lpp', 'contract_price', 'delivery_days', 'delivery_impact', 'reason']) expect(line).toHaveProperty(k);
    expect(line.selected_vendor).toBe('Coromandel Track Systems Pvt Ltd');
    expect(d.panel.justification).toBeTruthy();
    expect(d.panel.deviation_reason).toMatch(/breakdown/);
    expect(d.context.recommended_by).toBe(uid('amit.kulkarni'));
    expect(d.linked).toMatchObject({ link: `/comparisons/${s.cmpId}` });
    expect(d.matrix).toMatchObject({ version: 1 });
    expect(d.steps.length).toBeGreaterThan(0);
    expect(d.can_act).toBe(true);
    expect(s.deviation).toBeTruthy();
  });

  it('AC-APR-03: reject and return need a comment; clarification round-trip and withdrawal', async () => {
    const amit = await login('amit.kulkarni');
    const s = await submitted(amit, fixture('UCG-2002', 2, [36000, 38000]));
    const vikram = await login('vikram.joshi');
    expect((await vikram.post(`/api/approvals/${s.award}/reject`, {})).status).toBe(400);
    expect((await vikram.post(`/api/approvals/${s.award}/return`, { comment: '' })).status).toBe(400);
    expect((await vikram.post(`/api/approvals/${s.award}/clarify`, { comment: 'Confirm the warranty period' })).status).toBe(200);
    expect((await amit.get(`/api/approvals/${s.award}`)).body.can_answer).toBe(true);
    expect((await amit.post(`/api/approvals/${s.award}/answer`, { answer: '12 months from commissioning' })).status).toBe(200);
    expect(t.db.get<{ status: string }>('SELECT status FROM approvals WHERE id = ?', s.award)!.status).toBe('Pending');
    expect((await amit.post(`/api/approvals/${s.award}/withdraw`, { reason: 'Recommendation needs a change' })).status).toBe(200);
    expect(t.db.get<{ status: string }>('SELECT status FROM comparisons WHERE id = ?', s.cmpId)!.status).toBe('Recommendation recorded');
  });

  it('AC-APR-04: off-contract routing creates an exception approval listed in the register', async () => {
    const amit = await login('amit.kulkarni');
    const id = t.db.get<{ id: number }>("SELECT id FROM pr_lines WHERE pr_no = '10045502' AND item = 10")!.id;
    await amit.post(`/api/pr/lines/${id}/checks`);
    const r = await amit.post(`/api/pr/lines/${id}/route`, { route: 'RFQ', reason: 'Quality issues with ARC vendor this quarter' });
    expect(r.status).toBe(200);
    const vikram = await login('vikram.joshi');
    const reg = await vikram.get('/api/approvals/exceptions');
    const row = reg.body.rows.find((x: any) => x.type === 'exc.off_contract' && x.linked_link === `/pr/${id}`);
    expect(row).toMatchObject({ reason: 'Quality issues with ARC vendor this quarter', outcome: 'Open', linked_label: 'PR line' });
    expect(reg.body.review.some((x: any) => x.type === 'exc.off_contract')).toBe(true);
    expect((await vikram.post(`/api/approvals/${row.id}/approve`, { comment: 'Accepted for this quarter' })).status).toBe(200);
    const after = (await vikram.get('/api/approvals/exceptions')).body.rows.find((x: any) => x.id === row.id);
    expect(after.outcome).toBe('Approved');
    expect(after.approvers).toMatch(/Vikram Joshi/);
    expect((await vikram.post(`/api/approvals/exceptions/${row.id}/review`, { note: 'Reviewed in October exception review' })).status).toBe(200);
    expect((await vikram.get('/api/approvals/exceptions')).body.rows.find((x: any) => x.id === row.id).reviewed_by).toBe('Vikram Joshi');
    const csv = await vikram.get('/api/approvals/exceptions?format=csv');
    expect(String(csv.body)).toContain('Off-contract purchase');
    // Period filter excludes it.
    expect((await vikram.get('/api/approvals/exceptions?from=2020-01-01&to=2020-12-31')).body.total).toBe(0);
  });

  it('AC-APR-05: ageing buckets for 1, 3 and 6 days', async () => {
    const amit = await login('amit.kulkarni');
    const ids: number[] = [];
    for (const days of [1.5, 3.5, 6.5]) {
      const s = await submitted(amit, fixture('UCG-2002', 1, [36000, 38000]));
      t.db.run('UPDATE approvals SET created_at = ? WHERE id = ?', new Date(Date.now() - days * 86400000).toISOString(), s.award);
      ids.push(s.award);
    }
    const vikram = await login('vikram.joshi');
    const ag = (await vikram.get('/api/approvals/ageing?by=approver')).body;
    expect(ag.buckets).toEqual(['Under 1 day', '1–3 days', '3–6 days', '6 days and over']);
    const list = (await vikram.get('/api/approvals?tab=all&status=open')).body;
    const b = (id: number) => list.find((r: any) => r.id === id).bucket;
    expect(ids.map(b)).toEqual(['1–3 days', '3–6 days', '6 days and over']);
    const apr = ag.rows.find((r: any) => r.key === 'APR');
    expect(apr.counts[1] + apr.counts[2] + apr.counts[3]).toBeGreaterThanOrEqual(3);
    const drill = (await vikram.get(`/api/approvals?tab=all&role=APR&bucket=${encodeURIComponent('6 days and over')}`)).body;
    expect(drill.some((r: any) => r.id === ids[2])).toBe(true);
  });

  it('AC-APR-06: a user cannot approve a request they raised — not offered and refused by the API', async () => {
    const vikram = await login('vikram.joshi');
    expect((await vikram.post('/api/auth/switch-role', { role: 'BUY' })).status).toBe(200);
    const s = await submitted(vikram, fixture('UCG-2002', 2, [36000, 38000]));
    expect((await vikram.post('/api/auth/switch-role', { role: 'APR' })).status).toBe(200);
    const d = (await vikram.get(`/api/approvals/${s.award}`)).body;
    expect(d.can_act).toBe(false);
    expect(d.why_not).toMatch(/segregation of duties/);
    expect((await vikram.get('/api/approvals?tab=mine')).body.some((r: any) => r.id === s.award)).toBe(false);
    expect((await vikram.post(`/api/approvals/${s.award}/approve`, {})).status).toBe(403);
    expect((await vikram.get('/api/approvals?tab=raised')).body.some((r: any) => r.id === s.award)).toBe(true);
  });

  it('bulk approve only for configured types (Q 10.3)', async () => {
    const amit = await login('amit.kulkarni');
    const s = await submitted(amit, fixture('UCG-2002', 2, [36000, 38000]));
    const vikram = await login('vikram.joshi');
    const r = await vikram.post('/api/approvals/bulk-approve', { ids: [s.award] });
    expect(r.body).toMatchObject({ succeeded: 0, failed: 1 });
    const anjali = await login('anjali.verma');
    expect((await anjali.put('/api/config/approvals.bulk_types', { value: ['cmp.award'], reason: 'Pilot bulk approval for small awards' })).status).toBe(200);
    expect((await vikram.post('/api/approvals/bulk-approve', { ids: [s.award] })).body).toMatchObject({ succeeded: 1 });
  });

  it('FR-APR-06: delegation is audited and lets the delegate act for the absent approver', async () => {
    const vikram = await login('vikram.joshi');
    const rajesh = await login('rajesh.menon');
    const amit = await login('amit.kulkarni');
    expect((await vikram.put('/api/approvals/delegation', { delegate_id: uid('vikram.joshi'), until: '2030-01-01' })).status).toBe(400);
    expect((await vikram.put('/api/approvals/delegation', { delegate_id: uid('amit.kulkarni'), until: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) })).status).toBe(400);
    const until = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const set = await vikram.put('/api/approvals/delegation', { delegate_id: uid('rajesh.menon'), until, reason: 'Annual leave' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ active: true, delegate: { name: 'Rajesh Menon' } });
    expect(t.db.get<{ delegate_id: number }>('SELECT delegate_id FROM users WHERE id = ?', uid('vikram.joshi'))!.delegate_id).toBe(uid('rajesh.menon'));
    expect(t.db.get('SELECT id FROM audit_events WHERE action = ? AND object_id = ?', 'user.delegation_set', String(uid('vikram.joshi')))).toBeTruthy();
    const s = await submitted(amit, fixture('UCG-2002', 2, [36000, 38000]));
    const d = (await rajesh.get(`/api/approvals/${s.award}`)).body;
    expect(d).toMatchObject({ can_act: true, acting_as_delegate_for: 'Vikram Joshi' });
    expect((await rajesh.post(`/api/approvals/${s.award}/approve`, { comment: 'Approved while Vikram is on leave' })).status).toBe(200);
    const st = steps(s.award)[0];
    expect(st).toMatchObject({ status: 'Approved', acted_by: uid('rajesh.menon'), delegated_from: uid('vikram.joshi') });
    expect((await vikram.del('/api/approvals/delegation')).body.active).toBe(false);
  });

  it('FR-APR-01: matrix admin creates a new version (adm.config only) and new requests store it', async () => {
    const vikram = await login('vikram.joshi');
    const anjali = await login('anjali.verma');
    const body = { type: 'cmp.award', name: 'Award up to ₹5 lakh (v2 test)', conditions: { max_value: 500000 }, levels: [{ level: 1, roles: ['APR', 'FIN'], label: 'Procurement and finance (parallel)' }], effective_from: new Date(Date.now() - 86400000).toISOString().slice(0, 10), note: 'Test version' };
    expect((await vikram.post('/api/approvals/matrix', body)).status).toBe(403);
    expect((await anjali.post('/api/approvals/matrix', { ...body, levels: [{ level: 1, roles: ['ADM'] }] })).status).toBe(400);
    const old = t.db.get<{ id: number }>("SELECT id FROM approval_matrix WHERE type = 'cmp.award' AND name = 'Award up to ₹5 lakh'")!;
    const r = await anjali.post('/api/approvals/matrix', { ...body, replaces_id: old.id });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(2);
    expect(t.db.get<{ active: number }>('SELECT active FROM approval_matrix WHERE id = ?', old.id)!.active).toBe(0);
    const amit = await login('amit.kulkarni');
    const s = await submitted(amit, fixture('UCG-2002', 2, [36000, 38000]));
    const a = t.db.get<{ matrix_id: number; matrix_version: number }>('SELECT matrix_id, matrix_version FROM approvals WHERE id = ?', s.award)!;
    expect(a).toMatchObject({ matrix_id: r.body.id, matrix_version: 2 });
    expect(steps(s.award).map((x) => x.approver_role).sort()).toEqual(['APR', 'FIN']);
    const list = (await vikram.get('/api/approvals/matrix')).body;
    expect(list.rows.some((x: any) => x.id === r.body.id && x.in_effect)).toBe(true);
    expect((await anjali.post(`/api/approvals/matrix/${r.body.id}/deactivate`, { reason: 'Test version withdrawn' })).status).toBe(200);
  });

  it('vendors cannot reach approvals', async () => {
    const manoj = await login('manoj.kale');
    expect((await manoj.get('/api/approvals?tab=raised')).status).toBe(403);
    expect((await manoj.get('/api/approvals/1')).status).toBe(403);
  });
});
