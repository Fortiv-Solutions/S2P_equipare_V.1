/**
 * Base demo data: masters, users, approval-matrix placeholder, and SAP-simulator documents
 * (vendors, materials, stock, OAs, PRs, POs, GRNs) which are then synchronised into the platform
 * through the normal inbound flows. All organisations, people and documents are fictional.
 */
import { get, insert, run, J, now } from '../core/db.ts';
import { hashPassword } from '../core/auth.ts';
import { seedConfig } from '../core/config.ts';
import { sapPut, runAllInbound } from '../core/sap.ts';
import { makeGstin, STATE_CODES } from '../core/india.ts';
import { audit } from '../core/audit.ts';
import { DAY, D } from './ctx.ts';

export const DEMO_PASSWORD = 'Equipcare@2026';

const PLANTS = [
  { code: 'PUN1', name: 'Chakan Central Workshop', city: 'Pune', state: 'Maharashtra', addr: 'Plot B-14, MIDC Chakan Phase II, Pune 410501' },
  { code: 'NGP1', name: 'Nagpur Reman Centre', city: 'Nagpur', state: 'Maharashtra', addr: 'Survey 221, Hingna MIDC, Nagpur 440016' },
  { code: 'DHN1', name: 'Dhanbad Mine Service Hub', city: 'Dhanbad', state: 'Jharkhand', addr: 'Govindpur Industrial Area, Dhanbad 828109' },
];

const CATEGORIES: [string, string, number, number, string][] = [
  ['HYD', 'Hydraulics & seals', 3, 1, 'Seal kits, hoses, pumps, motors, cylinders'],
  ['UCG', 'Undercarriage & ground engaging tools', 3, 1, 'Track chains, rollers, idlers, sprockets, bucket teeth'],
  ['ENG', 'Engine & powertrain', 3, 1, 'Turbochargers, injectors, bearings, final drives'],
  ['FLT', 'Filters', 2, 1, 'Oil, fuel, hydraulic and air filters'],
  ['LUB', 'Lubricants & oils', 2, 1, 'Engine oil, hydraulic oil, grease'],
  ['WLD', 'Welding & consumables', 3, 1, 'Electrodes, hardfacing wire, gases'],
  ['TLS', 'Tools & workshop equipment', 3, 1, 'Hand tools, torque tools, workshop equipment'],
  ['PPE', 'Safety & PPE', 3, 1, 'Safety shoes, gloves, helmets'],
  ['ELE', 'Auto electricals', 2, 1, 'Alternators, starters, wiring'],
  ['SRV', 'Repair & machining services', 2, 1, 'Track chain repair, line boring, machining'],
  ['CAP', 'Capex equipment', 3, 0, 'Mobile workshops, machines and small assets'],
  ['LOG', 'Logistics services', 2, 0, 'Low-bed trailers, transport'],
];

const GROUPS: [string, string][] = [
  ['HYD-SEAL', 'HYD'], ['HYD-HOSE', 'HYD'], ['HYD-REMAN', 'HYD'], ['UCG-TRK', 'UCG'], ['UCG-GET', 'UCG'], ['ENG-TURBO', 'ENG'], ['ENG-BRG', 'ENG'],
  ['ENG-FUEL', 'ENG'], ['FLT-ELM', 'FLT'], ['LUB-OIL', 'LUB'], ['LUB-GRS', 'LUB'], ['WLD-CON', 'WLD'], ['TLS-HND', 'TLS'], ['PPE-GEN', 'PPE'],
  ['ELE-GEN', 'ELE'], ['SRV-REP', 'SRV'], ['CAP-EQP', 'CAP'], ['LOG-TRN', 'LOG'],
];

type Mat = [code: string, desc: string, uom: string, group: string, gst: number, hsn: string, lpp: number, brand?: string, service?: boolean];
const MATERIALS: Mat[] = [
  ['HYD-1001', 'Hydraulic main pump seal kit – PC2000-8', 'EA', 'HYD-SEAL', 18, '40169330', 18450, 'Komatsu-equivalent'],
  ['HYD-1002', 'Boom cylinder seal kit – EX1200-6', 'EA', 'HYD-SEAL', 18, '40169330', 24800, 'Hitachi-equivalent'],
  ['HYD-1003', 'Hydraulic hose assembly 1" 4SH × 2.5 m', 'EA', 'HYD-HOSE', 18, '40093100', 3950, 'Parker / equivalent'],
  ['HYD-1004', 'Swing motor reman – PC1250-8 (exchange)', 'EA', 'HYD-REMAN', 18, '84122990', 485000],
  ['HYD-1005', 'O-ring kit, assorted metric (386 pcs)', 'SET', 'HYD-SEAL', 18, '40169330', 2650],
  ['UCG-2001', 'Track chain link assembly, 45 links – D375A', 'EA', 'UCG-TRK', 18, '84314990', 685000, 'Berco / equivalent'],
  ['UCG-2002', 'Track roller, single flange – D155A', 'EA', 'UCG-TRK', 18, '84314990', 38500],
  ['UCG-2003', 'Bucket tooth point, heavy duty – PC2000', 'EA', 'UCG-GET', 18, '84314990', 7850, 'ESCO / equivalent'],
  ['UCG-2004', 'Sprocket segment set – D375A', 'SET', 'UCG-TRK', 18, '84314990', 142000],
  ['UCG-2005', 'Front idler assembly – EX1200', 'EA', 'UCG-TRK', 18, '84314990', 295000],
  ['ENG-3001', 'Turbocharger reman – SAA12V140', 'EA', 'ENG-TURBO', 18, '84148090', 325000],
  ['ENG-3002', 'Final drive bearing 23140 CC/W33', 'EA', 'ENG-BRG', 18, '84822000', 46200, 'SKF / FAG'],
  ['ENG-3003', 'Fuel injector – QSK60', 'EA', 'ENG-FUEL', 18, '84099112', 62500, 'Cummins'],
  ['FLT-4001', 'Engine oil filter element – QSK60 (LF9070)', 'EA', 'FLT-ELM', 18, '84212300', 2180, 'Fleetguard'],
  ['FLT-4002', 'Hydraulic return filter – PC2000', 'EA', 'FLT-ELM', 18, '84212300', 6450],
  ['FLT-4003', 'Air filter primary – D375A', 'EA', 'FLT-ELM', 18, '84213100', 9800],
  ['LUB-5001', 'Engine oil 15W-40 CI-4, 210 L drum', 'DRM', 'LUB-OIL', 18, '27101980', 52500],
  ['LUB-5002', 'Grease EP2 lithium, 180 kg drum', 'DRM', 'LUB-GRS', 18, '34031900', 41000],
  ['LUB-5003', 'Hydraulic oil ISO VG 68, 210 L drum', 'DRM', 'LUB-OIL', 18, '27101980', 39800],
  ['WLD-6001', 'Welding electrode E7018 3.15 mm, 20 kg box', 'BOX', 'WLD-CON', 18, '83111000', 4250],
  ['WLD-6002', 'Hardfacing wire 1.6 mm, 15 kg spool', 'SPL', 'WLD-CON', 18, '83112000', 8900],
  ['TLS-7001', 'Hydraulic torque wrench, 3/4" drive', 'EA', 'TLS-HND', 18, '82041120', 185000],
  ['TLS-7002', 'Impact socket set 1" drive, 21 pcs', 'SET', 'TLS-HND', 18, '82042000', 34500],
  ['PPE-8001', 'Safety shoes S3, steel toe', 'PR', 'PPE-GEN', 18, '64029990', 1650],
  ['PPE-8002', 'Nitrile-coated work gloves', 'PR', 'PPE-GEN', 12, '40151900', 95],
  ['ELE-9001', 'Alternator 24 V 100 A – HD785', 'EA', 'ELE-GEN', 18, '85115000', 58000],
  ['SRV-9501', 'Track chain repair service (per chain set)', 'JOB', 'SRV-REP', 18, '998719', 125000, undefined, true],
  ['SRV-9502', 'Line boring & machining of boom pivot', 'JOB', 'SRV-REP', 18, '998719', 85000, undefined, true],
  ['CAP-9901', 'Mobile workshop container 20 ft, fitted (Workshop on Wheels)', 'EA', 'CAP-EQP', 18, '87059000', 3850000],
  ['LOG-9701', 'Low-bed trailer transport, per trip', 'TRIP', 'LOG-TRN', 12, '996511', 68000, undefined, true],
];

