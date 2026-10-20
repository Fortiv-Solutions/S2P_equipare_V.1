/** Module 7 — PO publication, acknowledgement, open-PO follow-up and amendments (PRD 7.7). */
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { ModuleDef } from '../types.ts';
import { all, get, run, update, addHours } from '../../core/db.ts';
import { h, parse, idParam, reasonSchema, sendCsv, badRequest } from '../../core/http.ts';
import { requirePerm, actorOf, type Actor } from '../../core/auth.ts';
import { audit } from '../../core/audit.ts';
import { onDecision } from '../../core/approvals.ts';
import { onSynced } from '../../core/sap.ts';
import { registerConfig } from '../../core/config.ts';
import { registerObjectAccess } from '../../core/files.ts';
import { registerJob } from '../../core/scheduler.ts';
import { actorFor, D, DAY } from '../../seed/ctx.ts';
import * as S from './service.ts';
import { poPdf } from './pdf.ts';
import { DEMO_EXTRA } from '../../core/mode.ts';
import { seedExtra } from './seed_extra.ts';

const router = Router();

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date (YYYY-MM-DD)');
const ackSchema = z.object({
  lines: z.array(z.object({
    line_id: z.number().int().positive(),
    decision: z.enum(['accept', 'partial', 'reject'], { error: 'Choose accept, partially accept or reject' }),
    accepted_qty: z.number().nullable().optional(),
    commit_date: z.string().nullable().optional(),
    reason: z.string().max(500).nullable().optional(),
    remarks: z.string().max(500).nullable().optional(),
  })).min(1, 'Choose a decision for at least one line'),
  source: z.string().max(300).optional(),
});
const commitSchema = z.object({ commit_date: z.string({ error: 'Enter the new commitment date' }), delay_reason: z.string({ error: 'Choose a delay reason' }), note: z.string().max(500).nullable().optional() });
const amendSchema = z.object({
  type: z.enum(S.AMEND_TYPES, { error: 'Choose the amendment type' }),
  reason: z.string().max(500),
  lines: z.array(z.object({ line_id: z.number().int().positive(), qty: z.number().nullable().optional(), unit_price: z.number().nullable().optional(), delivery_date: z.string().nullable().optional() })).optional(),
  terms: z.object({ payment_terms: z.string().max(200).nullable().optional(), delivery_terms: z.string().max(200).nullable().optional() }).optional(),
});

