/**
 * Extended demo data, ASNs and receipt disputes (opt-in with DEMO_EXTRA, see docs/DEMO_DATA_BRIEF.md, engineer B).
 *
 *  - ASNs on the extra POs in every state: Draft, Submitted, In transit, Delivered (matched to the SAP goods receipt), an Equipcare pickup
 *    that is overdue and a cancelled one, each with the dispatch documents a vendor would upload.
 *  - Disputes across all nine discrepancy types, owners (vendor, procurement, logistics, stores, finance), delivery terms and statuses,
 *    aged 1 to 40 days, with evidence, vendor responses, outcomes with amounts and one closure waiting for approval.
 *
 * Disputes are raised and worked through the dispute service as the stores, buyer, finance and vendor personas; the dated history is
 * set with `retimed` (SQL on the domain rows, never on audit_events).
 */
import { all, get, insert, update, run, J } from '../../core/db.ts';
import { audit } from '../../core/audit.ts';
import { createApproval } from '../../core/approvals.ts';
import { storeGenerated } from '../../core/files.ts';
import { DAY } from '../../seed/ctx.ts';
import { EXTRA } from '../../seed/base_extra.ts';
import { demoPdf, demoPng, seedAsn, type SeedAsn } from './seed.ts';
import { termKey } from './service.ts';
import * as D from './disputes.ts';
import { rng, timeline, isoAt, addDate, actor, vendorActor, localOf, situations, openPoClasses } from '../po/seed_extra.ts';
import type { Actor } from '../../core/auth.ts';

const CARRIERS = ['Sahyadri Roadlines', 'Southern Cargo Movers', 'Vidarbha Freight Carriers', 'VRL Logistics', 'TCI Freight', 'Safexpress', 'Gati-KWE', 'Blue Dart Surface'];
const STATE_CODE: Record<string, string> = { PUN1: 'MH12', NGP1: 'MH40', DHN1: 'JH10' };

// ------------------------------------------------------------------ documents
function unowned(filename: string, mime: string, buf: Buffer, label: string, actorId: number, vendorVisible = true) {
  const id = storeGenerated(buf, filename, mime, { ownerType: 'dispute', ownerId: 0, label, actorId, vendorVisible });
  run('UPDATE attachments SET owner_type = NULL, owner_id = NULL WHERE id = ?', id);
  return id;
}
const pdf = (filename: string, label: string, title: string, lines: string[], actorId: number, vendorVisible = true) => unowned(filename, 'application/pdf', demoPdf(title, lines), label, actorId, vendorVisible);
const photo = (filename: string, actorId: number, rgb: [number, number, number]) => unowned(filename, 'image/png', demoPng(240, 160, rgb), 'Photo', actorId);

// ------------------------------------------------------------------ ASNs
export function seedExtra() {
  seedAsns();
  seedDisputes();
}

interface PoInfo { id: number; po_no: string; plant: string; vendor_id: number; delivery_terms: string | null; po_date: string }
const poByNo = (no: string) => get<PoInfo>('SELECT id, po_no, plant, vendor_id, delivery_terms, po_date FROM pos WHERE po_no = ?', no);
const vendorLocal = (vendorId: number) => {
  const u = get<{ email: string }>('SELECT email FROM users WHERE vendor_id = ? AND active = 1 ORDER BY id LIMIT 1', vendorId);
  return u ? localOf(u.email) : '-';
};
const grnOf = (poId: number) => get<{ grn_no: string; posting_date: string }>('SELECT grn_no, MIN(posting_date) AS posting_date FROM grns WHERE po_id = ? GROUP BY grn_no ORDER BY posting_date LIMIT 1', poId);
const grnQty = (poId: number, grnNo: string) => all<{ item: number; qty: number }>('SELECT l.item, g.qty FROM grns g JOIN po_lines l ON l.id = g.po_line_id WHERE g.po_id = ? AND g.grn_no = ? ORDER BY l.item', poId, grnNo);

