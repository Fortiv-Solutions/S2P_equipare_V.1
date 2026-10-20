import { Router } from 'express';
import { z } from 'zod';
import type { ModuleDef } from '../types.ts';
import { get, all, update } from '../../core/db.ts';
import { h, parse, idParam, reasonSchema, sendCsv, notFound } from '../../core/http.ts';
import { requirePerm, actorOf } from '../../core/auth.ts';
import { onDecision, act, getApproval } from '../../core/approvals.ts';
import { registerConfig } from '../../core/config.ts';
import { registerObjectAccess } from '../../core/files.ts';
import { audit } from '../../core/audit.ts';
import { actorFor, D } from '../../seed/ctx.ts';
import { DEMO_EXTRA } from '../../core/mode.ts';
import * as S from './service.ts';
import { seedExtra } from './seed_extra.ts';

const router = Router();

router.get('/', requirePerm('cmp.view'), h((req) => S.list(req.query as Record<string, string>)));
router.get('/ready-rfqs', requirePerm('cmp.view'), h(() => S.readyRfqs()));
router.get('/rfq/:rfqId', requirePerm('cmp.view'), h((req) => {
  const e = S.eligibility(idParam(req, 'rfqId'));
  return { rfq: { id: e.rfq.id, rfq_no: e.rfq.rfq_no, title: e.rfq.title, status: e.rfq.status, closing_at: e.rfq.closing_at }, ok: e.ok, reason: e.reason, locked: e.locked, invited: e.invited, all_responded: e.all_responded, latest: e.latest, quotes_changed: e.quotes_changed };
}));
router.post('/rfq/:rfqId/generate', requirePerm('cmp.manage'), h((req) => {
  const r = S.generate(actorOf(req), idParam(req, 'rfqId'));
  return { id: r.id, created: r.created, ref: S.comparisonLabel(r.comparison) };
}));
router.get('/:id', requirePerm('cmp.view'), h((req) => S.detail(idParam(req))));
router.post('/:id/refresh-params', requirePerm('cmp.manage'), h((req) => S.refreshParams(actorOf(req), idParam(req))));
router.post('/:id/acceptable', requirePerm('cmp.manage'), h((req) => {
  const b = parse(z.object({ rfq_line_id: z.number().int(), vendor_id: z.number().int(), acceptable: z.boolean(), reason: z.string().max(500).optional() }), req.body);
  return S.setAcceptable(actorOf(req), idParam(req), b.rfq_line_id, b.vendor_id, b.acceptable, b.reason);
}));
router.post('/:id/discounts', requirePerm('cmp.manage'), h((req) => {
  const b = parse(z.object({ rfq_line_id: z.number().int(), vendor_id: z.number().int(), late: z.number().min(0, 'Late discount cannot be negative'), risk: z.number().min(0, 'Risk discount cannot be negative'), reason: reasonSchema }), req.body);
  return S.saveDiscount(actorOf(req), idParam(req), b);
}));
router.post('/:id/discounts/remove', requirePerm('cmp.manage'), h((req) => {
  const b = parse(z.object({ rfq_line_id: z.number().int(), vendor_id: z.number().int() }), req.body);
  return S.removeDiscount(actorOf(req), idParam(req), b.rfq_line_id, b.vendor_id);
}));
router.post('/:id/discounts/submit', requirePerm('cmp.manage'), h((req) => S.submitDiscounts(actorOf(req), idParam(req))));
router.put('/:id/recommendation', requirePerm('cmp.manage'), h((req) => {
  const b = parse(z.object({
    awards: z.array(z.object({ rfq_line_id: z.number().int(), vendor_id: z.number().int().nullable(), qty: z.number().positive('Quantity must be more than zero').optional(), reason: z.string().max(500).nullable().optional() })).min(1, 'Choose a vendor for at least one line'),
    justification: z.string().max(2000),
  }), req.body);
  return S.saveRecommendation(actorOf(req), idParam(req), b);
}));
router.post('/:id/submit', requirePerm('cmp.manage'), h((req) => S.submit(actorOf(req), idParam(req))));
router.post('/:id/release', requirePerm('cmp.manage'), h((req) => S.release(actorOf(req), idParam(req))));

