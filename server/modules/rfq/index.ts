import { Router } from 'express';
import { z } from 'zod';
import type { ModuleDef } from '../types.ts';
import { all, get, db } from '../../core/db.ts';
import { h, parse, idParam, reasonSchema, sendCsv } from '../../core/http.ts';
import { requirePerm, actorOf } from '../../core/auth.ts';
import { audit } from '../../core/audit.ts';
import { onDecision } from '../../core/approvals.ts';
import { registerConfig } from '../../core/config.ts';
import { registerObjectAccess } from '../../core/files.ts';
import { registerJob } from '../../core/scheduler.ts';
import * as S from './service.ts';
import * as Q from './quotes.ts';
import { rfqPdf } from './pdf.ts';
import { seed } from './seed.ts';

const router = Router();
const VIEW = requirePerm('rfq.view');
const MANAGE = requirePerm('rfq.manage');
const VENDOR = requirePerm('rfq.vendor');

const optText = z.string().max(4000).nullable().optional();
const isoDate = z.string().min(1, 'Enter a date and time');

// ------------------------------------------------------------------ buyer / internal (SCR-RFQ-01..03)
router.get('/rfqs', VIEW, h((req, res) => {
  const rows = S.listRfqs(actorOf(req), req.query as Record<string, string>);
  if (req.query.format === 'csv') {
    return sendCsv(res, 'rfqs.csv', rows as unknown as Record<string, unknown>[], [
      { key: 'rfq_no', label: 'RFQ' }, { key: 'title', label: 'Title' }, { key: 'kind', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'buyer_name', label: 'Buyer' },
      { key: 'plant', label: 'Plant' }, { key: 'lines', label: 'Lines' }, { key: 'invited', label: 'Invited' }, { key: 'responded', label: 'Responded' }, { key: 'declined', label: 'Declined' },
      { key: 'not_responded', label: 'Not responded' }, { key: 'closing_at', label: 'Closing (UTC)' }, { key: 'published_at', label: 'Published (UTC)' },
    ]);
  }
  return rows;
}));
router.get('/summary', VIEW, h((req) => S.summary(actorOf(req))));
router.get('/plants', VIEW, h(() => all('SELECT code, name, city, ship_to_address FROM plants ORDER BY code')));
router.get('/opportunities/:id', VIEW, h((req) => S.opportunityPreview(idParam(req))));

router.post('/preview', MANAGE, h((req) => {
  const b = parse(z.object({ pr_line_ids: z.array(z.number().int().positive()).optional(), opportunity_id: z.number().int().positive().optional(), plant: z.string().optional() }), req.body);
  return S.preview(actorOf(req), b);
}));
router.post('/rfqs', MANAGE, h((req) => {
  const b = parse(z.object({
    pr_line_ids: z.array(z.number().int().positive()).optional(), opportunity_id: z.number().int().positive().optional(), plant: z.string().optional(),
    qty: z.number().positive('Enter a quantity above zero').optional(), title: z.string().max(200).optional(), closing_at: z.string().optional(),
  }), req.body);
  return S.createRfq(actorOf(req), b);
}));
router.get('/rfqs/:id', VIEW, h((req) => S.detail(actorOf(req), idParam(req))));
router.put('/rfqs/:id', MANAGE, h((req) => {
  const b = parse(z.object({
    title: z.string().max(200).optional(), closing_at: z.string().optional(), delivery_terms: z.enum(S.DELIVERY_TERMS, { error: 'Choose FOR or Ex-Works' }).optional(),
    payment_terms: optText, warranty: optText, packing: optText, documents_required: optText, standard_terms: optText, ship_to: optText, reason: z.string().max(500).optional(),
  }), req.body);
  const { reason, ...patch } = b;
  return S.updateHeader(actorOf(req), idParam(req), patch, reason);
}));
router.get('/rfqs/:id/suggestions', VIEW, h((req) => S.suggestions(idParam(req))));
router.get('/rfqs/:id/vendor-search', MANAGE, h((req) => S.searchVendors(idParam(req), String(req.query.q ?? ''))));

router.post('/rfqs/:id/lines', MANAGE, h((req) => S.addLines(actorOf(req), idParam(req), parse(z.object({ pr_line_ids: z.array(z.number().int().positive()).min(1, 'Choose at least one PR line') }), req.body).pr_line_ids)));
router.put('/rfqs/:id/lines/:lineId', MANAGE, h((req) => {
  const b = parse(z.object({
    description: z.string().max(500).optional(), qty: z.number().optional(), required_date: z.string().nullable().optional(), due_at: z.string().nullable().optional(),
    plant: z.string().optional(), ship_to: optText, gst_rate: z.number().nullable().optional(), valuation_type: optText, transport_req: optText, specs: optText, reason: z.string().max(500).optional(),
  }), req.body);
  const { reason, ...patch } = b;
  return S.updateLine(actorOf(req), idParam(req), idParam(req, 'lineId'), patch, reason);
}));
router.delete('/rfqs/:id/lines/:lineId', MANAGE, h((req) => S.removeLine(actorOf(req), idParam(req), idParam(req, 'lineId'))));
router.post('/rfqs/:id/lines/:lineId/flag', MANAGE, h((req) => {
  const b = parse(z.object({ action: z.enum(['remove', 'keep'], { error: 'Choose remove or keep' }), reason: reasonSchema }), req.body);
  return S.resolveFlag(actorOf(req), idParam(req), idParam(req, 'lineId'), b.action, b.reason);
}));

