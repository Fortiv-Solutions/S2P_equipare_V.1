/**
 * Extended demo data, PO acknowledgement and follow-up (opt-in with DEMO_EXTRA, see docs/DEMO_DATA_BRIEF.md, engineer B).
 *
 *  - Historic extra POs (4500030001+): every line accepted by the vendor (portal) or by the buyer on the vendor's behalf, with the first
 *    commitment and, where the goods arrived late, a revised latest commitment with a delay reason.
 *  - Open extra POs (4500031001+): fresh (unviewed, viewed-not-acknowledged), accepted with commitments, partial acceptance, a rejected
 *    line, overdue lines with varied delay reasons, reminders, level-2 and level-3 escalations and follow-up notes with next-action dates.
 *  - Amendments in every state (requested, vendor request, declined, approved awaiting SAP, republished, re-acknowledged, withdrawn,
 *    cancellation) driven through the real services, the approval engine and the SAP simulator.
 *
 * Everything runs through the services as the right persona; the domain rows the services stamp with the real clock are then moved
 * to the intended moment in history with SQL (`retimed`). audit_events is never touched.
 */
import { all, get, run, scalar, addHours, now } from '../../core/db.ts';
import { act, actionability, type ApprovalRow } from '../../core/approvals.ts';
import { cfg } from '../../core/config.ts';
import type { Actor } from '../../core/auth.ts';
import { EXTRA } from '../../seed/base_extra.ts';
import { actorFor, DAY } from '../../seed/ctx.ts';
import { changePo } from '../sap/simulator.ts';
import * as S from './service.ts';

// ------------------------------------------------------------------ shared helpers (also used by the ASN extended seed)
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

const HOUR = 3600000;
/** Never schedule history in the future: anything later than an hour ago is pulled back to an hour ago. */
export const clampNow = (iso: string) => {
  const max = new Date(Date.now() - HOUR).toISOString();
  return iso > max ? max : iso;
};
/** ISO timestamp for a calendar date (YYYY-MM-DD) plus N days at an hour of the day in IST. */
export function isoAt(date: string, hourIst: number, addDaysN = 0) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + addDaysN);
  d.setUTCHours(hourIst - 5, 30, 0, 0);
  return clampNow(d.toISOString());
}
export const addDate = (date: string, n: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

const maxId = (t: string) => scalar<number>(`SELECT COALESCE(MAX(id), 0) FROM ${t}`) ?? 0;

/**
 * Runs a service call and moves the rows it stamped with the real clock to `ts`: notifications (and their simulated e-mails), follow-ups,
 * dispute timeline events, approvals and steps, PO publications, amendments, attachments and the PO/dispute lifecycle stamps.
 * Older notifications are marked read so a fresh install does not open with a pile of stale unread items.
 */
export function retimed<T>(ts: string, fn: () => T): T {
  const m = { n: maxId('notifications'), ob: maxId('outbox'), ev: maxId('dispute_events'), fu: maxId('po_followups'), ap: maxId('approvals'), pub: maxId('po_publications'), amd: maxId('po_amendments'), att: maxId('attachments') };
  const t0 = now();
  const out = fn();
  run('UPDATE notifications SET created_at = ? WHERE id > ?', ts, m.n);
  if (ts < addHours(new Date(), -72)) run('UPDATE notifications SET read_at = ? WHERE id > ? AND read_at IS NULL', addHours(ts, 5), m.n);
  run('UPDATE outbox SET created_at = ? WHERE id > ?', ts, m.ob);
  run('UPDATE dispute_events SET created_at = ? WHERE id > ?', ts, m.ev);
  run('UPDATE po_followups SET created_at = ? WHERE id > ?', ts, m.fu);
  run('UPDATE approvals SET created_at = ? WHERE id > ?', ts, m.ap);
  run('UPDATE approvals SET decided_at = CASE WHEN id > ? THEN ? ELSE ? END WHERE decided_at >= ?', m.ap, addHours(ts, 3), ts, t0);
  run('UPDATE approval_steps SET acted_at = CASE WHEN approval_id > ? THEN ? ELSE ? END WHERE acted_at >= ?', m.ap, addHours(ts, 3), ts, t0);
  run('UPDATE approval_steps SET due_at = ? WHERE approval_id > ? AND due_at IS NOT NULL', addHours(ts, 48), m.ap);
  run('UPDATE po_publications SET published_at = ? WHERE id > ?', ts, m.pub);
  const ackHours = cfg<{ ack_after_hours: number }>('po.reminders').ack_after_hours;
  run('UPDATE pos SET ack_due_at = ? WHERE id IN (SELECT po_id FROM po_publications WHERE id > ?)', addHours(ts, ackHours), m.pub);
  run('UPDATE po_amendments SET created_at = ? WHERE id > ?', ts, m.amd);
  run('UPDATE po_amendments SET sap_changed_at = ? WHERE sap_changed_at >= ?', ts, t0);
  run('UPDATE po_amendments SET reack_at = ? WHERE reack_at >= ?', ts, t0);
  run('UPDATE pos SET viewed_at = ? WHERE viewed_at >= ?', ts, t0);
  run('UPDATE disputes SET resolved_at = ? WHERE resolved_at >= ?', ts, t0);
  run('UPDATE disputes SET closed_at = ? WHERE closed_at >= ?', ts, t0);
  run('UPDATE attachments SET created_at = ? WHERE id > ?', ts, m.att);
  return out;
}

/** A queue of dated steps, run in chronological order so numbering (AMD, APR, DSP, ASN) follows the calendar. */
export function timeline(module: string) {
  const q: { ts: string; n: number; label: string; fn: () => void }[] = [];
  return {
    when(ts: string, label: string, fn: () => void) { q.push({ ts, n: q.length, label, fn }); },
    run() {
      q.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.n - b.n));
      for (const s of q) {
        try { retimed(s.ts, s.fn); } catch (e) { console.warn(`${module}: ${s.label} skipped — ${(e as Error).message}`); }
      }
    },
  };
}

