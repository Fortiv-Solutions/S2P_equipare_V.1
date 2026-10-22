/**
 * Insights layer: rule-based assistance on top of SAP-mirrored data and platform workflow data (PO delivery risk,
 * invoice explanations, vendor-reply reading, plain-language questions) and the data behind the new home and the
 * Sourcing / Delivery / Finance workspaces. Read-only except the two actions a person confirms (send a reminder,
 * record a commitment), and both reuse the existing PO functions, so their audit and notification behaviour is unchanged.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ModuleDef } from '../types.ts';
import { get, now } from '../../core/db.ts';
import { h, parse, idParam, forbidden, notFound, conflict } from '../../core/http.ts';
import { requirePerm, actorOf } from '../../core/auth.ts';
import { registerConfig, cfg } from '../../core/config.ts';
import { aiStatus } from '../../core/ai.ts';
import * as PO from '../po/service.ts';
import { poLineRisks } from './risk.ts';
import { explainInvoice } from './explain.ts';
import { readReply } from './reply.ts';
import { ask } from './ask.ts';
import { overview, workspace, WORKSPACES, type WorkspaceKey } from './overview.ts';
import { ensureSchema, logSuggestion, recentSuggestions, suggestionStats } from './log.ts';

const router = Router();
const INTERNAL = ['po.view', 'inv.view', 'apr.view', 'pr.work', 'rpt.view'] as const;

/** The home and workspace views read across every module, so they are for the merged Administrator only. */
const merged = (req: Parameters<typeof actorOf>[0]) => {
  const a = actorOf(req);
  if (!a.merged) throw forbidden('This view is for the Administrator workspace.');
  return a;
};

router.get('/status', requirePerm(...INTERNAL), h(() => ({ ai: aiStatus(), stats: suggestionStats() })));
router.get('/overview', requirePerm(...INTERNAL), h((req) => overview(merged(req))));
router.get('/workspace/:key', requirePerm(...INTERNAL), h((req) => {
  const key = String(req.params.key) as WorkspaceKey;
  if (!WORKSPACES.includes(key)) throw notFound('Workspace');
  return workspace(merged(req), key);
}));
router.get('/log', requirePerm('audit.view'), h(() => ({ items: recentSuggestions(100), stats: suggestionStats(), ai: aiStatus() })));

router.get('/ask', requirePerm(...INTERNAL), h((req) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) throw conflict('Type a question of at least two characters.');
  return ask(actorOf(req), q);
}));

// ------------------------------------------------------------------ PO delivery risk
router.get('/po/:id/risk', requirePerm('po.view'), h((req) => {
  const a = actorOf(req);
  const id = idParam(req);
  if (!PO.canSeePo(a, id)) throw notFound('Purchase order');
  return { lines: poLineRisks({ poId: id }), thresholds: cfg('insights.risk_bands'), ai: aiStatus() };
}));

/** One click: send the reminder the risk card proposes. Uses the same function as the "Remind vendor" button. */
router.post('/po/:id/remind', requirePerm('po.followup'), h((req) => {
  const a = actorOf(req);
  const id = idParam(req);
  const b = parse(z.object({ line_id: z.number().int().positive() }), req.body);
  if (!PO.canSeePo(a, id)) throw notFound('Purchase order');
  const risk = poLineRisks({ poId: id }).find((r) => r.line_id === b.line_id);
  if (!risk || risk.action.type !== 'remind' || !risk.action.reminder) throw conflict('This line no longer needs a reminder. Reload to see its current state.');
  const sent = PO.remind(a, id, { manual: true, type: risk.action.reminder, lineIds: [b.line_id] });
  logSuggestion(a, { kind: 'po_reminder', objectType: 'po', objectId: id, objectRef: `${risk.po_no}/${risk.item}`, summary: `${risk.action.label}: ${risk.factors.map((f) => f.label).join('; ')}`, score: risk.score, decision: 'Accepted', outcome: `${sent.type} reminder sent for ${sent.lines} line(s)` });
  return sent;
}));

