/**
 * Module 5 — Approval inbox, decision screen data, ageing dashboard, exception register,
 * approval-matrix administration and delegation (FR-APR-01..10, APP-01..05, WF-01, WF-04).
 * The routing / decision engine itself is core/approvals.ts; this module only reads it and calls it.
 */
import { all, get, insert, run, update, J, now, tx, scalar } from '../../core/db.ts';
import { audit } from '../../core/audit.ts';
import { cfg } from '../../core/config.ts';
import { badRequest, conflict, forbidden, notFound } from '../../core/http.ts';
import { APPROVAL_TYPES, actionability, act, answerClarification, getApproval, stepsOf, withdraw, type ApprovalAction, type ApprovalRow } from '../../core/approvals.ts';
import { ROLES, type Role } from '../../core/permissions.ts';
import { approvalPanel } from '../cmp/service.ts';
import type { Actor } from '../../core/auth.ts';

/** Roles that may hold approval steps (SAP/IT and Administrator never approve — PRD Sec 6). */
export const APPROVER_ROLES: Role[] = ['APR', 'FIN', 'MGT'];

const typeLabel = (t: string) => APPROVAL_TYPES[t]?.label ?? t;
const ageDays = (iso: string) => (Date.now() - new Date(iso).getTime()) / 86400000;

export function bucketDefs() {
  const edges = cfg<number[]>('approvals.ageing_buckets');
  const labels: string[] = [];
  edges.forEach((e, i) => labels.push(i === 0 ? `Under ${e} day${e === 1 ? '' : 's'}` : `${edges[i - 1]}–${e} days`));
  labels.push(`${edges[edges.length - 1]} days and over`);
  return { edges, labels };
}
export function bucketOf(age: number) {
  const { edges, labels } = bucketDefs();
  const i = edges.findIndex((e) => age < e);
  return labels[i === -1 ? edges.length : i];
}

// ------------------------------------------------------------------ linked record (every object type links to its record)
export function linkFor(objectType: string | null, objectId: number | null): { label: string; ref: string | null; link: string | null } {
  if (!objectType || objectId == null) return { label: 'No linked record', ref: null, link: null };
  const g = <T>(sql: string) => get<T>(sql, objectId);
  switch (objectType) {
    case 'pr_line': { const r = g<{ pr_no: string; item: number }>('SELECT pr_no, item FROM pr_lines WHERE id = ?'); return { label: 'PR line', ref: r ? `${r.pr_no}/${r.item}` : null, link: `/pr/${objectId}` }; }
    case 'comparison': { const r = g<{ cmp_no: string; version: number }>('SELECT cmp_no, version FROM comparisons WHERE id = ?'); return { label: 'Comparison', ref: r ? `${r.cmp_no} v${r.version}` : null, link: `/comparisons/${objectId}` }; }
    case 'rfq': { const r = g<{ rfq_no: string }>('SELECT rfq_no FROM rfqs WHERE id = ?'); return { label: 'RFQ', ref: r?.rfq_no ?? null, link: `/rfqs/${objectId}` }; }
    case 'rfq_reopen': { const r = g<{ rfq_id: number; rfq_no: string }>('SELECT o.rfq_id, r.rfq_no FROM rfq_reopens o JOIN rfqs r ON r.id = o.rfq_id WHERE o.id = ?'); return { label: 'RFQ reopen', ref: r?.rfq_no ?? null, link: r ? `/rfqs/${r.rfq_id}` : null }; }
    case 'po': { const r = g<{ po_no: string }>('SELECT po_no FROM pos WHERE id = ?'); return { label: 'Purchase order', ref: r?.po_no ?? null, link: `/pos/${objectId}` }; }
    case 'po_amendment': { const r = g<{ po_id: number; amd_no: string | null; po_no: string }>('SELECT a.po_id, a.amd_no, p.po_no FROM po_amendments a JOIN pos p ON p.id = a.po_id WHERE a.id = ?'); return { label: 'PO amendment', ref: r ? `${r.po_no}${r.amd_no ? ` · ${r.amd_no}` : ''}` : null, link: r ? `/pos/${r.po_id}` : null }; }
    case 'contract': { const r = g<{ contract_no: string }>('SELECT contract_no FROM contracts WHERE id = ?'); return { label: 'Contract', ref: r?.contract_no ?? null, link: `/contracts/${objectId}` }; }
    case 'advance': { const r = g<{ adv_no: string }>('SELECT adv_no FROM advances WHERE id = ?'); return { label: 'Advance', ref: r?.adv_no ?? null, link: `/advances/${objectId}` }; }
    case 'vendor': { const r = g<{ name: string }>('SELECT name FROM vendors WHERE id = ?'); return { label: 'Vendor', ref: r?.name ?? null, link: `/vendors/${objectId}` }; }
    case 'vendor_change': { const r = g<{ vendor_id: number; field: string; name: string }>('SELECT c.vendor_id, c.field, v.name FROM vendor_change_requests c JOIN vendors v ON v.id = c.vendor_id WHERE c.id = ?'); return { label: 'Vendor change', ref: r ? `${r.name} · ${r.field}` : null, link: r ? `/vendors/${r.vendor_id}` : null }; }
    case 'dispute': { const r = g<{ dsp_no: string }>('SELECT dsp_no FROM disputes WHERE id = ?'); return { label: 'Dispute', ref: r?.dsp_no ?? null, link: `/disputes/${objectId}` }; }
    case 'config_change': { const r = g<{ key: string }>('SELECT key FROM config_history WHERE id = ?'); return { label: 'Configuration change', ref: r?.key ?? null, link: '/admin/config' }; }
    default: return { label: objectType.replace(/_/g, ' '), ref: `#${objectId}`, link: null };
  }
}

