import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers.ts';
import { landedCost } from '../modules/cmp/landed.ts';

let t: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t.close(); });

let seq = 0;
type Q = { basic_price: number; discount_pct?: number; gst_rate?: number; freight?: number; packing?: number; delivery_days?: number; quoted_qty?: number; alternate?: boolean; partial?: boolean; no_quote?: boolean };
/** Build a closed RFQ with locked quotations directly in the database (independent of the RFQ module). */
function fixture(opts: { lines: { material: string; qty: number }[]; vendors: { code: string; status?: 'Responded' | 'Declined' | 'Invited'; quotes?: (Q | null)[]; terms?: string; credit_days?: number }[] }) {
  const { db } = t;
  const buyer = db.get<{ id: number }>("SELECT id FROM users WHERE email LIKE 'amit.kulkarni@%'")!.id;
  const n = ++seq;
  const rfqId = db.insert('rfqs', { rfq_no: `RFQ-T-${String(n).padStart(4, '0')}`, title: `Test RFQ ${n}`, buyer_id: buyer, status: 'Closed', category: 'UCG', plant: 'DHN1', closing_at: db.now(), closed_at: db.now(), created_at: db.now() });
  const lineIds = opts.lines.map((l, i) => {
    const m = db.get<{ id: number; description: string; uom: string; gst_rate: number }>('SELECT id, description, uom, gst_rate FROM materials WHERE code = ?', l.material)!;
    return db.insert('rfq_lines', { rfq_id: rfqId, line_no: (i + 1) * 10, material_id: m.id, description: m.description, qty: l.qty, uom: m.uom, plant: 'DHN1', gst_rate: m.gst_rate, required_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), status: 'Active' });
  });
  const vendorIds: number[] = [];
  for (const v of opts.vendors) {
    const vid = db.get<{ id: number }>('SELECT id FROM vendors WHERE sap_code = ?', v.code)!.id;
    vendorIds.push(vid);
    const status = v.status ?? 'Responded';
    db.insert('rfq_invitations', { rfq_id: rfqId, vendor_id: vid, status, sent_at: db.now(), decline_reason: status === 'Declined' ? 'Capacity full this month' : null });
    if (status === 'Responded') {
      const lines = (v.quotes ?? []).map((q, i) => (q ? { rfq_line_id: lineIds[i], no_quote: !!q.no_quote, quoted_qty: q.quoted_qty ?? opts.lines[i].qty, basic_price: q.basic_price, discount_pct: q.discount_pct ?? 0, gst_rate: q.gst_rate ?? 18, freight: q.freight ?? 0, packing: q.packing ?? 0, delivery_days: q.delivery_days ?? 10, make_brand: 'Test', warranty: '12 months', alternate: !!q.alternate, partial: !!q.partial, remarks: null } : { rfq_line_id: lineIds[i], no_quote: true }));
      db.insert('quotations', { rfq_id: rfqId, vendor_id: vid, status: 'Locked', version: 1, ref_no: `QTN-T-${n}-${vid}`, submitted_at: db.now(), lines_json: db.J(lines), payment_terms: '45 days', credit_days: v.credit_days ?? 45, delivery_terms: v.terms ?? 'FOR', validity_date: '2027-03-31', updated_at: db.now(), created_at: db.now() });
    }
  }
  return { rfqId, lineIds, vendorIds };
}

describe('Landed cost formula (FR-CMP-02, AC-CMP-02)', () => {
  it('computes Taxable = P(1−d)q + F + K and Landed = Taxable(1+γG) − PTA − LD − RD to 2 decimals', () => {
    const base = { P: 1000, d: 10, q: 5, F: 200, K: 100, G: 18 };
    expect(landedCost({ ...base, gamma: 1 })).toMatchObject({ net_unit: 900, taxable: 4800, landed: 5664, unit_landed: 1132.8 });
    expect(landedCost({ ...base, gamma: 0 })).toMatchObject({ taxable: 4800, landed: 4800, unit_landed: 960 });
    expect(landedCost({ ...base, gamma: 1, pta: { enabled: true, rate_pct: 12, reference_days: 30, credit_days: 60 } })).toMatchObject({ pta: 47.34, landed: 5616.66, unit_landed: 1123.33 });
    expect(landedCost({ ...base, gamma: 1, pta: { enabled: false, rate_pct: 12, reference_days: 30, credit_days: 60 } }).pta).toBe(0);
    expect(landedCost({ ...base, gamma: 1, LD: 100, RD: 50 })).toMatchObject({ landed_before_discounts: 5664, landed: 5514, unit_landed: 1102.8 });
    expect(landedCost({ P: 1234.57, d: 7.5, q: 3, F: 95.5, K: 40, G: 18, gamma: 1 })).toMatchObject({ taxable: 3561.43, landed: 4202.49, unit_landed: 1400.83 });
  });
});

