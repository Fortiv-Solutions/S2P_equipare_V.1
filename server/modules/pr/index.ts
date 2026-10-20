import { Router } from 'express';
import { z } from 'zod';
import type { ModuleDef } from '../types.ts';
import { all, get } from '../../core/db.ts';
import { h, parse, idParam, reasonSchema, sendCsv, badRequest } from '../../core/http.ts';
import { requirePerm, actorOf, requireAuth, can } from '../../core/auth.ts';
import { onDecision } from '../../core/approvals.ts';
import { onSynced } from '../../core/sap.ts';
import { registerObjectAccess } from '../../core/files.ts';
import { registerJob } from '../../core/scheduler.ts';
import { DEMO_EXTRA } from '../../core/mode.ts';
import * as S from './service.ts';
import { seedExtra } from './seed_extra.ts';

const router = Router();

router.get('/lines', requirePerm('pr.view', 'pr.view_own'), h((req, res) => {
  const rows = S.listLines(actorOf(req), req.query as Record<string, string>);
  if (req.query.format === 'csv') {
    return sendCsv(res, 'pr-lines.csv', rows as unknown as Record<string, unknown>[], [
      { key: 'ref', label: 'PR / item' }, { key: 'material_code', label: 'Material' }, { key: 'description', label: 'Description' },
      { key: 'qty', label: 'Qty' }, { key: 'uom', label: 'UoM' }, { key: 'plant', label: 'Plant' }, { key: 'priority', label: 'Priority' },
      { key: 'status', label: 'Status' }, { key: 'route', label: 'Route' }, { key: 'route_proposed', label: 'Proposed route' },
      { key: 'buyer_name', label: 'Buyer' }, { key: 'requisitioner_name', label: 'Requisitioner' }, { key: 'required_date', label: 'Required date' },
      { key: 'age_days', label: 'Age (days)' }, { key: 'rfq_no', label: 'RFQ' }, { key: 'po_no', label: 'PO' },
    ]);
  }
  return rows;
}));

router.get('/summary', requirePerm('pr.view'), h((req) => S.summary(actorOf(req))));
router.get('/ageing', requirePerm('pr.view', 'pr.view_own'), h((req) => S.ageing(actorOf(req), String(req.query.by ?? 'buyer'))));
router.get('/mine', requirePerm('pr.view_own'), h((req) => S.myRequirements(actorOf(req))));
router.get('/buyers', requirePerm('pr.view'), h(() =>
  all<{ id: number; name: string; categories: string | null }>("SELECT id, name, categories FROM users WHERE active = 1 AND (',' || roles || ',') LIKE '%,BUY,%' ORDER BY name"),
));
router.get('/lines/:id', requirePerm('pr.view', 'pr.view_own'), h((req) => S.lineDetail(actorOf(req), idParam(req))));

