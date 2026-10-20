/**
 * Vendor module extended demo data (only with DEMO_EXTRA).
 *
 * A pipeline of vendors in every onboarding state (invited, expired link, registering, submitted, under review, clarification,
 * approved and waiting for the SAP code, rejected), capability proposals, bank and profile change requests in several states,
 * KYC documents expiring or expired across a dozen vendors, and vendor tickets in every category and status with message
 * threads, internal notes and SLA breaches. Services run as the right persona; timestamps are backdated afterwards.
 * Deterministic: no Math.random().
 */
import { all, get, run, scalar, insert } from '../../core/db.ts';
import { act, getApproval } from '../../core/approvals.ts';
import { cfg } from '../../core/config.ts';
import { hashPassword } from '../../core/auth.ts';
import { makeGstin } from '../../core/india.ts';
import type { Role } from '../../core/permissions.ts';
import { DEMO_PASSWORD } from '../../seed/base.ts';
import { actorFor, D, DAY, V } from '../../seed/ctx.ts';
import { applyBankChange } from '../sap/simulator.ts';
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

const warn = (what: string, e: unknown) => console.warn(`vendors seed_extra: ${what} skipped —`, (e as Error).message);

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

function backdateApproval(apId: number | null | undefined, startDay: number) {
  if (!apId) return;
  run('UPDATE approvals SET created_at = ?, decided_at = CASE WHEN decided_at IS NULL THEN NULL ELSE ? END WHERE id = ?', D(startDay, 11), D(Math.min(0, startDay + 2), 15), apId);
  const steps = all<{ id: number }>('SELECT id FROM approval_steps WHERE approval_id = ? AND acted_at IS NOT NULL ORDER BY level, id', apId);
  steps.forEach((s, i) => run('UPDATE approval_steps SET acted_at = ? WHERE id = ?', D(Math.min(0, startDay + 1 + i), 12 + i), s.id));
}

function patchOb(vendorId: number, fn: (o: any) => void) {
  const v = S.getVendor(vendorId)!;
  const o: any = JSON.parse(JSON.stringify(v.onboarding ?? {}));
  fn(o);
  run('UPDATE vendors SET onboarding_json = ? WHERE id = ?', JSON.stringify(o), vendorId);
}

function panFor(seed9: string, entity: string) {
  const letters = seed9.slice(0, 5).split('');
  letters[3] = entity;
  return `${letters.join('')}${seed9.slice(5, 9)}${'ABCDEFGHJK'[Number(seed9.slice(8, 9))]}`;
}