type Ven = [code: string, name: string, city: string, state: string, panSeed: string, entity: 'C' | 'F' | 'P', msme: string | null, cats: string[], contact: string, email: string, phone: string, blocked?: boolean];
const VENDORS: Ven[] = [
  ['100101', 'Hydrotech Seals & Systems Pvt Ltd', 'Pune', 'Maharashtra', 'HYDRS4821', 'C', 'Small', ['HYD'], 'Manoj Kale', 'manoj.kale@hydrotech.test', '+91 98220 41100'],
  ['100102', 'Shakti Undercarriage Components Pvt Ltd', 'Chennai', 'Tamil Nadu', 'SHKUC6604', 'C', 'Medium', ['UCG'], 'Divya Raman', 'divya.raman@shakti-ucg.test', '+91 94440 22871'],
  ['100103', 'Bharat Bearings & Transmission Co.', 'Kolkata', 'West Bengal', 'BHRBT1190', 'F', null, ['ENG', 'UCG'], 'Arindam Bose', 'sales@bharatbearings.test', '+91 98300 11523'],
  ['100104', 'Western Lubricants Distributors', 'Nagpur', 'Maharashtra', 'WSTLD7735', 'F', 'Micro', ['LUB'], 'Sanjay Agrawal', 'sanjay@westernlube.test', '+91 98230 66710'],
  ['100105', 'Precision Filtration India Pvt Ltd', 'Faridabad', 'Haryana', 'PRCFI3302', 'C', 'Small', ['FLT'], 'Pooja Malhotra', 'pooja.malhotra@precisionfilt.test', '+91 98110 30044'],
  ['100106', 'Deccan Hydraulics & Reman Works', 'Hyderabad', 'Telangana', 'DCNHR5518', 'F', 'Small', ['HYD', 'ENG', 'SRV'], 'Imran Sheikh', 'imran@deccanreman.test', '+91 99490 77120'],
  ['100107', 'Apex Welding Consumables', 'Ahmedabad', 'Gujarat', 'APXWC2207', 'F', 'Micro', ['WLD'], 'Hetal Shah', 'orders@apexweld.test', '+91 98250 18846'],
  ['100108', 'Kranti Industrial Tools', 'Mumbai', 'Maharashtra', 'KRNIT8841', 'C', 'Small', ['TLS', 'PPE'], 'Nitin Sawant', 'nitin@krantitools.test', '+91 98200 55190'],
  ['100109', 'Jharkhand Mining Services & Repairs', 'Dhanbad', 'Jharkhand', 'JHMSR4410', 'C', 'Small', ['SRV', 'UCG'], 'Ajay Mahato', 'ajay@jmsr.test', '+91 94311 20987'],
  ['100110', 'SafeStep PPE Supplies', 'Bengaluru', 'Karnataka', 'SFSPP6672', 'F', 'Micro', ['PPE'], 'Kavya Hegde', 'kavya@safestep.test', '+91 98450 31277'],
  ['100111', 'Volt Auto Electricals', 'Nagpur', 'Maharashtra', 'VLTAE9031', 'F', 'Micro', ['ELE'], 'Prakash Wankhede', 'prakash@voltauto.test', '+91 98901 44352'],
  ['100112', 'TransIndia Heavy Haulage', 'Pune', 'Maharashtra', 'TRNHH1288', 'C', null, ['LOG'], 'Gurpreet Singh', 'ops@transindia.test', '+91 98221 70640'],
  ['100113', 'Sudarshan Engineering Traders', 'Pune', 'Maharashtra', 'SDRET5560', 'F', 'Micro', ['HYD', 'UCG'], 'Mahesh Jadhav', 'mahesh@sudarshan.test', '+91 98228 10974', true],
  ['100114', 'Metro Mobile Workshop Fabricators', 'Pune', 'Maharashtra', 'MTRMW7124', 'C', 'Small', ['CAP'], 'Rohit Bhosale', 'rohit@metromobile.test', '+91 98903 66218'],
  ['100115', 'Coromandel Track Systems Pvt Ltd', 'Coimbatore', 'Tamil Nadu', 'CRMTS3385', 'C', 'Medium', ['UCG'], 'Senthil Kumar', 'senthil@coromandeltrack.test', '+91 94430 51872'],
  ['100116', 'Unique Hydraulic Solutions', 'Nashik', 'Maharashtra', 'UNQHS2093', 'F', 'Small', ['HYD'], 'Swati Kulkarni', 'swati@uniquehydraulic.test', '+91 98221 93420'],
];