// ------------------------------------------------------------------ list / inbox (SCR-APR-01)
type Row = ApprovalRow & { requester_name: string | null };

function decorate(actor: Actor, a: Row) {
  const pending = all<{ approver_role: Role; level: number }>("SELECT approver_role, level FROM approval_steps WHERE approval_id = ? AND level = ? AND status = 'Pending'", a.id, a.current_level);
  const chk = actionability(actor, a);
  const age = ageDays(a.created_at);
  const open = ['Pending', 'Clarification requested'].includes(a.status);
  const linked = linkFor(a.object_type, a.object_id);
  return {
    id: a.id, req_no: a.req_no, type: a.type, type_label: typeLabel(a.type), category: a.category, title: a.title, summary: a.summary, value: a.value,
    status: a.status, current_level: a.current_level, levels: ((a.context?.levels as unknown[]) ?? []).length || null, requester_id: a.requester_id, requester_name: a.requester_name,
    created_at: a.created_at, decided_at: a.decided_at, age_days: Math.floor(age), age_hours: Math.round(age * 24), bucket: open ? bucketOf(age) : null,
    waiting_on: open ? [...new Set(pending.map((p) => p.approver_role))] : [], waiting_on_label: open ? [...new Set(pending.map((p) => ROLES[p.approver_role]))].join(' + ') : null,
    can_act: chk.canAct, urgency: a.urgency, plant: a.plant, matrix_version: a.matrix_version, linked,
    bulk_allowed: chk.canAct && cfg<string[]>('approvals.bulk_types').includes(a.type),
  };
}

export function listApprovals(actor: Actor, q: Record<string, string | undefined>) {
  const tab = q.tab ?? 'mine';
  const where: string[] = [];
  const p: unknown[] = [];
  if (tab === 'mine') where.push("a.status = 'Pending'");
  else if (tab === 'raised') { where.push("(a.requester_id = ? OR json_extract(a.context_json, '$.recommended_by') = ?)"); p.push(actor.id, actor.id); }
  else if (tab === 'all') { if (!actor.perms.has('apr.view') && !actor.perms.has('apr.decide')) throw forbidden('Your role cannot see all approval requests.'); }
  else throw badRequest('Unknown tab.');
  if (q.type) { where.push('a.type = ?'); p.push(q.type); }
  if (q.status) { if (q.status === 'open') where.push("a.status IN ('Pending','Clarification requested')"); else { where.push('a.status = ?'); p.push(q.status); } }
  if (q.category) { where.push('a.category = ?'); p.push(q.category); }
  if (q.level) { where.push('a.current_level = ?'); p.push(Number(q.level)); }
  if (q.role) { where.push("EXISTS (SELECT 1 FROM approval_steps s WHERE s.approval_id = a.id AND s.level = a.current_level AND s.status = 'Pending' AND s.approver_role = ?)"); p.push(q.role); }
  const rows = all<Row>(
    `SELECT a.*, u.name AS requester_name FROM approvals a LEFT JOIN users u ON u.id = a.requester_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.created_at DESC, a.id DESC LIMIT 1000`,
    ...p,
  );
  let out = rows.map((r) => decorate(actor, r));
  if (tab === 'mine') out = out.filter((r) => r.can_act);
  if (q.bucket) out = out.filter((r) => r.bucket === q.bucket);
  return out;
}

