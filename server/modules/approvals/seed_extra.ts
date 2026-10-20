/**
 * Extended demo data for Module 5 (approvals) and the shared helpers the other sourcing seeds use.
 *
 * Exception approvals that no other sourcing flow raises by itself (urgent procurement, PO after receipt, price amendment)
 * are created here through the approval engine as the buyer, decided as the right persona, and every approval raised by the
 * sourcing seeds is aged afterwards (created / acted / decided times) so the ageing buckets and the exception register look
 * like a working operation. Only domain rows are re-dated: the hash-chained audit log is never touched.
 *
 * Decisions on the approvals raised by the PR seed (off-contract routing) are taken here, because this module seeds after pr.
 */
import { all, get, update } from '../../core/db.ts';
import { act, createApproval, getApproval, type ApprovalAction } from '../../core/approvals.ts';
import type { Role } from '../../core/permissions.ts';
import { actorFor } from '../../seed/ctx.ts';

/** Small deterministic RNG (same generator as seed/base_extra.ts). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ISO timestamp `days` (may be fractional) before now. */
export const ago = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

const PERSONA: Record<string, string[]> = { APR: ['vikram.joshi'], FIN: ['meera.iyer', 'kiran.shah'], MGT: ['rajesh.menon'] };

/** Decide the pending step of an approval as the persona who holds that role. */
export function decide(id: number, action: ApprovalAction, comment: string | null = null) {
  const a = getApproval(id);
  if (!a) throw new Error(`seed: approval ${id} not found`);
  const step = get<{ approver_role: Role }>("SELECT approver_role FROM approval_steps WHERE approval_id = ? AND level = ? AND status = 'Pending' ORDER BY id LIMIT 1", id, a.current_level);
  if (!step) throw new Error(`seed: approval ${a.req_no} has no pending step (${a.status})`);
  const names = PERSONA[step.approver_role] ?? PERSONA.APR;
  return act(actorFor(names[id % names.length], step.approver_role), id, action, comment);
}

/** Approve level after level as the right personas (stops after `maxLevel`). */
export function approveThrough(id: number, comment: string, maxLevel = 99) {
  let a = getApproval(id)!;
  while (a.status === 'Pending' && a.current_level <= maxLevel) a = decide(id, 'approve', comment);
  return a;
}

/**
 * Re-date an approval that was just created (and possibly decided) in the seed: created `createdAgoDays` ago, each acted step
 * `gapHours[i]` after the previous event (default 4-20 h, never later than now), pending steps due 48 h after they opened.
 */
export function ageApproval(id: number, createdAgoDays: number, gapHours: number[] = []) {
  const created = Date.now() - createdAgoDays * 86400000;
  const cap = Date.now() - 10 * 60000;
  const iso = (t: number) => new Date(Math.min(t, cap)).toISOString();
  let prev = created;
  let gi = 0;
  for (const s of all<{ id: number; status: string; acted_at: string | null; due_at: string | null }>('SELECT id, status, acted_at, due_at FROM approval_steps WHERE approval_id = ? ORDER BY level, id', id)) {
    const opened = prev;
    const acted = !!s.acted_at && ['Approved', 'Rejected', 'Returned'].includes(s.status);
    const fields: Record<string, unknown> = {};
    if (s.due_at) fields.due_at = iso(opened + 48 * 3600000);
    if (acted) {
      const gap = gapHours[gi++] ?? 4 + ((id * 7 + s.id * 3) % 17);
      prev = Math.min(opened + gap * 3600000, cap);
      fields.acted_at = new Date(prev).toISOString();
    }
    if (Object.keys(fields).length) update('approval_steps', s.id, fields);
  }
  const a = getApproval(id)!;
  update('approvals', id, { created_at: iso(created), decided_at: a.decided_at ? new Date(prev).toISOString() : null });
}

const buyerOf = (userId: number | null) => {
  const email = userId ? get<{ email: string }>('SELECT email FROM users WHERE id = ?', userId)?.email : null;
  return actorFor((email ?? 'amit.kulkarni@x').split('@')[0], 'BUY');
};

function approvalOfLine(type: string, ref: string) {
  const [pr, item] = ref.split('/');
  return get<{ id: number; status: string }>(
    `SELECT a.id, a.status FROM approvals a JOIN pr_lines p ON p.id = a.object_id WHERE a.type = ? AND a.object_type = 'pr_line' AND p.pr_no = ? AND p.item = ? ORDER BY a.id DESC LIMIT 1`,
    type, pr, Number(item),
  );
}

