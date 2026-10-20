/**
 * Extended demo data for Module 11 (advances). Advances run through the real request and approval flow as the right
 * personas (buyer requests, procurement manager / finance / director approve), then the SAP side reports payment and
 * adjustment through sapPut('ADVPAY') + the inbound sync. Approval and advance dates are back-dated afterwards so the
 * ageing buckets (0-30, 31-60, 61-90, > 90 days) and the approval inbox all have rows. Deterministic; gated on DEMO_EXTRA
 * by seedPayments().
 */
import { all, get, run, tx, update, round2 } from '../../core/db.ts';
import { sapPut, syncEvent } from '../../core/sap.ts';
import { act, getApproval } from '../../core/approvals.ts';
import { cfg } from '../../core/config.ts';
import { actorFor, D, DAY } from '../../seed/ctx.ts';
import { EXTRA } from '../../seed/base_extra.ts';
import { tick } from '../invoices/seed.ts';
import * as S from './service.ts';

type State = 'returned' | 'pending1' | 'pending2' | 'pending3' | 'approved' | 'cancel-approved' | 'cancel-pending' | 'rejected' | 'paid' | 'partial' | 'full';
interface Case { tag: string; state: State; contract?: number; age: number; want: number; paidAgo?: number; adjusted?: number; reason: string }

const CASES: Case[] = [
  { tag: 'returned for changes', state: 'returned', age: 6, want: 0.25, reason: 'Vendor asks for a 25% advance to buy imported seal material before dispatch; proforma invoice attached.' },
  { tag: 'pending level 1 (new)', state: 'pending1', age: 2, want: 0.3, reason: 'Breakdown order for the mine site: vendor needs an advance to release the exchange unit before dispatch.' },
  { tag: 'pending level 1 (old)', state: 'pending1', age: 16, want: 0.2, reason: 'Advance for tooling and raw material as per the vendor quotation terms (30% with order, balance on delivery).' },
  { tag: 'pending level 2', state: 'pending2', age: 5, want: 0.3, reason: 'Vendor works to order and asked for a 30% advance with the PO; procurement manager has approved.' },
  { tag: 'pending level 3', state: 'pending3', contract: 1, age: 8, want: 1100000, reason: 'Season stocking advance under the lubricants ARC for the monsoon quarter; value above ten lakh needs director approval.' },
  { tag: 'approved, awaiting SAP payment', state: 'approved', age: 4, want: 0.25, reason: 'Advance agreed in the negotiation minutes; approved by procurement and finance, to be paid from SAP.' },
  { tag: 'cancelled after approval', state: 'cancel-approved', age: 9, want: 0.2, reason: 'Vendor requested an advance to start fabrication ahead of the delivery schedule.' },
  { tag: 'cancelled while pending', state: 'cancel-pending', age: 7, want: 0.15, reason: 'Advance requested for imported spares; vendor later agreed to supply against the normal terms.' },
  { tag: 'rejected by finance', state: 'rejected', age: 14, want: 0.3, reason: 'Vendor requested a 30% advance citing cash flow; the last two POs of this vendor were delivered late.' },
  { tag: 'paid, 0-30 days', state: 'paid', age: 13, paidAgo: 9, want: 0.3, reason: 'Advance for exchange cores as per the BD order terms, approved and paid in SAP.' },
  { tag: 'paid, 31-60 days', state: 'paid', contract: 9, age: 48, paidAgo: 44, want: 0.1, reason: 'Season stocking advance for safety footwear under the fixed supplier agreement.' },
  { tag: 'paid, 61-90 days', state: 'paid', contract: 6, age: 80, paidAgo: 76, want: 0.1, reason: 'Advance for the electrical spares annual programme under the fixed supplier agreement.' },
  { tag: 'paid, over 90 days', state: 'paid', contract: 2, age: 134, paidAgo: 130, want: 0.05, reason: 'Opening advance for the vendor managed inventory programme, to be adjusted against monthly invoices.' },
  { tag: 'partially adjusted, 31-60 days', state: 'partial', contract: 7, age: 63, paidAgo: 58, want: 0.1, adjusted: 0.4, reason: 'Annual hydraulic seal ARC: advance for the first lot of imported seal compound.' },
  { tag: 'partially adjusted, over 90 days', state: 'partial', contract: 4, age: 118, paidAgo: 113, want: 0.05, adjusted: 0.3, reason: 'Advance under the undercarriage ARC for the forged blanks; adjusted against two deliveries so far.' },
  { tag: 'fully adjusted', state: 'full', contract: 8, age: 101, paidAgo: 96, want: 0.02, adjusted: 1, reason: 'Engine wear parts ARC: advance against the first call-off, fully adjusted by subsequent invoices.' },
];