export function summary(actor: Actor) {
  const mine = listApprovals(actor, { tab: 'mine' });
  const raised = listApprovals(actor, { tab: 'raised' });
  const canAll = actor.perms.has('apr.view') || actor.perms.has('apr.decide');
  return {
    mine: mine.length,
    mine_value: mine.reduce((s, r) => s + (r.value ?? 0), 0),
    mine_overdue: mine.filter((r) => r.age_days >= bucketDefs().edges[1]).length,
    raised_open: raised.filter((r) => ['Pending', 'Clarification requested'].includes(r.status)).length,
    clarifications: raised.filter((r) => r.status === 'Clarification requested' && r.requester_id === actor.id).length,
    all_open: canAll ? scalar<number>("SELECT COUNT(*) FROM approvals WHERE status IN ('Pending','Clarification requested')") ?? 0 : null,
    can_all: canAll,
    bulk_types: cfg<string[]>('approvals.bulk_types'),
    buckets: bucketDefs().labels,
    types: Object.entries(APPROVAL_TYPES).map(([id, d]) => ({ id, label: d.label, category: d.category })),
  };
}

/** APP-05 ageing dashboard: open requests by approver role, level or type, in configured buckets. */
export function ageing(by: string) {
  const { labels } = bucketDefs();
  const open = all<ApprovalRow>("SELECT * FROM approvals WHERE status IN ('Pending','Clarification requested')");
  const map = new Map<string, { key: string; label: string; counts: number[]; total: number; oldest: number; names?: string }>();
  const add = (key: string, lbl: string, age: number, names?: string) => {
    const r = map.get(key) ?? { key, label: lbl, counts: labels.map(() => 0), total: 0, oldest: 0, names };
    r.counts[labels.indexOf(bucketOf(age))]++;
    r.total++;
    r.oldest = Math.max(r.oldest, Math.floor(age));
    map.set(key, r);
  };
  const users = all<{ name: string; roles: string }>('SELECT name, roles FROM users WHERE active = 1 AND vendor_id IS NULL');
  for (const a of open) {
    const age = ageDays(a.created_at);
    if (by === 'type') add(a.type, typeLabel(a.type), age);
    else if (by === 'level') add(String(a.current_level), `Level ${a.current_level}`, age);
    else {
      const roles = [...new Set(all<{ approver_role: Role }>("SELECT approver_role FROM approval_steps WHERE approval_id = ? AND level = ? AND status = 'Pending'", a.id, a.current_level).map((s) => s.approver_role))];
      if (a.status === 'Clarification requested') add('requester', 'Requester (clarification)', age);
      else for (const r of roles) add(r, ROLES[r], age, users.filter((u) => u.roles.split(',').includes(r)).map((u) => u.name).join(', '));
    }
  }
  return { by, buckets: labels, rows: [...map.values()].sort((x, y) => y.total - x.total), total: open.length };
}

// ------------------------------------------------------------------ decision screen (SCR-APR-02)
function canSee(actor: Actor, a: ApprovalRow) {
  if (actor.role === 'VEN') return false;
  if (actor.perms.has('apr.view') || actor.perms.has('apr.decide')) return true;
  if (a.requester_id === actor.id || a.context?.recommended_by === actor.id) return true;
  return !!get('SELECT id FROM approval_steps WHERE approval_id = ? AND acted_by = ?', a.id, actor.id);
}
export function canAccessApproval(actor: Actor, id: number) {
  const a = getApproval(id);
  return !!a && canSee(actor, a);
}

