/**
 * Extended demo data, engineer B (fulfilment): PO acknowledgements and follow-up, amendments, ASNs and receipt disputes.
 * Starts the app with the extras ON and asserts volumes, situations and referential invariants (DEMO_DATA_BRIEF.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers.ts';
import { STATUS } from '../core/statuses.ts';

let t: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { t = await startApp({ demoExtra: true }); }, 60000);
afterAll(async () => { await t.close(); });

const HIST = "p.po_no >= '4500030001' AND p.po_no < '4500031001'";
const OPEN = "p.po_no >= '4500031001' AND p.po_no < '4500031500'";
const ALL = "p.po_no >= '4500030001' AND p.po_no < '4500031500'";
const all = <T = any>(sql: string, ...p: unknown[]) => t.db.all<T>(sql, ...p);
const n = (sql: string, ...p: unknown[]) => t.db.scalar<number>(sql, ...p) ?? 0;
const today = () => new Date().toISOString().slice(0, 10);

describe('Extended demo data — PO acknowledgement and follow-up', () => {
  it('every historic extra PO line is accepted with a first and a latest commitment', () => {
    const lines = all<any>(`SELECT l.* FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE ${HIST}`);
    expect(lines.length).toBeGreaterThanOrEqual(100);
    for (const l of lines) {
      expect(l.ack_status).toBe('Accepted');
      expect(l.first_commit_date).toBeTruthy();
      expect(l.commit_date).toBeTruthy();
      expect(l.commit_date >= l.first_commit_date).toBe(true);
    }
    const revised = lines.filter((l) => l.commit_date > l.first_commit_date);
    expect(revised.length).toBeGreaterThanOrEqual(15);
    const allowed = t.db.get<{ value: string[] }>("SELECT value_json FROM config WHERE key = 'po.delay_reasons'")?.value ?? [];
    for (const l of revised) if (allowed.length) expect(allowed).toContain(l.delay_reason);
  });

  it('open POs show fresh, viewed-not-acknowledged, partial, rejected and overdue situations', () => {
    const unviewed = n(`SELECT COUNT(*) FROM pos p WHERE ${OPEN} AND p.viewed_at IS NULL AND p.status = 'Published' AND NOT EXISTS (SELECT 1 FROM po_lines l WHERE l.po_id = p.id AND l.ack_status != 'Pending' AND l.ack_status != 'Cancelled')`);
    expect(unviewed).toBeGreaterThanOrEqual(3);
    const viewedPending = n(`SELECT COUNT(*) FROM pos p WHERE ${OPEN} AND p.viewed_at IS NOT NULL AND EXISTS (SELECT 1 FROM po_lines l WHERE l.po_id = p.id AND l.ack_status = 'Pending')`);
    expect(viewedPending).toBeGreaterThanOrEqual(2);
    expect(n(`SELECT COUNT(*) FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE ${OPEN} AND l.ack_status = 'Partially accepted'`)).toBeGreaterThanOrEqual(2);
    expect(n(`SELECT COUNT(*) FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE ${OPEN} AND l.ack_status = 'Rejected'`)).toBeGreaterThanOrEqual(1);
    const overdue = all<any>(`SELECT l.* FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE ${OPEN} AND p.status IN ('Published','Partially received') AND l.ack_status IN ('Accepted','Partially accepted') AND COALESCE(l.commit_date, l.delivery_date) < ?`, today());
    expect(overdue.length).toBeGreaterThanOrEqual(6);
    expect(new Set(overdue.map((l) => l.delay_reason).filter(Boolean)).size).toBeGreaterThanOrEqual(4);
    expect(all(`SELECT l.id FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE ${OPEN} AND l.commit_date > l.first_commit_date`).length).toBeGreaterThanOrEqual(8);
  });

  it('reminders, level 2 and level 3 escalations and follow-up notes with next-action dates exist', () => {
    const perPo = all<{ po_id: number; c: number }>(`SELECT f.po_id, COUNT(*) c FROM po_followups f JOIN pos p ON p.id = f.po_id WHERE ${OPEN} AND f.kind = 'Reminder' GROUP BY f.po_id`);
    expect(perPo.length).toBeGreaterThanOrEqual(8);
    expect(Math.max(...perPo.map((x) => x.c))).toBeGreaterThanOrEqual(3);
    const levels = new Set(all<{ l: number }>(`SELECT json_extract(f.meta_json, '$.level') l FROM po_followups f JOIN pos p ON p.id = f.po_id WHERE ${OPEN} AND f.kind = 'Escalation'`).map((x) => x.l));
    expect(levels.has(2) && levels.has(3)).toBe(true);
    expect(n(`SELECT COUNT(*) FROM po_followups f JOIN pos p ON p.id = f.po_id WHERE ${OPEN} AND f.kind IN ('Call','E-mail','Note','Vendor update') AND f.next_action_date IS NOT NULL`)).toBeGreaterThanOrEqual(5);
    expect(n(`SELECT COUNT(*) FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE ${OPEN} AND l.next_action_date IS NOT NULL`)).toBeGreaterThanOrEqual(8);
    // History is dated in the past, in order
    const bad = all(`SELECT f.id FROM po_followups f JOIN pos p ON p.id = f.po_id WHERE ${ALL} AND f.created_at > ?`, new Date().toISOString());
    expect(bad.length).toBe(0);
  });

  it('amendments exist in every state, including a cancellation, and agree with the PO', () => {
    const rows = all<any>(`SELECT a.*, p.version, p.status AS po_status, p.sap_change_pending FROM po_amendments a JOIN pos p ON p.id = a.po_id WHERE ${OPEN}`);
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const statuses = new Set(rows.map((r) => r.status));
    for (const s of ['Requested', 'Approved', 'Republished', 'Re-acknowledged', 'Rejected', 'Withdrawn']) expect(statuses.has(s)).toBe(true);
    for (const r of rows) expect(STATUS.amendment).toContain(r.status);
    expect(rows.some((r) => r.type === 'Cancel')).toBe(true);
    expect(rows.some((r) => r.type === 'Cancel' && r.po_status === 'Cancelled')).toBe(true);
    for (const r of rows.filter((x) => x.status === 'Approved')) expect(r.sap_change_pending).toBe(1);
    for (const r of rows.filter((x) => ['Republished', 'Re-acknowledged'].includes(x.status))) { expect(r.version).toBeGreaterThanOrEqual(2); expect(r.sap_changed_at).toBeTruthy(); }
    for (const r of rows.filter((x) => !x.raised_by_vendor && x.status !== 'Withdrawn')) expect(r.approval_id).toBeTruthy();
    expect(rows.some((r) => r.raised_by_vendor)).toBe(true);
    // Approvals linked to amendments reference real approvals
    for (const r of rows.filter((x) => x.approval_id)) expect(t.db.get('SELECT id FROM approvals WHERE id = ?', r.approval_id)).toBeTruthy();
  });
});

describe('Extended demo data — ASNs', () => {
  it('has at least 14 ASNs in every state, with documents, matched receipts and an overdue Equipcare pickup', () => {
    const asns = all<any>(`SELECT a.* FROM asns a JOIN pos p ON p.id = a.po_id WHERE ${ALL}`);
    expect(asns.length).toBeGreaterThanOrEqual(14);
    const statuses = new Set(asns.map((a) => a.status));
    for (const s of STATUS.asn) expect(statuses.has(s)).toBe(true);
    for (const a of asns) {
      expect(STATUS.asn).toContain(a.status);
      // Every ASN line is a real line of its own PO
      for (const l of JSON.parse(a.lines_json ?? '[]')) expect(t.db.get('SELECT id FROM po_lines WHERE id = ? AND po_id = ?', l.po_line_id, a.po_id)).toBeTruthy();
      expect(n('SELECT COUNT(*) FROM attachments WHERE owner_type = ? AND owner_id = ?', 'asn', a.id)).toBeGreaterThanOrEqual(1);
    }
    for (const a of asns.filter((x) => x.status === 'Delivered')) {
      const links = all<{ grn_no: string }>('SELECT grn_no FROM asn_grns WHERE asn_id = ?', a.id);
      expect(links.length).toBeGreaterThanOrEqual(1);
      for (const g of links) expect(n('SELECT COUNT(*) FROM grns WHERE grn_no = ? AND po_id = ?', g.grn_no, a.po_id)).toBeGreaterThanOrEqual(1);
      expect(a.delivered_at).toBeTruthy();
    }
    expect(asns.some((a) => a.status === 'Submitted' && a.pickup_by === 'Equipcare' && ['Requested', 'Scheduled'].includes(a.pickup_status) && a.pickup_date < today())).toBe(true);
    expect(asns.some((a) => a.status === 'Cancelled' && a.cancel_reason)).toBe(true);
    expect(asns.filter((a) => a.status === 'Draft').every((a) => !a.submitted_at)).toBe(true);
  });

  it('is visible through the API to the buyer and flags the overdue pickup', async () => {
    const amit = await t.login('amit.kulkarni');
    const r = await amit.get('/api/asn/asns?include_drafts=1');
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThanOrEqual(14);
    expect(r.body.filter((a: any) => a.pickup_overdue).length).toBeGreaterThanOrEqual(2);
  });
});

describe('Extended demo data — disputes', () => {
  it('has at least 12 extra disputes across all types, owners, terms and statuses, aged 1 to 40 days', () => {
    const d = all<any>(`SELECT d.*, p.po_no FROM disputes d JOIN pos p ON p.id = d.po_id WHERE ${ALL}`);
    expect(d.length).toBeGreaterThanOrEqual(12);
    for (const type of ['Shortage', 'Excess', 'Damage', 'Transit damage', 'Transit loss', 'Accidental loss', 'Wrong material', 'Quality rejection', 'Document mismatch']) expect(d.some((x) => x.type === type)).toBe(true);
    for (const party of ['Vendor', 'Procurement', 'Stores', 'Finance', 'Logistics']) expect(d.some((x) => x.owner_party === party)).toBe(true);
    expect(new Set(d.map((x) => x.delivery_term))).toEqual(new Set(['FOR', 'Ex-Works']));
    for (const s of ['Awaiting response', 'Assigned', 'Under resolution', 'Resolved', 'Closed', 'Reopened']) expect(d.some((x) => x.status === s)).toBe(true);
    const ages = d.map((x) => (Date.now() - new Date(x.created_at).getTime()) / 86400000);
    expect(Math.min(...ages)).toBeLessThan(2.5);
    expect(Math.max(...ages)).toBeGreaterThan(38);
    for (const x of d) {
      expect(STATUS.dispute).toContain(x.status);
      expect(t.db.get('SELECT id FROM po_lines WHERE id = ? AND po_id = ?', x.po_line_id, x.po_id)).toBeTruthy();
      if (x.grn_id) expect(t.db.get('SELECT id FROM grns WHERE id = ? AND po_line_id = ?', x.grn_id, x.po_line_id)).toBeTruthy();
      if (x.asn_id) expect(t.db.get('SELECT id FROM asns WHERE id = ? AND po_id = ?', x.asn_id, x.po_id)).toBeTruthy();
      expect(x.created_at <= new Date().toISOString()).toBe(true);
    }
  });

  it('carries evidence, vendor responses and outcomes with amounts, and one closure waiting for approval', () => {
    const d = all<any>(`SELECT d.* FROM disputes d JOIN pos p ON p.id = d.po_id WHERE ${ALL}`);
    const ids = d.map((x) => x.id);
    const marks = ids.map(() => '?').join(',');
    expect(n(`SELECT COUNT(*) FROM attachments WHERE owner_type = 'dispute' AND owner_id IN (${marks})`, ...ids)).toBeGreaterThanOrEqual(8);
    expect(n(`SELECT COUNT(*) FROM dispute_events WHERE kind = 'vendor_response' AND dispute_id IN (${marks})`, ...ids)).toBeGreaterThanOrEqual(3);
    const withAmount = d.filter((x) => ['Credit note', 'Debit note', 'Transporter claim', 'Insurance claim'].includes(x.outcome));
    expect(withAmount.length).toBeGreaterThanOrEqual(3);
    for (const x of withAmount) expect(x.outcome_amount).toBeGreaterThan(0);
    for (const x of d.filter((y) => ['Resolved', 'Closed'].includes(y.status))) { expect(x.outcome).toBeTruthy(); expect(x.resolved_at).toBeTruthy(); }
    for (const x of d.filter((y) => y.status === 'Closed')) expect(x.closed_at).toBeTruthy();
    const pending = d.filter((x) => x.status === 'Resolved' && x.closure_approval_id);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    for (const x of pending) expect(t.db.get<any>('SELECT type, status FROM approvals WHERE id = ?', x.closure_approval_id)).toMatchObject({ type: 'dispute.closure', status: 'Pending' });
    // Timeline events are in the past and never earlier than the dispute itself
    for (const x of d) for (const e of all<any>('SELECT created_at FROM dispute_events WHERE dispute_id = ?', x.id)) expect(e.created_at >= x.created_at).toBe(true);
  });

  it('is visible through the API: dispute list, ageing report and a vendor-safe timeline', async () => {
    const amit = await t.login('amit.kulkarni');
    const list = await amit.get('/api/asn/disputes');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(18);
    const ageing = await amit.get('/api/asn/disputes/ageing?by=owner');
    expect(ageing.status).toBe(200);
    // A vendor sees only its own disputes and never the internal notes
    const sanjay = await t.login('sanjay');
    const mine = await sanjay.get('/api/asn/disputes');
    expect(mine.status).toBe(200);
    for (const row of mine.body) {
      const det = await sanjay.get(`/api/asn/disputes/${row.id}`);
      expect(det.status).toBe(200);
      expect(det.body.events.every((e: any) => e.vendor_visible === 1 || e.vendor_visible === true)).toBe(true);
    }
  });
});

describe('Extended demo data — integrity', () => {
  it('uses canonical statuses everywhere and keeps the audit chain intact', async () => {
    for (const r of all<{ ack_status: string }>('SELECT DISTINCT ack_status FROM po_lines')) expect(STATUS.poLineAck).toContain(r.ack_status);
    for (const r of all<{ status: string }>('SELECT DISTINCT status FROM po_lines')) expect(STATUS.poLine).toContain(r.status);
    for (const r of all<{ status: string }>('SELECT DISTINCT status FROM pos')) expect(STATUS.po).toContain(r.status);
    for (const r of all<{ id: number }>(`SELECT f.id FROM po_followups f LEFT JOIN pos p ON p.id = f.po_id WHERE p.id IS NULL`)) expect(r).toBeUndefined();
    const mgt = await t.login('rajesh.menon');
    const v = await mgt.get('/api/audit/verify');
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ ok: true });
  });
});
