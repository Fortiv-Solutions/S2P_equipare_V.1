/**
 * "Ask the procurement data": plain-language questions answered by keyword and filter rules over read-only queries.
 * It is NOT a language model. It says how it understood the question, shows the records behind the answer, and says
 * so when it does not understand. It reads what the signed-in user may see and changes nothing.
 */
import { all, get, now } from '../../core/db.ts';
import type { Actor } from '../../core/auth.ts';
import { APPROVER_STEP_ROLES, type Perm } from '../../core/permissions.ts';
import { receivedLines } from '../reports/defs.ts';
import { poLineRisks } from './risk.ts';

export interface AskRow { title: string; subtitle?: string; tag?: string; tone?: 'bad' | 'warn' | 'info' | 'decision' | 'ok'; link: string }
export interface AskAnswer {
  q: string; intent: string | null; understood: string; total: number; rows: AskRow[]; viewAll?: { label: string; link: string };
  source: 'rules'; examples?: string[];
}

export const EXAMPLES = [
  'Which POs are late?',
  'Late deliveries from Shakti',
  'Which invoices are on hold and why?',
  'Payments due this week',
  'What is waiting for my approval?',
  'POs not acknowledged',
  'Which RFQs have low response?',
  'Contracts expiring soon',
  'Unassigned PR lines',
  'Open disputes',
  'Which POs are likely to be late?',
];

const STOP = new Set(['pvt', 'ltd', 'limited', 'private', 'industries', 'industry', 'enterprises', 'enterprise', 'engineering', 'engineers', 'works', 'sales', 'services', 'service', 'trading', 'traders', 'company', 'corporation', 'and', 'the', 'india', 'indian', 'tools', 'systems', 'solutions', 'supply', 'supplies', 'agencies', 'agency', 'projects', 'international', 'global']);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
const iso = (n = 0) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const inr = (n: number | null | undefined) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
const day = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—');

function vendorsIn(q: string) {
  const qw = new Set(words(q));
  const hits = all<{ id: number; name: string }>('SELECT id, name FROM vendors').filter((v) => words(v.name).some((w) => w.length >= 4 && !STOP.has(w) && qw.has(w)));
  return hits.slice(0, 5);
}
function plantIn(q: string) {
  const qw = new Set(words(q));
  return all<{ code: string; name: string; city: string | null }>('SELECT code, name, city FROM plants').filter((p) => qw.has(p.code.toLowerCase()) || words(`${p.name} ${p.city ?? ''}`).some((w) => w.length >= 4 && qw.has(w)))[0];
}
const inList = (n: number) => Array(n).fill('?').join(',');

