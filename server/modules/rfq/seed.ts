/**
 * Demo RFQs (WF-01, WF-03, WF-04, WF-05). PR lines are checked and routed through the Module 1 service as
 * their assigned buyer first; a scenario whose lines are not in the expected state is skipped.
 */
import { get, run, tx } from '../../core/db.ts';
import { permsFor } from '../../core/permissions.ts';
import type { Actor } from '../../core/auth.ts';
import { actorFor, PRL, V, D, DAY } from '../../seed/ctx.ts';
import { getLine, runChecks, decideRoute, RFQ_ROUTES, type RouteName } from '../pr/service.ts';
import * as S from './service.ts';
import * as Q from './quotes.ts';
import { DEMO_EXTRA } from '../../core/mode.ts';
import { seedExtra } from './seed_extra.ts';

function routed(actor: Actor, refs: string[]) {
  const ids: number[] = [];
  for (const ref of refs) {
    let id: number;
    try { id = PRL(ref); } catch { console.warn(`rfq seed: PR line ${ref} missing — skipped`); return null; }
    let l = getLine(id)!;
    if (l.buyer_id !== actor.id) { console.warn(`rfq seed: ${ref} not assigned to ${actor.name}`); return null; }
    if (['Assigned', 'Under review', 'Synced'].includes(l.status)) l = runChecks(actor, id);
    if (l.status === 'Under review' && l.route_proposed && RFQ_ROUTES.includes(l.route_proposed as RouteName)) l = decideRoute(actor, id, { route: l.route_proposed as RouteName, acknowledgeStale: true });
    if (l.status !== 'Route decided' || l.rfq_id) { console.warn(`rfq seed: ${ref} is ${l.status} — scenario skipped`); return null; }
    ids.push(id);
  }
  return ids;
}

function vendorActor(code: string): Actor {
  const vid = V(code);
  const u = get<{ email: string }>("SELECT email FROM users WHERE vendor_id = ? AND active = 1 ORDER BY id LIMIT 1", vid);
  if (u) return actorFor(u.email.split('@')[0], 'VEN');
  const v = get<{ name: string; contact_name: string | null; contact_email: string | null }>('SELECT name, contact_name, contact_email FROM vendors WHERE id = ?', vid)!;
  // Vendors without a portal user (quotation keyed in during the demo history).
  return { id: 0, name: `${v.contact_name ?? 'Vendor'} (${v.name})`, email: v.contact_email ?? '', roles: ['VEN'], role: 'VEN', perms: permsFor('VEN'), vendorId: vid, plants: '*', categories: [], department: null, sessionId: 'seed', channel: 'seed' };
}

type L = Partial<Q.QLine>;
function quote(rfqId: number, code: string, header: Partial<Q.QHeader>, byLine: Record<number, L>, submitNow = true) {
  const a = vendorActor(code);
  Q.vendorView(a, rfqId);
  const lines = S.linesOf(rfqId).map((l) => ({ rfq_line_id: l.id, ...(byLine[l.line_no] ?? { no_quote: true }) }));
  if (submitNow) Q.submit(a, rfqId, { header, lines });
  else Q.saveDraft(a, rfqId, { header, lines });
}

function scenario(name: string, fn: () => void) {
  try { tx(fn); } catch (e) { console.warn(`rfq seed: scenario ${name} skipped — ${(e as Error).message}`); }
}

function backdate(rfqId: number, publishedDays: number) {
  run('UPDATE rfqs SET created_at = ?, published_at = ? WHERE id = ?', D(publishedDays - 1), D(publishedDays), rfqId);
  run('UPDATE rfq_invitations SET sent_at = ? WHERE rfq_id = ? AND sent_at IS NOT NULL', D(publishedDays), rfqId);
  run('UPDATE rfq_invitations SET viewed_at = ? WHERE rfq_id = ? AND viewed_at IS NOT NULL', D(publishedDays + 0.3), rfqId);
}

function closeAt(rfqId: number, at: string) {
  run('UPDATE rfqs SET closing_at = ? WHERE id = ?', at, rfqId);
  run('UPDATE rfq_lines SET due_at = ? WHERE rfq_id = ?', at, rfqId);
  S.closeRfq(null, rfqId, 'auto');
  run('UPDATE rfqs SET closed_at = ? WHERE id = ?', at, rfqId);
}

