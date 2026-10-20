/**
 * Extended demo data for Module 4 (comparative statements).
 *
 * Takes every RFQ the RFQ seed registered in COMPARE_PLAN (closed, quotations locked) to its planned state through the
 * Module 4 service as the buyer and the approval personas: Draft, Recommendation recorded, Submitted (pending at level 1, 2
 * or 3), Approved, Returned, Rejected and Released for PO, plus a late / risk discount waiting for approval. Historic RFQs
 * that ended in an extra historic PO are released and linked to that PO (pos.rfq_id / pos.comparison_id). Dates are shifted
 * back with SQL on the domain rows afterwards; the audit log is never edited.
 */
import { all, get, run, tx, update, J } from '../../core/db.ts';
import { actorFor } from '../../seed/ctx.ts';
import { COMPARE_PLAN, type CmpPlan } from '../rfq/seed_extra.ts';
import { requestReopen } from '../rfq/service.ts';
import { ageApproval, ago, approveThrough, decide } from '../approvals/seed_extra.ts';
import * as S from './service.ts';

const warn = (m: string) => console.warn(`cmp seed_extra: ${m}`);

function awardsFor(c: S.ComparisonRow, p: CmpPlan): S.AwardInput[] {
  const out: S.AwardInput[] = [];
  for (const row of c.rows ?? []) {
    const el = row.cells.filter((x) => x.eligible && !x.no_quote);
    if (!el.length) { out.push({ rfq_line_id: row.rfq_line_id, vendor_id: null, reason: 'No eligible quotation received for this line' }); continue; }
    const low = el.find((x) => x.lowest) ?? [...el].sort((a, b) => (a.unit_landed ?? 1e18) - (b.unit_landed ?? 1e18))[0];
    const pick = (p.awardVendorId ? el.find((x) => x.vendor_id === p.awardVendorId) : null) ?? low;
    out.push({
      rfq_line_id: row.rfq_line_id, vendor_id: pick.vendor_id, qty: Math.min(row.qty, pick.quoted_qty ?? row.qty),
      reason: pick.lowest ? null : `Delivery in ${pick.delivery_days ?? 'fewer'} days against ${low.delivery_days ?? 'many'} days from the lowest vendor; the planned maintenance window cannot move, so the price difference is accepted.`,
    });
  }
  return out;
}

const JUSTIFY: Record<string, string> = {
  rec: 'Lowest landed cost among vendors quoting the full quantity; delivery date meets the requirement.',
  sub: 'Lowest landed cost on every line; warranty and payment terms comparable. Recommended for award.',
};

function retime(cmpId: number, p: CmpPlan, approvalIds: number[], decided: boolean) {
  const c = S.getComparison(cmpId)!;
  const s = c.summary ?? ({} as S.Summary);
  if (s.computed_at) s.computed_at = ago(p.t.cmp);
  if (s.recommendation) s.recommendation = { ...s.recommendation, at: ago(p.t.rec) };
  if (s.submission) s.submission = { ...s.submission, at: ago(p.t.sub) };
  if (s.released) s.released = { ...s.released, at: ago(p.t.rel) };
  update('comparisons', cmpId, {
    created_at: ago(p.t.cmp), summary_json: J(s),
    submitted_at: c.submitted_at ? ago(p.t.sub) : null, decided_at: c.decided_at ? ago(p.t.dec) : null, sap_handoff_at: c.sap_handoff_at ? ago(p.t.rel) : null,
  });
  for (const id of approvalIds) {
    const acted = all<{ id: number }>("SELECT id FROM approval_steps WHERE approval_id = ? AND acted_at IS NOT NULL AND status IN ('Approved','Rejected','Returned')", id).length;
    const gap = decided && acted ? Math.max(1, ((p.t.sub - p.t.dec) * 24) / acted) : 6;
    ageApproval(id, p.t.sub, Array(Math.max(acted, 1)).fill(gap));
  }
}

