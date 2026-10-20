/**
 * Extended demo data for Modules 2 and 3 (RFQs and vendor quotations).
 *
 * Grows the RFQ list from 4 to ~30 in every state (Draft, Pending approval, Published with mixed vendor participation and
 * closing dates incl. one closing today, Closed, Under comparison, Awarded, Cancelled, Re-floated), plus one annual-rate RFQ
 * raised from an ARC opportunity. Every RFQ is built through the services as the assigned buyer; vendor quotations are entered
 * as the vendor (portal user, or a synthesised vendor contact when the vendor has no portal user) with prices around the
 * material's last purchase price, different delivery days, GST, freight, FOR / Ex-Works, alternates, partial quantities,
 * declines and non-responders. Dates are shifted back afterwards with SQL on the domain rows only (the audit log is never edited).
 *
 * RFQs that are meant to end up with a comparative statement are left Closed here and registered in COMPARE_PLAN; the
 * comparison seed (Module 4) picks them up and takes each to its planned state.
 */
import { all, get, insert, J, run, scalar, tx, update } from '../../core/db.ts';
import { permsFor } from '../../core/permissions.ts';
import type { Actor } from '../../core/auth.ts';
import { actorFor, D, DAY } from '../../seed/ctx.ts';
import { getLine, runChecks, decideRoute, RFQ_ROUTES, type RouteName } from '../pr/service.ts';
import { ageApproval, ago, decide, rng } from '../approvals/seed_extra.ts';
import { ineligibility } from './suggest.ts';
import { opportunityJob, acceptOpportunity } from '../contracts/service.ts';
import * as S from './service.ts';
import * as Q from './quotes.ts';

// ------------------------------------------------------------------ plan shared with the comparison seed
export type CmpKind = 'draft' | 'rec' | 'sub1' | 'sub2' | 'sub3' | 'approved' | 'returned' | 'rejected' | 'released' | 'discount';
/** Days before now at which each step happened (already fitted to the age of the PR lines). */
export interface Timeline { pub: number; close: number; cmp: number; rec: number; sub: number; dec: number; rel: number }
export interface CmpPlan {
  rfqId: number; buyer: string; kind: CmpKind; t: Timeline;
  /** Award to this vendor on every line (historic RFQs that ended in a PO); a reason is recorded when it is not the lowest landed cost. */
  awardVendorId?: number; po?: { id: number; no: string };
  /** After a return, the buyer asks to reopen quotations for one vendor. */
  reopenAfterReturn?: boolean;
}
export const COMPARE_PLAN: CmpPlan[] = [];

// ------------------------------------------------------------------ helpers
const warn = (m: string) => console.warn(`rfq seed_extra: ${m}`);

function buyerActor(local: string): Actor { return actorFor(local, 'BUY'); }

export function vendorActor(vendorId: number): Actor {
  const u = get<{ email: string }>('SELECT email FROM users WHERE vendor_id = ? AND active = 1 ORDER BY id LIMIT 1', vendorId);
  if (u) return actorFor(u.email.split('@')[0], 'VEN');
  const v = get<{ name: string; contact_name: string | null; contact_email: string | null }>('SELECT name, contact_name, contact_email FROM vendors WHERE id = ?', vendorId)!;
  return { id: 0, name: `${v.contact_name ?? 'Vendor'} (${v.name})`, email: v.contact_email ?? '', roles: ['VEN'], role: 'VEN', perms: permsFor('VEN'), vendorId, plants: '*', categories: [], department: null, sessionId: 'seed', channel: 'seed' };
}

/** PR lines of a scenario ready for an RFQ: route decided (by the PR seed), or checked and routed here as the buyer. */
function routedIds(actor: Actor, refs: string[]) {
  const ids: number[] = [];
  for (const ref of refs) {
    const [pr, item] = ref.split('/');
    const row = get<{ id: number }>('SELECT id FROM pr_lines WHERE pr_no = ? AND item = ?', pr, Number(item));
    if (!row) throw new Error(`PR line ${ref} missing`);
    let l = getLine(row.id)!;
    if (l.buyer_id !== actor.id) throw new Error(`${ref} is not assigned to ${actor.name}`);
    if (['Assigned', 'Under review', 'Synced'].includes(l.status)) l = runChecks(actor, row.id);
    if (l.status === 'Under review' && l.route_proposed && RFQ_ROUTES.includes(l.route_proposed as RouteName)) l = decideRoute(actor, row.id, { route: l.route_proposed as RouteName, acknowledgeStale: true });
    if (l.status !== 'Route decided' || l.rfq_id) throw new Error(`${ref} is ${l.status}${l.rfq_id ? ' (already in an RFQ)' : ''}`);
    ids.push(row.id);
  }
  return ids;
}

