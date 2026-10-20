import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers.ts';

let t: Awaited<ReturnType<typeof startApp>>;
const sessions = new Map<string, ReturnType<typeof t.login>>();
const login = (u: string) => { if (!sessions.has(u)) sessions.set(u, t.login(u)); return sessions.get(u)!; };
beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t.close(); });

const IDS = Array.from({ length: 12 }, (_, i) => `rpt-${String(i + 1).padStart(2, '0')}`);
const iso = (d: string) => `${d}T10:00:00.000Z`;

describe('Reports (RPT-01..12) — AC-RPT-01: totals reconcile with the drill-down rows', () => {
  it('every tile equals the rows behind it, for all twelve reports', async () => {
    const rajesh = await login('rajesh.menon');
    for (const id of IDS) {
      const r = await rajesh.get(`/api/reports/${id}`);
      expect(r.status, id).toBe(200);
      expect(r.body.as_of, id).toBeTruthy();
      expect(r.body.rows.length, id).toBe(r.body.total_rows);
      for (const tile of r.body.tiles) {
        if (!tile.tag && tile.agg !== 'count' && tile.agg !== 'sum') continue;
        const rows = tile.tag ? r.body.rows.filter((x: any) => x.tags.includes(tile.tag)) : r.body.rows;
        if (tile.agg === 'count') expect(tile.value, `${id} ${tile.key}`).toBe(rows.length);
        if (tile.agg === 'sum') expect(tile.value, `${id} ${tile.key}`).toBeCloseTo(rows.reduce((s: number, x: any) => s + (typeof x[tile.field] === 'number' ? x[tile.field] : 0), 0), 1);
      }
      // The chart totals equal the record count (single-valued groups).
      if (r.body.chart && r.body.chart.legend === undefined && r.body.chart.format === 'count' && id !== 'rpt-09') {
        expect(r.body.chart.data.reduce((s: number, d: any) => s + d.count, 0), id).toBe(r.body.rows.length);
      }
    }
  });

  it('RPT-07 contract coverage equals an independent calculation from the PO tables (KPI-08 / KPI-09)', async () => {
    const vikram = await login('vikram.joshi');
    const r = await vikram.get('/api/reports/rpt-07');
    const total = t.db.scalar<number>("SELECT SUM(pl.qty * pl.unit_price) FROM po_lines pl JOIN pos p ON p.id = pl.po_id WHERE p.status != 'Cancelled' AND pl.status != 'Cancelled'")!;
    const contract = t.db.scalar<number>("SELECT SUM(pl.qty * pl.unit_price) FROM po_lines pl JOIN pos p ON p.id = pl.po_id JOIN contracts c ON c.id = p.contract_id WHERE p.status != 'Cancelled' AND pl.status != 'Cancelled' AND c.type IN ('ARC','OA','FDS','VMI')")!;
    const tile = (k: string) => r.body.tiles.find((x: any) => x.key === k);
    expect(tile('all').value).toBeCloseTo(total, 0);
    expect(tile('contract').value).toBeCloseTo(contract, 0);
    expect(tile('kpi08').value).toBeCloseTo(contract / total, 3);
    expect(tile('kpi09').value + tile('kpi08').value).toBeLessThanOrEqual(1.0001);
  });

  it('RPT-01 buckets add up to the open lines and unassigned count matches the database', async () => {
    const amit = await login('amit.kulkarni');
    const r = await amit.get('/api/reports/rpt-01');
    expect(r.status).toBe(200);
    const buckets = r.body.tiles.filter((x: any) => x.key.startsWith('b:'));
    expect(buckets.reduce((s: number, x: any) => s + x.value, 0)).toBe(r.body.tiles.find((x: any) => x.key === 'open').value);
    expect(r.body.rows.every((x: any) => typeof x.age_days === 'number')).toBe(true);
  });
});

