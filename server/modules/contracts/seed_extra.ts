/**
 * Module 6 extended demo data (only with DEMO_EXTRA): a working contract book on top of the base seed.
 *
 * Platform-created contracts in every lifecycle state (Draft, Pending approval at level 1 and 2, Pending SAP, Active, Expiring,
 * Expired, Renewed, Terminated), an FDS with three price-list versions, a VMI with min/max, ARCs above the utilisation warning,
 * change requests, off-contract alerts that were justified or dismissed, and ARC/OA opportunities that were accepted, rejected
 * or put under review. Everything goes through the real services as the right persona; only timestamps are backdated.
 * Deterministic: no Math.random().
 */
import { all, get, run, scalar } from '../../core/db.ts';
import { act, getApproval } from '../../core/approvals.ts';
import { sapGet, sapPut, syncEvent } from '../../core/sap.ts';
import type { Role } from '../../core/permissions.ts';
import { actorFor, D, DAY, M, V } from '../../seed/ctx.ts';
import { createOa } from '../sap/simulator.ts';
import * as S from './service.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const warn = (what: string, e: unknown) => console.warn(`contracts seed_extra: ${what} skipped —`, (e as Error).message);

/** Decide an approval as whoever holds the pending step (never the requester). `stopAfterLevel` leaves the next level waiting. */
function decide(apId: number, action: 'approve' | 'reject' | 'return', comment: string, stopAfterLevel?: number) {
  for (let guard = 0; guard < 6; guard++) {
    const ap = getApproval(apId);
    if (!ap || ap.status !== 'Pending') return ap;
    if (stopAfterLevel && ap.current_level > stopAfterLevel) return ap;
    const step = get<{ approver_role: string }>("SELECT approver_role FROM approval_steps WHERE approval_id = ? AND level = ? AND status = 'Pending' ORDER BY id", apId, ap.current_level);
    if (!step) return ap;
    const u = get<{ email: string }>("SELECT email FROM users WHERE vendor_id IS NULL AND (',' || roles || ',') LIKE ? AND id != ? ORDER BY id", `%,${step.approver_role},%`, ap.requester_id);
    if (!u) throw new Error(`no ${step.approver_role} approver available`);
    act(actorFor(u.email.split('@')[0], step.approver_role as Role), apId, action, comment);
    if (action !== 'approve') return getApproval(apId);
  }
  return getApproval(apId);
}

/** Spread an approval over a few days starting `startDay` (negative = past). Domain timestamps only; the audit chain is untouched. */
function backdateApproval(apId: number | null | undefined, startDay: number) {
  if (!apId) return;
  const ap = getApproval(apId);
  if (!ap) return;
  run('UPDATE approvals SET created_at = ?, decided_at = CASE WHEN decided_at IS NULL THEN NULL ELSE ? END WHERE id = ?', D(startDay, 11), D(Math.min(-0, startDay + 2), 15), apId);
  const steps = all<{ id: number; level: number }>('SELECT id, level FROM approval_steps WHERE approval_id = ? AND acted_at IS NOT NULL ORDER BY level, id', apId);
  steps.forEach((s, i) => run('UPDATE approval_steps SET acted_at = ? WHERE id = ?', D(Math.min(-0, startDay + 1 + i), 12 + i), s.id));
}

/** Wait one millisecond so the next SAP document change sorts after the last sync watermark. */
function tick() {
  const t = Date.now();
  while (Date.now() === t) { /* spin */ }
}

/** SAP changes an outline agreement (consumption, validity) and the inbound sync brings it over. */
function sapAmend(oaNo: string, patch: (p: any) => any) {
  const cur = sapGet<any>('OA', oaNo);
  if (!cur) throw new Error(`SAP OA ${oaNo} missing`);
  tick();
  sapPut('OA', oaNo, patch(cur.payload), 'Seed');
  syncEvent('OA');
}

type Stage = 'draft' | 'pending1' | 'pending2' | 'pendingSap' | 'active';
interface Spec {
  owner: 'amit.kulkarni' | 'sneha.patil';
  input: S.ContractInput;
  daysAgo: number;
  stage: Stage;
  note: string;
  approveNote?: string;
}

