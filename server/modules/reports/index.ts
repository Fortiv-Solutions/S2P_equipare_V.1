/**
 * Reporting & KPIs (PRD Sec 13, RPT-01..12, KPI-01..15, AC-RPT-01..04).
 * Role scope per PRD 6.2 "Dashboards and reports": REQ own · BUY team · APR department · STO stores ·
 * FIN finance · SAP integration · MGT all · ADM audit · vendors none.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { ModuleDef } from '../types.ts';
import { all, now } from '../../core/db.ts';
import { h, parse, sendCsv, forbidden, notFound, badRequest } from '../../core/http.ts';
import { requirePerm, actorOf, type Actor } from '../../core/auth.ts';
import { audit } from '../../core/audit.ts';
import { registerConfig } from '../../core/config.ts';
import { freshness, FLOWS } from '../../core/sap.ts';
import type { Role } from '../../core/permissions.ts';
import { REPORTS } from './defs.ts';
import { chartData, scopeAndFilter, tileValue, type Filters, type ReportDef, type Row } from './engine.ts';
import { computeKpis } from './kpis.ts';

const router = Router();
const KPI_ROLES: Role[] = ['BUY', 'APR', 'FIN', 'MGT'];
const SCOPE_LABEL: Record<string, string> = { REQ: 'Your own requirements', BUY: 'Your procurement team', APR: 'Procurement department', STO: 'Your stores plants', FIN: 'Finance (all vendors)', MGT: 'All data', SAP: 'Integration', ADM: 'Audit' };

const filterSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  plant: z.string().optional(), category: z.string().optional(), buyer: z.string().optional(), vendor: z.string().optional(),
  priority: z.string().optional(), route: z.string().optional(), group: z.string().optional(), tag: z.string().optional(),
});

function filtersOf(req: Request) {
  const q = Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => [k, String(v)]));
  const f = parse(filterSchema, q);
  if (f.from && f.to && f.from > f.to) throw badRequest('The start date is after the end date.', { from: 'After end date' });
  return f;
}

function mustReport(actor: Actor, id: string) {
  const def = REPORTS.find((r) => r.id === id);
  if (!def) throw notFound('Report');
  if (!actor.merged && !def.roles.includes(actor.role)) throw forbidden(`${def.no} is not part of the ${actor.role} reports. Ask your administrator if you need it.`);
  return def;
}

export function runReport(actor: Actor, def: ReportDef, f: Filters) {
  const built = def.build(actor, f);
  const restricted = actor.role === 'REQ';
  const restrictedKeys = new Set(built.columns.filter((c) => c.restricted).map((c) => c.key));
  const rows = scopeAndFilter(actor, def, built.rows, f);
  const tiles = built.tiles.filter((t) => !(restricted && t.restricted)).map((t) => ({ ...t, ...tileValue(rows, t) }));
  const clean = rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) if (!k.startsWith('_') && !(restricted && restrictedKeys.has(k))) o[k] = v;
    return o as Row;
  });
  const fresh = freshness().filter((x) => def.flows.includes(x.id)).map((x) => ({ id: x.id, name: x.name, lastSuccess: x.lastSuccess, stale: x.stale, thresholdMinutes: x.thresholdMinutes, ageMinutes: x.ageMinutes }));
  return {
    id: def.id, no: def.no, title: def.title, screen: def.screen, description: def.description, filters: def.filters, date_label: def.dateLabel ?? null,
    scope: actor.merged ? 'All data' : SCOPE_LABEL[actor.role] ?? actor.role, as_of: now(), freshness: fresh, applied: f,
    columns: built.columns.filter((c) => !(restricted && c.restricted)), tiles, chart: built.chart ? chartData(rows, built.chart, f.group) : null,
    rows: clean, total_rows: clean.length, empty: built.empty ?? 'No records for these filters.', notes: built.notes ?? [], decisions: built.decisions ?? [],
    can_export: actor.perms.has('rpt.export'),
  };
}

router.get('/catalogue', requirePerm('rpt.view', 'rpt.integration'), h((req) => {
  const a = actorOf(req);
  return {
    scope: a.merged ? 'All data' : SCOPE_LABEL[a.role] ?? a.role,
    reports: REPORTS.filter((r) => a.merged || r.roles.includes(a.role)).map((r) => ({ id: r.id, no: r.no, title: r.title, description: r.description, screen: r.screen, flows: r.flows })),
    kpis: !!a.merged || KPI_ROLES.includes(a.role),
    integration: a.perms.has('rpt.integration') || a.perms.has('sap.monitor'),
    audit: a.perms.has('audit.view_all'),
  };
}));

router.get('/filters', requirePerm('rpt.view'), h(() => ({
  plants: all('SELECT code, name FROM plants ORDER BY code'),
  categories: all('SELECT code, name FROM spend_categories ORDER BY code'),
  buyers: all("SELECT id, name FROM users WHERE active = 1 AND (',' || roles || ',') LIKE '%,BUY,%' ORDER BY name"),
  vendors: all('SELECT id, name, sap_code FROM vendors WHERE sap_code IS NOT NULL ORDER BY name'),
  priorities: ['Normal', 'Urgent', 'BD', 'Class 1', 'General stock'],
  routes: ['ARC/OA', 'VMI', 'FDS', 'Fixed supplier', 'RFQ', 'Urgent/BD', 'Class 1', 'Capex', 'Service', 'Exception', 'Not routed'],
  flows: FLOWS.map((f) => ({ id: f.id, name: f.name })),
})));

function period(req: Request) {
  const f = filtersOf(req);
  const to = f.to ?? now().slice(0, 10);
  const from = f.from ?? new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  if (from > to) throw badRequest('The start date is after the end date.', { from: 'After end date' });
  return { from, to };
}
function kpiActor(req: Request) {
  const a = actorOf(req);
  if (!a.merged && !KPI_ROLES.includes(a.role)) throw forbidden('KPIs are available to procurement, finance and management roles.');
  return a;
}
router.get('/kpis', requirePerm('rpt.view'), h((req) => {
  const a = kpiActor(req);
  const p = period(req);
  return { ...p, as_of: now(), kpis: computeKpis(a, p.from, p.to) };
}));
router.get('/kpis/summary', requirePerm('rpt.view'), h((req) => {
  const a = kpiActor(req);
  const p = period(req);
  return { ...p, as_of: now(), kpis: computeKpis(a, p.from, p.to).map(({ rows: _r, columns: _c, ...k }) => k) };
}));

router.get('/:id', requirePerm('rpt.view'), h((req) => {
  const a = actorOf(req);
  return runReport(a, mustReport(a, String(req.params.id)), filtersOf(req));
}));

/** CSV export of the report rows (or a drilled tile), audited (Sec 13, FR-PLT-05). */
router.get('/:id/export.csv', requirePerm('rpt.export'), h((req, res) => {
  const a = actorOf(req);
  const def = mustReport(a, String(req.params.id));
  const f = filtersOf(req);
  const r = runReport(a, def, f);
  const rows = f.tag ? r.rows.filter((x) => (x.tags as string[]).includes(f.tag!)) : r.rows;
  audit(a, { action: 'report.export_csv', objectType: 'report', objectId: def.id, objectRef: def.no, after: { filters: f, rows: rows.length } });
  sendCsv(res, `${def.no}-${now().slice(0, 10)}.csv`, rows.map((x) => ({ ...x, tags: undefined, link: undefined })), r.columns.map((c) => ({ key: c.key, label: c.header })));
}));