router.post('/po/:id/dismiss', requirePerm('po.followup'), h((req) => {
  const a = actorOf(req);
  const id = idParam(req);
  const b = parse(z.object({ line_id: z.number().int().positive().optional() }), req.body ?? {});
  if (!PO.canSeePo(a, id)) throw notFound('Purchase order');
  const risks = poLineRisks({ poId: id });
  const risk = risks.find((r) => r.line_id === b.line_id) ?? risks[0];
  if (!risk) throw conflict('Nothing at risk on this PO.');
  logSuggestion(a, { kind: 'po_reminder', objectType: 'po', objectId: id, objectRef: risk.po_no, summary: `Dismissed: ${risk.factors.map((f) => f.label).join('; ')}`, score: risk.score, decision: 'Dismissed', outcome: 'Hidden for 24 hours' });
  return { ok: true };
}));

// ------------------------------------------------------------------ vendor replies
const lineOf = (a: ReturnType<typeof actorOf>, lineId: number) => {
  const l = get<PO.PoLine>('SELECT * FROM po_lines WHERE id = ?', lineId);
  if (!l || !PO.canSeePo(a, l.po_id)) throw notFound('PO line');
  return l;
};
const replySchema = z.object({ text: z.string({ error: 'Paste the vendor’s reply' }).trim().min(5, 'Paste the vendor’s reply').max(2000, 'Keep the pasted reply under 2000 characters') });

router.post('/po-lines/:id/read-reply', requirePerm('po.followup'), h((req) => {
  const a = actorOf(req);
  const l = lineOf(a, idParam(req));
  const { text } = parse(replySchema, req.body);
  return { line_id: l.id, reasons: cfg<string[]>('po.delay_reasons'), ...readReply(text, now().slice(0, 10), cfg<string[]>('po.delay_reasons')) };
}));

router.post('/po-lines/:id/apply-reply', requirePerm('po.followup'), h((req) => {
  const a = actorOf(req);
  const l = lineOf(a, idParam(req));
  const b = parse(replySchema.extend({
    commit_date: z.string({ error: 'Enter the commitment date' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date (YYYY-MM-DD)'),
    delay_reason: z.string({ error: 'Choose a delay reason' }).min(1, 'Choose a delay reason'),
  }), req.body);
  const po = PO.getPo(l.po_id)!;
  const suggested = readReply(b.text, now().slice(0, 10), cfg<string[]>('po.delay_reasons')).suggested_date;
  const excerpt = b.text.length > 280 ? `${b.text.slice(0, 277)}…` : b.text;
  const out = PO.logFollowup(a, l.po_id, {
    po_line_id: l.id, kind: 'Vendor update', commit_date: b.commit_date, delay_reason: b.delay_reason,
    note: `Vendor reply recorded from pasted text: “${excerpt}”`,
  });
  logSuggestion(a, { kind: 'vendor_reply', objectType: 'po', objectId: l.po_id, objectRef: `${po.po_no}/${l.item}`, summary: `Date read from the vendor’s reply: ${suggested ?? 'none found'}`, decision: suggested === b.commit_date ? 'Accepted' : 'Edited', outcome: `Commitment set to ${b.commit_date} (${b.delay_reason})` });
  return out;
}));

// ------------------------------------------------------------------ invoice explanation
router.get('/invoices/:id/explain', requirePerm('inv.view'), h((req) => explainInvoice(actorOf(req), idParam(req))));

function init() {
  ensureSchema();
  registerConfig(
    { key: 'ai.model_wording', label: 'AI-worded summaries', group: 'AI assistance', description: 'When on and ANTHROPIC_API_KEY is set on the server, an AI model words the one-paragraph summaries from facts the rules computed. It never changes a record, a match result or a score. Off: plain rules text only and nothing leaves this server.', value: false, decision: 'Q AI-1' },
    { key: 'insights.risk_bands', label: 'Delivery-risk score bands', group: 'AI assistance', description: 'Score at which a PO line shows as medium or high delivery risk. The score is the sum of the named factors shown on each card; these are proposed defaults.', value: { high: 60, medium: 35 }, decision: 'Q AI-2' },
  );
}

export const module: ModuleDef = { path: 'insights', router, init };
