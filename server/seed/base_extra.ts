/**
 * Extended demo data, SAP side (opt-in, on by default; tests switch it off with S2P_DEMO_EXTRA=0).
 *
 * Adds a realistic year of procurement on top of the base seed: more vendors and materials, ~60 historic POs with
 * goods receipts, 22 open POs in varied states, ~90 more requisitions and three more outline agreements. Everything is
 * generated from a fixed random seed, so every database gets the same data. Platform-owned records (RFQs, quotations,
 * invoices, disputes …) are layered on by each module's own extended seed.
 */
import { get, insert, run, now } from '../core/db.ts';
import { sapPut, runAllInbound } from '../core/sap.ts';
import { makeGstin, STATE_CODES } from '../core/india.ts';
import { DAY, D } from './ctx.ts';

export const EXTRA = {
  poHistoricFrom: 4500030001,
  poOpenFrom: 4500031001,
  prHistoricFrom: 10044001,
  prOpenFrom: 10046001,
  grnFrom: 5000150001,
};

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

type Mat = [code: string, desc: string, uom: string, group: string, gst: number, hsn: string, lpp: number, service?: boolean];
const MATERIALS: Mat[] = [
  ['HYD-1006', 'Rod seal set, boom cylinder – PC1250', 'SET', 'HYD-SEAL', 18, '40169330', 9600],
  ['HYD-1007', 'Piston seal kit, bucket cylinder – EX1200', 'SET', 'HYD-SEAL', 18, '40169330', 11800],
  ['HYD-1008', 'Hydraulic gear pump – PC200 pilot', 'EA', 'HYD-REMAN', 18, '84136090', 64000],
  ['HYD-1009', 'Main relief valve – D375A', 'EA', 'HYD-REMAN', 18, '84818090', 38500],
  ['HYD-1010', 'Hose clamp set, heavy duty (24 pcs)', 'SET', 'HYD-HOSE', 18, '73269099', 1450],
  ['UCG-2006', 'Track bolt and nut set, 90 pcs – D375A', 'SET', 'UCG-TRK', 18, '73181500', 21500],
  ['UCG-2007', 'Carrier roller assembly – D155A', 'EA', 'UCG-TRK', 18, '84314990', 27800],
  ['UCG-2008', 'Cutting edge, bolt-on 3.2 m – WA600', 'EA', 'UCG-GET', 18, '84314990', 44500],
  ['UCG-2009', 'End bit, left and right pair – WA600', 'PR', 'UCG-GET', 18, '84314990', 18200],
  ['UCG-2010', 'Bucket pin and bush set – PC2000', 'SET', 'UCG-GET', 18, '84314990', 33800],
  ['ENG-3004', 'Piston ring set – SAA12V140', 'SET', 'ENG-BRG', 18, '84099199', 28400],
  ['ENG-3005', 'Cylinder liner kit, 12 pcs – QSK60', 'SET', 'ENG-BRG', 18, '84099199', 142000],
  ['ENG-3006', 'Water pump assembly – QSK60', 'EA', 'ENG-TURBO', 18, '84133090', 36800],
  ['ENG-3007', 'Engine oil cooler core – SAA12V140', 'EA', 'ENG-TURBO', 18, '84198990', 47200],
  ['ENG-3008', 'Starter motor 24 V – HD785', 'EA', 'ENG-FUEL', 18, '85114000', 52500],
  ['FLT-4004', 'Fuel filter element – QSK60 (FS1000)', 'EA', 'FLT-ELM', 18, '84212300', 1980],
  ['FLT-4005', 'Water separator filter – D375A', 'EA', 'FLT-ELM', 18, '84212300', 2650],
  ['FLT-4006', 'Breather filter – PC2000', 'EA', 'FLT-ELM', 18, '84213100', 1150],
  ['FLT-4007', 'Transmission filter – HD785', 'EA', 'FLT-ELM', 18, '84212300', 5400],
  ['LUB-5004', 'Gear oil 80W-90 GL-5, 210 L drum', 'DRM', 'LUB-OIL', 18, '27101980', 46800],
  ['LUB-5005', 'Coolant concentrate, 210 L drum', 'DRM', 'LUB-OIL', 18, '38200000', 29500],
  ['LUB-5006', 'Transmission oil TO-4 SAE 30, 210 L drum', 'DRM', 'LUB-OIL', 18, '27101980', 48200],
  ['WLD-6003', 'Hardfacing electrode 4.0 mm, 20 kg box', 'BOX', 'WLD-CON', 18, '83111000', 11800],
  ['WLD-6004', 'Argon-CO2 gas mixture cylinder, 47 L', 'CYL', 'WLD-CON', 18, '28042100', 3650],
  ['TLS-7003', 'Pneumatic grease gun, 600 cc', 'EA', 'TLS-HND', 18, '84672900', 6900],
  ['TLS-7004', 'Bearing puller set, 3-jaw hydraulic', 'SET', 'TLS-HND', 18, '82041120', 48500],
  ['TLS-7005', 'Digital multimeter, CAT III', 'EA', 'TLS-HND', 18, '90303100', 8200],
  ['PPE-8003', 'Safety helmet with chin strap', 'EA', 'PPE-GEN', 18, '65061010', 420],
  ['PPE-8004', 'Hi-visibility jacket, reflective', 'EA', 'PPE-GEN', 12, '62101090', 580],
  ['PPE-8005', 'Safety goggles, anti-fog', 'EA', 'PPE-GEN', 18, '90049090', 210],
  ['ELE-9002', 'Battery 12 V 180 Ah, heavy duty', 'EA', 'ELE-GEN', 18, '85071000', 14800],
  ['ELE-9003', 'Engine wiring harness – PC200', 'EA', 'ELE-GEN', 18, '85444999', 18600],
  ['ELE-9004', 'LED floodlight 120 W (work light)', 'EA', 'ELE-GEN', 18, '94054090', 3800],
  ['SRV-9503', 'Hydraulic cylinder overhaul service (per cylinder)', 'JOB', 'SRV-REP', 18, '998719', 68000, true],
  ['SRV-9504', 'Structural repair welding, boom and stick (per job)', 'JOB', 'SRV-REP', 18, '998719', 145000, true],
  ['LOG-9702', 'Crane hire with operator, per day', 'DAY', 'LOG-TRN', 18, '997319', 42000, true],
];