async function sendPdf(req: Request, res: import('express').Response, id: number) {
  const a = actorOf(req);
  const d = S.poDetail(a, id);
  if (d.view === 'requisitioner') throw badRequest('The PO document contains prices and is not available to requisitioners.');
  const buf = await poPdf(d);
  audit(a, { action: 'po.document_downloaded', objectType: 'po', objectId: id, objectRef: `${d.po_no} v${d.version}` });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="PO-${d.po_no}-v${d.version}.pdf"`);
  res.send(buf);
}

// ------------------------------------------------------------------ internal (buyers, managers, stores, finance, requisitioners)
router.get('/lines', requirePerm('po.view', 'po.view_own_pr'), h((req, res) => {
  const rows = S.listLines(actorOf(req), req.query as Record<string, string>);
  if (req.query.format === 'csv') {
    return sendCsv(res, 'open-po-lines.csv', rows.map((r) => ({ ...r, overdue: r.overdue ? 'Yes' : 'No' })) as unknown as Record<string, unknown>[], [
      { key: 'ref', label: 'PO / item' }, { key: 'po_date', label: 'PO date' }, { key: 'rfq_date', label: 'RFQ date' }, { key: 'vendor_name', label: 'Vendor' },
      { key: 'buyer_name', label: 'Buyer' }, { key: 'plant', label: 'Plant' }, { key: 'material_code', label: 'Material' }, { key: 'material_group', label: 'Material group' },
      { key: 'description', label: 'Description' }, { key: 'urgency', label: 'Urgency' }, { key: 'qty', label: 'Ordered' }, { key: 'open_qty', label: 'Open qty' }, { key: 'uom', label: 'UoM' },
      { key: 'delivery_date', label: 'PO delivery date' }, { key: 'ack_status', label: 'Acknowledgement' }, { key: 'first_commit_date', label: 'First commitment' },
      { key: 'commit_date', label: 'Latest commitment' }, { key: 'delay_reason', label: 'Delay reason' }, { key: 'overdue', label: 'Overdue' }, { key: 'overdue_days', label: 'Days overdue' },
      { key: 'next_action', label: 'Next action' }, { key: 'next_action_date', label: 'Next action date' }, { key: 'reminders', label: 'Reminders' }, { key: 'escalation_level', label: 'Escalation level' },
    ]);
  }
  return rows;
}));
router.get('/summary', requirePerm('po.view'), h((req) => S.summary(actorOf(req))));
router.get('/reports/open', requirePerm('po.view'), h((req) => S.openPoReport(actorOf(req), req.query as Record<string, string>)));
router.get('/reports/followup', requirePerm('po.view'), h((req) => S.followupReport(actorOf(req), req.query as Record<string, string>)));
router.get('/reports/non-response', requirePerm('po.view'), h((req) => S.nonResponseReport(actorOf(req))));
router.get('/pos/:id', requirePerm('po.view', 'po.view_own_pr'), h((req) => S.poDetail(actorOf(req), idParam(req))));
router.get('/pos/:id/pdf', requirePerm('po.view'), h((req, res) => sendPdf(req, res, idParam(req))));

router.post('/pos/:id/acknowledge', requirePerm('po.followup'), h((req) => {
  const b = parse(ackSchema, req.body);
  return S.acknowledge(actorOf(req), idParam(req), b.lines, { onBehalf: b.source });
}));
router.post('/pos/:id/followups', requirePerm('po.followup'), h((req) => {
  const b = parse(z.object({
    po_line_id: z.number().int().positive().nullable().optional(), kind: z.string(), note: z.string().max(1000),
    commit_date: z.string().nullable().optional(), delay_reason: z.string().nullable().optional(), next_action_date: z.string().nullable().optional(),
  }), req.body);
  return S.logFollowup(actorOf(req), idParam(req), { ...b, commit_date: b.commit_date || null, delay_reason: b.delay_reason || null, next_action_date: b.next_action_date || null });
}));
router.post('/lines/:id/commitment', requirePerm('po.followup'), h((req) => S.updateCommitment(actorOf(req), idParam(req), parse(commitSchema, req.body))));
router.post('/pos/:id/remind', requirePerm('po.followup'), h((req) => {
  const b = parse(z.object({ line_ids: z.array(z.number().int()).optional() }), req.body ?? {});
  return S.remind(actorOf(req), idParam(req), { manual: true, lineIds: b.line_ids?.length ? b.line_ids : undefined });
}));
router.post('/remind', requirePerm('po.followup'), h((req) => {
  const { po_ids } = parse(z.object({ po_ids: z.array(z.number().int().positive()).min(1, 'Select at least one PO').max(200) }), req.body);
  const a = actorOf(req);
  const results = [...new Set(po_ids)].map((id) => {
    try { return { id, ok: true, ...S.remind(a, id, { manual: true }) }; } catch (e) { return { id, ok: false, message: (e as Error).message }; }
  });
  return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}));
router.post('/pos/:id/escalate', requirePerm('po.followup'), h((req) => {
  const { reason } = parse(z.object({ reason: reasonSchema }), req.body);
  return S.escalate(actorOf(req), idParam(req), { reason, manual: true });
}));

router.post('/pos/:id/amendments', requirePerm('po.amend'), h((req) => S.requestAmendment(actorOf(req), idParam(req), parse(amendSchema, req.body))));
router.post('/amendments/:id/forward', requirePerm('po.amend'), h((req) => S.forwardVendorRequest(actorOf(req), idParam(req))));
router.post('/amendments/:id/decline', requirePerm('po.amend'), h((req) => S.declineVendorRequest(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/amendments/:id/withdraw', requirePerm('po.amend'), h((req) => S.withdrawAmendment(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/amendments/:id/confirm', requirePerm('po.amend', 'asn.receive'), h((req) => {
  const b = parse(z.object({ party: z.enum(['stores', 'vendor']), note: z.string().max(500).nullable().optional() }), req.body);
  return S.confirmCancellation(actorOf(req), idParam(req), b.party, b.note);
}));
router.post('/amendments/:id/sap-request', requirePerm('po.amend'), h((req) => S.prepareSapChange(actorOf(req), idParam(req))));

// ------------------------------------------------------------------ vendor portal (SCR-VPT-05)
router.get('/vendor/pos', requirePerm('po.vendor'), h((req) => S.listVendorPos(actorOf(req))));
router.get('/vendor/pos/:id', requirePerm('po.vendor'), h((req) => {
  const a = actorOf(req);
  const id = idParam(req);
  const d = S.poDetail(a, id); // 404 + audited for another vendor's PO (AC-VPT-02)
  if (!d.viewed_at) { S.markViewed(a, id); return S.poDetail(a, id); }
  return d;
}));
router.get('/vendor/pos/:id/pdf', requirePerm('po.vendor'), h((req, res) => sendPdf(req, res, idParam(req))));
router.post('/vendor/pos/:id/acknowledge', requirePerm('po.vendor'), h((req) => S.acknowledge(actorOf(req), idParam(req), parse(ackSchema, req.body).lines)));
router.post('/vendor/lines/:id/commitment', requirePerm('po.vendor'), h((req) => S.updateCommitment(actorOf(req), idParam(req), parse(commitSchema, req.body))));
router.post('/vendor/pos/:id/deviation', requirePerm('po.vendor'), h((req) => S.requestAmendment(actorOf(req), idParam(req), parse(amendSchema, req.body))));
router.post('/vendor/amendments/:id/confirm', requirePerm('po.vendor'), h((req) => S.confirmCancellation(actorOf(req), idParam(req), 'vendor', parse(z.object({ note: z.string().max(500).nullable().optional() }), req.body ?? {}).note)));
router.post('/vendor/amendments/:id/acknowledge', requirePerm('po.vendor'), h((req) => S.acknowledgeCancellation(actorOf(req), idParam(req))));
router.post('/vendor/amendments/:id/withdraw', requirePerm('po.vendor'), h((req) => S.withdrawAmendment(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));

void dateStr;

// ------------------------------------------------------------------ init
function init() {
  S.ensureSchema();
  registerConfig({
    key: 'po.document_reminder', label: 'Pending documents reminder', group: 'Purchase orders',
    description: 'Remind the vendor to upload invoice and dispatch documents when goods are received but no invoice has arrived after N days (FR-POM-07).',
    value: { enabled: true, days_after_grn: 7 }, decision: 'Q 7.7',
  });
  registerObjectAccess('po', (actor, id) => S.canSeePo(actor, id));
  registerObjectAccess('po_amendment', (actor, id) => {
    const amd = get<{ po_id: number }>('SELECT po_id FROM po_amendments WHERE id = ?', id);
    return !!amd && S.canSeePo(actor, amd.po_id);
  });
  onSynced('PO', S.onPoSynced);
  for (const t of ['po.amendment', 'po.cancellation', 'exc.price_amendment']) onDecision(t, S.onAmendmentDecision);
  registerJob({ name: 'po.followup', label: 'PO deemed acceptance, reminders and escalations', everyMinutes: 30, run: S.followupJob });
}

// ------------------------------------------------------------------ seed (platform-owned acknowledgements and follow-ups)
function seed() {
  // Publication history: the seeded SAP POs were published on their PO date.
  for (const po of all<{ id: number; po_date: string }>('SELECT id, po_date FROM pos')) {
    const at = `${po.po_date}T06:30:00.000Z`;
    update('pos', po.id, { published_at: at, ack_due_at: addHours(at, 24) });
    run('UPDATE po_publications SET published_at = ? WHERE po_id = ?', at, po.id);
    run("UPDATE notifications SET created_at = ? WHERE object_type = 'po' AND object_id = ? AND event = 'NTF-16'", at, po.id);
  }
  const step = (name: string, fn: () => void) => {
    try { fn(); } catch (e) { console.warn(`po seed: ${name} skipped — ${(e as Error).message}`); }
  };
  const po = (no: string) => {
    const p = S.getPoByNo(no);
    if (!p) throw new Error(`PO ${no} not synced`);
    return { p, lines: S.linesOf(p.id) };
  };
  const accept = (actor: Actor, no: string, at: string, commit: (item: number) => string, onBehalf?: string) => {
    const { p, lines } = po(no);
    S.acknowledge(actor, p.id, lines.map((l) => ({ line_id: l.id, decision: 'accept' as const, commit_date: commit(l.item) })), { at, onBehalf, allowClosed: true });
  };
  step('4500021001', () => accept(actorFor('manoj.kale'), '4500021001', D(-11), () => DAY(4)));
  step('4500021002', () => {
    const { p, lines } = po('4500021002');
    S.acknowledge(actorFor('divya.raman'), p.id, [
      { line_id: lines[0].id, decision: 'accept', commit_date: DAY(5) },
      { line_id: lines[1].id, decision: 'partial', accepted_qty: 3, commit_date: DAY(9), reason: 'Only 3 rollers in finished stock; the fourth needs a new forging lot (about 6 weeks).' },
    ], { at: D(-8) });
  });
  step('4500021003', () => {
    const { p, lines } = po('4500021003');
    S.acknowledge(actorFor('sanjay'), p.id, [{ line_id: lines[0].id, decision: 'accept', commit_date: DAY(-6) }], { at: D(-19), allowClosed: true });
    S.updateCommitment(actorFor('sanjay'), lines[0].id, { commit_date: DAY(2), delay_reason: 'Transport unavailable', note: 'Tanker for the balance 4 drums not available this week; 6 drums already delivered.' }, { at: D(-5) });
    S.logFollowup(actorFor('sneha.patil'), p.id, { po_line_id: lines[0].id, kind: 'Call', note: 'Spoke to Sanjay: balance 4 drums leave Nagpur depot once the tanker is free. Confirm dispatch and LR number.', next_action_date: DAY(1) }, { at: D(-1, 15) });
  });
  step('4500021004', () => accept(actorFor('imran'), '4500021004', D(-5), () => DAY(1)));
  step('4500021005', () => {
    const { p } = po('4500021005');
    S.remind(null, p.id, { type: 'ack', at: D(-2, 13) });
    S.escalate(null, p.id, { at: new Date(Date.now() - 2 * 3600000).toISOString() });
  });
  step('4500021006', () => accept(actorFor('pooja.malhotra'), '4500021006', D(-14), () => DAY(-3)));
  step('4500021007', () => accept(actorFor('nitin'), '4500021007', D(-24), () => DAY(-12)));
  step('4500021008', () => accept(actorFor('amit.kulkarni'), '4500021008', D(-4), () => DAY(2), 'Acknowledgement received by e-mail from Ajay Mahato (JMSR)'));
  step('4500021009', () => accept(actorFor('sneha.patil'), '4500021009', D(-39), () => DAY(-26), 'Signed PO copy returned by Apex Welding (Hetal Shah) by e-mail'));
  // 4500021010 is left unopened by the vendor.
  step('amendment 4500021002/20', () => {
    const { p, lines } = po('4500021002');
    const l = lines.find((x) => x.item === 20)!;
    S.requestAmendment(actorFor('amit.kulkarni'), p.id, { type: 'Price', reason: 'Shakti revised the roller price after the steel price increase notified on 1 Oct; matches the ARC revision clause.', lines: [{ line_id: l.id, unit_price: 39500 }] });
  });
  if (DEMO_EXTRA) seedExtra();
}

export const module: ModuleDef = { path: 'po', router, init, seed };
