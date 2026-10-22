/**
 * Insights layer: delivery-risk scoring, invoice explanations, vendor-reply reading, the ask box, the home and
 * workspace feeds, and the guardrails around the optional AI wording. Single-user mode with the extended demo data.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startApp, type Client } from './helpers.ts';

let t: Awaited<ReturnType<typeof startApp>>;
let admin: Client;
const realFetch = globalThis.fetch;
/** Replace the model endpoint only; the test client's own requests to the local API still go through. */
const stubModel = (impl: (url: string, init: any) => unknown) => {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', (url: any, init: any) => (String(url).includes('anthropic') ? Promise.resolve(spy(String(url), init)) : realFetch(url, init)));
  return spy;
};
beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  t = await startApp({ singleUser: true, demoExtra: true });
  admin = await t.login('anyone');
});
afterAll(async () => { await t.close(); });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; t.db.run("DELETE FROM config WHERE key = 'ai.model_wording'"); });

describe('AI status', () => {
  it('is rules-only by default and says so', async () => {
    const r = await admin.get('/api/insights/status');
    expect(r.status).toBe(200);
    expect(r.body.ai).toMatchObject({ mode: 'rules', keyPresent: false, enabled: false, active: false });
    expect(r.body.ai.note).toMatch(/No AI model is connected/);
  });
});

describe('Home feed: act now, at risk, KPIs', () => {
  it('returns prioritised work with a next-step hint, risks with reasons, and KPI cards without invented targets', async () => {
    const r = await admin.get('/api/insights/overview');
    expect(r.status).toBe(200);
    expect(r.body.act.length).toBeGreaterThan(3);
    expect(r.body.act.every((a: any) => typeof a.link === 'string' && 'hint' in a)).toBe(true);
    expect(r.body.act.some((a: any) => a.hint)).toBe(true);
    expect(r.body.atRisk.length).toBeGreaterThan(0);
    for (const x of r.body.atRisk) { expect(x.why.length).toBeGreaterThan(0); expect(['High', 'Medium']).toContain(x.severity); }
    expect(r.body.kpis.map((k: any) => k.id)).toEqual(['KPI-02', 'KPI-07', 'KPI-08', 'KPI-11']);
    expect(r.body.ai.mode).toBe('rules');
  });

  it('serves the three workspaces and rejects an unknown one', async () => {
    for (const k of ['sourcing', 'delivery', 'finance']) {
      const r = await admin.get(`/api/insights/workspace/${k}`);
      expect(r.status, k).toBe(200);
      expect(r.body.stages).toHaveLength(5);
      expect(r.body.stages.every((s: any) => typeof s.count === 'number' && s.link.startsWith('/'))).toBe(true);
      expect(r.body.kpis.length).toBeGreaterThan(0);
    }
    expect((await admin.get('/api/insights/workspace/nonsense')).status).toBe(404);
  });
});