// ---------------------------------------------------------------------------------------------------- onboarding pipeline
type Stage = 'invited' | 'expired' | 'progress' | 'submitted' | 'review' | 'clarify' | 'pendingSap' | 'rejected';
interface NewVendor {
  stage: Stage; daysAgo: number; name: string; person: string; email: string; phone: string; cat: string; sub: string; role: string;
  state: string; city: string; address: string; panSeed: string; entity: string; msme?: [string, string]; bank: [string, string, string];
}
const NEW_VENDORS: NewVendor[] = [
  { stage: 'invited', daysAgo: 3, name: 'Nashik Seal & Gasket Works', person: 'Sandeep Pawar', email: 'sandeep.pawar@nashikseal.test', phone: '+91 98220 41877', cat: 'HYD', sub: 'Seals and gaskets', role: 'Manufacturer', state: 'Maharashtra', city: 'Nashik', address: 'Plot 14, MIDC Ambad, Nashik 422010', panSeed: 'NSGWK4408', entity: 'F', bank: ['HDFC Bank', 'HDFC0000412', '50200041877731'] },
  { stage: 'expired', daysAgo: 21, name: 'Kolhapur Forge & Castings', person: 'Amol Jadhav', email: 'amol.jadhav@kolhapurforge.test', phone: '+91 98500 61204', cat: 'UCG', sub: 'Forged bucket parts', role: 'Manufacturer', state: 'Maharashtra', city: 'Kolhapur', address: 'Shiroli MIDC, Kolhapur 416122', panSeed: 'KLPFC5516', entity: 'C', bank: ['State Bank of India', 'SBIN0000527', '30145520661'] },
  { stage: 'progress', daysAgo: 9, name: 'Raigad Industrial Lubes', person: 'Mahesh Gaikwad', email: 'mahesh.gaikwad@raigadlubes.test', phone: '+91 98230 90412', cat: 'LUB', sub: 'Gear and hydraulic oils', role: 'Authorised distributor', state: 'Maharashtra', city: 'Panvel', address: 'Gala 7, Taloja Industrial Area, Panvel 410208', panSeed: 'RGILB7720', entity: 'F', bank: ['ICICI Bank', 'ICIC0000688', '068801502277'] },
  { stage: 'submitted', daysAgo: 6, name: 'Surat Safety & Workwear Co.', person: 'Hiren Desai', email: 'hiren.desai@suratsafety.test', phone: '+91 98250 33180', cat: 'PPE', sub: 'Workwear and gloves', role: 'Manufacturer', state: 'Gujarat', city: 'Surat', address: 'Unit 22, Sachin GIDC, Surat 394230', panSeed: 'SRTSW3391', entity: 'C', msme: ['UDYAM-GJ-22-0044187', 'Small'], bank: ['Axis Bank', 'UTIB0001433', '917020014418722'] },
  { stage: 'review', daysAgo: 14, name: 'Aurangabad Hydraulic Systems LLP', person: 'Vivek Kulkarni', email: 'vivek.kulkarni@aurangabadhydraulic.test', phone: '+91 98220 77451', cat: 'HYD', sub: 'Hydraulic pumps and motors', role: 'Reman service', state: 'Maharashtra', city: 'Aurangabad', address: 'Plot D-31, Waluj MIDC, Aurangabad 431136', panSeed: 'AGBHS6642', entity: 'F', msme: ['UDYAM-MH-02-0061342', 'Medium'], bank: ['HDFC Bank', 'HDFC0001019', '50200066420915'] },
  { stage: 'clarify', daysAgo: 12, name: 'Coimbatore Track Parts Pvt Ltd', person: 'Senthil Kumar', email: 'senthil.kumar@cbetrackparts.test', phone: '+91 94440 55318', cat: 'UCG', sub: 'Track shoes and links', role: 'Authorised distributor', state: 'Tamil Nadu', city: 'Coimbatore', address: '88 Kurichi Industrial Estate, Coimbatore 641021', panSeed: 'CBTPP8805', entity: 'C', bank: ['Canara Bank', 'CNRB0000855', '0855201004417'] },
  { stage: 'pendingSap', daysAgo: 22, name: 'Indore Filtration Technologies', person: 'Rakesh Joshi', email: 'rakesh.joshi@indorefiltration.test', phone: '+91 94250 61180', cat: 'FLT', sub: 'Hydraulic and fuel filters', role: 'Manufacturer', state: 'Madhya Pradesh', city: 'Indore', address: 'Sector F, Pithampur Industrial Area, Dhar 454775', panSeed: 'INDFT2257', entity: 'C', msme: ['UDYAM-MP-14-0030215', 'Medium'], bank: ['Bank of Baroda', 'BARB0PITHAM', '31740200001126'] },
  { stage: 'rejected', daysAgo: 38, name: 'Lucknow Bearing Traders', person: 'Anil Srivastava', email: 'anil.srivastava@lucknowbearing.test', phone: '+91 98390 44721', cat: 'ENG', sub: 'Bearings', role: 'Trader', state: 'Uttar Pradesh', city: 'Lucknow', address: '12 Aishbagh Road, Lucknow 226003', panSeed: 'LKNBT9013', entity: 'F', bank: ['Punjab National Bank', 'PUNB0114500', '1145002100031'] },
];

function ensureVendorUser(vendorId: number, v: NewVendor, startDay: number) {
  let u = get<{ id: number }>('SELECT id FROM users WHERE lower(email) = ?', v.email);
  if (!u) {
    const id = insert('users', { name: v.person, email: v.email, phone: v.phone, roles: 'VEN', title: 'Director', vendor_id: vendorId, vendor_role: 'Vendor administrator', password_hash: hashPassword(DEMO_PASSWORD), created_at: D(startDay + 1) });
    u = { id };
  } else run('UPDATE users SET created_at = ? WHERE id = ?', D(startDay + 1), u.id);
  return actorFor(v.email.split('@')[0]);
}