type Ven = [code: string, name: string, city: string, state: string, panSeed: string, entity: 'C' | 'F' | 'P', msme: string | null, cats: [string, string][], contact: string, email: string, phone: string];
const VENDORS: Ven[] = [
  ['100117', 'Anand Fasteners & Fittings Pvt Ltd', 'Pune', 'Maharashtra', 'ANDFF3317', 'C', 'Small', [['UCG', 'Track hardware'], ['HYD', 'Hose fittings']], 'Rohan Anand', 'rohan@anandfasteners.test', '+91 98220 77310'],
  ['100118', 'Eastern Engine Spares Co.', 'Kolkata', 'West Bengal', 'EESCO4412', 'F', null, [['ENG', 'Engine spares']], 'Subhajit Roy', 'subhajit@easternspares.test', '+91 98310 40021'],
  ['100119', 'Gujarat Industrial Gases Ltd', 'Vadodara', 'Gujarat', 'GIGLT8820', 'C', null, [['WLD', 'Industrial gases']], 'Nilesh Patel', 'nilesh@gigl.test', '+91 98250 61177'],
  ['100120', 'Vidarbha Safety Equipments', 'Nagpur', 'Maharashtra', 'VDBSE2291', 'F', 'Micro', [['PPE', 'Helmets and eyewear']], 'Rekha Bhoyar', 'rekha@vidarbhasafety.test', '+91 98900 33415'],
  ['100121', 'Chennai Power Electricals Pvt Ltd', 'Chennai', 'Tamil Nadu', 'CHPEL7755', 'C', 'Medium', [['ELE', 'Batteries and harnesses']], 'Karthik Raja', 'karthik@chennaipower.test', '+91 94440 82230'],
  ['100122', 'Raipur Heavy Equipment Services', 'Raipur', 'Chhattisgarh', 'RHESV5503', 'C', 'Small', [['SRV', 'Structural repair'], ['UCG', 'Cutting edges']], 'Dinesh Sahu', 'dinesh@raipurheavy.test', '+91 98260 14470'],
  ['100123', 'Odisha Mining Tools & Tackle', 'Bhubaneswar', 'Odisha', 'OMTTK3140', 'F', 'Small', [['TLS', 'Workshop tools'], ['UCG', 'Bucket hardware']], 'Prasant Mohanty', 'prasant@omtt.test', '+91 94370 55218'],
  ['100124', 'Telangana Hydraulic Hose Works', 'Hyderabad', 'Telangana', 'THHWK6628', 'C', 'Small', [['HYD', 'Hoses and seals']], 'Farida Begum', 'farida@thhw.test', '+91 99490 12874'],
  ['100125', 'Bengaluru Lubricant Traders', 'Bengaluru', 'Karnataka', 'BLTRD9034', 'F', 'Micro', [['LUB', 'Oils and coolants'], ['FLT', 'Filters']], 'Naveen Gowda', 'naveen@bltraders.test', '+91 98450 70022'],
  ['100126', 'Jamshedpur Heavy Haulage & Cranes', 'Jamshedpur', 'Jharkhand', 'JHHCR1186', 'C', null, [['LOG', 'Cranes and haulage']], 'Amarjit Kaur', 'amarjit@jhhc.test', '+91 94310 66905'],
];

