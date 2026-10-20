/** Module 8 — ASN, dispatch, logistics, stores receipt view and disputes (PRD 7.8, WF-08, WF-14, RPT-08). */
import { Router } from 'express';
import { z } from 'zod';
import type { ModuleDef } from '../types.ts';
import { h, parse, idParam, reasonSchema, sendCsv } from '../../core/http.ts';
import { requirePerm, actorOf } from '../../core/auth.ts';
import { onDecision } from '../../core/approvals.ts';
import { onSynced } from '../../core/sap.ts';
import { registerObjectAccess } from '../../core/files.ts';
import { registerJob } from '../../core/scheduler.ts';
import { registerConfig, cfg } from '../../core/config.ts';
import * as S from './service.ts';
import * as D from './disputes.ts';
import { seed } from './seed.ts';

const router = Router();

// ------------------------------------------------------------------ ASN
const lineSchema = z.object({ po_line_id: z.number().int().positive(), qty: z.number({ error: 'Enter a quantity' }), packing: z.string().max(200).nullish() });
const asnSchema = z.object({
  po_id: z.number().int().positive('Choose the PO'),
  dispatch_date: z.string().nullish(), expected_date: z.string().nullish(),
  transporter: z.string().max(120).nullish(), lr_no: z.string().max(60).nullish(), vehicle_no: z.string().max(30).nullish(),
  eway_bill: z.string().max(30).nullish(), invoice_ref: z.string().max(60).nullish(), packing_details: z.string().max(1000).nullish(),
  pickup_by: z.enum(['Vendor', 'Equipcare']).nullish(),
  lines: z.array(lineSchema).min(1, 'Add at least one line'),
  attachment_ids: z.array(z.number().int().positive()).max(30).optional(),
  submit: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});

router.get('/meta', requirePerm('asn.view', 'asn.vendor', 'dsp.view', 'dsp.vendor'), h(() => ({
  dispute_types: D.DISPUTE_TYPES, outcomes: D.OUTCOMES, owner_parties: D.OWNER_PARTIES, evidence_labels: D.EVIDENCE_LABELS,
  responsibility: cfg('dispute.responsibility'), photo_rule: D.photoRule(), lr_mandatory: cfg('asn.lr_mandatory'), term_defaults: cfg('asn.term_defaults'),
  tolerance_pct: cfg('asn.qty_tolerance_pct'), closure_approval: cfg('dispute.closure_approval'), escalate_days: cfg('dispute.ageing_escalate_days'),
  buckets: D.bucketsDef().labels, hold_rule: cfg('dispute.hold_rule'),
})));

router.get('/asns', requirePerm('asn.view', 'asn.vendor'), h((req, res) => {
  const rows = S.listAsns(actorOf(req), req.query as Record<string, string>);
  if (req.query.format === 'csv') {
    return sendCsv(res, 'asns.csv', rows as unknown as Record<string, unknown>[], [
      { key: 'asn_no', label: 'ASN' }, { key: 'po_no', label: 'PO' }, { key: 'vendor_name', label: 'Vendor' }, { key: 'plant', label: 'Plant' }, { key: 'status', label: 'Status' },
      { key: 'dispatch_date', label: 'Dispatch date' }, { key: 'expected_date', label: 'Expected delivery' }, { key: 'delivery_terms', label: 'Delivery terms' },
      { key: 'transporter', label: 'Transporter' }, { key: 'lr_no', label: 'LR / AWB' }, { key: 'vehicle_no', label: 'Vehicle' }, { key: 'eway_bill', label: 'E-way bill' },
      { key: 'total_qty', label: 'Total qty' }, { key: 'pickup_by', label: 'Pickup by' }, { key: 'pickup_status', label: 'Pickup status' }, { key: 'grn_nos', label: 'GRN' }, { key: 'version', label: 'Version' },
    ]);
  }
  return rows;
}));
router.get('/asns/summary', requirePerm('asn.view', 'asn.vendor'), h((req) => S.asnSummary(actorOf(req))));
router.get('/eligible-pos', requirePerm('asn.vendor'), h((req) => S.eligiblePos(actorOf(req))));
router.get('/prefill', requirePerm('asn.vendor'), h((req) => S.prefill(actorOf(req), Number(req.query.po), req.query.exclude ? Number(req.query.exclude) : undefined)));
router.get('/receipts', requirePerm('asn.receive', 'asn.view'), h((req) => S.expectedReceipts(actorOf(req), req.query as Record<string, string>)));
router.get('/asns/:id', requirePerm('asn.view', 'asn.vendor'), h((req) => S.asnDetail(actorOf(req), idParam(req))));