function registerVendor(spec: NewVendor) {
  const amit = actorFor('amit.kulkarni');
  const start = -spec.daysAgo;
  const inv = S.inviteVendor(amit, { legal_name: spec.name, contact_name: spec.person, email: spec.email, phone: spec.phone, category: spec.cat });
  const id = inv.id;
  run('UPDATE vendors SET created_at = ? WHERE id = ?', D(start, 10), id);
  patchOb(id, (o) => { o.invite.invited_at = D(start, 10); });
  run('UPDATE outbox SET created_at = ? WHERE recipient = ?', D(start, 10), spec.email);
  if (spec.stage === 'invited' || spec.stage === 'expired') {
    run('UPDATE vendors SET invite_expires_at = ? WHERE id = ?', D(start + 14, 10), id);
    return id;
  }

  const token = get<{ invite_token: string }>('SELECT invite_token FROM vendors WHERE id = ?', id)!.invite_token;
  S.acceptInvite({ token, name: spec.person, password: DEMO_PASSWORD });
  const me = ensureVendorUser(id, spec, start);
  patchOb(id, (o) => { o.registered_at = D(start + 1, 11); });

  const pan = panFor(spec.panSeed, spec.entity);
  const gstin = makeGstin(S.GST_STATES[spec.state], pan, '1');
  S.saveOnboarding(me, { section: 'company', legal_name: spec.name, name: spec.name, address: spec.address, city: spec.city, state: spec.state });
  S.saveOnboarding(me, { section: 'tax', gstin, pan });
  if (spec.stage === 'progress') return id;
  if (spec.msme) S.saveOnboarding(me, { section: 'msme', registered: true, msme_no: spec.msme[0], msme_category: spec.msme[1] });
  S.saveOnboarding(me, { section: 'bank', bank_name: spec.bank[0], bank_ifsc: spec.bank[1], account_no: spec.bank[2], account_confirm: spec.bank[2] });
  S.saveOnboarding(me, { section: 'contacts', contacts: [{ name: spec.person, role: 'Director', email: spec.email, phone: spec.phone }, { name: 'Accounts desk', role: 'Accounts', email: `accounts@${spec.email.split('@')[1]}`, phone: spec.phone }] });

  const docs: [string, string | null, string | null][] = [['GST certificate', gstin, null], ['PAN card', pan, null], ['Cancelled cheque', null, null]];
  if (spec.msme) docs.push(['MSME / Udyam certificate', spec.msme[0], DAY(540)]);
  docs.push(['ISO 9001 certificate', `ISO-${spec.panSeed.slice(0, 3)}-${spec.panSeed.slice(5)}`, DAY(380)]);
  for (const [type, no, expiry] of docs) {
    const att = S.attachDemoPdf(id, `${type} — ${spec.name}`, me.id);
    S.addDocument(me, { doc_type: type, doc_no: no, expiry_date: expiry, attachment_id: att });
  }
  run('UPDATE vendor_documents SET created_at = ? WHERE vendor_id = ?', D(start + 2, 12), id);
  S.addCapability(me, { category: spec.cat, sub_category: spec.sub, supplier_role: spec.role, brand: 'Own brand', region: 'All India' });
  run('UPDATE vendor_capabilities SET created_at = ? WHERE vendor_id = ?', D(start + 2, 12), id);
  S.submitOnboarding(me);
  patchOb(id, (o) => { o.submitted_at = D(start + 3, 10); });
  if (spec.stage === 'submitted') return id;

  const procurement = actorFor('amit.kulkarni');
  const finance = actorFor('meera.iyer');
  const docRows = all<{ id: number; doc_type: string }>("SELECT id, doc_type FROM vendor_documents WHERE vendor_id = ? AND status = 'Pending review' ORDER BY id", id);
  const capId = scalar<number>("SELECT id FROM vendor_capabilities WHERE vendor_id = ? AND status = 'Proposed' ORDER BY id LIMIT 1", id)!;

  if (spec.stage === 'clarify' || spec.stage === 'rejected') {
    S.startReview(procurement, id);
    S.reviewDocument(procurement, docRows.find((d) => d.doc_type === 'GST certificate')!.id, 'Valid', null);
    S.requestClarification(finance, id, spec.stage === 'clarify'
      ? 'The cancelled cheque is cropped and the account number is not readable. Upload a full scan and confirm the account holder name matches the legal name.'
      : 'The GSTIN certificate shows a different trade name from your application. Send the amended certificate within 10 days.');
    patchOb(id, (o) => { o.clarification.at = D(start + 5, 15); });
    run("UPDATE comments SET created_at = ? WHERE object_type = 'vendor' AND object_id = ?", D(start + 5, 15), id);
    if (spec.stage === 'clarify') {
      S.respondClarification(me, 'Understood. We are getting a fresh cancelled cheque from our bank and will upload it tomorrow.');
      run("UPDATE comments SET created_at = ? WHERE object_type = 'vendor' AND object_id = ? AND body LIKE 'Understood.%'", D(start + 7, 11), id);
    } else {
      S.rejectOnboarding(procurement, id, 'No response to the clarification request within 15 days and the GST certificate still does not match the application. Reapply with corrected documents.');
      patchOb(id, (o) => { o.rejected_at = D(start + 20, 12); });
      run("UPDATE comments SET created_at = ? WHERE object_type = 'vendor' AND object_id = ? AND body LIKE 'Application rejected%'", D(start + 20, 12), id);
    }
    return id;
  }

  // Under review: documents decided one by one, then the procurement review; finance still has the cheque to verify.
  S.startReview(procurement, id);
  for (const d of docRows) {
    if (spec.stage === 'review' && d.doc_type === 'Cancelled cheque') continue;
    S.reviewDocument(finance, d.id, 'Valid', null);
  }
  S.decideCapability(procurement, capId, 'Approved', 'Matches the category list and the vendor profile.');
  run('UPDATE vendor_capabilities SET decided_at = ? WHERE vendor_id = ?', D(start + 5, 14), id);
  S.completeReview(procurement, id, 'procurement', 'Capability, references and plant visit report are satisfactory.');
  patchOb(id, (o) => { if (o.reviews?.procurement) o.reviews.procurement.at = D(start + 5, 15); });
  if (spec.stage === 'review') {
    const extra = S.addCapability(me, { category: spec.cat === 'HYD' ? 'ENG' : spec.cat, sub_category: 'Reman services — new proposal', supplier_role: 'Reman service', brand: 'Assorted', region: 'West India' });
    run('UPDATE vendor_capabilities SET created_at = ? WHERE id = ?', D(-2, 10), extra.id);
    return id;
  }

  // Pending SAP code: finance review, approval (procurement manager then finance), SAP vendor not yet created.
  S.completeReview(finance, id, 'finance', 'Bank letter matches the cancelled cheque; GSTIN active.');
  patchOb(id, (o) => { if (o.reviews?.finance) o.reviews.finance.at = D(start + 6, 15); });
  S.submitForApproval(procurement, id);
  const apId = S.getVendor(id)!.onboarding!.approval_id!;
  decide(apId, 'approve', 'Onboarding checks complete — approved.');
  backdateApproval(apId, start + 8);
  patchOb(id, (o) => { o.approved_at = D(start + 10, 12); o.sap_requested_at = D(start + 10, 12); });
  return id;
}