describe('PO delivery risk', () => {
  it('scores each line as the sum of named factors, never above 100', async () => {
    const o = await admin.get('/api/insights/overview');
    const po = o.body.atRisk.find((x: any) => x.kind === 'po_delivery');
    expect(po, 'the demo data has at least one PO at risk').toBeTruthy();
    const poId = Number(po.link.split('/').pop());
    const r = await admin.get(`/api/insights/po/${poId}/risk`);
    expect(r.status).toBe(200);
    expect(r.body.lines.length).toBeGreaterThan(0);
    for (const l of r.body.lines) {
      const sum = l.factors.reduce((a: number, f: any) => a + f.points, 0);
      expect(l.score).toBe(Math.min(100, sum));
      expect(l.factors.length).toBeGreaterThan(0);
      expect(['High', 'Medium', 'Low']).toContain(l.band);
    }
  });

  it('sends the reminder in one click, logs the suggestion and the decision, and refuses a stale click', async () => {
    const lines = (await admin.get('/api/insights/overview')).body.atRisk.filter((x: any) => x.kind === 'po_delivery' && x.action);
    expect(lines.length).toBeGreaterThan(0);
    const item = lines[0];
    const before = t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM po_followups WHERE po_id = ? AND kind = 'Reminder'", item.action.po_id)!.n;
    const sent = await admin.post(`/api/insights/po/${item.action.po_id}/remind`, { line_id: item.action.line_id });
    expect(sent.status).toBe(200);
    expect(sent.body.lines).toBeGreaterThan(0);
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM po_followups WHERE po_id = ? AND kind = 'Reminder'", item.action.po_id)!.n).toBe(before + 1);
    const log = t.db.get<{ decision: string; kind: string; score: number }>("SELECT decision, kind, score FROM ai_suggestions WHERE object_id = ? ORDER BY id DESC", item.action.po_id)!;
    expect(log).toMatchObject({ decision: 'Accepted', kind: 'po_reminder' });
    expect(log.score).toBeGreaterThan(0);
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'ai.suggestion_accepted'")!.n).toBeGreaterThan(0);
    // The risk list moves on: the same reminder is not offered again the same day.
    const again = await admin.get(`/api/insights/po/${item.action.po_id}/risk`);
    const line = again.body.lines.find((l: any) => l.line_id === item.action.line_id);
    expect(line.action.type).not.toBe('remind');
    const stale = await admin.post(`/api/insights/po/${item.action.po_id}/remind`, { line_id: item.action.line_id });
    expect(stale.status).toBe(409);
  });

  it('can be dismissed, which hides that PO from the lists for the day', async () => {
    const item = (await admin.get('/api/insights/overview')).body.atRisk.find((x: any) => x.kind === 'po_delivery')!;
    const poId = Number(item.link.split('/').pop());
    expect((await admin.post(`/api/insights/po/${poId}/dismiss`, {})).status).toBe(200);
    const after = (await admin.get('/api/insights/overview')).body.atRisk;
    expect(after.some((x: any) => x.kind === 'po_delivery' && x.link === item.link)).toBe(false);
    expect(t.db.get<{ decision: string }>("SELECT decision FROM ai_suggestions WHERE object_id = ? ORDER BY id DESC", poId)!.decision).toBe('Dismissed');
  });

  it('reads the reminder wording from the same function the reminder uses', async () => {
    const { reminderContent } = await import('../modules/po/service.ts');
    expect(reminderContent('ack', '4500000001', '10', null)).toEqual({ title: 'Please acknowledge PO 4500000001', body: 'Line(s) 10 are waiting for your acceptance and delivery commitment.' });
  });
});

describe('Reading a vendor reply', () => {
  const reasons = ['Raw material shortage', 'Production capacity', 'Transport unavailable', 'Awaiting technical clarification', 'Payment / advance pending', 'Import / OEM lead time', 'Quality rework', 'Other'];
  it('finds explicit dates and a reason, and refuses to guess from vague words', async () => {
    const { readReply } = await import('../modules/insights/reply.ts');
    const today = '2026-10-20'; // a Tuesday
    const a = readReply('We will dispatch by 25 Oct 2026. Truck not available this week.', today, reasons);
    expect(a.suggested_date).toBe('2026-10-25');
    expect(a.suggested_reason).toBe('Transport unavailable');
    expect(readReply('Material will leave on 5/11/2026', today, reasons).suggested_date).toBe('2026-11-05');
    expect(readReply('Will ship by Friday', today, reasons).suggested_date).toBe('2026-10-23');
    expect(readReply('Dispatch in 3 days', today, reasons).suggested_date).toBe('2026-10-23');
    expect(readReply('Will dispatch tomorrow', today, reasons).suggested_date).toBe('2026-10-21');
    expect(readReply('15 November', today, reasons).suggested_date).toBe('2026-11-15');
    const none = readReply('We will send it very soon, please bear with us.', today, reasons);
    expect(none.suggested_date).toBeNull();
    expect(none.note).toMatch(/No delivery date/);
    // Words that merely start like months are not dates.
    expect(readReply('We shipped 5 marked boxes and 2 decimal scales', today, reasons).suggested_date).toBeNull();
    const past = readReply('Delivered on 2026-10-01', today, reasons);
    expect(past.suggested_date).toBeNull();
    expect(past.dates).toHaveLength(1);
    expect(readReply('Dispatched today, LR No. MH12345678', today, reasons).signals).toMatchObject({ dispatched: true, refs: ['MH12345678'] });
  });

  it('records the commitment only after the buyer confirms the date and reason, and logs whether the suggestion was edited', async () => {
    const line = t.db.get<{ id: number; po_id: number }>(
      `SELECT l.id, l.po_id FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE p.status = 'Published' AND l.status NOT IN ('Received','Closed','Cancelled') AND l.ack_status IN ('Accepted','Partially accepted') ORDER BY l.id LIMIT 1`)!;
    const text = 'Sir, tanker is not available; we will dispatch on 30 Nov 2026.';
    const read = await admin.post(`/api/insights/po-lines/${line.id}/read-reply`, { text });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ suggested_date: '2026-11-30', suggested_reason: 'Transport unavailable' });
    // Nothing changed yet.
    const before = t.db.get<{ commit_date: string | null }>('SELECT commit_date FROM po_lines WHERE id = ?', line.id)!.commit_date;
    expect(before).not.toBe('2026-11-30');
    const bad = await admin.post(`/api/insights/po-lines/${line.id}/apply-reply`, { text, commit_date: '2026-11-30' });
    expect(bad.status).toBe(400);
    const ok = await admin.post(`/api/insights/po-lines/${line.id}/apply-reply`, { text, commit_date: '2026-12-02', delay_reason: 'Transport unavailable' });
    expect(ok.status).toBe(200);
    expect(t.db.get<{ commit_date: string }>('SELECT commit_date FROM po_lines WHERE id = ?', line.id)!.commit_date).toBe('2026-12-02');
    const fu = t.db.get<{ kind: string; note: string }>('SELECT kind, note FROM po_followups WHERE po_line_id = ? ORDER BY id DESC', line.id)!;
    expect(fu.kind).toBe('Vendor update');
    expect(fu.note).toMatch(/tanker is not available/);
    expect(t.db.get<{ decision: string }>("SELECT decision FROM ai_suggestions WHERE kind = 'vendor_reply' ORDER BY id DESC")!.decision).toBe('Edited');
  });
});