router.post('/rfqs/:id/invitations', MANAGE, h((req) => {
  const b = parse(z.object({ vendor_id: z.number().int().positive('Choose a vendor'), justification: z.string().max(500).nullable().optional() }), req.body);
  return S.addInvitation(actorOf(req), idParam(req), b.vendor_id, b.justification);
}));
router.put('/rfqs/:id/invitations/:invId', MANAGE, h((req) => {
  const b = parse(z.object({ justification: z.string().trim().min(10, 'Justification must be at least 10 characters').max(500) }), req.body);
  return S.updateJustification(actorOf(req), idParam(req), idParam(req, 'invId'), b.justification);
}));
router.delete('/rfqs/:id/invitations/:invId', MANAGE, h((req) => S.removeInvitation(actorOf(req), idParam(req), idParam(req, 'invId'))));
router.post('/rfqs/:id/invitations/:invId/resend', MANAGE, h((req) => S.resendInvitation(actorOf(req), idParam(req), idParam(req, 'invId'))));

router.post('/rfqs/:id/publish', MANAGE, h((req) => S.publish(actorOf(req), idParam(req), parse(z.object({ exception_reason: z.string().max(500).nullable().optional() }), req.body))));
router.post('/rfqs/:id/remind', MANAGE, h((req) => S.remind(actorOf(req), idParam(req), parse(z.object({ message: z.string().max(500).nullable().optional() }), req.body).message)));
router.post('/rfqs/:id/extend', MANAGE, h((req) => {
  const b = parse(z.object({ closing_at: isoDate, reason: reasonSchema }), req.body);
  return S.extend(actorOf(req), idParam(req), b.closing_at, b.reason);
}));
router.post('/rfqs/:id/cancel', MANAGE, h((req) => S.cancel(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/rfqs/:id/refloat', MANAGE, h((req) => S.refloat(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/rfqs/:id/close', MANAGE, h((req) => S.closeEarly(actorOf(req), idParam(req))));
router.post('/rfqs/:id/no-response-exception', MANAGE, h((req) => S.noResponseException(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/rfqs/:id/reopen', MANAGE, h((req) => {
  const b = parse(z.object({ vendor_ids: z.array(z.number().int().positive()).min(1, 'Choose at least one vendor'), reason: reasonSchema, reopen_until: isoDate }), req.body);
  return S.requestReopen(actorOf(req), idParam(req), b);
}));
router.post('/rfqs/:id/reopens/:rid/lock', MANAGE, h((req) => S.lockReopenNow(actorOf(req), idParam(req), idParam(req, 'rid'))));

router.get('/rfqs/:id/pdf', VIEW, h(async (req, res) => {
  const a = actorOf(req);
  const r = S.mustRfq(idParam(req));
  const vendorId = req.query.vendor_id ? Number(req.query.vendor_id) : null;
  if (vendorId && !get('SELECT id FROM rfq_invitations WHERE rfq_id = ? AND vendor_id = ?', r.id, vendorId)) throw S.notInvited();
  const buf = await rfqPdf(r, vendorId);
  audit(a, { action: 'rfq.pdf_downloaded', objectType: 'rfq', objectId: r.id, objectRef: r.rfq_no, after: { vendor_id: vendorId } });
  sendPdf(res, `${r.rfq_no}${vendorId ? `-${vendorId}` : ''}.pdf`, buf, !!req.query.inline);
}));

function sendPdf(res: import('express').Response, name: string, buf: Buffer, inline: boolean) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buf);
}

// ------------------------------------------------------------------ vendor portal (SCR-VPT-03, SCR-VPT-04)
const num = z.number({ error: 'Enter a number' }).nullable().optional();
const quoteSchema = z.object({
  header: z.object({
    payment_terms: z.string().max(500).nullable().optional(), credit_days: num, delivery_terms: z.string().nullable().optional(),
    validity_date: z.string().nullable().optional(), remarks: z.string().max(2000).nullable().optional(),
  }).optional(),
  lines: z.array(z.object({
    rfq_line_id: z.number().int().positive(), no_quote: z.boolean().optional(), quoted_qty: num, basic_price: num, discount_pct: num, gst_rate: num, freight: num, packing: num,
    delivery_days: num, make_brand: z.string().max(200).nullable().optional(), warranty: z.string().max(300).nullable().optional(), alternate: z.boolean().optional(),
    partial: z.boolean().optional(), remarks: z.string().max(1000).nullable().optional(),
  })).optional(),
});