/** Which vendors supply which spend category (existing base vendors plus the new ones; 100113 is blocked in SAP). */
const SUPPLIERS: Record<string, string[]> = {
  HYD: ['100101', '100116', '100106', '100124', '100117'],
  UCG: ['100102', '100115', '100103', '100109', '100117', '100122', '100123'],
  ENG: ['100106', '100103', '100118'],
  FLT: ['100105', '100125'],
  LUB: ['100104', '100125'],
  WLD: ['100107', '100119'],
  TLS: ['100108', '100123'],
  PPE: ['100108', '100110', '100120'],
  ELE: ['100111', '100121'],
  SRV: ['100106', '100109', '100122'],
  LOG: ['100112', '100126'],
};

const BUYER_BY_CAT: Record<string, string> = { HYD: 'amit.kulkarni', UCG: 'amit.kulkarni', ENG: 'amit.kulkarni', SRV: 'amit.kulkarni', CAP: 'amit.kulkarni' };
const buyerEmail = (cat: string) => `${BUYER_BY_CAT[cat] ?? 'sneha.patil'}@equipcare.test`;
const REQ = [
  { email: 'priya.nair@equipcare.test', dept: 'Maintenance Planning', plants: ['PUN1'] },
  { email: 'rahul.deshmukh@equipcare.test', dept: 'Field Service', plants: ['NGP1'] },
  { email: 'farhan.qureshi@equipcare.test', dept: 'Mine Site Services', plants: ['DHN1'] },
];
const PLANTS = ['PUN1', 'NGP1', 'DHN1'];
const TERMS = ['45 days from GRN', '30 days', '60 days from GRN', '45 days from GRN', '30 days from invoice'];

function panFor(seed: string, entity: string) {
  const letters = seed.slice(0, 5).split('');
  letters[3] = entity;
  return `${letters.join('')}${seed.slice(5, 9)}${'ABCDEFGHJK'[Number(seed.slice(8, 9))]}`;
}

const catOf = (code: string) => code.slice(0, 3);

