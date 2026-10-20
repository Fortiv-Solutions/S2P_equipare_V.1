import { Router } from 'express';
import { z } from 'zod';
import type { ModuleDef } from '../types.ts';
import { h, parse, idParam, reasonSchema, sendCsv, forbidden } from '../../core/http.ts';
import { requirePerm, requireAuth, actorOf } from '../../core/auth.ts';
import { registerConfig } from '../../core/config.ts';
import { registerObjectAccess } from '../../core/files.ts';
import { audit } from '../../core/audit.ts';
import { DEMO_EXTRA } from '../../core/mode.ts';
import * as S from './service.ts';
import { seedExtra } from './seed_extra.ts';

const router = Router();
const internal = (req: Parameters<typeof actorOf>[0]) => {
  const a = actorOf(req);
  if (a.role === 'VEN') throw forbidden();
  return a;
};
const commentSchema = z.object({ comment: z.string().max(2000).optional().nullable() });

router.get('/', requireAuth, h((req) => S.listApprovals(internal(req), req.query as Record<string, string>)));
router.get('/summary', requireAuth, h((req) => S.summary(internal(req))));
router.get('/ageing', requirePerm('apr.view', 'apr.decide'), h((req) => S.ageing(String(req.query.by ?? 'approver'))));

router.get('/delegation', requireAuth, h((req) => S.delegation(internal(req))));
router.put('/delegation', requireAuth, h((req) => {
  const b = parse(z.object({ delegate_id: z.number({ error: 'Choose a person' }).int().positive('Choose a person'), until: z.string({ error: 'Enter the end date' }).min(1, 'Enter the end date'), reason: z.string().max(500).optional().nullable() }), req.body);
  return S.setDelegation(internal(req), b.delegate_id, b.until, b.reason ?? null);
}));
router.delete('/delegation', requireAuth, h((req) => S.clearDelegation(internal(req))));

router.get('/exceptions', requirePerm('exc.view'), h((req, res) => {
  const q = req.query as Record<string, string>;
  const r = S.exceptions(q);
  if (q.format === 'csv') {
    audit(actorOf(req), { action: 'exceptions.exported', objectType: 'screen', objectId: 'SCR-APR-03', after: { rows: r.rows.length, from: q.from ?? null, to: q.to ?? null } });
    return sendCsv(res, 'exception-register.csv', r.rows as unknown as Record<string, unknown>[], [
      { key: 'req_no', label: 'Request' }, { key: 'type_label', label: 'Exception type' }, { key: 'title', label: 'Title' }, { key: 'reason', label: 'Reason' },
      { key: 'value', label: 'Value (INR)' }, { key: 'requester_name', label: 'Raised by' }, { key: 'created_at', label: 'Raised at (UTC)' }, { key: 'approvers', label: 'Approver(s)' },
      { key: 'outcome', label: 'Outcome' }, { key: 'outcome_comment', label: 'Outcome comment' }, { key: 'decided_at', label: 'Decided at (UTC)' },
      { key: 'linked_label', label: 'Record type' }, { key: 'linked_ref', label: 'Record' }, { key: 'reviewed_by', label: 'Reviewed by' }, { key: 'reviewed_at', label: 'Reviewed at (UTC)' }, { key: 'review_note', label: 'Review note' },
    ]);
  }
  return r;
}));
router.post('/exceptions/:id/review', requirePerm('exc.view'), h((req) => S.reviewException(actorOf(req), idParam(req), parse(z.object({ note: reasonSchema }), req.body).note)));

router.get('/matrix', requireAuth, h((req) => { internal(req); return S.matrixList(); }));
const matrixSchema = z.object({
  type: z.string().min(1, 'Choose the approval type'),
  name: z.string().trim().min(3, 'Name the rule (at least 3 characters)').max(120),
  conditions: z.object({ min_value: z.number().nullable().optional(), max_value: z.number().nullable().optional(), urgency: z.array(z.string()).optional(), category: z.array(z.string()).optional() }).default({}),
  levels: z.array(z.object({ level: z.number().int().positive(), roles: z.array(z.string()), label: z.string().max(80).nullable().optional() })).min(1, 'Add at least one level'),
  effective_from: z.string().min(10, 'Enter the effective date'),
  note: z.string().max(500).nullable().optional(),
  replaces_id: z.number().int().nullable().optional(),
});
router.post('/matrix', requirePerm('adm.config'), h((req) => S.createMatrix(actorOf(req), parse(matrixSchema, req.body))));
router.post('/matrix/:id/deactivate', requirePerm('adm.config'), h((req) => S.deactivateMatrix(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));

router.post('/bulk-approve', requirePerm('apr.decide'), h((req) => {
  const b = parse(z.object({ ids: z.array(z.number().int().positive()).min(1, 'Select at least one request').max(100), comment: z.string().max(2000).optional().nullable() }), req.body);
  return S.bulkApprove(actorOf(req), b.ids, b.comment ?? null);
}));

router.get('/:id', requireAuth, h((req) => S.detail(internal(req), idParam(req))));
router.post('/:id/approve', requirePerm('apr.decide'), h((req) => S.decide(actorOf(req), idParam(req), 'approve', parse(commentSchema, req.body).comment ?? null)));
router.post('/:id/reject', requirePerm('apr.decide'), h((req) => S.decide(actorOf(req), idParam(req), 'reject', parse(commentSchema, req.body).comment ?? null)));
router.post('/:id/return', requirePerm('apr.decide'), h((req) => S.decide(actorOf(req), idParam(req), 'return', parse(commentSchema, req.body).comment ?? null)));
router.post('/:id/clarify', requirePerm('apr.decide'), h((req) => S.decide(actorOf(req), idParam(req), 'clarify', parse(commentSchema, req.body).comment ?? null)));
router.post('/:id/answer', requireAuth, h((req) => S.answer(internal(req), idParam(req), parse(z.object({ answer: z.string().max(2000) }), req.body).answer)));
router.post('/:id/withdraw', requireAuth, h((req) => S.withdrawRequest(internal(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));

function init() {
  registerConfig(
    { key: 'approvals.bulk_types', label: 'Bulk approval allowed for', group: 'Approvals', description: 'Approval types an approver may approve several at a time from the inbox. Empty: every request is opened and decided individually.', value: [], decision: 'Q 10.3' },
    { key: 'approvals.ageing_buckets', label: 'Approval ageing buckets (days)', group: 'Approvals', description: 'Upper bounds of the approval ageing buckets on the APP-05 dashboard.', value: [1, 3, 6], decision: 'Q APP-05' },
  );
  registerObjectAccess('approval', (actor, id) => S.canAccessApproval(actor, id));
}

/** Demo data: only the extended set (approvals are raised by the other modules' seeds). */
function seed() {
  if (DEMO_EXTRA) seedExtra();
}

export const module: ModuleDef = { path: 'approvals', router, init, seed };