export function detail(actor: Actor, id: number) {
  const a = getApproval(id);
  if (!a || !canSee(actor, a)) throw notFound('Approval request');
  const chk = actionability(actor, a);
  const requester = get<{ name: string; title: string | null; department: string | null }>('SELECT name, title, department FROM users WHERE id = ?', a.requester_id);
  const recId = typeof a.context?.recommended_by === 'number' ? (a.context.recommended_by as number) : null;
  const recommender = recId ? get<{ name: string }>('SELECT name FROM users WHERE id = ?', recId)?.name ?? null : null;
  const steps = stepsOf(id).map((s) => ({
    ...s, role_label: ROLES[s.approver_role] ?? s.approver_role,
    delegated_from_name: s.delegated_from ? get<{ name: string }>('SELECT name FROM users WHERE id = ?', s.delegated_from)?.name ?? null : null,
    holders: all<{ name: string }>("SELECT name FROM users WHERE active = 1 AND vendor_id IS NULL AND (',' || roles || ',') LIKE ?", `%,${s.approver_role},%`).map((u) => u.name),
  }));
  const { matrix_name, levels, ...context } = (a.context ?? {}) as Record<string, unknown>;
  const matrix = a.matrix_id ? get<{ id: number; name: string; version: number; effective_from: string; note: string | null; active: number }>('SELECT id, name, version, effective_from, note, active FROM approval_matrix WHERE id = ?', a.matrix_id) : null;
  let panel: unknown = null;
  if (a.object_type === 'comparison') panel = { kind: 'comparison', ...approvalPanel(a.object_id) };
  else if (a.object_type === 'config_change') {
    const h = get<{ key: string; status: string; reason: string | null }>('SELECT key, status, reason FROM config_history WHERE id = ?', a.object_id);
    const c = h ? get<{ label: string; decision_ref: string | null; description: string | null }>('SELECT label, decision_ref, description FROM config WHERE key = ?', h.key) : undefined;
    panel = { kind: 'config_change', key: h?.key ?? context.key, label: c?.label ?? null, description: c?.description ?? null, decision: c?.decision_ref ?? null, change_status: h?.status ?? null, from: context.from, to: context.to };
  }
  const comments = all('SELECT c.id, c.body, c.created_at, c.user_id, u.name AS user_name, c.internal FROM comments c JOIN users u ON u.id = c.user_id WHERE c.object_type = ? AND c.object_id = ? ORDER BY c.id', 'approval', id);
  const isRequester = a.requester_id === actor.id;
  let delegatedFor: string | null = null;
  if (chk.canAct && chk.stepId) {
    const st = get<{ approver_role: Role }>('SELECT approver_role FROM approval_steps WHERE id = ?', chk.stepId)!;
    if (st.approver_role !== actor.role) delegatedFor = delegatorFor(actor, st.approver_role, a.requester_id)?.name ?? null;
  }
  return {
    ...a, context, type_label: typeLabel(a.type), requester_name: requester?.name ?? null, requester_title: requester?.title ?? null, requester_department: requester?.department ?? null,
    recommended_by_name: recommender, age_days: Math.floor(ageDays(a.created_at)), bucket: ['Pending', 'Clarification requested'].includes(a.status) ? bucketOf(ageDays(a.created_at)) : null,
    steps, levels: levels ?? [], matrix: { id: a.matrix_id, name: (matrix_name as string) ?? matrix?.name ?? 'Fallback route', version: a.matrix_version, effective_from: matrix?.effective_from ?? null, note: matrix?.note ?? null, fallback: !a.matrix_id },
    linked: linkFor(a.object_type, a.object_id), panel, comments,
    can_act: chk.canAct, why_not: chk.canAct ? null : chk.why ?? null, acting_as_delegate_for: delegatedFor,
    can_answer: isRequester && a.status === 'Clarification requested', can_withdraw: isRequester && ['Pending', 'Clarification requested'].includes(a.status),
    bulk_allowed: cfg<string[]>('approvals.bulk_types').includes(a.type),
  };
}

