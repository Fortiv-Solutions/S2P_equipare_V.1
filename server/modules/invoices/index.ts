import { Router } from 'express';
import { z } from 'zod';
import type { ModuleDef } from '../types.ts';
import { get } from '../../core/db.ts';
import { h, parse, idParam, reasonSchema, sendCsv } from '../../core/http.ts';
import { requirePerm, actorOf, plantAllowed } from '../../core/auth.ts';
import { onSynced } from '../../core/sap.ts';
import { registerObjectAccess } from '../../core/files.ts';
import { registerJob } from '../../core/scheduler.ts';
import { registerConfig } from '../../core/config.ts';
import * as S from './service.ts';
import { seedInvoices } from './seed.ts';

const router = Router();
const val = z.union([z.string().max(200), z.number(), z.null()]).optional();

// Lists (SCR-INV-01, SCR-INV-02)
router.get('/', requirePerm('inv.view'), h((req, res) => {
  const rows = S.listInvoices(actorOf(req));
  if (req.query.format === 'csv') {
    return sendCsv(res, 'invoices.csv', rows as unknown as Record<string, unknown>[], [
      { key: 'inv_ref', label: 'Invoice ref' }, { key: 'vendor_invoice_no', label: 'Vendor invoice no.' }, { key: 'invoice_date', label: 'Invoice date' },
      { key: 'vendor_name', label: 'Vendor' }, { key: 'po_no', label: 'PO' }, { key: 'plant', label: 'Plant' }, { key: 'total_value', label: 'Total' },
      { key: 'status', label: 'Status' }, { key: 'sub_reason', label: 'Reason' }, { key: 'open_exceptions', label: 'Open exceptions' }, { key: 'owners', label: 'Owners' },
      { key: 'age_days', label: 'Age (days)' }, { key: 'due_date', label: 'Due' }, { key: 'payment_ref', label: 'Payment ref' },
    ]);
  }
  return rows;
}));
router.get('/exceptions', requirePerm('inv.view'), h((req) => S.listExceptions(actorOf(req), String(req.query.status ?? 'Open'))));
router.get('/assignees', requirePerm('inv.review'), h(() => S.assignees()));
router.get('/report', requirePerm('inv.view', 'rpt.finance'), h((req) => S.reportSummary(actorOf(req))));

// Upload (FR-INV-01, FR-INV-10)
router.get('/po-options', requirePerm('inv.vendor', 'inv.upload_behalf'), h((req) => S.poOptions(actorOf(req))));
router.get('/po-context/:id', requirePerm('inv.vendor', 'inv.upload_behalf'), h((req) => S.uploadContext(actorOf(req), idParam(req))));
router.post('/', requirePerm('inv.vendor', 'inv.upload_behalf'), h((req) => {
  const b = parse(z.object({
    po_id: z.number({ error: 'Choose the purchase order' }).int().positive('Choose the purchase order'),
    attachment_id: z.number({ error: 'Upload the invoice file (PDF or photo)' }).int().positive('Upload the invoice file (PDF or photo)'),
    asn_id: z.number().int().positive().nullable().optional(),
    header: z.record(z.string(), val),
    lines: z.array(z.record(z.string(), val)).min(1, 'Enter at least one invoice line').max(100),
  }), req.body);
  const inv = S.createInvoice(actorOf(req), b as S.UploadInput);
  return { id: inv.id, inv_ref: inv.inv_ref, status: inv.status, sub_reason: inv.sub_reason };
}));

// Vendor (SCR-VPT-07) — vendor-safe data only
router.get('/vendor', requirePerm('inv.vendor'), h((req) => S.vendorInvoices(actorOf(req))));
router.get('/vendor/:id', requirePerm('inv.vendor'), h((req) => S.vendorInvoiceDetail(actorOf(req), idParam(req))));