describe('Invoice explanation', () => {
  it('turns each open finding into what it means, who owns it and what to do, and recommends a first step', async () => {
    const exc = t.db.all<{ invoice_id: number }>("SELECT DISTINCT invoice_id FROM invoice_exceptions WHERE status = 'Open'");
    expect(exc.length).toBeGreaterThan(3);
    const reasons = new Set<string>();
    for (const { invoice_id } of exc) {
      const r = await admin.get(`/api/insights/invoices/${invoice_id}/explain`);
      expect(r.status).toBe(200);
      const open = t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM invoice_exceptions WHERE invoice_id = ? AND status = 'Open'", invoice_id)!.n;
      expect(r.body.items).toHaveLength(open);
      expect(r.body.source).toBe('rules');
      expect(r.body.recommended?.step).toBeTruthy();
      for (const i of r.body.items) {
        expect(i.what.length).toBeGreaterThan(10);
        expect(i.steps.length).toBeGreaterThan(0);
        expect(i.vendor_message.length).toBeGreaterThan(0);
        reasons.add(i.rule);
      }
    }
    expect(reasons.size).toBeGreaterThan(2);
  });

  it('says nothing is for you to do when the invoice only waits for a receipt', async () => {
    const row = t.db.all<{ invoice_id: number; reasons: string }>("SELECT invoice_id, GROUP_CONCAT(reason, '|') reasons FROM invoice_exceptions WHERE status = 'Open' GROUP BY invoice_id").find((r) => r.reasons.split('|').every((x) => x.startsWith('Pending')));
    if (!row) return; // demo data dependent
    const r = await admin.get(`/api/insights/invoices/${row.invoice_id}/explain`);
    expect(r.body.recommended.next).toBe('wait');
    expect(r.body.headline).toMatch(/Nothing for you to do/);
  });

  it('returns 404 for an invoice that does not exist', async () => {
    expect((await admin.get('/api/insights/invoices/999999/explain')).status).toBe(404);
  });
});