function build(spec: Spec) {
  const owner = actorFor(spec.owner);
  const c = S.createContract(owner, spec.input);
  run('UPDATE contracts SET created_at = ? WHERE id = ?', D(-spec.daysAgo, 10), c.id);
  if (spec.stage === 'draft') return S.getContract(c.id)!;
  S.submitContract(owner, c.id, spec.note);
  const apId = scalar<number>('SELECT approval_id FROM contracts WHERE id = ?', c.id)!;
  if (spec.stage !== 'pending1') decide(apId, 'approve', spec.approveNote ?? 'Rates checked against last purchase prices and budget — approved.', spec.stage === 'pending2' ? 1 : undefined);
  backdateApproval(apId, -spec.daysAgo + 1);
  if (spec.stage === 'active') createOa(actorFor('neha.gupta'), c.id);
  return S.getContract(c.id)!;
}

const mat = (code: string) => M(code);
const item = (code: string, unit_price: number, qty_cap: number | null = null, extra: Partial<S.ItemInput> = {}): S.ItemInput => ({ material_id: mat(code), unit_price, qty_cap, ...extra });

export function seedExtra() {
  const amit = actorFor('amit.kulkarni');
  const sneha = actorFor('sneha.patil');
  const r = rng(26102025);
  const between = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));

  // 1. Draft: FDS for workshop tools with a launch price list and a later revision already entered (versions on a draft apply at once).
  try {
    const c = build({
      owner: 'sneha.patil', daysAgo: 6, stage: 'draft', note: '',
      input: {
        type: 'FDS', vendor_id: V('100123'), title: 'Fixed discount structure – workshop tools (Odisha Mining Tools)', category: 'TLS', plant: '*',
        valid_from: DAY(10), valid_to: DAY(374), value_cap: 1200000, payment_terms: '30 days', delivery_terms: 'FOR destination', discount_pct: 10, invoice_validation: true,
        terms: 'Fixed 10% discount on the vendor catalogue price version in force on the PO date. Draft prepared after the TLS-7003/7004 opportunity review.',
        items: [item('TLS-7003', 6210, 60, { list_price: 6900 }), item('TLS-7004', 43650, 12, { list_price: 48500 })],
        price_list: { effective_from: DAY(10), items: [{ material_id: mat('TLS-7003'), list_price: 6900 }, { material_id: mat('TLS-7004'), list_price: 48500 }], note: 'Catalogue received with quotation' },
      },
    });
    S.addPriceList(sneha, c.id, { effective_from: DAY(100), items: [{ material_id: mat('TLS-7003'), list_price: 7150 }, { material_id: mat('TLS-7004'), list_price: 50200 }], note: 'Announced revision from January' });
  } catch (e) { warn('FDS draft', e); }

  // 2. Draft: ARC for hydraulic fittings, being negotiated.
  try {
    build({
      owner: 'amit.kulkarni', daysAgo: 3, stage: 'draft', note: '',
      input: {
        type: 'ARC', vendor_id: V('100124'), title: 'Annual rate contract – hydraulic fittings (Telangana Hose Works)', category: 'HYD', plant: '*',
        valid_from: DAY(15), valid_to: DAY(379), value_cap: 750000, payment_terms: '45 days from GRN', delivery_terms: 'FOR destination',
        terms: 'Draft for negotiation. Vendor to hold the rate for 12 months; delivery within 7 days of PO.',
        items: [item('HYD-1005', 2520, 150), item('HYD-1002', 23600, 14)],
      },
    });
  } catch (e) { warn('ARC draft', e); }

  // 3. Pending approval, level 1 (procurement manager) waiting.
  try {
    build({
      owner: 'sneha.patil', daysAgo: 2, stage: 'pending1', note: 'Gas and electrode volumes justify a rate contract; rate is 4% below the last three POs.',
      input: {
        type: 'ARC', vendor_id: V('100119'), title: 'Annual rate contract – industrial gases (Gujarat Industrial Gases)', category: 'WLD', plant: '*',
        valid_from: DAY(7), valid_to: DAY(371), value_cap: 600000, payment_terms: '45 days from GRN', delivery_terms: 'FOR destination',
        terms: 'Cylinder rental included for 30 days. Price revision only if the gas index moves more than 5%.',
        items: [item('WLD-6004', 3500, 160)],
      },
    });
  } catch (e) { warn('pending level 1', e); }

  // 4. Pending approval, level 2 (finance) waiting after the procurement manager approved.
  try {
    build({
      owner: 'sneha.patil', daysAgo: 5, stage: 'pending2', note: 'Battery and harness spend crossed the ARC threshold; vendor offered 6% off list for a 12-month commitment.',
      approveNote: 'Rates reviewed against the last purchase price — approved at procurement level.',
      input: {
        type: 'ARC', vendor_id: V('100121'), title: 'Annual rate contract – batteries and harnesses (Chennai Power Electricals)', category: 'ELE', plant: '*',
        valid_from: DAY(5), valid_to: DAY(369), value_cap: 1500000, payment_terms: '30 days', delivery_terms: 'FOR destination',
        terms: 'Batteries carry an 18-month replacement warranty. Core return at delivery.',
        items: [item('ELE-9002', 13900, 60), item('ELE-9003', 17500, 24)],
      },
    });
  } catch (e) { warn('pending level 2', e); }

  // 5. Pending SAP: approved, waiting for the SAP team to create the outline agreement (not routable yet, FR-CON-09).
  try {
    build({
      owner: 'amit.kulkarni', daysAgo: 8, stage: 'pendingSap', note: 'Cutting edges and end bits for the WA600 fleet; two RFQs in the last year gave the same winner.',
      input: {
        type: 'ARC', vendor_id: V('100122'), title: 'Annual rate contract – cutting edges and end bits (Raipur Heavy Equipment)', category: 'UCG', plant: '*',
        valid_from: DAY(0), valid_to: DAY(364), value_cap: 1800000, payment_terms: '45 days from GRN', delivery_terms: 'FOR destination',
        terms: 'Rates firm for 12 months. Vendor stocks 6 sets at the Nagpur workshop.',
        items: [item('UCG-2008', 42200, 24), item('UCG-2009', 17300, 30)],
      },
    });
  } catch (e) { warn('pending SAP', e); }

  // 6. Active VMI with minimum and maximum levels at Chakan (stock below minimum raises NTF-15).
  try {
    const c = build({
      owner: 'sneha.patil', daysAgo: 150, stage: 'active', note: 'Vendor-managed stock of fast-moving filters at Chakan.',
      input: {
        type: 'VMI', vendor_id: V('100125'), title: 'Vendor-managed inventory – engine and transmission filters (Bengaluru Lubricant Traders)', category: 'FLT', plant: 'PUN1',
        valid_from: DAY(-140), valid_to: DAY(225), value_cap: 900000, payment_terms: '30 days from invoice', delivery_terms: 'FOR destination',
        terms: 'Vendor replenishes to the maximum every two weeks and invoices monthly on consumption.',
        items: [item('FLT-4004', 1880), item('FLT-4005', 2520), item('FLT-4006', 1090)],
        vmi: {
          items: [{ material_id: mat('FLT-4004'), min: 12, max: 48 }, { material_id: mat('FLT-4005'), min: 10, max: 40 }, { material_id: mat('FLT-4006'), min: 16, max: 60 }],
          replenishment_frequency: 'Fortnightly', billing_cycle: 'Monthly on consumption (GRN of issues)', reconciliation: 'Joint count with Chakan stores on the last working day of each month.', plant: 'PUN1',
        },
      },
    });
    void c;
  } catch (e) { warn('VMI', e); }

  // 7. Active ARC with item utilisation above 80%, one terms change waiting for approval.
  try {
    const c = build({
      owner: 'amit.kulkarni', daysAgo: 160, stage: 'active', note: 'Track hardware moves every month; vendor agreed a firm rate for the year.',
      input: {
        type: 'ARC', vendor_id: V('100117'), title: 'Annual rate contract – track hardware and carrier rollers (Anand Fasteners)', category: 'UCG', plant: '*',
        valid_from: DAY(-150), valid_to: DAY(215), value_cap: 760000, payment_terms: '45 days from GRN', delivery_terms: 'FOR destination',
        terms: 'Rate firm for 12 months. Delivery within 10 days of PO; free replacement for bolts failing torque test.',
        items: [item('UCG-2006', 20900, 22), item('UCG-2007', 27100, 12)],
      },
    });
    sapAmend(c.sap_oa_no ?? scalar<string>('SELECT sap_oa_no FROM contracts WHERE id = ?', c.id)!, (p) => ({
      ...p, consumed_value: 20900 * 19 + 27100 * 9,
      items: p.items.map((i: any) => ({ ...i, consumed_qty: i.material_code === 'UCG-2006' ? 19 : 9 })),
    }));
    const ch = S.requestChange(amit, c.id, { fields: { payment_terms: '60 days from GRN' }, items: [{ material_id: mat('UCG-2006'), qty_cap: 30 }], reason: 'Consumption is running ahead of plan; raise the bolt-set cap and align payment terms with the other undercarriage contracts.' });
    run('UPDATE contract_changes SET created_at = ? WHERE id = ?', D(-2, 15), ch.id);
    backdateApproval(ch.approval_id, -2);
  } catch (e) { warn('ARC with utilisation', e); }

  // 8. Active FDS with three price-list versions (v3 takes effect next month).
  try {
    const c = build({
      owner: 'sneha.patil', daysAgo: 205, stage: 'draft', note: '',
      input: {
        type: 'FDS', vendor_id: V('100107'), title: 'Fixed discount structure – welding consumables (Apex Welding)', category: 'WLD', plant: '*',
        valid_from: DAY(-195), valid_to: DAY(170), value_cap: 700000, payment_terms: '30 days', delivery_terms: 'FOR destination', discount_pct: 6, invoice_validation: true,
        terms: 'Fixed 6% discount on the vendor catalogue version in force on the PO date. Invoices are validated against that version (FR-INV-18).',
        items: [item('WLD-6002', 8366, 40, { list_price: 8900 }), item('PPE-8002', 89, 600, { list_price: 95 })],
        price_list: { effective_from: DAY(-195), items: [{ material_id: mat('WLD-6002'), list_price: 8500 }, { material_id: mat('PPE-8002'), list_price: 90 }], note: 'Launch catalogue' },
      },
    });
    S.addPriceList(sneha, c.id, { effective_from: DAY(-90), items: [{ material_id: mat('WLD-6002'), list_price: 8900 }, { material_id: mat('PPE-8002'), list_price: 95 }], note: 'Steel and consumables price revision' });
    S.addPriceList(sneha, c.id, { effective_from: DAY(20), items: [{ material_id: mat('WLD-6002'), list_price: 9250 }, { material_id: mat('PPE-8002'), list_price: 99 }], note: 'Revision announced for next month' });
    S.submitContract(sneha, c.id, 'FDS for welding rods and gloves; three catalogue versions on file.');
    const apId = scalar<number>('SELECT approval_id FROM contracts WHERE id = ?', c.id)!;
    decide(apId, 'approve', 'Discount matches the negotiated sheet — approved.');
    backdateApproval(apId, -204);
    createOa(actorFor('neha.gupta'), c.id);
  } catch (e) { warn('FDS with versions', e); }

  // 9. Expiring ARC with an extension request waiting for approval.
  try {
    const c = build({
      owner: 'amit.kulkarni', daysAgo: 333, stage: 'active', note: 'Engine wear parts for the QSK60 fleet.',
      input: {
        type: 'ARC', vendor_id: V('100118'), title: 'Annual rate contract – oil coolers and starter motors (Eastern Engine Spares)', category: 'ENG', plant: '*',
        valid_from: DAY(-333), valid_to: DAY(32), value_cap: 2400000, payment_terms: '60 days from GRN', delivery_terms: 'FOR destination',
        terms: 'Rate firm for 12 months; OEM test certificate with every dispatch.',
        items: [item('ENG-3007', 46100, 14), item('ENG-3003', 61000, 8)],
      },
    });
    const ex = S.extendContract(amit, c.id, { valid_to: DAY(32 + 90), reason: 'Renewal RFQ is planned for next quarter; extend by 90 days at the same rates to avoid a gap.' });
    run('UPDATE contract_changes SET created_at = ? WHERE id = ?', D(-4, 14), ex.id);
    backdateApproval(ex.approval_id, -4);
  } catch (e) { warn('expiring with extension', e); }

  // 10. Expiring fixed-supplier contract where the owner recorded "let expire".
  try {
    const c = build({
      owner: 'sneha.patil', daysAgo: 347, stage: 'active', note: 'Crane hire with operator for the Jamshedpur workshop.',
      input: {
        type: 'Fixed supplier', vendor_id: V('100126'), title: 'Fixed supplier – crane hire with operator (Jamshedpur Heavy Haulage)', category: 'LOG', plant: '*',
        valid_from: DAY(-347), valid_to: DAY(18), value_cap: 500000, payment_terms: '30 days', delivery_terms: 'FOR destination',
        terms: 'Day rate includes operator and fuel. Minimum hire 4 hours.',
        items: [item('LOG-9702', 39500, 12)],
      },
    });
    S.letExpire(sneha, c.id, 'Crane hire is now bought per job through the monthly RFQ; no renewal needed.');
    run("UPDATE contract_changes SET created_at = ? WHERE contract_id = ? AND kind = 'let_expire'", D(-3, 16), c.id);
  } catch (e) { warn('expiring, let expire', e); }

  // 11. Expired outline agreement (SAP shows the validity end in the past and 94% consumed).
  try {
    const c = build({
      owner: 'amit.kulkarni', daysAgo: 372, stage: 'active', note: 'Main relief valves for the D375A fleet.',
      input: {
        type: 'OA', vendor_id: V('100106'), title: 'Outline agreement – main relief valves (Deccan Hydraulics)', category: 'HYD', plant: '*',
        valid_from: DAY(-370), valid_to: DAY(2), value_cap: 1000000, payment_terms: '45 days from GRN', delivery_terms: 'FOR destination',
        terms: 'Reman valves with 12-month warranty; core exchange at delivery.',
        items: [item('HYD-1009', 36800, 28)],
      },
    });
    sapAmend(scalar<string>('SELECT sap_oa_no FROM contracts WHERE id = ?', c.id)!, (p) => ({
      ...p, valid_to: DAY(-9), consumed_value: 36800 * 26,
      items: p.items.map((i: any) => ({ ...i, consumed_qty: 26 })),
    }));
  } catch (e) { warn('expired', e); }

  // 12. Renewed: the old ARC is replaced by an approved renewal that SAP has created.
  try {
    const old = build({
      owner: 'amit.kulkarni', daysAgo: 327, stage: 'active', note: 'Structural repair services for the Jharkhand sites.',
      input: {
        type: 'ARC', vendor_id: V('100109'), title: 'Annual rate contract – structural repair services (Jharkhand Mining Services)', category: 'SRV', plant: '*',
        valid_from: DAY(-327), valid_to: DAY(38), value_cap: 2000000, payment_terms: '45 days from GRN', delivery_terms: 'FOR destination',
        terms: 'Per-job rates for boom and stick repair; rework within 30 days at no charge.',
        items: [item('SRV-9502', 82000, 16), item('SRV-9503', 66000, 12)],
      },
    });
    const ren = S.renewContract(amit, old.id, { reason: 'Rates reconfirmed with the vendor; two jobs overran last year, so cap raised in the renewal.' });
    run('UPDATE contracts SET created_at = ? WHERE id = ?', D(-18, 10), ren.id);
    S.submitContract(amit, ren.id, 'Renewal of the structural repair ARC; same rates, longer validity.');
    const apId = scalar<number>('SELECT approval_id FROM contracts WHERE id = ?', ren.id)!;
    decide(apId, 'approve', 'Renewal at unchanged rates — approved.');
    backdateApproval(apId, -17);
    createOa(actorFor('neha.gupta'), ren.id);
    run("UPDATE contract_changes SET created_at = ? WHERE contract_id = ? AND kind = 'renewal'", D(-18, 10), old.id);
  } catch (e) { warn('renewed', e); }

  // 13. Terminated: a fixed-supplier contract ended early for missed delivery commitments.
  try {
    const c = build({
      owner: 'sneha.patil', daysAgo: 250, stage: 'active', note: 'Gloves and safety shoes for the Nagpur workshop.',
      input: {
        type: 'Fixed supplier', vendor_id: V('100110'), title: 'Fixed supplier – safety shoes and gloves (SafeStep PPE)', category: 'PPE', plant: 'NGP1',
        valid_from: DAY(-240), valid_to: DAY(125), value_cap: 400000, payment_terms: '30 days', delivery_terms: 'FOR destination',
        terms: 'Single source for Nagpur PPE with fortnightly top-up.',
        items: [item('PPE-8001', 1580, 200)],
      },
    });
    S.terminateContract(sneha, c.id, 'Three consecutive POs delivered more than two weeks late; supply moved to the RFQ route.');
  } catch (e) { warn('terminated', e); }

  // 14. Off-contract alerts: backdate to the PO date, then justify (approved / waiting) or dismiss with a reason.
  try {
    for (const a of all<{ id: number; po_date: string }>('SELECT id, po_date FROM contract_alerts')) {
      const age = Math.max(0, Math.round((Date.now() - Date.parse(`${a.po_date}T00:00:00Z`)) / 86400000) - 1);
      run('UPDATE contract_alerts SET created_at = ? WHERE id = ?', D(-age, 11), a.id);
    }
    const open = S.listAlerts({ status: 'Open' }).sort((x, y) => (x.id as number) - (y.id as number));
    const buyerOf = (a: { buyer_id: number | null }) => {
      const u = a.buyer_id ? get<{ email: string }>("SELECT email FROM users WHERE id = ? AND (',' || roles || ',') LIKE '%,BUY,%' AND (',' || roles || ',') NOT LIKE '%,APR,%'", a.buyer_id) : null;
      return actorFor(u ? u.email.split('@')[0] : 'amit.kulkarni');
    };
    const picks = open.filter((_, i) => i % 4 === 1).slice(0, 9);
    const justifications = [
      'Breakdown at the Nagpur workshop: the contract vendor could not deliver inside 48 hours, so the nearest stockist was used.',
      'Contract vendor quoted a longer lead time than the machine downtime allowed; urgent buy approved by the workshop head.',
      'Item was needed with the vendor-supplied OEM test certificate that the contract vendor does not issue.',
    ];
    const dismissals = [
      'PO was raised against the wrong vendor in SAP and has been corrected; no off-contract purchase took place.',
      'Quantity is below the contract minimum order and was part of a trial lot for a different machine model.',
      'Contract was not yet communicated to the plant when this PO was raised; the buyer has been briefed.',
      'Vendor delivered the same make and brand at a lower price after a one-time clearance offer, verified by stores.',
    ];
    picks.forEach((a, i) => {
      const buyer = buyerOf(a as { buyer_id: number | null });
      const day = -Math.min(Number(a.age_days ?? 6), 20) + 1;
      if (i < 3) {
        const j = S.justifyAlert(buyer, a.id as number, justifications[i]);
        if (i < 2) {
          decide(j.approval_id!, 'approve', 'Justification accepted; the contract vendor was informed.');
          run('UPDATE contract_alerts SET decided_at = ? WHERE id = ?', D(Math.min(-1, day + 1), 16), a.id);
        }
        backdateApproval(j.approval_id, Math.min(-1, day));
      } else if (i < 7) {
        S.dismissAlert(actorFor('amit.kulkarni'), a.id as number, dismissals[i - 3]);
        run('UPDATE contract_alerts SET decided_at = ? WHERE id = ?', D(Math.min(-1, day + 2), 12), a.id);
      }
    });
  } catch (e) { warn('off-contract alerts', e); }

  // 15. Opportunities: spread identification dates, then accept (draft ARC), reject with reason or move under review.
  try {
    for (const o of all<{ id: number }>('SELECT id FROM opportunities ORDER BY id')) run('UPDATE opportunities SET identified_at = ? WHERE id = ?', D(-between(14, 150), 8), o.id);
    const byCode = (code: string) => get<{ id: number; status: string; rfq_id: number | null }>('SELECT o.id, o.status, o.rfq_id FROM opportunities o JOIN materials m ON m.id = o.material_id WHERE m.code = ?', code);
    const plan: [string, 'accept' | 'reject' | 'review', string?][] = [
      ['HYD-1008', 'accept', 'Gear pumps are bought four times a year; negotiate an ARC with the incumbent and benchmark with a rate RFQ.'],
      ['LUB-5006', 'accept', 'TO-4 oil volumes are steady across plants; consolidate to one supplier.'],
      ['UCG-2010', 'accept', 'Six vendors supplied the same bucket pin sets; consolidate for price leverage.'],
      ['LUB-5004', 'reject', 'Gear oil is bought against project jobs and the volume swings too much for a rate contract; spot buying is cheaper.'],
      ['TLS-7005', 'reject', 'Multimeters are bought once per workshop opening; the annual value is a few one-off purchases, not recurring demand.'],
      ['ENG-3008', 'reject', 'Starter motors are bought only against failures and the make changes by machine; an ARC would not hold.'],
      ['HYD-1001', 'review'], ['LUB-5005', 'review'], ['HYD-1003', 'review'],
    ];
    for (const [code, what, note] of plan) {
      const o = byCode(code);
      if (!o || o.status !== 'Identified' || o.rfq_id) continue;
      const day = -between(2, 25);
      if (what === 'accept') {
        const res = S.acceptOpportunity(amit, o.id, { note });
        run('UPDATE contracts SET created_at = ? WHERE id = ?', D(day, 10), res.contract_id);
      } else if (what === 'reject') S.rejectOpportunity(amit, o.id, note!);
      else S.reviewOpportunity(amit, o.id);
      run('UPDATE opportunities SET decided_at = ? WHERE id = ?', D(day, 10), o.id);
    }
  } catch (e) { warn('opportunities', e); }

  // Refresh expiry state, price-list versions and notices for everything above.
  S.expiryJob();
}