function panFor(seed: string, entity: string) {
  // seed is 5 letters + 4 digits; insert the entity type as the 4th character and end with a letter.
  const letters = seed.slice(0, 5).split('');
  letters[3] = entity;
  return `${letters.join('')}${seed.slice(5, 9)}${'ABCDEFGHJK'[Number(seed.slice(8, 9))]}`;
}

type UserSeed = [local: string, name: string, roles: string, title: string, dept: string | null, plants: string, cats: string | null, phone: string, vendor?: string, domain?: string];
const USERS: UserSeed[] = [
  ['anjali.verma', 'Anjali Verma', 'ADM', 'Platform Administrator', 'IT', '*', null, '+91 98500 10001'],
  ['priya.nair', 'Priya Nair', 'REQ', 'Maintenance Planner', 'Maintenance Planning', 'PUN1', null, '+91 98500 10002'],
  ['rahul.deshmukh', 'Rahul Deshmukh', 'REQ', 'Workshop on Wheels Supervisor', 'Field Service', 'NGP1', null, '+91 98500 10003'],
  ['farhan.qureshi', 'Farhan Qureshi', 'REQ', 'Mine Site Service Engineer', 'Mine Site Services', 'DHN1', null, '+91 98500 10004'],
  ['amit.kulkarni', 'Amit Kulkarni', 'BUY', 'Senior Buyer – Hydraulics & Undercarriage', 'Procurement', '*', 'HYD,UCG,ENG,SRV,CAP', '+91 98500 10005'],
  ['sneha.patil', 'Sneha Patil', 'BUY', 'Buyer – Consumables & MRO', 'Procurement', '*', 'FLT,LUB,WLD,TLS,PPE,ELE,LOG', '+91 98500 10006'],
  ['vikram.joshi', 'Vikram Joshi', 'APR,BUY', 'Procurement Manager', 'Procurement', '*', 'HYD,UCG,ENG,FLT,LUB,WLD,TLS,PPE,ELE,SRV,CAP,LOG', '+91 98500 10007'],
  ['meera.iyer', 'Meera Iyer', 'FIN', 'Accounts Payable Lead', 'Finance', '*', null, '+91 98500 10008'],
  ['kiran.shah', 'Kiran Shah', 'FIN', 'Finance Controller', 'Finance', '*', null, '+91 98500 10009'],
  ['suresh.pawar', 'Suresh Pawar', 'STO', 'Stores In-charge, Chakan & Nagpur', 'Stores', 'PUN1,NGP1', null, '+91 98500 10010'],
  ['lakshmi.reddy', 'Lakshmi Reddy', 'STO', 'Stores In-charge, Dhanbad', 'Stores', 'DHN1', null, '+91 98500 10011'],
  ['neha.gupta', 'Neha Gupta', 'SAP', 'SAP MM Consultant', 'IT', '*', null, '+91 98500 10012'],
  ['rajesh.menon', 'Rajesh Menon', 'MGT', 'Director – Operations', 'Management', '*', null, '+91 98500 10013'],
  ['manoj.kale', 'Manoj Kale', 'VEN', 'Sales & Accounts', null, '*', null, '+91 98220 41100', '100101', 'hydrotech.test'],
  ['divya.raman', 'Divya Raman', 'VEN', 'Key Account Manager', null, '*', null, '+91 94440 22871', '100102', 'shakti-ucg.test'],
  ['sanjay', 'Sanjay Agrawal', 'VEN', 'Proprietor', null, '*', null, '+91 98230 66710', '100104', 'westernlube.test'],
  ['pooja.malhotra', 'Pooja Malhotra', 'VEN', 'Customer Service Manager', null, '*', null, '+91 98110 30044', '100105', 'precisionfilt.test'],
  ['imran', 'Imran Sheikh', 'VEN', 'Partner', null, '*', null, '+91 99490 77120', '100106', 'deccanreman.test'],
  ['nitin', 'Nitin Sawant', 'VEN', 'Sales Manager', null, '*', null, '+91 98200 55190', '100108', 'krantitools.test'],
];

