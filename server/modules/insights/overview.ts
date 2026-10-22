/**
 * Data for the new home (Act now / At risk / Ask) and for the three workspaces (Sourcing, Delivery, Finance).
 * Everything is read from platform tables that mirror SAP; nothing here writes.
 */
import { all, get, now } from '../../core/db.ts';
import type { Actor } from '../../core/auth.ts';
import { cfg } from '../../core/config.ts';
import { APPROVER_STEP_ROLES } from '../../core/permissions.ts';
import { aiStatus } from '../../core/ai.ts';
import { OPEN_STATUSES } from '../pr/service.ts';
import { computeKpis, type KpiResult } from '../reports/kpis.ts';
import { administrator } from '../home/index.ts';
import { poLineRisks, type LineRisk } from './risk.ts';

const n = (sql: string, ...p: unknown[]) => Number(get<{ n: number }>(sql, ...p)?.n ?? 0);
const inList = (xs: readonly string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(',');
const iso = (d = 0) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const daysAgo = (ts: string) => Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 86400000));
const day = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—');

export type WorkspaceKey = 'sourcing' | 'delivery' | 'finance';
export const WORKSPACES: WorkspaceKey[] = ['sourcing', 'delivery', 'finance'];
const PREFIXES: Record<WorkspaceKey, string[]> = {
  sourcing: ['/pr', '/rfqs', '/comparisons', '/approvals', '/contracts', '/vendors'],
  delivery: ['/pos', '/asns', '/disputes', '/tickets', '/receipts'],
  finance: ['/invoices', '/payments', '/advances'],
};
const inWorkspace = (key: WorkspaceKey, link: string) => PREFIXES[key].some((p) => link === p || link.startsWith(`${p}/`) || link.startsWith(`${p}?`));

export interface Attention {
  title: string; subtitle?: string; link: string; tone?: 'ok' | 'warn' | 'bad' | 'info' | 'decision'; tag?: string; due?: string | null;
  /** What to do next, from the rules. */
  hint: string | null;
}

/** One line of "what to do next" per kind of work item. Rules only. */
function hintFor(t: { tag?: string; link: string }): string | null {
  const l = t.link;
  if (l.startsWith('/approvals')) return t.tag === 'Exception'
    ? 'Read the justification and the policy deviation, then approve, return or reject with a reason.'
    : 'Open it, read the request and its justification, then decide. A request you raised yourself cannot be approved by you.';
  if (l.startsWith('/invoices')) return t.tag === 'Approve' ? 'Matched cleanly. Check the match summary and approve it for posting.' : 'Open the invoice for a plain explanation and the recommended next step.';
  if (l.startsWith('/comparisons')) return 'Quotes are in. Open the comparison to see landed cost and record the award recommendation.';
  if (l.startsWith('/pos')) return t.tag === 'Rejected' ? 'The vendor rejected lines. Re-source them or amend the PO.' : 'Open the PO. The risk card suggests a reminder, a call or an escalation.';
  if (l.startsWith('/disputes')) return 'Check the owner and ageing, then chase the owner or close it with the outcome.';
  if (l.startsWith('/asns')) return 'Check the delivery against the ASN when it arrives and record any difference as a receipt dispute.';
  if (l.startsWith('/contracts')) return 'Decide to renew, extend or let it expire before the renewal window closes.';
  if (l.startsWith('/pr')) return t.tag === 'Assign' ? 'No buyer matches this line. Assign one, or add a row to the buyer matrix.' : 'Check stock, open POs and contracts, then pick the sourcing route.';
  if (l.startsWith('/integration')) return 'Open the error, fix the cause in SAP or the data, then retry.';
  return null;
}

// ------------------------------------------------------------------ at risk
export interface RiskItem {
  kind: 'po_delivery' | 'invoice_held' | 'payment' | 'rfq_response' | 'contract';
  severity: 'High' | 'Medium';
  title: string; why: string[]; link: string; score: number;
  /** One-click action the PO risk card also offers; absent for items that only link out. */
  action?: { type: 'remind'; po_id: number; line_id: number; reminder: string; label: string };
  /** The recommended next step in words, including the ones that are not one-click (call, escalate). */
  next?: string;
  subtitle?: string;
}

