/**
 * Extended demo data, masters and support (contracts, vendors, tickets, SAP monitor history).
 * Starts the app with the extras ON and asserts volumes plus a few invariants: every row links to something real,
 * statuses are canonical (core/statuses.ts), and the audit chain still verifies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers.ts';
import { STATUS } from '../core/statuses.ts';

let t: Awaited<ReturnType<typeof startApp>>;
const sessions = new Map<string, ReturnType<typeof t.login>>();
const login = (u: string) => { if (!sessions.has(u)) sessions.set(u, t.login(u)); return sessions.get(u)!; };
beforeAll(async () => { t = await startApp({ demoExtra: true }); }, 60_000);
afterAll(async () => { await t.close(); });

const all = <T = any>(sql: string, ...p: unknown[]) => t.db.all<T>(sql, ...p);
const n = (sql: string, ...p: unknown[]) => t.db.scalar<number>(sql, ...p) ?? 0;
const statuses = (sql: string) => new Set(all<{ s: string }>(sql).map((r) => r.s));

describe('Contracts (extended demo data)', () => {
  it('has platform-created contracts in every lifecycle state and canonical statuses', () => {
    const created = all<{ status: string }>('SELECT status FROM contracts WHERE created_by IS NOT NULL');
    expect(created.length).toBeGreaterThanOrEqual(9);
    const have = new Set(created.map((c) => c.status));
    for (const s of ['Draft', 'Pending approval', 'Pending SAP', 'Active', 'Expiring', 'Expired', 'Renewed', 'Terminated']) expect(have.has(s), `status ${s}`).toBe(true);
    for (const s of statuses('SELECT DISTINCT status AS s FROM contracts')) expect(STATUS.contract).toContain(s);
    // Two approval levels are visible: one request waits at level 1, another at level 2.
    const levels = all<{ lv: number }>("SELECT current_level AS lv FROM approvals WHERE type = 'contract.approval' AND object_type = 'contract' AND status = 'Pending'").map((r) => r.lv);
    expect(levels).toContain(1);
    expect(levels).toContain(2);
  });

  it('covers an FDS with price-list versions, a VMI with min/max and an ARC above 80% item utilisation', () => {
    expect(n("SELECT COUNT(*) FROM (SELECT contract_id FROM price_lists GROUP BY contract_id HAVING COUNT(*) >= 3 AND contract_id IN (SELECT id FROM contracts WHERE type = 'FDS' AND status = 'Active' AND created_by IS NOT NULL))")).toBeGreaterThanOrEqual(1);
    const vmi = all<{ vmi: any }>("SELECT vmi_json FROM contracts WHERE type = 'VMI' AND created_by IS NOT NULL AND status = 'Active'");
    expect(vmi.length).toBeGreaterThanOrEqual(1);
    expect(vmi[0].vmi.items.length).toBeGreaterThanOrEqual(2);
    expect(vmi[0].vmi.items.every((i: any) => i.max > i.min)).toBe(true);
    expect(n("SELECT COUNT(*) FROM contract_items ci JOIN contracts c ON c.id = ci.contract_id WHERE c.type = 'ARC' AND c.created_by IS NOT NULL AND ci.qty_cap > 0 AND ci.consumed_qty * 1.0 / ci.qty_cap > 0.8")).toBeGreaterThanOrEqual(1);
  });

  it('links every contract, item and renewal to something real', () => {
    expect(n('SELECT COUNT(*) FROM contracts WHERE vendor_id NOT IN (SELECT id FROM vendors)')).toBe(0);
    expect(n('SELECT COUNT(*) FROM contract_items WHERE contract_id NOT IN (SELECT id FROM contracts) OR material_id NOT IN (SELECT id FROM materials)')).toBe(0);
    expect(n('SELECT COUNT(*) FROM contracts WHERE renewed_from_id IS NOT NULL AND renewed_from_id NOT IN (SELECT id FROM contracts)')).toBe(0);
    expect(n("SELECT COUNT(*) FROM contracts WHERE renewed_from_id IS NOT NULL AND status = 'Active' AND (SELECT status FROM contracts o WHERE o.id = contracts.renewed_from_id) = 'Renewed'")).toBeGreaterThanOrEqual(1);
    // Contracts in force carry an SAP outline agreement; terminated platform contracts keep their reason.
    expect(n("SELECT COUNT(*) FROM contracts WHERE status IN ('Active','Expiring','Expired','Renewed') AND sap_oa_no IS NULL")).toBe(0);
    expect(n("SELECT COUNT(*) FROM contracts WHERE status = 'Terminated' AND created_by IS NOT NULL AND length(COALESCE(terminated_reason, '')) >= 10")).toBeGreaterThanOrEqual(1);
  });

  it('has off-contract alerts that were justified or dismissed with reasons', () => {
    const decided = all<{ status: string; reason: string | null; approval_id: number | null }>("SELECT status, reason, approval_id FROM contract_alerts WHERE status IN ('Justified','Dismissed','Justification pending approval')");
    expect(decided.length).toBeGreaterThanOrEqual(5);
    expect(decided.filter((a) => a.status === 'Dismissed').length).toBeGreaterThanOrEqual(2);
    expect(decided.filter((a) => a.status === 'Justified').length).toBeGreaterThanOrEqual(1);
    for (const a of decided) expect((a.reason ?? '').length).toBeGreaterThanOrEqual(10);
    for (const a of decided.filter((x) => x.status !== 'Dismissed')) expect(a.approval_id).toBeTruthy();
    expect(n('SELECT COUNT(*) FROM contract_alerts WHERE po_id NOT IN (SELECT id FROM pos) OR contract_id NOT IN (SELECT id FROM contracts)')).toBe(0);
  });

  it('has opportunities accepted into draft ARCs, rejected with a reason and under review', () => {
    const acc = all<{ contract_id: number | null }>("SELECT contract_id FROM opportunities WHERE status = 'Accepted'");
    expect(acc.length).toBeGreaterThanOrEqual(3);
    for (const o of acc) expect(n('SELECT COUNT(*) FROM contracts WHERE id = ? AND type = ?', o.contract_id, 'ARC')).toBe(1);
    const rej = all<{ decision_reason: string }>("SELECT decision_reason FROM opportunities WHERE status = 'Rejected'");
    expect(rej.length).toBeGreaterThanOrEqual(3);
    for (const o of rej) expect((o.decision_reason ?? '').length).toBeGreaterThanOrEqual(10);
    expect(n("SELECT COUNT(*) FROM opportunities WHERE status = 'Under review'")).toBeGreaterThanOrEqual(3);
    for (const s of statuses('SELECT DISTINCT status AS s FROM opportunities')) expect(STATUS.opportunity).toContain(s);
  });

  it('shows the book through the API', async () => {
    const amit = await login('amit.kulkarni');
    const list = await amit.get('/api/contracts');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(24);
    expect((await amit.get('/api/contracts/alerts')).body.length).toBeGreaterThanOrEqual(20);
    expect((await amit.get('/api/contracts/opportunities')).body.length).toBeGreaterThanOrEqual(15);
  });
});

describe('Vendors (extended demo data)', () => {
  it('has applications in every onboarding state', () => {
    const have = statuses('SELECT DISTINCT onboarding_status AS s FROM vendors');
    for (const s of ['Invited', 'Registration in progress', 'Submitted', 'Under review', 'Clarification requested', 'Pending SAP code', 'Rejected', 'Active']) expect(have.has(s), s).toBe(true);
    for (const s of have) expect(STATUS.vendorOnboarding).toContain(s);
    expect(n("SELECT COUNT(*) FROM vendors WHERE onboarding_status NOT IN ('Active')")).toBeGreaterThanOrEqual(7);
    // An expired invitation link exists and the Pending SAP code vendor went through the approval engine.
    expect(n("SELECT COUNT(*) FROM vendors WHERE onboarding_status = 'Invited' AND invite_expires_at < ?", new Date().toISOString())).toBeGreaterThanOrEqual(1);
    const ap = all<{ status: string }>("SELECT a.status FROM approvals a JOIN vendors v ON v.id = a.object_id WHERE a.type = 'vendor.onboarding' AND a.object_type = 'vendor' AND v.onboarding_status = 'Pending SAP code'");
    expect(ap.length).toBeGreaterThanOrEqual(1);
    expect(ap.every((a) => a.status === 'Approved')).toBe(true);
    // A rejected application keeps its reason; a clarification thread has the vendor's answer.
    expect(n("SELECT COUNT(*) FROM comments WHERE object_type = 'vendor' AND body LIKE 'Application rejected:%'")).toBeGreaterThanOrEqual(1);
    expect(n("SELECT COUNT(*) FROM comments WHERE object_type = 'vendor' AND body LIKE 'Clarification requested:%'")).toBeGreaterThanOrEqual(2);
  });

  it('has capability proposals pending and rejected, and change requests in several states', () => {
    for (const s of statuses('SELECT DISTINCT status AS s FROM vendor_capabilities')) expect(STATUS.capability).toContain(s);
    expect(n("SELECT COUNT(*) FROM vendor_capabilities WHERE status = 'Proposed'")).toBeGreaterThanOrEqual(3);
    expect(n("SELECT COUNT(*) FROM vendor_capabilities WHERE status = 'Rejected' AND length(COALESCE(decision_note, '')) >= 10")).toBeGreaterThanOrEqual(2);
    const cr = statuses('SELECT DISTINCT status AS s FROM vendor_change_requests');
    for (const s of cr) expect(STATUS.vendorChange).toContain(s);
    for (const s of ['Pending', 'Rejected', 'Sent to SAP', 'Applied']) expect(cr.has(s), s).toBe(true);
    expect(n("SELECT COUNT(*) FROM vendor_change_requests WHERE high_risk = 1")).toBeGreaterThanOrEqual(3);
    expect(n('SELECT COUNT(*) FROM vendor_change_requests WHERE vendor_id NOT IN (SELECT id FROM vendors)')).toBe(0);
    expect(n('SELECT COUNT(*) FROM vendor_capabilities WHERE vendor_id NOT IN (SELECT id FROM vendors)')).toBe(0);
  });

  it('has KYC documents expiring or expired across at least eight vendors', async () => {
    expect(n("SELECT COUNT(DISTINCT vendor_id) FROM vendor_documents WHERE status = 'Expired' OR (status = 'Valid' AND expiry_date <= date('now', '+30 day'))")).toBeGreaterThanOrEqual(8);
    expect(n("SELECT COUNT(*) FROM vendor_documents WHERE status = 'Valid' AND expiry_date < date('now')")).toBe(0);
    expect(n('SELECT COUNT(*) FROM vendor_documents WHERE vendor_id NOT IN (SELECT id FROM vendors)')).toBe(0);
    const amit = await login('amit.kulkarni');
    const exp = await amit.get('/api/vendors/documents/expiring');
    expect(exp.status).toBe(200);
    expect(new Set(exp.body.map((d: any) => d.vendor_id)).size).toBeGreaterThanOrEqual(8);
  });

  it('has tickets in every category and status with threads, internal notes and SLA breaches', async () => {
    expect(n('SELECT COUNT(*) FROM tickets')).toBeGreaterThanOrEqual(12);
    for (const s of statuses('SELECT DISTINCT status AS s FROM tickets')) expect(STATUS.ticket).toContain(s);
    for (const s of STATUS.ticket) expect(statuses('SELECT DISTINCT status AS s FROM tickets').has(s), s).toBe(true);
    const admin = await login('anjali.verma');
    const meta = (await admin.get('/api/vendors/tickets/meta')).body;
    const cats = statuses('SELECT DISTINCT category AS s FROM tickets');
    for (const c of meta.categories) expect(cats.has(c), c).toBe(true);
    expect(n('SELECT COUNT(*) FROM ticket_messages WHERE internal = 1')).toBeGreaterThanOrEqual(3);
    expect(n("SELECT COUNT(*) FROM tickets WHERE status NOT IN ('Resolved','Closed') AND sla_due < ?", new Date().toISOString())).toBeGreaterThanOrEqual(3);
    expect(n('SELECT COUNT(*) FROM tickets WHERE vendor_id NOT IN (SELECT id FROM vendors) OR raised_by NOT IN (SELECT id FROM users)')).toBe(0);
    expect(n('SELECT COUNT(*) FROM ticket_messages WHERE ticket_id NOT IN (SELECT id FROM tickets)')).toBe(0);
    expect(n('SELECT COUNT(*) FROM tickets t WHERE (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) = 0')).toBe(0);
    // Messages are in time order and never before the ticket was raised.
    expect(n('SELECT COUNT(*) FROM ticket_messages m JOIN tickets t ON t.id = m.ticket_id WHERE m.created_at < t.created_at')).toBe(0);
    const list = (await admin.get('/api/vendors/tickets')).body;
    expect(list.length).toBeGreaterThanOrEqual(12);
    expect(list.some((x: any) => x.sla_breached)).toBe(true);
    // Vendors never see internal notes of their own tickets.
    const nitin = await login('nitin');
    const mine = (await nitin.get('/api/vendors/tickets')).body;
    for (const tk of mine) {
      const d = (await nitin.get(`/api/vendors/tickets/${tk.id}`)).body;
      expect(d.messages.every((m: any) => !m.internal)).toBe(true);
    }
  });
});

describe('SAP monitor history (extended demo data)', () => {
  it('has at least 40 job runs over several days and canonical outcomes', async () => {
    const jobs = all<{ status: string; started_at: string; flow: string }>('SELECT status, started_at, flow FROM integration_jobs');
    expect(jobs.length).toBeGreaterThanOrEqual(40);
    for (const j of jobs) expect(['Running', 'Succeeded', 'Partial', 'Failed']).toContain(j.status);
    expect(new Set(jobs.map((j) => j.started_at.slice(0, 10))).size).toBeGreaterThanOrEqual(6);
    expect(new Set(jobs.map((j) => j.flow)).size).toBeGreaterThanOrEqual(7);
    expect(n("SELECT COUNT(*) FROM integration_jobs WHERE status = 'Running'")).toBe(0);
    expect(n('SELECT COUNT(*) FROM integration_jobs WHERE finished_at IS NOT NULL AND finished_at < started_at')).toBe(0);
    // Newest first: the list the monitor shows starts with the latest start time.
    const neha = await login('neha.gupta');
    const recent = (await neha.get('/api/sap/jobs?limit=200')).body as { started_at: string }[];
    expect(recent.length).toBeGreaterThanOrEqual(40);
    for (let i = 1; i < recent.length; i++) expect(recent[i - 1].started_at >= recent[i].started_at).toBe(true);
  });

  it('has resolved, replayed and discarded integration errors with reasons', async () => {
    const closed = all<{ status: string; resolution_reason: string; flow: string }>("SELECT status, resolution_reason, flow FROM integration_errors WHERE status IN ('Resolved','Discarded','Replayed')");
    for (const s of ['Resolved', 'Discarded', 'Replayed']) expect(closed.some((e) => e.status === s), s).toBe(true);
    expect(closed.filter((e) => e.status === 'Discarded').length).toBeGreaterThanOrEqual(2);
    for (const e of closed) expect((e.resolution_reason ?? '').length).toBeGreaterThanOrEqual(10);
    const flows = new Set(all<{ id: string }>('SELECT DISTINCT flow AS id FROM integration_jobs').map((f) => f.id));
    for (const e of closed) expect(flows.has(e.flow) || /^INT-M\d\d$/.test(e.flow)).toBe(true);
    const neha = await login('neha.gupta');
    const errs = (await neha.get('/api/sap/errors?status=all')).body;
    expect(errs.length).toBeGreaterThanOrEqual(closed.length);
    // Reconciliation and scheduler history: latest reconciliation is the newest run, job runs have outcomes.
    const hist = all<{ ran_at: string }>('SELECT ran_at FROM sap_reconciliations ORDER BY id DESC');
    expect(hist.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < hist.length; i++) expect(hist[i - 1].ran_at >= hist[i].ran_at).toBe(true);
    expect(n("SELECT COUNT(*) FROM job_runs WHERE status NOT IN ('Succeeded','Failed','Running')")).toBe(0);
  });
});

describe('Audit chain', () => {
  it('still verifies after the extended seed', async () => {
    const admin = await login('anjali.verma');
    const v = await admin.get('/api/audit/verify');
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ ok: true });
    expect(v.body.checked).toBeGreaterThan(100);
  });
});