export function seedBase() {
  const t = now();
  seedConfig(null);

  for (const p of PLANTS) {
    const pan = 'AANFK4821R';
    insert('plants', { code: p.code, name: p.name, city: p.city, state: p.state, gstin: makeGstin(STATE_CODES[p.state], pan, '1'), ship_to_address: p.addr });
  }
  for (const [code, name, min, itc, description] of CATEGORIES) insert('spend_categories', { code, name, min_vendors: min, itc_recoverable: itc, description, rfq_rule: min > 2 ? 'Minimum vendor count applies' : 'Minimum two vendors' });
  for (const [g, c] of GROUPS) insert('material_group_map', { material_group: g, category: c });

  // --- SAP simulator: vendor master
  for (const v of VENDORS) {
    const pan = panFor(v[4], v[5]);
    const gstin = makeGstin(STATE_CODES[v[3]], pan, '1');
    sapPut('VENDOR', v[0], {
      sap_code: v[0], name: v[1], legal_name: v[1], pan, gstin, msme_no: v[6] ? `UDYAM-${STATE_CODES[v[3]] === '27' ? 'MH' : 'XX'}-${v[0].slice(-2)}-00${v[0].slice(-4)}` : null,
      msme_category: v[6], address: `${v[2]}, ${v[3]}`, city: v[2], state: v[3], bank_name: ['HDFC Bank', 'State Bank of India', 'ICICI Bank', 'Axis Bank'][Number(v[0]) % 4],
      bank_account_masked: `XXXXXX${v[0].slice(-3)}${(Number(v[0]) * 7) % 10}`, bank_ifsc: ['HDFC0001234', 'SBIN0004567', 'ICIC0007788', 'UTIB0002211'][Number(v[0]) % 4],
      blocked: !!v[11],
    }, 'Seed');
  }
  // --- SAP simulator: material master
  for (const m of MATERIALS) {
    sapPut('MATERIAL', m[0], {
      code: m[0], description: m[1], uom: m[2], material_group: m[3], gst_rate: m[4], hsn: m[5], valuation_type: m[8] ? null : 'Standard',
      is_service: !!m[8], lpp: m[6], lpp_date: DAY(-60 - (m[0].charCodeAt(5) % 90)), brand: m[7] ?? null,
      budget_price: Math.round(m[6] * 1.05),
    }, 'Seed');
  }
  runAllInbound('full');

  // Platform-owned vendor attributes
  for (const v of VENDORS) {
    run('UPDATE vendors SET contact_name = ?, contact_email = ?, contact_phone = ?, portal_status = ?, performance_score = ?, created_at = ? WHERE sap_code = ?',
      v[8], v[9], v[10], USERS.some((u) => u[8] === v[0]) ? 'Active' : 'Not invited', 60 + (Number(v[0]) % 9) * 4, D(-400), v[0]);
  }
  // Onboarding vendor without SAP code (WF-06)
  const orionPan = panFor('ORNST6120', 'F');
  const orionId = insert('vendors', {
    name: 'Orion Seal Technologies LLP', legal_name: 'Orion Seal Technologies LLP', pan: orionPan, gstin: makeGstin('27', orionPan, '1'),
    msme_no: 'UDYAM-MH-26-0071234', msme_category: 'Micro', city: 'Pune', state: 'Maharashtra', address: 'Bhosari MIDC, Pune 411026',
    contact_name: 'Ravi Teja', contact_email: 'ravi.teja@orionseal.test', contact_phone: '+91 98222 61540',
    bank_name: 'Kotak Mahindra Bank', bank_account_masked: 'XXXXXXXX4417', bank_ifsc: 'KKBK0001765',
    onboarding_status: 'Under review', portal_status: 'Registration submitted', created_at: D(-6),
  });

  // --- users
  const pw = hashPassword(DEMO_PASSWORD);
  for (const u of USERS) {
    const vendorId = u[8] ? getVendorId(u[8]) : null;
    insert('users', {
      name: u[1], email: `${u[0]}@${u[9] ?? 'equipcare.test'}`, phone: u[7], roles: u[2], title: u[3], department: u[4], plant_scope: u[5],
      categories: u[6], vendor_id: vendorId, vendor_role: u[8] ? 'Vendor administrator' : null, password_hash: pw, created_at: D(-300),
    });
  }
  insert('users', {
    name: 'Ravi Teja', email: 'ravi.teja@orionseal.test', phone: '+91 98222 61540', roles: 'VEN', title: 'Director', vendor_id: orionId,
    vendor_role: 'Vendor administrator', password_hash: pw, created_at: D(-6),
  });
  const id = getUserId;
  run('UPDATE users SET manager_id = ? WHERE email IN (?, ?)', id('vikram.joshi'), 'amit.kulkarni@equipcare.test', 'sneha.patil@equipcare.test');
  run('UPDATE users SET manager_id = ? WHERE email = ?', id('rajesh.menon'), 'vikram.joshi@equipcare.test');
  run('UPDATE users SET manager_id = ? WHERE email = ?', id('kiran.shah'), 'meera.iyer@equipcare.test');

  // --- buyer assignment matrix (BRD Sec 10)
  const amit = id('amit.kulkarni');
  const sneha = id('sneha.patil');
  const vikram = id('vikram.joshi');
  for (const c of ['HYD', 'UCG', 'ENG', 'SRV', 'CAP']) insert('buyer_matrix', { category: c, plant: '*', priority_route: '*', buyer_id: amit, backup_buyer_id: vikram });
  for (const c of ['FLT', 'LUB', 'WLD', 'TLS', 'PPE', 'ELE']) insert('buyer_matrix', { category: c, plant: '*', priority_route: '*', buyer_id: sneha, backup_buyer_id: vikram });
  // LOG deliberately unmapped: lines land in the manager's unassigned queue (FR-PRW-03 exception path).

  // --- vendor capability mapping (approved rows)
  const caps: [string, string, string, string, string, string][] = [
    ['100101', 'HYD', 'Seal kits', 'Manufacturer', 'Hydrotech', 'West'], ['100101', 'HYD', 'Hoses & fittings', 'Manufacturer', 'Hydrotech', 'West'],
    ['100116', 'HYD', 'Seal kits', 'Trader', 'NOK / Hallite', 'West'], ['100116', 'HYD', 'Hoses & fittings', 'Dealer', 'Parker', 'West'],
    ['100106', 'HYD', 'Reman pumps & motors', 'Reman service', 'Deccan', 'All India'], ['100106', 'HYD', 'Seal kits', 'Trader', 'Assorted', 'South'],
    ['100106', 'ENG', 'Turbo & fuel system reman', 'Reman service', 'Deccan', 'All India'], ['100106', 'SRV', 'Machining', 'Service provider', '—', 'South'],
    ['100113', 'HYD', 'Seal kits', 'Trader', 'Assorted', 'West'], ['100113', 'UCG', 'Bucket teeth', 'Trader', 'Assorted', 'West'],
    ['100102', 'UCG', 'Ground engaging tools', 'Manufacturer', 'Shakti', 'All India'], ['100102', 'UCG', 'Track components', 'Manufacturer', 'Shakti', 'All India'],
    ['100115', 'UCG', 'Track components', 'Manufacturer', 'Coromandel', 'All India'], ['100115', 'UCG', 'Ground engaging tools', 'Dealer', 'ESCO', 'South'],
    ['100103', 'ENG', 'Bearings', 'Authorised distributor', 'SKF / FAG', 'East'], ['100103', 'UCG', 'Track components', 'Trader', 'Assorted', 'East'],
    ['100109', 'SRV', 'Track chain repair', 'Service provider', '—', 'East'], ['100109', 'UCG', 'Track components', 'Trader', 'Assorted', 'East'],
    ['100104', 'LUB', 'Engine & hydraulic oils', 'Authorised distributor', 'Castrol / Servo', 'Central'], ['100104', 'LUB', 'Greases', 'Authorised distributor', 'Servo', 'Central'],
    ['100105', 'FLT', 'Filters', 'Manufacturer', 'Precision', 'All India'],
    ['100107', 'WLD', 'Electrodes & wires', 'Manufacturer', 'Apex', 'West'],
    ['100108', 'TLS', 'Torque & hand tools', 'Authorised distributor', 'Stanley / Hytorc', 'West'], ['100108', 'PPE', 'Safety footwear', 'Dealer', 'Karam', 'West'],
    ['100110', 'PPE', 'Gloves & footwear', 'Trader', 'Assorted', 'South'],
    ['100111', 'ELE', 'Alternators & starters', 'Service provider', 'Bosch / Prestolite', 'Central'],
    ['100112', 'LOG', 'Heavy haulage', 'Service provider', '—', 'All India'],
    ['100114', 'CAP', 'Mobile workshop fabrication', 'Manufacturer', 'Metro', 'West'],
  ];
  for (const [code, cat, sub, role, brand, region] of caps) {
    insert('vendor_capabilities', { vendor_id: getVendorId(code), category: cat, sub_category: sub, supplier_role: role, brand, region, criticality: ['HYD', 'UCG', 'ENG'].includes(cat) ? 'High' : 'Medium', buyer_owner_id: ['HYD', 'UCG', 'ENG', 'SRV', 'CAP'].includes(cat) ? amit : sneha, status: 'Approved', created_at: D(-200), decided_by: vikram, decided_at: D(-199) });
  }
  insert('vendor_capabilities', { vendor_id: orionId, category: 'HYD', sub_category: 'Seal kits', supplier_role: 'Manufacturer', brand: 'Orion', region: 'West', criticality: 'High', status: 'Proposed', created_at: D(-6) });

  // --- KYC documents (expiry dates drive FR-VPT-12)
  const docs: [string, string, number, string][] = [['GST certificate', 'GST', 0, 'Valid'], ['PAN card', 'PAN', 0, 'Valid'], ['Cancelled cheque', 'BANK', 0, 'Valid'], ['ISO 9001 certificate', 'ISO', 400, 'Valid']];
  for (const v of VENDORS) {
    const vid = getVendorId(v[0]);
    for (const [label, type, exp, status] of docs) {
      let expiry: string | null = exp ? DAY(exp - (Number(v[0]) % 5) * 90) : null;
      if (v[0] === '100101' && type === 'ISO') expiry = DAY(24); // expiring within lead time
      if (v[0] === '100113' && type === 'ISO') expiry = DAY(-12); // expired
      insert('vendor_documents', { vendor_id: vid, doc_type: label, doc_no: type === 'GST' ? 'GSTIN on certificate' : null, expiry_date: expiry, status: expiry && expiry < DAY(0) ? 'Expired' : status, mandatory: type === 'ISO' ? 0 : 1, created_at: D(-300) });
    }
    if (v[6]) insert('vendor_documents', { vendor_id: vid, doc_type: 'MSME / Udyam certificate', expiry_date: v[0] === '100104' ? DAY(18) : DAY(500), status: 'Valid', mandatory: 1, created_at: D(-300) });
  }
  for (const label of ['GST certificate', 'PAN card', 'Cancelled cheque', 'MSME / Udyam certificate']) {
    insert('vendor_documents', { vendor_id: orionId, doc_type: label, status: 'Pending review', mandatory: 1, created_at: D(-5) });
  }

  // --- approval matrix placeholder (DEC-13 pending). Values are illustrative and editable.
  const M = (type: string, name: string, levels: { level: number; roles: string[]; label?: string }[], conditions: Record<string, unknown> = {}) =>
    insert('approval_matrix', { version: 1, type, name, conditions_json: J(conditions), levels_json: J(levels), effective_from: D(-365), active: 1, created_at: D(-365), note: 'Placeholder pending DEC-13 — replace with Equipcare\'s approved matrix.' });
  M('cmp.award', 'Award up to ₹5 lakh', [{ level: 1, roles: ['APR'], label: 'Procurement Manager' }], { max_value: 500000 });
  M('cmp.award', 'Award ₹5–25 lakh', [{ level: 1, roles: ['APR'], label: 'Procurement Manager' }, { level: 2, roles: ['FIN'], label: 'Finance' }], { min_value: 500000.01, max_value: 2500000 });
  M('cmp.award', 'Award above ₹25 lakh', [{ level: 1, roles: ['APR'] }, { level: 2, roles: ['FIN'] }, { level: 3, roles: ['MGT'], label: 'Management' }], { min_value: 2500000.01 });
  for (const t of ['exc.deviation', 'exc.single_source', 'exc.urgent', 'exc.off_contract', 'exc.new_vendor', 'exc.stale_routing', 'rfq.reopen', 'cmp.discount', 'po.amendment', 'po.cancellation', 'contract.renewal', 'dispute.closure']) {
    M(t, 'Procurement Manager', [{ level: 1, roles: ['APR'], label: 'Procurement Manager' }]);
  }
  M('exc.po_after_receipt', 'PO after receipt', [{ level: 1, roles: ['APR'] }, { level: 2, roles: ['FIN'] }]);
  M('exc.price_amendment', 'Price amendment', [{ level: 1, roles: ['APR'] }, { level: 2, roles: ['FIN'] }]);
  M('contract.approval', 'Contract approval', [{ level: 1, roles: ['APR'] }, { level: 2, roles: ['FIN'] }]);
  M('adv.request', 'Advance up to ₹10 lakh', [{ level: 1, roles: ['APR'] }, { level: 2, roles: ['FIN'] }], { max_value: 1000000 });
  M('adv.request', 'Advance above ₹10 lakh', [{ level: 1, roles: ['APR'] }, { level: 2, roles: ['FIN'] }, { level: 3, roles: ['MGT'] }], { min_value: 1000000.01 });
  M('config.tolerance', 'Joint procurement and finance approval', [{ level: 1, roles: ['FIN', 'APR'], label: 'Finance and Procurement (parallel)' }]);
  M('vendor.onboarding', 'Vendor onboarding', [{ level: 1, roles: ['APR'], label: 'Procurement (capability)' }, { level: 2, roles: ['FIN'], label: 'Finance (bank / KYC)' }]);
  M('vendor.bank_change', 'Bank detail change', [{ level: 1, roles: ['FIN'], label: 'Finance' }]);

  seedSapTransactions();
  runAllInbound('full');
  // Demo history: lines became available in the platform when SAP released them.
  run("UPDATE pr_lines SET available_at = sap_created_at, assigned_at = CASE WHEN buyer_id IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', sap_created_at, '+2 hours') END");
  run("UPDATE pr_lines SET sla_due = strftime('%Y-%m-%dT%H:%M:%fZ', available_at, '+' || CASE priority WHEN 'BD' THEN 24 WHEN 'Class 1' THEN 24 ELSE 72 END || ' hours') WHERE priority != 'Normal'");
  audit(null, { action: 'system.seeded', objectType: 'system', after: { at: t } });
}