function onboardingPipeline() {
  for (const spec of NEW_VENDORS) {
    try {
      registerVendor(spec);
    } catch (e) { warn(`onboarding ${spec.name}`, e); }
  }
}

// ---------------------------------------------------------------------------------------------------- capabilities
function capabilityProposals() {
  const proposals: { who: string; code: string; body: Parameters<typeof S.addCapability>[1]; day: number; decision?: ['Approved' | 'Rejected', string] }[] = [
    { who: 'manoj.kale', code: '100101', day: -4, body: { category: 'HYD', sub_category: 'Hydraulic cylinder repair', supplier_role: 'Reman service', brand: 'Assorted', region: 'West India' } },
    { who: 'divya.raman', code: '100102', day: -2, body: { category: 'UCG', sub_category: 'Sprockets and idlers', supplier_role: 'Manufacturer', brand: 'Own brand', region: 'All India' } },
    { who: 'nitin', code: '100108', day: -6, body: { category: 'WLD', sub_category: 'Welding accessories', supplier_role: 'Dealer', brand: 'Assorted', region: 'West India' } },
    { who: 'imran', code: '100106', day: -16, body: { category: 'ENG', sub_category: 'Turbocharger repair', supplier_role: 'Reman service', brand: 'Assorted', region: 'South India' }, decision: ['Rejected', 'Turbocharger repair is handled by the OEM service network under the engine ARC; propose it under hydraulic reman instead.'] },
    { who: 'pooja.malhotra', code: '100105', day: -23, body: { category: 'LUB', sub_category: 'Filter and lube combination kits', supplier_role: 'Authorised distributor', brand: 'Assorted', region: 'All India' }, decision: ['Rejected', 'Duplicate of the approved filter capability; kits are quoted under filters, so no separate row is needed.'] },
    { who: 'sanjay', code: '100104', day: -31, body: { category: 'LUB', sub_category: 'Grease and coolants', supplier_role: 'Authorised distributor', brand: 'Assorted', region: 'West India' }, decision: ['Approved', 'Regular supplier of grease; add for RFQ suggestions.'] },
  ];
  for (const p of proposals) {
    try {
      const me = actorFor(p.who);
      const { id } = S.addCapability(me, p.body);
      run('UPDATE vendor_capabilities SET created_at = ? WHERE id = ?', D(p.day, 10), id);
      if (p.decision) {
        S.decideCapability(actorFor('amit.kulkarni'), id, p.decision[0], p.decision[1]);
        run('UPDATE vendor_capabilities SET decided_at = ? WHERE id = ?', D(p.day + 2, 15), id);
      }
    } catch (e) { warn(`capability proposal ${p.code}`, e); }
  }
}

