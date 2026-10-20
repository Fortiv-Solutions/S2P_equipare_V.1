/**
 * Configurable approval engine (Module 5, APP-01..05, FR-APR-01..10).
 *  - Routing comes from `approval_matrix` rows (data, not code). No amounts or approvers are
 *    invented: the seeded matrix is a placeholder marked "pending DEC-13".
 *  - Each request stores the matrix id/version applied (FR-APR-10).
 *  - Segregation of duties: requester / recommender cannot act on their own request (FR-APR-09).
 *  - Modules register `onDecision` handlers to react to final outcomes.
 */
import { all, get, insert, update, run, J, now, addHours, tx } from './db.ts';
import { nextNo } from './numbering.ts';
import { audit } from './audit.ts';
import { notify } from './notify.ts';
import { badRequest, conflict, forbidden, notFound } from './http.ts';
import { cfg } from './config.ts';
import type { Actor } from './auth.ts';
import { APPROVER_STEP_ROLES, type Role } from './permissions.ts';

export const APPROVAL_TYPES: Record<string, { label: string; category: 'approval' | 'exception' }> = {
  'cmp.award': { label: 'Award recommendation', category: 'approval' },
  'exc.deviation': { label: 'Award deviation (not lowest landed cost)', category: 'exception' },
  'exc.single_source': { label: 'Single source / limited vendors', category: 'exception' },
  'exc.urgent': { label: 'Urgent procurement', category: 'exception' },
  'exc.po_after_receipt': { label: 'PO after receipt', category: 'exception' },
  'exc.off_contract': { label: 'Off-contract purchase', category: 'exception' },
  'exc.price_amendment': { label: 'Price amendment', category: 'exception' },
  'exc.new_vendor': { label: 'Non-suggested vendor added to RFQ', category: 'exception' },
  'exc.stale_routing': { label: 'Routing on unavailable SAP data', category: 'exception' },
  'rfq.reopen': { label: 'Reopen quotations after close', category: 'approval' },
  'cmp.discount': { label: 'Late / risk discount use', category: 'approval' },
  'po.amendment': { label: 'PO amendment', category: 'approval' },
  'po.cancellation': { label: 'PO cancellation', category: 'approval' },
  'contract.approval': { label: 'Contract / ARC approval', category: 'approval' },
  'contract.renewal': { label: 'Contract renewal / extension', category: 'approval' },
  'adv.request': { label: 'Advance payment request', category: 'approval' },
  'config.tolerance': { label: '3-way match tolerance change', category: 'approval' },
  'vendor.onboarding': { label: 'Vendor onboarding', category: 'approval' },
  'vendor.bank_change': { label: 'Vendor bank detail change', category: 'approval' },
  'dispute.closure': { label: 'Dispute closure', category: 'approval' },
};

/** Modules may add approval types at init (the matrix falls back to the Procurement Manager). */
export function registerApprovalType(type: string, label: string, category: 'approval' | 'exception' = 'approval') {
  APPROVAL_TYPES[type] = { label, category };
}

export interface MatrixLevel {
  level: number;
  roles: Role[]; // more than one role = parallel approvals at this level, all required
  label?: string;
}
interface MatrixRow {
  id: number;
  version: number;
  type: string;
  name: string;
  conditions: { min_value?: number; max_value?: number; urgency?: string[]; category?: string[] } | null;
  levels: MatrixLevel[];
  effective_from: string;
  active: number;
}

export interface ApprovalRow {
  id: number;
  req_no: string;
  type: string;
  category: string;
  object_type: string;
  object_id: number;
  title: string;
  summary: string | null;
  value: number | null;
  requester_id: number;
  status: string;
  current_level: number;
  matrix_id: number | null;
  matrix_version: number | null;
  context: Record<string, unknown> | null;
  reason: string | null;
  outcome: string | null;
  urgency: string | null;
  plant: string | null;
  category_code: string | null;
  created_at: string;
  decided_at: string | null;
}

type Outcome = 'Approved' | 'Rejected' | 'Returned' | 'Withdrawn';
type Handler = (a: ApprovalRow, outcome: Outcome, actor: Actor | null, comment: string | null) => void;
const handlers = new Map<string, Handler[]>();

export function onDecision(type: string, fn: Handler) {
  const list = handlers.get(type) ?? [];
  list.push(fn);
  handlers.set(type, list);
}

function matchMatrix(type: string, value: number, urgency?: string | null, category?: string | null): MatrixRow | undefined {
  const rows = all<MatrixRow>(
    'SELECT * FROM approval_matrix WHERE type = ? AND active = 1 AND effective_from <= ? ORDER BY version DESC, id',
    type, now(),
  );
  return rows.find((r) => {
    const c = r.conditions ?? {};
    if (c.min_value != null && value < c.min_value) return false;
    if (c.max_value != null && value > c.max_value) return false;
    if (c.urgency?.length && (!urgency || !c.urgency.includes(urgency))) return false;
    if (c.category?.length && (!category || !c.category.includes(category))) return false;
    return true;
  });
}