export function ask(actor: Actor, q: string): AskAnswer {
  const text = q.trim().slice(0, 200);
  const l = text.toLowerCase();
  const vendors = vendorsIn(text);
  const plant = plantIn(text);
  const days = Number(l.match(/(\d{1,3})\s*days?/)?.[1] ?? NaN);
  const scope: string[] = [];
  if (vendors.length) scope.push(`vendor ${vendors.map((v) => v.name).join(' / ')}`);
  if (plant) scope.push(`plant ${plant.code}`);
  const scoped = scope.length ? ` (${scope.join(', ')})` : '';
  const vSql = vendors.length ? ` AND p.vendor_id IN (${inList(vendors.length)})` : '';
  const vArgs = vendors.map((v) => v.id);
  const pSql = plant ? ' AND p.plant = ?' : '';
  const pArgs = plant ? [plant.code] : [];
  const plantsOk = actor.plants === '*' ? '' : ` AND p.plant IN (${inList(actor.plants.length)})`;
  const plantsArgs = actor.plants === '*' ? [] : actor.plants;
  const plantOk = (code: string | null | undefined) => actor.plants === '*' || !code || actor.plants.includes(code);
  /** SQL fragment limiting a plant column to the plants this user may see (empty for all plants). */
  const only = (col: string, withNull = false) => (actor.plants === '*' ? '' : ` AND (${withNull ? `${col} IS NULL OR ${col} = '*' OR ` : ''}${col} IN (${inList(actor.plants.length)}))`);
  const onlyArgs = actor.plants === '*' ? [] : actor.plants;
  const base = { q: text, source: 'rules' as const };
  /** Each question type reads the same data as its module, so it needs that module's permission. */
  const denied = (intent: string, ...perms: Perm[]): AskAnswer | null =>
    perms.some((x) => actor.perms.has(x)) ? null : { ...base, intent, understood: 'That information is not available to your role.', total: 0, rows: [] };
  const done = (intent: string, understood: string, rows: AskRow[], total: number, viewAll?: AskAnswer['viewAll']): AskAnswer => ({ ...base, intent, understood, rows: rows.slice(0, 15), total, viewAll });
  const word = (re: RegExp) => re.test(l);

  // 1. Likely to be late (risk) — before "late" so "likely to be late" does not read as "is late"
  if (word(/likely|at risk|going to be late|will be late|risk/)) {
    const no = denied('risk', 'po.view'); if (no) return no;
    const risks = poLineRisks().filter((r) => r.band !== 'Low' && plantOk(r.plant) && (!vendors.length || vendors.some((v) => v.id === r.vendor_id)) && (!plant || r.plant === plant.code));
    return done('risk', `PO lines with a medium or high delivery-risk score${scoped}`, risks.map((r) => ({
      title: `${r.vendor}: ${r.description}`, subtitle: `PO ${r.po_no}/${r.item} · risk ${r.score} · ${r.factors[0]?.label ?? ''}`, tag: r.band, tone: r.band === 'High' ? 'bad' : 'warn', link: r.link,
    })), risks.length, { label: 'Open the PO dashboard', link: '/pos' });
  }

  // 2. Not acknowledged
  if (word(/acknowledg|not accepted|unaccepted|not accepting/)) {
    const no = denied('ack', 'po.view'); if (no) return no;
    const rows = all<{ id: number; po_no: string; vendor: string; n: number; due: string | null }>(
      `SELECT p.id, p.po_no, v.name vendor, COUNT(*) n, p.ack_due_at due FROM pos p JOIN po_lines l ON l.po_id = p.id JOIN vendors v ON v.id = p.vendor_id
       WHERE p.status IN ('Published','Partially received') AND l.ack_status IN ('Pending','Pending re-acknowledgement') AND l.status NOT IN ('Cancelled','Closed')${vSql}${pSql}${plantsOk}
       GROUP BY p.id ORDER BY p.ack_due_at`, ...vArgs, ...pArgs, ...plantsArgs);
    return done('ack', `POs with lines the vendor has not acknowledged${scoped}`, rows.map((r) => ({
      title: `${r.vendor}: PO ${r.po_no}`, subtitle: `${r.n} line${r.n === 1 ? '' : 's'} waiting · acknowledgement due ${day(r.due)}`, tag: r.due && r.due < now() ? 'Overdue' : 'Waiting', tone: r.due && r.due < now() ? 'bad' : 'info', link: `/pos/${r.id}`,
    })), rows.length, { label: 'Open PO list', link: '/pos' });
  }

  // 3. Late / overdue deliveries
  if (word(/\b(late|overdue|delayed|behind|past due|past commit|slipp)/) && !word(/invoice|payment|pay\b/)) {
    const no = denied('late', 'po.view'); if (no) return no;
    const rows = all<{ id: number; po_no: string; item: number; vendor: string; description: string; due: string; reason: string | null }>(
      `SELECT p.id, p.po_no, l.item, v.name vendor, l.description, COALESCE(l.commit_date, l.delivery_date) due, l.delay_reason reason
       FROM po_lines l JOIN pos p ON p.id = l.po_id JOIN vendors v ON v.id = p.vendor_id
       WHERE p.status IN ('Published','Partially received') AND l.status NOT IN ('Received','Closed','Cancelled') AND l.ack_status NOT IN ('Rejected','Pending','Pending re-acknowledgement')
         AND COALESCE(l.commit_date, l.delivery_date) < ?${vSql}${pSql}${plantsOk} ORDER BY due`, iso(), ...vArgs, ...pArgs, ...plantsArgs);
    return done('late', `PO lines past their committed delivery date${scoped}`, rows.map((r) => {
      const d = Math.floor((Date.now() - new Date(r.due).getTime()) / 86400000);
      return { title: `${r.vendor}: ${r.description}`, subtitle: `PO ${r.po_no}/${r.item} · due ${day(r.due)}, ${d} day${d === 1 ? '' : 's'} late${r.reason ? ` · ${r.reason}` : ''}`, tag: d > 7 ? 'Very late' : 'Late', tone: d > 7 ? 'bad' : 'warn', link: `/pos/${r.id}` } satisfies AskRow;
    }), rows.length, { label: 'Open PO list', link: '/pos' });
  }

  // 4. Invoices on hold
  if (word(/invoice|bill/) && word(/hold|held|stuck|exception|block|mismatch|why|problem|issue|pending/)) {
    const no = denied('invoice_hold', 'inv.view'); if (no) return no;
    const rows = all<{ id: number; inv_ref: string; no: string | null; vendor: string; status: string; reason: string | null; total: number | null; created_at: string }>(
      `SELECT i.id, i.inv_ref, i.vendor_invoice_no no, v.name vendor, i.status, i.sub_reason reason, i.total_value total, i.created_at FROM invoices i JOIN vendors v ON v.id = i.vendor_id JOIN pos p ON p.id = i.po_id
       WHERE i.status IN ('Exception','Payment blocked','Validation pending')${vSql.replace('p.vendor_id', 'i.vendor_id')}${pSql}${plantsOk} ORDER BY i.created_at`, ...vArgs, ...pArgs, ...plantsArgs);
    return done('invoice_hold', `Invoices that are held, blocked or waiting on a receipt${scoped}`, rows.map((r) => ({
      title: `${r.vendor}: invoice ${r.no ?? r.inv_ref}`, subtitle: `${inr(r.total)} · ${r.reason ?? r.status}`, tag: r.status, tone: r.status === 'Validation pending' ? 'warn' : 'bad', link: `/invoices/${r.id}`,
    })), rows.length, { label: 'Open the exception queue', link: '/invoices/exceptions' });
  }

  // 5. Payments due
  if (word(/payment|pay\b|paid|due/) && !word(/approval|approve/)) {
    const no = denied('payments', 'pay.view', 'inv.view'); if (no) return no;
    const horizon = Number.isFinite(days) ? days : word(/today/) ? 0 : word(/next week/) ? 14 : 7;
    const rows = all<{ id: number; inv_ref: string; no: string | null; vendor: string; status: string; total: number | null; due: string }>(
      `SELECT i.id, i.inv_ref, i.vendor_invoice_no no, v.name vendor, i.status, i.total_value total, i.due_date due FROM invoices i JOIN vendors v ON v.id = i.vendor_id JOIN pos p ON p.id = i.po_id
       WHERE i.status IN ('Posted','Payment due','Payment blocked') AND i.due_date IS NOT NULL AND i.due_date <= ?${vSql.replace('p.vendor_id', 'i.vendor_id')}${pSql}${plantsOk} ORDER BY i.due_date`, iso(horizon), ...vArgs, ...pArgs, ...plantsArgs);
    return done('payments', `Posted invoices due within ${horizon} day${horizon === 1 ? '' : 's'}${scoped}`, rows.map((r) => ({
      title: `${r.vendor}: invoice ${r.no ?? r.inv_ref}`, subtitle: `${inr(r.total)} · due ${day(r.due)}${r.due < iso() ? ' (overdue)' : ''}`, tag: r.status, tone: r.status === 'Payment blocked' || r.due < iso() ? 'bad' : 'info', link: `/invoices/${r.id}`,
    })), rows.length, { label: 'Open payments', link: '/payments' });
  }

  // 6. Approvals
  if (word(/approv|decision|waiting for me|sign off/)) {
    const no = denied('approvals', 'apr.decide', 'apr.view'); if (no) return no;
    const roles: string[] = actor.merged ? [...APPROVER_STEP_ROLES] : [actor.role];
    const rows = all<{ id: number; req_no: string; title: string; type: string; value: number | null; created_at: string }>(
      `SELECT DISTINCT ap.id, ap.req_no, ap.title, ap.type, ap.value, ap.created_at FROM approvals ap JOIN approval_steps s ON s.approval_id = ap.id
       WHERE ap.status = 'Pending' AND s.status = 'Pending' AND s.level = ap.current_level AND s.approver_role IN (${inList(roles.length)}) AND ap.requester_id != ?
         AND COALESCE(json_extract(ap.context_json, '$.recommended_by'), 0) != ?${only('ap.plant', true)} ORDER BY ap.created_at`, ...roles, actor.id, actor.id, ...onlyArgs);
    return done('approvals', 'Approvals waiting for a decision from you', rows.map((r) => ({
      title: r.title, subtitle: `${r.req_no} · ${r.value != null ? inr(r.value) + ' · ' : ''}waiting since ${day(r.created_at)}`, tag: 'Decide', tone: 'decision', link: `/approvals/${r.id}`,
    })), rows.length, { label: 'Open approvals', link: '/approvals' });
  }

  // 7. RFQs with low response
  if (word(/rfq|quotation|quote/)) {
    const no = denied('rfq', 'rfq.view'); if (no) return no;
    const rows = all<{ id: number; rfq_no: string; title: string | null; closing_at: string | null; invited: number; quoted: number }>(
      `SELECT r.id, r.rfq_no, r.title, r.closing_at,
              (SELECT COUNT(*) FROM rfq_invitations i WHERE i.rfq_id = r.id) invited,
              (SELECT COUNT(*) FROM quotations q WHERE q.rfq_id = r.id AND q.submitted_at IS NOT NULL AND q.status NOT IN ('Draft','Not started','Declined')) quoted
       FROM rfqs r WHERE r.status = 'Published'${only('r.plant', true)} ORDER BY r.closing_at`, ...onlyArgs);
    const low = word(/low|few|no response|not responded|waiting|closing|chase/) ? rows.filter((r) => r.invited > 0 && r.quoted / r.invited < 0.5) : rows;
    return done('rfq', word(/low|few|no response|not responded|waiting|closing|chase/) ? 'Open RFQs where fewer than half of the invited vendors have quoted' : 'RFQs open with vendors', low.map((r) => ({
      title: r.title ?? r.rfq_no, subtitle: `${r.rfq_no} · ${r.quoted} of ${r.invited} vendors quoted · closes ${day(r.closing_at)}`, tag: `${r.invited ? Math.round((r.quoted / r.invited) * 100) : 0}%`, tone: r.invited && r.quoted / r.invited < 0.5 ? 'warn' : 'info', link: `/rfqs/${r.id}`,
    })), low.length, { label: 'Open RFQs', link: '/rfqs' });
  }

  // 8. Contracts expiring
  if (word(/contract|arc|\boa\b|expir|renew/)) {
    const no = denied('contracts', 'con.view'); if (no) return no;
    const rows = all<{ id: number; contract_no: string; title: string | null; valid_to: string; status: string; vendor: string }>(
      `SELECT c.id, c.contract_no, c.title, c.valid_to, c.status, v.name vendor FROM contracts c JOIN vendors v ON v.id = c.vendor_id
       WHERE c.status IN ('Expiring','Active') AND c.valid_to <= ?${vendors.length ? ` AND c.vendor_id IN (${inList(vendors.length)})` : ''}${only('c.plant', true)} ORDER BY c.valid_to`, iso(Number.isFinite(days) ? days : 60), ...vArgs, ...onlyArgs);
    return done('contracts', `Contracts that end within ${Number.isFinite(days) ? days : 60} days${scoped}`, rows.map((r) => ({
      title: `${r.vendor}: ${r.title ?? r.contract_no}`, subtitle: `${r.contract_no} · valid to ${day(r.valid_to)}`, tag: r.status, tone: 'warn', link: `/contracts/${r.id}`,
    })), rows.length, { label: 'Open renewals', link: '/contracts/renewals' });
  }

  // 9. PR lines
  if (word(/\bpr\b|requisition|requirement|unassigned|no buyer/)) {
    const no = denied('pr', 'pr.work', 'pr.assign'); if (no) return no;
    const unassigned = word(/unassigned|no buyer|not assigned/);
    const age = Number.isFinite(days) ? days : 7;
    const rows = all<{ id: number; pr_no: string; item: number; description: string; status: string; buyer: string | null; available_at: string | null }>(
      `SELECT l.id, l.pr_no, l.item, l.description, l.status, b.name buyer, l.available_at FROM pr_lines l LEFT JOIN users b ON b.id = l.buyer_id
       WHERE ${unassigned ? "l.status = 'Unassigned'" : `l.status IN ('Synced','Unassigned','Assigned','Under review','Route decided','RFQ in progress','Clarification pending') AND l.available_at < ?`}${plant ? ' AND l.plant = ?' : ''}${only('l.plant')}
       ORDER BY l.available_at`, ...(unassigned ? [] : [iso(-age)]), ...(plant ? [plant.code] : []), ...onlyArgs);
    return done('pr', unassigned ? `PR lines with no buyer${scoped}` : `Open PR lines older than ${age} days${scoped}`, rows.map((r) => ({
      title: r.description, subtitle: `${r.pr_no}/${r.item} · ${r.status}${r.buyer ? ` · ${r.buyer}` : ''}${r.available_at ? ` · since ${day(r.available_at)}` : ''}`, tag: r.status, tone: unassigned ? 'warn' : 'info', link: `/pr/${r.id}`,
    })), rows.length, { label: 'Open the PR workbench', link: '/pr' });
  }

  // 10. Disputes
  if (word(/dispute|shortage|damage|transit|claim/)) {
    const no = denied('disputes', 'dsp.view'); if (no) return no;
    const rows = all<{ id: number; dsp_no: string; type: string; status: string; owner_party: string; vendor: string; created_at: string }>(
      `SELECT d.id, d.dsp_no, d.type, d.status, d.owner_party, v.name vendor, d.created_at FROM disputes d JOIN pos p ON p.id = d.po_id JOIN vendors v ON v.id = p.vendor_id
       WHERE d.status NOT IN ('Resolved','Closed')${vSql}${pSql}${plantsOk} ORDER BY d.created_at`, ...vArgs, ...pArgs, ...plantsArgs);
    return done('disputes', `Receipt disputes that are not closed${scoped}`, rows.map((r) => ({
      title: `${r.vendor}: ${r.type}`, subtitle: `${r.dsp_no} · owner ${r.owner_party} · raised ${day(r.created_at)}`, tag: r.status, tone: 'warn', link: `/disputes/${r.id}`,
    })), rows.length, { label: 'Open disputes', link: '/disputes' });
  }

  // 11. Advances
  if (word(/advance/)) {
    const no = denied('advances', 'pay.view'); if (no) return no;
    const rows = all<{ id: number; adv_no: string; vendor: string; amount: number; adjusted: number; status: string; paid_date: string | null }>(
      `SELECT a.id, a.adv_no, v.name vendor, a.amount, a.adjusted_amount adjusted, a.status, a.paid_date FROM advances a JOIN vendors v ON v.id = a.vendor_id
       WHERE a.status IN ('Paid','Partially adjusted')${vendors.length ? ` AND a.vendor_id IN (${inList(vendors.length)})` : ''}${actor.plants === '*' ? '' : ` AND a.po_id IN (SELECT p.id FROM pos p WHERE p.plant IN (${inList(actor.plants.length)}))`} ORDER BY a.paid_date`, ...vArgs, ...onlyArgs);
    return done('advances', `Advances paid and not fully adjusted${scoped}`, rows.map((r) => ({
      title: `${r.vendor}: ${inr(r.amount - r.adjusted)} outstanding`, subtitle: `${r.adv_no} · paid ${day(r.paid_date)} · ${inr(r.adjusted)} adjusted of ${inr(r.amount)}`, tag: r.status, tone: 'info', link: `/advances/${r.id}`,
    })), rows.length, { label: 'Open payments & advances', link: '/payments' });
  }

  // 12. A vendor snapshot
  if (vendors.length) {
    const no = denied('vendor', 'po.view') ?? denied('vendor', 'inv.view'); if (no) return no;
    const v = vendors[0];
    const open = get<{ n: number; late: number }>(
      `SELECT COUNT(*) n, SUM(CASE WHEN l.ack_status NOT IN ('Pending','Pending re-acknowledgement') AND COALESCE(l.commit_date, l.delivery_date) < ? THEN 1 ELSE 0 END) late
       FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE p.vendor_id = ? AND p.status IN ('Published','Partially received') AND l.status NOT IN ('Received','Closed','Cancelled')${only('p.plant')}`, iso(), v.id, ...onlyArgs)!;
    const inv = get<{ n: number }>(`SELECT COUNT(*) n FROM invoices i JOIN pos p ON p.id = i.po_id WHERE i.vendor_id = ? AND i.status IN ('Exception','Payment blocked')${only('p.plant')}`, v.id, ...onlyArgs)!;
    const rec = receivedLines().filter((x) => x.vendor_id === v.id && plantOk(x.plant));
    const rate = rec.length ? Math.round((rec.filter((x) => x.on_time).length / rec.length) * 100) : null;
    return done('vendor', `A snapshot of ${v.name}`, [
      { title: `${open.n} open PO line${open.n === 1 ? '' : 's'}, ${open.late ?? 0} past commitment`, subtitle: 'Open the PO list', tone: open.late ? 'warn' : 'info', link: '/pos' },
      { title: `${inv.n} invoice${inv.n === 1 ? '' : 's'} held or blocked`, subtitle: 'Open the invoice list', tone: inv.n ? 'warn' : 'ok', link: '/invoices' },
      { title: rate == null ? 'No fully received lines yet, so no delivery record' : `${rate}% of ${rec.length} received lines were on time`, subtitle: 'Same basis as the on-time delivery KPI', tone: rate != null && rate < 80 ? 'warn' : 'ok', link: '/reports' },
    ], 3, { label: `Open ${v.name}`, link: `/vendors/${v.id}` });
  }

  return { ...base, intent: null, understood: 'I did not recognise that question.', total: 0, rows: [], examples: EXAMPLES };
}
