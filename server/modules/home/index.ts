/**
 * Role home (SCR-PLT-01): task counts and "next actions" for each of the nine roles.
 * Reads across module tables using the canonical statuses in core/statuses.ts.
 */
import { Router } from 'express';
import type { ModuleDef } from '../types.ts';
import { all, get, now } from '../../core/db.ts';
import { h } from '../../core/http.ts';
import { requireAuth, actorOf, type Actor } from '../../core/auth.ts';
import { freshness } from '../../core/sap.ts';
import { OPEN_STATUSES } from '../pr/service.ts';
import { APPROVER_STEP_ROLES } from '../../core/permissions.ts';

interface Tile { key: string; label: string; value: number | string; meta?: string; tone?: 'ok' | 'warn' | 'bad'; link?: string }
interface Task { title: string; subtitle?: string; link: string; tone?: 'ok' | 'warn' | 'bad' | 'info' | 'decision'; tag?: string; due?: string | null }

const n = (sql: string, ...p: unknown[]) => Number(get<{ n: number }>(sql, ...p)?.n ?? 0);
const inList = (xs: readonly string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(',');
const OPEN = inList(OPEN_STATUSES);
const today = () => now().slice(0, 10);
const plus = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const plantFilter = (a: Actor, col: string) => (a.plants === '*' ? '' : `AND ${col} IN (${inList(a.plants)})`);

function approvalsWaiting(a: Actor) {
  // The merged Administrator holds every approver role.
  const roles: string[] = a.merged ? [...APPROVER_STEP_ROLES] : [a.role];
  return all<{ id: number; req_no: string; title: string; type: string; value: number | null; created_at: string }>(
    `SELECT DISTINCT ap.id, ap.req_no, ap.title, ap.type, ap.value, ap.created_at FROM approvals ap JOIN approval_steps s ON s.approval_id = ap.id
     WHERE ap.status = 'Pending' AND s.status = 'Pending' AND s.approver_role IN (${roles.map(() => '?').join(',')}) AND s.level = ap.current_level AND ap.requester_id != ?
       AND COALESCE(json_extract(ap.context_json, '$.recommended_by'), 0) != ? ORDER BY ap.created_at LIMIT 8`,
    ...roles, a.id, a.id,
  );
}
const approvalTasks = (a: Actor): Task[] => approvalsWaiting(a).map((x) => ({ title: x.title, subtitle: `${x.req_no} · waiting since ${x.created_at.slice(0, 10)}`, link: `/approvals/${x.id}`, tone: 'decision', tag: 'Approve' }));

function requisitioner(a: Actor) {
  const mine = `requisitioner_id = ${a.id}`;
  const tiles: Tile[] = [
    { key: 'open', label: 'Requirements in progress', value: n(`SELECT COUNT(*) n FROM pr_lines WHERE ${mine} AND status IN (${OPEN})`), link: '/my-requirements' },
    { key: 'nobuyer', label: 'Waiting for a buyer', value: n(`SELECT COUNT(*) n FROM pr_lines WHERE ${mine} AND status IN ('Synced','Unassigned')`), link: '/my-requirements' },
    { key: 'po', label: 'PO raised, not yet received', value: n(`SELECT COUNT(*) n FROM pr_lines l JOIN po_lines pl ON pl.pr_line_id = l.id WHERE l.${mine} AND pl.status NOT IN ('Received','Closed','Cancelled')`), link: '/my-requirements' },
    { key: 'late', label: 'Delayed by vendor', value: n(`SELECT COUNT(*) n FROM pr_lines l JOIN po_lines pl ON pl.pr_line_id = l.id WHERE l.${mine} AND pl.status NOT IN ('Received','Closed','Cancelled') AND (pl.delay_reason IS NOT NULL OR COALESCE(pl.commit_date, pl.delivery_date) < '${today()}')`), link: '/my-requirements' },
  ];
  tiles[3].tone = Number(tiles[3].value) ? 'bad' : undefined;
  const tasks: Task[] = all<{ id: number; pr_no: string; item: number; description: string; status: string }>(
    `SELECT id, pr_no, item, description, status FROM pr_lines WHERE ${mine} AND status = 'Clarification pending'`,
  ).map((l) => ({ title: `Procurement asked about ${l.description}`, subtitle: `${l.pr_no}/${l.item} · reply to keep it moving`, link: `/my-requirements?focus=${l.id}`, tone: 'warn', tag: 'Reply' }));
  for (const l of all<{ id: number; pr_no: string; item: number; description: string; delay_reason: string | null; commit_date: string | null }>(
    `SELECT l.id, l.pr_no, l.item, l.description, pl.delay_reason, pl.commit_date FROM pr_lines l JOIN po_lines pl ON pl.pr_line_id = l.id
     WHERE l.${mine} AND pl.status NOT IN ('Received','Closed','Cancelled') AND pl.delay_reason IS NOT NULL LIMIT 5`,
  )) tasks.push({ title: `${l.description} is delayed`, subtitle: `${l.delay_reason} · new commitment ${l.commit_date ?? '—'}`, link: `/my-requirements?focus=${l.id}`, tone: 'bad', tag: 'Delayed' });
  return { tiles, tasks };
}

function buyer(a: Actor) {
  const me = a.id;
  const tiles: Tile[] = [
    { key: 'review', label: 'PR lines to check or route', value: n(`SELECT COUNT(*) n FROM pr_lines WHERE buyer_id = ? AND status IN ('Assigned','Under review','Clarification pending')`, me), link: '/pr?view=mine' },
    { key: 'sla', label: 'Priority lines past SLA', value: n(`SELECT COUNT(*) n FROM pr_lines WHERE buyer_id = ? AND sla_due < ? AND status IN (${OPEN})`, me, now()), link: '/pr?view=priority' },
    { key: 'rfq', label: 'RFQs open with vendors', value: n(`SELECT COUNT(*) n FROM rfqs WHERE buyer_id = ? AND status = 'Published'`, me), link: '/rfqs' },
    { key: 'po', label: 'POs needing follow-up', value: n(`SELECT COUNT(DISTINCT p.id) n FROM pos p JOIN po_lines l ON l.po_id = p.id WHERE p.buyer_id = ? AND p.status NOT IN ('Closed','Cancelled') AND (l.ack_status IN ('Pending','Rejected','Pending re-acknowledgement') OR (l.status NOT IN ('Received','Closed','Cancelled') AND COALESCE(l.commit_date, l.delivery_date) < ?))`, me, today()), link: '/pos' },
  ];
  tiles[1].tone = Number(tiles[1].value) ? 'bad' : undefined;
  const tasks: Task[] = [];
  for (const l of all<{ id: number; pr_no: string; item: number; description: string; priority: string; sla_due: string | null; status: string }>(
    `SELECT id, pr_no, item, description, priority, sla_due, status FROM pr_lines WHERE buyer_id = ? AND priority != 'Normal' AND status IN (${OPEN}) ORDER BY sla_due LIMIT 5`, me,
  )) tasks.push({ title: `${l.priority}: ${l.description}`, subtitle: `${l.pr_no}/${l.item} · ${l.status}`, link: `/pr/${l.id}`, tone: l.sla_due && l.sla_due < now() ? 'bad' : 'warn', tag: l.priority, due: l.sla_due });
  for (const r of all<{ id: number; rfq_no: string; title: string }>("SELECT id, rfq_no, title FROM rfqs WHERE buyer_id = ? AND status = 'Closed' LIMIT 5", me)) tasks.push({ title: `Compare quotations: ${r.title ?? r.rfq_no}`, subtitle: `${r.rfq_no} closed`, link: `/comparisons/rfq/${r.id}`, tone: 'info', tag: 'Compare' });
  for (const c of all<{ id: number; cmp_no: string; rfq_id: number }>("SELECT id, cmp_no, rfq_id FROM comparisons WHERE created_by = ? AND status IN ('Returned','Approved')", me)) tasks.push({ title: `Comparison ${c.cmp_no ?? c.id} needs your next step`, subtitle: 'Returned for changes or approved for release', link: `/comparisons/${c.id}`, tone: 'decision', tag: 'Comparison' });
  for (const p of all<{ id: number; po_no: string; vendor: string; n: number }>(
    `SELECT p.id, p.po_no, v.name vendor, COUNT(*) n FROM pos p JOIN po_lines l ON l.po_id = p.id JOIN vendors v ON v.id = p.vendor_id
     WHERE p.buyer_id = ? AND l.ack_status = 'Rejected' GROUP BY p.id LIMIT 5`, me,
  )) tasks.push({ title: `${p.vendor} rejected ${p.n} line(s)`, subtitle: `PO ${p.po_no} · re-source or amend`, link: `/pos/${p.id}`, tone: 'bad', tag: 'Rejected' });
  for (const p of all<{ id: number; po_no: string; vendor: string }>(
    `SELECT DISTINCT p.id, p.po_no, v.name vendor FROM pos p JOIN po_lines l ON l.po_id = p.id JOIN vendors v ON v.id = p.vendor_id
     WHERE p.buyer_id = ? AND l.status NOT IN ('Received','Closed','Cancelled') AND COALESCE(l.commit_date, l.delivery_date) < ? LIMIT 5`, me, today(),
  )) tasks.push({ title: `Delivery overdue from ${p.vendor}`, subtitle: `PO ${p.po_no}`, link: `/pos/${p.id}`, tone: 'warn', tag: 'Overdue' });
  for (const d of all<{ id: number; dsp_no: string; type: string }>("SELECT d.id, d.dsp_no, d.type FROM disputes d JOIN pos p ON p.id = d.po_id WHERE p.buyer_id = ? AND d.owner_party IN ('Procurement','Logistics') AND d.status NOT IN ('Resolved','Closed') LIMIT 5", me)) tasks.push({ title: `${d.type} dispute assigned to procurement`, subtitle: d.dsp_no, link: `/disputes/${d.id}`, tone: 'warn', tag: 'Dispute' });
  if (a.perms.has('apr.decide')) tasks.unshift(...approvalTasks(a));
  return { tiles, tasks };
}

function manager(a: Actor) {
  const waiting = approvalsWaiting(a);
  const tiles: Tile[] = [
    { key: 'approvals', label: 'Approvals waiting for you', value: waiting.length, meta: waiting[0] ? `Oldest since ${waiting[0].created_at.slice(0, 10)}` : 'Nothing waiting', link: '/approvals', tone: waiting.length ? 'warn' : undefined },
    { key: 'unassigned', label: 'Unassigned PR lines', value: n("SELECT COUNT(*) n FROM pr_lines WHERE status = 'Unassigned'"), link: '/pr?view=unassigned' },
    { key: 'exceptions', label: 'Exceptions this month', value: n("SELECT COUNT(*) n FROM approvals WHERE category = 'exception' AND created_at >= ?", now().slice(0, 7) + '-01'), link: '/exceptions' },
    { key: 'expiring', label: 'Contracts expiring', value: n("SELECT COUNT(*) n FROM contracts WHERE status = 'Expiring'"), link: '/contracts/renewals' },
  ];
  tiles[1].tone = Number(tiles[1].value) ? 'warn' : undefined;
  const tasks: Task[] = approvalTasks(a);
  for (const l of all<{ id: number; pr_no: string; item: number; description: string }>("SELECT id, pr_no, item, description FROM pr_lines WHERE status = 'Unassigned' LIMIT 5")) tasks.push({ title: `Assign a buyer: ${l.description}`, subtitle: `${l.pr_no}/${l.item} — no buyer-matrix row`, link: `/pr/${l.id}`, tone: 'warn', tag: 'Assign' });
  for (const c of all<{ id: number; contract_no: string; title: string; valid_to: string }>("SELECT id, contract_no, title, valid_to FROM contracts WHERE status = 'Expiring' LIMIT 5")) tasks.push({ title: `Renewal due: ${c.title ?? c.contract_no}`, subtitle: `Valid to ${c.valid_to}`, link: `/contracts/${c.id}`, tone: 'warn', tag: 'Renewal' });
  return { tiles, tasks, chart: 'pr-ageing' };
}

function stores(a: Actor) {
  const pf = plantFilter(a, 'a.plant');
  const tiles: Tile[] = [
    { key: 'today', label: 'Deliveries expected today', value: n(`SELECT COUNT(*) n FROM asns a WHERE a.status IN ('Submitted','In transit') AND a.expected_date <= ? ${pf}`, today()), link: '/receipts' },
    { key: 'week', label: 'Expected in the next 7 days', value: n(`SELECT COUNT(*) n FROM asns a WHERE a.status IN ('Submitted','In transit') AND a.expected_date <= ? ${pf}`, plus(7)), link: '/receipts' },
    { key: 'overdue', label: 'PO lines overdue at your plants', value: n(`SELECT COUNT(*) n FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE l.status NOT IN ('Received','Closed','Cancelled') AND COALESCE(l.commit_date, l.delivery_date) < ? ${plantFilter(a, 'p.plant')}`, today()), link: '/pos' },
    { key: 'disputes', label: 'Open receipt disputes', value: n(`SELECT COUNT(*) n FROM disputes d JOIN pos p ON p.id = d.po_id WHERE d.status NOT IN ('Resolved','Closed') ${plantFilter(a, 'p.plant')}`), link: '/disputes' },
  ];
  tiles[2].tone = Number(tiles[2].value) ? 'warn' : undefined;
  const tasks: Task[] = all<{ id: number; asn_no: string; vendor: string; expected_date: string; plant: string }>(
    `SELECT a.id, a.asn_no, v.name vendor, a.expected_date, a.plant FROM asns a JOIN vendors v ON v.id = a.vendor_id WHERE a.status IN ('Submitted','In transit') ${pf} ORDER BY a.expected_date LIMIT 8`,
  ).map((x) => ({ title: `${x.vendor} delivery`, subtitle: `${x.asn_no} · ${x.plant} · expected ${x.expected_date}`, link: `/asns/${x.id}`, tone: x.expected_date < today() ? 'bad' : 'info', tag: x.expected_date <= today() ? 'Due' : 'Upcoming', due: x.expected_date }));
  for (const d of all<{ id: number; dsp_no: string; type: string }>(`SELECT d.id, d.dsp_no, d.type FROM disputes d JOIN pos p ON p.id = d.po_id WHERE d.owner_party = 'Stores' AND d.status NOT IN ('Resolved','Closed') ${plantFilter(a, 'p.plant')} LIMIT 5`)) tasks.push({ title: `${d.type} dispute owned by stores`, subtitle: d.dsp_no, link: `/disputes/${d.id}`, tone: 'warn', tag: 'Dispute' });
  return { tiles, tasks };
}

function finance(a: Actor) {
  const tiles: Tile[] = [
    { key: 'exceptions', label: 'Invoice exceptions', value: n("SELECT COUNT(*) n FROM invoices WHERE status = 'Exception'"), link: '/invoices/exceptions' },
    { key: 'approve', label: 'Matched, waiting for approval', value: n("SELECT COUNT(*) n FROM invoices WHERE status = 'Matched' AND approved_by IS NULL"), link: '/invoices' },
    { key: 'due', label: 'Payments due in 7 days', value: n("SELECT COUNT(*) n FROM invoices WHERE status IN ('Posted','Payment due') AND due_date <= ?", plus(7)), link: '/payments' },
    { key: 'advances', label: 'Advances outstanding', value: n("SELECT COUNT(*) n FROM advances WHERE status IN ('Paid','Partially adjusted')"), link: '/payments' },
  ];
  tiles[0].tone = Number(tiles[0].value) ? 'warn' : undefined;
  const tasks: Task[] = approvalTasks(a);
  for (const i of all<{ id: number; inv_ref: string; vendor: string; sub_reason: string | null }>("SELECT i.id, i.inv_ref, v.name vendor, i.sub_reason FROM invoices i JOIN vendors v ON v.id = i.vendor_id WHERE i.status = 'Exception' ORDER BY i.created_at LIMIT 6")) tasks.push({ title: `Resolve exception: ${i.vendor}`, subtitle: `${i.inv_ref}${i.sub_reason ? ' · ' + i.sub_reason : ''}`, link: `/invoices/${i.id}`, tone: 'bad', tag: 'Exception' });
  for (const i of all<{ id: number; inv_ref: string; vendor: string }>("SELECT i.id, i.inv_ref, v.name vendor FROM invoices i JOIN vendors v ON v.id = i.vendor_id WHERE i.status = 'Matched' AND i.approved_by IS NULL LIMIT 5")) tasks.push({ title: `Approve for posting: ${i.vendor}`, subtitle: i.inv_ref, link: `/invoices/${i.id}`, tone: 'decision', tag: 'Approve' });
  return { tiles, tasks };
}

function sapIt() {
  const f = freshness();
  const tiles: Tile[] = [
    { key: 'errors', label: 'Open integration errors', value: n("SELECT COUNT(*) n FROM integration_errors WHERE status IN ('Queued','Retrying','Failed')"), link: '/integration/errors' },
    { key: 'stale', label: 'Flows past freshness', value: f.filter((x) => x.stale).length, meta: `of ${f.length} inbound flows`, link: '/integration' },
    { key: 'queued', label: 'Writes queued for retry', value: n("SELECT COUNT(*) n FROM integration_errors WHERE status = 'Retrying'"), link: '/integration/errors' },
    { key: 'jobs', label: 'Failed job runs (24 h)', value: n("SELECT COUNT(*) n FROM job_runs WHERE status = 'Failed' AND started_at >= ?", new Date(Date.now() - 86400000).toISOString()), link: '/admin/jobs' },
  ];
  tiles[0].tone = Number(tiles[0].value) ? 'bad' : 'ok';
  tiles[1].tone = Number(tiles[1].value) ? 'warn' : 'ok';
  const tasks: Task[] = all<{ id: number; flow: string; error: string; error_type: string }>("SELECT id, flow, error, error_type FROM integration_errors WHERE status IN ('Queued','Retrying','Failed') ORDER BY id DESC LIMIT 8")
    .map((e) => ({ title: `${e.flow}: ${e.error}`, subtitle: `${e.error_type} error`, link: '/integration/errors', tone: e.error_type === 'business' ? 'bad' : 'warn', tag: e.error_type === 'business' ? 'Business' : 'Transient' }));
  for (const x of f.filter((y) => y.stale)) tasks.push({ title: `${x.id} ${x.name} is stale`, subtitle: `Last success ${x.lastSuccess ?? 'never'}`, link: '/integration', tone: 'warn', tag: 'Stale' });
  return { tiles, tasks };
}

function management(a: Actor) {
  const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const total = get<{ v: number }>('SELECT COALESCE(SUM(l.qty * l.unit_price), 0) v FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE p.po_date >= ?', since)!.v;
  const covered = get<{ v: number }>('SELECT COALESCE(SUM(l.qty * l.unit_price), 0) v FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE p.po_date >= ? AND p.contract_id IS NOT NULL', since)!.v;
  const inv = n("SELECT COUNT(*) n FROM invoices WHERE status != 'Rejected'");
  const invExc = n("SELECT COUNT(DISTINCT invoice_id) n FROM invoice_exceptions");
  const tiles: Tile[] = [
    { key: 'open', label: 'Open PR lines', value: n(`SELECT COUNT(*) n FROM pr_lines WHERE status IN (${OPEN})`), meta: `${n(`SELECT COUNT(*) n FROM pr_lines WHERE status IN (${OPEN}) AND available_at < ?`, new Date(Date.now() - 7 * 86400000).toISOString())} older than 7 days`, link: '/reports/rpt-01' },
    { key: 'coverage', label: 'Contract coverage (12 months)', value: total ? `${Math.round((covered / total) * 100)}%` : '—', meta: 'PO value under ARC/OA/FDS/VMI · KPI-08', link: '/reports/rpt-07' },
    { key: 'overdue', label: 'Overdue PO lines', value: n("SELECT COUNT(*) n FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE l.status NOT IN ('Received','Closed','Cancelled') AND COALESCE(l.commit_date, l.delivery_date) < ?", today()), link: '/reports/rpt-04' },
    { key: 'invexc', label: 'Invoices with exceptions', value: inv ? `${Math.round((invExc / inv) * 100)}%` : '—', meta: `${invExc} of ${inv} invoices · KPI-11`, link: '/reports/rpt-09' },
  ];
  tiles[2].tone = Number(tiles[2].value) ? 'warn' : undefined;
  const tasks: Task[] = approvalTasks(a);
  for (const e of all<{ id: number; req_no: string; title: string; status: string }>("SELECT id, req_no, title, status FROM approvals WHERE category = 'exception' ORDER BY id DESC LIMIT 5")) tasks.push({ title: e.title, subtitle: `${e.req_no} · ${e.status}`, link: `/approvals/${e.id}`, tone: 'decision', tag: 'Exception' });
  return { tiles, tasks, chart: 'pr-ageing' };
}

function admin() {
  const tiles: Tile[] = [
    { key: 'users', label: 'Active users', value: n('SELECT COUNT(*) n FROM users WHERE active = 1'), meta: `${n('SELECT COUNT(*) n FROM users WHERE vendor_id IS NOT NULL AND active = 1')} vendor users`, link: '/admin/users' },
    { key: 'locked', label: 'Locked accounts', value: n('SELECT COUNT(*) n FROM users WHERE locked = 1'), link: '/admin/users', tone: n('SELECT COUNT(*) n FROM users WHERE locked = 1') ? 'warn' : undefined },
    { key: 'config', label: 'Rule changes pending approval', value: n("SELECT COUNT(*) n FROM config_history WHERE status = 'Pending'"), link: '/admin/config' },
    { key: 'outbox', label: 'Messages in simulated outbox', value: n('SELECT COUNT(*) n FROM outbox'), meta: 'Not delivered — no provider connected', link: '/admin/outbox' },
  ];
  const tasks: Task[] = all<{ id: number; name: string; email: string }>('SELECT id, name, email FROM users WHERE locked = 1 LIMIT 5').map((u) => ({ title: `Unlock ${u.name}?`, subtitle: `${u.email} locked after failed sign-ins`, link: '/admin/users', tone: 'warn', tag: 'Locked' }));
  for (const t of all<{ id: number; tkt_no: string; subject: string }>("SELECT id, tkt_no, subject FROM tickets WHERE assignee_role = 'ADM' AND status IN ('Open','In progress') LIMIT 5")) tasks.push({ title: t.subject, subtitle: t.tkt_no, link: `/tickets/${t.id}`, tone: 'info', tag: 'Ticket' });
  return { tiles, tasks };
}

/** Single-user Administrator: one dashboard drawing on every module, most urgent work first. */
export function administrator(a: Actor, limit = 14) {
  const mgr = manager(a), buy = buyer(a), fin = finance(a), sto = stores(a), sap = sapIt();
  const tiles: Tile[] = [mgr.tiles[0], mgr.tiles[1], buy.tiles[0], buy.tiles[3], fin.tiles[0], sto.tiles[0], sto.tiles[3], sap.tiles[0]];
  const seen = new Set<string>();
  const tasks = [...mgr.tasks, ...buy.tasks, ...fin.tasks, ...sto.tasks, ...sap.tasks]
    .filter((t) => (seen.has(t.link + t.title) ? false : (seen.add(t.link + t.title), true)))
    .sort((x, y) => ['bad', 'decision', 'warn', 'info', 'ok'].indexOf(x.tone ?? 'info') - ['bad', 'decision', 'warn', 'info', 'ok'].indexOf(y.tone ?? 'info'))
    .slice(0, limit);
  return { tiles, tasks, chart: 'pr-ageing' };
}

const router = Router();
router.get('/', requireAuth, h((req) => {
  const a = actorOf(req);
  if (a.merged) return { role: a.role, ...administrator(a) };
  const byRole: Record<string, () => { tiles: Tile[]; tasks: Task[]; chart?: string }> = {
    REQ: () => requisitioner(a), BUY: () => buyer(a), APR: () => manager(a), STO: () => stores(a), FIN: () => finance(a),
    SAP: () => sapIt(), MGT: () => management(a), ADM: () => admin(),
  };
  const fn = byRole[a.role];
  if (!fn) return { role: a.role, tiles: [], tasks: [] };
  return { role: a.role, ...fn() };
}));

export const module: ModuleDef = { path: 'home', router };