router.post('/:id/print', requirePerm('rpt.view'), h((req) => {
  const a = actorOf(req);
  const def = mustReport(a, String(req.params.id));
  audit(a, { action: 'report.print_pdf', objectType: 'report', objectId: def.id, objectRef: def.no, after: { filters: req.body ?? {} } });
  return { ok: true };
}));

function init() {
  registerConfig(
    { key: 'reports.pr_ageing_buckets', label: 'PR ageing buckets (days)', group: 'Reports', description: 'Upper bounds of the PR ageing buckets in RPT-01.', value: [3, 7, 15], decision: 'DEC-15' },
    { key: 'reports.dispute_buckets', label: 'Dispute ageing buckets (days)', group: 'Reports', description: 'Upper bounds of the dispute ageing buckets in RPT-08.', value: [7, 15, 30], decision: 'DEC-15' },
    { key: 'reports.approval_buckets', label: 'Approval ageing buckets (days)', group: 'Reports', description: 'Bucket bounds for KPI-05 approval ageing (AC-APR-05: 1/3/6 days).', value: [1, 3, 6], decision: 'DEC-15' },
    { key: 'reports.kpi07_commitment', label: 'On-time delivery basis', group: 'Reports', description: 'Which vendor commitment counts for KPI-07: "latest" or "first".', value: 'latest', decision: 'Q 7.7' },
    { key: 'reports.scorecard_normalisation', label: 'Vendor scorecard normalisation', group: 'Reports', description: 'Ack TAT earns full marks at or below the first value (hours) and none at the second; dispute rate per received line that scores zero.', value: { ack_full_marks_hours: 24, ack_zero_marks_hours: 168, dispute_rate_zero_marks: 0.2 }, decision: 'DEC-22' },
  );
}

export const module: ModuleDef = { path: 'reports', router, init };