/** POs whose suggestion was dismissed in the last 24 hours stay out of the lists for the rest of the day. */
function snoozedPos() {
  return new Set(all<{ object_id: number }>("SELECT object_id FROM ai_suggestions WHERE kind = 'po_reminder' AND decision = 'Dismissed' AND decided_at >= ?", new Date(Date.now() - 86400000).toISOString()).map((r) => r.object_id));
}

function poRisks(all_: LineRisk[]): RiskItem[] {
  const seen = snoozedPos();
  const out: RiskItem[] = [];
  for (const r of all_) {
    if (r.band === 'Low' || seen.has(r.po_id)) continue;
    seen.add(r.po_id);
    const more = all_.filter((x) => x.po_id === r.po_id && x.line_id !== r.line_id && x.band !== 'Low').length;
    out.push({
      kind: 'po_delivery', severity: r.band === 'High' ? 'High' : 'Medium', score: r.score, link: r.link,
      title: `${r.vendor} may miss delivery on PO ${r.po_no}`,
      subtitle: `${r.description}${more ? ` and ${more} more line${more === 1 ? '' : 's'}` : ''}`,
      why: r.factors.slice(0, 3).map((f) => f.label),
      next: r.action.type === 'monitor' ? undefined : `${r.action.label}. ${r.action.why}`,
      action: r.action.type === 'remind' && r.action.reminder ? { type: 'remind', po_id: r.po_id, line_id: r.line_id, reminder: r.action.reminder, label: r.action.label } : undefined,
    });
  }
  return out;
}

function otherRisks(): RiskItem[] {
  const out: RiskItem[] = [];
  const ageing = Number(cfg<number>('inv.exception_ageing_days') ?? 3);
  for (const i of all<{ id: number; no: string | null; inv_ref: string; vendor: string; reason: string | null; created_at: string; total: number | null }>(
    `SELECT i.id, i.vendor_invoice_no no, i.inv_ref, v.name vendor, i.sub_reason reason, i.created_at, i.total_value total FROM invoices i JOIN vendors v ON v.id = i.vendor_id WHERE i.status = 'Exception' ORDER BY i.created_at LIMIT 40`,
  )) {
    const age = daysAgo(i.created_at);
    if (age < ageing) continue;
    out.push({ kind: 'invoice_held', severity: age >= ageing * 2 ? 'High' : 'Medium', score: Math.min(80, 30 + age * 3), link: `/invoices/${i.id}`, title: `${i.vendor}: invoice ${i.no ?? i.inv_ref} has been held ${age} days`, why: [i.reason ?? 'Open exception', 'The vendor will chase payment until it is resolved'] });
  }
  for (const i of all<{ id: number; no: string | null; inv_ref: string; vendor: string; status: string; due_date: string }>(
    `SELECT i.id, i.vendor_invoice_no no, i.inv_ref, v.name vendor, i.status, i.due_date FROM invoices i JOIN vendors v ON v.id = i.vendor_id
     WHERE i.due_date IS NOT NULL AND ((i.status = 'Payment blocked' AND i.due_date <= ?) OR (i.status = 'Payment due' AND i.due_date < ?)) ORDER BY i.due_date LIMIT 20`, iso(7), iso(),
  )) {
    const late = i.due_date < iso();
    out.push({ kind: 'payment', severity: late || i.status === 'Payment blocked' ? 'High' : 'Medium', score: late ? 80 : 65, link: `/invoices/${i.id}`, title: `${i.vendor}: invoice ${i.no ?? i.inv_ref} ${late ? 'is past its payment date' : 'is due soon but blocked'}`, why: [`Due ${day(i.due_date)}`, i.status === 'Payment blocked' ? 'Payment is blocked in SAP' : 'Not yet released in SAP'] });
  }
  for (const r of all<{ id: number; rfq_no: string; title: string | null; closing_at: string; invited: number; quoted: number }>(
    `SELECT r.id, r.rfq_no, r.title, r.closing_at,
            (SELECT COUNT(*) FROM rfq_invitations i WHERE i.rfq_id = r.id) invited,
            (SELECT COUNT(*) FROM quotations q WHERE q.rfq_id = r.id AND q.submitted_at IS NOT NULL AND q.status NOT IN ('Draft','Not started','Declined')) quoted
     FROM rfqs r WHERE r.status = 'Published' AND r.closing_at <= ? ORDER BY r.closing_at`, new Date(Date.now() + 3 * 86400000).toISOString(),
  )) {
    if (!r.invited || r.quoted / r.invited >= 0.5) continue;
    out.push({ kind: 'rfq_response', severity: r.quoted === 0 ? 'High' : 'Medium', score: r.quoted === 0 ? 70 : 50, link: `/rfqs/${r.id}`, title: `${r.title ?? r.rfq_no} closes ${day(r.closing_at)} with low response`, why: [`${r.quoted} of ${r.invited} invited vendors have quoted`, 'Chase the non-responders or extend the closing date'] });
  }
  for (const c of all<{ id: number; contract_no: string; title: string | null; valid_to: string; vendor: string }>(
    `SELECT c.id, c.contract_no, c.title, c.valid_to, v.name vendor FROM contracts c JOIN vendors v ON v.id = c.vendor_id WHERE c.status IN ('Active','Expiring') AND c.valid_to <= ? ORDER BY c.valid_to LIMIT 10`, iso(30),
  )) {
    const bought = n('SELECT COUNT(*) n FROM pos WHERE contract_id = ? AND po_date >= ?', c.id, iso(-365));
    out.push({ kind: 'contract', severity: c.valid_to <= iso(14) ? 'High' : 'Medium', score: c.valid_to <= iso(14) ? 55 : 40, link: `/contracts/${c.id}`, title: `${c.vendor}: ${c.title ?? c.contract_no} ends ${day(c.valid_to)}`, why: [bought ? `${bought} PO${bought === 1 ? '' : 's'} were raised on it in the last 12 months` : 'No POs on it in the last 12 months', 'Spot buying starts when it lapses'] });
  }
  return out;
}