// Exceptions (WF-10 resolutions)
router.post('/exceptions/:id/approve', requirePerm('inv.review'), h((req) => S.approveException(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/exceptions/:id/resolve', requirePerm('inv.review'), h((req) => {
  const b = parse(z.object({ resolution: z.enum(['Credit note received', 'Corrected in SAP', 'PO amended', 'Other']), reference: z.string().trim().max(60).optional().nullable(), reason: reasonSchema }), req.body);
  return S.resolveException(actorOf(req), idParam(req), b.resolution, b.reference || null, b.reason);
}));
router.post('/exceptions/:id/assign', requirePerm('inv.review'), h((req) => {
  const b = parse(z.object({ user_id: z.number({ error: 'Choose a person' }).int().positive('Choose a person'), note: z.string().trim().max(500).optional() }), req.body);
  return S.assignException(actorOf(req), idParam(req), b.user_id, b.note || undefined);
}));

// Review (SCR-INV-03)
router.get('/:id', requirePerm('inv.view'), h((req) => S.invoiceDetail(actorOf(req), idParam(req))));
router.post('/:id/correct', requirePerm('inv.review'), h((req) => {
  const b = parse(z.object({ field: z.string().min(1, 'Choose a field').max(60), value: z.union([z.string().max(200), z.number(), z.null()]), reason: reasonSchema }), req.body);
  return S.correctField(actorOf(req), idParam(req), b.field, b.value, b.reason);
}));
router.post('/:id/verify', requirePerm('inv.review'), h((req) => S.verifyField(actorOf(req), idParam(req), parse(z.object({ field: z.string().min(1).max(60) }), req.body).field)));
router.post('/:id/revalidate', requirePerm('inv.review'), h((req) => S.validate(idParam(req), actorOf(req), 'manual re-run')));
router.post('/:id/approve', requirePerm('inv.review'), h((req) => S.approveInvoice(actorOf(req), idParam(req), parse(z.object({ note: z.string().trim().max(500).optional() }), req.body).note || null)));
router.post('/:id/park', requirePerm('inv.review'), h((req) => S.requestParking(actorOf(req), idParam(req))));
router.post('/:id/reject', requirePerm('inv.review'), h((req) => {
  const b = parse(z.object({ vendor_reason: reasonSchema, internal_note: z.string().trim().max(500).optional() }), req.body);
  return S.rejectInvoice(actorOf(req), idParam(req), b.vendor_reason, b.internal_note || null);
}));

function init() {
  S.ensureSchema();
  registerConfig(
    { key: 'inv.upload_on_behalf', label: 'Finance uploads invoices on the vendor’s behalf', group: 'Invoice matching', description: 'When on, finance can upload an invoice for a vendor; it is marked “uploaded on behalf” (FR-INV-10).', value: true, decision: 'Q 7.10' },
    { key: 'inv.exception_ageing_days', label: 'Invoice exception ageing alert (days)', group: 'Invoice matching', description: 'Open exceptions older than this notify the owner (NTF-29); twice this escalates to finance and procurement managers.', value: 3, decision: 'DEC-15' },
  );
  registerObjectAccess('invoice', (actor, id) => {
    const i = get<{ vendor_id: number; plant: string }>('SELECT i.vendor_id, p.plant FROM invoices i JOIN pos p ON p.id = i.po_id WHERE i.id = ?', id);
    if (!i) return false;
    if (actor.role === 'VEN') return actor.vendorId === i.vendor_id;
    return actor.perms.has('inv.view') && plantAllowed(actor, i.plant);
  });
  onSynced('INVSTATUS', S.onInvoiceStatus);
  onSynced('GRN', S.onGrnSynced);
  onSynced('PO', (rows) => { for (const r of rows) S.revalidatePo(r.id, 'PO change in SAP'); });
  registerJob({ name: 'inv.exception_ageing', label: 'Invoice exception ageing and dispute-hold re-check (NTF-29)', everyMinutes: 60, run: S.exceptionAgeingJob });
}

export const module: ModuleDef = { path: 'invoices', router, init, seed: seedInvoices };