router.post('/lines/:id/assign', requirePerm('pr.assign'), h((req) => {
  const b = parse(z.object({ buyer_id: z.number().int().positive('Choose a buyer'), reason: z.string().optional() }), req.body);
  return S.reassign(actorOf(req), idParam(req), b.buyer_id, b.reason);
}));
router.post('/lines/:id/checks', requirePerm('pr.work'), h((req) => S.runChecks(actorOf(req), idParam(req))));
router.post('/lines/:id/route', requirePerm('pr.work'), h((req) => {
  const b = parse(z.object({ route: z.enum(S.ROUTES), reason: z.string().optional(), acknowledge_stale: z.boolean().optional() }), req.body);
  return S.decideRoute(actorOf(req), idParam(req), { route: b.route, reason: b.reason, acknowledgeStale: b.acknowledge_stale });
}));
router.get('/lines/:id/po-reference', requirePerm('pr.work', 'pr.view'), h((req) => S.poReference(idParam(req))));
router.post('/lines/:id/hold', requirePerm('pr.work'), h((req) => S.hold(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/lines/:id/release', requirePerm('pr.work'), h((req) => S.release(actorOf(req), idParam(req))));
router.post('/lines/:id/close', requirePerm('pr.work'), h((req) => S.closeLine(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/lines/:id/clarify', requirePerm('pr.clarify'), h((req) => {
  const a = actorOf(req);
  const id = idParam(req);
  const l = S.getLine(id);
  if (!l || (!can(a, 'pr.view') && l.requisitioner_id !== a.id)) throw badRequest('PR line not found.');
  return S.clarify(a, id, parse(z.object({ body: z.string().trim().min(3, 'Write your question or answer').max(2000) }), req.body).body);
}));

router.post('/basket-check', requirePerm('pr.work'), h((req) => {
  const { ids } = parse(z.object({ ids: z.array(z.number().int().positive()).min(1, 'Select at least one line') }), req.body);
  const r = S.basketCheck(ids, actorOf(req).id);
  return { ok: r.ok, problems: r.problems, count: r.lines.length };
}));

router.post('/bulk', requirePerm('pr.work', 'pr.assign'), h((req) => {
  const a = actorOf(req);
  const b = parse(z.object({ action: z.enum(['checks', 'assign']), ids: z.array(z.number().int().positive()).min(1).max(200), buyer_id: z.number().int().optional(), reason: z.string().optional() }), req.body);
  const results: { id: number; ok: boolean; message?: string }[] = [];
  for (const id of b.ids) {
    try {
      if (b.action === 'checks') {
        if (!a.perms.has('pr.work')) throw badRequest('Your role cannot run checks.');
        S.runChecks(a, id);
      } else {
        if (!a.perms.has('pr.assign')) throw badRequest('Your role cannot assign lines.');
        if (!b.buyer_id) throw badRequest('Choose a buyer.');
        S.reassign(a, id, b.buyer_id, b.reason);
      }
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, message: (e as Error).message });
    }
  }
  return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}));

router.get('/matrix', requireAuth, h(() =>
  all('SELECT m.*, b.name AS buyer_name, bb.name AS backup_name FROM buyer_matrix m LEFT JOIN users b ON b.id = m.buyer_id LEFT JOIN users bb ON bb.id = m.backup_buyer_id ORDER BY category, plant'),
));

function init() {
  registerObjectAccess('pr_line', (actor, id) => {
    if (actor.perms.has('pr.view')) return true;
    const l = get<{ requisitioner_id: number }>('SELECT requisitioner_id FROM pr_lines WHERE id = ?', id);
    return !!l && l.requisitioner_id === actor.id;
  });
  // New PR lines from SAP: assign a buyer and flag repeat purchases (FR-PRW-03, PR-08).
  onSynced('PR', (rows) => {
    for (const r of rows) {
      if (r.isNew) {
        S.autoAssign(r.id);
        S.computeRepeat(r.id);
      }
    }
  });
  // PO history changes repeat-purchase counts for open lines of the same material.
  onSynced('PO', () => {
    for (const l of all<{ id: number }>(`SELECT id FROM pr_lines WHERE status IN (${S.OPEN_STATUSES.map(() => '?').join(',')})`, ...S.OPEN_STATUSES)) S.computeRepeat(l.id);
  });
  for (const t of ['exc.off_contract', 'exc.single_source', 'exc.stale_routing']) {
    onDecision(t, (ap, outcome, actor, comment) => {
      if (ap.object_type === 'pr_line') S.onRouteApproval(ap.object_id, outcome, actor, comment);
    });
  }
  registerJob({ name: 'pr.ageing', label: 'PR ageing and priority SLA alerts', everyMinutes: 60, run: S.ageingJob });
}

/** Demo data: the base PR lines come from the SAP seed; the extended set checks and routes a share of them. */
function seed() {
  if (DEMO_EXTRA) seedExtra();
}

export const module: ModuleDef = { path: 'pr', router, init, seed };