function getVendorId(code: string) {
  return get<{ id: number }>('SELECT id FROM vendors WHERE sap_code = ?', code)!.id;
}
function getUserId(local: string) {
  return get<{ id: number }>('SELECT id FROM users WHERE email LIKE ?', `${local}@%`)!.id;
}

/** SAP-side transactions: stock, outline agreements, PRs, POs (history and open), GRN/SES. */
function seedSapTransactions() {
  const B = { amit: 'amit.kulkarni@equipcare.test', sneha: 'sneha.patil@equipcare.test' };
  const R = { priya: 'priya.nair@equipcare.test', rahul: 'rahul.deshmukh@equipcare.test', farhan: 'farhan.qureshi@equipcare.test' };

  // Stock / open PO / VMI (INT-M04)
  const stock: [string, string, number, number, boolean][] = [
    ['HYD-1001', 'PUN1', 1, 0, false], ['HYD-1005', 'PUN1', 14, 0, false], ['UCG-2003', 'PUN1', 6, 80, false], ['UCG-2001', 'DHN1', 0, 0, false],
    ['ENG-3002', 'DHN1', 0, 8, false], ['FLT-4001', 'PUN1', 22, 80, true], ['FLT-4002', 'PUN1', 3, 0, true], ['FLT-4003', 'PUN1', 8, 0, true],
    ['LUB-5001', 'NGP1', 2, 4, false], ['LUB-5002', 'NGP1', 1, 0, false], ['WLD-6001', 'NGP1', 4, 0, false], ['HYD-1002', 'DHN1', 0, 2, false],
    ['HYD-1003', 'DHN1', 5, 0, false], ['TLS-7001', 'NGP1', 0, 0, false], ['PPE-8001', 'NGP1', 18, 0, false], ['ENG-3001', 'PUN1', 0, 1, false],
    ['ENG-3003', 'PUN1', 0, 0, false], ['ELE-9001', 'NGP1', 0, 0, false], ['CAP-9901', 'PUN1', 0, 0, false], ['WLD-6002', 'NGP1', 0, 0, false],
  ];
  for (const [m, p, u, o, vmi] of stock) sapPut('STOCK', `${m}|${p}`, { material_code: m, plant: p, unrestricted: u, open_po_qty: o, vmi }, 'Seed');

  // Outline agreements / contracts (INT-M06)
  sapPut('OA', '5500000101', { type: 'ARC', title: 'Annual rate contract – lubricants FY 2026-27', category: 'LUB', vendor_sap_code: '100104', valid_from: '2026-04-01', valid_to: '2027-03-31', value_cap: 6000000, consumed_value: 2236000, payment_terms: '45 days from GRN', delivery_terms: 'FOR destination', items: [
    { material_code: 'LUB-5001', unit_price: 52000, qty_cap: 80, consumed_qty: 32 }, { material_code: 'LUB-5002', unit_price: 40500, qty_cap: 30, consumed_qty: 10 }, { material_code: 'LUB-5003', unit_price: 39200, qty_cap: 40, consumed_qty: 3 },
  ] }, 'Seed');
  sapPut('OA', '5500000102', { type: 'VMI', title: 'Vendor-managed inventory – filters, Chakan', category: 'FLT', plant: 'PUN1', vendor_sap_code: '100105', valid_from: '2026-01-01', valid_to: '2026-12-31', value_cap: 2400000, consumed_value: 1310000, payment_terms: 'Monthly consumption billing', delivery_terms: 'FOR Chakan', items: [
    { material_code: 'FLT-4001', unit_price: 2150, qty_cap: 600, consumed_qty: 380 }, { material_code: 'FLT-4002', unit_price: 6400, qty_cap: 90, consumed_qty: 44 }, { material_code: 'FLT-4003', unit_price: 9700, qty_cap: 60, consumed_qty: 21 },
  ] }, 'Seed');
  sapPut('OA', '5500000103', { type: 'FDS', title: 'Fixed discount structure – Kranti tools & PPE (12% on price list)', category: 'TLS', vendor_sap_code: '100108', valid_from: '2026-04-01', valid_to: '2027-03-31', value_cap: 1500000, consumed_value: 206040, payment_terms: '30 days', delivery_terms: 'FOR destination', items: [
    { material_code: 'TLS-7001', unit_price: 162800, discount_pct: 12 }, { material_code: 'TLS-7002', unit_price: 30360, discount_pct: 12 }, { material_code: 'PPE-8001', unit_price: 1452, discount_pct: 12 },
  ] }, 'Seed');
  sapPut('OA', '5500000104', { type: 'ARC', title: 'Rate contract – GET & rollers (Shakti)', category: 'UCG', vendor_sap_code: '100102', valid_from: '2025-11-21', valid_to: new Date(Date.now() + 34 * 86400000).toISOString().slice(0, 10), value_cap: 4000000, consumed_value: 3160000, payment_terms: '60 days from GRN', delivery_terms: 'FOR destination', items: [
    { material_code: 'UCG-2003', unit_price: 7600, qty_cap: 400, consumed_qty: 312 }, { material_code: 'UCG-2002', unit_price: 38000, qty_cap: 24, consumed_qty: 14 },
  ] }, 'Seed');
  sapPut('OA', '5500000105', { type: 'OA', title: 'Outline agreement – hydraulic hoses (expired)', category: 'HYD', vendor_sap_code: '100101', valid_from: '2025-10-01', valid_to: '2026-09-30', value_cap: 900000, consumed_value: 812000, payment_terms: '45 days', delivery_terms: 'FOR destination', items: [
    { material_code: 'HYD-1003', unit_price: 3800, qty_cap: 240, consumed_qty: 214 },
  ] }, 'Seed');
  sapPut('OA', '5500000106', { type: 'Fixed supplier', title: 'Fixed supplier – alternator overhaul & supply (Volt)', category: 'ELE', vendor_sap_code: '100111', valid_from: '2026-02-01', valid_to: '2027-01-31', value_cap: 800000, consumed_value: 116000, payment_terms: '30 days', delivery_terms: 'FOR Nagpur', items: [
    { material_code: 'ELE-9001', unit_price: 57500, qty_cap: 12, consumed_qty: 2 },
  ] }, 'Seed');

  // Historic POs (closed, with GRN) — LPP, repeat-purchase and contract-coverage history.
  type Hist = [po: string, vendor: string, days: number, buyer: string, plant: string, items: [string, number, number][], oa?: string];
  const hist: Hist[] = [
    ['4500020101', '100116', -310, B.amit, 'PUN1', [['HYD-1001', 3, 18900]]],
    ['4500020102', '100101', -240, B.amit, 'PUN1', [['HYD-1001', 4, 18450], ['HYD-1005', 6, 2650]]],
    ['4500020103', '100106', -170, B.amit, 'NGP1', [['HYD-1001', 2, 19200]]],
    ['4500020104', '100101', -95, B.amit, 'DHN1', [['HYD-1001', 5, 18450], ['HYD-1003', 30, 3800]], '5500000105'],
    ['4500020105', '100107', -280, B.sneha, 'NGP1', [['WLD-6001', 30, 4300]]],
    ['4500020106', '100107', -190, B.sneha, 'NGP1', [['WLD-6001', 40, 4250], ['WLD-6002', 8, 8900]]],
    ['4500020107', '100107', -120, B.sneha, 'PUN1', [['WLD-6001', 25, 4250]]],
    ['4500020108', '100104', -150, B.sneha, 'NGP1', [['LUB-5001', 12, 52000], ['LUB-5002', 4, 40500]], '5500000101'],
    ['4500020109', '100102', -130, B.amit, 'PUN1', [['UCG-2003', 120, 7600]], '5500000104'],
    ['4500020110', '100103', -200, B.amit, 'DHN1', [['ENG-3002', 6, 46200]]],
    ['4500020111', '100106', -75, B.amit, 'PUN1', [['ENG-3001', 1, 325000]]],
    ['4500020112', '100109', -65, B.amit, 'DHN1', [['SRV-9501', 1, 125000]]],
    ['4500020113', '100105', -45, B.sneha, 'PUN1', [['FLT-4001', 120, 2150], ['FLT-4002', 20, 6400]], '5500000102'],
    ['4500020114', '100110', -210, B.sneha, 'NGP1', [['PPE-8001', 60, 1690], ['PPE-8002', 400, 95]]],
    ['4500020115', '100116', -55, B.amit, 'PUN1', [['HYD-1001', 2, 18700]]],
  ];
  const mat = new Map(MATERIALS.map((m) => [m[0], m]));
  let grnNo = 5000100100;
  for (const [po, vendor, days, buyer, plant, items, oa] of hist) {
    sapPut('PO', po, {
      po_no: po, vendor_sap_code: vendor, buyer_email: buyer, plant, po_date: DAY(days), released: true, version: 1,
      delivery_terms: 'FOR destination', payment_terms: '45 days from GRN', oa_no: oa ?? null, urgency: 'General stock',
      items: items.map(([code, qty, price], i) => ({ item: (i + 1) * 10, material_code: code, description: mat.get(code)![1], qty, uom: mat.get(code)![2], unit_price: price, gst_rate: mat.get(code)![4], delivery_date: DAY(days + 14) })),
    }, 'Seed');
    const g = String(grnNo++);
    sapPut('GRN', `${g}-2026`, { grn_no: g, year: '2026', po_no: po, posting_date: DAY(days + 12), plant, is_service: items.some(([c]) => mat.get(c)![8]), items: items.map(([code, qty, price], i) => ({ po_item: (i + 1) * 10, qty, value: qty * price })) }, 'Seed');
  }

  // Older PRs already converted to open POs (status PO created after sync)
  type PrDoc = [pr: string, req: string, dept: string, days: number, items: [item: number, code: string, qty: number, plant: string, reqDays: number, priority?: string, extra?: Record<string, unknown>][]];
  const prs: PrDoc[] = [
    ['10045480', R.priya, 'Maintenance Planning', -24, [[10, 'HYD-1001', 6, 'PUN1', 5], [20, 'HYD-1003', 24, 'PUN1', 5]]],
    ['10045481', R.priya, 'Maintenance Planning', -20, [[10, 'UCG-2003', 80, 'PUN1', 6], [20, 'UCG-2002', 4, 'PUN1', 10]]],
    ['10045482', R.rahul, 'Field Service', -30, [[10, 'LUB-5001', 10, 'NGP1', -5]]],
    ['10045483', R.priya, 'Maintenance Planning', -10, [[10, 'ENG-3001', 1, 'PUN1', 2, 'BD']]],
    ['10045484', R.farhan, 'Mine Site Services', -6, [[10, 'ENG-3002', 8, 'DHN1', 4, 'Class 1']]],
    ['10045485', R.priya, 'Maintenance Planning', -22, [[10, 'FLT-4001', 80, 'PUN1', -2]]],
    ['10045486', R.rahul, 'Field Service', -34, [[10, 'TLS-7002', 2, 'NGP1', -14], [20, 'PPE-8001', 100, 'NGP1', -14]]],
    ['10045487', R.farhan, 'Mine Site Services', -12, [[10, 'SRV-9501', 1, 'DHN1', 0, 'Normal', { is_service: true }]]],
    ['10045488', R.rahul, 'Field Service', -48, [[10, 'WLD-6001', 40, 'NGP1', -25]]],
    ['10045489', R.farhan, 'Mine Site Services', -8, [[10, 'HYD-1002', 2, 'DHN1', 8]]],
    ['10045490', R.priya, 'Maintenance Planning', -5, [[10, 'HYD-1004', 1, 'PUN1', 20]]],
  ];
  // Open PRs waiting in the workbench (WF-01..WF-05)
  const open: PrDoc[] = [
    ['10045501', R.priya, 'Maintenance Planning', -9, [[10, 'HYD-1001', 4, 'PUN1', 12], [20, 'HYD-1005', 10, 'PUN1', 12]]],
    ['10045502', R.priya, 'Maintenance Planning', -4, [[10, 'UCG-2003', 40, 'PUN1', 15]]],
    ['10045503', R.rahul, 'Field Service', -3, [[10, 'LUB-5001', 6, 'NGP1', 10], [20, 'LUB-5002', 2, 'NGP1', 10]]],
    ['10045504', R.farhan, 'Mine Site Services', -1, [[10, 'UCG-2001', 2, 'DHN1', 3, 'BD'], [20, 'UCG-2004', 1, 'DHN1', 3, 'BD']]],
    ['10045505', R.priya, 'Maintenance Planning', -2, [[10, 'FLT-4002', 12, 'PUN1', 7], [20, 'FLT-4003', 10, 'PUN1', 7]]],
    ['10045506', R.rahul, 'Field Service', -6, [[10, 'TLS-7001', 1, 'NGP1', 20], [20, 'PPE-8001', 50, 'NGP1', 20]]],
    ['10045507', R.farhan, 'Mine Site Services', -2, [[10, 'SRV-9502', 1, 'DHN1', 14, 'Normal', { is_service: true }]]],
    ['10045508', R.priya, 'Maintenance Planning', -15, [[10, 'CAP-9901', 1, 'PUN1', 60, 'Normal', { is_capex: true }]]],
    ['10045509', R.farhan, 'Mine Site Services', -1, [[10, 'HYD-1002', 3, 'DHN1', 4, 'Class 1'], [20, 'HYD-1003', 20, 'DHN1', 5, 'Urgent']]],
    ['10045510', R.rahul, 'Field Service', -11, [[10, 'WLD-6001', 30, 'NGP1', 9], [20, 'WLD-6002', 10, 'NGP1', 9]]],
    ['10045511', R.priya, 'Maintenance Planning', -13, [[10, 'ENG-3001', 1, 'PUN1', 21], [20, 'ENG-3003', 6, 'PUN1', 21]]],
    ['10045512', R.rahul, 'Field Service', -3, [[10, 'ELE-9001', 2, 'NGP1', 12]]],
    ['10045513', R.priya, 'Maintenance Planning', -7, [[10, 'UCG-2002', 6, 'PUN1', 18], [20, 'UCG-2005', 1, 'PUN1', 30]]],
    ['10045514', R.farhan, 'Mine Site Services', -2, [[10, 'LOG-9701', 2, 'DHN1', 6, 'Normal', { is_service: true }]]],
    ['10045515', R.rahul, 'Field Service', -18, [[10, 'HYD-1005', 6, 'NGP1', 4]]],
  ];
  for (const [pr, req, dept, days, items] of [...prs, ...open]) {
    sapPut('PR', pr, {
      pr_no: pr, requisitioner_email: req, department: dept, created_at: D(days),
      items: items.map(([item, code, qty, plant, reqDays, priority, extra]) => ({
        item, material_code: code, description: mat.get(code)![1], qty, uom: mat.get(code)![2], plant, storage_location: plant === 'DHN1' ? 'MS01' : 'WS01',
        required_date: DAY(reqDays), priority: priority ?? 'Normal', est_unit_price: mat.get(code)![6], status: 'Released', ...(extra ?? {}),
      })),
    }, 'Seed');
  }

  // Open POs (released in SAP) — follow-up, ASN, GRN, invoice and dispute scenarios.
  type OpenPo = [po: string, vendor: string, days: number, buyer: string, plant: string, terms: string, urgency: string, items: [pr: string, item: number, code: string, qty: number, price: number, delDays: number, freight?: number][], oa?: string];
  const openPos: OpenPo[] = [
    ['4500021001', '100101', -12, B.amit, 'PUN1', 'FOR destination', 'General stock', [['10045480', 10, 'HYD-1001', 6, 18200, 4], ['10045480', 20, 'HYD-1003', 24, 3900, 4]]],
    ['4500021002', '100102', -9, B.amit, 'PUN1', 'FOR destination', 'General stock', [['10045481', 10, 'UCG-2003', 80, 7600, 5], ['10045481', 20, 'UCG-2002', 4, 38000, 9]], '5500000104'],
    ['4500021003', '100104', -20, B.sneha, 'NGP1', 'Ex-Works', 'General stock', [['10045482', 10, 'LUB-5001', 10, 52000, -6, 6500]], '5500000101'],
    ['4500021004', '100106', -6, B.amit, 'PUN1', 'Ex-Works', 'BD', [['10045483', 10, 'ENG-3001', 1, 318000, 1]]],
    ['4500021005', '100103', -3, B.amit, 'DHN1', 'FOR destination', 'Class 1', [['10045484', 10, 'ENG-3002', 8, 45500, 3]]],
    ['4500021006', '100105', -15, B.sneha, 'PUN1', 'FOR destination', 'General stock', [['10045485', 10, 'FLT-4001', 80, 2150, -3]], '5500000102'],
    ['4500021007', '100108', -25, B.sneha, 'NGP1', 'FOR destination', 'General stock', [['10045486', 10, 'TLS-7002', 2, 30360, -12], ['10045486', 20, 'PPE-8001', 100, 1452, -12]], '5500000103'],
    ['4500021008', '100109', -5, B.amit, 'DHN1', 'FOR destination', 'Urgent', [['10045487', 10, 'SRV-9501', 1, 125000, 2]]],
    ['4500021009', '100107', -40, B.sneha, 'NGP1', 'FOR destination', 'General stock', [['10045488', 10, 'WLD-6001', 40, 4200, -26]]],
    ['4500021010', '100101', -2, B.amit, 'DHN1', 'FOR destination', 'General stock', [['10045489', 10, 'HYD-1002', 2, 24500, 9]]],
  ];
  for (const [po, vendor, days, buyer, plant, terms, urgency, items, oa] of openPos) {
    sapPut('PO', po, {
      po_no: po, vendor_sap_code: vendor, buyer_email: buyer, plant, po_date: DAY(days), released: true, version: 1, delivery_terms: terms,
      payment_terms: oa === '5500000101' ? '45 days from GRN' : '45 days from GRN', freight_terms: terms === 'Ex-Works' ? 'Freight to pay' : 'Freight paid', oa_no: oa ?? null, urgency,
      rfq_date: oa ? null : DAY(days - 6),
      items: items.map(([pr, it, code, qty, price, del, freight]) => ({
        item: it, pr_no: pr, pr_item: it, material_code: code, description: mat.get(code)![1], qty, uom: mat.get(code)![2], unit_price: price,
        gst_rate: mat.get(code)![4], freight: freight ?? 0, delivery_date: DAY(del),
      })),
    }, 'Seed');
  }
  // A PO created but not yet released in SAP (must not be visible to the vendor — AC-POM-01).
  sapPut('PO', '4500021011', { po_no: '4500021011', vendor_sap_code: '100106', buyer_email: B.amit, plant: 'PUN1', po_date: DAY(0), released: false, version: 1, delivery_terms: 'Ex-Works', payment_terms: '30 days', items: [
    { item: 10, pr_no: '10045490', pr_item: 10, material_code: 'HYD-1004', description: mat.get('HYD-1004')![1], qty: 1, uom: 'EA', unit_price: 478000, gst_rate: 18, delivery_date: DAY(20) },
  ] }, 'Seed');

  // GRN / SES on open POs
  const grns: [string, string, number, [number, number, number][], boolean?][] = [
    ['5000100201', '4500021003', -4, [[10, 6, 312000]]],
    ['5000100202', '4500021006', -2, [[10, 80, 172000]]],
    ['5000100203', '4500021007', -11, [[10, 2, 60720], [20, 100, 145200]]],
    ['5000100204', '4500021009', -27, [[10, 40, 168000]]],
    ['5000100205', '4500021001', -1, [[10, 6, 109200], [20, 20, 78000]]],
  ];
  for (const [g, po, days, items, svc] of grns) {
    const plant = openPos.find((p) => p[0] === po)![4];
    sapPut('GRN', `${g}-2026`, { grn_no: g, year: '2026', po_no: po, posting_date: DAY(days), plant, is_service: !!svc, items: items.map(([po_item, qty, value]) => ({ po_item, qty, value })) }, 'Seed');
  }
}