router.get('/:id/csv', requirePerm('cmp.view'), h((req, res) => {
  const c = S.getComparison(idParam(req));
  if (!c) throw notFound('Comparison');
  const rows: Record<string, unknown>[] = [];
  for (const r of c.rows ?? []) for (const x of r.cells) {
    const aw = (c.awards ?? []).find((a) => a.rfq_line_id === r.rfq_line_id && a.vendor_id === x.vendor_id);
    rows.push({
      line: r.line_no, pr: r.pr_ref, material: r.material_code, description: r.description, qty: r.qty, uom: r.uom, vendor: x.vendor_name, quoted: x.no_quote ? 'No quote' : x.alternate ? 'Alternate' : x.partial ? 'Partial' : 'Yes',
      quoted_qty: x.quoted_qty, basic: x.basic_price, discount_pct: x.discount_pct, net_unit: x.net_unit, gst_pct: x.gst_rate, gamma: x.gamma, freight: x.freight, packing: x.packing, taxable: x.taxable,
      gst_impact: x.gst_impact, pta: x.pta, late_discount: x.ld, risk_discount: x.rd, landed: x.landed, unit_landed: x.unit_landed, rank: x.rank ?? (x.alt_rank ? `alt ${x.alt_rank}` : ''), lowest: x.lowest ? 'Yes' : '',
      lpp: r.lpp, var_lpp_pct: x.var_lpp_pct != null ? (x.var_lpp_pct * 100).toFixed(1) : '', contract_price: r.contract?.unit_price, var_contract_pct: x.var_contract_pct != null ? (x.var_contract_pct * 100).toFixed(1) : '',
      budget: r.budget_price, delivery_days: x.delivery_days, make_brand: x.make_brand, performance: x.performance_score, awarded_qty: aw?.qty ?? '', award_reason: aw?.reason ?? '',
    });
  }
  audit(actorOf(req), { action: 'cmp.exported_csv', objectType: 'comparison', objectId: c.id, objectRef: S.comparisonLabel(c), after: { rows: rows.length } });
  return sendCsv(res, `${c.cmp_no}-v${c.version}.csv`, rows);
}));