// ---------------------------------------------------------------------------------------------------- change requests
function changeRequests() {
  const amit = actorFor('amit.kulkarni');
  const meera = actorFor('meera.iyer');
  const stamp = (id: number, day: number, patch: Record<string, string | null> = {}) => {
    run('UPDATE vendor_change_requests SET created_at = ? WHERE id = ?', D(day, 10), id);
    for (const [k, v] of Object.entries(patch)) run(`UPDATE vendor_change_requests SET ${k} = ? WHERE id = ?`, v, id);
  };
  const cheque = (vendorId: number, label: string, userId: number) => S.attachDemoPdf(vendorId, label, userId);
  const relink = (att: number, crId: number) => run("UPDATE attachments SET owner_type = 'vendor_change', owner_id = ? WHERE id = ?", crId, att);

  // Shakti: bank change verified by finance, approved by a second finance user, sent to SAP and applied there.
  try {
    const me = actorFor('divya.raman');
    const att = cheque(me.vendorId!, 'Cancelled cheque — new account, Shakti Undercarriage', me.id);
    const cr = S.requestChange(me, { field: 'bank_account', reason: 'Our treasury moved collections to a new current account at ICICI Bank.', bank: { bank_name: 'ICICI Bank', bank_ifsc: 'ICIC0001203', account_no: '120501003318', account_confirm: '120501003318' }, attachment_ids: [att] });
    relink(att, cr.id);
    const v = S.sendBankChangeForApproval(meera, cr.id, 'Cheque matches the new account; confirmed by call to the registered finance contact.');
    decide(v.approval_id, 'approve', 'Verified against cheque and callback — approved.');
    backdateApproval(v.approval_id, -33);
    applyBankChange(actorFor('neha.gupta'), me.vendorId!, cr.id);
    stamp(cr.id, -34, { decided_at: D(-31, 12), sent_to_sap_at: D(-31, 12), applied_at: D(-29, 11) });
  } catch (e) { warn('bank change applied', e); }

  // Western Lubricants: bank change rejected by finance.
  try {
    const me = actorFor('sanjay');
    const att = cheque(me.vendorId!, 'Cancelled cheque — new account, Western Lubricants', me.id);
    const cr = S.requestChange(me, { field: 'bank_account', reason: 'Switching to a proprietorship current account closer to our godown.', bank: { bank_name: 'Kotak Mahindra Bank', bank_ifsc: 'KKBK0001765', account_no: '4412087751', account_confirm: '4412087751' }, attachment_ids: [att] });
    relink(att, cr.id);
    const v = S.sendBankChangeForApproval(meera, cr.id, 'Document is a bank letter, not a cancelled cheque; sending for decision as requested.');
    decide(v.approval_id, 'reject', 'Account holder on the cheque is an individual, not the proprietorship — rejected.');
    backdateApproval(v.approval_id, -19);
    stamp(cr.id, -20, { decided_at: D(-17, 12) });
  } catch (e) { warn('bank change rejected', e); }

  // Deccan Hydraulics: bank change waiting for finance verification, and a phone change waiting for procurement.
  try {
    const me = actorFor('imran');
    const att = cheque(me.vendorId!, 'Cancelled cheque — new account, Deccan Hydraulics', me.id);
    const cr = S.requestChange(me, { field: 'bank_account', reason: 'Bank merger changed our IFSC and account number.', bank: { bank_name: 'Union Bank of India', bank_ifsc: 'UBIN0532118', account_no: '532101008855', account_confirm: '532101008855' }, attachment_ids: [att] });
    relink(att, cr.id);
    stamp(cr.id, -1);
    const ph = S.requestChange(me, { field: 'contact_phone', new_value: '+91 99490 77555', reason: 'The accounts desk has a new mobile number for payment calls.' });
    stamp(ph.id, -3);
  } catch (e) { warn('Deccan changes', e); }

  // Precision Filtration: e-mail change approved and applied (platform-owned field).
  try {
    const me = actorFor('pooja.malhotra');
    const cr = S.requestChange(me, { field: 'contact_email', new_value: 'orders@precisionfilt.test', reason: 'Order mails should go to a shared inbox instead of a personal one.' });
    S.decideChange(amit, cr.id, 'Approved', 'Domain matches the vendor registration.');
    stamp(cr.id, -12, { decided_at: D(-11, 12), applied_at: D(-11, 12) });
  } catch (e) { warn('e-mail change applied', e); }

  // Kranti Tools: address change approved and sent to SAP, waiting for the SAP team (SAP-owned field).
  try {
    const me = actorFor('nitin');
    const cr = S.requestChange(me, { field: 'address', new_value: 'Gala 12, Bhosari MIDC, Pune 411026', reason: 'Warehouse moved to a larger unit in Bhosari; invoices must carry the new address.' });
    S.decideChange(amit, cr.id, 'Approved', 'Address proof (rent agreement) attached to the ticket.');
    stamp(cr.id, -8, { decided_at: D(-6, 12), sent_to_sap_at: D(-6, 12) });
  } catch (e) { warn('address change sent to SAP', e); }

  // Shakti: legal-name change rejected by procurement; Western Lubricants: MSME category change withdrawn by the vendor.
  try {
    const me = actorFor('divya.raman');
    const cr = S.requestChange(me, { field: 'legal_name', new_value: 'Shakti Undercarriage Components Limited', reason: 'Company converted from private to public limited.' });
    S.decideChange(amit, cr.id, 'Rejected', 'The conversion certificate was not attached. Raise a new request with the ROC certificate.');
    stamp(cr.id, -26, { decided_at: D(-25, 12) });
  } catch (e) { warn('legal name rejected', e); }
  try {
    const me = actorFor('sanjay');
    const cr = S.requestChange(me, { field: 'msme_category', new_value: 'Small', reason: 'Turnover crossed the micro-enterprise limit this year.' });
    S.withdrawChange(me, cr.id);
    stamp(cr.id, -15, { decided_at: D(-14, 10) });
  } catch (e) { warn('MSME change withdrawn', e); }
}