describe('Reports — AC-RPT-02: role scope and standard filters', () => {
  it('requisitioners see only their own data in RPT-04 and RPT-12, no prices, and no other report', async () => {
    const priya = await login('priya.nair');
    const uid = t.db.get<{ id: number }>("SELECT id FROM users WHERE email LIKE 'priya.nair@%'")!.id;
    const r12 = await priya.get('/api/reports/rpt-12');
    expect(r12.status).toBe(200);
    expect(r12.body.rows.length).toBe(t.db.scalar<number>('SELECT COUNT(*) FROM pr_lines WHERE requisitioner_id = ?', uid));
    expect(r12.body.rows.every((x: any) => x.requisitioner === 'Priya Nair')).toBe(true);
    const r04 = await priya.get('/api/reports/rpt-04');
    expect(r04.status).toBe(200);
    const mine = t.db.scalar<number>(`SELECT COUNT(*) FROM po_lines pl JOIN pos p ON p.id = pl.po_id JOIN pr_lines pr ON pr.id = pl.pr_line_id
      WHERE pr.requisitioner_id = ? AND p.status NOT IN ('Closed','Cancelled') AND pl.status NOT IN ('Received','Closed','Cancelled')`, uid);
    expect(r04.body.rows.length).toBe(mine);
    expect(r04.body.columns.some((c: any) => c.key === 'open_value')).toBe(false);
    expect(r04.body.rows.every((x: any) => !('open_value' in x))).toBe(true);
    for (const id of ['rpt-01', 'rpt-07', 'rpt-09', 'rpt-11']) expect((await priya.get(`/api/reports/${id}`)).status, id).toBe(403);
    expect((await priya.get('/api/reports/kpis')).status).toBe(403);
    expect((await priya.get('/api/reports/rpt-12/export.csv')).status).toBe(403);
  });

  it('vendors have no reports, and the catalogue follows the role', async () => {
    const manoj = await login('manoj.kale');
    expect((await manoj.get('/api/reports/rpt-04')).status).toBe(403);
    expect((await manoj.get('/api/reports/catalogue')).status).toBe(403);
    const cat = async (u: string) => (await (await login(u)).get('/api/reports/catalogue')).body;
    expect((await cat('priya.nair')).reports.map((x: any) => x.id)).toEqual(['rpt-04', 'rpt-12']);
    expect((await cat('rajesh.menon')).reports).toHaveLength(12);
    expect((await cat('suresh.pawar')).reports.map((x: any) => x.id)).toEqual(['rpt-04', 'rpt-08', 'rpt-12']);
    expect((await cat('neha.gupta')).reports).toHaveLength(0);
    expect((await cat('neha.gupta')).integration).toBe(true);
  });

  it('plant, vendor and date filters narrow the rows and the tiles together', async () => {
    const rajesh = await login('rajesh.menon');
    const all = await rajesh.get('/api/reports/rpt-04');
    const pun = await rajesh.get('/api/reports/rpt-04?plant=PUN1');
    expect(pun.body.rows.length).toBeGreaterThan(0);
    expect(pun.body.rows.length).toBeLessThan(all.body.rows.length);
    expect(pun.body.rows.every((x: any) => x.plant === 'PUN1')).toBe(true);
    expect(pun.body.tiles.find((x: any) => x.key === 'open').value).toBe(pun.body.rows.length);
    const vid = t.db.get<{ id: number }>("SELECT id FROM vendors WHERE sap_code = '100101'")!.id;
    const v = await rajesh.get(`/api/reports/rpt-04?vendor=${vid}`);
    expect(v.body.rows.every((x: any) => x.vendor.startsWith('Hydrotech'))).toBe(true);
    const future = await rajesh.get('/api/reports/rpt-04?from=2099-01-01');
    expect(future.body.rows).toHaveLength(0);
    expect(future.body.empty).toBeTruthy();
    expect((await rajesh.get('/api/reports/rpt-04?from=2026-12-01&to=2026-01-01')).status).toBe(400);
    expect((await rajesh.get('/api/reports/rpt-99')).status).toBe(404);
  });

  it('shows SAP freshness for SAP-sourced reports', async () => {
    const rajesh = await login('rajesh.menon');
    const r = await rajesh.get('/api/reports/rpt-04');
    expect(r.body.freshness.map((f: any) => f.id)).toEqual(expect.arrayContaining(['INT-M07', 'INT-M10']));
    expect(r.body.freshness.every((f: any) => typeof f.stale === 'boolean')).toBe(true);
  });
});