router.post('/asns', requirePerm('asn.vendor'), h((req) => {
  const a = actorOf(req);
  S.assertCanCreate(a);
  const b = parse(asnSchema, req.body);
  return S.createAsn(a, b, !!b.submit);
}));
router.put('/asns/:id', requirePerm('asn.vendor'), h((req) => {
  const b = parse(asnSchema, req.body);
  return S.reviseAsn(actorOf(req), idParam(req), b, b.reason);
}));
router.post('/asns/:id/submit', requirePerm('asn.vendor'), h((req) => S.submitAsn(actorOf(req), idParam(req))));
router.post('/asns/:id/dispatch', requirePerm('asn.vendor'), h((req) => {
  const b = parse(z.object({ transporter: z.string().max(120).nullish(), lr_no: z.string().max(60).nullish(), vehicle_no: z.string().max(30).nullish() }), req.body);
  return S.markDispatched(actorOf(req), idParam(req), b);
}));
router.post('/asns/:id/pickup', requirePerm('po.followup'), h((req) => {
  const b = parse(z.object({ action: z.enum(['schedule', 'picked_up', 'failed']), pickup_date: z.string().nullish(), transporter: z.string().max(120).nullish(), lr_no: z.string().max(60).nullish(), vehicle_no: z.string().max(30).nullish(), note: z.string().max(500).nullish() }), req.body);
  return S.updatePickup(actorOf(req), idParam(req), b);
}));
router.post('/asns/:id/cancel', requirePerm('asn.vendor', 'po.followup'), h((req) => S.cancelAsn(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));

// ------------------------------------------------------------------ disputes
router.get('/disputes', requirePerm('dsp.view', 'dsp.vendor'), h((req, res) => {
  const rows = D.listDisputes(actorOf(req), req.query as Record<string, string>);
  if (req.query.format === 'csv') {
    return sendCsv(res, 'disputes.csv', rows as unknown as Record<string, unknown>[], [
      { key: 'dsp_no', label: 'Dispute' }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'po_no', label: 'PO' }, { key: 'item', label: 'Item' },
      { key: 'description', label: 'Material' }, { key: 'vendor_name', label: 'Vendor' }, { key: 'plant', label: 'Plant' }, { key: 'qty', label: 'Qty' }, { key: 'value', label: 'Value (INR)' },
      { key: 'delivery_term', label: 'Delivery term' }, { key: 'owner_label', label: 'Owner' }, { key: 'age_days', label: 'Age (days)' }, { key: 'bucket', label: 'Ageing bucket' },
      { key: 'outcome', label: 'Outcome' }, { key: 'closure_tat_days', label: 'Closure TAT (days)' },
    ]);
  }
  return rows;
}));
router.get('/disputes/ageing', requirePerm('dsp.view'), h((req) => D.ageingReport(actorOf(req), String(req.query.by ?? 'owner'))));
router.get('/disputes/context', requirePerm('dsp.raise'), h((req) => {
  const n = (k: string) => (req.query[k] ? Number(req.query[k]) : undefined);
  return D.captureContext(actorOf(req), { po_line: n('po_line'), asn: n('asn'), invoice: n('invoice') ?? n('invoice_id'), po: n('po') });
}));
router.get('/disputes/owners', requirePerm('dsp.manage'), h(() => D.ownerCandidates()));
router.get('/disputes/:id', requirePerm('dsp.view', 'dsp.vendor'), h((req) => D.disputeDetail(actorOf(req), idParam(req))));