// ---------------------------------------------------------------------------------------------------- KYC documents
function kycDocuments() {
  const plan: [string, string, number][] = [
    ['100103', 'ISO 9001 certificate', 9], ['100107', 'ISO 9001 certificate', -35], ['100110', 'ISO 9001 certificate', 27],
    ['100112', 'ISO 9001 certificate', -3], ['100114', 'ISO 9001 certificate', 14], ['100119', 'ISO 9001 certificate', -62],
    ['100121', 'MSME / Udyam certificate', 6], ['100113', 'MSME / Udyam certificate', -20], ['100126', 'ISO 9001 certificate', 33],
  ];
  for (const [code, type, days] of plan) {
    try {
      const vid = V(code);
      const n = run("UPDATE vendor_documents SET expiry_date = ?, status = 'Valid' WHERE vendor_id = ? AND doc_type = ? AND status IN ('Valid','Expired')", DAY(days), vid, type).changes;
      if (!n) throw new Error(`${code} has no ${type}`);
    } catch (e) { warn(`KYC expiry ${code}`, e); }
  }
  // Extra documents with files: dealer / OEM letters with expiry dates.
  const letters: [string, number][] = [['100105', 18], ['100108', -9], ['100116', 41], ['100102', 11]];
  for (const [code, days] of letters) {
    try {
      const vid = V(code);
      const att = S.attachDemoPdf(vid, `Authorised dealer / OEM letter — ${code}`, null);
      insert('vendor_documents', { vendor_id: vid, doc_type: 'Authorised dealer / OEM letter', doc_no: `OEM/${code}/26`, attachment_id: att, issued_on: DAY(days - 365), expiry_date: DAY(days), status: 'Valid', mandatory: 0, created_at: D(-200) });
    } catch (e) { warn(`OEM letter ${code}`, e); }
  }
  S.kycExpiryJob();
}

// ---------------------------------------------------------------------------------------------------- tickets
type Step =
  | ['assign', string]
  | ['reply', string, string, boolean?]
  | ['vendor', string]
  | ['status', string, string, string]
  | ['vendorStatus', string]
  | ['reroute', string, string, string];
interface TicketSpec { who: string; category: string; priority: string; subject: string; body: string; days: number; po?: boolean; steps: Step[] }