export interface CreateApprovalInput {
  type: string;
  objectType: string;
  objectId: number;
  title: string;
  summary?: string;
  value?: number;
  reason?: string;
  context?: Record<string, unknown>;
  urgency?: string | null;
  plant?: string | null;
  categoryCode?: string | null;
}

export function createApproval(actor: Actor, input: CreateApprovalInput) {
  const def = APPROVAL_TYPES[input.type];
  if (!def) throw new Error(`Unknown approval type ${input.type}`);
  const open = get<{ req_no: string }>(
    "SELECT req_no FROM approvals WHERE type = ? AND object_type = ? AND object_id = ? AND status IN ('Pending','Clarification requested')",
    input.type, input.objectType, input.objectId,
  );
  if (open) throw conflict(`An approval request (${open.req_no}) is already pending for this record.`);

  return tx(() => {
    const value = input.value ?? 0;
    const m = matchMatrix(input.type, value, input.urgency, input.categoryCode);
    const levels: MatrixLevel[] = m?.levels ?? [{ level: 1, roles: ['APR'], label: 'Procurement Manager (fallback — no matrix row matched, DEC-13)' }];
    const reqNo = nextNo('APR');
    const id = insert('approvals', {
      req_no: reqNo, type: input.type, category: def.category, object_type: input.objectType, object_id: input.objectId,
      title: input.title, summary: input.summary ?? null, value: input.value ?? null, requester_id: actor.id, status: 'Pending',
      current_level: levels[0].level, matrix_id: m?.id ?? null, matrix_version: m?.version ?? null,
      context_json: J({ ...(input.context ?? {}), matrix_name: m?.name ?? 'Fallback route', levels }),
      reason: input.reason ?? null, urgency: input.urgency ?? null, plant: input.plant ?? null,
      category_code: input.categoryCode ?? null, created_at: now(),
    });
    const timing = cfg<{ remind_after_hours: number; escalate_after_hours: number }>('approval.timing');
    for (const lv of levels) {
      lv.roles.forEach((role) => {
        insert('approval_steps', {
          approval_id: id, level: lv.level, approver_role: role,
          status: lv.level === levels[0].level ? 'Pending' : 'Waiting',
          due_at: lv.level === levels[0].level ? addHours(new Date(), timing.escalate_after_hours) : null,
          parallel_group: lv.roles.length > 1 ? lv.level : null,
        });
      });
    }
    audit(actor, { action: 'approval.requested', objectType: 'approval', objectId: id, objectRef: reqNo, after: { type: input.type, value: input.value, matrix_version: m?.version ?? null, linked: `${input.objectType}:${input.objectId}` }, reason: input.reason });
    notifyLevel(id, levels[0].level);
    return getApproval(id)!;
  });
}

function notifyLevel(approvalId: number, level: number) {
  const a = getApproval(approvalId)!;
  const steps = all<{ approver_role: Role }>("SELECT approver_role FROM approval_steps WHERE approval_id = ? AND level = ? AND status = 'Pending'", approvalId, level);
  const recommender = (a.context?.recommended_by as number | undefined) ?? undefined;
  notify({
    event: 'NTF-10', title: `Approval needed: ${a.title}`, body: `${APPROVAL_TYPES[a.type]?.label ?? a.type} · ${a.req_no}`,
    link: `/approvals/${a.id}`, roles: steps.map((s) => s.approver_role), plant: a.plant, objectType: 'approval', objectId: a.id,
    exclude: [a.requester_id, ...(recommender ? [recommender] : [])], dedupeKey: `NTF-10:${a.id}:${level}`, severity: 'warning',
  });
}

export function getApproval(id: number) {
  return get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', id);
}

export function stepsOf(id: number) {
  return all<{ id: number; level: number; approver_role: Role; status: string; comment: string | null; acted_by: number | null; acted_at: string | null; due_at: string | null; escalated: number; device: string | null; delegated_from: number | null; acted_by_name?: string }>(
    'SELECT s.*, u.name AS acted_by_name FROM approval_steps s LEFT JOIN users u ON u.id = s.acted_by WHERE s.approval_id = ? ORDER BY s.level, s.id',
    id,
  );
}