const actors = new Map<string, Actor>();
export const actor = (local: string) => {
  let a = actors.get(local);
  if (!a) { a = actorFor(local); actors.set(local, a); }
  return a;
};
export const localOf = (email: string) => email.split('@')[0];
/** Portal user of a vendor (null when the vendor has not been invited yet). */
export function vendorActor(vendorId: number) {
  const u = get<{ email: string }>('SELECT email FROM users WHERE vendor_id = ? AND active = 1 ORDER BY id LIMIT 1', vendorId);
  return u ? actor(localOf(u.email)) : null;
}

const REASONS = ['Raw material shortage', 'Production capacity', 'Transport unavailable', 'Awaiting technical clarification', 'Payment / advance pending', 'Import / OEM lead time', 'Quality rework'];

// ------------------------------------------------------------------ PO context
interface Ctx { po: S.PoRow; buyer: Actor; vendor: Actor | null; contact: string; vname: string }
function ctxOf(po: S.PoRow): Ctx {
  const b = po.buyer_id ? get<{ email: string }>('SELECT email FROM users WHERE id = ?', po.buyer_id) : undefined;
  const v = get<{ name: string; contact_name: string | null }>('SELECT name, contact_name FROM vendors WHERE id = ?', po.vendor_id)!;
  return { po, buyer: actor(b ? localOf(b.email) : 'amit.kulkarni'), vendor: vendorActor(po.vendor_id), contact: v.contact_name ?? 'the vendor contact', vname: v.name };
}
const lines = (c: Ctx) => S.linesOf(c.po.id);
const lineAt = (c: Ctx, item: number) => lines(c).find((l) => l.item === item)!;

/** Acknowledgement: by the vendor on the portal when it has a user, otherwise recorded by the buyer from the vendor's e-mail. */
function ack(c: Ctx, ts: string, make: (ls: S.PoLine[]) => S.AckInput[], via = 'e-mail') {
  const inputs = make(lines(c));
  if (c.vendor) S.acknowledge(c.vendor, c.po.id, inputs, { at: ts, allowClosed: true });
  else S.acknowledge(c.buyer, c.po.id, inputs, { at: ts, allowClosed: true, onBehalf: `Acknowledgement received by ${via} from ${c.contact} (${c.vname})` });
}
const acceptAll = (ls: S.PoLine[]): S.AckInput[] => ls.filter((l) => l.ack_status === 'Pending' || l.ack_status === 'Pending re-acknowledgement').map((l) => ({ line_id: l.id, decision: 'accept', commit_date: l.delivery_date }));

