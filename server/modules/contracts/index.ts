/**
 * Module 6 routes — contract / ARC / OA / VMI / FDS repository, renewals, opportunities, off-contract
 * alerts and vendor read-only view (PRD 7.6, SCR-CON-01..04).
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ModuleDef } from '../types.ts';
import { h, parse, idParam, reasonSchema, sendCsv } from '../../core/http.ts';
import { requirePerm, actorOf } from '../../core/auth.ts';
import { onDecision } from '../../core/approvals.ts';
import { onSynced } from '../../core/sap.ts';
import { registerObjectAccess } from '../../core/files.ts';
import { registerJob } from '../../core/scheduler.ts';
import { registerConfig } from '../../core/config.ts';
import * as S from './service.ts';
import { seed } from './seed.ts';

const router = Router();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD');
const money = (msg: string) => z.number({ error: msg }).nonnegative(msg);
const itemSchema = z.object({
  material_id: z.number({ error: 'Choose a material' }).int().positive('Choose a material'),
  unit_price: money('Enter the contract price (0 or more)'),
  qty_cap: z.number().positive('Quantity cap must be above zero').nullable().optional(),
  discount_pct: z.number().min(0, 'Discount must be 0–100%').max(100, 'Discount must be 0–100%').nullable().optional(),
  list_price: z.number().positive('List price must be above zero').nullable().optional(),
});
const vmiItem = z.object({ material_id: z.number().int().positive(), min: z.number().min(0, 'Minimum must be 0 or more'), max: z.number().positive('Maximum must be above zero') });
const vmiSchema = z.object({
  items: z.array(vmiItem).min(1, 'Add minimum and maximum for at least one material'),
  replenishment_frequency: z.string().trim().min(2, 'Enter the replenishment frequency').max(120),
  billing_cycle: z.string().trim().min(2, 'Enter the billing cycle').max(120),
  reconciliation: z.string().trim().min(2, 'Describe how stock is reconciled').max(1000),
  plant: z.string().nullable().optional(),
});
const priceListSchema = z.object({
  effective_from: date,
  items: z.array(z.object({ material_id: z.number().int().positive(), list_price: z.number().positive('List price must be above zero') })).min(1, 'Add list prices for at least one item'),
  note: z.string().max(300).optional(),
});
const contractSchema = z.object({
  type: z.enum(S.CONTRACT_TYPES, { error: 'Choose a contract type' }),
  vendor_id: z.number({ error: 'Choose a vendor' }).int().positive('Choose a vendor'),
  title: z.string({ error: 'Enter a title' }).trim().min(5, 'Title must be at least 5 characters').max(160),
  category: z.string({ error: 'Choose a spend category' }).min(1, 'Choose a spend category'),
  plant: z.string().optional(),
  valid_from: date,
  valid_to: date,
  value_cap: z.number().positive('Value cap must be above zero').nullable().optional(),
  payment_terms: z.string({ error: 'Enter payment terms' }).trim().min(2, 'Enter payment terms').max(200),
  delivery_terms: z.string({ error: 'Enter delivery terms' }).trim().min(2, 'Enter delivery terms').max(200),
  discount_pct: z.number().min(0).max(100, 'Discount must be 0–100%').nullable().optional(),
  invoice_validation: z.boolean().optional(),
  renewal_lead_days: z.number().int().min(1, 'Lead time must be 1–365 days').max(365, 'Lead time must be 1–365 days').optional(),
  price_revision_date: date.nullable().optional().or(z.literal('')),
  terms: z.string().max(4000).nullable().optional(),
  owner_id: z.number().int().positive().nullable().optional(),
  items: z.array(itemSchema).min(1, 'Add at least one item with its price'),
  vmi: vmiSchema.nullable().optional(),
  price_list: priceListSchema.nullable().optional(),
  attachment_ids: z.array(z.number().int().positive()).optional(),
  submit: z.boolean().optional(),
});

const VIEW = requirePerm('con.view');
const MANAGE = requirePerm('con.manage');

// ---------------------------------------------------------------- repository (SCR-CON-01)
router.get('/', VIEW, h((req, res) => {
  const rows = S.listContracts(actorOf(req), req.query as Record<string, string>);
  if (req.query.format === 'csv') {
    return sendCsv(res, 'contracts.csv', rows as unknown as Record<string, unknown>[], [
      { key: 'contract_no', label: 'Contract' }, { key: 'sap_oa_no', label: 'SAP OA' }, { key: 'type', label: 'Type' }, { key: 'title', label: 'Title' },
      { key: 'vendor_name', label: 'Vendor' }, { key: 'category', label: 'Category' }, { key: 'plant', label: 'Plant' }, { key: 'scope', label: 'Materials' },
      { key: 'valid_from', label: 'Valid from' }, { key: 'valid_to', label: 'Valid to' }, { key: 'status', label: 'Status' }, { key: 'value_cap', label: 'Value cap' },
      { key: 'consumed', label: 'Consumed' }, { key: 'utilisation_pct', label: 'Utilisation' }, { key: 'owner_name', label: 'Owner' },
    ]);
  }
  return rows;
}));
router.get('/summary', VIEW, h(() => S.summary()));
router.get('/options', MANAGE, h(() => S.formOptions()));
router.get('/pending-sap', requirePerm('con.view', 'sapsim.all', 'sapsim.po'), h(() => S.pendingSap()));
router.post('/', MANAGE, h((req) => {
  const a = actorOf(req);
  const b = parse(contractSchema, req.body);
  const c = S.createContract(a, { ...b, price_revision_date: b.price_revision_date || null });
  if (b.submit) return { ...S.submitContract(a, c.id), warnings: c.warnings };
  return c;
}));

// ---------------------------------------------------------------- alerts (CON-03)
router.get('/alerts', VIEW, h((req) => S.listAlerts(req.query as Record<string, string>)));
router.post('/alerts/:id/justify', MANAGE, h((req) => S.justifyAlert(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/alerts/:id/dismiss', MANAGE, h((req) => S.dismissAlert(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));

// ---------------------------------------------------------------- opportunities (SCR-CON-03)
router.get('/opportunities', VIEW, h(() => S.listOpportunities()));
router.post('/opportunities/run', MANAGE, h((req) => {
  const msg = S.opportunityJob();
  return { message: msg, rows: S.listOpportunities(), by: actorOf(req).id };
}));
router.get('/opportunities/:id', VIEW, h((req) => S.opportunityDetail(idParam(req))));
router.post('/opportunities/:id/review', MANAGE, h((req) => S.reviewOpportunity(actorOf(req), idParam(req))));
router.post('/opportunities/:id/accept', MANAGE, h((req) => {
  const b = parse(z.object({ vendor_id: z.number().int().positive().optional(), note: z.string().max(500).optional() }), req.body);
  return S.acceptOpportunity(actorOf(req), idParam(req), b);
}));
router.post('/opportunities/:id/reject', MANAGE, h((req) => S.rejectOpportunity(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));

// ---------------------------------------------------------------- renewals (SCR-CON-04)
router.get('/renewals', VIEW, h(() => S.renewalDashboard()));
router.post('/renewals/run', MANAGE, h(() => ({ message: S.expiryJob() })));

// ---------------------------------------------------------------- reports data (RPT-06/07)
router.get('/reports/opportunities', requirePerm('con.view'), h(() => S.opportunityReport()));
router.get('/reports/coverage', requirePerm('con.view'), h((req) => S.coverageReport({ from: req.query.from as string | undefined, to: req.query.to as string | undefined })));

// ---------------------------------------------------------------- vendor read-only (own contracts)
router.get('/vendor', requirePerm('con.vendor'), h((req) => S.vendorList(actorOf(req))));
router.get('/vendor/:id', requirePerm('con.vendor'), h((req) => S.vendorDetail(actorOf(req), idParam(req))));

// ---------------------------------------------------------------- detail and actions (SCR-CON-02)
router.get('/:id', VIEW, h((req) => S.contractDetail(actorOf(req), idParam(req))));
router.get('/:id/sap-payload', requirePerm('con.view', 'sapsim.all', 'sapsim.po'), h((req) => S.sapOaPayload(idParam(req))));
router.put('/:id', MANAGE, h((req) => {
  const a = actorOf(req);
  const b = parse(contractSchema, req.body);
  const c = S.updateDraft(a, idParam(req), { ...b, price_revision_date: b.price_revision_date || null });
  if (b.submit) return { ...S.submitContract(a, c.id), warnings: c.warnings };
  return c;
}));
router.post('/:id/submit', MANAGE, h((req) => S.submitContract(actorOf(req), idParam(req), parse(z.object({ note: z.string().max(500).optional() }), req.body).note)));
router.post('/:id/changes', MANAGE, h((req) => {
  const b = parse(z.object({
    fields: z.object({
      valid_from: date.optional(), valid_to: date.optional(), value_cap: z.number().positive('Value cap must be above zero').nullable().optional(),
      payment_terms: z.string().trim().min(2).max(200).optional(), delivery_terms: z.string().trim().min(2).max(200).optional(),
      title: z.string().trim().min(5).max(160).optional(), discount_pct: z.number().min(0).max(100).nullable().optional(), invoice_validation: z.boolean().optional(),
      renewal_lead_days: z.number().int().min(1).max(365).optional(), price_revision_date: date.nullable().optional(), terms: z.string().max(4000).nullable().optional(),
      owner_id: z.number().int().positive().optional(),
    }).optional(),
    items: z.array(z.object({ material_id: z.number().int().positive(), unit_price: z.number().nonnegative().optional(), qty_cap: z.number().positive().nullable().optional(), discount_pct: z.number().min(0).max(100).nullable().optional(), remove: z.boolean().optional() })).optional(),
    reason: reasonSchema,
  }), req.body);
  return S.requestChange(actorOf(req), idParam(req), b);
}));
router.post('/:id/price-lists', MANAGE, h((req) => S.addPriceList(actorOf(req), idParam(req), parse(priceListSchema.extend({ reason: z.string().max(500).optional() }), req.body))));
router.put('/:id/vmi', MANAGE, h((req) => {
  const b = parse(vmiSchema.extend({ reason: reasonSchema }), req.body);
  const { reason, ...vmi } = b;
  return S.setVmiTerms(actorOf(req), idParam(req), vmi, reason);
}));
router.post('/:id/renew', MANAGE, h((req) => S.renewContract(actorOf(req), idParam(req), parse(z.object({ valid_from: date.optional(), valid_to: date.optional(), reason: z.string().max(500).optional() }), req.body))));
router.post('/:id/extend', MANAGE, h((req) => S.extendContract(actorOf(req), idParam(req), parse(z.object({ valid_to: date, reason: reasonSchema }), req.body))));
router.post('/:id/let-expire', MANAGE, h((req) => S.letExpire(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/:id/terminate', MANAGE, h((req) => S.terminateContract(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));

function init() {
  S.ensureTables();
  registerConfig(
    { key: 'contract.utilisation_warn_pct', label: 'Contract utilisation warning (%)', group: 'Contracts', description: 'Contracts and items at or above this share of their value/quantity cap are flagged.', value: 80, decision: 'DEC-09' },
    { key: 'contract.renewal_reminder_days', label: 'Contract renewal follow-up reminders (days before expiry)', group: 'Contracts', description: 'Extra NTF-13 reminders while no renewal decision is recorded.', value: [15, 7], decision: 'Q 7.6' },
  );
  registerObjectAccess('contract', (actor, id) => S.canAccessContract(actor, id));
  registerObjectAccess('contract_alert', (actor) => actor.perms.has('con.view'));
  onDecision('contract.approval', (ap, outcome, actor, comment) => {
    if (ap.object_type === 'contract') S.onContractDecision(ap, outcome, actor, comment);
    if (ap.object_type === 'contract_change') S.onChangeDecision(ap, outcome, actor, comment);
  });
  onDecision('contract.renewal', (ap, outcome, actor, comment) => {
    if (ap.object_type === 'contract_change') S.onChangeDecision(ap, outcome, actor, comment);
  });
  onDecision('exc.off_contract', (ap, outcome, actor, comment) => {
    if (ap.object_type === 'contract_alert') S.onAlertDecision(ap, outcome, actor, comment);
  });
  onSynced('OA', (rows) => S.onOaSynced(rows));
  onSynced('PO', (rows) => { S.onPoSynced(rows); });
  onSynced('STOCK', () => { S.vmiJob(); });
  registerJob({ name: 'contracts.expiry', label: 'Contract expiry and renewal reminders (NTF-13)', everyMinutes: 60, run: S.expiryJob });
  registerJob({ name: 'contracts.vmi', label: 'VMI below-minimum alerts (NTF-15)', everyMinutes: 60, run: S.vmiJob });
  registerJob({ name: 'contracts.opportunities', label: 'ARC/OA opportunity detection (DEC-09)', everyMinutes: 1440, run: S.opportunityJob });
}

export const module: ModuleDef = { path: 'contracts', router, init, seed };
