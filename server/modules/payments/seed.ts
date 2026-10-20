/** Module 11 demo scenarios: a BD advance pending approval and an older paid, partially adjusted advance. */
import { get, update, tx, round2 } from '../../core/db.ts';
import { sapPut, syncEvent } from '../../core/sap.ts';
import { act } from '../../core/approvals.ts';
import { actorFor, D, DAY } from '../../seed/ctx.ts';
import * as S from './service.ts';
import { tick } from '../invoices/seed.ts';
import { DEMO_EXTRA } from '../../core/mode.ts';
import { seedExtra } from './seed_extra.ts';

function scenario(name: string, fn: () => void) {
  try { tx(fn); } catch (e) { console.warn(`[payments seed] skipped "${name}": ${(e as Error).message}`); }
}

export function seedPayments() {
  // Deccan 4500021004 (BD) — 30% advance, pending approval.
  scenario('Deccan BD advance', () => {
    const po = get<{ id: number; total_value: number }>("SELECT id, total_value FROM pos WHERE po_no = '4500021004'");
    if (!po) return;
    S.withClock(D(-2), () => S.requestAdvance(actorFor('amit.kulkarni'), {
      po_id: po.id, amount: round2(po.total_value * 0.3),
      reason: 'Breakdown order: Deccan needs a 30% advance to release the exchange turbocharger core before dispatch.',
    }));
  });

  // Western Lubricants ARC — older advance, approved, paid in SAP and partially adjusted (> 60 days).
  scenario('Western Lubricants advance', () => {
    const k = get<{ id: number }>("SELECT id FROM contracts WHERE sap_oa_no = '5500000101'");
    if (!k) return;
    const a = S.withClock(D(-82), () => S.requestAdvance(actorFor('sneha.patil'), { contract_id: k.id, amount: 150000, reason: 'Season stocking advance under the lubricants ARC, agreed in the annual negotiation.' }));
    const ap = get<{ id: number }>('SELECT approval_id AS id FROM advances WHERE id = ?', a.id)!;
    act(actorFor('vikram.joshi', 'APR'), ap.id, 'approve', 'Within ARC terms.');
    act(actorFor('meera.iyer'), ap.id, 'approve', 'Cash flow planned.');
    update('approvals', ap.id, { created_at: D(-82), decided_at: D(-81) });
    sapPut('ADVPAY', a.adv_no, { adv_no: a.adv_no, sap_doc: '1700000412', paid_date: DAY(-78), amount_paid: 150000, adjusted_amount: 0 }, 'Seed');
    syncEvent('ADVPAY');
    tick();
    sapPut('ADVPAY', a.adv_no, { adv_no: a.adv_no, sap_doc: '1700000412', paid_date: DAY(-78), amount_paid: 150000, adjusted_amount: 90000 }, 'Seed');
    syncEvent('ADVPAY');
  });

  if (DEMO_EXTRA) seedExtra();
}
