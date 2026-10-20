/**
 * Module 12 — SAP integration monitor (SCR-SAP-01..03, FR-SAP-05..12) and SAP simulator console API.
 * Monitor: view = sap.monitor (SAP/IT, Administrator), act = sap.replay (SAP/IT only; PRD 6.2).
 * Simulator: sapsim.po (buyers), sapsim.grn (stores), sapsim.fin (finance), sapsim.all (SAP/IT).
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ModuleDef } from '../types.ts';
import { all, get, insert, now, update } from '../../core/db.ts';
import { h, parse, idParam, reasonSchema, badRequest, notFound } from '../../core/http.ts';
import { requirePerm, actorOf } from '../../core/auth.ts';
import { registerConfig, cfg } from '../../core/config.ts';
import { registerJob } from '../../core/scheduler.ts';
import { FLOWS, sapGet, sapPut, sapWrite, simSettings, setSimSettings, syncEvent } from '../../core/sap.ts';
import * as M from './monitor.ts';
import * as S from './simulator.ts';
import { RUNBOOK } from './runbook.ts';
import { U, D, DAY } from '../../seed/ctx.ts';
import { DEMO_EXTRA } from '../../core/mode.ts';
import { seedExtra } from './seed_extra.ts';

const router = Router();
const view = requirePerm('sap.monitor');
const act = requirePerm('sap.replay');
const sim = (p: 'sapsim.po' | 'sapsim.grn' | 'sapsim.fin' | 'sapsim.all') => requirePerm(p, 'sapsim.all');
const anySim = requirePerm('sapsim.po', 'sapsim.grn', 'sapsim.fin', 'sapsim.all', 'sap.monitor');

// ---------------------------------------------------------------- monitor
router.get('/flows', view, h(() => ({ generated_at: now(), flows: M.flowCards(), alerts: M.alerts(), settings: S.getSettings() })));
router.post('/flows/:id/run', act, h((req) => M.runFlow(actorOf(req), String(req.params.id))));
router.get('/jobs', view, h((req) => M.recentJobs(req.query.flow ? String(req.query.flow) : undefined, Number(req.query.limit ?? 60))));
router.get('/alerts', view, h(() => M.alerts()));

router.get('/errors', view, h((req) => M.listErrors(req.query as Record<string, string>)));
router.get('/errors/:id', view, h((req) => M.getError(idParam(req))));
router.post('/errors/:id/replay', act, h((req) => {
  const b = parse(z.object({ payload: z.unknown().optional() }), req.body ?? {});
  return M.replay(actorOf(req), idParam(req), b.payload);
}));
router.post('/errors/:id/discard', act, h((req) => M.discard(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/queue/process', act, h((req) => M.processQueue(actorOf(req), parse(z.object({ flow: z.string().optional() }), req.body ?? {}).flow)));

router.get('/reconcile', view, h(() => ({ latest: M.getReconciliation(), history: M.reconciliationHistory() })));
router.get('/reconcile/:id', view, h((req) => M.getReconciliation(idParam(req)) ?? (() => { throw notFound('Reconciliation run'); })()));
router.post('/reconcile', act, h((req) => M.runReconciliation(actorOf(req), 'manual')));

router.post('/resync', act, h((req) => {
  const b = parse(z.object({
    flow: z.string().min(1, 'Choose the flow'), mode: z.enum(['document', 'from_date', 'full']), doc_type: z.string().optional(),
    key: z.string().max(80).optional(), from: z.string().optional(), reason: z.string().max(500).optional(),
  }), req.body);
  return M.resync(actorOf(req), b);
}));

router.get('/runbook', view, h(() => RUNBOOK.map((r) => {
  const f = FLOWS.find((x) => x.id === r.flow)!;
  return { ...r, name: f.name, direction: f.direction, doc_types: M.FLOW_DOCS[r.flow] ?? (f.docType ? [f.docType] : []), inbound: M.isInbound(f), decision: f.decision ?? null };
})));
router.get('/documents', view, h((req) => {
  const t = String(req.query.doc_type ?? '');
  if (!t) throw badRequest('Choose a document type.');
  return M.documents(t, req.query.q ? String(req.query.q) : undefined);
}));
router.get('/documents/:type/:key', view, h((req) => sapGet(String(req.params.type), String(req.params.key)) ?? (() => { throw notFound('SAP document'); })()));

router.get('/settings', view, h(() => ({ simulator: S.getSettings(), freshness_minutes: cfg('sap.freshness_minutes'), auto_sync_minutes: cfg('sap.auto_sync_minutes'), write: { ack: cfg('sap.write.ack'), invoice_parking: cfg('sap.write.invoice_parking'), rfq: cfg('sap.write.rfq') } })));

// ---------------------------------------------------------------- simulator settings (outage & failure injection)
const settingsBody = z.object({ offline: z.boolean().optional(), fail: z.record(z.string(), z.enum(S.FAIL_MODES).nullable()).optional() });
router.get('/sim/settings', anySim, h(() => S.getSettings()));
router.put('/sim/settings', sim('sapsim.all'), h((req) => S.putSettings(actorOf(req), parse(settingsBody, req.body))));
router.put('/settings', sim('sapsim.all'), h((req) => S.putSettings(actorOf(req), parse(settingsBody, req.body))));

router.get('/sim/lookups', anySim, h(() => ({
  plants: all('SELECT code, name FROM plants ORDER BY code'),
  materials: all('SELECT code, description, uom, gst_rate, lpp, is_service FROM materials ORDER BY code'),
  vendors: all('SELECT id, sap_code, name, sap_blocked FROM vendors WHERE sap_code IS NOT NULL ORDER BY name'),
  buyers: all("SELECT id, name, email FROM users WHERE active = 1 AND (',' || roles || ',') LIKE '%,BUY,%' ORDER BY name"),
  requisitioners: all("SELECT id, name, email, department FROM users WHERE active = 1 AND vendor_id IS NULL AND (',' || roles || ',') LIKE '%,REQ,%' ORDER BY name"),
  priorities: ['Normal', 'Urgent', 'BD', 'Class 1'],
})));

// PR (SAP/IT)
router.get('/sim/prs', sim('sapsim.all'), h(() => S.listPrs()));
router.post('/sim/pr', sim('sapsim.all'), h((req) => {
  const b = parse(z.object({
    requisitioner_email: z.string().email('Choose the requisitioner'), department: z.string().optional(),
    items: z.array(z.object({ material_code: z.string().min(1, 'Choose a material'), qty: z.number().positive('Must be more than zero'), plant: z.string().min(1, 'Choose a plant'), required_date: z.string().min(10, 'Enter the required date'), priority: z.string().default('Normal'), storage_location: z.string().optional(), est_unit_price: z.number().optional() })).min(1, 'Add at least one item'),
  }), req.body);
  return S.createPr(actorOf(req), b as Parameters<typeof S.createPr>[1]);
}));

// PO (buyers)
router.get('/sim/pos', sim('sapsim.po'), h((req) => S.listPos(actorOf(req))));
router.get('/sim/po-sources', sim('sapsim.po'), h(() => S.poSources()));
router.post('/sim/po', sim('sapsim.po'), h((req) => {
  const b = parse(z.object({
    source: z.enum(['comparison', 'pr_reference', 'manual']), comparison_id: z.number().int().optional(), pr_line_ids: z.array(z.number().int()).optional(),
    vendor_id: z.number().int().optional(), release: z.boolean().optional(), plant: z.string().optional(), buyer_id: z.number().int().optional(),
    payment_terms: z.string().max(120).optional(), delivery_terms: z.string().max(120).optional(), urgency: z.string().optional(), oa_no: z.string().optional(),
    items: z.array(z.object({ material_code: z.string(), qty: z.number(), unit_price: z.number(), delivery_date: z.string(), gst_rate: z.number().optional(), freight: z.number().optional(), pr_no: z.string().optional(), pr_item: z.number().int().optional() })).optional(),
  }), req.body);
  return S.createPo(actorOf(req), b);
}));
router.post('/sim/po/:po_no/release', sim('sapsim.po'), h((req) => S.releasePo(actorOf(req), String(req.params.po_no))));
router.post('/sim/po/:po_no/change', sim('sapsim.po'), h((req) => {
  const b = parse(z.object({
    changes: z.array(z.object({ item: z.number().int(), qty: z.number().optional(), unit_price: z.number().optional(), delivery_date: z.string().optional(), deleted: z.boolean().optional() })).default([]),
    cancel: z.boolean().optional(), amendment_id: z.number().int().optional(), terms: z.record(z.string(), z.string().nullable()).optional(),
  }), req.body);
  return S.changePo(actorOf(req), String(req.params.po_no), b);
}));

// GRN / SES (stores)
router.get('/sim/grn-sources', sim('sapsim.grn'), h((req) => S.grnSources(actorOf(req))));
router.post('/sim/grn', sim('sapsim.grn'), h((req) => {
  const b = parse(z.object({ po_no: z.string().min(1, 'Choose the PO'), items: z.array(z.object({ po_item: z.number().int(), qty: z.number().min(0) })).min(1, 'Enter received quantities'), asn_id: z.number().int().nullable().optional(), service: z.boolean().optional(), posting_date: z.string().optional() }), req.body);
  return S.postGrn(actorOf(req), b);
}));

// Invoices & advances (finance)
router.get('/sim/invoices', sim('sapsim.fin'), h(() => S.listInvoices()));
router.post('/sim/invoice/:inv_ref/:action', sim('sapsim.fin'), h((req) => {
  const a = String(req.params.action);
  if (!['park', 'post', 'pay', 'block', 'unblock'].includes(a)) throw notFound('Simulator action');
  const body = a === 'pay'
    ? parse(z.object({ payment_ref: z.string().max(40).optional(), tds: z.number().min(0).optional(), retention: z.number().min(0).optional(), advance_adjusted: z.number().min(0).optional(), deductions: z.array(z.object({ label: z.string().min(2, 'Name the deduction'), amount: z.number().positive() })).optional() }), req.body ?? {})
    : (req.body ?? {});
  return S.invoiceAction(actorOf(req), String(req.params.inv_ref), a as 'park', body);
}));
router.get('/sim/advances', sim('sapsim.fin'), h(() => S.listAdvances()));
router.post('/sim/advance/:adv_no/pay', sim('sapsim.fin'), h((req) => S.payAdvance(actorOf(req), String(req.params.adv_no), parse(z.object({ amount: z.number().positive().optional() }), req.body ?? {}))));
router.post('/sim/advance/:adv_no/adjust', sim('sapsim.fin'), h((req) => S.adjustAdvance(actorOf(req), String(req.params.adv_no), parse(z.object({ amount: z.number({ error: 'Enter the amount' }).positive('Must be more than zero') }), req.body))));

// Vendors (SAP/IT)
router.get('/sim/vendors', sim('sapsim.all'), h(() => S.vendorSources()));
router.post('/sim/vendor', sim('sapsim.all'), h((req) => S.createVendor(actorOf(req), parse(z.object({ vendor_id: z.number().int() }), req.body).vendor_id)));
router.post('/sim/vendor/:vendor_id/bank', sim('sapsim.all'), h((req) => S.applyBankChange(actorOf(req), idParam(req, 'vendor_id'), parse(z.object({ change_request_id: z.number().int() }), req.body).change_request_id)));

// Outline agreements (buyers)
router.get('/sim/oa-sources', sim('sapsim.po'), h(() => S.oaSources()));
router.post('/sim/oa', sim('sapsim.po'), h((req) => S.createOa(actorOf(req), parse(z.object({ contract_id: z.number().int() }), req.body).contract_id)));

// Stock (stores)
router.get('/sim/stock', sim('sapsim.grn'), h((req) => S.listStock(actorOf(req))));
router.post('/sim/stock', sim('sapsim.grn'), h((req) => S.setStock(actorOf(req), parse(z.object({ material_code: z.string().min(1, 'Choose a material'), plant: z.string().min(1, 'Choose a plant'), unrestricted: z.number().min(0, 'Cannot be negative') }), req.body))));

// ---------------------------------------------------------------- init & seed
function init() {
  M.ensureTables();
  registerConfig({ key: 'sapsim.default_payment_days', label: 'SAP simulator: default payment days', group: 'SAP integration', description: 'Used by the SAP simulator to compute a due date when the PO payment term has no day count (real SAP uses its payment-term master).', value: 30 });
  registerJob({ name: 'sap.reconcile', label: 'Daily SAP reconciliation (counts, totals, differences)', everyMinutes: 1440, run: () => `${M.runReconciliation(null, 'scheduled').diff_count} difference(s)` });
  registerJob({ name: 'sap.freshness', label: 'SAP freshness alerts and recovered pull errors', everyMinutes: 15, run: M.freshnessJob });
}

function seed() {
  // 1. Inbound business error: SAP holds a GRN for a PO the platform never received (AC-SAP-03/04).
  sapPut('GRN', '5000299999-2026', { grn_no: '5000299999', year: '2026', po_no: '4500029999', posting_date: DAY(-1), plant: 'PUN1', is_service: false, items: [{ po_item: 10, qty: 5, value: 10750 }] }, 'Seed');
  syncEvent('GRN');

  // 2. Outbound write queued for retry: PO acknowledgement for 4500021006 hit a transient gateway error.
  const s = simSettings();
  setSimSettings({ ...s, offline: false, fail: { ...s.fail, 'INT-M08': 'transient' } });
  const po = get<{ id: number; vendor_id: number }>('SELECT id, vendor_id FROM pos WHERE po_no = ?', '4500021006');
  if (po) {
    const key = 'POACK:4500021006:10:v1';
    sapWrite('INT-M08', 'POACK', key, { po_no: '4500021006', item: 10, ack_status: 'Accepted', accepted_qty: 80, commit_date: DAY(2), acknowledged_at: D(-1), vendor_sap_code: '100105' }, null);
    // Keep the queued write visible in the demo for 15 minutes before the automatic retry picks it up.
    const e = get<{ id: number }>("SELECT id FROM integration_errors WHERE idempotency_key = ? AND status = 'Retrying'", key);
    if (e) update('integration_errors', e.id, { next_retry_at: new Date(Date.now() + 15 * 60000).toISOString() });
  }
  const s2 = simSettings();
  setSimSettings({ offline: false, fail: { ...s2.fail, 'INT-M08': null } });

  // 3. A resolved historic error (vendor master arrived after the PO).
  let resolver: number | null = null;
  try { resolver = U('neha.gupta'); } catch { /* user missing */ }
  insert('integration_errors', {
    flow: 'INT-M07', message_id: 'PO:4500021008', idempotency_key: null, payload_json: JSON.stringify({ po_no: '4500021008', vendor_sap_code: '100109' }),
    error: 'Vendor 100109 not found for PO 4500021008', error_type: 'business', attempts: 2, status: 'Resolved', next_retry_at: null,
    created_at: D(-4, 9), updated_at: D(-4, 11), resolved_by: resolver, resolution_reason: 'Vendor master re-synced (INT-M01), then the PO was replayed and published.',
  });

  // A reconciliation run so SCR-SAP-03 has a baseline (lists the GRN difference above).
  M.runReconciliation(null, 'seed');

  if (DEMO_EXTRA) seedExtra();
}

export const module: ModuleDef = { path: 'sap', router, init, seed };