export function seedBaseExtra() {
  const r = rng(20261020);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const between = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const round10 = (n: number) => Math.round(n / 10) * 10;

  // ---------------------------------------------------------------- masters
  for (const m of MATERIALS) {
    sapPut('MATERIAL', m[0], {
      code: m[0], description: m[1], uom: m[2], material_group: m[3], gst_rate: m[4], hsn: m[5], valuation_type: m[7] ? null : 'Standard', is_service: !!m[7],
      lpp: m[6], lpp_date: DAY(-45 - between(0, 120)), brand: null, budget_price: Math.round(m[6] * 1.05),
    }, 'Seed');
  }
  for (const v of VENDORS) {
    const pan = panFor(v[4], v[5]);
    const idx = Number(v[0]);
    sapPut('VENDOR', v[0], {
      sap_code: v[0], name: v[1], legal_name: v[1], pan, gstin: makeGstin(STATE_CODES[v[3]], pan, '1'), msme_no: v[6] ? `UDYAM-XX-${v[0].slice(-2)}-00${v[0].slice(-4)}` : null,
      msme_category: v[6], address: `${v[2]}, ${v[3]}`, city: v[2], state: v[3], bank_name: ['HDFC Bank', 'State Bank of India', 'ICICI Bank', 'Axis Bank'][idx % 4],
      bank_account_masked: `XXXXXX${v[0].slice(-3)}${(idx * 7) % 10}`, bank_ifsc: ['HDFC0001234', 'SBIN0004567', 'ICIC0007788', 'UTIB0002211'][idx % 4], blocked: false,
    }, 'Seed');
  }
  for (const m of MATERIALS) for (const p of PLANTS) sapPut('STOCK', `${m[0]}|${p}`, { material_code: m[0], plant: p, unrestricted: between(0, 14), open_po_qty: 0, vmi: false }, 'Seed');

  // Three more outline agreements (INT-M06)
  sapPut('OA', '5500000107', { type: 'ARC', title: 'Annual rate contract – hydraulic seals (Unique Hydraulic)', category: 'HYD', vendor_sap_code: '100116', valid_from: '2026-01-01', valid_to: '2026-12-31', value_cap: 3500000, consumed_value: 1180000, payment_terms: '45 days from GRN', delivery_terms: 'FOR destination', items: [
    { material_code: 'HYD-1006', unit_price: 9200, qty_cap: 120, consumed_qty: 48 }, { material_code: 'HYD-1007', unit_price: 11300, qty_cap: 100, consumed_qty: 31 }, { material_code: 'HYD-1010', unit_price: 1380, qty_cap: 600, consumed_qty: 192 },
  ] }, 'Seed');
  sapPut('OA', '5500000108', { type: 'ARC', title: 'Annual rate contract – engine wear parts (Eastern Engine Spares)', category: 'ENG', vendor_sap_code: '100118', valid_from: '2026-03-01', valid_to: '2027-02-28', value_cap: 5200000, consumed_value: 940000, payment_terms: '60 days from GRN', delivery_terms: 'FOR destination', items: [
    { material_code: 'ENG-3004', unit_price: 27200, qty_cap: 40, consumed_qty: 12 }, { material_code: 'ENG-3005', unit_price: 136500, qty_cap: 16, consumed_qty: 4 }, { material_code: 'ENG-3006', unit_price: 35400, qty_cap: 24, consumed_qty: 6 },
  ] }, 'Seed');
  sapPut('OA', '5500000109', { type: 'Fixed supplier', title: 'Fixed supplier – safety footwear and helmets (Vidarbha Safety)', category: 'PPE', vendor_sap_code: '100120', valid_from: '2026-02-01', valid_to: '2027-01-31', value_cap: 600000, consumed_value: 118000, payment_terms: '30 days', delivery_terms: 'FOR destination', items: [
    { material_code: 'PPE-8003', unit_price: 395, qty_cap: 800, consumed_qty: 220 }, { material_code: 'PPE-8004', unit_price: 550, qty_cap: 800, consumed_qty: 180 }, { material_code: 'PPE-8005', unit_price: 198, qty_cap: 1200, consumed_qty: 310 },
  ] }, 'Seed');
  const oaItems: Record<string, { vendor: string; oa: string; mats: Record<string, number>; from: number }> = {
    HYD: { vendor: '100116', oa: '5500000107', mats: { 'HYD-1006': 9200, 'HYD-1007': 11300, 'HYD-1010': 1380 }, from: -240 },
    ENG: { vendor: '100118', oa: '5500000108', mats: { 'ENG-3004': 27200, 'ENG-3005': 136500, 'ENG-3006': 35400 }, from: -200 },
    PPE: { vendor: '100120', oa: '5500000109', mats: { 'PPE-8003': 395, 'PPE-8004': 550, 'PPE-8005': 198 }, from: -260 },
  };

  const allMats = [
    ...MATERIALS,
    // base materials usable by the generator
    ['HYD-1001', 'Hydraulic main pump seal kit – PC2000-8', 'EA', 'HYD-SEAL', 18, '40169330', 18450], ['HYD-1003', 'Hydraulic hose assembly 1" 4SH × 2.5 m', 'EA', 'HYD-HOSE', 18, '40093100', 3950],
    ['UCG-2003', 'Bucket tooth point, heavy duty – PC2000', 'EA', 'UCG-GET', 18, '84314990', 7850], ['UCG-2002', 'Track roller, single flange – D155A', 'EA', 'UCG-TRK', 18, '84314990', 38500],
    ['ENG-3002', 'Final drive bearing 23140 CC/W33', 'EA', 'ENG-BRG', 18, '84822000', 46200], ['FLT-4001', 'Engine oil filter element – QSK60 (LF9070)', 'EA', 'FLT-ELM', 18, '84212300', 2180],
    ['FLT-4002', 'Hydraulic return filter – PC2000', 'EA', 'FLT-ELM', 18, '84212300', 6450], ['LUB-5001', 'Engine oil 15W-40 CI-4, 210 L drum', 'DRM', 'LUB-OIL', 18, '27101980', 52500],
    ['LUB-5003', 'Hydraulic oil ISO VG 68, 210 L drum', 'DRM', 'LUB-OIL', 18, '27101980', 39800], ['WLD-6001', 'Welding electrode E7018 3.15 mm, 20 kg box', 'BOX', 'WLD-CON', 18, '83111000', 4250],
    ['TLS-7002', 'Impact socket set 1" drive, 21 pcs', 'SET', 'TLS-HND', 18, '82042000', 34500], ['PPE-8001', 'Safety shoes S3, steel toe', 'PR', 'PPE-GEN', 18, '64029990', 1650],
    ['ELE-9001', 'Alternator 24 V 100 A – HD785', 'EA', 'ELE-GEN', 18, '85115000', 58000], ['SRV-9501', 'Track chain repair service (per chain set)', 'JOB', 'SRV-REP', 18, '998719', 125000, true],
  ] as Mat[];
  const matsByCat = (cat: string) => allMats.filter((m) => catOf(m[0]) === cat);
  const cats = Object.keys(SUPPLIERS);
  const qtyFor = (m: Mat) => (m[7] ? 1 : m[2] === 'DRM' ? between(2, 12) : m[2] === 'BOX' || m[2] === 'CYL' ? between(6, 40) : m[2] === 'EA' && m[6] < 3000 ? between(8, 60) : m[2] === 'PR' ? between(20, 120) : m[6] > 100000 ? between(1, 3) : between(2, 14));

  type Line = { m: Mat; qty: number; price: number };
  const mkLines = (cat: string, vendor: string, day: number): { lines: Line[]; oa: string | null } => {
    const pool = matsByCat(cat);
    const n = Math.min(pool.length, between(1, 3));
    const chosen: Mat[] = [];
    while (chosen.length < n) { const m = pick(pool); if (!chosen.includes(m)) chosen.push(m); }
    const oa = oaItems[cat];
    const useOa = !!oa && oa.vendor === vendor && day >= oa.from && chosen.some((m) => oa.mats[m[0]]) && r() < 0.8;
    const lines = chosen.map((m) => ({ m, qty: qtyFor(m), price: useOa && oa.mats[m[0]] ? oa.mats[m[0]] : round10(m[6] * (0.93 + r() * 0.13)) }));
    return { lines, oa: useOa ? oa.oa : null };
  };

  const prDoc = (prNo: string, req: (typeof REQ)[number], created: number, items: { m: Mat; qty: number; plant: string; reqDay: number; priority?: string }[]) =>
    sapPut('PR', prNo, {
      pr_no: prNo, requisitioner_email: req.email, department: req.dept, created_at: D(created),
      items: items.map((it, i) => ({
        item: (i + 1) * 10, material_code: it.m[0], description: it.m[1], qty: it.qty, uom: it.m[2], plant: it.plant, storage_location: it.plant === 'DHN1' ? 'MS01' : 'WS01',
        required_date: DAY(it.reqDay), priority: it.priority ?? 'Normal', est_unit_price: it.m[6], status: 'Released', is_service: !!it.m[7],
      })),
    }, 'Seed');

  // ---------------------------------------------------------------- historic POs with receipts (closed)
  let po = EXTRA.poHistoricFrom, pr = EXTRA.prHistoricFrom, grn = EXTRA.grnFrom;
  for (let i = 0; i < 64; i++) {
    const cat = pick(cats.filter((c) => c !== 'LOG' || r() < 0.3));
    const vendor = pick(SUPPLIERS[cat]);
    const day = -between(26, 340);
    const plant = pick(PLANTS);
    const { lines, oa } = mkLines(cat, vendor, day);
    const req = REQ.find((q) => q.plants.includes(plant)) ?? pick(REQ);
    const prNo = String(pr++);
    prDoc(prNo, req, day - between(7, 18), lines.map((l) => ({ m: l.m, qty: l.qty, plant, reqDay: day + 12 })));
    const poNo = String(po++);
    const urgency = cat === 'ENG' || cat === 'UCG' ? pick(['General stock', 'General stock', 'General stock', 'Urgent', 'BD', 'Class 1']) : 'General stock';
    sapPut('PO', poNo, {
      po_no: poNo, vendor_sap_code: vendor, buyer_email: buyerEmail(cat), plant, po_date: DAY(day), released: true, version: 1, delivery_terms: pick(['FOR destination', 'FOR destination', 'Ex-Works']),
      payment_terms: pick(TERMS), freight_terms: 'Freight paid', oa_no: oa, urgency, rfq_date: oa ? null : DAY(day - between(5, 12)),
      items: lines.map((l, k) => ({ item: (k + 1) * 10, pr_no: prNo, pr_item: (k + 1) * 10, material_code: l.m[0], description: l.m[1], qty: l.qty, uom: l.m[2], unit_price: l.price, gst_rate: l.m[4], delivery_date: DAY(day + between(10, 18)) })),
    }, 'Seed');
    const g = String(grn++);
    sapPut('GRN', `${g}-2026`, { grn_no: g, year: '2026', po_no: poNo, posting_date: DAY(day + between(8, 24)), plant, is_service: lines.some((l) => l.m[7]), items: lines.map((l, k) => ({ po_item: (k + 1) * 10, qty: l.qty, value: Math.round(l.qty * l.price) })) }, 'Seed');
  }

  // ---------------------------------------------------------------- open POs in varied states
  type OpenKind = 'fresh' | 'accepted' | 'partial' | 'overdue' | 'overdue_partial' | 'cancelled';
  const kinds: OpenKind[] = ['fresh', 'fresh', 'fresh', 'fresh', 'accepted', 'accepted', 'accepted', 'accepted', 'accepted', 'partial', 'partial', 'partial', 'partial', 'overdue', 'overdue', 'overdue', 'overdue', 'overdue_partial', 'overdue_partial', 'accepted', 'fresh', 'cancelled'];
  po = EXTRA.poOpenFrom; pr = EXTRA.prHistoricFrom + 400;
  for (const kind of kinds) {
    const cat = pick(cats.filter((c) => c !== 'LOG'));
    const vendor = pick(SUPPLIERS[cat]);
    const day = kind === 'fresh' ? -between(0, 2) : kind.startsWith('overdue') ? -between(24, 44) : -between(4, 20);
    const plant = pick(PLANTS);
    const { lines, oa } = mkLines(cat, vendor, day);
    const req = REQ.find((q) => q.plants.includes(plant)) ?? pick(REQ);
    const prNo = String(pr++);
    prDoc(prNo, req, day - between(6, 14), lines.map((l) => ({ m: l.m, qty: l.qty, plant, reqDay: day + 12 })));
    const poNo = String(po++);
    const delivery = kind.startsWith('overdue') ? day + between(8, 16) : day + between(8, 20);
    const urgency = pick(['General stock', 'General stock', 'General stock', 'Urgent', 'BD', 'Class 1']);
    sapPut('PO', poNo, {
      po_no: poNo, vendor_sap_code: vendor, buyer_email: buyerEmail(cat), plant, po_date: DAY(day), released: true, version: 1, cancelled: kind === 'cancelled', delivery_terms: pick(['FOR destination', 'FOR destination', 'Ex-Works']),
      payment_terms: pick(TERMS), freight_terms: 'Freight paid', oa_no: oa, urgency, rfq_date: oa ? null : DAY(day - between(5, 12)),
      items: lines.map((l, k) => ({ item: (k + 1) * 10, pr_no: prNo, pr_item: (k + 1) * 10, material_code: l.m[0], description: l.m[1], qty: l.qty, uom: l.m[2], unit_price: l.price, gst_rate: l.m[4], delivery_date: DAY(delivery) })),
    }, 'Seed');
    if (kind === 'partial' || kind === 'overdue_partial') {
      const g = String(grn++);
      sapPut('GRN', `${g}-2026`, { grn_no: g, year: '2026', po_no: poNo, posting_date: DAY(Math.min(-1, day + between(6, 12))), plant, is_service: false, items: lines.map((l, k) => ({ po_item: (k + 1) * 10, qty: Math.max(1, Math.floor(l.qty / 2)), value: Math.round(Math.max(1, Math.floor(l.qty / 2)) * l.price) })) }, 'Seed');
    }
  }

  // ---------------------------------------------------------------- open requisitions (waiting in the workbench)
  pr = EXTRA.prOpenFrom;
  const openMats = [...allMats, ...MATERIALS.filter((m) => !m[7])];
  for (let i = 0; i < 30; i++) {
    const plant = pick(PLANTS);
    const req = REQ.find((q) => q.plants.includes(plant)) ?? pick(REQ);
    const created = -between(0, 21);
    const n = r() < 0.4 ? 2 : 1;
    const items: { m: Mat; qty: number; plant: string; reqDay: number; priority?: string }[] = [];
    const prio = r() < 0.12 ? pick(['BD', 'Urgent', 'Class 1']) : 'Normal';
    while (items.length < n) {
      const m = pick(openMats);
      if (catOf(m[0]) === 'CAP' || items.some((x) => x.m === m)) continue;
      items.push({ m, qty: qtyFor(m), plant, reqDay: created + (prio === 'Normal' ? between(8, 35) : between(2, 6)), priority: prio });
    }
    prDoc(String(pr++), req, created, items);
  }

  // ---------------------------------------------------------------- vendor attributes and documents (platform-owned)
  runAllInbound('scheduled');
  for (const v of VENDORS) {
    const row = get<{ id: number }>('SELECT id FROM vendors WHERE sap_code = ?', v[0]);
    if (!row) continue;
    run('UPDATE vendors SET contact_name = ?, contact_email = ?, contact_phone = ?, portal_status = ?, performance_score = ?, created_at = ? WHERE id = ?', v[8], v[9], v[10], 'Not invited', 58 + (Number(v[0]) % 11) * 4, D(-300), row.id);
    for (const [cat, sub] of v[7]) {
      insert('vendor_capabilities', { vendor_id: row.id, category: cat, sub_category: sub, supplier_role: v[5] === 'C' ? 'Manufacturer' : 'Trader', brand: 'Assorted', region: 'All India', criticality: ['HYD', 'UCG', 'ENG'].includes(cat) ? 'High' : 'Medium', buyer_owner_id: get<{ id: number }>("SELECT id FROM users WHERE email = ?", buyerEmail(cat))?.id ?? 1, status: 'Approved', created_at: D(-180), decided_at: D(-179) });
    }
    for (const [label, expiry] of [['GST certificate', null], ['PAN card', null], ['Cancelled cheque', null], ['ISO 9001 certificate', v[0] === '100118' ? DAY(-8) : v[0] === '100124' ? DAY(21) : DAY(300)]] as [string, string | null][]) {
      insert('vendor_documents', { vendor_id: row.id, doc_type: label, expiry_date: expiry, status: expiry && expiry < DAY(0) ? 'Expired' : 'Valid', mandatory: label === 'ISO 9001 certificate' ? 0 : 1, created_at: D(-250) });
    }
    if (v[6]) insert('vendor_documents', { vendor_id: row.id, doc_type: 'MSME / Udyam certificate', expiry_date: DAY(400), status: 'Valid', mandatory: 1, created_at: D(-250) });
  }
  // Give the new vendors the same arrival times as their SAP records and keep historic noise out of the inbox.
  run("UPDATE pr_lines SET available_at = sap_created_at, assigned_at = CASE WHEN buyer_id IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', sap_created_at, '+2 hours') END WHERE available_at > sap_created_at");
  run("UPDATE pr_lines SET sla_due = strftime('%Y-%m-%dT%H:%M:%fZ', available_at, '+' || CASE priority WHEN 'BD' THEN 24 WHEN 'Class 1' THEN 24 ELSE 72 END || ' hours') WHERE priority != 'Normal' AND sla_due IS NULL");
  run("UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND event = 'NTF-01' AND object_id IN (SELECT id FROM pr_lines WHERE status = 'PO created')", now());
  run("UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND event IN ('NTF-16', 'NTF-20') AND object_id IN (SELECT id FROM pos WHERE status = 'Closed')", now());
}