describe('Module 4 — comparative statement and award', () => {
  it('AC-CMP-01/02/04: 3 quotes × 4 lines → 4 rows, RFQ total per vendor, landed per formula, LPP variance; RFQ under comparison', async () => {
    const f = fixture({
      lines: [{ material: 'UCG-2002', qty: 4 }, { material: 'HYD-1003', qty: 10 }, { material: 'ENG-3002', qty: 2 }, { material: 'CAP-9901', qty: 1 }],
      vendors: [
        { code: '100102', quotes: [{ basic_price: 38000, discount_pct: 5, freight: 1200, packing: 300 }, { basic_price: 4000 }, { basic_price: 46000 }, { basic_price: 3800000, freight: 25000 }] },
        { code: '100115', quotes: [{ basic_price: 37500 }, { basic_price: 3900, discount_pct: 2 }, { basic_price: 47000 }, { basic_price: 3850000 }] },
        { code: '100103', quotes: [{ basic_price: 39000 }, { basic_price: 4100 }, { basic_price: 45500, freight: 800 }, { basic_price: 3790000, freight: 40000 }] },
      ],
    });
    const amit = await t.login('amit.kulkarni');
    const g = await amit.post(`/api/cmp/rfq/${f.rfqId}/generate`);
    expect(g.status).toBe(200);
    expect(g.body.created).toBe(true);
    const c = (await amit.get(`/api/cmp/${g.body.id}`)).body;
    expect(c.rows).toHaveLength(4);
    expect(c.summary.vendors).toHaveLength(3);
    for (const v of c.summary.vendors) {
      const sum = c.rows.reduce((s: number, r: any) => s + r.cells.find((x: any) => x.vendor_id === v.vendor_id).landed, 0);
      expect(v.total_landed).toBeCloseTo(sum, 2);
    }
    // UCG is ITC-recoverable → γ = 0; CAP is not → γ = 1 (DEC-21 category_itc).
    const r0 = c.rows[0];
    const shakti = r0.cells.find((x: any) => x.vendor_id === f.vendorIds[0]);
    expect(r0.gamma).toBe(0);
    expect(shakti.taxable).toBe(Math.round((38000 * 0.95 * 4 + 1500) * 100) / 100);
    expect(shakti.landed).toBe(shakti.taxable);
    expect(shakti.unit_landed).toBe(Math.round((shakti.landed / 4) * 100) / 100);
    const capCell = c.rows[3].cells.find((x: any) => x.vendor_id === f.vendorIds[0]);
    expect(c.rows[3].gamma).toBe(1);
    expect(capCell.landed).toBe(Math.round(3825000 * 1.18 * 100) / 100);
    expect(c.params.landed_cost.payment_term_adjustment.enabled).toBe(false);
    // Lowest per line highlighted.
    expect(r0.lowest_vendor_ids).toEqual([f.vendorIds[0]]);
    // AC-CMP-04: LPP and variance %.
    const lpp = t.db.get<{ lpp: number }>("SELECT lpp FROM materials WHERE code = 'UCG-2002'")!.lpp;
    expect(r0.lpp).toBe(lpp);
    expect(shakti.var_lpp_pct).toBeCloseTo((36100 - lpp) / lpp, 3);
    expect(t.db.get<{ status: string }>('SELECT status FROM rfqs WHERE id = ?', f.rfqId)!.status).toBe('Under comparison');
    // Generating again without quotation changes returns the same comparison.
    expect((await amit.post(`/api/cmp/rfq/${f.rfqId}/generate`)).body).toMatchObject({ id: g.body.id, created: false });
    // CSV export
    const csv = await amit.get(`/api/cmp/${g.body.id}/csv`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('unit_landed');
  });

  it('only Locked/Final quotations are compared; a draft RFQ cannot be compared', async () => {
    const f = fixture({ lines: [{ material: 'UCG-2002', qty: 2 }], vendors: [{ code: '100102', quotes: [{ basic_price: 38000 }] }, { code: '100115', quotes: [{ basic_price: 30000 }] }] });
    t.db.run("UPDATE quotations SET status = 'Submitted' WHERE rfq_id = ? AND vendor_id = ?", f.rfqId, f.vendorIds[1]);
    const amit = await t.login('amit.kulkarni');
    const g = await amit.post(`/api/cmp/rfq/${f.rfqId}/generate`);
    const c = (await amit.get(`/api/cmp/${g.body.id}`)).body;
    expect(c.summary.vendors.map((v: any) => v.vendor_id)).toEqual([f.vendorIds[0]]);
    const f2 = fixture({ lines: [{ material: 'UCG-2002', qty: 2 }], vendors: [{ code: '100102', quotes: [{ basic_price: 38000 }] }] });
    t.db.run("UPDATE rfqs SET status = 'Draft' WHERE id = ?", f2.rfqId);
    expect((await amit.post(`/api/cmp/rfq/${f2.rfqId}/generate`)).status).toBe(409);
  });

  it('AC-CMP-06: coverage 4 of 6 responded lists declined and non-participating vendors', async () => {
    const q = [{ basic_price: 38000 }];
    const f = fixture({
      lines: [{ material: 'UCG-2002', qty: 2 }],
      vendors: [{ code: '100102', quotes: q }, { code: '100115', quotes: q }, { code: '100103', quotes: q }, { code: '100109', quotes: q }, { code: '100113', status: 'Declined' }, { code: '100106', status: 'Invited' }],
    });
    const amit = await t.login('amit.kulkarni');
    const g = await amit.post(`/api/cmp/rfq/${f.rfqId}/generate`);
    const cov = (await amit.get(`/api/cmp/${g.body.id}`)).body.summary.coverage;
    expect(cov).toMatchObject({ invited: 6, responded: 4, declined: 1, non_participating: 1 });
    expect(cov.vendors.find((v: any) => v.status === 'Non-participating').name).toBe('Deccan Hydraulics & Reman Works');
  });

  it('alternate / partial quotes are ranked separately unless the buyer marks them acceptable', async () => {
    const f = fixture({ lines: [{ material: 'UCG-2002', qty: 10 }], vendors: [{ code: '100102', quotes: [{ basic_price: 38000 }] }, { code: '100115', quotes: [{ basic_price: 30000, partial: true, quoted_qty: 6 }] }] });
    const amit = await t.login('amit.kulkarni');
    const id = (await amit.post(`/api/cmp/rfq/${f.rfqId}/generate`)).body.id;
    let c = (await amit.get(`/api/cmp/${id}`)).body;
    let alt = c.rows[0].cells.find((x: any) => x.vendor_id === f.vendorIds[1]);
    expect(alt).toMatchObject({ eligible: false, rank: null, alt_rank: 1, lowest: false, quoted_qty: 6 });
    expect(c.rows[0].lowest_vendor_ids).toEqual([f.vendorIds[0]]);
    expect((await amit.post(`/api/cmp/${id}/acceptable`, { rfq_line_id: f.lineIds[0], vendor_id: f.vendorIds[1], acceptable: true })).status).toBe(400);
    const ok = await amit.post(`/api/cmp/${id}/acceptable`, { rfq_line_id: f.lineIds[0], vendor_id: f.vendorIds[1], acceptable: true, reason: 'Partial 6 of 10 accepted; balance from second vendor' });
    expect(ok.status).toBe(200);
    alt = ok.body.rows[0].cells.find((x: any) => x.vendor_id === f.vendorIds[1]);
    expect(alt).toMatchObject({ eligible: true, rank: 1, lowest: true });
    c = ok.body;
    expect(c.params.acceptable).toContain(`${f.lineIds[0]}:${f.vendorIds[1]}`);
  });

  it('AC-CMP-03: late discount is a separate field and applies only after cmp.discount approval', async () => {
    const f = fixture({ lines: [{ material: 'UCG-2002', qty: 2 }], vendors: [{ code: '100102', quotes: [{ basic_price: 38000 }] }, { code: '100115', quotes: [{ basic_price: 37000 }] }] });
    const amit = await t.login('amit.kulkarni');
    const id = (await amit.post(`/api/cmp/rfq/${f.rfqId}/generate`)).body.id;
    const d = await amit.post(`/api/cmp/${id}/discounts`, { rfq_line_id: f.lineIds[0], vendor_id: f.vendorIds[0], late: 3000, risk: 500, reason: 'Vendor offered late discount after closing' });
    expect(d.status).toBe(200);
    let cell = d.body.rows[0].cells.find((x: any) => x.vendor_id === f.vendorIds[0]);
    expect(cell).toMatchObject({ ld: 0, rd: 0, ld_pending: 3000, rd_pending: 500, landed: 76000 });
    const s = await amit.post(`/api/cmp/${id}/discounts/submit`);
    expect(s.status).toBe(200);
    const ap = t.db.get<{ id: number; type: string }>("SELECT id, type FROM approvals WHERE object_type = 'comparison' AND object_id = ? AND type = 'cmp.discount'", id)!;
    expect(ap).toBeTruthy();
    // Recommendation is blocked while discounts are pending.
    expect((await amit.put(`/api/cmp/${id}/recommendation`, { awards: [{ rfq_line_id: f.lineIds[0], vendor_id: f.vendorIds[1] }], justification: 'Lowest landed cost' })).status).toBe(409);
    const vikram = await t.login('vikram.joshi');
    expect((await vikram.post(`/api/approvals/${ap.id}/approve`, {})).status).toBe(200);
    const c = (await amit.get(`/api/cmp/${id}`)).body;
    cell = c.rows[0].cells.find((x: any) => x.vendor_id === f.vendorIds[0]);
    expect(cell).toMatchObject({ ld: 3000, rd: 500, ld_pending: 0, landed_before_discounts: 76000, landed: 72500 });
    expect(c.rows[0].lowest_vendor_ids).toEqual([f.vendorIds[0]]);
  });

  it('AC-CMP-05: second-lowest without reason is blocked; with reason creates a deviation approval next to the award; approved → locked PDF → released for PO', async () => {
    const f = fixture({ lines: [{ material: 'UCG-2002', qty: 2 }, { material: 'HYD-1003', qty: 10 }], vendors: [
      { code: '100102', quotes: [{ basic_price: 36000, delivery_days: 20 }, { basic_price: 3900 }] },
      { code: '100115', quotes: [{ basic_price: 38000, delivery_days: 3 }, { basic_price: 4100 }] },
    ] });
    const amit = await t.login('amit.kulkarni');
    const id = (await amit.post(`/api/cmp/rfq/${f.rfqId}/generate`)).body.id;
    const awards = [{ rfq_line_id: f.lineIds[0], vendor_id: f.vendorIds[1], qty: 2 }, { rfq_line_id: f.lineIds[1], vendor_id: f.vendorIds[0], qty: 10 }];
    const blocked = await amit.put(`/api/cmp/${id}/recommendation`, { awards, justification: 'Fastest delivery for breakdown' });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toMatch(/not the lowest landed cost/);
    awards[0] = { ...awards[0], reason: 'Breakdown: 3-day delivery outweighs the price difference' } as any;
    const rec = await amit.put(`/api/cmp/${id}/recommendation`, { awards, justification: 'Fastest delivery for breakdown' });
    expect(rec.status).toBe(200);
    expect(rec.body).toMatchObject({ status: 'Recommendation recorded', deviation: 1 });
    const sub = await amit.post(`/api/cmp/${id}/submit`);
    expect(sub.status).toBe(200);
    expect(sub.body.status).toBe('Submitted for approval');
    const aps = t.db.all<{ id: number; type: string; category: string; value: number; requester_id: number }>("SELECT id, type, category, value, requester_id FROM approvals WHERE object_type = 'comparison' AND object_id = ? ORDER BY id", id);
    expect(aps.map((a) => a.type)).toEqual(['cmp.award', 'exc.deviation']);
    expect(aps[0].value).toBeCloseTo(sub.body.summary.recommendation.total_landed, 2);
    expect(aps[1].category).toBe('exception');
    const vikram = await t.login('vikram.joshi');
    const reg = await vikram.get('/api/approvals/exceptions');
    expect(reg.body.rows.some((r: any) => r.id === aps[1].id && r.type === 'exc.deviation')).toBe(true);
    // Approve the award first: comparison stays submitted until the deviation is also approved.
    expect((await vikram.post(`/api/approvals/${aps[0].id}/approve`, { comment: 'OK' })).status).toBe(200);
    expect(t.db.get<{ status: string }>('SELECT status FROM comparisons WHERE id = ?', id)!.status).toBe('Submitted for approval');
    expect((await vikram.post(`/api/approvals/${aps[1].id}/approve`, {})).status).toBe(200);
    expect(t.db.get<{ status: string }>('SELECT status FROM comparisons WHERE id = ?', id)!.status).toBe('Approved');
    let pdf: number | null = null;
    for (let i = 0; i < 40 && !pdf; i++) { await new Promise((r) => setTimeout(r, 100)); pdf = (await amit.get(`/api/cmp/${id}`)).body.summary.pdf_attachment_id ?? null; }
    expect(pdf).toBeTruthy();
    const att = t.db.get<{ owner_type: string; mime: string }>('SELECT owner_type, mime FROM attachments WHERE id = ?', pdf)!;
    expect(att).toMatchObject({ owner_type: 'comparison', mime: 'application/pdf' });
    const rel = await amit.post(`/api/cmp/${id}/release`);
    expect(rel.status).toBe(200);
    expect(rel.body.status).toBe('Released for PO');
    expect(rel.body.awards[0]).toMatchObject({ rfq_line_id: f.lineIds[0], vendor_id: f.vendorIds[1], qty: 2, lowest: false });
    for (const k of ['pr_line_id', 'unit_price', 'gst_rate', 'freight', 'landed_unit', 'reason']) expect(rel.body.awards[0]).toHaveProperty(k);
    expect(t.db.get<{ status: string }>('SELECT status FROM rfqs WHERE id = ?', f.rfqId)!.status).toBe('Awarded');
  });

  it('returned → editable again; rejected → terminal; reopen with changed quotations → new version', async () => {
    const f = fixture({ lines: [{ material: 'UCG-2002', qty: 2 }], vendors: [{ code: '100102', quotes: [{ basic_price: 36000 }] }, { code: '100115', quotes: [{ basic_price: 38000 }] }] });
    const amit = await t.login('amit.kulkarni');
    const vikram = await t.login('vikram.joshi');
    const id = (await amit.post(`/api/cmp/rfq/${f.rfqId}/generate`)).body.id;
    const awards = [{ rfq_line_id: f.lineIds[0], vendor_id: f.vendorIds[0] }];
    await amit.put(`/api/cmp/${id}/recommendation`, { awards, justification: 'Lowest landed cost' });
    await amit.post(`/api/cmp/${id}/submit`);
    let ap = t.db.get<{ id: number }>("SELECT id FROM approvals WHERE object_type = 'comparison' AND object_id = ? AND status = 'Pending'", id)!;
    expect((await vikram.post(`/api/approvals/${ap.id}/return`, { comment: 'Add warranty comparison' })).status).toBe(200);
    expect((await amit.get(`/api/cmp/${id}`)).body).toMatchObject({ status: 'Returned', editable: true });
    expect((await amit.put(`/api/cmp/${id}/recommendation`, { awards, justification: 'Lowest landed cost; warranty equal' })).status).toBe(200);
    await amit.post(`/api/cmp/${id}/submit`);
    ap = t.db.get<{ id: number }>("SELECT id FROM approvals WHERE object_type = 'comparison' AND object_id = ? AND status = 'Pending'", id)!;
    expect((await vikram.post(`/api/approvals/${ap.id}/reject`, { comment: 'Re-float with more vendors' })).status).toBe(200);
    expect((await amit.get(`/api/cmp/${id}`)).body.status).toBe('Rejected');
    expect((await amit.put(`/api/cmp/${id}/recommendation`, { awards, justification: 'Try again after rejection' })).status).toBe(409);

    const f2 = fixture({ lines: [{ material: 'UCG-2002', qty: 2 }], vendors: [{ code: '100102', quotes: [{ basic_price: 36000 }] }, { code: '100115', quotes: [{ basic_price: 38000 }] }] });
    const v1 = (await amit.post(`/api/cmp/rfq/${f2.rfqId}/generate`)).body.id;
    // Approved reopen: vendor revises the quotation (new version, Final).
    const q = t.db.get<{ id: number; lines: any[] }>('SELECT id, lines_json FROM quotations WHERE rfq_id = ? AND vendor_id = ?', f2.rfqId, f2.vendorIds[1])!;
    t.db.run("UPDATE quotations SET version = 2, status = 'Final', lines_json = ?, updated_at = ? WHERE id = ?", t.db.J(q.lines.map((l) => ({ ...l, basic_price: 35000 }))), t.db.now(), q.id);
    const det = (await amit.get(`/api/cmp/${v1}`)).body;
    expect(det.quotes_changed).toBe(true);
    const g2 = await amit.post(`/api/cmp/rfq/${f2.rfqId}/generate`);
    expect(g2.body.created).toBe(true);
    const c2 = (await amit.get(`/api/cmp/${g2.body.id}`)).body;
    expect(c2.version).toBe(2);
    expect(c2.rows[0].lowest_vendor_ids).toEqual([f2.vendorIds[1]]);
    expect((await amit.get(`/api/cmp/${v1}`)).body.summary.superseded_by).toBe(g2.body.id);
  });

  it('permissions: finance can view, not edit; vendors cannot see comparisons', async () => {
    const meera = await t.login('meera.iyer');
    expect((await meera.get('/api/cmp')).status).toBe(200);
    const any = t.db.get<{ id: number }>('SELECT id FROM comparisons LIMIT 1')!;
    expect((await meera.post(`/api/cmp/${any.id}/submit`)).status).toBe(403);
    const manoj = await t.login('manoj.kale');
    expect((await manoj.get(`/api/cmp/${any.id}`)).status).toBe(403);
  });
});