/** A later commitment with a delay reason: by the vendor on the portal while the PO is open, otherwise logged by the buyer after speaking to the vendor. */
function revise(c: Ctx, ts: string, item: number, date: string, reason: string, note?: string) {
  const l = lineAt(c, item);
  const po = S.getPo(c.po.id)!;
  if (c.vendor && S.OPEN_PO.includes(po.status) && !['Received', 'Closed', 'Cancelled'].includes(l.status)) {
    S.updateCommitment(c.vendor, l.id, { commit_date: date, delay_reason: reason, note: note ?? null }, { at: ts });
  } else {
    S.logFollowup(c.buyer, c.po.id, { po_line_id: l.id, kind: item % 20 === 0 ? 'E-mail' : 'Call', note: note ?? `${c.contact} (${c.vname}) confirmed the revised date: ${reason.toLowerCase()}.`, commit_date: date, delay_reason: reason }, { at: ts });
  }
}

// ------------------------------------------------------------------ amendment helpers
const SAP_ACTOR = () => actor('neha.gupta');
function decideAll(amdId: number, comment: string) {
  for (let i = 0; i < 4; i++) {
    if (S.getAmendment(amdId)!.status !== 'Requested') return;
    const ap = get<ApprovalRow>("SELECT * FROM approvals WHERE object_type = 'po_amendment' AND object_id = ? AND status = 'Pending' ORDER BY id DESC LIMIT 1", amdId);
    if (!ap) return;
    const who = ['vikram.joshi', 'kiran.shah', 'meera.iyer'].map(actor).find((a) => actionability(a, ap).canAct);
    if (!who) throw new Error(`no approver available for ${ap.req_no}`);
    act(who, ap.id, 'approve', comment);
  }
}
function applyInSap(c: Ctx, amdId: number) {
  const { body } = S.prepareSapChange(c.buyer, amdId);
  changePo(SAP_ACTOR(), c.po.po_no, body);
}


/** The classification the PO seed worked from, kept so the ASN seed (which runs after the amendments changed some dates) tells the same story. */
export const situations: { pos?: ReturnType<typeof openPoClasses> } = {};

/** The open extra POs grouped by situation, in PO-number order (shared with the ASN seed so both tell one story). */
export function openPoClasses() {
  const open = all<S.PoRow>('SELECT * FROM pos WHERE po_no >= ? AND po_no < ? ORDER BY po_no', String(EXTRA.poOpenFrom), String(EXTRA.poOpenFrom + 500));
  const today = DAY(0);
  const info = open.filter((p) => p.status !== 'Cancelled').map((po) => {
    const ls = S.linesOf(po.id);
    const received = ls.some((l) => l.received_qty > 0);
    const minDel = ls.map((l) => l.delivery_date).sort()[0];
    return { po, received, minDel, age: Math.floor((Date.now() - new Date(po.po_date).getTime()) / 86400000) };
  });
  const fresh = info.filter((x) => x.age <= 2 && !x.received && x.po.status === 'Published').map((x) => x.po);
  const overdue = info.filter((x) => !fresh.includes(x.po) && x.po.status !== 'Closed' && x.minDel < today).map((x) => x.po);
  const closed = info.filter((x) => x.po.status === 'Closed').map((x) => x.po);
  const partial = info.filter((x) => x.po.status === 'Partially received' && !overdue.includes(x.po)).map((x) => x.po);
  const accepted = info.filter((x) => ![...fresh, ...overdue, ...closed, ...partial].includes(x.po)).map((x) => x.po);
  return { fresh, overdue, closed, partial, accepted };
}