router.get('/:id/pdf', requirePerm('cmp.view'), h(async (req, res) => {
  const id = idParam(req);
  const c = S.getComparison(id);
  if (!c) throw notFound('Comparison');
  const a = actorOf(req);
  if (['Approved', 'Released for PO'].includes(c.status)) {
    const attId = await S.lockPdf(id);
    if (attId) {
      audit(a, { action: 'cmp.exported_pdf', objectType: 'comparison', objectId: id, objectRef: S.comparisonLabel(c), after: { locked: true, attachment_id: attId } });
      return res.redirect(`/api/files/${attId}/download`);
    }
  }
  const { renderPdf } = await import('./pdf.ts');
  const buf = await renderPdf(c, false);
  audit(a, { action: 'cmp.exported_pdf', objectType: 'comparison', objectId: id, objectRef: S.comparisonLabel(c), after: { locked: false } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${c.cmp_no}-v${c.version}-working-copy.pdf"`);
  res.send(buf);
}));

function init() {
  registerConfig({
    key: 'cmp.split_award_by_qty', label: 'Split award by quantity', group: 'Comparison',
    description: 'When on, one RFQ line can be awarded to more than one vendor by quantity (FR-CMP-07). Split by line is always allowed.',
    value: { enabled: false }, decision: 'Q FR-CMP-07',
  });
  registerObjectAccess('comparison', (actor) => actor.perms.has('cmp.view'));
  onDecision('cmp.award', S.onAwardDecision);
  onDecision('exc.deviation', S.onAwardDecision);
  onDecision('cmp.discount', (ap, outcome, actor) => { if (ap.object_type === 'comparison') S.onDiscountDecision(ap, outcome, actor); });
}

/**
 * Demo: the RFQ for breakdown PR 10045504 (track chain, Dhanbad). Recommend the fastest-delivery vendor for
 * the track chain (not the lowest landed cost → deviation), submit, approve level 1 as Vikram so the award
 * waits at Finance. Skipped when the RFQ module has not seeded that RFQ.
 */
function seedBase() {
  const pl = get<{ id: number }>("SELECT id FROM pr_lines WHERE pr_no = '10045504' AND item = 10");
  if (!pl) return;
  const rl = get<{ rfq_id: number }>("SELECT l.rfq_id FROM rfq_lines l JOIN rfqs r ON r.id = l.rfq_id WHERE l.pr_line_id = ? AND r.status = 'Closed' ORDER BY r.id DESC LIMIT 1", pl.id);
  if (!rl) return;
  if (!S.eligibility(rl.rfq_id).ok) return;
  const rfq = get<{ buyer_id: number | null }>('SELECT buyer_id FROM rfqs WHERE id = ?', rl.rfq_id)!;
  const buyerEmail = rfq.buyer_id ? get<{ email: string }>('SELECT email FROM users WHERE id = ?', rfq.buyer_id)?.email : null;
  const buyer = actorFor(buyerEmail?.split('@')[0] ?? 'amit.kulkarni', 'BUY');
  const { id } = S.generate(buyer, rl.rfq_id);
  const c = S.getComparison(id)!;
  const inr = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Math.round(n));
  const awards: S.AwardInput[] = [];
  for (const r of c.rows ?? []) {
    const eligible = r.cells.filter((x) => x.eligible);
    if (!eligible.length) { awards.push({ rfq_line_id: r.rfq_line_id, vendor_id: null, reason: 'No eligible quotation received for this line' }); continue; }
    const lowest = eligible.find((x) => x.lowest)!;
    if (r.rfq_line_id && r.pr_line_id === pl.id) {
      const fastest = eligible.find((x) => x.vendor_id === r.fastest_vendor_id) ?? lowest;
      const diff = ((fastest.unit_landed ?? 0) - (lowest.unit_landed ?? 0)) * Math.min(r.qty, fastest.quoted_qty ?? r.qty);
      awards.push({ rfq_line_id: r.rfq_line_id, vendor_id: fastest.vendor_id, qty: Math.min(r.qty, fastest.quoted_qty ?? r.qty), reason: fastest.lowest ? null : `Breakdown at Dhanbad mine: fastest delivery outweighs ${inr(diff)} difference` });
    } else {
      awards.push({ rfq_line_id: r.rfq_line_id, vendor_id: lowest.vendor_id, qty: Math.min(r.qty, lowest.quoted_qty ?? r.qty) });
    }
  }
  S.saveRecommendation(buyer, id, { awards, justification: 'D375A dozer down at Dhanbad; award balances landed cost against delivery to restore the machine fastest.' });
  const sub = S.submit(buyer, id);
  const vikram = actorFor('vikram.joshi', 'APR');
  for (const apId of sub.summary?.submission?.approval_ids ?? []) {
    const a = getApproval(apId);
    if (a?.status === 'Pending') act(vikram, apId, 'approve', a.type === 'exc.deviation' ? 'Accepted: breakdown priority justifies the faster vendor.' : 'Commercials reviewed; recommend to Finance.');
  }
  // Demo ageing: the request was raised yesterday morning, level 1 acted in the afternoon.
  for (const apId of sub.summary?.submission?.approval_ids ?? []) {
    update('approvals', apId, { created_at: D(-1, 9) });
    for (const s of all<{ id: number; status: string }>('SELECT id, status FROM approval_steps WHERE approval_id = ?', apId)) {
      if (s.status === 'Approved') update('approval_steps', s.id, { acted_at: D(-1, 15) });
    }
  }
}

function seed() {
  seedBase();
  if (DEMO_EXTRA) seedExtra();
}

export const module: ModuleDef = { path: 'cmp', router, init, seed };