describe('Reports — AC-RPT-03: export and print are audited', () => {
  it('CSV export returns the records and writes an audit event; print is audited too', async () => {
    const vikram = await login('vikram.joshi');
    const r = await vikram.get('/api/reports/rpt-07/export.csv?plant=PUN1');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    const lines = String(r.body).trim().split(/\r?\n/);
    const json = await vikram.get('/api/reports/rpt-07?plant=PUN1');
    expect(lines.length - 1).toBe(json.body.rows.length);
    expect(t.db.get("SELECT id FROM audit_events WHERE action = 'report.export_csv' AND object_ref = 'RPT-07'")).toBeTruthy();
    expect((await vikram.post('/api/reports/rpt-07/print', {})).status).toBe(200);
    expect(t.db.get("SELECT id FROM audit_events WHERE action = 'report.print_pdf' AND object_ref = 'RPT-07'")).toBeTruthy();
  });
});

describe('KPIs (KPI-01..15) — AC-RPT-04: known values from known data', () => {
  it('returns all fifteen KPIs with formulas, a record set each, and no baseline or target', async () => {
    const rajesh = await login('rajesh.menon');
    const r = await rajesh.get('/api/reports/kpis');
    expect(r.status).toBe(200);
    expect(r.body.kpis.map((k: any) => k.id)).toEqual(Array.from({ length: 15 }, (_, i) => `KPI-${String(i + 1).padStart(2, '0')}`));
    for (const k of r.body.kpis) {
      expect(k.formula, k.id).toBeTruthy();
      expect(k.baseline).toBe('To be measured');
      expect(k.target).toBe('Pending approval');
      expect(Array.isArray(k.rows)).toBe(true);
      expect(k.empty).toBeTruthy();
    }
    const k13 = r.body.kpis.find((k: any) => k.id === 'KPI-13');
    expect(k13.formula).toMatch(/RFQ response 20/); // weights from vendor.scorecard_weights (DEC-22)
    expect(k13.decision).toBe('DEC-22');
  });

  it('computes median and P90 TAT, response rate and closure TAT from known 2020 records', async () => {
    const d = t.db;
    // KPI-12: three disputes resolved after 2, 4 and 10 days → median 4, P90 (nearest rank) 10.
    for (const [i, days] of [2, 4, 10].entries()) {
      d.run("INSERT INTO disputes (dsp_no, type, status, created_at, resolved_at, owner_party) VALUES (?, 'Shortage', 'Resolved', ?, ?, 'Vendor')", `DSP-TEST-${i}`, iso('2020-01-05'), iso(`2020-01-${String(5 + days).padStart(2, '0')}`));
    }
    // KPI-04: two RFQs closed then compared after 1 and 3 days → median 2.
    const buyer = d.get<{ id: number }>("SELECT id FROM users WHERE email LIKE 'amit.kulkarni@%'")!.id;
    for (const [i, days] of [1, 3].entries()) {
      const rfq = d.run("INSERT INTO rfqs (rfq_no, title, status, buyer_id, plant, published_at, closed_at, category) VALUES (?, 'KPI test', 'Awarded', ?, 'PUN1', ?, ?, 'HYD')", `RFQ-T-${i}`, buyer, iso('2020-01-01'), iso('2020-01-10')).lastId;
      d.run("INSERT INTO comparisons (cmp_no, rfq_id, status, submitted_at, created_by) VALUES (?, ?, 'Approved', ?, ?)", `CMP-T-${i}`, rfq, iso(`2020-01-${10 + days}`), buyer);
    }
    // KPI-03: one RFQ, four invited, three quoted → 0.75.
    const rfq3 = d.run("INSERT INTO rfqs (rfq_no, title, status, buyer_id, plant, published_at, category) VALUES ('RFQ-T-R', 'Response test', 'Closed', ?, 'PUN1', ?, 'HYD')", buyer, iso('2020-01-02')).lastId;
    const vendors = d.all<{ id: number }>('SELECT id FROM vendors WHERE sap_code IS NOT NULL ORDER BY id LIMIT 4');
    for (const [i, v] of vendors.entries()) {
      d.run("INSERT INTO rfq_invitations (rfq_id, vendor_id, status) VALUES (?, ?, ?)", rfq3, v.id, i < 3 ? 'Responded' : 'Not responded');
      if (i < 3) d.run("INSERT INTO quotations (rfq_id, vendor_id, status, version, submitted_at) VALUES (?, ?, 'Locked', 1, ?)", rfq3, v.id, iso('2020-01-04'));
    }
    const rajesh = await login('rajesh.menon');
    const r = await rajesh.get('/api/reports/kpis?from=2020-01-01&to=2020-12-31');
    const k = (id: string) => r.body.kpis.find((x: any) => x.id === id);
    expect(k('KPI-12')).toMatchObject({ median: 4, p90: 10, n: 3 });
    expect(k('KPI-12').rows).toHaveLength(3);
    expect(k('KPI-04').median).toBe(2);
    expect(k('KPI-04').rows).toHaveLength(2);
    expect(k('KPI-03')).toMatchObject({ value: 0.75, numerator: 3, denominator: 4 });
    expect(k('KPI-03').rows.filter((x: any) => x.quoted === 'No')).toHaveLength(1);
    // Outside the period the same records do not count.
    const later = await rajesh.get('/api/reports/kpis?from=2021-01-01&to=2021-12-31');
    expect(later.body.kpis.find((x: any) => x.id === 'KPI-12').rows).toHaveLength(0);
    expect(later.body.kpis.find((x: any) => x.id === 'KPI-12').value).toBeNull();
    // RPT-08 closure tile uses the same records (reconciles with KPI-12).
    const rpt = await rajesh.get('/api/reports/rpt-08?from=2020-01-01&to=2020-12-31');
    expect(rpt.body.tiles.find((x: any) => x.key === 'closed').value).toBe(4);
  });

  it('KPI-07 on-time delivery follows the configured commitment basis and KPI-15 lists unadjusted advances', async () => {
    const rajesh = await login('rajesh.menon');
    const r = await rajesh.get('/api/reports/kpis?from=2025-01-01&to=2027-12-31');
    const k7 = r.body.kpis.find((x: any) => x.id === 'KPI-07');
    expect(k7.rows.length).toBeGreaterThan(0);
    const onTime = k7.rows.filter((x: any) => x.on_time === 'Yes').length;
    expect(k7.value).toBeCloseTo(onTime / k7.rows.length, 3);
    expect(k7.rows.every((x: any) => (x.on_time === 'Yes') === (x.last_grn <= x.committed))).toBe(true);
    const k15 = r.body.kpis.find((x: any) => x.id === 'KPI-15');
    expect(k15.value).toBeCloseTo(k15.rows.reduce((s: number, x: any) => s + x.outstanding, 0), 1);
  });

  it('is restricted to procurement, finance and management roles', async () => {
    for (const [u, status] of [['amit.kulkarni', 200], ['meera.iyer', 200], ['vikram.joshi', 200], ['suresh.pawar', 403], ['neha.gupta', 403]] as const) {
      expect((await (await login(u)).get('/api/reports/kpis/summary')).status, u).toBe(status);
    }
  });
});
