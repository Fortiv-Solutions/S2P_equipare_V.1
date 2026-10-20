import { Router } from 'express';
import { z } from 'zod';
import type { ModuleDef } from '../types.ts';
import { get } from '../../core/db.ts';
import { h, parse, idParam, reasonSchema, sendCsv } from '../../core/http.ts';
import { requirePerm, actorOf, plantAllowed } from '../../core/auth.ts';
import { onDecision } from '../../core/approvals.ts';
import { onSynced } from '../../core/sap.ts';
import { registerObjectAccess } from '../../core/files.ts';
import { registerJob } from '../../core/scheduler.ts';
import { registerConfig } from '../../core/config.ts';
import * as S from './service.ts';
import { seedPayments } from './seed.ts';

const router = Router();

// SCR-PAY-01
router.get('/invoices', requirePerm('pay.view'), h((req, res) => {
  const rows = S.invoicePayments(actorOf(req));
  if (req.query.format === 'csv') return sendCsv(res, 'invoice-payments.csv', rows, [
    { key: 'inv_ref', label: 'Invoice ref' }, { key: 'vendor_invoice_no', label: 'Vendor invoice' }, { key: 'vendor_name', label: 'Vendor' }, { key: 'po_no', label: 'PO' },
    { key: 'status', label: 'Status' }, { key: 'total_value', label: 'Total' }, { key: 'due_date', label: 'Due' }, { key: 'paid_at', label: 'Paid' }, { key: 'payment_ref', label: 'Payment ref' }, { key: 'tds', label: 'TDS' },
  ]);
  return rows;
}));
router.get('/advances', requirePerm('pay.view', 'adv.request', 'adv.manage'), h((req) => S.register(actorOf(req))));
router.get('/report', requirePerm('pay.view', 'rpt.finance'), h((req) => S.reportSummary(actorOf(req))));
router.get('/po-options', requirePerm('adv.request'), h((req) => S.poOptions(actorOf(req))));
router.get('/advance-context/:id', requirePerm('adv.request', 'pay.view'), h((req) => S.advanceContext(actorOf(req), idParam(req))));
router.post('/advances', requirePerm('adv.request'), h((req) => {
  const b = parse(z.object({
    po_id: z.number().int().positive().nullable().optional(), contract_id: z.number().int().positive().nullable().optional(),
    amount: z.number({ error: 'Enter the advance amount' }).positive('Enter an amount greater than zero'),
    reason: z.string({ error: 'Give the reason for the advance' }).trim().min(10, 'Give the reason for the advance (at least 10 characters)').max(500),
  }), req.body);
  return S.requestAdvance(actorOf(req), b);
}));

// SCR-VPT-08 (vendor) — before /advances/:id
router.get('/vendor/invoices', requirePerm('pay.vendor'), h((req) => S.vendorPayments(actorOf(req))));
router.get('/vendor/advances', requirePerm('pay.vendor'), h((req) => S.listAdvances(actorOf(req)).map((a) => ({ id: a.id, adv_no: a.adv_no, po_no: a.po_no, contract_no: a.contract_no, amount: a.amount, status: a.status, paid_date: a.paid_date, adjusted_amount: a.adjusted_amount, outstanding: a.outstanding, created_at: a.created_at }))));
router.get('/invoices/:id/advice.pdf', requirePerm('pay.vendor', 'pay.view', 'inv.view'), h((req, res) => {
  const r = S.adviceFor(actorOf(req), idParam(req));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${r.filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(r.buffer);
}));

router.get('/advances/:id', requirePerm('pay.view', 'adv.request', 'adv.manage', 'pay.vendor'), h((req) => S.advanceDetail(actorOf(req), idParam(req))));
router.post('/advances/:id/cancel', requirePerm('adv.request', 'adv.manage'), h((req) => S.cancelAdvance(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/advances/:id/resubmit', requirePerm('adv.request'), h((req) => {
  const b = parse(z.object({ amount: z.number().positive().optional(), reason: z.string().trim().max(500).optional() }), req.body);
  return S.resubmitAdvance(actorOf(req), idParam(req), b);
}));

function init() {
  registerConfig({ key: 'pay.advance_alert_days', label: 'Unadjusted advance alert (days)', group: 'Payments', description: 'Paid advances not fully adjusted after this many days notify the requester and finance (NTF-31).', value: 60, decision: 'Q KPI-15' });
  registerObjectAccess('advance', (actor, id) => {
    const a = get<{ vendor_id: number; plant: string | null }>('SELECT a.vendor_id, p.plant FROM advances a LEFT JOIN pos p ON p.id = a.po_id WHERE a.id = ?', id);
    if (!a) return false;
    if (actor.role === 'VEN') return actor.vendorId === a.vendor_id;
    return (actor.perms.has('pay.view') || actor.perms.has('adv.request') || actor.perms.has('adv.manage')) && plantAllowed(actor, a.plant);
  });
  onDecision('adv.request', (ap, outcome, actor, comment) => { if (ap.object_type === 'advance') S.onAdvanceDecision(ap, outcome, actor, comment); });
  onSynced('ADVPAY', S.onAdvanceSynced);
  registerJob({ name: 'pay.advance_ageing', label: 'Unadjusted advance ageing (NTF-31)', everyMinutes: 360, run: S.advanceAgeingJob });
}

export const module: ModuleDef = { path: 'payments', router, init, seed: seedPayments };