router.post('/disputes', requirePerm('dsp.raise'), h((req) => {
  const b = parse(z.object({
    po_line_id: z.number({ error: 'Choose the PO line' }).int().positive('Choose the PO line'),
    asn_id: z.number().int().positive().nullish(), grn_id: z.number().int().positive().nullish(), invoice_id: z.number().int().positive().nullish(),
    type: z.string({ error: 'Choose the discrepancy type' }).min(1, 'Choose the discrepancy type'),
    qty: z.number({ error: 'Enter the affected quantity' }), value: z.number().min(0).nullish(),
    description: z.string().max(2000).nullish(), attachment_ids: z.array(z.number().int().positive()).max(20).optional(),
  }), req.body);
  return D.raiseDispute(actorOf(req), b);
}));
router.post('/disputes/:id/reassign', requirePerm('dsp.manage'), h((req) => {
  const b = parse(z.object({ owner_party: z.string().min(1, 'Choose the owner'), owner_user_id: z.number().int().positive().nullish(), reason: reasonSchema }), req.body);
  return D.reassign(actorOf(req), idParam(req), b);
}));
router.post('/disputes/:id/notes', requirePerm('dsp.raise', 'dsp.manage', 'dsp.hold'), h((req) => {
  const b = parse(z.object({ body: z.string().trim().min(3, 'Write the note').max(2000), vendor_visible: z.boolean().optional() }), req.body);
  return D.addNote(actorOf(req), idParam(req), b);
}));
router.post('/disputes/:id/evidence', requirePerm('dsp.raise', 'dsp.manage', 'dsp.hold'), h((req) => {
  const b = parse(z.object({ attachment_ids: z.array(z.number().int().positive()).min(1, 'Upload at least one file').max(20), note: z.string().max(300).nullish() }), req.body);
  return D.addEvidence(actorOf(req), idParam(req), b);
}));
router.post('/disputes/:id/request-response', requirePerm('dsp.manage', 'dsp.raise'), h((req) => D.requestResponse(actorOf(req), idParam(req), parse(z.object({ message: reasonSchema }), req.body).message)));
router.post('/disputes/:id/under-resolution', requirePerm('dsp.manage', 'dsp.raise', 'dsp.hold'), h((req) => D.markUnderResolution(actorOf(req), idParam(req), parse(z.object({ note: z.string().max(500).nullish() }), req.body).note)));
router.post('/disputes/:id/outcome', requirePerm('dsp.manage', 'dsp.raise', 'dsp.hold'), h((req) => {
  const b = parse(z.object({ outcome: z.string().min(1, 'Choose the outcome'), note: reasonSchema, amount: z.number().min(0).nullish() }), req.body);
  return D.recordOutcome(actorOf(req), idParam(req), b);
}));
router.post('/disputes/:id/close', requirePerm('dsp.manage'), h((req) => D.closeDispute(actorOf(req), idParam(req), parse(z.object({ note: z.string().max(500).nullish() }), req.body).note ?? null)));
router.post('/disputes/:id/reopen', requirePerm('dsp.manage', 'dsp.raise'), h((req) => D.reopenDispute(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/disputes/:id/respond', requirePerm('dsp.vendor'), h((req) => {
  const b = parse(z.object({ body: z.string().trim().min(10, 'Write your response (at least 10 characters)').max(3000), attachment_ids: z.array(z.number().int().positive()).max(20).optional() }), req.body);
  return D.vendorRespond(actorOf(req), idParam(req), b);
}));

function init() {
  S.ensureTables();
  registerConfig(
    { key: 'asn.lr_mandatory', label: 'LR / AWB mandatory by delivery term', group: 'Purchase orders', description: 'An ASN cannot be submitted without an LR / AWB number for these delivery terms (AC-ASN-01). Equipcare-arranged pickups record the LR at pickup.', value: { FOR: true, 'Ex-Works': false }, decision: 'Q 7.8' },
    { key: 'asn.term_defaults', label: 'ASN defaults by delivery term', group: 'Purchase orders', description: 'Freight, transit-risk responsibility and pickup responsibility prefilled on each ASN from the PO delivery term (FR-ASN-02, FR-ASN-03). The PO freight term overrides the freight default.', value: { FOR: { freight_mode: 'Paid', transit_risk: 'Vendor', pickup_by: 'Vendor' }, 'Ex-Works': { freight_mode: 'To pay', transit_risk: 'Equipcare', pickup_by: 'Equipcare' } }, decision: 'DEC-24' },
    { key: 'dispute.photo_rule', label: 'Photos required for discrepancy types', group: 'Disputes', description: 'A discrepancy of these types needs at least this many photos (SCR-ASN-04).', value: { types: ['Damage', 'Transit damage'], min_photos: 1 }, decision: 'Q 7.8' },
    { key: 'dispute.ageing_buckets', label: 'Dispute ageing buckets (days)', group: 'Disputes', description: 'Upper bounds of the dispute ageing buckets (RPT-08, AC-DSP-03).', value: [3, 7, 15], decision: 'DEC-15' },
  );
  registerObjectAccess('asn', (actor, id) => S.canAccessAsn(actor, id));
  registerObjectAccess('dispute', (actor, id) => D.canAccessDispute(actor, id));
  onSynced('GRN', (rows) => S.onGrnSynced(rows));
  onDecision('dispute.closure', (ap, outcome, actor, comment) => {
    if (ap.object_type === 'dispute') D.onClosureDecision(ap.id, ap.object_id, outcome, actor, comment);
  });
  registerJob({ name: 'asn.pickup_overdue', label: 'Overdue Equipcare pickups (AC-ASN-03)', everyMinutes: 60, run: S.pickupOverdueJob });
  registerJob({ name: 'dsp.ageing', label: 'Dispute ageing escalation (NTF-23)', everyMinutes: 60, run: D.ageingJob });
}

export const module: ModuleDef = { path: 'asn', router, init, seed };