/** Whether this actor may act on the approval right now, and why not. */
export function actionability(actor: Actor, a: ApprovalRow): { canAct: boolean; why?: string; stepId?: number } {
  if (!['Pending'].includes(a.status)) return { canAct: false, why: `Request is ${a.status.toLowerCase()}.` };
  if (!actor.perms.has('apr.decide')) return { canAct: false, why: 'Your role does not approve requests.' };
  if (a.requester_id === actor.id) return { canAct: false, why: 'You raised this request, so you cannot approve it (segregation of duties).' };
  if (a.context?.recommended_by === actor.id) return { canAct: false, why: 'You made this recommendation, so you cannot approve it (segregation of duties).' };
  // The merged single-user Administrator holds every approver role, so it can act on whichever step is pending.
  const roles: Role[] = actor.merged ? APPROVER_STEP_ROLES : [actor.role];
  const step = get<{ id: number }>(
    `SELECT id FROM approval_steps WHERE approval_id = ? AND level = ? AND status = 'Pending' AND approver_role IN (${roles.map(() => '?').join(',')}) ORDER BY id`,
    a.id, a.current_level, ...roles,
  );
  if (step) return { canAct: true, stepId: step.id };
  // Delegation: actor is the current delegate of a user who holds a pending role.
  const delegators = all<{ id: number; roles: string }>(
    'SELECT id, roles FROM users WHERE delegate_id = ? AND delegate_until >= ?', actor.id, now(),
  );
  for (const d of delegators) {
    const s = get<{ id: number }>(
      `SELECT id FROM approval_steps WHERE approval_id = ? AND level = ? AND status = 'Pending' AND approver_role IN (${d.roles.split(',').map(() => '?').join(',')})`,
      a.id, a.current_level, ...d.roles.split(','),
    );
    if (s && d.id !== a.requester_id) return { canAct: true, stepId: s.id };
  }
  return { canAct: false, why: 'This step is waiting for another role.' };
}

export type ApprovalAction = 'approve' | 'reject' | 'return' | 'clarify';

export function act(actor: Actor, id: number, action: ApprovalAction, comment: string | null) {
  const a = getApproval(id);
  if (!a) throw notFound('Approval request');
  const chk = actionability(actor, a);
  if (!chk.canAct) throw forbidden(chk.why);
  if (action !== 'approve' && (!comment || comment.trim().length < 5)) {
    throw badRequest('A comment of at least 5 characters is required to reject, return or ask for clarification.', { comment: 'Comment is required' });
  }
  return tx(() => {
    const ts = now();
    if (action === 'clarify') {
      update('approval_steps', chk.stepId!, { comment, acted_by: actor.id, acted_at: ts, device: actor.channel });
      update('approvals', id, { status: 'Clarification requested' });
      insert('comments', { object_type: 'approval', object_id: id, user_id: actor.id, body: `Clarification requested: ${comment}`, internal: 1, created_at: ts });
      audit(actor, { action: 'approval.clarification_requested', objectType: 'approval', objectId: id, objectRef: a.req_no, reason: comment });
      notify({ event: 'NTF-12', title: `Clarification requested on ${a.req_no}`, body: comment ?? '', link: `/approvals/${id}`, users: [a.requester_id], objectType: 'approval', objectId: id, dedupeKey: `NTF-12c:${id}:${ts}` });
      return getApproval(id)!;
    }
    const stepStatus = action === 'approve' ? 'Approved' : action === 'reject' ? 'Rejected' : 'Returned';
    update('approval_steps', chk.stepId!, { status: stepStatus, comment, acted_by: actor.id, acted_at: ts, device: actor.channel });
    audit(actor, { action: `approval.${action}`, objectType: 'approval', objectId: id, objectRef: a.req_no, after: { level: a.current_level, step: chk.stepId, device: actor.channel }, reason: comment });

    if (action !== 'approve') {
      run("UPDATE approval_steps SET status = 'Skipped' WHERE approval_id = ? AND status IN ('Pending','Waiting')", id);
      return finish(a, action === 'reject' ? 'Rejected' : 'Returned', actor, comment);
    }
    const remaining = get<{ n: number }>("SELECT COUNT(*) AS n FROM approval_steps WHERE approval_id = ? AND level = ? AND status = 'Pending'", id, a.current_level)!.n;
    if (remaining > 0) return getApproval(id)!;
    const next = get<{ level: number }>("SELECT MIN(level) AS level FROM approval_steps WHERE approval_id = ? AND status = 'Waiting'", id);
    if (next?.level) {
      const timing = cfg<{ escalate_after_hours: number }>('approval.timing');
      run("UPDATE approval_steps SET status = 'Pending', due_at = ? WHERE approval_id = ? AND level = ?", addHours(new Date(), timing.escalate_after_hours), id, next.level);
      update('approvals', id, { current_level: next.level });
      notifyLevel(id, next.level);
      return getApproval(id)!;
    }
    return finish(a, 'Approved', actor, comment);
  });
}