const TICKETS: TicketSpec[] = [
  { who: 'nitin', category: 'Login / access', priority: 'Normal', days: 4, subject: 'OTP for our second user is not arriving', body: 'We added Pravin from dispatch as a portal user. He gets the invitation but the sign-in code never reaches his phone. Please check the number on file.', steps: [] },
  { who: 'imran', category: 'RFQ access', priority: 'High', days: 2, subject: 'Invited RFQ does not show on our dashboard', body: 'We received the e-mail for the hydraulic pump RFQ but the RFQ is not listed under Open RFQs. The closing time is close, so please look at this today.', steps: [] },
  { who: 'manoj.kale', category: 'PO visibility', priority: 'Normal', days: 3, po: true, subject: 'Revised delivery date not reflected on the PO', body: 'The buyer agreed a revised delivery date on call but the portal still shows the original date and now marks us late.', steps: [
    ['assign', 'amit.kulkarni'], ['reply', 'amit.kulkarni', 'Thank you. We are raising the amendment with SAP so the new date appears on the PO. You will get a notification once it is released.'],
    ['reply', 'amit.kulkarni', 'Internal: amendment is with the SAP team; warehouse confirmed the late slot is due to our own dock congestion, so no vendor delay should be recorded.', true],
  ] },
  { who: 'divya.raman', category: 'Invoice upload', priority: 'High', days: 5, subject: 'Invoice PDF rejected as unreadable', body: 'The upload screen says the invoice file could not be read. The same PDF opens fine on our side. Can you tell us what format you need?', steps: [
    ['assign', 'meera.iyer'], ['reply', 'meera.iyer', 'The scan looks rotated and the GSTIN line is cut off. Please export the invoice again as a text PDF, not a photo scan.'],
    ['status', 'meera.iyer', 'Awaiting vendor', 'We will keep this ticket open until you upload the corrected file.'],
  ] },
  { who: 'sanjay', category: 'Payment query', priority: 'Urgent', days: 1, po: true, subject: 'Payment overdue by 12 days on two invoices', body: 'Two invoices for lubricant supply are 12 days past the due date and our diesel suppliers are asking us for payment. Please share the release date.', steps: [
    ['assign', 'kiran.shah'], ['reply', 'kiran.shah', 'We have raised this with the payment run owner and will confirm the release date today.'],
    ['reply', 'kiran.shah', 'Internal: the run slipped because one of the two invoices was on dispute hold; hold lifted this morning, release in tomorrow\'s run.', true],
  ] },
  { who: 'pooja.malhotra', category: 'Document issue', priority: 'Normal', days: 9, subject: 'GST certificate marked expired but it is current', body: 'The portal shows our GST certificate as expired. It has no expiry date, so this looks like a data problem.', steps: [
    ['assign', 'sneha.patil'], ['reply', 'sneha.patil', 'Thanks for flagging. The date field had been filled from the invoice date. We cleared it and re-checked the certificate.'],
    ['vendor', 'Confirmed, the status is correct on our profile now. Thank you.'], ['status', 'sneha.patil', 'Resolved', 'GST certificate date corrected and KYC status shows complete.'],
  ] },
  { who: 'imran', category: 'Dispute clarification', priority: 'High', days: 21, po: true, subject: 'Short receipt dispute: need the GRN copy', body: 'Stores raised a shortage dispute on our last delivery. We need the goods receipt copy to compare with our delivery challan.', steps: [
    ['assign', 'amit.kulkarni'], ['reply', 'amit.kulkarni', 'The GRN copy is attached to the dispute thread now. Please compare and reply there.'],
    ['vendor', 'Received, our challan quantity was a typing error. We accept the receipt quantity.'], ['status', 'amit.kulkarni', 'Resolved', 'Dispute thread updated with your acceptance; the invoice is released for the received quantity.'], ['vendorStatus', 'Closed'],
  ] },
  { who: 'sanjay', category: 'Payment query', priority: 'Normal', days: 34, subject: 'TDS certificate for last quarter', body: 'Please share the TDS certificate (Form 16A) for the January to March quarter so we can file our return.', steps: [
    ['assign', 'meera.iyer'], ['reply', 'meera.iyer', 'Form 16A for the quarter has been issued from TRACES and sent to your registered e-mail.'],
    ['status', 'meera.iyer', 'Resolved', 'Form 16A for the January to March quarter sent to your registered e-mail.'], ['status', 'meera.iyer', 'Closed', 'Closed after no further questions.'],
  ] },
  { who: 'manoj.kale', category: 'Invoice upload', priority: 'Normal', days: 12, subject: 'Credit note could not be uploaded', body: 'We need to upload a credit note against a short-supplied invoice but the upload form only accepts invoices.', steps: [
    ['reroute', 'meera.iyer', 'BUY', 'Credit notes against POs are agreed with the buyer first, then finance posts them.'],
    ['assign', 'amit.kulkarni'], ['reply', 'amit.kulkarni', 'Please send the credit note as a ticket attachment; finance will post it against the invoice. Online credit-note upload is planned.'],
    ['status', 'amit.kulkarni', 'Resolved', 'Credit note received and passed to finance for posting against the invoice.'],
  ] },
  { who: 'nitin', category: 'PO visibility', priority: 'Urgent', days: 2, po: true, subject: 'PO line missing for the urgent PPE order', body: 'The buyer called to say an urgent order was placed, but we only see one line of three on the PO.', steps: [
    ['assign', 'sneha.patil'], ['status', 'sneha.patil', 'Awaiting vendor', 'Please send the PR or PO number the buyer quoted so we can match the missing lines.'],
  ] },
  { who: 'divya.raman', category: 'RFQ access', priority: 'Normal', days: 0, subject: 'Need more time for the quotation', body: 'We are waiting for a forged-parts price from our mill and cannot quote before the closing time. Can the deadline move by one day?', steps: [] },
  { who: 'pooja.malhotra', category: 'Login / access', priority: 'High', days: 6, subject: 'Account locked after password reset', body: 'I reset my password twice and now the account says locked. We have invoices waiting to be uploaded.', steps: [
    ['assign', 'anjali.verma'], ['reply', 'anjali.verma', 'Your account is unlocked now. Please sign in with the latest password; the code will go to your registered mobile number.'],
    ['status', 'anjali.verma', 'Resolved', 'Account unlocked and failed-attempt counter cleared. Sign in with your latest password.'],
  ] },
  { who: 'imran', category: 'Document issue', priority: 'Normal', days: 7, subject: 'ISO certificate uploaded but not showing in profile', body: 'We uploaded the renewed ISO 9001 certificate last week but the old one is still shown with its expiry date.', steps: [
    ['reroute', 'sneha.patil', 'APR', 'Needs the procurement manager to review a certificate issued by a body outside the approved list.'],
    ['assign', 'vikram.joshi'], ['reply', 'vikram.joshi', 'The new certificate is issued by a body that is not on our approved list. We are reviewing it and will confirm in two working days.'],
  ] },
  { who: 'manoj.kale', category: 'Dispute clarification', priority: 'Normal', days: 15, po: true, subject: 'Clarification on the excess quantity dispute', body: 'We delivered 5 extra sets as a free sample. Stores raised an excess quantity dispute; please clarify what we need to do.', steps: [
    ['assign', 'sneha.patil'], ['reply', 'sneha.patil', 'Extra quantity without a PO line cannot be received. Please collect the sets or ask us to raise a PO amendment.'],
    ['vendor', 'We will collect the 5 sets with the next delivery.'], ['reply', 'sneha.patil', 'Noted. The dispute will close once the sets are picked up.'],
    ['status', 'sneha.patil', 'Resolved', 'Agreed: vendor collects the 5 extra sets with the next delivery and the dispute closes then.'],
  ] },
];