function delegatorFor(actor: Actor, role: Role, requesterId: number) {
  return all<{ id: number; name: string; roles: string }>('SELECT id, name, roles FROM users WHERE delegate_id = ? AND delegate_until >= ?', actor.id, now())
    .find((d) => d.roles.split(',').includes(role) && d.id !== requesterId);
}

/** Decide (approve / reject / return / ask for clarification). Records delegation on the step (FR-APR-06). */
export function decide(actor: Actor, id: number, action: ApprovalAction, comment: string | null) {
  const a = getApproval(id);
  if (!a || !canSee(actor, a)) throw notFound('Approval request');
  const chk = actionability(actor, a);
  const step = chk.stepId ? get<{ id: number; approver_role: Role }>('SELECT id, approver_role FROM approval_steps WHERE id = ?', chk.stepId) : undefined;
  return tx(() => {
    const out = act(actor, id, action, comment?.trim() ? comment.trim() : null);
    if (step && step.approver_role !== actor.role) {
      const d = delegatorFor(actor, step.approver_role, a.requester_id);
      if (d) {
        update('approval_steps', step.id, { delegated_from: d.id });
        audit(actor, { action: 'approval.acted_as_delegate', objectType: 'approval', objectId: id, objectRef: a.req_no, after: { step: step.id, role: step.approver_role, on_behalf_of: d.name, action } });
      }
    }
    return out;
  });
}

export function answer(actor: Actor, id: number, text: string) {
  return answerClarification(actor, id, text);
}
export function withdrawRequest(actor: Actor, id: number, reason: string) {
  return withdraw(actor, id, reason);
}

