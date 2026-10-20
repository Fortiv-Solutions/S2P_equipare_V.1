/**
 * Extended demo data, engineer A (sourcing): PR routing, RFQs and quotations, comparative statements and approvals.
 * Starts the app with the extras ON and asserts volumes, situations and referential invariants (DEMO_DATA_BRIEF.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers.ts';
import { STATUS } from '../core/statuses.ts';

let t: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { t = await startApp({ demoExtra: true }); }, 90000);
afterAll(async () => { await t.close(); });

const all = <T = any>(sql: string, ...p: unknown[]) => t.db.all<T>(sql, ...p);
const n = (sql: string, ...p: unknown[]) => t.db.scalar<number>(sql, ...p) ?? 0;
const canon = (list: readonly string[], values: string[]) => { for (const v of values) expect(list, `status "${v}"`).toContain(v); };

describe('Extended demo data — PR workbench', () => {
  it('about fifty open lines have been checked and routed by their buyers', () => {
    expect(n('SELECT COUNT(DISTINCT pr_line_id) FROM route_decisions')).toBeGreaterThanOrEqual(45);
    const routes = all<{ route: string }>("SELECT DISTINCT route FROM pr_lines WHERE route IS NOT NULL AND status IN ('Contract/VMI PO pending','Route decided','RFQ in progress')").map((r) => r.route);
    for (const r of ['ARC/OA', 'VMI', 'FDS', 'Fixed supplier', 'RFQ', 'Urgent/BD', 'Class 1', 'Service', 'Capex']) expect(routes, r).toContain(r);
    expect(n("SELECT COUNT(*) FROM pr_lines WHERE status = 'Contract/VMI PO pending'")).toBeGreaterThanOrEqual(8);
  });

  it('has overrides with off-contract approvals, holds, clarification threads and closed lines', () => {
    expect(n("SELECT COUNT(*) FROM route_decisions d JOIN approvals a ON a.id = d.approval_id WHERE d.override = 1 AND a.type = 'exc.off_contract'")).toBeGreaterThanOrEqual(3);
    for (const d of all<any>("SELECT d.reason FROM route_decisions d WHERE d.override = 1")) expect(String(d.reason ?? '').length).toBeGreaterThanOrEqual(10);
    expect(n("SELECT COUNT(*) FROM pr_lines WHERE status = 'On hold' AND hold_reason IS NOT NULL")).toBeGreaterThanOrEqual(2);
    expect(n("SELECT COUNT(*) FROM pr_lines WHERE status = 'Clarification pending'")).toBeGreaterThanOrEqual(2);
    expect(n("SELECT COUNT(*) FROM pr_lines WHERE status = 'Closed' AND closed_at IS NOT NULL")).toBeGreaterThanOrEqual(2);
    // at least one thread has a reply from the requisitioner
    const threads = all<{ object_id: number; users: number; msgs: number }>("SELECT object_id, COUNT(DISTINCT user_id) users, COUNT(*) msgs FROM comments WHERE object_type = 'pr_line' GROUP BY object_id HAVING msgs >= 2");
    expect(threads.some((x) => x.users >= 2)).toBe(true);
  });

  it('uses canonical statuses and re-dates every decision after the line was assigned', () => {
    canon(STATUS.prLine, all<{ status: string }>('SELECT DISTINCT status FROM pr_lines').map((r) => r.status));
    expect(n('SELECT COUNT(*) FROM route_decisions d JOIN pr_lines p ON p.id = d.pr_line_id WHERE d.decided_at < p.assigned_at')).toBe(0);
    expect(n("SELECT COUNT(*) FROM route_decisions WHERE decided_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')")).toBe(0);
  });
});

describe('Extended demo data — RFQs and quotations', () => {
  it('has at least 18 RFQs in every state', () => {
    const by = Object.fromEntries(all<{ status: string; c: number }>('SELECT status, COUNT(*) c FROM rfqs GROUP BY status').map((r) => [r.status, r.c]));
    expect(n('SELECT COUNT(*) FROM rfqs')).toBeGreaterThanOrEqual(18);
    expect(by['Draft']).toBeGreaterThanOrEqual(3);
    expect(by['Published']).toBeGreaterThanOrEqual(4);
    expect(by['Closed']).toBeGreaterThanOrEqual(2);
    expect(by['Under comparison']).toBeGreaterThanOrEqual(2);
    expect(by['Awarded']).toBeGreaterThanOrEqual(4);
    expect(by['Cancelled']).toBeGreaterThanOrEqual(1);
    expect(by['Re-floated']).toBeGreaterThanOrEqual(1);
    expect(by['Pending approval']).toBeGreaterThanOrEqual(1);
    canon(STATUS.rfq, Object.keys(by));
    canon(STATUS.invitation, all<{ status: string }>('SELECT DISTINCT status FROM rfq_invitations').map((r) => r.status));
    canon(STATUS.quotation, all<{ status: string }>('SELECT DISTINCT status FROM quotations').map((r) => r.status));
  });

  it('has a published RFQ closing today, mixed participation, and a limited-source RFQ waiting for approval', () => {
    const live = all<any>("SELECT id, closing_at FROM rfqs WHERE status = 'Published'");
    const start = Date.now(), endOfToday = new Date(); endOfToday.setUTCHours(23, 59, 59, 999);
    expect(live.some((r) => Date.parse(r.closing_at) > start && Date.parse(r.closing_at) <= endOfToday.getTime() + 6 * 3600000)).toBe(true);
    const mixed = live.filter((r) => n("SELECT COUNT(DISTINCT status) FROM rfq_invitations WHERE rfq_id = ? AND sent_at IS NOT NULL", r.id) >= 3);
    expect(mixed.length).toBeGreaterThanOrEqual(2);
    const lim = all<any>("SELECT r.id, r.exception_approval_id FROM rfqs r WHERE r.status = 'Pending approval'");
    expect(lim.length).toBeGreaterThanOrEqual(1);
    for (const r of lim) {
      const a = t.db.get<any>('SELECT type, status FROM approvals WHERE id = ?', r.exception_approval_id);
      expect(a).toMatchObject({ type: 'exc.single_source', status: 'Pending' });
    }
  });

  it('has an annual-rate RFQ raised from an opportunity, linked both ways', () => {
    const arc = all<any>("SELECT id, opportunity_id FROM rfqs WHERE kind = 'ARC'");
    expect(arc.length).toBeGreaterThanOrEqual(1);
    for (const r of arc) expect(t.db.get<any>('SELECT rfq_id FROM opportunities WHERE id = ?', r.opportunity_id)?.rfq_id).toBe(r.id);
  });

  it('invites at least three vendors (except the limited-source RFQ) and quotes around the last purchase price', () => {
    const rfqs = all<any>("SELECT id, status FROM rfqs WHERE id > 4 AND status NOT IN ('Pending approval')");
    for (const r of rfqs) expect(n('SELECT COUNT(*) FROM rfq_invitations WHERE rfq_id = ?', r.id), `RFQ ${r.id}`).toBeGreaterThanOrEqual(3);
    const quotes = all<any>(`SELECT json_extract(j.value, '$.basic_price') price, json_extract(j.value, '$.no_quote') nq, m.lpp, json_extract(j.value, '$.delivery_days') days
      FROM quotations q, json_each(q.lines_json) j JOIN rfq_lines l ON l.id = json_extract(j.value, '$.rfq_line_id') JOIN materials m ON m.id = l.material_id
      WHERE q.status IN ('Submitted','Locked') AND q.rfq_id > 4`);
    expect(quotes.length).toBeGreaterThanOrEqual(50);
    for (const q of quotes.filter((x) => !x.nq && x.lpp)) { expect(q.price / q.lpp).toBeGreaterThan(0.8); expect(q.price / q.lpp).toBeLessThan(1.3); }
    expect(new Set(quotes.map((q) => q.days)).size).toBeGreaterThanOrEqual(8);
    const terms = new Set(all<{ d: string }>("SELECT DISTINCT delivery_terms d FROM quotations WHERE rfq_id > 4 AND delivery_terms IS NOT NULL").map((r) => r.d));
    expect(terms.has('FOR') && terms.has('Ex-Works')).toBe(true);
    expect(n("SELECT COUNT(*) FROM quotations q, json_each(q.lines_json) j WHERE q.rfq_id > 4 AND json_extract(j.value, '$.alternate') = 1")).toBeGreaterThanOrEqual(2);
    expect(n("SELECT COUNT(*) FROM quotations q, json_each(q.lines_json) j WHERE q.rfq_id > 4 AND json_extract(j.value, '$.partial') = 1")).toBeGreaterThanOrEqual(1);
    expect(n("SELECT COUNT(*) FROM rfq_invitations WHERE rfq_id > 4 AND status = 'Declined' AND decline_reason IS NOT NULL")).toBeGreaterThanOrEqual(3);
    expect(n("SELECT COUNT(*) FROM rfq_invitations WHERE rfq_id > 4 AND status = 'Not responded'")).toBeGreaterThanOrEqual(2);
    expect(n('SELECT COUNT(*) FROM quotation_versions WHERE version > 1')).toBeGreaterThanOrEqual(1);
  });

  it('links every row to something real and never dates anything in the future', () => {
    expect(n('SELECT COUNT(*) FROM rfq_lines l WHERE NOT EXISTS (SELECT 1 FROM rfqs r WHERE r.id = l.rfq_id)')).toBe(0);
    expect(n('SELECT COUNT(*) FROM rfq_lines l WHERE l.pr_line_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pr_lines p WHERE p.id = l.pr_line_id)')).toBe(0);
    expect(n('SELECT COUNT(*) FROM rfq_invitations i WHERE NOT EXISTS (SELECT 1 FROM vendors v WHERE v.id = i.vendor_id) OR NOT EXISTS (SELECT 1 FROM rfqs r WHERE r.id = i.rfq_id)')).toBe(0);
    expect(n('SELECT COUNT(*) FROM quotations q WHERE NOT EXISTS (SELECT 1 FROM vendors v WHERE v.id = q.vendor_id) OR NOT EXISTS (SELECT 1 FROM rfqs r WHERE r.id = q.rfq_id)')).toBe(0);
    // every PR line in an active RFQ points at that RFQ
    expect(n("SELECT COUNT(*) FROM pr_lines p WHERE p.status = 'RFQ in progress' AND NOT EXISTS (SELECT 1 FROM rfq_lines l WHERE l.pr_line_id = p.id AND l.rfq_id = p.rfq_id AND l.status != 'Removed')")).toBe(0);
    const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
    for (const [tbl, col] of [['rfq_invitations', 'responded_at'], ['rfq_invitations', 'viewed_at'], ['rfq_invitations', 'sent_at'], ['quotations', 'submitted_at'], ['rfqs', 'published_at'], ['comparisons', 'created_at'], ['approvals', 'created_at'], ['approval_steps', 'acted_at']]) {
      expect(n(`SELECT COUNT(*) FROM ${tbl} WHERE ${col} > ${now}`), `${tbl}.${col}`).toBe(0);
    }
    expect(n('SELECT COUNT(*) FROM rfqs r JOIN rfq_invitations i ON i.rfq_id = r.id WHERE i.sent_at < r.published_at')).toBe(0);
  });
});

describe('Extended demo data — comparative statements', () => {
  it('has at least eight comparisons across every state', () => {
    const by = Object.fromEntries(all<{ status: string; c: number }>('SELECT status, COUNT(*) c FROM comparisons GROUP BY status').map((r) => [r.status, r.c]));
    expect(n('SELECT COUNT(*) FROM comparisons')).toBeGreaterThanOrEqual(8);
    for (const s of ['Draft', 'Recommendation recorded', 'Submitted for approval', 'Approved', 'Returned', 'Rejected', 'Released for PO']) expect(by[s], s).toBeGreaterThanOrEqual(1);
    canon(STATUS.comparison, Object.keys(by));
    // submitted ones wait at different levels
    const levels = new Set(all<{ l: number }>("SELECT a.current_level l FROM comparisons c JOIN approvals a ON a.id = c.approval_id WHERE c.status = 'Submitted for approval' AND a.status = 'Pending'").map((r) => r.l));
    expect(levels.has(1) && levels.has(2)).toBe(true);
  });

  it('keeps comparison, RFQ and award consistent', () => {
    for (const c of all<any>('SELECT * FROM comparisons')) {
      const rfq = t.db.get<any>('SELECT status FROM rfqs WHERE id = ?', c.rfq_id);
      expect(rfq, `RFQ of ${c.cmp_no}`).toBeTruthy();
      if (c.status === 'Released for PO') expect(rfq.status).toBe('Awarded');
      else expect(['Under comparison', 'Closed', 'Awarded', 'Re-floated']).toContain(rfq.status);
      if (['Released for PO', 'Approved'].includes(c.status)) expect(c.awards.length).toBeGreaterThanOrEqual(1);
    }
    expect(n("SELECT COUNT(*) FROM comparisons WHERE status = 'Released for PO'")).toBeGreaterThanOrEqual(4);
  });

  it('links historic purchase orders to the RFQ and comparison behind them', () => {
    const pos = all<any>('SELECT p.id, p.vendor_id, p.rfq_id, p.comparison_id, p.po_date FROM pos p WHERE p.rfq_id IS NOT NULL AND p.po_no >= \'4500030001\' AND p.po_no < \'4500031001\'');
    expect(pos.length).toBeGreaterThanOrEqual(3);
    for (const p of pos) {
      const c = t.db.get<any>('SELECT * FROM comparisons WHERE id = ?', p.comparison_id);
      expect(c.rfq_id).toBe(p.rfq_id);
      expect(c.status).toBe('Released for PO');
      expect(c.awards.every((a: any) => a.vendor_id === p.vendor_id)).toBe(true);
      expect(String(c.sap_handoff_at).slice(0, 10) <= p.po_date).toBe(true);
    }
  });
});

describe('Extended demo data — approvals', () => {
  it('has at least 28 approvals across types and statuses, including the exception types', () => {
    expect(n('SELECT COUNT(*) FROM approvals')).toBeGreaterThanOrEqual(28);
    const types = new Set(all<{ type: string }>('SELECT DISTINCT type FROM approvals').map((r) => r.type));
    for (const x of ['cmp.award', 'exc.deviation', 'exc.single_source', 'exc.urgent', 'exc.po_after_receipt', 'exc.off_contract', 'exc.price_amendment', 'rfq.reopen', 'cmp.discount']) expect(types.has(x), x).toBe(true);
    const statuses = new Set(all<{ status: string }>('SELECT DISTINCT status FROM approvals').map((r) => r.status));
    canon(STATUS.approval, [...statuses]);
    for (const s of ['Pending', 'Approved', 'Rejected', 'Returned']) expect(statuses.has(s), s).toBe(true);
  });

  it('spreads pending approvals over every ageing bucket', () => {
    const edges = [1, 3, 6];
    const buckets = [0, 0, 0, 0];
    for (const a of all<{ created_at: string }>("SELECT created_at FROM approvals WHERE status = 'Pending'")) {
      const age = (Date.now() - Date.parse(a.created_at)) / 86400000;
      const i = edges.findIndex((e) => age < e);
      buckets[i === -1 ? edges.length : i]++;
    }
    for (const b of buckets) expect(b).toBeGreaterThanOrEqual(1);
  });

  it('links every approval to a real record and keeps segregation of duties', () => {
    const table: Record<string, string> = { pr_line: 'pr_lines', comparison: 'comparisons', rfq: 'rfqs', rfq_reopen: 'rfq_reopens', po: 'pos', po_amendment: 'po_amendments', contract: 'contracts', advance: 'advances', vendor: 'vendors', vendor_change: 'vendor_change_requests', dispute: 'disputes' };
    for (const a of all<any>('SELECT id, object_type, object_id FROM approvals')) {
      const tbl = table[a.object_type];
      if (!tbl) continue;
      expect(n(`SELECT COUNT(*) FROM ${tbl} WHERE id = ?`, a.object_id), `${a.object_type} ${a.object_id}`).toBe(1);
    }
    expect(n('SELECT COUNT(*) FROM approval_steps s JOIN approvals a ON a.id = s.approval_id WHERE s.acted_by IS NOT NULL AND s.acted_by = a.requester_id')).toBe(0);
    for (const a of all<any>("SELECT id FROM approvals WHERE status IN ('Approved','Rejected','Returned')")) {
      expect(t.db.get<any>('SELECT decided_at FROM approvals WHERE id = ?', a.id).decided_at).toBeTruthy();
    }
  });

  it('shows the approvals in the inbox for an approver', async () => {
    const vikram = await t.login('vikram.joshi');
    const r = await vikram.get('/api/approvals?tab=all');
    expect(r.status).toBe(200);
    expect((r.body.rows ?? r.body).length).toBeGreaterThanOrEqual(28);
  });
});

describe('Extended demo data — screens open', () => {
  it('every RFQ, comparison, approval and routed PR line opens through the API', async () => {
    const amit = await t.login('amit.kulkarni');
    const vikram = await t.login('vikram.joshi');
    for (const r of all<{ id: number }>('SELECT id FROM rfqs')) expect((await amit.get(`/api/rfq/rfqs/${r.id}`)).status, `rfq ${r.id}`).toBe(200);
    for (const c of all<{ id: number }>('SELECT id FROM comparisons')) expect((await amit.get(`/api/cmp/${c.id}`)).status, `comparison ${c.id}`).toBe(200);
    for (const a of all<{ id: number }>("SELECT id FROM approvals WHERE type IN ('cmp.award','exc.deviation','exc.single_source','exc.urgent','exc.po_after_receipt','exc.off_contract','exc.price_amendment','rfq.reopen','cmp.discount')")) expect((await vikram.get(`/api/approvals/${a.id}`)).status, `approval ${a.id}`).toBe(200);
    for (const l of all<{ id: number }>('SELECT DISTINCT pr_line_id AS id FROM route_decisions')) expect((await amit.get(`/api/pr/lines/${l.id}`)).status, `pr line ${l.id}`).toBe(200);
    expect((await vikram.get('/api/approvals/ageing?by=approver')).status).toBe(200);
    expect((await amit.get('/api/rfq/rfqs')).status).toBe(200);
  });
});

describe('Audit chain', () => {
  it('still verifies after the extended sourcing seed', async () => {
    const admin = await t.login('anjali.verma');
    const v = await admin.get('/api/audit/verify');
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ ok: true });
  });
});