/** Take the highest-scoring items round-robin across kinds, so one busy kind (say held invoices) cannot fill the list. */
function diversify(items: RiskItem[], n: number): RiskItem[] {
  const by = new Map<string, RiskItem[]>();
  for (const i of items) by.set(i.kind, [...(by.get(i.kind) ?? []), i]);
  const out: RiskItem[] = [];
  while (out.length < n && [...by.values()].some((l) => l.length)) {
    for (const l of [...by.values()].sort((a, b) => (b[0]?.score ?? 0) - (a[0]?.score ?? 0))) {
      const next = l.shift();
      if (next && out.length < n) out.push(next);
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------------------ KPIs
const kpiCache = new Map<string, { at: number; list: KpiResult[] }>();
function kpis(actor: Actor): KpiResult[] {
  const hit = kpiCache.get(String(actor.id));
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  const list = computeKpis(actor, iso(-90), iso());
  kpiCache.set(String(actor.id), { at: Date.now(), list });
  return list;
}
const KPI_IDS: Record<'home' | WorkspaceKey, string[]> = {
  home: ['KPI-02', 'KPI-07', 'KPI-08', 'KPI-11'],
  sourcing: ['KPI-02', 'KPI-03', 'KPI-08'],
  delivery: ['KPI-06', 'KPI-07', 'KPI-12'],
  finance: ['KPI-11', 'KPI-10', 'KPI-15'],
};
function kpiCards(actor: Actor, key: 'home' | WorkspaceKey) {
  const all_ = kpis(actor);
  return KPI_IDS[key].map((id) => all_.find((k) => k.id === id)).filter((k): k is KpiResult => !!k)
    .map((k) => ({ id: k.id, name: k.name, unit: k.unit, value: k.value, n: k.n, note: k.note ?? null, link: `/reports?kpi=${k.id}` }));
}

// ------------------------------------------------------------------ home
export function overview(actor: Actor) {
  const feed = administrator(actor, 40);
  const act: Attention[] = feed.tasks.map((t) => ({ ...t, hint: hintFor(t) }));
  const risks = poLineRisks();
  const atRisk = [...poRisks(risks), ...otherRisks()].sort((a, b) => b.score - a.score);
  return {
    act: act.slice(0, 8), actTotal: act.length, tiles: feed.tiles,
    atRisk: diversify(atRisk, 8), atRiskTotal: atRisk.length,
    kpis: kpiCards(actor, 'home'), ai: aiStatus(), generated_at: now(),
  };
}

// ------------------------------------------------------------------ workspaces
interface Stage { key: string; label: string; count: number; hint?: string; link: string; tone?: 'ok' | 'warn' | 'bad' }
interface Side { label: string; value: number | string; link: string; tone?: 'ok' | 'warn' | 'bad' }

const OPEN_PR = inList(OPEN_STATUSES);
const OPEN_PO = "p.status IN ('Published','Partially received')";
const LIVE_LINE = "l.status NOT IN ('Received','Closed','Cancelled')";

function stages(key: WorkspaceKey, actor: Actor): { stages: Stage[]; side: Side[] } {
  if (key === 'sourcing') {
    const unassigned = n("SELECT COUNT(*) n FROM pr_lines WHERE status = 'Unassigned'");
    const rfqRows = all<{ invited: number; quoted: number }>(
      `SELECT (SELECT COUNT(*) FROM rfq_invitations i WHERE i.rfq_id = r.id) invited,
              (SELECT COUNT(*) FROM quotations q WHERE q.rfq_id = r.id AND q.submitted_at IS NOT NULL AND q.status NOT IN ('Draft','Not started','Declined')) quoted FROM rfqs r WHERE r.status = 'Published'`);
    const low = rfqRows.filter((r) => r.invited > 0 && r.quoted / r.invited < 0.5).length;
    const roles: string[] = actor.merged ? [...APPROVER_STEP_ROLES] : [actor.role];
    const mine = n(`SELECT COUNT(DISTINCT s.approval_id) n FROM approval_steps s JOIN approvals ap ON ap.id = s.approval_id WHERE s.status = 'Pending' AND ap.status = 'Pending' AND s.level = ap.current_level AND s.approver_role IN (${roles.map(() => '?').join(',')}) AND ap.requester_id != ?`, ...roles, actor.id);
    return {
      stages: [
        { key: 'pr', label: 'Open requirements', count: n(`SELECT COUNT(*) n FROM pr_lines WHERE status IN (${OPEN_PR})`), hint: unassigned ? `${unassigned} without a buyer` : 'All have a buyer', link: '/pr', tone: unassigned ? 'warn' : undefined },
        { key: 'rfq', label: 'Out for quotes', count: rfqRows.length, hint: low ? `${low} with low response` : 'Responses on track', link: '/rfqs', tone: low ? 'warn' : undefined },
        { key: 'cmp', label: 'Quotes to compare', count: n("SELECT COUNT(*) n FROM rfqs WHERE status IN ('Closed','Under comparison')"), hint: 'Closed, waiting for a comparison', link: '/comparisons' },
        { key: 'apr', label: 'Awaiting approval', count: n("SELECT COUNT(*) n FROM approvals WHERE status = 'Pending'"), hint: `${mine} for you`, link: '/approvals', tone: mine ? 'warn' : undefined },
        { key: 'po', label: 'Ready for PO', count: n("SELECT COUNT(*) n FROM comparisons WHERE status = 'Approved'") + n("SELECT COUNT(*) n FROM pr_lines WHERE status = 'Contract/VMI PO pending'"), hint: 'Approved awards and contract-route lines', link: '/comparisons' },
      ],
      side: [
        { label: 'Contracts ending soon', value: n("SELECT COUNT(*) n FROM contracts WHERE status = 'Expiring'"), link: '/contracts/renewals', tone: 'warn' },
        { label: 'Vendors to review', value: n("SELECT COUNT(*) n FROM vendors WHERE onboarding_status IN ('Submitted','Under review')") + n("SELECT COUNT(*) n FROM vendor_change_requests WHERE status = 'Pending'"), link: '/vendors' },
        { label: 'Repeat-purchase opportunities', value: n("SELECT COUNT(*) n FROM opportunities WHERE status IN ('Identified','Under review')"), link: '/contracts/opportunities' },
      ],
    };
  }
  if (key === 'delivery') {
    const risks = poLineRisks();
    return {
      stages: [
        { key: 'ack', label: 'Awaiting acknowledgement', count: n(`SELECT COUNT(*) n FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE ${OPEN_PO} AND ${LIVE_LINE} AND l.ack_status IN ('Pending','Pending re-acknowledgement')`), hint: 'Lines the vendor has not accepted', link: '/pos' },
        { key: 'disp', label: 'Awaiting dispatch', count: n(`SELECT COUNT(*) n FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE ${OPEN_PO} AND ${LIVE_LINE} AND l.ack_status IN ('Accepted','Partially accepted','Deemed accepted') AND NOT EXISTS (SELECT 1 FROM asns a WHERE a.po_id = p.id AND a.status IN ('Submitted','In transit','Delivered'))`), hint: 'Accepted, no ASN yet', link: '/pos' },
        { key: 'transit', label: 'In transit', count: n("SELECT COUNT(*) n FROM asns WHERE status IN ('Submitted','In transit')"), hint: 'ASN submitted, not yet received', link: '/asns' },
        { key: 'rec', label: 'Received (7 days)', count: n('SELECT COUNT(DISTINCT grn_no) n FROM grns WHERE posting_date >= ?', iso(-7)), hint: 'GRN / SES posted in SAP', link: '/receipts' },
        { key: 'dsp', label: 'Open disputes', count: n("SELECT COUNT(*) n FROM disputes WHERE status NOT IN ('Resolved','Closed')"), hint: 'Shortage, damage, transit loss', link: '/disputes', tone: 'warn' },
      ],
      side: [
        { label: 'Lines past commitment', value: n(`SELECT COUNT(*) n FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE ${OPEN_PO} AND ${LIVE_LINE} AND l.ack_status NOT IN ('Rejected','Pending','Pending re-acknowledgement') AND COALESCE(l.commit_date, l.delivery_date) < ?`, iso()), link: '/pos', tone: 'bad' },
        { label: 'High delivery risk', value: new Set(risks.filter((r) => r.band === 'High').map((r) => r.po_id)).size, link: '/pos', tone: 'warn' },
        { label: 'Vendor tickets open', value: n("SELECT COUNT(*) n FROM tickets WHERE status IN ('Open','In progress')"), link: '/tickets' },
      ],
    };
  }
  return {
    stages: [
      { key: 'read', label: 'Being read or validated', count: n("SELECT COUNT(*) n FROM invoices WHERE status IN ('Uploaded','OCR pending','Validation pending')"), hint: 'Includes invoices waiting for a receipt', link: '/invoices' },
      { key: 'exc', label: 'Exceptions', count: n("SELECT COUNT(*) n FROM invoices WHERE status = 'Exception'"), hint: 'Need a decision', link: '/invoices/exceptions', tone: 'bad' },
      { key: 'ok', label: 'Matched, awaiting approval', count: n("SELECT COUNT(*) n FROM invoices WHERE status = 'Matched' AND approved_by IS NULL"), hint: 'Clean match', link: '/invoices', tone: 'warn' },
      { key: 'sap', label: 'Parked or posted in SAP', count: n("SELECT COUNT(*) n FROM invoices WHERE status IN ('Parked','Posted')"), hint: 'Status comes from SAP', link: '/invoices' },
      { key: 'pay', label: 'Payment due', count: n("SELECT COUNT(*) n FROM invoices WHERE status IN ('Payment due','Payment blocked')"), hint: `${n("SELECT COUNT(*) n FROM invoices WHERE status = 'Payment blocked'")} blocked`, link: '/payments' },
    ],
    side: [
      { label: 'Advances outstanding', value: n("SELECT COUNT(*) n FROM advances WHERE status IN ('Paid','Partially adjusted')"), link: '/payments' },
      { label: 'Advance requests to approve', value: n("SELECT COUNT(*) n FROM advances WHERE status IN ('Requested','Pending approval')"), link: '/payments', tone: 'warn' },
      { label: 'Held for a dispute', value: n('SELECT COUNT(*) n FROM invoices WHERE dispute_hold = 1'), link: '/invoices' },
    ],
  };
}

export function workspace(actor: Actor, key: WorkspaceKey) {
  const feed = administrator(actor, 60);
  const attention: Attention[] = feed.tasks.filter((t) => inWorkspace(key, t.link)).map((t) => ({ ...t, hint: hintFor(t) })).slice(0, 10);
  const risks = key === 'delivery' ? poRisks(poLineRisks()) : key === 'finance' ? otherRisks().filter((r) => r.kind === 'invoice_held' || r.kind === 'payment') : otherRisks().filter((r) => r.kind === 'rfq_response' || r.kind === 'contract');
  return { key, ...stages(key, actor), attention, risks: risks.sort((a, b) => b.score - a.score).slice(0, 6), kpis: kpiCards(actor, key), ai: aiStatus() };
}