describe('Ask the data', () => {
  it('answers from rules, says how it understood the question, and links to records', async () => {
    const r = await admin.get('/api/insights/ask?q=' + encodeURIComponent('Which POs are late?'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ intent: 'late', source: 'rules' });
    expect(r.body.understood).toMatch(/past their committed delivery date/);
    expect(r.body.total).toBeGreaterThan(0);
    expect(r.body.rows.every((x: any) => x.link.startsWith('/pos/'))).toBe(true);
  });

  it('applies a vendor filter taken from the question', async () => {
    const v = t.db.get<{ id: number; name: string }>(
      `SELECT v.id, v.name FROM vendors v JOIN pos p ON p.vendor_id = v.id JOIN po_lines l ON l.po_id = p.id WHERE p.status IN ('Published','Partially received') AND l.status NOT IN ('Received','Closed','Cancelled')
         AND l.ack_status NOT IN ('Rejected','Pending','Pending re-acknowledgement') AND COALESCE(l.commit_date, l.delivery_date) < date('now') LIMIT 1`);
    if (!v) return;
    const token = v.name.toLowerCase().split(/\W+/).find((w) => w.length >= 4 && !['pvt', 'ltd', 'limited', 'private', 'industries', 'enterprises', 'engineering', 'works', 'sales', 'services'].includes(w))!;
    const all = (await admin.get('/api/insights/ask?q=late%20deliveries')).body;
    const one = (await admin.get('/api/insights/ask?q=' + encodeURIComponent(`late deliveries from ${token}`))).body;
    expect(one.understood).toMatch(/vendor/);
    expect(one.total).toBeGreaterThan(0);
    expect(one.total).toBeLessThanOrEqual(all.total);
  });

  it('covers the other questions in the examples and admits what it does not understand', async () => {
    for (const [q, intent] of [['Which invoices are on hold and why?', 'invoice_hold'], ['Payments due this week', 'payments'], ['What is waiting for my approval?', 'approvals'], ['POs not acknowledged', 'ack'], ['Which RFQs have low response?', 'rfq'], ['Contracts expiring soon', 'contracts'], ['Unassigned PR lines', 'pr'], ['Open disputes', 'disputes'], ['Which POs are likely to be late?', 'risk']] as const) {
      const r = await admin.get('/api/insights/ask?q=' + encodeURIComponent(q));
      expect(r.status, q).toBe(200);
      expect(r.body.intent, q).toBe(intent);
    }
    const none = await admin.get('/api/insights/ask?q=' + encodeURIComponent('what is the meaning of life'));
    expect(none.body).toMatchObject({ intent: null, total: 0 });
    expect(none.body.examples.length).toBeGreaterThan(3);
    expect((await admin.get('/api/insights/ask?q=a')).status).toBe(409);
  });
});

describe('Optional AI wording: guarded and never trusted blindly', () => {
  const enable = () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    t.db.run("INSERT OR REPLACE INTO config (key, value_json) VALUES ('ai.model_wording', 'true')");
  };
  const invoice = () => t.db.get<{ invoice_id: number }>("SELECT invoice_id FROM invoice_exceptions WHERE status = 'Open' AND rule != 'DUP' LIMIT 1")!.invoice_id;
  const reply = (text: string, ok = true) => () => ({ ok, json: async () => ({ content: [{ type: 'text', text }] }) });

  it('is inactive with a key but the rule off, and with the rule on but no key', async () => {
    process.env.ANTHROPIC_API_KEY = 'x';
    expect((await admin.get('/api/insights/status')).body.ai).toMatchObject({ keyPresent: true, enabled: false, active: false });
    delete process.env.ANTHROPIC_API_KEY;
    t.db.run("INSERT OR REPLACE INTO config (key, value_json) VALUES ('ai.model_wording', 'true')");
    expect((await admin.get('/api/insights/status')).body.ai).toMatchObject({ keyPresent: false, enabled: true, active: false });
  });

  it('falls back to rules text when the model invents a number, errors, or times out', async () => {
    enable();
    const id = invoice();
    stubModel(reply('The invoice is held for 987654 days. Please escalate.'));
    const invented = (await admin.get(`/api/insights/invoices/${id}/explain`)).body;
    expect(invented.source).toBe('rules');
    expect(invented.summary).not.toMatch(/987654/);
    stubModel(reply('boom', false));
    expect((await admin.get(`/api/insights/invoices/${id}/explain`)).body.source).toBe('rules');
    stubModel(() => Promise.reject(new Error('network down')));
    expect((await admin.get(`/api/insights/invoices/${id}/explain`)).body.source).toBe('rules');
  });

  it('never sends the document or free-text fields, only the computed facts', async () => {
    enable();
    const id = invoice();
    const f = stubModel(() => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'Held until it is resolved.' }] }) }));
    const r = (await admin.get(`/api/insights/invoices/${id}/explain`)).body;
    expect(r.source).toBe('model');
    expect(r.summary).toBe('Held until it is resolved.');
    const sent = f.mock.calls[0][1] as { body: string; headers: Record<string, string> };
    expect(sent.headers['x-api-key']).toBe('test-key');
    const body = JSON.parse(sent.body);
    expect(body.model).toBeTruthy();
    expect(body.messages[0].content).not.toMatch(/bank|gstin|attachment/i);
  });
});