export function seedExtra() {
  let sapDoc = 1700000500;
  const buyerLocal = (id: number | null) => (id ? get<{ email: string }>('SELECT email FROM users WHERE id = ?', id)?.email.split('@')[0] : null) ?? 'amit.kulkarni';

  // Open POs without an advance, biggest first.
  const pos = all<{ id: number; po_no: string; po_date: string; total_value: number; buyer_id: number | null }>(
    `SELECT p.id, p.po_no, p.po_date, p.total_value, p.buyer_id FROM pos p WHERE p.po_no >= ? AND p.status IN ('Published','Partially received')
       AND NOT EXISTS (SELECT 1 FROM advances a WHERE a.po_id = p.id) AND p.total_value >= 60000 ORDER BY p.total_value DESC`, String(EXTRA.poOpenFrom),
  );
  const taken = new Set<number>();

  function backdate(advId: number, age: number) {
    const a = S.getAdvance(advId)!;
    if (!a.approval_id) return;
    const ap = getApproval(a.approval_id)!;
    const timing = cfg<{ escalate_after_hours: number }>('approval.timing');
    const created = D(-age, 10);
    const acted = all<{ id: number; level: number }>('SELECT id, level FROM approval_steps WHERE approval_id = ? AND acted_at IS NOT NULL ORDER BY level, id', ap.id);
    let last = created;
    for (const s of acted) {
      last = D(-Math.max(age - (s.level - 1), 0), 11 + s.level * 2);
      run('UPDATE approval_steps SET acted_at = ? WHERE id = ?', last, s.id);
    }
    update('approvals', ap.id, { created_at: created, ...(ap.decided_at ? { decided_at: last } : {}) });
    const due = new Date(Date.parse(last) + timing.escalate_after_hours * 3600000).toISOString();
    run("UPDATE approval_steps SET due_at = ? WHERE approval_id = ? AND status = 'Pending'", due, ap.id);
  }

  function runCase(c: Case) {
    const requester = (() => {
      if (c.contract) return c.state === 'pending3' ? 'sneha.patil' : ['amit.kulkarni', 'sneha.patil'][c.contract % 2];
      return 'amit.kulkarni';
    })();
    let anchor: { po_id?: number; contract_id?: number };
    let amount: number;
    let who = requester;
    if (c.contract) {
      const k = get<{ id: number; contract_no: string; value_cap: number | null; consumed_value: number; status: string }>('SELECT id, contract_no, value_cap, consumed_value, status FROM contracts WHERE id = ?', c.contract);
      if (!k || !['Active', 'Expiring'].includes(k.status)) throw new Error(`contract ${c.contract} is not available for advances`);
      const committed = all<{ amount: number }>("SELECT amount FROM advances WHERE contract_id = ? AND status NOT IN ('Rejected','Cancelled')", k.id).reduce((s, a) => s + a.amount, 0);
      const room = (k.value_cap ?? 0) - k.consumed_value - committed;
      const wanted = c.want > 1 ? c.want : (k.value_cap ?? 0) * c.want;
      amount = Math.max(5000, Math.round(Math.min(wanted, room * 0.5) / 1000) * 1000);
      anchor = { contract_id: k.id };
    } else {
      const po = pos.find((p) => !taken.has(p.id) && p.po_date <= DAY(-c.age)) ?? pos.find((p) => !taken.has(p.id));
      if (!po) throw new Error('no open PO left for another advance');
      taken.add(po.id);
      amount = Math.max(5000, Math.round((po.total_value * c.want) / 1000) * 1000);
      anchor = { po_id: po.id };
      who = buyerLocal(po.buyer_id);
    }
    const reqActor = actorFor(who);
    const adv = S.withClock(D(-c.age, 10), () => S.requestAdvance(reqActor, { ...anchor, amount, reason: c.reason }));
    const apId = adv.approval_id!;
    const l1 = () => act(actorFor('vikram.joshi', 'APR'), apId, 'approve', 'Within the agreed commercial terms.');
    const l2 = () => act(actorFor(adv.id % 2 ? 'meera.iyer' : 'kiran.shah'), apId, 'approve', 'Cash flow planned for the payment run.');
    const l3 = () => act(actorFor('rajesh.menon'), apId, 'approve', 'Approved for the season stocking programme.');

    if (c.state === 'returned') act(actorFor('vikram.joshi', 'APR'), apId, 'return', 'Attach the vendor proforma invoice and confirm the advance percentage with the vendor.');
    else if (c.state === 'pending2') l1();
    else if (c.state === 'pending3') { l1(); l2(); }
    else if (c.state === 'cancel-pending') S.withClock(D(-c.age + 2, 12), () => S.cancelAdvance(reqActor, adv.id, 'Vendor agreed to supply on the normal payment terms; the advance is no longer needed.'));
    else if (c.state === 'rejected') { l1(); act(actorFor('meera.iyer'), apId, 'reject', 'Not supported: the vendor has two late deliveries open. Revisit after they are cleared.'); }
    else if (['approved', 'cancel-approved', 'paid', 'partial', 'full'].includes(c.state)) {
      l1(); l2();
      if (c.state === 'cancel-approved') S.withClock(D(-c.age + 3, 12), () => S.cancelAdvance(reqActor, adv.id, 'Vendor delivered ahead of schedule; the advance is no longer required.'));
    }
    backdate(adv.id, c.age);

    if (['paid', 'partial', 'full'].includes(c.state)) {
      const adjusted = c.state === 'paid' ? 0 : round2(amount * (c.adjusted ?? 0));
      tick();
      sapPut('ADVPAY', adv.adv_no, { adv_no: adv.adv_no, sap_doc: String(sapDoc++), paid_date: DAY(-(c.paidAgo ?? 5)), amount_paid: amount, adjusted_amount: adjusted }, 'Seed');
      syncEvent('ADVPAY');
    }
  }

  for (const c of CASES) {
    try { tx(() => runCase(c)); } catch (e) { console.warn(`payments seed_extra: skipped "${c.tag}": ${(e as Error).message}`); }
  }
}