function seedAsns() {
  const tl = timeline('asn seed_extra');
  const r = rng(20261022);
  const digits = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 10)).join('');
  const carrier = () => CARRIERS[Math.floor(r() * CARRIERS.length)];
  const cls = situations.pos ?? openPoClasses();
  const byIdx = (list: { po_no: string }[], i: number) => (list[i] ? poByNo(list[i].po_no) : undefined);
  const history = all<PoInfo>('SELECT id, po_no, plant, vendor_id, delivery_terms, po_date FROM pos WHERE po_no >= ? AND po_no < ?', String(EXTRA.poHistoricFrom), String(EXTRA.poOpenFrom));

  const transport = (po: PoInfo) => ({ transporter: carrier(), lr: `${carrier().slice(0, 3).toUpperCase()}/${po.plant}/${digits(5)}`, vehicle: `${STATE_CODE[po.plant] ?? 'MH12'}${String.fromCharCode(65 + Math.floor(r() * 26))}${String.fromCharCode(65 + Math.floor(r() * 26))}${digits(4)}`, eway: `3${digits(11)}` });
  const docsFor = (po: PoInfo, inv: string, t: ReturnType<typeof transport> | null, full = true): SeedAsn['docs'] => [
    ...(t && full ? [['E-way bill', `eway-bill-${t.eway}.pdf`, [`E-way bill ${t.eway}`, `Vehicle ${t.vehicle}`]] as [string, string, string[]]] : []),
    ['Invoice / challan', `invoice-${inv.replace(/\//g, '-')}.pdf`, [`Invoice ${inv}`, `PO ${po.po_no}`]],
    ...(full ? [['Packing list', `packing-list-${po.po_no}.pdf`, ['Packing list', 'Cartons and pallets as per invoice']] as [string, string, string[]]] : []),
    ...(t && full ? [['LR copy', `lr-${t.lr.replace(/\//g, '-')}.pdf`, [`LR ${t.lr}`, t.transporter]] as [string, string, string[]]] : []),
  ];
  let invSeq = 1180;
  const invoiceNo = (po: PoInfo) => `${(get<{ name: string }>('SELECT name FROM vendors WHERE id = ?', po.vendor_id)?.name ?? 'VEN').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()}/26-27/${invSeq++}`;
  const lineQtyAll = (poId: number) => all<{ item: number; qty: number }>('SELECT item, qty FROM po_lines WHERE po_id = ? AND ack_status IN (\'Accepted\', \'Partially accepted\', \'Deemed accepted\') ORDER BY item', poId);
  const openBalance = (poId: number) => all<{ item: number; qty: number }>(
    `SELECT item, COALESCE(accepted_qty, qty) - received_qty AS qty FROM po_lines WHERE po_id = ? AND ack_status IN ('Accepted', 'Partially accepted', 'Deemed accepted') AND status NOT IN ('Cancelled') AND COALESCE(accepted_qty, qty) - received_qty > 0 ORDER BY item`, poId,
  ).map((x) => ({ item: x.item, qty: x.qty }));

  const add = (created: string, label: string, make: () => void) => tl.when(created, label, make);

  // --- Delivered, matched to the SAP goods receipt (historic and partly received POs)
  const delivered = (po: PoInfo | undefined, opts: { pickup?: boolean; partial?: boolean }) => {
    if (!po) { console.warn('asn seed_extra: a delivered ASN was skipped — PO not found'); return; }
    const g = grnOf(po.id);
    if (!g) { console.warn(`asn seed_extra: delivered ASN for ${po.po_no} skipped — no goods receipt`); return; }
    const t = transport(po);
    const created = isoAt(addDate(g.posting_date, -4), 11);
    const pickup = opts.pickup;
    const inv = invoiceNo(po);
    add(created, `delivered ASN ${po.po_no}`, () => {
      seedAsn({
        po: po.po_no, vendor: vendorLocal(po.vendor_id), lines: grnQty(po.id, g.grn_no).map((x) => [x.item, x.qty] as [number, number]), status: 'Delivered',
        dispatch: addDate(g.posting_date, -3), expected: addDate(g.posting_date, -1), created, submitted: isoAt(addDate(g.posting_date, -4), 14), delivered: isoAt(g.posting_date, 15),
        transporter: t.transporter, lr: t.lr, vehicle: t.vehicle, eway: t.eway, invoiceRef: inv, packing: opts.partial ? 'Part shipment, balance to follow' : 'Cartons and pallets, shrink wrapped',
        ...(pickup ? { pickupBy: 'Equipcare' as const, pickupDate: addDate(g.posting_date, -3), pickupStatus: 'Picked up' } : {}), grn: g.grn_no, docs: docsFor(po, inv, t),
      });
    });
  };
  const recent = history.filter((p) => grnOf(p.id)).sort((a, b) => (grnOf(b.id)!.posting_date < grnOf(a.id)!.posting_date ? -1 : 1));
  const firstFor = recent.filter((p) => termKey(p.delivery_terms) === 'FOR' && (get<{ n: number }>('SELECT COUNT(*) n FROM po_lines WHERE po_id = ?', p.id)?.n ?? 0) >= 2);
  const firstExw = recent.filter((p) => termKey(p.delivery_terms) === 'Ex-Works');
  delivered(firstFor[0], {});
  delivered(firstExw[0], { pickup: true });
  delivered(firstFor[1], {});
  delivered(byIdx(cls.partial, 0), { partial: true });
  delivered(byIdx(cls.overdue, 5), { partial: true });
  delivered(byIdx(cls.closed, 0), { pickup: byIdx(cls.closed, 0) ? termKey(byIdx(cls.closed, 0)!.delivery_terms) === 'Ex-Works' : false });
  delivered(byIdx(cls.closed, 1), { pickup: byIdx(cls.closed, 1) ? termKey(byIdx(cls.closed, 1)!.delivery_terms) === 'Ex-Works' : false });

  // --- In transit: balances of the partly received POs and a late line finally dispatched
  const inTransit = (po: PoInfo | undefined, daysAgo: number, eta: number, extra: Partial<SeedAsn> = {}, revised = false) => {
    if (!po) { console.warn('asn seed_extra: an in-transit ASN was skipped — PO not found'); return; }
    const t = transport(po);
    const inv = invoiceNo(po);
    const created = isoAt(DAY(-daysAgo - 1), 11);
    add(created, `in-transit ASN ${po.po_no}`, () => {
      const lines = openBalance(po.id).map((x) => [x.item, x.qty] as [number, number]);
      const a = seedAsn({
        po: po.po_no, vendor: vendorLocal(po.vendor_id), lines, status: 'In transit', dispatch: DAY(-daysAgo), expected: DAY(eta), created, submitted: isoAt(DAY(-daysAgo - 1), 14),
        transporter: t.transporter, lr: t.lr, vehicle: t.vehicle, eway: t.eway, invoiceRef: inv, packing: 'Balance quantity, packed and strapped', ...(termKey(po.delivery_terms) === 'Ex-Works' ? { pickupBy: 'Vendor' as const } : {}),
        docs: docsFor(po, inv, t), ...extra,
      });
      if (a && revised) {
        const { id: _i, created_by: _c, ...snap } = get<Record<string, unknown>>('SELECT * FROM asns WHERE id = ?', a.id)!;
        insert('asn_versions', { asn_id: a.id, version: 1, snapshot_json: J({ ...snap, expected_date: DAY(eta - 1), vehicle_no: `${STATE_CODE[po.plant] ?? 'MH12'}ZZ0000`, version: 1 }), reason: 'Vehicle changed after a breakdown on the highway; delivery moves by a day.', created_by: get<{ id: number }>('SELECT id FROM users WHERE vendor_id = ? ORDER BY id', po.vendor_id)?.id ?? null, created_at: isoAt(DAY(-1), 17) });
        update('asns', a.id, { version: 2 });
      }
    });
  };
  inTransit(byIdx(cls.partial, 0), 2, 1);
  inTransit(byIdx(cls.overdue, 5), 1, 1);
  inTransit(byIdx(cls.overdue, 2), 1, 2, {}, true);

  // --- Cancelled and re-submitted, Submitted with an overdue Equipcare pickup, Drafts
  const o6 = byIdx(cls.overdue, 6);
  if (o6) {
    const t = transport(o6);
    const inv = invoiceNo(o6);
    add(isoAt(DAY(-10), 11), `cancelled ASN ${o6.po_no}`, () => {
      const a = seedAsn({ po: o6.po_no, vendor: vendorLocal(o6.vendor_id), lines: openBalance(o6.id).map((x) => [x.item, x.qty] as [number, number]), status: 'Submitted', dispatch: DAY(-9), expected: DAY(-6), created: isoAt(DAY(-10), 11), submitted: isoAt(DAY(-10), 14), transporter: t.transporter, lr: t.lr, vehicle: t.vehicle, eway: t.eway, invoiceRef: inv, docs: docsFor(o6, inv, t) });
      if (a) {
        update('asns', a.id, { status: 'Cancelled', cancel_reason: 'Vehicle broke down at the vendor gate; the consignment will be re-dispatched with a new e-way bill.' });
        audit(null, { action: 'asn.cancelled', objectType: 'asn', objectId: a.id, objectRef: a.asnNo, before: { status: 'Submitted' }, after: { status: 'Cancelled' }, reason: 'Vehicle broke down at the vendor gate; the consignment will be re-dispatched with a new e-way bill.' });
      }
    });
    const t2 = transport(o6);
    const inv2 = invoiceNo(o6);
    add(isoAt(DAY(-2), 11), `submitted ASN ${o6.po_no}`, () => {
      seedAsn({ po: o6.po_no, vendor: vendorLocal(o6.vendor_id), lines: openBalance(o6.id).map((x) => [x.item, x.qty] as [number, number]), status: 'Submitted', dispatch: DAY(0), expected: DAY(2), created: isoAt(DAY(-2), 11), submitted: isoAt(DAY(-2), 14), transporter: t2.transporter, lr: t2.lr, vehicle: t2.vehicle, eway: t2.eway, invoiceRef: inv2, packing: 'Re-packed after the cancelled dispatch', docs: docsFor(o6, inv2, t2) });
    });
  }
  const o0 = byIdx(cls.overdue, 0);
  if (o0) {
    const inv = invoiceNo(o0);
    add(isoAt(DAY(-5), 11), `pickup ASN ${o0.po_no}`, () => {
      seedAsn({
        po: o0.po_no, vendor: vendorLocal(o0.vendor_id), lines: openBalance(o0.id).map((x) => [x.item, x.qty] as [number, number]), status: 'Submitted', dispatch: DAY(-4), expected: DAY(-1), created: isoAt(DAY(-5), 11), submitted: isoAt(DAY(-5), 14),
        pickupBy: 'Equipcare', pickupDate: DAY(-3), pickupStatus: 'Scheduled', invoiceRef: inv, packing: 'Ready for pickup at the vendor works; crated and labelled', docs: docsFor(o0, inv, null, false),
      });
    });
  }
  const draft = (po: PoInfo | undefined, pickItems: number[] | null, daysAgo: number) => {
    if (!po) { console.warn('asn seed_extra: a draft ASN was skipped — PO not found'); return; }
    const inv = invoiceNo(po);
    add(isoAt(DAY(-daysAgo), 10), `draft ASN ${po.po_no}`, () => {
      const lines = lineQtyAll(po.id).filter((l) => !pickItems || pickItems.includes(l.item)).map((l) => [l.item, l.qty] as [number, number]);
      seedAsn({ po: po.po_no, vendor: vendorLocal(po.vendor_id), lines, status: 'Draft', dispatch: DAY(2), expected: DAY(5), created: isoAt(DAY(-daysAgo), 10), submitted: '', invoiceRef: inv, docs: docsFor(po, inv, null, false) });
      run("UPDATE asns SET submitted_at = NULL WHERE po_id = ? AND status = 'Draft'", po.id);
    });
  };
  draft(byIdx(cls.overdue, 3), [10], 1);
  draft(byIdx(cls.accepted, 4), null, 2);

  tl.run();
}