export function seed() {
  const amit = actorFor('amit.kulkarni');
  const sneha = actorFor('sneha.patil');
  const validity = DAY(60);

  // RFQ A — Published, sealed, closing in 3 days (HYD; lines from two PRs and two plants — WF-05).
  scenario('A', () => {
    const ids = routed(amit, ['10045501/10', '10045501/20', '10045515/10']);
    if (!ids) return;
    const r = S.createRfq(amit, { pr_line_ids: ids, title: 'Hydraulic seal kits and O-ring kits — Chakan & Nagpur', closing_at: D(3, 17) });
    for (const c of ['100101', '100116', '100106']) S.addInvitation(amit, r.id, V(c));
    S.publish(amit, r.id);
    backdate(r.id, -1);
    quote(r.id, '100101', { payment_terms: '45 days from GRN', credit_days: 45, delivery_terms: 'FOR' }, {
      10: { basic_price: 18200, discount_pct: 2, gst_rate: 18, delivery_days: 10, make_brand: 'Hydrotech', warranty: '12 months' },
      20: { basic_price: 2600, gst_rate: 18 },
    }, false);
    quote(r.id, '100106', { payment_terms: '30 days from GRN', credit_days: 30, delivery_terms: 'Ex-Works', validity_date: validity, remarks: 'Prices ex our Hyderabad works; dispatch by road.' }, {
      10: { basic_price: 18650, discount_pct: 1.5, gst_rate: 18, freight: 0, packing: 400, delivery_days: 14, make_brand: 'NOK (Japan)', warranty: '12 months' },
      20: { basic_price: 2490, discount_pct: 0, gst_rate: 18, freight: 0, packing: 200, delivery_days: 7, make_brand: 'Assorted metric — Trelleborg', warranty: '6 months' },
      30: { basic_price: 2490, discount_pct: 0, gst_rate: 18, freight: 0, packing: 150, delivery_days: 7, make_brand: 'Assorted metric — Trelleborg', warranty: '6 months' },
    });
  });

  // RFQ B — Closed yesterday: front idler (LPP ₹2,95,000), FOR and Ex-Works quotes, one alternate brand.
  scenario('B', () => {
    const ids = routed(amit, ['10045513/20']);
    if (!ids) return;
    const r = S.createRfq(amit, { pr_line_ids: ids, title: 'Front idler assembly – EX1200 for Chakan', closing_at: D(2, 17) });
    for (const c of ['100102', '100115', '100103']) S.addInvitation(amit, r.id, V(c));
    S.publish(amit, r.id);
    backdate(r.id, -6);
    quote(r.id, '100102', { payment_terms: '60 days from GRN', credit_days: 60, delivery_terms: 'FOR', validity_date: validity }, { 10: { basic_price: 289000, discount_pct: 2, gst_rate: 18, freight: 6500, packing: 1500, delivery_days: 21, make_brand: 'Shakti', warranty: '12 months from fitment' } });
    quote(r.id, '100115', { payment_terms: '45 days from GRN', credit_days: 45, delivery_terms: 'Ex-Works', validity_date: validity, remarks: 'Ex-Works Coimbatore; buyer to arrange transport.' }, { 10: { basic_price: 284500, discount_pct: 0, gst_rate: 18, freight: 0, packing: 2000, delivery_days: 28, make_brand: 'Coromandel', warranty: '12 months' } });
    quote(r.id, '100103', { payment_terms: '30 days from GRN', credit_days: 30, delivery_terms: 'FOR', validity_date: validity }, { 10: { basic_price: 268000, discount_pct: 1, gst_rate: 18, freight: 4500, packing: 1200, delivery_days: 35, make_brand: 'ITR (Italy)', warranty: '9 months', alternate: true, remarks: 'Alternate make — ITR idler, dimensionally interchangeable.' } });
    closeAt(r.id, D(-1, 17));
  });

  // RFQ C — Closed, urgent breakdown at Dhanbad (route Urgent/BD — WF-04); cheapest landed vendor is the slowest.
  scenario('C', () => {
    const ids = routed(amit, ['10045504/10', '10045504/20']);
    if (!ids) return;
    const r = S.createRfq(amit, { pr_line_ids: ids, title: 'BD: track chain and sprocket set – D375A, Dhanbad', closing_at: D(1, 17) });
    for (const c of ['100102', '100115', '100109']) S.addInvitation(amit, r.id, V(c));
    S.publish(amit, r.id);
    backdate(r.id, -2);
    quote(r.id, '100102', { payment_terms: '60 days from GRN', credit_days: 60, delivery_terms: 'FOR', validity_date: validity }, {
      10: { basic_price: 679000, discount_pct: 1.5, gst_rate: 18, freight: 18000, packing: 4000, delivery_days: 10, make_brand: 'Shakti', warranty: '4000 hours or 12 months' },
      20: { basic_price: 141000, discount_pct: 1.5, gst_rate: 18, freight: 3000, packing: 1000, delivery_days: 10, make_brand: 'Shakti', warranty: '12 months' },
    });
    quote(r.id, '100115', { payment_terms: '45 days from GRN', credit_days: 45, delivery_terms: 'FOR', validity_date: validity }, {
      10: { basic_price: 668000, discount_pct: 0, gst_rate: 18, freight: 22000, packing: 3000, delivery_days: 7, make_brand: 'Coromandel', warranty: '12 months' },
      20: { basic_price: 139500, discount_pct: 0, gst_rate: 18, freight: 2500, packing: 800, delivery_days: 7, make_brand: 'Coromandel', warranty: '12 months' },
    });
    quote(r.id, '100109', { payment_terms: '30 days from GRN', credit_days: 30, delivery_terms: 'FOR', validity_date: validity, remarks: 'Local Dhanbad stockist; chain sourced from Berco distributor.' }, {
      10: { basic_price: 652000, discount_pct: 1, gst_rate: 18, freight: 4000, packing: 2000, delivery_days: 21, make_brand: 'Berco', warranty: '12 months' },
      20: { basic_price: 136000, discount_pct: 1, gst_rate: 18, freight: 1000, packing: 500, delivery_days: 21, make_brand: 'Berco', warranty: '12 months' },
    });
    closeAt(r.id, new Date(Date.now() - 4 * 3600000).toISOString());
  });

  // RFQ D — Draft by Sneha: welding consumables (repeat purchase; one suggested vendor → limited-source path on publish).
  scenario('D', () => {
    const ids = routed(sneha, ['10045510/10', '10045510/20']);
    if (!ids) return;
    const r = S.createRfq(sneha, { pr_line_ids: ids, title: 'Welding electrodes and hardfacing wire — Nagpur' });
    S.addInvitation(sneha, r.id, V('100107'));
  });

  if (DEMO_EXTRA) seedExtra();
}