function finish(a: ApprovalRow, outcome: Outcome, actor: Actor | null, comment: string | null) {
  update('approvals', a.id, { status: outcome, outcome: comment, decided_at: now() });
  const fresh = getApproval(a.id)!;
  for (const fn of handlers.get(a.type) ?? []) fn(fresh, outcome, actor, comment);
  notify({
    event: 'NTF-12', title: `${a.req_no} ${outcome.toLowerCase()}: ${a.title}`, body: comment ?? undefined,
    link: `/approvals/${a.id}`, users: [a.requester_id], objectType: 'approval', objectId: a.id,
    severity: outcome === 'Approved' ? 'success' : 'warning', dedupeKey: `NTF-12:${a.id}:${outcome}`,
  });
  return getApproval(a.id)!;
}

/** Requester answers a clarification; request returns to the pending step. */
export function answerClarification(actor: Actor, id: number, answer: string) {
  const a = getApproval(id);
  if (!a) throw notFound('Approval request');
  if (a.requester_id !== actor.id) throw forbidden('Only the requester can answer the clarification.');
  if (a.status !== 'Clarification requested') throw conflict('No clarification is pending.');
  if (!answer || answer.trim().length < 5) throw badRequest('Answer is required.', { answer: 'Answer is required' });
  insert('comments', { object_type: 'approval', object_id: id, user_id: actor.id, body: `Clarification answered: ${answer}`, internal: 1, created_at: now() });
  update('approvals', id, { status: 'Pending' });
  audit(actor, { action: 'approval.clarification_answered', objectType: 'approval', objectId: id, objectRef: a.req_no, reason: answer });
  notifyLevel(id, a.current_level);
  return getApproval(id)!;
}

export function withdraw(actor: Actor, id: number, reason: string) {
  const a = getApproval(id);
  if (!a) throw notFound('Approval request');
  if (a.requester_id !== actor.id) throw forbidden('Only the requester can withdraw this request.');
  if (!['Pending', 'Clarification requested'].includes(a.status)) throw conflict(`Request is already ${a.status.toLowerCase()}.`);
  return tx(() => {
    run("UPDATE approval_steps SET status = 'Skipped' WHERE approval_id = ? AND status IN ('Pending','Waiting')", id);
    audit(actor, { action: 'approval.withdrawn', objectType: 'approval', objectId: id, objectRef: a.req_no, reason });
    return finish(a, 'Withdrawn', actor, reason);
  });
}

/** Scheduler: remind and escalate overdue steps (FR-APR-06, NTF-11). */
export function escalateApprovals() {
  const timing = cfg<{ remind_after_hours: number; escalate_after_hours: number }>('approval.timing');
  const pending = all<{ id: number; approval_id: number; approver_role: Role; level: number; escalated: number; created_at: string; due_at: string | null; req_no: string; title: string; plant: string | null; requester_id: number }>(
    `SELECT s.id, s.approval_id, s.approver_role, s.level, s.escalated, s.due_at, a.created_at, a.req_no, a.title, a.plant, a.requester_id
     FROM approval_steps s JOIN approvals a ON a.id = s.approval_id
     WHERE s.status = 'Pending' AND a.status = 'Pending'`,
  );
  let reminded = 0;
  let escalated = 0;
  for (const s of pending) {
    const ageH = (Date.now() - new Date(s.created_at).getTime()) / 3600000;
    if (ageH >= timing.remind_after_hours) {
      reminded += notify({ event: 'NTF-11', title: `Reminder: ${s.req_no} waiting for your decision`, body: s.title, link: `/approvals/${s.approval_id}`, roles: [s.approver_role], plant: s.plant, exclude: [s.requester_id], objectType: 'approval', objectId: s.approval_id, dedupeKey: `NTF-11r:${s.id}`, severity: 'warning' }).length;
    }
    if (!s.escalated && s.due_at && new Date(s.due_at).getTime() < Date.now()) {
      update('approval_steps', s.id, { escalated: 1 });
      escalated += notify({ event: 'NTF-11', title: `Escalation: ${s.req_no} pending beyond ${timing.escalate_after_hours} h`, body: `${s.title} — waiting on ${s.approver_role}`, link: `/approvals/${s.approval_id}`, roles: ['MGT'], objectType: 'approval', objectId: s.approval_id, dedupeKey: `NTF-11e:${s.id}`, severity: 'danger' }).length;
      audit(null, { action: 'approval.escalated', objectType: 'approval', objectId: s.approval_id, objectRef: s.req_no, after: { step: s.id, role: s.approver_role } });
    }
  }
  return `reminders ${reminded}, escalations ${escalated}`;
}

export function approvalForObject(objectType: string, objectId: number, type?: string) {
  return get<ApprovalRow>(
    `SELECT * FROM approvals WHERE object_type = ? AND object_id = ? ${type ? 'AND type = ?' : ''} ORDER BY id DESC LIMIT 1`,
    objectType, objectId, ...(type ? [type] : []),
  );
}
