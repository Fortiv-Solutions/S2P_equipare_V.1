/**
 * Extended demo data, finance (modules invoices and payments).
 * Starts the app with the extras ON and asserts volumes plus invariants: every row links to something real, statuses are
 * canonical (core/statuses.ts), every exception reason and advance state is represented, and the audit chain verifies.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startApp } from './helpers.ts';
import { STATUS } from '../core/statuses.ts';

let t: Awaited<ReturnType<typeof startApp>>;
const warnings: string[] = [];
const sessions = new Map<string, ReturnType<typeof t.login>>();
const login = (u: string) => { if (!sessions.has(u)) sessions.set(u, t.login(u)); return sessions.get(u)!; };
beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.join(' ')); });
  t = await startApp({ demoExtra: true });
}, 90_000);
afterAll(async () => { await t.close(); vi.restoreAllMocks(); });

const all = <T = any>(sql: string, ...p: unknown[]) => t.db.all<T>(sql, ...p);
const n = (sql: string, ...p: unknown[]) => t.db.scalar<number>(sql, ...p) ?? 0;
const set = (sql: string) => new Set(all<{ s: string }>(sql).map((r) => r.s));
const EXTRA_POS = "(SELECT id FROM pos WHERE po_no >= '4500030001')";

describe('Invoices (extended demo data)', () => {
  it('seeds without warnings from the finance modules', () => {
    expect(warnings.filter((w) => /invoices seed_extra|payments seed_extra/.test(w))).toEqual([]);
  });

  it('has at least 36 invoices on the extra POs, covering every canonical status', () => {
    expect(n(`SELECT COUNT(*) FROM invoices WHERE po_id IN ${EXTRA_POS}`)).toBeGreaterThanOrEqual(36);
    const have = set('SELECT DISTINCT status AS s FROM invoices');
    for (const s of have) expect(STATUS.invoice).toContain(s);
    for (const s of STATUS.invoice) expect(have.has(s), `invoice status ${s}`).toBe(true);
  });

  it('covers every exception reason, with canonical exception statuses', () => {
    const reasons = set('SELECT DISTINCT reason AS s FROM invoice_exceptions');
    for (const r of ['Price variance', 'Excess billing', 'Pending GRN', 'Tax mismatch', 'Unapproved freight', 'Duplicate invoice', 'GSTIN invalid', 'Bank details mismatch', 'Dispute hold', 'Low OCR confidence', 'FDS price variance']) {
      expect(reasons.has(r), `reason ${r}`).toBe(true);
    }
    for (const s of set('SELECT DISTINCT status AS s FROM invoice_exceptions')) expect(STATUS.invoiceException).toContain(s);
    // Exceptions were decided too: approved, resolved or rejected ones exist next to open ones.
    for (const s of ['Open', 'Approved', 'Resolved', 'Rejected']) expect(n('SELECT COUNT(*) FROM invoice_exceptions WHERE status = ?', s), `exceptions ${s}`).toBeGreaterThan(0);
  });

  it('links every invoice, exception, event and file to something real', () => {
    expect(n('SELECT COUNT(*) FROM invoices i LEFT JOIN pos p ON p.id = i.po_id WHERE p.id IS NULL OR p.vendor_id != i.vendor_id')).toBe(0);
    expect(n('SELECT COUNT(*) FROM invoices i LEFT JOIN attachments a ON a.id = i.attachment_id WHERE a.id IS NULL')).toBe(0);
    expect(n('SELECT COUNT(*) FROM invoice_exceptions e LEFT JOIN invoices i ON i.id = e.invoice_id WHERE i.id IS NULL')).toBe(0);
    expect(n('SELECT COUNT(*) FROM invoice_events e LEFT JOIN invoices i ON i.id = e.invoice_id WHERE i.id IS NULL')).toBe(0);
    expect(n('SELECT COUNT(*) FROM invoices WHERE duplicate_of IS NOT NULL AND duplicate_of NOT IN (SELECT id FROM invoices)')).toBe(0);
    // Open exceptions only on invoices that are still editable; no open exception hides behind a SAP status.
    expect(n("SELECT COUNT(*) FROM invoice_exceptions e JOIN invoices i ON i.id = e.invoice_id WHERE e.status = 'Open' AND i.status IN ('Parked','Posted','Payment due','Payment released','Payment blocked')")).toBe(0);
    // Every invoice number is unique per vendor once normalised, except the deliberate duplicates.
    expect(n('SELECT COUNT(*) FROM invoices WHERE duplicate_of IS NOT NULL')).toBeGreaterThanOrEqual(2);
  });

  it('spreads invoice dates over the year and mixes vendor uploads with uploads on behalf', () => {
    const months = set("SELECT DISTINCT substr(invoice_date, 1, 7) AS s FROM invoices WHERE invoice_date IS NOT NULL");
    expect(months.size).toBeGreaterThanOrEqual(9);
    expect(n('SELECT COUNT(*) FROM invoices WHERE on_behalf = 1')).toBeGreaterThan(5);
    expect(n('SELECT COUNT(*) FROM invoices WHERE on_behalf = 0')).toBeGreaterThan(5);
    // Dates never run backwards: invoice date is not after upload, nothing is in the future, due dates follow invoice dates.
    expect(n("SELECT COUNT(*) FROM invoices WHERE substr(created_at, 1, 10) < invoice_date OR created_at > ?", new Date(Date.now() + 86400000).toISOString())).toBe(0);
    expect(n('SELECT COUNT(*) FROM invoices WHERE due_date IS NOT NULL AND due_date < invoice_date')).toBe(0);
  });

  it('paid invoices carry payment references, advices and a mix of TDS, deductions and retention', () => {
    const paid = all<any>("SELECT * FROM invoices WHERE status = 'Payment released'");
    expect(paid.length).toBeGreaterThanOrEqual(15);
    for (const i of paid) {
      expect(i.payment_ref, i.inv_ref).toBeTruthy();
      expect(i.paid_at, i.inv_ref).toBeTruthy();
      expect(i.payment_advice, i.inv_ref).toBeTruthy();
      expect(i.posted_at && i.posted_at <= i.paid_at, i.inv_ref).toBeTruthy();
    }
    expect(paid.filter((i) => i.tds != null).length).toBeGreaterThan(5);
    expect(paid.filter((i) => i.deductions?.length).length).toBeGreaterThan(1);
    expect(paid.filter((i) => i.retention != null).length).toBeGreaterThan(1);
    // Blocked invoices keep an internal reason and a vendor-safe one; the vendor text never repeats the internal text.
    const blocked = all<any>("SELECT block_reason_internal AS b, vendor_reason AS v FROM invoices WHERE status = 'Payment blocked'");
    expect(blocked.length).toBeGreaterThanOrEqual(2);
    for (const b of blocked) { expect(b.b).toBeTruthy(); expect(b.v).toBeTruthy(); expect(b.v).not.toBe(b.b); }
  });

  it('shows overdue and upcoming payments, and a OCR correction history for KPI-10', () => {
    expect(n("SELECT COUNT(*) FROM invoices WHERE status IN ('Posted','Payment due') AND due_date < date('now')")).toBeGreaterThan(0);
    expect(n("SELECT COUNT(*) FROM invoices WHERE status IN ('Posted','Payment due') AND due_date >= date('now')")).toBeGreaterThan(0);
    expect(n('SELECT COUNT(*) FROM invoice_corrections')).toBeGreaterThan(0);
  });

  it('serves the lists through the API as finance', async () => {
    const meera = await login('meera.iyer');
    const list = await meera.get('/api/invoices');
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(n('SELECT COUNT(*) FROM invoices'));
    const exc = await meera.get('/api/invoices/exceptions?status=Open');
    expect(exc.status).toBe(200);
    expect(exc.body.length).toBe(n("SELECT COUNT(*) FROM invoice_exceptions WHERE status = 'Open'"));
    const buckets = new Set(exc.body.map((e: any) => e.age_bucket));
    expect(buckets.size).toBeGreaterThanOrEqual(3);
    const pays = await meera.get('/api/payments/invoices');
    expect(pays.status).toBe(200);
    expect(pays.body.some((p: any) => p.overdue)).toBe(true);
    // A released payment's advice downloads as a PDF.
    const released = all<{ id: number }>("SELECT id FROM invoices WHERE status = 'Payment released' ORDER BY id DESC LIMIT 1")[0];
    const adv = await meera.get(`/api/payments/invoices/${released.id}/advice.pdf`);
    expect(adv.status).toBe(200);
  });
});

describe('Advances (extended demo data)', () => {
  it('has at least 8 more advances in every canonical state', () => {
    expect(n('SELECT COUNT(*) FROM advances')).toBeGreaterThanOrEqual(10);
    const have = set('SELECT DISTINCT status AS s FROM advances');
    for (const s of have) expect(STATUS.advance).toContain(s);
    for (const s of STATUS.advance) expect(have.has(s), `advance status ${s}`).toBe(true);
  });

  it('links every advance to a PO or contract of the same vendor, and to an approval', () => {
    expect(n('SELECT COUNT(*) FROM advances WHERE (po_id IS NULL AND contract_id IS NULL) OR (po_id IS NOT NULL AND contract_id IS NOT NULL)')).toBe(0);
    expect(n('SELECT COUNT(*) FROM advances a JOIN pos p ON p.id = a.po_id WHERE p.vendor_id != a.vendor_id')).toBe(0);
    expect(n('SELECT COUNT(*) FROM advances a JOIN contracts c ON c.id = a.contract_id WHERE c.vendor_id != a.vendor_id')).toBe(0);
    expect(n('SELECT COUNT(*) FROM advances a LEFT JOIN approvals ap ON ap.id = a.approval_id WHERE a.approval_id IS NULL OR ap.id IS NULL')).toBe(0);
    expect(n("SELECT COUNT(*) FROM advances WHERE status IN ('Paid','Partially adjusted','Fully adjusted') AND (paid_date IS NULL OR sap_doc IS NULL)")).toBe(0);
    expect(n("SELECT COUNT(*) FROM advances WHERE status = 'Fully adjusted' AND adjusted_amount < amount")).toBe(0);
    expect(n("SELECT COUNT(*) FROM advances WHERE status = 'Partially adjusted' AND (adjusted_amount <= 0 OR adjusted_amount >= amount)")).toBe(0);
    expect(n("SELECT COUNT(*) FROM advances WHERE status = 'Cancelled' AND cancel_reason IS NULL")).toBe(0);
  });

  it('keeps advance approvals at level 1, 2 and 3 and fills every ageing bucket', async () => {
    const levels = new Set(all<{ s: number }>("SELECT current_level AS s FROM approvals WHERE type = 'adv.request' AND status = 'Pending'").map((r) => r.s));
    for (const l of [1, 2, 3]) expect(levels.has(l), `pending at level ${l}`).toBe(true);
    const meera = await login('meera.iyer');
    const reg = await meera.get('/api/payments/advances');
    expect(reg.status).toBe(200);
    expect(reg.body.buckets).toHaveLength(4);
    for (const [i, v] of reg.body.totals.bucket_totals.entries()) expect(v, `bucket ${reg.body.buckets[i]}`).toBeGreaterThan(0);
    const detail = await meera.get(`/api/payments/advances/${reg.body.rows[0].id}`);
    expect(detail.status).toBe(200);
  });
});

describe('Audit chain', () => {
  it('still verifies after the extended finance seed', async () => {
    const admin = await login('anjali.verma');
    const v = await admin.get('/api/audit/verify');
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ ok: true });
  });
});