router.get('/vendor/rfqs', VENDOR, h((req) => Q.vendorInbox(actorOf(req))));
router.get('/vendor/rfqs/:id', VENDOR, h((req) => Q.vendorView(actorOf(req), idParam(req))));
router.put('/vendor/rfqs/:id/quotation', requirePerm('qtn.submit'), h((req) => Q.saveDraft(actorOf(req), idParam(req), parse(quoteSchema, req.body) as Q.QuoteInput)));
router.post('/vendor/rfqs/:id/quotation/submit', requirePerm('qtn.submit'), h((req) => Q.submit(actorOf(req), idParam(req), parse(quoteSchema, req.body) as Q.QuoteInput)));
router.post('/vendor/rfqs/:id/decline', requirePerm('qtn.submit'), h((req) => Q.decline(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.get('/vendor/rfqs/:id/pdf', VENDOR, h(async (req, res) => {
  const a = actorOf(req);
  const r = Q.vendorRfq(a, idParam(req));
  const buf = await rfqPdf(r, a.vendorId);
  audit(a, { action: 'rfq.pdf_downloaded', objectType: 'rfq', objectId: r.id, objectRef: r.rfq_no, after: { vendor_id: a.vendorId } });
  sendPdf(res, `${r.rfq_no}.pdf`, buf, !!req.query.inline);
}));

// ------------------------------------------------------------------ init
function addColumn(table: string, col: string, type: string) {
  const cols = all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

function init() {
  // Module-owned columns (reported to the lead): RFQ type and source opportunity, limited-source justification, master-data auto-fill snapshot.
  addColumn('rfqs', 'kind', "TEXT DEFAULT 'Spot'");
  addColumn('rfqs', 'opportunity_id', 'INTEGER');
  addColumn('rfqs', 'exception_reason', 'TEXT');
  addColumn('rfq_lines', 'autofill_json', 'TEXT');
  registerConfig(...S.RFQ_CONFIG);

  const rfqVisible = (actor: import('../../core/auth.ts').Actor, rfqId: number) => {
    if (actor.role !== 'VEN') return actor.perms.has('rfq.view') || actor.perms.has('qtn.view') || actor.perms.has('cmp.view');
    const r = get<{ status: string }>('SELECT status FROM rfqs WHERE id = ?', rfqId);
    if (!r || ['Draft', 'Pending approval'].includes(r.status)) return false;
    return !!get('SELECT id FROM rfq_invitations WHERE rfq_id = ? AND vendor_id = ? AND sent_at IS NOT NULL', rfqId, actor.vendorId);
  };
  // FR-RFQ-10 / AC-RFQ-10: RFQ and line attachments readable by internal users and invited vendors of a non-draft RFQ.
  registerObjectAccess('rfq', rfqVisible);
  registerObjectAccess('rfq_line', (actor, lineId) => {
    const l = get<{ rfq_id: number }>('SELECT rfq_id FROM rfq_lines WHERE id = ?', lineId);
    return !!l && rfqVisible(actor, l.rfq_id);
  });
  // Quotation documents: the vendor while it may edit (uploads), internal users only once prices are unsealed.
  registerObjectAccess('quotation', (actor, qid) => {
    const q = get<{ rfq_id: number; vendor_id: number }>('SELECT rfq_id, vendor_id FROM quotations WHERE id = ?', qid);
    if (!q) return false;
    const r = S.getRfq(q.rfq_id);
    if (!r) return false;
    if (actor.role === 'VEN') return actor.vendorId === q.vendor_id && Q.editState(r, q.vendor_id).editable;
    return (actor.perms.has('rfq.view') || actor.perms.has('qtn.view') || actor.perms.has('cmp.view')) && !S.isSealedNow(r);
  });

  for (const t of ['exc.single_source', 'exc.new_vendor']) {
    onDecision(t, (ap, outcome, actor, comment) => {
      if (ap.object_type === 'rfq') S.onExceptionDecision(ap.object_id, ap.id, outcome, actor, comment);
    });
  }
  onDecision('rfq.reopen', (ap, outcome, actor, comment) => {
    if (ap.object_type === 'rfq_reopen') S.onReopenDecision(ap.object_id, outcome, actor, comment);
  });
  registerJob({ name: 'rfq.lifecycle', label: 'RFQ auto-close at closing time and reopen-window lock', everyMinutes: 5, run: S.lifecycleJob });
  registerJob({ name: 'rfq.reminders', label: 'RFQ reminders to non-responding vendors (NTF-05)', everyMinutes: 30, run: S.remindersJob });
}

export const module: ModuleDef = { path: 'rfq', router, init, seed };