// ------------------------------------------------------------------ seed
export function seedExtra() {
  const tl = timeline('po seed_extra');
  const r = rng(20261021);
  const history = all<S.PoRow>('SELECT * FROM pos WHERE po_no >= ? AND po_no < ? ORDER BY po_no', String(EXTRA.poHistoricFrom), String(EXTRA.poOpenFrom));

  // ---------------------------------------------------------------- historic POs: accepted, with first and latest commitment
  for (const po of history) {
    const c = ctxOf(po);
    const ackTs = isoAt(po.po_date, 9 + Math.floor(r() * 8), 1 + Math.floor(r() * 2));
    tl.when(ackTs, `acknowledge ${po.po_no}`, () => ack(c, ackTs, acceptAll));
    const grn = scalar<string>('SELECT MIN(posting_date) FROM grns WHERE po_id = ?', po.id);
    for (const l of S.linesOf(po.id)) {
      if (!grn || grn <= l.delivery_date) continue;
      const reason = REASONS[Math.floor(r() * REASONS.length)];
      const ts = isoAt(l.delivery_date, 10, -1);
      tl.when(ts, `revise ${po.po_no}/${l.item}`, () => revise(c, ts, l.item, grn, reason));
    }
  }

  // ---------------------------------------------------------------- open POs by situation
  const { fresh, overdue, closed, partial, accepted } = openPoClasses();
  situations.pos = { fresh, overdue, closed, partial, accepted };
  const pick = (cls: S.PoRow[], i: number, what: string) => {
    if (!cls[i]) { console.warn(`po seed_extra: ${what} skipped — no open PO in that situation`); return null; }
    return ctxOf(cls[i]);
  };
  const T = (c: Ctx, days: number, hour = 11) => isoAt(c.po.po_date, hour, days);
  const remind = (c: Ctx, ts: string, type: 'ack' | 'overdue' | 'dispatch', manual: boolean) =>
    tl.when(ts, `reminder ${c.po.po_no}`, () => { S.remind(manual ? c.buyer : null, c.po.id, { type, manual, at: ts }); });
  const escalate = (c: Ctx, ts: string, reason?: string) =>
    tl.when(ts, `escalate ${c.po.po_no}`, () => { S.escalate(reason ? c.buyer : null, c.po.id, reason ? { reason, manual: true, at: ts } : { at: ts }); });
  const note = (c: Ctx, ts: string, kind: string, text: string, next?: string, lineItem?: number) =>
    tl.when(ts, `note ${c.po.po_no}`, () => { S.logFollowup(c.buyer, c.po.id, { po_line_id: lineItem ? lineAt(c, lineItem).id : null, kind, note: text, next_action_date: next ?? null }, { at: ts }); });
  const view = (c: Ctx, ts: string) => tl.when(ts, `view ${c.po.po_no}`, () => { if (c.vendor) S.markViewed(c.vendor, c.po.id); });
  const accept = (c: Ctx, ts: string, via = 'e-mail') => tl.when(ts, `acknowledge ${c.po.po_no}`, () => ack(c, ts, acceptAll, via));
  const rev = (c: Ctx, ts: string, item: number, date: string, reason: string, text?: string) => tl.when(ts, `revise ${c.po.po_no}/${item}`, () => revise(c, ts, item, date, reason, text));

  // Amendment lifecycle steps (each one a dated step so the audit trail, approvals and numbering read in order).
  const amd: Record<string, number> = {};
  const request = (c: Ctx, ts: string, key: string, who: Actor, input: S.AmendInput) =>
    tl.when(ts, `amendment ${key}`, () => { amd[key] = S.requestAmendment(who, c.po.id, input).id; });
  const approve = (ts: string, key: string, comment: string) => tl.when(ts, `approve ${key}`, () => decideAll(amd[key], comment));
  const sap = (c: Ctx, ts: string, key: string) => tl.when(ts, `apply in SAP ${key}`, () => applyInSap(c, amd[key]));

  // ---- fresh
  const f = (i: number, what: string) => pick(fresh, i, what);
  const f1 = f(1, 'fresh viewed PO');
  if (f1) { view(f1, T(f1, 1, 9)); remind(f1, T(f1, 1, 13), 'ack', false); }
  const f2 = f(2, 'fresh reminded PO');
  if (f2) remind(f2, T(f2, 1, 13), 'ack', false);
  const f3 = f(3, 'line cancellation PO');
  if (f3) {
    request(f3, T(f3, 1, 10), 'cancel-line', f3.buyer, { type: 'Cancel', reason: 'Requirement on the third line is withdrawn by the workshop; the repair was completed with stock on hand.', lines: [{ line_id: lineAt(f3, 30).id }] });
    approve(T(f3, 1, 14), 'cancel-line', 'Approved: stock covers the requirement.');
    sap(f3, T(f3, 1, 17), 'cancel-line');
  }

  // ---- accepted situation (not yet due)
  const a0 = pick(accepted, 0, 'silent vendor PO (level 3)');
  if (a0) {
    remind(a0, T(a0, 1, 13), 'ack', false);
    remind(a0, T(a0, 3, 10), 'ack', true);
    note(a0, T(a0, 3, 15), 'Call', `Called ${a0.contact}: phone unreachable. Will retry tomorrow and send a WhatsApp reminder.`, DAY(1));
    remind(a0, T(a0, 5, 11), 'ack', true);
    escalate(a0, T(a0, 5, 15), 'No acknowledgement after three reminders; delivery is due in four days.');
    escalate(a0, T(a0, 6, 10), 'Still no response from the vendor; escalating to the department head for a decision on re-sourcing.');
  }
  const a1 = pick(accepted, 1, 'urgent silent vendor PO (level 3)');
  if (a1) {
    remind(a1, T(a1, 1, 13), 'ack', false);
    remind(a1, T(a1, 3, 10), 'ack', true);
    escalate(a1, T(a1, 4, 10));
    remind(a1, T(a1, 6, 10), 'ack', true);
    note(a1, T(a1, 7, 16), 'E-mail', `E-mailed ${a1.contact} and the vendor's sales head; urgent line, need the delivery commitment by return.`, DAY(1));
    escalate(a1, T(a1, 8, 10));
  }
  const a2 = pick(accepted, 2, 'viewed-not-acknowledged PO');
  if (a2) {
    view(a2, T(a2, 1, 10));
    remind(a2, T(a2, 1, 13), 'ack', false);
    remind(a2, T(a2, 4, 11), 'ack', true);
    escalate(a2, T(a2, 6, 11), 'Viewed on the portal but not acknowledged for six days; BD requirement is waiting.');
    note(a2, T(a2, 8, 12), 'Vendor update', `${a2.contact} says the drawing check is pending at their end and they will acknowledge by Thursday.`, DAY(2));
  }
  const a3 = pick(accepted, 3, 'cancelled PO');
  if (a3) {
    accept(a3, T(a3, 1, 12));
    request(a3, T(a3, 4, 10), 'cancel-po', a3.buyer, { type: 'Cancel', reason: 'The requirement was withdrawn after the machine was released from the breakdown list; no dispatch has started.' });
    approve(T(a3, 5, 11), 'cancel-po', 'Approved: requirement withdrawn.');
    sap(a3, T(a3, 6, 10), 'cancel-po');
  }
  const a4 = pick(accepted, 4, 'partial acceptance PO');
  if (a4) {
    view(a4, T(a4, 1, 10));
    tl.when(T(a4, 2, 11), `acknowledge ${a4.po.po_no}`, () => ack(a4, T(a4, 2, 11), (ls) => [
      { line_id: ls[0].id, decision: 'accept', commit_date: ls[0].delivery_date },
      { line_id: ls[1].id, decision: 'partial', accepted_qty: Math.max(1, ls[1].qty - 1), commit_date: ls[1].delivery_date, reason: 'Only part of the quantity is in finished stock; the balance needs a fresh lot.' },
    ]));
    if (a4.vendor) request(a4, T(a4, 10, 11), 'vendor-qty', a4.vendor, { type: 'Quantity', reason: 'Please reduce line 20 to the quantity we can supply; the balance is not available this quarter.', lines: [{ line_id: lineAt(a4, 20).id, qty: Math.max(1, lineAt(a4, 20).qty - 1) }] });
  }

  // ---- partly received, not overdue
  const p0 = pick(partial, 0, 'partly received PO');
  if (p0) {
    accept(p0, T(p0, 1, 11));
    note(p0, T(p0, 5, 15), 'Call', `Spoke to ${p0.contact}: balance quantity is packed and will be dispatched on Friday; LR to follow.`, DAY(2));
    request(p0, T(p0, 6, 11), 'date-requested', p0.buyer, { type: 'Date', reason: 'Plant shutdown moves to the first week of November; the balance can arrive later without affecting the job.', lines: [{ line_id: lineAt(p0, 10).id, delivery_date: DAY(11) }] });
  }
  const p1 = pick(partial, 1, 'price amendment PO');
  if (p1) {
    accept(p1, T(p1, 1, 11));
    request(p1, T(p1, 2, 11), 'price', p1.buyer, { type: 'Price', reason: 'Vendor passed on the steel price revision notified on 1 October; the increase is within the rate-contract clause.', lines: [{ line_id: lineAt(p1, 10).id, unit_price: Math.round(lineAt(p1, 10).unit_price * 1.06 / 10) * 10 }] });
    approve(T(p1, 3, 12), 'price', 'Approved: increase is within the contractual revision limit.');
    sap(p1, T(p1, 6, 10), 'price');
  }
  // ---- fully received (closed)
  for (const [i, c] of [[0, pick(closed, 0, 'closed PO')], [1, pick(closed, 1, 'closed PO')]] as [number, Ctx | null][]) if (c) accept(c, T(c, 1, 10 + i));

  // ---- overdue
  const o0 = pick(overdue, 0, 'overdue PO with three revisions');
  if (o0) {
    accept(o0, T(o0, 1, 11));
    rev(o0, T(o0, 7, 11), 10, addDate(o0.po.po_date, 12), REASONS[0]);
    rev(o0, T(o0, 7, 12), 20, addDate(o0.po.po_date, 14), REASONS[1]);
    rev(o0, T(o0, 7, 13), 30, addDate(o0.po.po_date, 11), REASONS[2]);
    rev(o0, T(o0, 11, 11), 10, addDate(o0.po.po_date, 16), REASONS[6], `Quality rework on the reconditioned part; ${o0.contact} gave the revised date by phone.`);
    request(o0, T(o0, 12, 11), 'withdrawn', o0.buyer, { type: 'Quantity', reason: 'Workshop now needs fewer units; reducing line 20 so the vendor can ship the rest earlier.', lines: [{ line_id: lineAt(o0, 20).id, qty: 8 }] });
    tl.when(T(o0, 13, 10), 'withdraw amendment', () => { S.withdrawAmendment(o0.buyer, amd.withdrawn, 'Vendor has already machined the full quantity; keeping the original order.'); });
    remind(o0, T(o0, 17, 11), 'overdue', false);
    note(o0, T(o0, 17, 16), 'Call', `Called ${o0.contact}: Ex-Works pickup needs a vehicle; logistics to book the truck once the vendor confirms readiness.`, DAY(1));
  }
  const o1 = pick(overdue, 1, 'overdue urgent PO with level 2 escalation');
  if (o1) {
    accept(o1, T(o1, 1, 11));
    rev(o1, T(o1, 10, 11), 10, addDate(o1.po.po_date, 19), REASONS[1]);
    rev(o1, T(o1, 10, 12), 20, addDate(o1.po.po_date, 19), REASONS[1]);
    rev(o1, T(o1, 18, 11), 10, addDate(o1.po.po_date, 27), REASONS[5], 'OEM has quoted a longer lead time for the casting.');
    rev(o1, T(o1, 18, 12), 20, addDate(o1.po.po_date, 25), REASONS[0]);
    request(o1, T(o1, 26, 11), 'approved', o1.buyer, { type: 'Date', reason: 'Align the PO delivery date with the vendor\'s revised commitment so stores plans the dock slot.', lines: [{ line_id: lineAt(o1, 10).id, delivery_date: DAY(10) }, { line_id: lineAt(o1, 20).id, delivery_date: DAY(10) }] });
    approve(T(o1, 27, 11), 'approved', 'Approved: urgent line, date aligned.');
    remind(o1, T(o1, 28, 11), 'overdue', false);
    escalate(o1, T(o1, 29, 11));
    remind(o1, T(o1, 30, 10), 'overdue', true);
    note(o1, T(o1, 30, 15), 'Vendor update', `${o1.contact} confirmed dispatch by the 22nd and will send the pickup readiness note.`, DAY(2));
  }
  const o2 = pick(overdue, 2, 'overdue PO with level 3 escalation');
  if (o2) {
    accept(o2, T(o2, 1, 11));
    rev(o2, T(o2, 7, 11), 10, addDate(o2.po.po_date, 21), REASONS[3], 'Vendor needs a drawing clarification before machining.');
    rev(o2, T(o2, 20, 11), 10, addDate(o2.po.po_date, 35), REASONS[6]);
    remind(o2, T(o2, 36, 11), 'overdue', false);
    remind(o2, T(o2, 38, 11), 'overdue', true);
    escalate(o2, T(o2, 39, 11), 'Class 1 line is five days past the committed date and the vendor is not responding.');
    remind(o2, T(o2, 40, 11), 'overdue', true);
    escalate(o2, T(o2, 41, 11), 'Machine stays down without this part; need management help to get a dispatch date.');
    note(o2, T(o2, 41, 15), 'Call', `Called ${o2.contact}; the part is ready but waiting for the final inspection. Will dispatch once cleared.`, DAY(1));
  }
  const o3 = pick(overdue, 3, 'overdue PO with a rejected line');
  if (o3) {
    tl.when(T(o3, 1, 11), `acknowledge ${o3.po.po_no}`, () => ack(o3, T(o3, 1, 11), (ls) => [
      { line_id: ls[0].id, decision: 'accept', commit_date: ls[0].delivery_date },
      { line_id: ls[1].id, decision: 'reject', reason: 'Item is discontinued by the OEM and the superseded part code is not available from us.' },
    ]));
    if (o3.vendor) {
      request(o3, T(o3, 13, 10), 'declined', o3.vendor, { type: 'Price', reason: 'Raw material cost has gone up since the quotation; requesting a revised unit price on line 10.', lines: [{ line_id: lineAt(o3, 10).id, unit_price: Math.round(lineAt(o3, 10).unit_price * 1.08) }] });
      tl.when(T(o3, 15, 11), 'decline amendment', () => { S.declineVendorRequest(o3.buyer, amd.declined, 'The quotation price was valid for this order; no revision is possible. Please ship against the original price.'); });
    }
    rev(o3, T(o3, 13, 14), 10, addDate(o3.po.po_date, 28), REASONS[2]);
    rev(o3, T(o3, 27, 11), 10, addDate(o3.po.po_date, 38), REASONS[1]);
    note(o3, T(o3, 33, 12), 'Note', 'Line 20 is rejected by the vendor: sourcing to raise a fresh requisition for the superseded part.', DAY(2), 20);
    remind(o3, T(o3, 39, 11), 'overdue', false);
    remind(o3, T(o3, 41, 11), 'overdue', true);
  }
  const o4 = pick(overdue, 4, 'overdue PO with date amendment');
  if (o4) {
    accept(o4, T(o4, 1, 11));
    rev(o4, T(o4, 9, 11), 10, addDate(o4.po.po_date, 23), REASONS[4], 'Vendor asks for a 30 percent advance before starting; finance is checking.');
    remind(o4, T(o4, 25, 11), 'overdue', false);
    request(o4, T(o4, 25, 15), 'reack', o4.buyer, { type: 'Date', reason: 'Advance request is being processed by finance; moving the delivery date to give the vendor a realistic window.', lines: [{ line_id: lineAt(o4, 10).id, delivery_date: DAY(8) }] });
    approve(T(o4, 26, 11), 'reack', 'Approved.');
    sap(o4, T(o4, 27, 10), 'reack');
    tl.when(T(o4, 28, 11), `re-acknowledge ${o4.po.po_no}`, () => ack(o4, T(o4, 28, 11), (ls) => ls.filter((l) => l.ack_status === 'Pending re-acknowledgement').map((l) => ({ line_id: l.id, decision: 'accept' as const, commit_date: l.delivery_date })), 'phone call'));
  }
  const o5 = pick(overdue, 5, 'overdue partly received PO with partial acceptance');
  if (o5) {
    tl.when(T(o5, 1, 11), `acknowledge ${o5.po.po_no}`, () => ack(o5, T(o5, 1, 11), (ls) => [
      { line_id: ls[0].id, decision: 'partial', accepted_qty: Math.floor(ls[0].qty * 0.55), commit_date: ls[0].delivery_date, reason: 'Only about half is in finished stock; the balance needs a fresh machining lot (about three weeks).' },
    ]));
    rev(o5, T(o5, 10, 11), 10, addDate(o5.po.po_date, 16), REASONS[1]);
    remind(o5, T(o5, 17, 11), 'overdue', false);
    note(o5, T(o5, 18, 15), 'Call', `Called ${o5.contact}: the last few units are being finished; Equipcare stores will receive them with the next truck.`, DAY(1));
  }
  const o6 = pick(overdue, 6, 'overdue partly received PO with level 2 escalation');
  if (o6) {
    accept(o6, T(o6, 1, 11));
    rev(o6, T(o6, 10, 11), 10, addDate(o6.po.po_date, 18), REASONS[2]);
    rev(o6, T(o6, 10, 12), 20, addDate(o6.po.po_date, 17), REASONS[6]);
    remind(o6, T(o6, 19, 11), 'overdue', false);
    remind(o6, T(o6, 22, 11), 'overdue', true);
    escalate(o6, T(o6, 23, 11));
    note(o6, T(o6, 24, 15), 'Vendor update', `${o6.contact} confirmed the balance is loaded and will arrive within two days; ASN to follow.`, DAY(2));
  }

  tl.run();

  // The SAP change resets a changed line to "Published"; goods already received keep their receipt status.
  run(`UPDATE po_lines SET status = 'Partially received' WHERE status = 'Published' AND received_qty > 0 AND received_qty < qty
       AND po_id IN (SELECT id FROM pos WHERE po_no >= ?)`, String(EXTRA.poHistoricFrom));
}