export function seedExtra() {
  for (const p of COMPARE_PLAN) {
    try {
      tx(() => {
        const buyer = actorFor(p.buyer, 'BUY');
        const { id } = S.generate(buyer, p.rfqId);
        let approvalIds: number[] = [];
        let decided = false;
        if (p.kind === 'discount') {
          const c = S.getComparison(id)!;
          const row = c.rows![0];
          const cell = [...row.cells].filter((x) => x.eligible && !x.no_quote).sort((a, b) => (a.unit_landed ?? 0) - (b.unit_landed ?? 0))[1] ?? row.cells.find((x) => !x.no_quote)!;
          const base = cell.landed_before_discounts ?? 0;
          S.saveDiscount(buyer, id, { rfq_line_id: row.rfq_line_id, vendor_id: cell.vendor_id, late: Math.round(base * 0.012), risk: Math.round(base * 0.008), reason: 'Vendor offered a late-delivery discount of 1.2% and a 0.8% risk discount for payment inside 15 days; buyer asks to apply both.' });
          S.submitDiscounts(buyer, id);
          const ap = get<{ id: number }>("SELECT id FROM approvals WHERE type = 'cmp.discount' AND object_type = 'comparison' AND object_id = ? ORDER BY id DESC LIMIT 1", id)!;
          approvalIds = [ap.id];
        } else if (p.kind !== 'draft') {
          const c = S.getComparison(id)!;
          S.saveRecommendation(buyer, id, { awards: awardsFor(c, p), justification: p.kind === 'rec' ? JUSTIFY.rec : p.awardVendorId ? 'Vendor chosen on delivery and past performance; commercial terms reviewed against the other quotations.' : JUSTIFY.sub });
          if (p.kind !== 'rec') {
            const sub = S.submit(buyer, id);
            approvalIds = sub.summary?.submission?.approval_ids ?? [];
            if (p.kind === 'sub2') for (const a of approvalIds) approveThrough(a, 'Commercials reviewed; recommend to Finance.', 1);
            else if (p.kind === 'sub3') for (const a of approvalIds) approveThrough(a, 'Reviewed; forwarding up the approval chain.', 2);
            else if (p.kind === 'approved' || p.kind === 'released') for (const a of approvalIds) approveThrough(a, 'Approved. Comparison and justification reviewed.');
            else if (p.kind === 'rejected') { decided = true; decide(approvalIds[0], 'reject', 'Rejected: the landed cost is above budget for this item. Re-float the RFQ with a wider vendor list.'); }
            else if (p.kind === 'returned') { decided = true; decide(approvalIds[0], 'return', 'Returned: please confirm the delivery date with the plant and attach the vendor test certificate.'); }
            if (p.kind === 'approved' || p.kind === 'released') decided = true;
            if (p.kind === 'released') {
              S.release(buyer, id);
              if (p.po) run('UPDATE pos SET rfq_id = ?, comparison_id = ? WHERE id = ?', p.rfqId, id, p.po.id);
            }
          }
        }
        retime(id, p, approvalIds, decided);
        if (p.reopenAfterReturn) {
          const v = get<{ vendor_id: number }>("SELECT vendor_id FROM rfq_invitations WHERE rfq_id = ? AND status = 'Responded' ORDER BY id DESC LIMIT 1", p.rfqId);
          if (!v) throw new Error('no responded vendor for a reopen request');
          const ro = requestReopen(buyer, p.rfqId, { vendor_ids: [v.vendor_id], reason: 'The approver asked for a firmer delivery date; vendor will revise its quotation with a committed date.', reopen_until: new Date(Date.now() + 5 * 86400000).toISOString() });
          run('UPDATE rfq_reopens SET created_at = ? WHERE id = ?', ago(p.t.dec * 0.75), ro.id);
          ageApproval(ro.approval_id!, p.t.dec * 0.75);
        }
      });
    } catch (e) { warn(`RFQ ${p.rfqId} (${p.kind}) skipped — ${(e as Error).message}`); }
  }
}