// ------------------------------------------------------------------ disputes
interface Cand { line_id: number; po_id: number; item: number; qty: number; uom: string; unit_price: number; po_no: string; plant: string; vendor_id: number; delivery_terms: string | null; buyer_id: number | null; grn_id: number; grn_no: string; grn_qty: number; posting_date: string }
interface Spec {
  age: number; type: string; frac: number; term?: 'FOR' | 'Ex-Works'; vendorUser?: boolean; byBuyer?: boolean; hour?: number;
  desc: string; photos?: number;
}

function seedDisputes() {
  const tl = timeline('asn dispute seed_extra');
  const stores = (plant: string) => actor(plant === 'DHN1' ? 'lakshmi.reddy' : 'suresh.pawar');
  const cands = all<Cand>(
    `SELECT l.id AS line_id, l.po_id, l.item, l.qty, l.uom, l.unit_price, p.po_no, p.plant, p.vendor_id, p.delivery_terms, p.buyer_id, g.id AS grn_id, g.grn_no, g.qty AS grn_qty, g.posting_date
     FROM po_lines l JOIN pos p ON p.id = l.po_id JOIN grns g ON g.po_line_id = l.id
     WHERE p.po_no >= ? AND p.po_no < ? AND p.status != 'Cancelled' AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.po_line_id = l.id) ORDER BY g.posting_date DESC, l.id`, String(EXTRA.poHistoricFrom), String(EXTRA.poOpenFrom + 500),
  );
  const used = new Set<number>();
  const choose = (s: Spec) => {
    const raised = DAY(-s.age);
    const ok = cands.filter((c) => !used.has(c.line_id) && c.posting_date <= raised && (!s.term || termKey(c.delivery_terms) === s.term) && (!s.vendorUser || !!vendorActor(c.vendor_id)));
    ok.sort((a, b) => (b.posting_date > a.posting_date ? 1 : b.posting_date < a.posting_date ? -1 : 0));
    const c = ok[0];
    if (c) used.add(c.line_id);
    return c;
  };
  const buyerOf = (c: Cand) => actor(localOf(get<{ email: string }>('SELECT email FROM users WHERE id = ?', c.buyer_id ?? 0)?.email ?? 'amit.kulkarni@x'));
  const asnFor = (c: Cand) => get<{ id: number }>("SELECT a.id FROM asns a WHERE a.po_id = ? AND a.status = 'Delivered' AND a.lines_json LIKE ? ORDER BY a.id LIMIT 1", c.po_id, `%"po_line_id":${c.line_id},%`)?.id ?? null;

  /** Registers one dispute: `steps` receives helpers and the (lazily set) dispute row. */
  function plan(name: string, s: Spec, steps: (h: H) => void) {
    const c = choose(s);
    if (!c) { console.warn(`asn dispute seed_extra: ${name} skipped — no receipt matches`); return; }
    const base = DAY(-s.age);
    const raiser = s.byBuyer ? buyerOf(c) : stores(c.plant);
    const state: { id: number } = { id: 0 };
    const at = (days: number, hour = 11) => isoAt(base, hour, days);
    const dsp = () => D.getDispute(state.id)!;
    const asnId = asnFor(c);
    const qty = s.type === 'Excess' ? Math.max(1, Math.round(c.qty * 0.15)) : Math.max(1, Math.min(c.qty, Math.round(c.grn_qty * s.frac)));
    const t0 = at(0, s.hour ?? 10);
    tl.when(t0, `${name} raise`, () => {
      const ids: number[] = [];
      for (let i = 0; i < (s.photos ?? 0); i++) ids.push(photo(`${s.type.toLowerCase().replace(/ /g, '-')}-${c.po_no}-${i + 1}.png`, raiser.id, [[130, 110, 90], [95, 105, 120], [120, 100, 100]][i % 3] as [number, number, number]));
      state.id = D.raiseDispute(raiser, { po_line_id: c.line_id, asn_id: asnId, grn_id: c.grn_id, type: s.type, qty, description: s.desc, attachment_ids: ids }, { at: t0 }).id;
    });
    steps({ c, at, dsp, buyer: buyerOf(c), vendor: vendorActor(c.vendor_id), raiser, when: (ts, label, fn) => tl.when(ts, `${name} ${label}`, fn), state });
  }
  interface H {
    c: Cand; at: (days: number, hour?: number) => string; dsp: () => D.DisputeRow; buyer: Actor; vendor: Actor | null; raiser: Actor;
    when: (ts: string, label: string, fn: () => void) => void; state: { id: number };
  }
  const evidence = (h: H, who: Actor, ts: string, label: string, file: string, title: string, lines: string[], note: string, vendorVisible = false) =>
    h.when(ts, `evidence ${label}`, () => D.addEvidence(who, h.state.id, { attachment_ids: [pdf(file, label, title, lines, who.id, vendorVisible)], note }));
  const respond = (h: H, ts: string, body: string, file: string, label: string) =>
    h.when(ts, 'vendor response', () => {
      const v = h.vendor;
      if (!v) throw new Error('vendor has no portal user');
      D.vendorRespond(v, h.state.id, { body, attachment_ids: [pdf(file, label, `${label} — ${h.dsp().dsp_no}`, [`PO ${h.c.po_no} item ${h.c.item}`, body.slice(0, 80)], v.id)] });
    });
  const outcome = (h: H, who: Actor, ts: string, kind: string, text: string, amountFrac?: number) =>
    h.when(ts, `outcome ${kind}`, () => D.recordOutcome(who, h.state.id, { outcome: kind, note: text, amount: amountFrac ? Math.round((h.dsp().value ?? 0) * amountFrac) : null }));
  const close = (h: H, who: Actor, ts: string, text: string) => h.when(ts, 'close', () => D.closeDispute(who, h.state.id, text));
  const note = (h: H, who: Actor, ts: string, text: string, visible = false) => h.when(ts, 'note', () => D.addNote(who, h.state.id, { body: text, vendor_visible: visible }));

  // Oldest first so the DSP numbers follow the calendar.
  plan('D40 shortage', { age: 40, type: 'Shortage', frac: 0.3, desc: 'Counted at the dock: short against the invoice quantity. Packing list and invoice match the PO, the carton was short.', hour: 10 }, (h) => {
    note(h, h.buyer, h.at(2), 'Called the vendor: they say the short quantity goes with the next consignment. No date given yet.');
    h.when(h.at(5), 'request response', () => D.requestResponse(h.buyer, h.state.id, 'Please confirm the short-supplied quantity and the dispatch date, or issue a credit note. This is holding the invoice.'));
  });
  plan('D35 transit damage, reopened', { age: 35, type: 'Transit damage', frac: 0.2, term: 'FOR', vendorUser: true, photos: 2, desc: 'Two units cracked in transit; the carton was crushed on one side and the carrier note was signed with remarks.', hour: 11 }, (h) => {
    respond(h, h.at(2), 'We have checked the dispatch photos: packing was intact at our dock. Raising a claim with the carrier and sending replacements at our cost.', 'dispatch-photos.pdf', 'Vendor response');
    outcome(h, h.buyer, h.at(6), 'Replacement', 'Vendor agrees to send replacement units at its own cost; carrier claim is the vendor\'s matter.');
    close(h, h.buyer, h.at(9), 'Replacement agreed');
    h.when(h.at(21), 'reopen', () => D.reopenDispute(h.buyer, h.state.id, 'The replacement units arrived with the same crack on the housing; reopening to ask for a credit note instead.'));
  });
  plan('D31 excess', { age: 31, type: 'Excess', frac: 0.1, term: 'FOR', desc: 'Vendor delivered more than the PO line; the extra units were not requested and are held at the dock.', hour: 12 }, (h) => {
    note(h, h.buyer, h.at(1), 'Excess quantity is outside the PO tolerance. Checking with the requisitioner whether the extra units can be used.');
    outcome(h, h.buyer, h.at(4), 'Debit note', 'Requisitioner does not need the extra units; returning them and raising a debit note for the excess value.', 1);
    close(h, h.buyer, h.at(6), 'Debit note raised and excess stock returned');
  });
  plan('D27 accidental loss', { age: 27, type: 'Accidental loss', frac: 0.15, desc: 'Item dropped by the forklift during unloading and written off under the stores incident report.', hour: 15 }, (h) => {
    outcome(h, h.raiser, h.at(3), 'Accepted as-is', 'Loss after receipt; no vendor or carrier liability. Written off under the stores incident report.');
    close(h, h.buyer, h.at(6), 'Closed after the incident report was filed');
  });
  plan('D24 damage, logistics', { age: 24, type: 'Damage', frac: 0.25, term: 'Ex-Works', photos: 1, desc: 'Equipcare-arranged pickup: consignment received with a bent flange and torn packing; photos taken at the gate.', hour: 10 }, (h) => {
    evidence(h, h.buyer, h.at(1), 'Transporter claim', 'transporter-claim.pdf', 'Transporter claim', [`Claim for PO ${h.c.po_no} item ${h.c.item}`, 'Damage found at delivery; surveyor report attached'], 'Claim lodged with the transporter');
    h.when(h.at(2), 'under resolution', () => D.markUnderResolution(h.buyer, h.state.id, 'Transporter claim in progress; surveyor visit booked'));
    outcome(h, h.buyer, h.at(9), 'Transporter claim', 'Transporter accepted the claim after the surveyor report; amount to be recovered from the freight bill.', 0.9);
    close(h, h.buyer, h.at(12), 'Claim settled');
  });
  plan('D22 transit loss, logistics', { age: 22, type: 'Transit loss', frac: 0.2, term: 'Ex-Works', desc: 'One carton listed on the LR did not arrive at the plant; the transporter has not traced it.', hour: 14 }, (h) => {
    note(h, h.buyer, h.at(1), 'Transporter asked for the LR copy and the signed pickup challan; sending both today.');
    outcome(h, h.buyer, h.at(14), 'Insurance claim', 'Carton not traced after 14 days. Filing a marine insurance claim for the lost value.', 1);
  });
  plan('D18 wrong material', { age: 18, type: 'Wrong material', frac: 0.5, term: 'FOR', vendorUser: true, desc: 'Received a different part number than ordered; the tag on the box shows the superseded code.', hour: 11 }, (h) => {
    h.when(h.at(1), 'request response', () => D.requestResponse(h.buyer, h.state.id, 'Please confirm the part number you shipped and arrange the correct item. We are holding the received units for return.'));
    respond(h, h.at(3), 'Part number was changed by our store by mistake. We will collect the wrong units and ship the correct ones this week.', 'corrective-note.pdf', 'Vendor response');
    outcome(h, h.buyer, h.at(7), 'Replacement', 'Vendor to collect the wrong units and deliver the correct part; no payment for the wrong units.');
  });
  plan('D15 shortage, closure approval', { age: 15, type: 'Shortage', frac: 0.35, term: 'Ex-Works', vendorUser: true, desc: 'Counted short at the dock against the invoice and LR; the carton seal was intact.', hour: 10 }, (h) => {
    evidence(h, h.raiser, h.at(0, 12), 'Shortage report', 'shortage-report.pdf', 'Shortage report', [`Short receipt on PO ${h.c.po_no} item ${h.c.item}`, 'Counted by two stores staff'], 'Shortage report from stores', true);
    respond(h, h.at(2), 'Our packing record shows the full quantity left the works. We will accept a credit note for the short quantity.', 'packing-record.pdf', 'Vendor response');
    outcome(h, h.buyer, h.at(6), 'Credit note', 'Vendor agrees a credit note for the short quantity.', 1);
    h.when(h.at(8), 'request closure approval', () => {
      const d = h.dsp();
      const po = get<{ po_no: string; plant: string; vendor_name: string }>('SELECT p.po_no, p.plant, v.name AS vendor_name FROM pos p JOIN vendors v ON v.id = p.vendor_id WHERE p.id = ?', d.po_id)!;
      const ap = createApproval(h.buyer, {
        type: 'dispute.closure', objectType: 'dispute', objectId: d.id, title: `Close dispute ${d.dsp_no} (${d.type})`,
        summary: `PO ${po.po_no} · ${po.vendor_name} · outcome ${d.outcome} ₹${d.outcome_amount}`, value: d.value ?? 0, reason: d.outcome_note ?? undefined, plant: po.plant, context: { dsp_no: d.dsp_no, outcome: d.outcome, po_no: po.po_no },
      });
      update('disputes', d.id, { closure_approval_id: ap.id });
      insert('dispute_events', { dispute_id: d.id, user_id: h.buyer.id, kind: 'closure_requested', body: `Closure sent for approval (${ap.req_no}).`, vendor_visible: 0, created_at: h.at(8) });
      audit(h.buyer, { action: 'dispute.closure_requested', objectType: 'dispute', objectId: d.id, objectRef: d.dsp_no, after: { approval: ap.req_no }, reason: 'Credit note agreed' });
    });
  });
  plan('D12 quality rejection, finance', { age: 12, type: 'Quality rejection', frac: 0.4, term: 'FOR', desc: 'Failed incoming inspection: hardness below the drawing limit on three samples.', hour: 15 }, (h) => {
    evidence(h, h.raiser, h.at(0, 16), 'Rejection note', 'rejection-note.pdf', 'Rejection note', [`Rejected on PO ${h.c.po_no} item ${h.c.item}`, 'Hardness test below limit on 3 of 3 samples'], 'Incoming inspection rejection note', true);
    h.when(h.at(1), 'reassign to finance', () => D.reassign(h.buyer, h.state.id, { owner_party: 'Finance', reason: 'A credit note is expected; Accounts Payable to hold the invoice and track the settlement with the vendor.' }));
    note(h, actor('meera.iyer'), h.at(2), 'Invoice is on hold. Waiting for the credit note from the vendor before releasing payment.');
  });
  plan('D10 transit damage, logistics', { age: 10, type: 'Transit damage', frac: 0.15, term: 'Ex-Works', photos: 2, desc: 'Pickup by Equipcare transporter: two units damaged in the truck; photos taken at the dock.', hour: 12 }, (h) => {
    evidence(h, h.buyer, h.at(1), 'Transporter claim', 'transporter-claim.pdf', 'Transporter claim', [`Claim for PO ${h.c.po_no} item ${h.c.item}`, 'Damage in transit; photos and LR copy attached'], 'Claim lodged with the transporter');
    h.when(h.at(2), 'under resolution', () => D.markUnderResolution(h.buyer, h.state.id, 'Transporter claim lodged; waiting for the surveyor'));
  });
  plan('D8 document mismatch', { age: 8, type: 'Document mismatch', frac: 0.2, term: 'FOR', byBuyer: true, desc: 'Invoice quantity does not match the packing list and the goods received; GST invoice number differs from the e-way bill.', hour: 11 }, (h) => {
    h.when(h.at(1), 'request response', () => D.requestResponse(h.buyer, h.state.id, 'Please send a corrected invoice or a credit note so that the invoice, e-way bill and packing list agree.'));
  });
  plan('D6 damage', { age: 6, type: 'Damage', frac: 0.2, term: 'FOR', vendorUser: true, photos: 1, desc: 'Item received with a dented housing; packing carton intact, so the damage looks like a handling defect at the vendor.', hour: 10 }, (h) => {
    respond(h, h.at(2), 'We have reviewed the photos. The housing dent is a transport mark; we will exchange the unit at our cost on the next dispatch.', 'exchange-offer.pdf', 'Vendor response');
  });
  plan('D4 excess', { age: 4, type: 'Excess', frac: 0.1, term: 'FOR', desc: 'Vendor shipped one more carton than the PO line; the extra carton is held at the dock.', hour: 13 }, (h) => {
    note(h, h.buyer, h.at(1), 'Excess carton is outside tolerance. Asking the requisitioner whether it can be absorbed before returning it.');
  });
  plan('D2 shortage', { age: 2, type: 'Shortage', frac: 0.25, term: 'FOR', desc: 'Counted short at the dock against the invoice; the carton count matches the LR.', hour: 10 }, () => {});
  plan('D1 shortage', { age: 1, type: 'Shortage', frac: 0.2, desc: 'Short receipt noted during unloading; GRN posted for the quantity actually counted.', hour: 15 }, () => {});

  tl.run();
}