export function bulkApprove(actor: Actor, ids: number[], comment: string | null) {
  const allowed = cfg<string[]>('approvals.bulk_types');
  const results: { id: number; req_no?: string; ok: boolean; message?: string }[] = [];
  for (const id of ids) {
    const a = getApproval(id);
    try {
      if (!a) throw notFound('Approval request');
      if (!allowed.includes(a.type)) throw badRequest(`${typeLabel(a.type)} requests must be opened and decided one at a time (bulk approval is not enabled for this type — Q 10.3).`);
      decide(actor, id, 'approve', comment);
      results.push({ id, req_no: a.req_no, ok: true });
    } catch (e) {
      results.push({ id, req_no: a?.req_no, ok: false, message: (e as Error).message });
    }
  }
  return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

// ------------------------------------------------------------------ exception register (FR-APR-08, SCR-APR-03)
export function exceptions(q: Record<string, string | undefined>) {
  const where = ["a.category = 'exception'"];
  const p: unknown[] = [];
  if (q.from) { where.push('a.created_at >= ?'); p.push(q.from); }
  if (q.to) { where.push('a.created_at <= ?'); p.push(`${q.to}T23:59:59.999Z`); }
  if (q.type) { where.push('a.type = ?'); p.push(q.type); }
  if (q.status) { where.push('a.status = ?'); p.push(q.status); }
  const rows = all<Row>(`SELECT a.*, u.name AS requester_name FROM approvals a LEFT JOIN users u ON u.id = a.requester_id WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC`, ...p);
  const list = rows.map((a) => {
    const acted = all<{ name: string; status: string; comment: string | null; acted_at: string; approver_role: string }>(
      "SELECT u.name, s.status, s.comment, s.acted_at, s.approver_role FROM approval_steps s JOIN users u ON u.id = s.acted_by WHERE s.approval_id = ? AND s.status IN ('Approved','Rejected','Returned') ORDER BY s.acted_at", a.id,
    );
    const review = get<{ actor_name: string; ts: string; reason: string | null }>("SELECT actor_name, ts, reason FROM audit_events WHERE action = 'exception.reviewed' AND object_type = 'approval' AND object_id = ? ORDER BY id DESC LIMIT 1", String(a.id));
    const linked = linkFor(a.object_type, a.object_id);
    return {
      id: a.id, req_no: a.req_no, type: a.type, type_label: typeLabel(a.type), title: a.title, summary: a.summary, reason: a.reason, value: a.value,
      requester_name: a.requester_name, created_at: a.created_at, status: a.status, outcome: a.status === 'Pending' || a.status === 'Clarification requested' ? 'Open' : a.status,
      outcome_comment: a.outcome, decided_at: a.decided_at, approvers: acted.map((s) => `${s.name} (${s.status.toLowerCase()})`).join(', ') || null,
      linked_label: linked.label, linked_ref: linked.ref, linked_link: linked.link, plant: a.plant,
      reviewed_by: review?.actor_name ?? null, reviewed_at: review?.ts ?? null, review_note: review?.reason ?? null,
    };
  });
  const byType = new Map<string, { type: string; label: string; total: number; approved: number; rejected: number; open: number; other: number; value: number }>();
  for (const r of list) {
    const t = byType.get(r.type) ?? { type: r.type, label: r.type_label, total: 0, approved: 0, rejected: 0, open: 0, other: 0, value: 0 };
    t.total++;
    t.value += r.value ?? 0;
    if (r.outcome === 'Approved') t.approved++; else if (r.outcome === 'Rejected') t.rejected++; else if (r.outcome === 'Open') t.open++; else t.other++;
    byType.set(r.type, t);
  }
  return { rows: list, review: [...byType.values()].sort((a, b) => b.total - a.total), total: list.length, reviewed: list.filter((r) => r.reviewed_at).length };
}

export function reviewException(actor: Actor, id: number, note: string) {
  const a = getApproval(id);
  if (!a || a.category !== 'exception') throw notFound('Exception');
  insert('comments', { object_type: 'approval', object_id: id, user_id: actor.id, body: `Periodic review: ${note}`, internal: 1, created_at: now() });
  audit(actor, { action: 'exception.reviewed', objectType: 'approval', objectId: id, objectRef: a.req_no, after: { status: a.status }, reason: note });
  return { ok: true };
}

// ------------------------------------------------------------------ approval matrix administration (FR-APR-01, FR-APR-10, DEC-13)
export interface MatrixInput {
  type: string;
  name: string;
  conditions: { min_value?: number | null; max_value?: number | null; urgency?: string[]; category?: string[] };
  levels: { level: number; roles: string[]; label?: string | null }[];
  effective_from: string;
  note?: string | null;
  replaces_id?: number | null;
}

export function matrixList() {
  const rows = all<{ id: number; version: number; type: string; name: string; conditions: MatrixInput['conditions'] | null; levels: MatrixInput['levels']; effective_from: string; active: number; created_by: number | null; created_at: string; note: string | null; created_by_name: string | null }>(
    'SELECT m.*, u.name AS created_by_name FROM approval_matrix m LEFT JOIN users u ON u.id = m.created_by ORDER BY m.type, m.active DESC, m.version DESC, m.id',
  );
  const used = new Map(all<{ matrix_id: number; n: number }>('SELECT matrix_id, COUNT(*) AS n FROM approvals WHERE matrix_id IS NOT NULL GROUP BY matrix_id').map((r) => [r.matrix_id, r.n]));
  const t = now();
  return {
    rows: rows.map((r) => ({ ...r, type_label: typeLabel(r.type), category: APPROVAL_TYPES[r.type]?.category ?? 'approval', in_effect: !!r.active && r.effective_from <= t, requests: used.get(r.id) ?? 0 })),
    types: Object.entries(APPROVAL_TYPES).map(([id, d]) => ({ id, label: d.label, category: d.category, has_rule: rows.some((r) => r.type === id && r.active) })),
    roles: APPROVER_ROLES.map((r) => ({ code: r, label: ROLES[r] })),
    categories: all<{ code: string; name: string }>('SELECT code, name FROM spend_categories ORDER BY code'),
    urgencies: ['Normal', 'Urgent', 'BD', 'Class 1'],
  };
}

export function createMatrix(actor: Actor, input: MatrixInput) {
  if (!APPROVAL_TYPES[input.type]) throw badRequest('Choose a known approval type.', { type: 'Unknown type' });
  if (!input.levels.length) throw badRequest('Add at least one approval level.', { levels: 'Add a level' });
  const lv = [...input.levels].sort((a, b) => a.level - b.level);
  lv.forEach((l, i) => {
    if (l.level !== i + 1) throw badRequest('Levels must be numbered 1, 2, 3 … without gaps.', { levels: 'Renumber the levels' });
    if (!l.roles.length) throw badRequest(`Level ${l.level} needs at least one approver role.`, { levels: 'Choose a role' });
    for (const r of l.roles) if (!APPROVER_ROLES.includes(r as Role)) throw badRequest(`${ROLES[r as Role] ?? r} cannot approve. SAP/IT, administrators, buyers and requisitioners never hold approval steps.`, { levels: 'Role cannot approve' });
    if (new Set(l.roles).size !== l.roles.length) throw badRequest(`Level ${l.level} lists a role twice.`);
  });
  const c = input.conditions ?? {};
  const min = c.min_value ?? null;
  const max = c.max_value ?? null;
  if (min != null && min < 0) throw badRequest('Minimum value cannot be negative.', { min_value: 'Must be 0 or more' });
  if (min != null && max != null && min > max) throw badRequest('Minimum value must not be more than the maximum value.', { max_value: 'Must be ≥ minimum' });
  if (!/^\d{4}-\d{2}-\d{2}/.test(input.effective_from)) throw badRequest('Enter the effective date.', { effective_from: 'Required' });
  const eff = input.effective_from.length === 10 ? new Date(`${input.effective_from}T00:00:00+05:30`).toISOString() : new Date(input.effective_from).toISOString();
  const replaces = input.replaces_id ? get<{ id: number; type: string; version: number; active: number; name: string }>('SELECT id, type, version, active, name FROM approval_matrix WHERE id = ?', input.replaces_id) : undefined;
  if (input.replaces_id && (!replaces || replaces.type !== input.type)) throw badRequest('The row being replaced is not of this approval type.');
  return tx(() => {
    const version = (scalar<number>('SELECT MAX(version) FROM approval_matrix WHERE type = ?', input.type) ?? 0) + 1;
    const conditions: Record<string, unknown> = {};
    if (min != null) conditions.min_value = min;
    if (max != null) conditions.max_value = max;
    if (c.urgency?.length) conditions.urgency = c.urgency;
    if (c.category?.length) conditions.category = c.category;
    const levels = lv.map((l) => ({ level: l.level, roles: l.roles, ...(l.label?.trim() ? { label: l.label.trim() } : {}) }));
    const id = insert('approval_matrix', {
      version, type: input.type, name: input.name.trim(), conditions_json: J(conditions), levels_json: J(levels), effective_from: eff, active: 1,
      created_by: actor.id, created_at: now(), note: input.note?.trim() || 'Placeholder pending DEC-13 — values entered by the administrator until Equipcare approves the matrix.',
    });
    // The replaced row stops applying immediately when the new version is already effective; otherwise the new
    // version (higher number) takes precedence from its effective date and the old row stays as the current rule.
    if (replaces && replaces.active && eff <= now()) {
      update('approval_matrix', replaces.id, { active: 0 });
      audit(actor, { action: 'approval_matrix.superseded', objectType: 'approval_matrix', objectId: replaces.id, objectRef: `${replaces.type} v${replaces.version}`, after: { superseded_by_version: version } });
    }
    audit(actor, { action: 'approval_matrix.version_created', objectType: 'approval_matrix', objectId: id, objectRef: `${input.type} v${version}`, before: replaces ? { replaces: `${replaces.name} v${replaces.version}` } : undefined, after: { name: input.name, conditions, levels, effective_from: eff }, reason: input.note ?? null });
    return get('SELECT * FROM approval_matrix WHERE id = ?', id);
  });
}

export function deactivateMatrix(actor: Actor, id: number, reason: string) {
  const r = get<{ id: number; type: string; version: number; active: number; name: string }>('SELECT id, type, version, active, name FROM approval_matrix WHERE id = ?', id);
  if (!r) throw notFound('Matrix row');
  if (!r.active) throw conflict('This matrix row is already inactive.');
  update('approval_matrix', id, { active: 0 });
  const left = scalar<number>('SELECT COUNT(*) FROM approval_matrix WHERE type = ? AND active = 1', r.type) ?? 0;
  audit(actor, { action: 'approval_matrix.deactivated', objectType: 'approval_matrix', objectId: id, objectRef: `${r.type} v${r.version}`, before: { active: 1 }, after: { active: 0, remaining_active_rows: left }, reason });
  return { ok: true, remaining_active_rows: left, message: left ? undefined : `No active rule remains for ${typeLabel(r.type)}; new requests fall back to the Procurement Manager.` };
}

// ------------------------------------------------------------------ delegation (FR-APR-06)
export function delegation(actor: Actor) {
  const me = get<{ delegate_id: number | null; delegate_until: string | null }>('SELECT delegate_id, delegate_until FROM users WHERE id = ?', actor.id)!;
  const active = !!me.delegate_id && !!me.delegate_until && me.delegate_until >= now();
  const del = me.delegate_id ? get<{ id: number; name: string; title: string | null }>('SELECT id, name, title FROM users WHERE id = ?', me.delegate_id) : null;
  const incoming = all<{ id: number; name: string; roles: string; delegate_until: string }>('SELECT id, name, roles, delegate_until FROM users WHERE delegate_id = ? AND delegate_until >= ?', actor.id, now());
  const candidates = all<{ id: number; name: string; title: string | null; roles: string }>("SELECT id, name, title, roles FROM users WHERE active = 1 AND vendor_id IS NULL AND id != ? ORDER BY name", actor.id)
    .filter((u) => u.roles.split(',').some((r) => APPROVER_ROLES.includes(r as Role)));
  const canDelegate = actor.roles.some((r) => APPROVER_ROLES.includes(r));
  return {
    can_delegate: canDelegate, active, delegate: del, until: me.delegate_until, expired: !!me.delegate_id && !active,
    incoming: incoming.map((i) => ({ ...i, roles: i.roles.split(',').filter((r) => APPROVER_ROLES.includes(r as Role)).map((r) => ROLES[r as Role]) })),
    candidates: candidates.map((c) => ({ id: c.id, name: c.name, title: c.title, roles: c.roles.split(',').map((r) => ROLES[r as Role] ?? r).join(', ') })),
  };
}

export function setDelegation(actor: Actor, delegateId: number, until: string, reason: string | null) {
  if (!actor.roles.some((r) => APPROVER_ROLES.includes(r))) throw forbidden('Only approvers can delegate approvals.');
  if (delegateId === actor.id) throw badRequest('Choose someone other than yourself.', { delegate_id: 'Choose another person' });
  const d = get<{ id: number; name: string; roles: string; active: number; vendor_id: number | null }>('SELECT id, name, roles, active, vendor_id FROM users WHERE id = ?', delegateId);
  if (!d || !d.active || d.vendor_id) throw badRequest('Choose an active internal user.', { delegate_id: 'Not available' });
  if (!d.roles.split(',').some((r) => APPROVER_ROLES.includes(r as Role))) throw badRequest(`${d.name} does not hold an approver role and could not act on your requests.`, { delegate_id: 'Not an approver' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw badRequest('Enter the last day of the delegation.', { until: 'Required' });
  const end = new Date(`${until}T23:59:59+05:30`).toISOString();
  if (end <= now()) throw badRequest('The end date must be today or later.', { until: 'Must be in the future' });
  if (new Date(end).getTime() - Date.now() > 92 * 86400000) throw badRequest('Delegation can last at most 90 days. Set a nearer end date.', { until: 'Too far ahead' });
  const before = get<{ delegate_id: number | null; delegate_until: string | null }>('SELECT delegate_id, delegate_until FROM users WHERE id = ?', actor.id);
  update('users', actor.id, { delegate_id: delegateId, delegate_until: end });
  audit(actor, { action: 'user.delegation_set', objectType: 'user', objectId: actor.id, objectRef: actor.name, before, after: { delegate_id: delegateId, delegate: d.name, delegate_until: end }, reason });
  return delegation(actor);
}

export function clearDelegation(actor: Actor) {
  const before = get<{ delegate_id: number | null; delegate_until: string | null }>('SELECT delegate_id, delegate_until FROM users WHERE id = ?', actor.id);
  if (!before?.delegate_id) throw conflict('You have no delegation to end.');
  run('UPDATE users SET delegate_id = NULL, delegate_until = NULL WHERE id = ?', actor.id);
  audit(actor, { action: 'user.delegation_ended', objectType: 'user', objectId: actor.id, objectRef: actor.name, before, after: { delegate_id: null } });
  return delegation(actor);
}