export function seedExtra() {
  const warn = (m: string) => console.warn(`approvals seed_extra: ${m}`);

  // ---- decisions on the off-contract routing requests raised by the PR seed
  const offContract: [ref: string, action: ApprovalAction | null, comment: string, gap: number][] = [
    ['10046020/20', 'approve', 'Approved. Annual rate contract price is higher than the quotes in hand for this one-off bulk order; RFQ is justified.', 14],
    ['10046013/10', 'reject', 'Rejected. The ARC holder can supply within the required date at the contract rate; buy against the ARC.', 20],
    ['10046023/10', null, '', 0],
    ['10046021/10', null, '', 0],
  ];
  for (const [ref, action, comment, gap] of offContract) {
    const ap = approvalOfLine('exc.off_contract', ref);
    if (!ap) { warn(`no off-contract approval for ${ref}`); continue; }
    if (!action) continue;
    if (ap.status !== 'Pending') continue;
    const created = get<{ created_at: string }>('SELECT created_at FROM approvals WHERE id = ?', ap.id)!.created_at;
    decide(ap.id, action, comment);
    ageApproval(ap.id, (Date.now() - Date.parse(created)) / 86400000, [gap]);
  }

  // ---- exception approvals raised directly by the buyer (no other seed raises these types)
  const line = (ref: string) => {
    const [pr, item] = ref.split('/');
    return get<{ id: number; buyer_id: number; description: string; qty: number; est_unit_price: number | null; plant: string; category: string | null; priority: string }>('SELECT id, buyer_id, description, qty, est_unit_price, plant, category, priority FROM pr_lines WHERE pr_no = ? AND item = ?', pr, Number(item));
  };

  type Direct = { ref: string; type: string; title: (d: string) => string; reason: string; summary: string; age: number; stop: 'pending' | 'l1' | 'approved'; comment?: string };
  const direct: Direct[] = [
    { ref: '10045509/20', type: 'exc.urgent', title: (d) => `Urgent procurement: ${d}`, age: 0.35, stop: 'pending',
      summary: 'Dhanbad shovel is down for hose assemblies; RFQ window cut to 36 hours and the nearest two vendors will be phoned.',
      reason: 'Machine down at Dhanbad mine; delivery needed within three days. Normal RFQ period would extend the breakdown.' },
    { ref: '10046010/10', type: 'exc.urgent', title: (d) => `Urgent procurement: ${d}`, age: 5, stop: 'approved', comment: 'Approved. Buy against the ARC vendor with expedited dispatch.',
      summary: 'Class 1 lubricant requirement for a machine under warranty service; expedite from the ARC holder.',
      reason: 'Class 1 priority: warranty service window closes in four days, lubricant stock at Nagpur is nil.' },
    { ref: '10046017/10', type: 'exc.po_after_receipt', title: (d) => `PO after receipt: ${d}`, age: 6.6, stop: 'pending',
      summary: 'Filters were taken into stores against a verbal order during the VMI stock-out; PO to be raised retrospectively.',
      reason: 'Goods received on 12 Oct against a verbal commitment by the plant. PO is being raised after receipt to regularise the purchase.' },
    { ref: '10046004/10', type: 'exc.po_after_receipt', title: (d) => `PO after receipt: ${d}`, age: 3.8, stop: 'l1', comment: 'Procurement view: genuine breakdown purchase, price in line with the ARC rate.',
      summary: 'Lubricant drums received at Nagpur workshop before PO; vendor invoice is waiting.',
      reason: 'Workshop on Wheels needed the drums on site the same day; the vendor delivered on a phone order. Rate matches the current ARC.' },
    { ref: '10046017/20', type: 'exc.po_after_receipt', title: (d) => `PO after receipt: ${d}`, age: 12, stop: 'approved', comment: 'Approved after review of the delivery note and rate.',
      summary: 'Seal sets received for a cylinder overhaul before the PO was raised.',
      reason: 'Cylinder overhaul could not wait; seal sets were collected from the vendor against a delivery challan.' },
  ];
  for (const d of direct) {
    const l = line(d.ref);
    if (!l) { warn(`PR line ${d.ref} missing`); continue; }
    const value = Math.round(l.qty * (l.est_unit_price ?? 0));
    try {
      const ap = createApproval(buyerOf(l.buyer_id), {
        type: d.type, objectType: 'pr_line', objectId: l.id, title: d.title(`${l.description} (${d.ref})`), summary: d.summary, value, reason: d.reason,
        context: { pr_ref: d.ref, material: l.description, qty: l.qty, plant: l.plant }, urgency: l.priority, plant: l.plant, categoryCode: l.category,
      });
      if (d.stop === 'l1') approveThrough(ap.id, d.comment ?? 'Approved.', 1);
      if (d.stop === 'approved') approveThrough(ap.id, d.comment ?? 'Approved.');
      ageApproval(ap.id, d.age);
    } catch (e) { warn(`${d.type} on ${d.ref} skipped: ${(e as Error).message}`); }
  }

  // Price amendment exceptions on open extra POs (vendor asked for a price increase after the PO was released).
  const pos = all<{ id: number; po_no: string; buyer_id: number | null; total_value: number | null; plant: string }>(
    "SELECT id, po_no, buyer_id, total_value, plant FROM pos WHERE po_no >= '4500031001' AND po_no < '4500032000' AND status = 'Published' AND total_value > 20000 ORDER BY po_no LIMIT 12",
  );
  const amend: { pick: number; pct: number; age: number; stop: 'pending' | 'l1'; why: string }[] = [
    { pick: 2, pct: 6, age: 1.4, stop: 'pending', why: 'Vendor reports a manufacturer price revision effective after the PO date and asks for the revised basic price.' },
    { pick: 5, pct: 3.5, age: 2.6, stop: 'l1', why: 'Vendor reports a freight surcharge on the road lane and asks to revise the unit price.' },
  ];
  for (const m of amend) {
    const po = pos[m.pick];
    if (!po) { warn('no open extra PO available for a price amendment exception'); continue; }
    const delta = Math.round((po.total_value ?? 0) * m.pct / 100);
    try {
      const ap = createApproval(buyerOf(po.buyer_id), {
        type: 'exc.price_amendment', objectType: 'po', objectId: po.id, title: `Price amendment on PO ${po.po_no}: +${m.pct}%`, summary: `${m.why} Increase of about ₹${delta.toLocaleString('en-IN')} on the PO value.`,
        value: delta, reason: m.why, context: { po_no: po.po_no, increase_pct: m.pct }, plant: po.plant,
      });
      if (m.stop === 'l1') approveThrough(ap.id, 'Procurement view: increase is documented by the vendor; Finance to confirm budget.', 1);
      ageApproval(ap.id, m.age);
    } catch (e) { warn(`price amendment on ${po.po_no} skipped: ${(e as Error).message}`); }
  }
}