/** Scale a scenario's timeline so that nothing happens before the buyer could have routed its PR lines. */
function fit(refs: string[] | null) {
  let minAge = Infinity;
  for (const ref of refs ?? []) {
    const [pr, item] = ref.split('/');
    const a = get<{ assigned_at: string | null }>('SELECT assigned_at FROM pr_lines WHERE pr_no = ? AND item = ?', pr, Number(item))?.assigned_at;
    if (a) minAge = Math.min(minAge, (Date.now() - Date.parse(a)) / 86400000);
  }
  return (maxOffset: number) => {
    const f = Number.isFinite(minAge) ? Math.min(1, Math.max(0.02, minAge * 0.78 - 0.05) / (maxOffset + 0.4)) : 1;
    return (d: number) => d * f;
  };
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
/** 17:00 IST on the day `days` ahead. */
const closingAt = (days: number) => { const x = new Date(Date.now() + days * 86400000); x.setUTCHours(11, 30, 0, 0); return x.toISOString(); };

function setClosing(rfqId: number, at: string) {
  run('UPDATE rfqs SET closing_at = ? WHERE id = ?', at, rfqId);
  run("UPDATE rfq_lines SET due_at = ? WHERE rfq_id = ? AND status != 'Removed'", at, rfqId);
}

const FAMILIES = [['HYD', 'UCG', 'ENG', 'FLT'], ['LUB', 'FLT', 'WLD'], ['ELE', 'TLS', 'PPE', 'WLD'], ['SRV', 'LOG', 'CAP', 'UCG', 'ENG'], ['TLS', 'PPE', 'WLD', 'CAP']];

/** Invite the first n suggested vendors; top up with the best-rated eligible vendors of related categories (with a justification). */
function invite(buyer: Actor, rfqId: number, n: number) {
  const out: number[] = [];
  for (const v of S.suggestions(rfqId).vendors) { if (out.length >= n) break; S.addInvitation(buyer, rfqId, v.vendor_id); out.push(v.vendor_id); }
  if (out.length < n) {
    const cat = get<{ category: string | null }>('SELECT category FROM rfqs WHERE id = ?', rfqId)?.category ?? '';
    const related = [...new Set(FAMILIES.filter((f) => f.includes(cat)).flat().concat(cat))];
    const have = new Set(S.invitationsOf(rfqId).map((i) => i.vendor_id));
    const cands = all<{ id: number; category: string }>(
      `SELECT v.id, c.category FROM vendors v JOIN vendor_capabilities c ON c.vendor_id = v.id AND c.status = 'Approved'
       WHERE v.sap_code IS NOT NULL AND v.sap_blocked = 0 AND c.category IN (${related.map(() => '?').join(',')})
       ORDER BY (c.category = ?) DESC, v.performance_score DESC, v.id`, ...related, cat,
    );
    for (const v of cands) {
      if (out.length >= n) break;
      if (have.has(v.id) || ineligibility(v.id).length) continue;
      have.add(v.id);
      S.addInvitation(buyer, rfqId, v.id, `Approved supplier of related items (${v.category}); added to widen the field and benchmark prices.`);
      out.push(v.id);
    }
  }
  return out;
}

const BRANDS: Record<string, string[]> = {
  HYD: ['Hydrotech', 'NOK', 'Trelleborg', 'Parker'], UCG: ['Shakti', 'Berco', 'ITR', 'Coromandel'], ENG: ['Cummins genuine', 'Bosch', 'Mahle', 'Federal-Mogul'],
  FLT: ['Donaldson', 'Fleetguard', 'Mann', 'Baldwin'], LUB: ['Servo', 'Castrol', 'Shell', 'Mobil'], WLD: ['ESAB', 'Ador', 'Lincoln'], ELE: ['Exide', 'Bosch', 'Amara Raja', 'Philips'],
  TLS: ['Stanley', 'Taparia', 'Bosch'], PPE: ['Karam', 'Udyogi', '3M'], SRV: ['Own workshop'], CAP: ['OEM supplied'], LOG: ['Own fleet'],
};
const TERMS: [string, number][] = [['30 days from GRN', 30], ['45 days from GRN', 45], ['60 days from GRN', 60], ['30 days from invoice', 30]];
const DECLINE = ['Not stocking this item at the moment.', 'Cannot meet the required delivery date.', 'Capacity is committed to OEM orders this month.', 'Item discontinued by the manufacturer; no equivalent available.'];

interface PriceOverride { price: number; days?: number; disc?: number; freightPct?: number; ex?: boolean }
type Token = 'q' | 'qx' | 'qa' | 'qp' | 'q1' | 'd' | 'v' | 'n' | 's';

/**
 * One vendor's reaction: q quote (FOR), qx quote Ex-Works, qa quote with an alternate make on line 1, qp partial quantity on
 * line 1, q1 quote line 1 only, d decline, v viewed only, n no reaction, s saved a draft.
 */
function respond(rfqId: number, vendorId: number, token: Token, idx: number, rnd: () => number, urgent: boolean, over?: (vendorId: number, line: S.RfqLine) => PriceOverride | null) {
  if (token === 'n') return;
  const a = vendorActor(vendorId);
  Q.vendorView(a, rfqId);
  if (token === 'v') return;
  if (token === 'd') { Q.decline(a, rfqId, DECLINE[(rfqId + idx) % DECLINE.length]); return; }
  const lines = S.linesOf(rfqId).filter((l) => l.status !== 'Removed');
  const cat = get<{ category: string | null }>('SELECT category FROM rfqs WHERE id = ?', rfqId)?.category ?? 'HYD';
  const brands = BRANDS[cat] ?? ['Assorted'];
  const factor = 0.93 + 0.14 * rnd();
  const ex = token === 'qx' || (token === 'q' && rnd() < 0.2);
  const terms = TERMS[Math.floor(rnd() * TERMS.length)];
  const qlines: Partial<Q.QLine>[] = lines.map((l, i) => {
    if (token === 'q1' && i > 0) return { rfq_line_id: l.id, no_quote: true };
    const lpp = l.material_id ? get<{ lpp: number | null }>('SELECT lpp FROM materials WHERE id = ?', l.material_id)?.lpp : null;
    const est = l.pr_line_id ? get<{ est_unit_price: number | null }>('SELECT est_unit_price FROM pr_lines WHERE id = ?', l.pr_line_id)?.est_unit_price : null;
    const base = lpp ?? est ?? 1000;
    const o = over?.(vendorId, l) ?? null;
    const price = o ? o.price : Math.round(base * factor * (0.985 + 0.03 * rnd()) * (base > 200 ? 1 : 100)) / (base > 200 ? 1 : 100);
    const exw = o?.ex ?? ex;
    const value = price * l.qty;
    const alt = token === 'qa' && i === 0;
    const part = token === 'qp' && i === 0 && l.qty > 1;
    return {
      rfq_line_id: l.id, no_quote: false, quoted_qty: part ? Math.max(1, Math.floor(l.qty * 0.6)) : l.qty,
      basic_price: alt ? Math.round(price * 0.94) : price, discount_pct: o?.disc ?? [0, 0, 1, 1.5, 2, 3][Math.floor(rnd() * 6)], gst_rate: l.gst_rate ?? 18,
      freight: exw ? 0 : Math.round(value * (o?.freightPct ?? 0.004 + 0.012 * rnd())), packing: Math.round(value * (exw ? 0.002 : 0.003)),
      delivery_days: o?.days ?? (urgent ? 3 + Math.floor(rnd() * 7) : 5 + Math.floor(rnd() * 28)), make_brand: alt ? `Alternate: ${brands[(idx + 2) % brands.length]} (equivalent)` : brands[idx % brands.length],
      warranty: ['6 months', '12 months', '12 months'][Math.floor(rnd() * 3)], alternate: alt,
      remarks: alt ? 'Alternate make, dimensionally interchangeable; test certificate supplied.' : part ? 'Balance quantity available after two weeks.' : null,
    };
  });
  const header = { payment_terms: terms[0], credit_days: terms[1], delivery_terms: ex ? 'Ex-Works' : 'FOR', validity_date: DAY(40 + Math.floor(rnd() * 30)), remarks: ex ? 'Ex-Works our godown; buyer to arrange transport.' : null };
  if (token === 's') Q.saveDraft(a, rfqId, { header, lines: qlines });
  else Q.submit(a, rfqId, { header, lines: qlines });
}

/** Re-time invitations, quotations and versions of an RFQ between its publication and its close (or now). */
function retime(rfqId: number, pubAgo: number, closeAgo: number | null) {
  const t0 = Date.now() - pubAgo * 86400000;
  const t1 = closeAgo == null ? Date.now() - 30 * 60000 : Date.now() - closeAgo * 86400000;
  const r = rng(rfqId * 31 + 7);
  const at = (t: number) => new Date(Math.min(t, t1)).toISOString();
  run('UPDATE rfqs SET created_at = ?, published_at = ? WHERE id = ?', new Date(t0 - Math.min(0.35, 0.1 * pubAgo + 0.02) * 86400000).toISOString(), new Date(t0).toISOString(), rfqId);
  let i = 0;
  for (const inv of all<{ id: number; vendor_id: number; sent_at: string | null; viewed_at: string | null; responded_at: string | null; declined_at: string | null }>('SELECT * FROM rfq_invitations WHERE rfq_id = ? ORDER BY id', rfqId)) {
    if (!inv.sent_at) { i++; continue; }
    const sent = t0 + 120000 + i * 45000;
    const viewed = inv.viewed_at ? Math.max(sent + 600000, t0 + (t1 - t0) * (0.04 + 0.3 * r())) : null;
    const responded = inv.responded_at && viewed ? viewed + (t1 - viewed) * (0.15 + 0.6 * r()) : null;
    const declined = inv.declined_at && viewed ? viewed + (t1 - viewed) * (0.1 + 0.5 * r()) : null;
    update('rfq_invitations', inv.id, { sent_at: new Date(sent).toISOString(), viewed_at: viewed ? at(viewed) : null, responded_at: responded ? at(responded) : null, declined_at: declined ? at(declined) : null });
    const q = get<{ id: number; status: string; submitted_at: string | null }>('SELECT id, status, submitted_at FROM quotations WHERE rfq_id = ? AND vendor_id = ?', rfqId, inv.vendor_id);
    if (q) {
      const when = responded ?? declined ?? (viewed ? viewed + 3600000 : sent);
      update('quotations', q.id, { created_at: viewed ? at(viewed) : at(sent), updated_at: at(when), ...(q.submitted_at ? { submitted_at: at(responded ?? when) } : {}) });
      run('UPDATE quotation_versions SET created_at = ? WHERE quotation_id = ?', at(responded ?? when), q.id);
    }
    i++;
  }
}

/** Close an RFQ at a time in the past (quotations lock, non-responders are marked). */
function closeAt(rfqId: number, closeAgo: number) {
  setClosing(rfqId, iso(closeAgo));
  S.closeRfq(null, rfqId, 'auto');
  run('UPDATE rfqs SET closed_at = ? WHERE id = ?', iso(closeAgo), rfqId);
}

/** Closed RFQs: quotation validity runs from the close date, not from the day the seed happens to run. */
function fixValidity(rfqId: number, closeAgo: number) {
  const r = rng(rfqId * 53 + 3);
  for (const q of all<{ id: number; validity_date: string | null }>('SELECT id, validity_date FROM quotations WHERE rfq_id = ?', rfqId)) {
    if (!q.validity_date) continue;
    const v = new Date(Date.now() - closeAgo * 86400000 + (30 + Math.floor(30 * r())) * 86400000).toISOString().slice(0, 10);
    run('UPDATE quotations SET validity_date = ? WHERE id = ?', v, q.id);
    run("UPDATE quotation_versions SET header_json = json_set(header_json, '$.validity_date', ?) WHERE quotation_id = ?", v, q.id);
  }
}

/** Non-responders of an RFQ closing soon were reminded on the configured schedule. */
function markReminded(rfqId: number, closingInDays: number) {
  const days = closingInDays <= 1 ? [2, 1] : closingInDays <= 2 ? [2] : [];
  if (!days.length) return;
  const t = iso(Math.max(0.05, closingInDays <= 1 ? 0.3 : 0.15));
  run("UPDATE rfq_invitations SET reminders_sent = ?, last_reminder_at = ? WHERE rfq_id = ? AND sent_at IS NOT NULL AND status IN ('Invited','Viewed')", days.length, t, rfqId);
  run("UPDATE rfqs SET reminder_schedule_json = json_set(COALESCE(reminder_schedule_json, '{}'), '$.sent', json(?)) WHERE id = ?", J(days.map((d) => `before:${d}`)), rfqId);
}

interface Build {
  buyer: Actor; refs?: string[]; opportunityId?: number; plant?: string; title?: string; vendors: number; resp: Token[]; pub: number; close: number | null; closingIn?: number;
  closingToday?: boolean; urgent?: boolean; over?: (vendorId: number, line: S.RfqLine) => PriceOverride | null; prIds?: number[]; skipPublish?: boolean;
}

/** Create, invite, publish, collect responses and time-shift one RFQ. `pub`/`close` are days ago (already fitted). */
function build(o: Build) {
  const ids = o.prIds ?? (o.refs ? routedIds(o.buyer, o.refs) : undefined);
  const r = S.createRfq(o.buyer, o.opportunityId ? { opportunity_id: o.opportunityId, plant: o.plant, title: o.title, closing_at: closingAt(5) } : { pr_line_ids: ids, title: o.title, closing_at: closingAt(5) });
  const vendors = invite(o.buyer, r.id, o.vendors);
  if (o.skipPublish) return { id: r.id, vendors };
  const pub = S.publish(o.buyer, r.id);
  if (pub.status !== 'Published') return { id: r.id, vendors, pending: true as const };
  const rnd = rng(r.id * 977 + 13);
  vendors.forEach((v, i) => respond(r.id, v, o.resp[i] ?? 'n', i, rnd, !!o.urgent, o.over));
  if (o.close != null) { retime(r.id, o.pub, o.close); closeAt(r.id, o.close); fixValidity(r.id, o.close); }
  else {
    const at = o.closingToday ? ahead(0.125) : closingAt(o.closingIn ?? 3);
    setClosing(r.id, at);
    retime(r.id, o.pub, null);
    if (!o.closingToday) markReminded(r.id, o.closingIn ?? 3); else markReminded(r.id, 0.1);
  }
  return { id: r.id, vendors };
}

function scenario(name: string, fn: () => void) {
  try { tx(fn); } catch (e) { warn(`scenario ${name} skipped — ${(e as Error).message}`); }
}

function plan(rfqId: number, buyer: string, kind: CmpKind, t: Timeline, extra: Partial<CmpPlan> = {}) {
  COMPARE_PLAN.push({ rfqId, buyer, kind, t, ...extra });
}

/** Timeline for a comparison scenario; every offset is fitted to the age of the PR lines. */
function tline(T: (d: number) => number, x: Partial<Timeline> & { pub: number; close: number }): Timeline {
  const cmp = x.cmp ?? x.close - 0.3;
  const rec = x.rec ?? cmp - 0.5;
  const sub = x.sub ?? rec - 0.3;
  const dec = x.dec ?? sub - 0.8;
  const rel = x.rel ?? dec - 0.3;
  return { pub: T(x.pub), close: T(x.close), cmp: T(cmp), rec: T(rec), sub: T(sub), dec: T(dec), rel: T(rel) };
}

// ------------------------------------------------------------------ the seed
export function seedExtra() {
  COMPARE_PLAN.length = 0;
  const amit = buyerActor('amit.kulkarni');
  const sneha = buyerActor('sneha.patil');

  // Published, closing today — Dhanbad lights and filters; one quote in, one Ex-Works, one viewed, one silent.
  scenario('P1', () => {
    const refs = ['10046011/10', '10046011/20'];
    const T = fit(refs)(2.6);
    build({ buyer: sneha, refs, title: 'LED floodlights and transmission filters — Dhanbad', vendors: 4, resp: ['q', 'qx', 'v', 'n'], pub: T(2.6), close: null, closingToday: true });
  });

  // Published, closing in two days — mixed participation: quote, Ex-Works quote, decline, viewed only.
  scenario('P2', () => {
    const refs = ['10046025/10'];
    const T = fit(refs)(3.2);
    build({ buyer: amit, refs, title: 'Cutting edges, bolt-on 3.2 m — WA600, Nagpur', vendors: 4, resp: ['q', 'qx', 'd', 'v'], pub: T(3.2), close: null, closingIn: 1.8 });
  });

  // Published, urgent (Class 1 + Urgent, Dhanbad): short closing window, one alternate-make quote.
  scenario('P4', () => {
    const refs = ['10045509/10', '10045509/20'];
    const T = fit(refs)(0.45);
    build({ buyer: amit, refs, title: 'URGENT: boom cylinder seal kit and hydraulic hose assemblies — Dhanbad', vendors: 4, resp: ['q', 'qa', 'v', 'n'], pub: T(0.45), close: null, closingIn: 1.4, urgent: true });
  });

  // Annual-rate RFQ raised from an ARC opportunity (WF-03).
  scenario('ARC', () => {
    // The contracts seed (which runs later) decides the opportunities for these materials; this RFQ uses another one.
    const reserved = ['HYD-1008', 'LUB-5006', 'UCG-2010', 'LUB-5004', 'TLS-7005', 'ENG-3008', 'HYD-1001', 'LUB-5005', 'HYD-1003'];
    if (!scalar<number>('SELECT COUNT(*) FROM opportunities')) opportunityJob();
    const opps = all<{ id: number; code: string }>("SELECT o.id, m.code FROM opportunities o JOIN materials m ON m.id = o.material_id WHERE o.status = 'Identified' AND o.rfq_id IS NULL ORDER BY o.annual_value DESC, o.id").filter((o) => !reserved.includes(o.code));
    let done = false;
    const why: string[] = [];
    for (const o of opps) {
      try {
        tx(() => {
          const prev = S.opportunityPreview(o.id);
          // Accepting the opportunity prefills a draft ARC; the annual-rate RFQ is then raised from the same opportunity (FR-CON-08).
          const res = acceptOpportunity(amit, o.id, { note: `Spot purchases from several vendors across plants; run an annual-rate RFQ to consolidate into one ARC.` });
          run('UPDATE contracts SET created_at = ? WHERE id = ?', iso(4.3), res.contract_id);
          run('UPDATE opportunities SET decided_at = ? WHERE id = ?', iso(4.3), o.id);
          build({ buyer: amit, opportunityId: o.id, plant: prev.plants[0] ?? 'PUN1', title: `Annual rate contract — ${prev.description}`, vendors: 3, resp: ['q', 'qx', 'v'], pub: 4, close: null, closingIn: 6 });
        });
        done = true;
        break;
      } catch (e) { why.push(`${o.code}: ${(e as Error).message}`); }
    }
    if (!done) throw new Error(`no opportunity could be turned into an annual-rate RFQ (${why.join('; ')})`);
  });

  // Closed, one partial quote, one non-responder; a reopen request is waiting for approval.
  scenario('C1', () => {
    const refs = ['10046004/20'];
    const T = fit(refs)(6.5);
    const r = build({ buyer: amit, refs, title: 'Main relief valve — D375A (Nagpur)', vendors: 4, resp: ['q', 'qp', 'qx', 'n'], pub: T(6.5), close: T(1.4) });
    const nr = get<{ vendor_id: number }>("SELECT vendor_id FROM rfq_invitations WHERE rfq_id = ? AND status = 'Not responded' ORDER BY id LIMIT 1", r.id);
    if (!nr) throw new Error('no non-responder to reopen for');
    const ro = S.requestReopen(amit, r.id, { vendor_ids: [nr.vendor_id], reason: 'Vendor confirmed by phone that the quotation was held up by their finance approval; wants to quote and the delivery date still allows it.', reopen_until: ahead(4) });
    run('UPDATE rfq_reopens SET created_at = ? WHERE id = ?', iso(T(0.8)), ro.id);
    ageApproval(ro.approval_id!, T(0.8));
  });

  // Closed; the reopen was approved and a vendor revised its price (version 2) inside the reopen window.
  scenario('C2', () => {
    const refs = ['10046003/20', '10046014/20'];
    const T = fit(refs)(8);
    const r = build({ buyer: sneha, refs, title: 'Water separator filters — Chakan', vendors: 4, resp: ['q', 'q', 'd', 'n'], pub: T(8), close: T(2) });
    const target = r.vendors[0];
    const ro = S.requestReopen(sneha, r.id, { vendor_ids: [target], reason: 'Vendor offered a better rate if the order is split into one delivery; asked to revise the quotation.', reopen_until: ahead(2) });
    decide(ro.approval_id!, 'approve', 'Approved for one revision; window kept short.');
    const a = vendorActor(target);
    const view = Q.vendorView(a, r.id);
    const lines = (view.quotation?.lines ?? []).map((l: Q.QLine) => ({ ...l, basic_price: l.no_quote || !l.basic_price ? l.basic_price : Math.round(l.basic_price * 0.96) }));
    Q.submit(a, r.id, { lines });
    run('UPDATE rfq_reopens SET created_at = ? WHERE id = ?', iso(T(1.4)), ro.id);
    ageApproval(ro.approval_id!, T(1.4), [8]);
    const q = get<{ id: number }>('SELECT id FROM quotations WHERE rfq_id = ? AND vendor_id = ?', r.id, target)!;
    run('UPDATE quotation_versions SET created_at = ? WHERE quotation_id = ? AND version > 1', iso(T(0.6)), q.id);
    run('UPDATE quotations SET submitted_at = ?, updated_at = ? WHERE id = ?', iso(T(0.6)), iso(T(0.6)), q.id);
    run('UPDATE rfq_invitations SET responded_at = ? WHERE rfq_id = ? AND vendor_id = ?', iso(T(0.6)), r.id, target);
  });

  // Limited-source RFQ waiting for approval: only two vendors supply this welding consumable (FR-RFQ-11).
  scenario('LIM', () => {
    const refs = ['10046026/20'];
    const T = fit(refs)(4.2);
    const r = build({ buyer: sneha, refs, title: 'Hardfacing electrodes 4.0 mm — Chakan', vendors: 2, resp: [], pub: 0, close: null, skipPublish: true });
    const pub = S.publish(sneha, r.id, { exception_reason: 'Only two approved vendors supply hardfacing electrodes of this grade; the third approved vendor stopped stocking it last quarter.' });
    if (pub.status !== 'Pending approval') throw new Error(`expected a pending approval, RFQ is ${pub.status}`);
    run('UPDATE rfqs SET created_at = ? WHERE id = ?', iso(T(4.2)), r.id);
    const ap = get<{ id: number }>("SELECT id FROM approvals WHERE object_type = 'rfq' AND object_id = ? AND type = 'exc.single_source'", r.id)!;
    ageApproval(ap.id, T(3.5));
  });

  // Drafts.
  scenario('D2', () => {
    const refs = ['10046007/20', '10046016/20'];
    const T = fit(refs)(0.6);
    const r = build({ buyer: sneha, refs, title: 'Heavy-duty batteries 12 V 180 Ah — Chakan', vendors: 3, resp: [], pub: 0, close: null, skipPublish: true });
    run('UPDATE rfqs SET created_at = ? WHERE id = ?', iso(T(0.6)), r.id);
  });
  scenario('D3', () => {
    const refs = ['10046022/20'];
    const T = fit(refs)(1);
    const r = build({ buyer: amit, refs, title: 'Track and bucket hardware — Chakan', vendors: 3, resp: [], pub: 0, close: null, skipPublish: true });
    run('UPDATE rfqs SET created_at = ? WHERE id = ?', iso(T(1)), r.id);
  });

  // Cancelled: the requisitioner withdrew the service scope.
  scenario('CANCEL', () => {
    const refs = ['10045507/10'];
    const T = fit(refs)(1.6);
    const r = build({ buyer: amit, refs, title: 'Line boring and machining of boom pivot — Dhanbad', vendors: 3, resp: ['q', 'v', 'n'], pub: T(1.6), close: null, closingIn: 3 });
    retime(r.id, T(1.6), T(0.6));
    S.cancel(amit, r.id, 'Requisitioner withdrew the scope: the boom pivot will be replaced under warranty instead of being machined.');
    run('UPDATE rfqs SET closed_at = ? WHERE id = ?', iso(T(0.6)), r.id);
  });

  // Re-floated: no usable quotation, the RFQ is re-issued as a new draft with a wider vendor list.
  scenario('REFLOAT', () => {
    const refs = ['10046022/10'];
    const T = fit(refs)(12);
    const r = build({ buyer: amit, refs, title: 'Starter motor 24 V — HD785 (Chakan)', vendors: 3, resp: ['n', 'd', 'n'], pub: T(12), close: T(8) });
    const child = S.refloat(amit, r.id, 'No usable quotation: two vendors did not respond and one declined. Re-issuing with a wider vendor list.');
    run('UPDATE rfqs SET created_at = ? WHERE id = ?', iso(T(7.5)), child.id);
  });

  // Closed RFQs that go on to a comparative statement (the comparison seed takes each to its planned state).
  const toCompare: { key: string; buyer: Actor; local: string; refs: string[]; title?: string; resp: Token[]; vendors: number; kind: CmpKind; pub: number; close: number; x?: Partial<Timeline>; urgent?: boolean; reopenAfterReturn?: boolean }[] = [
    { key: 'U1', buyer: amit, local: 'amit.kulkarni', refs: ['10045511/20'], resp: ['q', 'q', 'qx'], vendors: 3, kind: 'draft', pub: 10, close: 5.5 },
    { key: 'S2', buyer: sneha, local: 'sneha.patil', refs: ['10046003/10'], resp: ['q', 'qa', 'qx'], vendors: 3, kind: 'rec', pub: 10, close: 5.5, x: { rec: 3.5 } },
    { key: 'S13', buyer: sneha, local: 'sneha.patil', refs: ['10046024/20'], resp: ['q', 'qx', 'q'], vendors: 3, kind: 'sub1', pub: 7, close: 2.2, x: { sub: 0.4, rec: 1.0 } },
    { key: 'A10', buyer: amit, local: 'amit.kulkarni', refs: ['10046014/10'], resp: ['q', 'q', 'qx', 'd'], vendors: 4, kind: 'sub2', pub: 12, close: 7.5, x: { sub: 5.8 } },
    { key: 'A2', buyer: amit, local: 'amit.kulkarni', refs: ['10045508/10'], resp: ['q', 'q', 'qx'], vendors: 3, kind: 'sub3', pub: 11, close: 6, x: { sub: 2.4, rec: 3.5 } },
    { key: 'A11', buyer: amit, local: 'amit.kulkarni', refs: ['10046019/10'], resp: ['q', 'qx', 'q'], vendors: 3, kind: 'rejected', pub: 11, close: 8.5, x: { sub: 7.4, dec: 6.5 } },
    { key: 'S12', buyer: sneha, local: 'sneha.patil', refs: ['10046019/20'], resp: ['q', 'q', 'qx'], vendors: 3, kind: 'approved', pub: 11, close: 8.8, x: { sub: 7.8, dec: 6.8 } },
    { key: 'S14', buyer: sneha, local: 'sneha.patil', refs: ['10046026/10'], resp: ['q', 'qx', 'q'], vendors: 3, kind: 'returned', pub: 14, close: 9.5, x: { sub: 6.4, dec: 5.2 }, reopenAfterReturn: true },
    { key: 'A12', buyer: amit, local: 'amit.kulkarni', refs: ['10046006/10'], resp: ['q', 'q', 'qx'], vendors: 3, kind: 'discount', pub: 9, close: 4.5, x: { sub: 1.5 } },
    { key: 'A15', buyer: amit, local: 'amit.kulkarni', refs: ['10046025/20'], resp: ['q', 'qx', 'q'], vendors: 3, kind: 'released', pub: 2.6, close: 2.0, x: { cmp: 1.8, rec: 1.6, sub: 1.5, dec: 1.2, rel: 1.0 } },
  ];
  for (const c of toCompare) {
    scenario(c.key, () => {
      const T = fit(c.refs)(c.pub);
      const t = tline(T, { pub: c.pub, close: c.close, ...c.x });
      const r = build({ buyer: c.buyer, refs: c.refs, title: c.title, vendors: c.vendors, resp: c.resp, pub: t.pub, close: t.close, urgent: c.urgent });
      plan(r.id, c.local, c.kind, t, { reopenAfterReturn: c.reopenAfterReturn });
    });
  }

  historic(amit, sneha);
}

/**
 * Historic RFQs that ended in a purchase order: the RFQ, the vendor quotations and the award behind three of the extra
 * historic POs, so the PO shows its RFQ and comparison (PO -> rfq_id / comparison_id). The PO vendor quotes the PO price; the
 * other vendors quote higher, except in one case where a cheaper vendor lost on delivery time (deviation approval).
 */
function historic(amit: Actor, sneha: Actor) {
  const want = [{ minAge: 200 }, { minAge: 100, deviation: true }, { minAge: 30 }];
  const used = new Set<number>();
  const cands = all<{ id: number; po_no: string; po_date: string; vendor_id: number; buyer_id: number | null; rfq_date: string }>(
    "SELECT id, po_no, po_date, vendor_id, buyer_id, rfq_date FROM pos WHERE po_no >= '4500030001' AND po_no < '4500031001' AND contract_id IS NULL AND rfq_date IS NOT NULL AND rfq_id IS NULL AND status = 'Closed' ORDER BY po_no",
  );
  let n = 0;
  for (const w of want) {
    n++;
    let done = false;
    for (const po of cands) {
      if (used.has(po.id)) continue;
      const poAgo = (Date.now() - Date.parse(`${po.po_date}T10:00:00Z`)) / 86400000;
      if (poAgo < w.minAge || poAgo > w.minAge + 110) continue;
      const buyer = po.buyer_id === amit.id ? amit : po.buyer_id === sneha.id ? sneha : null;
      if (!buyer) continue;
      const pol = all<{ item: number; pr_line_id: number | null; qty: number; unit_price: number }>('SELECT item, pr_line_id, qty, unit_price FROM po_lines WHERE po_id = ? ORDER BY item', po.id);
      if (!pol.length || pol.length > 2 || pol.some((x) => !x.pr_line_id)) continue;
      // The RFQ was issued on the PO's RFQ date, which must be after the buyer received the requisitions.
      const rfqDayAgo = (Date.now() - Date.parse(`${po.rfq_date}T10:00:00Z`)) / 86400000;
      const assignedOk = pol.every((x) => {
        const a = get<{ assigned_at: string | null }>('SELECT assigned_at FROM pr_lines WHERE id = ?', x.pr_line_id)?.assigned_at;
        return !!a && (Date.now() - Date.parse(a)) / 86400000 >= rfqDayAgo + 0.8;
      });
      if (!assignedOk) continue;
      try {
        tx(() => {
          // Re-open the historic PR lines for sourcing just long enough to float the RFQ, then restore them to "PO created".
          const lineIds = pol.map((x) => x.pr_line_id!);
          const rfqAgo = Math.max(poAgo + 1, rfqDayAgo);
          for (const id of lineIds) {
            const l = getLine(id)!;
            if (l.status !== 'PO created' || l.buyer_id !== buyer.id) throw new Error('line not suitable');
            runChecks(buyer, id);
            run("UPDATE pr_lines SET status = 'Route decided', route = 'RFQ', route_reason = NULL WHERE id = ?", id);
            insert('route_decisions', { pr_line_id: id, proposed: 'RFQ', decided: 'RFQ', override: 0, checks_json: J(getLine(id)!.checks), decided_by: buyer.id, decided_at: iso(rfqAgo + 0.5) });
          }
          const prices = new Map<number, number>();
          for (const x of pol) prices.set(x.pr_line_id!, x.unit_price);
          const span = rfqAgo - poAgo;
          const f = span >= 5.2 ? 1 : span / 5.2;
          const pub = rfqAgo, close = rfqAgo - 2.5 * f;
          const r = build({
            buyer, prIds: lineIds, vendors: 3, resp: ['q', 'qx', 'q'], pub, close, skipPublish: false,
            over: (vendorId, line) => {
              const base = prices.get(line.pr_line_id ?? -1);
              if (!base) return null;
              const idx = S.invitationsOf(line.rfq_id).findIndex((i) => i.vendor_id === vendorId);
              if (vendorId === po.vendor_id) return { price: base, days: w.deviation ? 8 : 12, disc: 0, freightPct: 0.006 };
              if (w.deviation && idx === 2) return { price: Math.round(base * 0.94), days: 42, disc: 0, freightPct: 0.01 };
              return { price: Math.round(base * (1.05 + 0.03 * idx)), days: 14 + 5 * idx, disc: 0, freightPct: 0.012 };
            },
          });
          if (!r.vendors.includes(po.vendor_id)) throw new Error('PO vendor is not among the suggested vendors');
          for (const id of lineIds) run("UPDATE pr_lines SET status = 'PO created' WHERE id = ?", id);
          const tl: Timeline = { pub, close, cmp: close - 0.4 * f, rec: close - 0.9 * f, sub: close - 1.1 * f, dec: close - 1.9 * f, rel: close - 2.2 * f };
          plan(r.id, buyer === amit ? 'amit.kulkarni' : 'sneha.patil', 'released', tl, { awardVendorId: po.vendor_id, po: { id: po.id, no: po.po_no } });
        });
        used.add(po.id);
        done = true;
        break;
      } catch { /* try the next historic PO */ }
    }
    if (!done) warn(`no historic PO suitable for linked RFQ ${n}`);
  }
}