function tickets() {
  const sla = cfg<Record<string, number>>('tickets.sla_hours');
  const r = rng(42042);
  for (const t of TICKETS) {
    try {
      const vendorActor = actorFor(t.who);
      const ref = t.po ? scalar<string>('SELECT po_no FROM pos WHERE vendor_id = ? ORDER BY po_date DESC LIMIT 1', vendorActor.vendorId) ?? null : null;
      const created = S.createTicket(vendorActor, { category: t.category, subject: t.subject, body: t.body, priority: t.priority, object_ref: ref });
      for (const s of t.steps) {
        if (s[0] === 'assign') S.assignTicket(actorFor(s[1]), created.id, actorFor(s[1]).id);
        else if (s[0] === 'reply') S.replyTicket(actorFor(s[1]), created.id, s[2], !!s[3]);
        else if (s[0] === 'vendor') S.replyTicket(vendorActor, created.id, s[1], false);
        else if (s[0] === 'status') S.setTicketStatus(actorFor(s[1]), created.id, s[2], s[3]);
        else if (s[0] === 'vendorStatus') S.setTicketStatus(vendorActor, created.id, s[1], null);
        else if (s[0] === 'reroute') S.rerouteTicket(actorFor(s[1]), created.id, s[2], s[3]);
      }
      // Backdate: first message at the start, the last one at ~80% of the elapsed time, others in between.
      const start = Math.min(Date.parse(D(-t.days, 9)), Date.now() - 3 * 3600000);
      const span = Math.max(0, (Date.now() - start) * 0.8);
      const msgs = all<{ id: number }>('SELECT id FROM ticket_messages WHERE ticket_id = ? ORDER BY id', created.id);
      let last = start;
      msgs.forEach((m, i) => {
        const at = msgs.length === 1 ? start : start + Math.round((span * (i === 0 ? 0 : (i + r() * 0.3) / (msgs.length - 0.7))));
        last = Math.max(last, Math.min(at, start + span));
        run('UPDATE ticket_messages SET created_at = ? WHERE id = ?', new Date(i === 0 ? start : last).toISOString(), m.id);
      });
      const row = get<{ status: string; priority: string }>('SELECT status, priority FROM tickets WHERE id = ?', created.id)!;
      const done = ['Resolved', 'Closed'].includes(row.status);
      run('UPDATE tickets SET created_at = ?, updated_at = ?, resolved_at = ?, sla_due = ? WHERE id = ?', new Date(start).toISOString(), new Date(last).toISOString(),
        done ? new Date(start + (last - start) * 0.9).toISOString() : null, new Date(start + (sla[row.priority] ?? 48) * 3600000).toISOString(), created.id);
    } catch (e) { warn(`ticket "${t.subject}"`, e); }
  }
}

export function seedExtra() {
  onboardingPipeline();
  capabilityProposals();
  changeRequests();
  kycDocuments();
  tickets();
}
