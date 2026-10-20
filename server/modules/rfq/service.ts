/**
 * Module 2 — RFQ automation and vendor enquiry (PRD 7.2: FR-RFQ-01..12, WF-01, WF-03, WF-04, WF-05).
 * Buyer-side lifecycle: build from a PR basket (or an ARC opportunity), suggest vendors, publish,
 * track participation, remind, extend, cancel, re-float, close, reopen. Vendor quotation entry lives
 * in quotes.ts; the comparative statement (Module 4) reads locked `quotations`.
 */
import { all, get, insert, update, run, J, now, addDays, tx, scalar } from '../../core/db.ts';
import { audit, diff } from '../../core/audit.ts';
import { notify } from '../../core/notify.ts';
import { cfg } from '../../core/config.ts';
import { badRequest, conflict, forbidden, notFound, HttpError } from '../../core/http.ts';
import { createApproval, withdraw } from '../../core/approvals.ts';
import { sapWrite } from '../../core/sap.ts';
import { nextNo } from '../../core/numbering.ts';
import type { Actor } from '../../core/auth.ts';
import { basketCheck, validContract, getLine as getPrLine } from '../pr/service.ts';
import { suggestForLines, ineligibility, type Reason, type SuggestLine } from './suggest.ts';
import { lockQuotations, restoreLatest } from './quotes.ts';

// ------------------------------------------------------------------ types
export interface ReminderSchedule { before_days: number[]; after_days: number[]; sent?: string[] }
export interface Extension { from: string; to: string; reason: string; by: number; by_name: string; at: string; reopened_from_closed?: boolean }
export interface Rfq {
  id: number; rfq_no: string; title: string; buyer_id: number; status: string; category: string | null; plant: string | null;
  closing_at: string; delivery_terms: string | null; payment_terms: string | null; warranty: string | null; packing: string | null;
  documents_required: string | null; standard_terms: string | null; ship_to: string | null; sealed: number;
  reminder_schedule: ReminderSchedule | null; extensions: Extension[] | null; parent_rfq_id: number | null; cancel_reason: string | null;
  exception_approval_id: number | null; no_contract_snapshot: ContractSnapshot[] | null; created_at: string; published_at: string | null;
  closed_at: string | null; sap_rfq_ref: string | null; kind: string | null; opportunity_id: number | null; exception_reason: string | null;
}
export interface ContractSnapshot { rfq_line_no: number; pr_line_id: number | null; material_code: string | null; contract_no: string | null; contract_type: string | null; vendor: string | null; checked_at: string }
export interface RfqLine {
  id: number; rfq_id: number; line_no: number; pr_line_id: number | null; material_id: number | null; description: string; qty: number; uom: string;
  required_date: string | null; due_at: string | null; plant: string | null; ship_to: string | null; gst_rate: number | null; valuation_type: string | null;
  transport_req: string | null; specs: string | null; status: string; flag_reason: string | null; autofill: Autofill | null;
}
export interface Autofill { gst_rate: number | null; valuation_type: string | null; plant: string | null; ship_to: string | null; transport_req: string | null; source: string }
export interface Invitation {
  id: number; rfq_id: number; vendor_id: number; suggested: number; suggest_reasons: { score: number; lines: number[]; reasons: Reason[] } | null;
  added_justification: string | null; status: string; sent_at: string | null; delivery_status: string | null; viewed_at: string | null;
  responded_at: string | null; declined_at: string | null; decline_reason: string | null; reminders_sent: number; last_reminder_at: string | null;
}

export const DELIVERY_TERMS = ['FOR', 'Ex-Works'] as const;
export const GST_RATES = [0, 5, 12, 18, 28];
const EDITABLE = ['Draft'];
const LIVE = ['Published'];
/** RFQ states in which buyers must not see prices when sealed (FR-RFQ-12). */
const SEALED_STATES = ['Draft', 'Pending approval', 'Published'];
const CLOSED_STATES = ['Closed', 'Under comparison', 'Awarded'];

const TZ_FMT = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtIST = (ts: string | null | undefined) => (ts ? `${TZ_FMT.format(new Date(ts))} IST` : '—');
const rref = (r: Pick<Rfq, 'rfq_no'>) => r.rfq_no;

// ------------------------------------------------------------------ configuration (registered in init)
export const RFQ_CONFIG = [
  { key: 'rfq.non_suggested_vendor_approval', label: 'Non-suggested vendors need approval', group: 'RFQ', description: 'When on, inviting a vendor the rules did not suggest routes an exception approval before the invitation is sent (FR-RFQ-03). Justification is always required.', value: false, decision: 'Q 7.2' },
  { key: 'rfq.default_closing_days', label: 'Default RFQ closing period (days)', group: 'RFQ', description: 'Proposed closing period by priority when a buyer starts an RFQ. Urgent / BD / Class 1 RFQs close sooner (WF-04).', value: { Normal: 7, Urgent: 3, BD: 2, 'Class 1': 2 }, decision: 'DEC-15' },
  { key: 'rfq.default_terms', label: 'RFQ default terms', group: 'RFQ', description: 'Template text pre-filled on new RFQs; the buyer edits per RFQ (FR-RFQ-05).', value: {
    payment_terms: '45 days from GRN', warranty: '12 months from commissioning or 18 months from supply, whichever is earlier',
    packing: 'Seaworthy / road-worthy packing suitable for multi-modal transport; parts tagged with material code',
    documents_required: 'Signed quotation on letterhead; technical datasheet; warranty terms; test certificate (where applicable)',
    standard_terms: 'Equipcare standard purchase terms apply. Prices firm for the validity period, inclusive of packing; GST extra as applicable. Delivery to the ship-to address stated. Quote only through the vendor portal.',
  } },
  { key: 'rfq.subcategory_map', label: 'Material group to capability sub-category', group: 'RFQ', description: 'Used by vendor suggestions when the material master has no sub-category (FR-RFQ-02).', value: {
    'HYD-SEAL': ['Seal kits'], 'HYD-HOSE': ['Hoses & fittings'], 'HYD-REMAN': ['Reman pumps & motors'], 'UCG-TRK': ['Track components'], 'UCG-GET': ['Ground engaging tools', 'Bucket teeth'],
    'ENG-TURBO': ['Turbo & fuel system reman'], 'ENG-FUEL': ['Turbo & fuel system reman'], 'ENG-BRG': ['Bearings'], 'FLT-ELM': ['Filters'], 'LUB-OIL': ['Engine & hydraulic oils'], 'LUB-GRS': ['Greases'],
    'WLD-CON': ['Electrodes & wires'], 'TLS-HND': ['Torque & hand tools'], 'PPE-GEN': ['Safety footwear', 'Gloves & footwear'], 'ELE-GEN': ['Alternators & starters'], 'SRV-REP': ['Track chain repair', 'Machining'],
    'CAP-EQP': ['Mobile workshop fabrication'], 'LOG-TRN': ['Heavy haulage'],
  } },
  { key: 'rfq.plant_regions', label: 'Plant service regions', group: 'RFQ', description: 'Vendor capability regions that count as serving each plant (FR-RFQ-02 plant / location criterion).', value: { PUN1: ['West'], NGP1: ['Central', 'West'], DHN1: ['East'] } },
  { key: 'rfq.transport_requirements', label: 'Transport requirement by material group', group: 'RFQ', description: 'Pre-filled transport requirement on RFQ lines (FR-RFQ-06); the buyer can edit it per line.', value: {
    'UCG-TRK': 'Heavy item — closed truck with crane unloading at site', 'HYD-REMAN': 'Exchange unit — vendor collects the core on delivery', 'CAP-EQP': 'Low-bed trailer; vendor arranges permits',
    'LUB-OIL': 'Drums on pallets; spill kit in vehicle', 'LUB-GRS': 'Drums on pallets; spill kit in vehicle', default: 'Standard road transport to the ship-to address', service: 'Not applicable — service performed at site',
  } },
];

// ------------------------------------------------------------------ basic reads
export function getRfq(id: number) {
  return get<Rfq>('SELECT * FROM rfqs WHERE id = ?', id);
}
export function mustRfq(id: number) {
  const r = getRfq(id);
  if (!r) throw notFound('RFQ');
  return r;
}
export function linesOf(rfqId: number, includeRemoved = false) {
  return all<RfqLine>(`SELECT * FROM rfq_lines WHERE rfq_id = ? ${includeRemoved ? '' : "AND status != 'Removed'"} ORDER BY line_no`, rfqId);
}
export function invitationsOf(rfqId: number) {
  return all<Invitation & { vendor_name: string; sap_code: string | null; contact_email: string | null; contact_name: string | null; city: string | null }>(
    'SELECT i.*, v.name AS vendor_name, v.sap_code, v.contact_email, v.contact_name, v.city FROM rfq_invitations i JOIN vendors v ON v.id = i.vendor_id WHERE i.rfq_id = ? ORDER BY v.name',
    rfqId,
  );
}
export const isSealedNow = (r: Rfq) => !!r.sealed && SEALED_STATES.includes(r.status);
export const isClosedState = (r: Rfq) => CLOSED_STATES.includes(r.status);

function assertBuyer(actor: Actor, r: Rfq) {
  if (!actor.perms.has('rfq.manage')) throw forbidden('Only procurement buyers can change RFQs.');
  void r;
}
function assertState(r: Rfq, states: string[], what: string) {
  if (!states.includes(r.status)) throw conflict(`${what} is not possible while RFQ ${r.rfq_no} is ${r.status.toLowerCase()}.`);
}

function transportFor(m: { material_group: string | null; is_service: number } | undefined) {
  const map = cfg<Record<string, string>>('rfq.transport_requirements');
  if (!m) return map.default ?? null;
  if (m.is_service) return map.service ?? null;
  return (m.material_group && map[m.material_group]) || map.default || null;
}

function closingDefault(priorities: string[]) {
  const days = cfg<Record<string, number>>('rfq.default_closing_days');
  const d = Math.min(...priorities.map((p) => days[p] ?? days.Normal ?? 7), days.Normal ?? 7);
  const x = new Date(Date.now() + d * 86400000);
  x.setUTCHours(11, 30, 0, 0); // 17:00 IST
  return x.toISOString();
}

const PRIORITY_ORDER = ['BD', 'Class 1', 'Urgent', 'Normal'];
const topPriority = (ps: string[]) => PRIORITY_ORDER.find((p) => ps.includes(p)) ?? 'Normal';

// ------------------------------------------------------------------ preview & create (FR-RFQ-01, FR-RFQ-06)
interface DraftLine { pr_line_id: number | null; material_id: number | null; material_code: string | null; description: string; qty: number; uom: string; required_date: string | null; plant: string; priority: string; category: string | null; autofill: Autofill; contract: ContractSnapshot | null; pr_ref: string | null }

function draftLineFromPr(prLineId: number): DraftLine {
  const l = getPrLine(prLineId)!;
  const m = l.material_id ? get<{ id: number; code: string; gst_rate: number | null; valuation_type: string | null; material_group: string | null; is_service: number }>('SELECT id, code, gst_rate, valuation_type, material_group, is_service FROM materials WHERE id = ?', l.material_id) : undefined;
  const plant = get<{ ship_to_address: string | null }>('SELECT ship_to_address FROM plants WHERE code = ?', l.plant);
  const c = l.material_id ? validContract(l.material_id, l.plant) : undefined;
  return {
    pr_line_id: l.id, material_id: l.material_id, material_code: l.material_code, description: l.description, qty: l.qty, uom: l.uom,
    required_date: l.required_date, plant: l.plant, priority: l.priority, category: l.category, pr_ref: `${l.pr_no}/${l.item}`,
    autofill: { gst_rate: m?.gst_rate ?? null, valuation_type: m?.valuation_type ?? null, plant: l.plant, ship_to: plant?.ship_to_address ?? null, transport_req: transportFor(m), source: 'SAP material master (INT-M02) and plant master' },
    contract: c ? { rfq_line_no: 0, pr_line_id: l.id, material_code: l.material_code, contract_no: c.contract_no, contract_type: c.type, vendor: c.vendor, checked_at: now() } : null,
  };
}

export interface OpportunityPreview {
  id: number; material_id: number; material_code: string; description: string; uom: string; category: string | null; frequency: number | null;
  annual_value: number | null; vendor_count: number | null; status: string; rfq_id: number | null; annual_qty_estimate: number; qty_basis: string; plants: string[];
}
export function opportunityPreview(id: number): OpportunityPreview {
  const o = get<{ id: number; material_id: number; category: string | null; frequency: number | null; annual_value: number | null; vendor_count: number | null; status: string; rfq_id: number | null }>('SELECT * FROM opportunities WHERE id = ?', id);
  if (!o) throw notFound('ARC/OA opportunity');
  const m = get<{ code: string; description: string; uom: string; lpp: number | null; category: string | null }>('SELECT code, description, uom, lpp, category FROM materials WHERE id = ?', o.material_id);
  if (!m) throw notFound('Material for this opportunity');
  const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const hist = get<{ qty: number | null }>('SELECT SUM(pl.qty) AS qty FROM po_lines pl JOIN pos p ON p.id = pl.po_id WHERE pl.material_id = ? AND p.po_date >= ? AND pl.status != \'Cancelled\'', o.material_id, since)!;
  const plants = all<{ plant: string }>('SELECT DISTINCT p.plant FROM po_lines pl JOIN pos p ON p.id = pl.po_id WHERE pl.material_id = ? AND p.po_date >= ? ORDER BY p.plant', o.material_id, since).map((x) => x.plant);
  let qty = Math.round(hist.qty ?? 0);
  let basis = 'Quantity bought on POs in the last 12 months';
  if (!qty) {
    qty = m.lpp && o.annual_value ? Math.max(1, Math.round(o.annual_value / m.lpp)) : 1;
    basis = 'Annual value ÷ last purchase price';
  }
  return { id: o.id, material_id: o.material_id, material_code: m.code, description: m.description, uom: m.uom, category: o.category ?? m.category, frequency: o.frequency, annual_value: o.annual_value, vendor_count: o.vendor_count, status: o.status, rfq_id: o.rfq_id, annual_qty_estimate: qty, qty_basis: basis, plants };
}

function draftLineFromOpportunity(o: OpportunityPreview, plant: string, qty: number): DraftLine {
  const m = get<{ gst_rate: number | null; valuation_type: string | null; material_group: string | null; is_service: number }>('SELECT gst_rate, valuation_type, material_group, is_service FROM materials WHERE id = ?', o.material_id);
  const p = get<{ ship_to_address: string | null }>('SELECT ship_to_address FROM plants WHERE code = ?', plant);
  return {
    pr_line_id: null, material_id: o.material_id, material_code: o.material_code, description: o.description, qty, uom: o.uom, required_date: addDays(new Date(), 30).slice(0, 10),
    plant, priority: 'Normal', category: o.category, pr_ref: null,
    autofill: { gst_rate: m?.gst_rate ?? null, valuation_type: m?.valuation_type ?? null, plant, ship_to: p?.ship_to_address ?? null, transport_req: transportFor(m), source: 'SAP material master (INT-M02) and plant master' },
    contract: null,
  };
}

/** What the builder shows before the draft exists: basket check, auto-filled lines and vendor suggestions. */
export function preview(actor: Actor, input: { pr_line_ids?: number[]; opportunity_id?: number; plant?: string }) {
  if (input.opportunity_id) {
    const o = opportunityPreview(input.opportunity_id);
    const plant = input.plant ?? o.plants[0] ?? 'PUN1';
    const dl = draftLineFromOpportunity(o, plant, o.annual_qty_estimate);
    return { kind: 'ARC', ok: true, problems: [], opportunity: o, lines: [dl], closing_default: closingDefault(['Normal']), suggestions: suggestForDraft([dl]), plants: all('SELECT code, name, ship_to_address FROM plants ORDER BY code') };
  }
  const ids = input.pr_line_ids ?? [];
  if (!ids.length) throw badRequest('Choose at least one PR line for the RFQ.', { lines: 'No lines selected' });
  const chk = basketCheck(ids, actor.id);
  const lines = chk.lines.map((l) => draftLineFromPr(l.id));
  return { kind: 'Spot', ok: chk.ok, problems: chk.problems, opportunity: null, lines, closing_default: closingDefault(lines.map((l) => l.priority)), suggestions: suggestForDraft(lines), plants: all('SELECT code, name, ship_to_address FROM plants ORDER BY code') };
}

function suggestForDraft(lines: DraftLine[]) {
  const s = suggestForLines(lines.map((l, i) => {
    const m = l.material_id ? get<{ material_group: string | null; brand: string | null }>('SELECT material_group, brand FROM materials WHERE id = ?', l.material_id) : undefined;
    return { id: -(i + 1), line_no: (i + 1) * 10, material_id: l.material_id, category: l.category, material_group: m?.material_group ?? null, brand: m?.brand ?? null, plant: l.plant, description: l.description };
  }));
  return { vendors: s.vendors, excluded: s.excluded };
}

export interface CreateInput { pr_line_ids?: number[]; opportunity_id?: number; plant?: string; qty?: number; title?: string; closing_at?: string }

export function createRfq(actor: Actor, input: CreateInput) {
  if (!actor.perms.has('rfq.manage')) throw forbidden('Only procurement buyers can create RFQs.');
  let lines: DraftLine[];
  let kind = 'Spot';
  let opp: OpportunityPreview | null = null;
  if (input.opportunity_id) {
    opp = opportunityPreview(input.opportunity_id);
    if (opp.rfq_id) {
      const ex = getRfq(opp.rfq_id);
      if (ex && !['Cancelled', 'Re-floated'].includes(ex.status)) throw conflict(`Opportunity already has RFQ ${ex.rfq_no} (${ex.status.toLowerCase()}).`);
    }
    const plant = input.plant ?? opp.plants[0];
    if (!plant || !get('SELECT code FROM plants WHERE code = ?', plant)) throw badRequest('Choose the plant / ship-to for the annual-rate RFQ.', { plant: 'Plant is required' });
    const qty = input.qty ?? opp.annual_qty_estimate;
    if (!(qty > 0)) throw badRequest('Annual quantity estimate must be more than zero.', { qty: 'Enter the estimated annual quantity' });
    lines = [draftLineFromOpportunity(opp, plant, qty)];
    kind = 'ARC';
  } else {
    const ids = [...new Set(input.pr_line_ids ?? [])];
    if (!ids.length) throw badRequest('Choose at least one PR line for the RFQ.', { lines: 'No lines selected' });
    // FR-RFQ-01 / WF-05: basket rules from Module 1 (route, checks, open PO cover, active RFQ, grouping).
    const chk = basketCheck(ids, actor.id);
    if (!chk.ok) throw new HttpError(400, 'basket_invalid', `These lines cannot go into one RFQ: ${chk.problems.map((p) => `${p.ref} — ${p.problem}`).join('; ')}.`, Object.fromEntries(chk.problems.map((p, i) => [`lines.${p.ref === '—' ? i : p.ref}`, p.problem])));
    lines = chk.lines.map((l) => draftLineFromPr(l.id));
  }
  const terms = cfg<Record<string, string>>('rfq.default_terms');
  const closing = input.closing_at ?? closingDefault(lines.map((l) => l.priority));
  const plants = [...new Set(lines.map((l) => l.plant))];
  const cats = [...new Set(lines.map((l) => l.category).filter(Boolean))] as string[];
  const title = input.title?.trim() || (kind === 'ARC' ? `Annual rate contract — ${lines[0].description}` : lines.length === 1 ? lines[0].description : `${lines[0].description} and ${lines.length - 1} more`);
  return tx(() => {
    const ts = now();
    const rfqNo = nextNo('RFQ');
    const snapshot: ContractSnapshot[] = lines.map((l, i) => ({ rfq_line_no: (i + 1) * 10, pr_line_id: l.pr_line_id, material_code: l.material_code, contract_no: l.contract?.contract_no ?? null, contract_type: l.contract?.contract_type ?? null, vendor: l.contract?.vendor ?? null, checked_at: ts }));
    const id = insert('rfqs', {
      rfq_no: rfqNo, title: title.slice(0, 200), buyer_id: actor.id, status: 'Draft', category: cats[0] ?? null, plant: plants.length === 1 ? plants[0] : 'Multiple',
      closing_at: closing, delivery_terms: 'FOR', payment_terms: terms.payment_terms ?? null, warranty: terms.warranty ?? null, packing: terms.packing ?? null,
      documents_required: terms.documents_required ?? null, standard_terms: terms.standard_terms ?? null, ship_to: lines[0].autofill.ship_to,
      sealed: cfg<boolean>('rfq.sealed') ? 1 : 0, reminder_schedule_json: J(cfg('rfq.reminders')), extensions_json: J([]),
      no_contract_snapshot_json: J(snapshot), created_at: ts, kind, opportunity_id: opp?.id ?? null,
    });
    lines.forEach((l, i) => {
      insert('rfq_lines', {
        rfq_id: id, line_no: (i + 1) * 10, pr_line_id: l.pr_line_id, material_id: l.material_id, description: l.description, qty: l.qty, uom: l.uom,
        required_date: l.required_date, due_at: closing, plant: l.plant, ship_to: l.autofill.ship_to, gst_rate: l.autofill.gst_rate, valuation_type: l.autofill.valuation_type,
        transport_req: l.autofill.transport_req, specs: kind === 'ARC' ? `Annual rate contract: quote unit rates firm for 12 months. Estimated annual quantity ${l.qty} ${l.uom} — indicative, not a commitment.` : null,
        status: 'Active', autofill_json: J(l.autofill),
      });
      if (l.pr_line_id) {
        run("UPDATE pr_lines SET status = 'RFQ in progress', rfq_id = ? WHERE id = ?", id, l.pr_line_id);
        audit(actor, { action: 'pr.added_to_rfq', objectType: 'pr_line', objectId: l.pr_line_id, objectRef: l.pr_ref, before: { status: 'Route decided' }, after: { status: 'RFQ in progress', rfq: rfqNo } });
      }
    });
    if (opp) {
      run("UPDATE opportunities SET rfq_id = ?, status = CASE WHEN status IN ('Identified','Under review') THEN 'Accepted' ELSE status END, decided_by = COALESCE(decided_by, ?), decided_at = COALESCE(decided_at, ?), decision_reason = COALESCE(decision_reason, ?) WHERE id = ?", id, actor.id, ts, `Annual-rate RFQ ${rfqNo} created`, opp.id);
      audit(actor, { action: 'opportunity.sourcing_started', objectType: 'opportunity', objectId: opp.id, after: { rfq: rfqNo } });
    }
    const sugg = suggestForLines(linesOf(id).map(toSuggestLine));
    audit(actor, {
      action: 'rfq.created', objectType: 'rfq', objectId: id, objectRef: rfqNo,
      after: {
        kind, lines: lines.map((l, i) => ({ line: (i + 1) * 10, pr: l.pr_ref, material: l.material_code, qty: l.qty, autofill: l.autofill })),
        no_contract_at_creation: snapshot.every((s) => !s.contract_no), contracts_found: snapshot.filter((s) => s.contract_no).map((s) => s.contract_no),
        suggested_vendors: sugg.vendors.map((v) => ({ vendor: v.sap_code ?? v.name, score: v.score, lines: v.lines, reasons: v.reasons.map((r) => r.label) })),
        excluded_vendors: sugg.excluded.map((e) => ({ vendor: e.sap_code ?? e.name, reasons: e.reasons })),
      },
    });
    return getRfq(id)!;
  });
}

export function toSuggestLine(l: RfqLine): SuggestLine {
  const m = l.material_id ? get<{ category: string | null; material_group: string | null; brand: string | null }>('SELECT category, material_group, brand FROM materials WHERE id = ?', l.material_id) : undefined;
  const pr = l.pr_line_id ? get<{ category: string | null }>('SELECT category FROM pr_lines WHERE id = ?', l.pr_line_id) : undefined;
  return { id: l.id, line_no: l.line_no, material_id: l.material_id, category: pr?.category ?? m?.category ?? null, material_group: m?.material_group ?? null, brand: m?.brand ?? null, plant: l.plant ?? '', description: l.description };
}

export function suggestions(rfqId: number) {
  mustRfq(rfqId);
  const s = suggestForLines(linesOf(rfqId).filter((l) => l.status !== 'Removed').map(toSuggestLine));
  const invited = new Set(all<{ vendor_id: number }>('SELECT vendor_id FROM rfq_invitations WHERE rfq_id = ?', rfqId).map((x) => x.vendor_id));
  return { ...s, vendors: s.vendors.map((v) => ({ ...v, invited: invited.has(v.vendor_id) })) };
}

/** Vendor search for adding a non-suggested vendor (FR-RFQ-03). */
export function searchVendors(rfqId: number, q: string) {
  const r = mustRfq(rfqId);
  const sugg = new Set(suggestions(r.id).vendors.map((v) => v.vendor_id));
  const like = `%${q.trim()}%`;
  const rows = all<{ id: number; name: string; sap_code: string | null; city: string | null; state: string | null; onboarding_status: string; sap_blocked: number }>(
    'SELECT id, name, sap_code, city, state, onboarding_status, sap_blocked FROM vendors WHERE name LIKE ? OR sap_code LIKE ? OR city LIKE ? ORDER BY name LIMIT 25', like, like, like,
  );
  const invited = new Set(all<{ vendor_id: number }>('SELECT vendor_id FROM rfq_invitations WHERE rfq_id = ?', rfqId).map((x) => x.vendor_id));
  return rows.map((v) => {
    const caps = all<{ category: string; sub_category: string | null }>("SELECT category, sub_category FROM vendor_capabilities WHERE vendor_id = ? AND status = 'Approved'", v.id);
    return { ...v, suggested: sugg.has(v.id), invited: invited.has(v.id), ineligible: ineligibility(v.id), capabilities: caps.map((c) => `${c.category}${c.sub_category ? ` · ${c.sub_category}` : ''}`) };
  });
}

// ------------------------------------------------------------------ header & line edits (FR-RFQ-05, FR-RFQ-06, FR-RFQ-07)
export interface HeaderPatch { title?: string; closing_at?: string; delivery_terms?: string; payment_terms?: string | null; warranty?: string | null; packing?: string | null; documents_required?: string | null; standard_terms?: string | null; ship_to?: string | null }

export function updateHeader(actor: Actor, id: number, patch: HeaderPatch, reason?: string) {
  const r = mustRfq(id);
  assertBuyer(actor, r);
  assertState(r, EDITABLE, 'Editing the RFQ');
  if (patch.delivery_terms && !DELIVERY_TERMS.includes(patch.delivery_terms as never)) throw badRequest('Delivery terms must be FOR or Ex-Works.', { delivery_terms: 'Choose FOR or Ex-Works' });
  if (patch.closing_at) {
    const t = new Date(patch.closing_at);
    if (Number.isNaN(t.getTime())) throw badRequest('Closing date is not a valid date and time.', { closing_at: 'Enter a valid date and time' });
    if (t.getTime() <= Date.now()) throw badRequest('Closing date must be in the future.', { closing_at: 'Choose a future date and time' });
    patch.closing_at = t.toISOString();
  }
  const before: Record<string, unknown> = { ...r };
  const values: Record<string, unknown> = {};
  for (const k of ['title', 'closing_at', 'delivery_terms', 'payment_terms', 'warranty', 'packing', 'documents_required', 'standard_terms', 'ship_to'] as const) {
    if (patch[k] !== undefined) values[k] = typeof patch[k] === 'string' ? (patch[k] as string).trim() || null : patch[k];
  }
  if (values.title === null) throw badRequest('Give the RFQ a title.', { title: 'Title is required' });
  const d = diff(before, values);
  if (!Object.keys(d.after).length) return r;
  return tx(() => {
    update('rfqs', id, values);
    // Line due dates that followed the old closing date move with it.
    if (values.closing_at) run('UPDATE rfq_lines SET due_at = ? WHERE rfq_id = ? AND (due_at IS NULL OR due_at = ? OR due_at > ?)', values.closing_at, id, r.closing_at, values.closing_at);
    audit(actor, { action: 'rfq.updated', objectType: 'rfq', objectId: id, objectRef: rref(r), before: d.before, after: d.after, reason: reason ?? null });
    return getRfq(id)!;
  });
}

export interface LinePatch { description?: string; qty?: number; required_date?: string | null; due_at?: string | null; plant?: string; ship_to?: string | null; gst_rate?: number | null; valuation_type?: string | null; transport_req?: string | null; specs?: string | null }

export function updateLine(actor: Actor, rfqId: number, lineId: number, patch: LinePatch, reason?: string) {
  const r = mustRfq(rfqId);
  assertBuyer(actor, r);
  assertState(r, EDITABLE, 'Editing RFQ lines');
  const l = get<RfqLine>('SELECT * FROM rfq_lines WHERE id = ? AND rfq_id = ?', lineId, rfqId);
  if (!l || l.status === 'Removed') throw notFound('RFQ line');
  const values: Record<string, unknown> = {};
  if (patch.description !== undefined) {
    if (!patch.description.trim()) throw badRequest(`Line ${l.line_no}: description is required.`, { description: 'Description is required' });
    values.description = patch.description.trim();
  }
  if (patch.qty !== undefined) {
    if (!(patch.qty > 0)) throw badRequest(`Line ${l.line_no}: quantity must be more than zero.`, { qty: 'Enter a quantity above zero' });
    if (l.pr_line_id) {
      const pr = getPrLine(l.pr_line_id);
      if (pr && patch.qty > pr.qty) throw badRequest(`Line ${l.line_no}: quantity cannot exceed the PR quantity (${pr.qty} ${pr.uom}).`, { qty: `At most ${pr.qty}` });
    }
    values.qty = patch.qty;
  }
  if (patch.gst_rate !== undefined && patch.gst_rate !== null && !GST_RATES.includes(patch.gst_rate)) throw badRequest(`Line ${l.line_no}: GST rate must be one of ${GST_RATES.join(', ')}%.`, { gst_rate: 'Choose an allowed GST rate' });
  if (patch.plant !== undefined) {
    const p = get<{ ship_to_address: string | null }>('SELECT ship_to_address FROM plants WHERE code = ?', patch.plant);
    if (!p) throw badRequest(`Line ${l.line_no}: unknown plant ${patch.plant}.`, { plant: 'Choose a plant' });
    values.plant = patch.plant;
    if (patch.ship_to === undefined && patch.plant !== l.plant) values.ship_to = p.ship_to_address;
  }
  if (patch.due_at) {
    const t = new Date(patch.due_at);
    if (Number.isNaN(t.getTime())) throw badRequest(`Line ${l.line_no}: quote due date is not valid.`, { due_at: 'Enter a valid date' });
    if (t.getTime() > new Date(r.closing_at).getTime()) throw badRequest(`Line ${l.line_no}: quote due date cannot be after the RFQ closing date (${fmtIST(r.closing_at)}).`, { due_at: 'On or before the closing date' });
    values.due_at = t.toISOString();
  }
  for (const k of ['required_date', 'ship_to', 'gst_rate', 'valuation_type', 'transport_req', 'specs'] as const) {
    if (patch[k] !== undefined) values[k] = typeof patch[k] === 'string' ? (patch[k] as string).trim() || null : patch[k];
  }
  const d = diff(l as unknown as Record<string, unknown>, values);
  if (!Object.keys(d.after).length) return l;
  // FR-RFQ-06: record when a buyer overrides a value auto-filled from master data.
  const overridden = Object.keys(d.after).filter((k) => l.autofill && k in l.autofill && (l.autofill as unknown as Record<string, unknown>)[k] !== d.after[k]);
  update('rfq_lines', lineId, values);
  audit(actor, { action: overridden.length ? 'rfq.line_autofill_overridden' : 'rfq.line_updated', objectType: 'rfq', objectId: rfqId, objectRef: `${rref(r)}/${l.line_no}`, before: d.before, after: { ...d.after, ...(overridden.length ? { overrides_master_data: overridden } : {}) }, reason: reason ?? null });
  return get<RfqLine>('SELECT * FROM rfq_lines WHERE id = ?', lineId)!;
}

function releasePrLine(actor: Actor | null, prLineId: number | null, r: Rfq, why: string) {
  if (!prLineId) return;
  const pr = getPrLine(prLineId);
  if (!pr || pr.rfq_id !== r.id) return;
  const status = pr.status === 'RFQ in progress' ? 'Route decided' : pr.status;
  run('UPDATE pr_lines SET status = ?, rfq_id = NULL WHERE id = ?', status, prLineId);
  audit(actor, { action: 'pr.released_from_rfq', objectType: 'pr_line', objectId: prLineId, objectRef: `${pr.pr_no}/${pr.item}`, before: { status: pr.status, rfq: r.rfq_no }, after: { status }, reason: why });
}

export function removeLine(actor: Actor, rfqId: number, lineId: number, reason?: string) {
  const r = mustRfq(rfqId);
  assertBuyer(actor, r);
  assertState(r, EDITABLE, 'Removing lines');
  const l = get<RfqLine>('SELECT * FROM rfq_lines WHERE id = ? AND rfq_id = ?', lineId, rfqId);
  if (!l || l.status === 'Removed') throw notFound('RFQ line');
  return tx(() => {
    run('DELETE FROM rfq_lines WHERE id = ?', lineId);
    releasePrLine(actor, l.pr_line_id, r, reason ?? `Removed from draft ${r.rfq_no}`);
    audit(actor, { action: 'rfq.line_removed', objectType: 'rfq', objectId: rfqId, objectRef: `${rref(r)}/${l.line_no}`, before: { line: l.line_no, description: l.description, pr_line_id: l.pr_line_id }, reason: reason ?? null });
    return { ok: true };
  });
}

export function addLines(actor: Actor, rfqId: number, prLineIds: number[]) {
  const r = mustRfq(rfqId);
  assertBuyer(actor, r);
  assertState(r, EDITABLE, 'Adding lines');
  if (r.kind === 'ARC') throw conflict('Annual-rate RFQs carry the opportunity material only.');
  const chk = basketCheck(prLineIds, actor.id);
  if (!chk.ok) throw new HttpError(400, 'basket_invalid', `These lines cannot be added: ${chk.problems.map((p) => `${p.ref} — ${p.problem}`).join('; ')}.`);
  return tx(() => {
    let lineNo = scalar<number>('SELECT MAX(line_no) FROM rfq_lines WHERE rfq_id = ?', rfqId) ?? 0;
    const snap = r.no_contract_snapshot ?? [];
    for (const pl of chk.lines) {
      const dl = draftLineFromPr(pl.id);
      lineNo += 10;
      insert('rfq_lines', {
        rfq_id: rfqId, line_no: lineNo, pr_line_id: dl.pr_line_id, material_id: dl.material_id, description: dl.description, qty: dl.qty, uom: dl.uom,
        required_date: dl.required_date, due_at: r.closing_at, plant: dl.plant, ship_to: dl.autofill.ship_to, gst_rate: dl.autofill.gst_rate, valuation_type: dl.autofill.valuation_type,
        transport_req: dl.autofill.transport_req, status: 'Active', autofill_json: J(dl.autofill),
      });
      snap.push({ rfq_line_no: lineNo, pr_line_id: dl.pr_line_id, material_code: dl.material_code, contract_no: dl.contract?.contract_no ?? null, contract_type: dl.contract?.contract_type ?? null, vendor: dl.contract?.vendor ?? null, checked_at: now() });
      run("UPDATE pr_lines SET status = 'RFQ in progress', rfq_id = ? WHERE id = ?", rfqId, pl.id);
      audit(actor, { action: 'pr.added_to_rfq', objectType: 'pr_line', objectId: pl.id, objectRef: dl.pr_ref, after: { status: 'RFQ in progress', rfq: r.rfq_no } });
      audit(actor, { action: 'rfq.line_added', objectType: 'rfq', objectId: rfqId, objectRef: `${rref(r)}/${lineNo}`, after: { pr: dl.pr_ref, material: dl.material_code, qty: dl.qty, autofill: dl.autofill } });
    }
    const plants = new Set(linesOf(rfqId).map((l) => l.plant));
    update('rfqs', rfqId, { no_contract_snapshot_json: J(snap), plant: plants.size === 1 ? [...plants][0] : 'Multiple' });
    return linesOf(rfqId);
  });
}

/** PR line cancelled in SAP while in an RFQ (PRD 7.2 exception): remove the line or keep it with a reason. */
export function resolveFlag(actor: Actor, rfqId: number, lineId: number, action: 'remove' | 'keep', reason: string) {
  const r = mustRfq(rfqId);
  assertBuyer(actor, r);
  const l = get<RfqLine>('SELECT * FROM rfq_lines WHERE id = ? AND rfq_id = ?', lineId, rfqId);
  if (!l) throw notFound('RFQ line');
  if (l.status !== 'Flagged') throw conflict(`Line ${l.line_no} is not flagged.`);
  return tx(() => {
    const pr = l.pr_line_id ? getPrLine(l.pr_line_id) : undefined;
    if (action === 'remove') {
      update('rfq_lines', lineId, { status: 'Removed', flag_reason: `${l.flag_reason ?? 'Flagged'} — removed: ${reason}` });
      if (pr) {
        run("UPDATE pr_lines SET status = 'Cancelled in SAP', flag = NULL, rfq_id = NULL WHERE id = ?", pr.id);
        audit(actor, { action: 'pr.removed_from_rfq_cancelled_in_sap', objectType: 'pr_line', objectId: pr.id, objectRef: `${pr.pr_no}/${pr.item}`, before: { status: pr.status }, after: { status: 'Cancelled in SAP' }, reason });
      }
      if (LIVE.includes(r.status)) {
        for (const inv of invitationsOf(rfqId).filter((i) => i.sent_at)) {
          notify({ event: 'NTF-06', title: `RFQ ${r.rfq_no}: line ${l.line_no} withdrawn`, body: `${l.description} is no longer required. Do not quote this line.`, link: `/vendor/rfqs/${rfqId}`, vendorId: inv.vendor_id, objectType: 'rfq', objectId: rfqId, dedupeKey: `NTF-06:line:${lineId}:${inv.vendor_id}` });
        }
      }
    } else {
      update('rfq_lines', lineId, { status: 'Active', flag_reason: `${l.flag_reason ?? 'Flagged'} — kept: ${reason}` });
      if (pr) run('UPDATE pr_lines SET flag = NULL WHERE id = ?', pr.id);
    }
    audit(actor, { action: action === 'remove' ? 'rfq.flagged_line_removed' : 'rfq.flagged_line_kept', objectType: 'rfq', objectId: rfqId, objectRef: `${rref(r)}/${l.line_no}`, before: { status: 'Flagged', flag: l.flag_reason }, after: { status: action === 'remove' ? 'Removed' : 'Active' }, reason });
    return get<RfqLine>('SELECT * FROM rfq_lines WHERE id = ?', lineId)!;
  });
}

// ------------------------------------------------------------------ invitations (FR-RFQ-02, FR-RFQ-03, FR-RFQ-04)
export function addInvitation(actor: Actor, rfqId: number, vendorId: number, justification?: string | null) {
  const r = mustRfq(rfqId);
  assertBuyer(actor, r);
  assertState(r, [...EDITABLE, ...LIVE], 'Inviting vendors');
  const v = get<{ id: number; name: string; sap_code: string | null }>('SELECT id, name, sap_code FROM vendors WHERE id = ?', vendorId);
  if (!v) throw notFound('Vendor');
  if (get('SELECT id FROM rfq_invitations WHERE rfq_id = ? AND vendor_id = ?', rfqId, vendorId)) throw conflict(`${v.name} is already on this RFQ.`);
  const bad = ineligibility(vendorId);
  if (bad.length) throw badRequest(`${v.name} cannot be invited: ${bad.join('; ')}.`, { vendor_id: bad[0] });
  const sugg = suggestions(rfqId).vendors.find((x) => x.vendor_id === vendorId);
  const just = justification?.trim() || null;
  if (just && just.length < 10) throw badRequest('Justification must be at least 10 characters.', { justification: 'At least 10 characters' });
  const live = LIVE.includes(r.status);
  if (!sugg && live && !just) throw badRequest(`${v.name} was not suggested by the rules. Give a justification to add the vendor.`, { justification: 'Justification is required for a non-suggested vendor' });
  return tx(() => {
    const id = insert('rfq_invitations', {
      rfq_id: rfqId, vendor_id: vendorId, suggested: sugg ? 1 : 0, suggest_reasons_json: sugg ? J({ score: sugg.score, lines: sugg.lines, reasons: sugg.reasons }) : null,
      added_justification: sugg ? null : just, status: 'Invited',
    });
    audit(actor, { action: sugg ? 'rfq.vendor_invited' : 'rfq.vendor_added_non_suggested', objectType: 'rfq', objectId: rfqId, objectRef: rref(r), after: { vendor: v.sap_code ?? v.name, suggested: !!sugg, score: sugg?.score ?? null, reasons: sugg?.reasons.map((x) => x.label) ?? null }, reason: just });
    if (live) {
      if (!sugg && cfg<boolean>('rfq.non_suggested_vendor_approval')) {
        const ap = createApproval(actor, { type: 'exc.new_vendor', objectType: 'rfq', objectId: rfqId, title: `Add non-suggested vendor ${v.name} to ${r.rfq_no}`, summary: `${r.title} · ${v.name}`, value: estValue(rfqId), reason: just ?? undefined, context: { rfq_no: r.rfq_no, vendors: [v.name], late_addition: true }, plant: r.plant, categoryCode: r.category });
        audit(actor, { action: 'rfq.vendor_pending_approval', objectType: 'rfq', objectId: rfqId, objectRef: rref(r), after: { vendor: v.name, approval: ap.req_no } });
      } else sendInvitation(actor, getRfq(rfqId)!, id);
    }
    return get<Invitation>('SELECT * FROM rfq_invitations WHERE id = ?', id)!;
  });
}

export function updateJustification(actor: Actor, rfqId: number, invId: number, justification: string) {
  const r = mustRfq(rfqId);
  assertBuyer(actor, r);
  assertState(r, EDITABLE, 'Changing the justification');
  const inv = get<Invitation>('SELECT * FROM rfq_invitations WHERE id = ? AND rfq_id = ?', invId, rfqId);
  if (!inv) throw notFound('Invitation');
  if (inv.suggested) throw conflict('Suggested vendors do not need a justification.');
  update('rfq_invitations', invId, { added_justification: justification });
  audit(actor, { action: 'rfq.vendor_justification', objectType: 'rfq', objectId: rfqId, objectRef: rref(r), before: { justification: inv.added_justification }, after: { vendor_id: inv.vendor_id, justification } });
  return get<Invitation>('SELECT * FROM rfq_invitations WHERE id = ?', invId)!;
}

export function removeInvitation(actor: Actor, rfqId: number, invId: number, reason?: string) {
  const r = mustRfq(rfqId);
  assertBuyer(actor, r);
  assertState(r, EDITABLE, 'Removing vendors');
  const inv = get<Invitation & { name: string }>('SELECT i.*, v.name FROM rfq_invitations i JOIN vendors v ON v.id = i.vendor_id WHERE i.id = ? AND i.rfq_id = ?', invId, rfqId);
  if (!inv) throw notFound('Invitation');
  run('DELETE FROM rfq_invitations WHERE id = ?', invId);
  audit(actor, { action: 'rfq.vendor_removed', objectType: 'rfq', objectId: rfqId, objectRef: rref(r), before: { vendor: inv.name, suggested: !!inv.suggested }, reason: reason ?? null });
  return { ok: true };
}

/** Send one invitation: in-app to vendor users, e-mail to the vendor contact (simulated outbox), record delivery. */
export function sendInvitation(actor: Actor | null, r: Rfq, invId: number, resend = false) {
  const inv = get<Invitation>('SELECT * FROM rfq_invitations WHERE id = ?', invId)!;
  const v = get<{ id: number; name: string; contact_email: string | null; sap_code: string | null }>('SELECT id, name, contact_email, sap_code FROM vendors WHERE id = ?', inv.vendor_id)!;
  const ts = now();
  const lines = linesOf(r.id).filter((l) => l.status !== 'Removed').length;
  const title = `Invitation to quote: RFQ ${r.rfq_no}`;
  const body = `${r.title} · ${lines} line${lines === 1 ? '' : 's'} · closes ${fmtIST(r.closing_at)}. Quote on the Equipcare vendor portal.`;
  notify({ event: 'NTF-04', title, body, link: `/vendor/rfqs/${r.id}`, vendorId: v.id, objectType: 'rfq', objectId: r.id, dedupeKey: `NTF-04:${r.id}:${v.id}${resend ? `:${ts}` : ''}`, mandatory: true });
  const channels = cfg<{ email: boolean }>('notify.channels');
  const email = v.contact_email?.trim();
  let status: string;
  if (!email) status = 'Delivery failed';
  else if (!channels.email) status = 'In-app only (e-mail channel off)';
  else {
    const userEmails = all<{ email: string }>('SELECT email FROM users WHERE vendor_id = ? AND active = 1', v.id).map((u) => u.email.toLowerCase());
    if (!userEmails.includes(email.toLowerCase())) {
      insert('outbox', { channel: 'email', recipient: email, subject: title, body, template: 'NTF-04.v1', status: 'Simulated — not sent (no e-mail provider connected)', created_at: ts });
    }
    status = 'Simulated e-mail recorded';
  }
  update('rfq_invitations', invId, { sent_at: ts, delivery_status: status });
  if (status === 'Delivery failed') {
    notify({ event: 'NTF-04', title: `Invitation for ${r.rfq_no} not delivered to ${v.name}`, body: 'The vendor record has no contact e-mail. Add a contact in the vendor master or call the vendor, then resend.', link: `/rfqs/${r.id}`, users: [r.buyer_id], objectType: 'rfq', objectId: r.id, severity: 'danger', dedupeKey: `NTF-04f:${r.id}:${v.id}:${ts}` });
  }
  if (resend) audit(actor, { action: 'rfq.invitation_resent', objectType: 'rfq', objectId: r.id, objectRef: r.rfq_no, after: { vendor: v.sap_code ?? v.name, sent_at: ts, delivery_status: status, recipient: email ?? null } });
  return { vendor: v.sap_code ?? v.name, vendor_name: v.name, sent_at: ts, delivery_status: status, recipient: email ?? null };
}

export function resendInvitation(actor: Actor, rfqId: number, invId: number) {
  const r = mustRfq(rfqId);
  assertBuyer(actor, r);
  assertState(r, LIVE, 'Resending an invitation');
  const inv = get<Invitation>('SELECT * FROM rfq_invitations WHERE id = ? AND rfq_id = ?', invId, rfqId);
  if (!inv || !inv.sent_at) throw notFound('Invitation');
  return sendInvitation(actor, r, invId, true);
}

// ------------------------------------------------------------------ publish (FR-RFQ-04, FR-RFQ-11, rules 7.2)
function estValue(rfqId: number) {
  return Math.round(all<{ qty: number; price: number | null }>(
    'SELECT l.qty, COALESCE(p.est_unit_price, m.lpp, 0) AS price FROM rfq_lines l LEFT JOIN pr_lines p ON p.id = l.pr_line_id LEFT JOIN materials m ON m.id = l.material_id WHERE l.rfq_id = ? AND l.status != \'Removed\'', rfqId,
  ).reduce((s, x) => s + x.qty * (x.price ?? 0), 0));
}
export function minVendors(rfqId: number) {
  const cats = [...new Set(linesOf(rfqId).map((l) => toSuggestLine(l).category).filter(Boolean))] as string[];
  if (!cats.length) return { min: 3, categories: [] as { code: string; name: string; min_vendors: number }[] };
  const rows = all<{ code: string; name: string; min_vendors: number }>(`SELECT code, name, min_vendors FROM spend_categories WHERE code IN (${cats.map(() => '?').join(',')})`, ...cats);
  return { min: Math.max(1, ...rows.map((x) => x.min_vendors ?? 3)), categories: rows };
}
function prPriorities(rfqId: number) {
  return all<{ priority: string }>('SELECT p.priority FROM rfq_lines l JOIN pr_lines p ON p.id = l.pr_line_id WHERE l.rfq_id = ?', rfqId).map((x) => x.priority);
}

/** Publish checks (rules 7.2): returns problems keyed by field so the UI can name each one. */
export function publishProblems(r: Rfq) {
  const fields: Record<string, string> = {};
  const lines = linesOf(r.id).filter((l) => l.status !== 'Removed');
  const invs = invitationsOf(r.id);
  if (!lines.length) fields.lines = 'Add at least one line';
  if (!invs.length) fields.vendors = 'Invite at least one vendor';
  if (!r.closing_at || new Date(r.closing_at).getTime() <= Date.now()) fields.closing_at = 'Closing date must be in the future';
  const hdr: [keyof Rfq, string][] = [['title', 'Title'], ['delivery_terms', 'Delivery terms'], ['warranty', 'Warranty'], ['packing', 'Packing'], ['documents_required', 'Documents required'], ['standard_terms', 'Standard terms']];
  for (const [k, label] of hdr) if (!r[k] || !String(r[k]).trim()) fields[k as string] = `${label} is required`;
  for (const l of lines) {
    const need: [keyof RfqLine, string][] = [['description', 'description'], ['required_date', 'required date'], ['plant', 'plant'], ['ship_to', 'shipping location (ship-to)']];
    for (const [k, label] of need) if (!l[k] || !String(l[k]).trim()) fields[`lines.${l.line_no}.${String(k)}`] = `Line ${l.line_no}: ${label} is required`;
    if (!(l.qty > 0)) fields[`lines.${l.line_no}.qty`] = `Line ${l.line_no}: quantity must be more than zero`;
    if (l.due_at && new Date(l.due_at).getTime() <= Date.now()) fields[`lines.${l.line_no}.due_at`] = `Line ${l.line_no}: quote due date must be in the future`;
    if (l.due_at && r.closing_at && new Date(l.due_at).getTime() > new Date(r.closing_at).getTime()) fields[`lines.${l.line_no}.due_at`] = `Line ${l.line_no}: quote due date is after the closing date`;
    if (l.status === 'Flagged') fields[`lines.${l.line_no}.flag`] = `Line ${l.line_no} is flagged (${l.flag_reason}); remove it or keep it with a reason`;
  }
  for (const i of invs) {
    if (!i.suggested && !(i.added_justification && i.added_justification.trim().length >= 10)) fields[`vendors.${i.vendor_id}.justification`] = `${i.vendor_name} was not suggested — add a justification`;
    const bad = ineligibility(i.vendor_id);
    if (bad.length) fields[`vendors.${i.vendor_id}.eligibility`] = `${i.vendor_name}: ${bad.join('; ')}`;
  }
  return fields;
}

export function publish(actor: Actor, id: number, input: { exception_reason?: string | null } = {}) {
  const r = mustRfq(id);
  assertBuyer(actor, r);
  assertState(r, EDITABLE, 'Publishing');
  const fields = publishProblems(r);
  if (Object.keys(fields).length) {
    const list = Object.values(fields);
    throw new HttpError(400, 'publish_blocked', `RFQ ${r.rfq_no} cannot be published yet: ${list.join('; ')}.`, fields);
  }
  const invs = invitationsOf(id);
  const mv = minVendors(id);
  const below = invs.length < mv.min;
  const reason = input.exception_reason?.trim() || null;
  const nonSuggested = invs.filter((i) => !i.suggested);
  const needVendorApproval = nonSuggested.length > 0 && cfg<boolean>('rfq.non_suggested_vendor_approval');
  if (below && (!reason || reason.length < 10)) {
    throw new HttpError(400, 'exception_justification_required', `${mv.categories.map((c) => c.name).join(' / ') || 'This category'} needs at least ${mv.min} vendors; ${invs.length} invited. Invite more vendors, or give a justification (10+ characters) to send a limited-source exception for approval (FR-RFQ-11).`, { exception_reason: `At least ${mv.min} vendors required — justification needed` });
  }
  return tx(() => {
    const approvals: string[] = [];
    const urgency = topPriority(prPriorities(id));
    if (below) {
      const ap = createApproval(actor, {
        type: 'exc.single_source', objectType: 'rfq', objectId: id, title: `${invs.length === 1 ? 'Single' : 'Limited'}-source RFQ ${r.rfq_no}`,
        summary: `${r.title}: ${invs.length} of ${mv.min} required vendors (${invs.map((i) => i.vendor_name).join(', ')})`, value: estValue(id), reason: reason!,
        context: { rfq_no: r.rfq_no, invited: invs.length, required: mv.min, vendors: invs.map((i) => i.vendor_name), category: r.category }, urgency, plant: r.plant === 'Multiple' ? null : r.plant, categoryCode: r.category,
      });
      update('rfqs', id, { exception_approval_id: ap.id, exception_reason: reason });
      approvals.push(ap.req_no);
    }
    if (needVendorApproval) {
      const ap = createApproval(actor, {
        type: 'exc.new_vendor', objectType: 'rfq', objectId: id, title: `Non-suggested vendor${nonSuggested.length > 1 ? 's' : ''} on ${r.rfq_no}`,
        summary: nonSuggested.map((i) => `${i.vendor_name}: ${i.added_justification}`).join(' · '), value: estValue(id), reason: nonSuggested.map((i) => i.added_justification).join(' | '),
        context: { rfq_no: r.rfq_no, vendors: nonSuggested.map((i) => i.vendor_name) }, urgency, plant: r.plant === 'Multiple' ? null : r.plant, categoryCode: r.category,
      });
      approvals.push(ap.req_no);
    }
    if (approvals.length) {
      update('rfqs', id, { status: 'Pending approval' });
      audit(actor, { action: 'rfq.submitted_for_approval', objectType: 'rfq', objectId: id, objectRef: rref(r), before: { status: 'Draft' }, after: { status: 'Pending approval', approvals, invited: invs.length, required: mv.min }, reason });
      return { ...getRfq(id)!, approvals };
    }
    return { ...publishNow(actor, id), approvals };
  });
}

/** Make the RFQ live: invitations, NTF-04, delivery outcome, INT-M05 reference (DEC-04). */
export function publishNow(actor: Actor | null, id: number) {
  const r = mustRfq(id);
  const ts = now();
  update('rfqs', id, { status: 'Published', published_at: ts, reminder_schedule_json: J({ ...cfg<ReminderSchedule>('rfq.reminders'), sent: [] }) });
  const fresh = getRfq(id)!;
  const sent = invitationsOf(id).filter((i) => !i.sent_at).map((i) => sendInvitation(actor, fresh, i.id));
  let sap: { enabled: boolean; status: string; message: string; key?: string } = { enabled: false, status: 'Reference only', message: 'RFQ is executed in the platform; SAP holds no RFQ document until DEC-04 is decided.' };
  if (cfg<boolean>('sap.write.rfq')) {
    const key = `RFQREF:${r.rfq_no}`;
    const lines = linesOf(id);
    const res = sapWrite('INT-M05', 'RFQREF', key, {
      rfq_no: r.rfq_no, title: r.title, closing_at: r.closing_at, published_at: ts,
      items: lines.map((l) => { const pr = l.pr_line_id ? getPrLine(l.pr_line_id) : undefined; return { line: l.line_no, pr_no: pr?.pr_no ?? null, pr_item: pr?.item ?? null, material_id: l.material_id, qty: l.qty }; }),
      vendors: sent.map((s) => s.vendor),
    }, actor);
    sap = { enabled: true, status: res.status, message: res.message, key };
    update('rfqs', id, { sap_rfq_ref: res.status === 'Written' || res.status === 'Duplicate' ? res.sapKey ?? key : null });
  }
  audit(actor, { action: 'rfq.published', objectType: 'rfq', objectId: id, objectRef: rref(r), before: { status: r.status }, after: { status: 'Published', published_at: ts, closing_at: r.closing_at, invitations: sent, sap_int_m05: sap } });
  return getRfq(id)!;
}

/** Approval outcome for limited-source / non-suggested vendor exceptions. */
export function onExceptionDecision(rfqId: number, approvalId: number, outcome: string, actor: Actor | null, comment: string | null) {
  const r = getRfq(rfqId);
  if (!r) return;
  if (r.status === 'Pending approval') {
    if (outcome === 'Approved') {
      const pending = scalar<number>("SELECT COUNT(*) FROM approvals WHERE object_type = 'rfq' AND object_id = ? AND status IN ('Pending','Clarification requested') AND id != ?", rfqId, approvalId) ?? 0;
      if (pending) return;
      if (new Date(r.closing_at).getTime() <= Date.now()) {
        update('rfqs', rfqId, { status: 'Draft' });
        audit(actor, { action: 'rfq.approval_too_late', objectType: 'rfq', objectId: rfqId, objectRef: r.rfq_no, after: { status: 'Draft' }, reason: 'Closing date passed while the exception was waiting for approval' });
        notify({ event: 'NTF-12', title: `${r.rfq_no} approved after its closing date`, body: 'Set a new closing date and publish again.', link: `/rfqs/${rfqId}`, users: [r.buyer_id], objectType: 'rfq', objectId: rfqId, severity: 'warning', dedupeKey: `rfq-late:${rfqId}:${now()}` });
        return;
      }
      publishNow(actor, rfqId);
      notify({ event: 'NTF-12', title: `${r.rfq_no} approved and published`, body: `Invitations sent. Closes ${fmtIST(r.closing_at)}.`, link: `/rfqs/${rfqId}`, users: [r.buyer_id], objectType: 'rfq', objectId: rfqId, severity: 'success', dedupeKey: `rfq-pub:${rfqId}` });
    } else {
      // Any rejection, return or withdrawal sends the RFQ back to the buyer; sibling requests are withdrawn.
      for (const o of all<{ id: number; req_no: string }>("SELECT id, req_no FROM approvals WHERE object_type = 'rfq' AND object_id = ? AND status IN ('Pending','Clarification requested') AND id != ?", rfqId, approvalId)) {
        run("UPDATE approvals SET status = 'Withdrawn', decided_at = ?, outcome = ? WHERE id = ?", now(), `Withdrawn: related request ${outcome.toLowerCase()}`, o.id);
        run("UPDATE approval_steps SET status = 'Skipped' WHERE approval_id = ? AND status IN ('Pending','Waiting')", o.id);
        audit(actor, { action: 'approval.withdrawn', objectType: 'approval', objectId: o.id, objectRef: o.req_no, reason: `Related RFQ exception ${outcome.toLowerCase()}` });
      }
      update('rfqs', rfqId, { status: 'Draft' });
      audit(actor, { action: `rfq.exception_${outcome.toLowerCase()}`, objectType: 'rfq', objectId: rfqId, objectRef: r.rfq_no, before: { status: 'Pending approval' }, after: { status: 'Draft' }, reason: comment });
    }
  } else if (LIVE.includes(r.status) && outcome === 'Approved') {
    // Late addition of a non-suggested vendor to a live RFQ: send the waiting invitations.
    for (const inv of all<{ id: number }>('SELECT id FROM rfq_invitations WHERE rfq_id = ? AND sent_at IS NULL', rfqId)) sendInvitation(actor, r, inv.id);
  } else if (LIVE.includes(r.status)) {
    for (const inv of all<{ id: number; vendor_id: number }>('SELECT id, vendor_id FROM rfq_invitations WHERE rfq_id = ? AND sent_at IS NULL', rfqId)) {
      run('DELETE FROM rfq_invitations WHERE id = ?', inv.id);
      audit(actor, { action: 'rfq.vendor_addition_rejected', objectType: 'rfq', objectId: rfqId, objectRef: r.rfq_no, after: { vendor_id: inv.vendor_id }, reason: comment });
    }
  }
}

// ------------------------------------------------------------------ lifecycle (FR-RFQ-07, FR-RFQ-08, FR-RFQ-09)
const nonResponders = (rfqId: number) =>
  all<Invitation & { vendor_name: string }>("SELECT i.*, v.name AS vendor_name FROM rfq_invitations i JOIN vendors v ON v.id = i.vendor_id WHERE i.rfq_id = ? AND i.sent_at IS NOT NULL AND i.status IN ('Invited','Viewed')", rfqId);

function remindVendors(actor: Actor | null, r: Rfq, key: string, message?: string | null) {
  const list = nonResponders(r.id);
  const ts = now();
  const hours = Math.max(0, Math.round((new Date(r.closing_at).getTime() - Date.now()) / 3600000));
  for (const i of list) {
    notify({ event: 'NTF-05', title: `Reminder: RFQ ${r.rfq_no} closes ${hours < 48 ? `in ${hours} h` : fmtIST(r.closing_at)}`, body: message?.trim() || `${r.title}. Submit your quotation or decline with a reason before ${fmtIST(r.closing_at)}.`, link: `/vendor/rfqs/${r.id}`, vendorId: i.vendor_id, objectType: 'rfq', objectId: r.id, dedupeKey: `NTF-05:${r.id}:${i.vendor_id}:${key}` });
    update('rfq_invitations', i.id, { reminders_sent: i.reminders_sent + 1, last_reminder_at: ts });
  }
  audit(actor, { action: actor ? 'rfq.reminder_sent' : 'rfq.reminder_auto', objectType: 'rfq', objectId: r.id, objectRef: r.rfq_no, after: { schedule: key, vendors: list.map((i) => i.vendor_name), skipped_responders: invitationsOf(r.id).filter((i) => ['Responded', 'Declined'].includes(i.status)).map((i) => i.vendor_name) }, reason: message ?? null });
  return list.length;
}

export function remind(actor: Actor, id: number, message?: string | null) {
  const r = ensureDue(mustRfq(id));
  assertBuyer(actor, r);
  assertState(r, LIVE, 'Sending reminders');
  const n = remindVendors(actor, r, `manual:${now()}`, message);
  return { reminded: n };
}

export function extend(actor: Actor, id: number, closingAt: string, reason: string) {
  const r = ensureDue(mustRfq(id));
  assertBuyer(actor, r);
  const responses = scalar<number>("SELECT COUNT(*) FROM rfq_invitations WHERE rfq_id = ? AND status = 'Responded'", id) ?? 0;
  const fromClosed = r.status === 'Closed' && responses === 0;
  if (!LIVE.includes(r.status) && !fromClosed) throw conflict(r.status === 'Closed' ? 'Quotations were received, so the RFQ cannot be extended. Request a reopen for chosen vendors instead.' : `Extending is not possible while RFQ ${r.rfq_no} is ${r.status.toLowerCase()}.`);
  const t = new Date(closingAt);
  if (Number.isNaN(t.getTime())) throw badRequest('New closing date is not a valid date and time.', { closing_at: 'Enter a valid date and time' });
  if (t.getTime() <= Date.now()) throw badRequest('New closing date must be in the future.', { closing_at: 'Choose a future date and time' });
  if (!fromClosed && t.getTime() <= new Date(r.closing_at).getTime()) throw badRequest(`New closing date must be after the current one (${fmtIST(r.closing_at)}).`, { closing_at: 'Later than the current closing date' });
  const to = t.toISOString();
  return tx(() => {
    const ext: Extension = { from: r.closing_at, to, reason, by: actor.id, by_name: actor.name, at: now(), reopened_from_closed: fromClosed || undefined };
    const sched = r.reminder_schedule ?? cfg<ReminderSchedule>('rfq.reminders');
    update('rfqs', id, { closing_at: to, status: 'Published', closed_at: null, extensions_json: J([...(r.extensions ?? []), ext]), reminder_schedule_json: J({ ...sched, sent: (sched.sent ?? []).filter((k) => !k.startsWith('before:') && !k.startsWith('after:')) }) });
    run('UPDATE rfq_lines SET due_at = ? WHERE rfq_id = ? AND (due_at IS NULL OR due_at >= ?)', to, id, r.closing_at);
    if (fromClosed) run("UPDATE rfq_invitations SET status = CASE WHEN viewed_at IS NOT NULL THEN 'Viewed' ELSE 'Invited' END WHERE rfq_id = ? AND status = 'Not responded'", id);
    for (const i of invitationsOf(id).filter((x) => x.sent_at && x.status !== 'Declined')) {
      notify({ event: 'NTF-06', title: `RFQ ${r.rfq_no} extended to ${fmtIST(to)}`, body: `${r.title}. The closing date has moved from ${fmtIST(r.closing_at)}.`, link: `/vendor/rfqs/${id}`, vendorId: i.vendor_id, objectType: 'rfq', objectId: id, dedupeKey: `NTF-06:ext:${id}:${i.vendor_id}:${to}` });
    }
    audit(actor, { action: 'rfq.extended', objectType: 'rfq', objectId: id, objectRef: rref(r), before: { closing_at: r.closing_at, status: r.status }, after: { closing_at: to, status: 'Published', extension_no: (r.extensions?.length ?? 0) + 1 }, reason });
    return getRfq(id)!;
  });
}

export function cancel(actor: Actor, id: number, reason: string) {
  const r = ensureDue(mustRfq(id));
  assertBuyer(actor, r);
  assertState(r, ['Draft', 'Pending approval', 'Published', 'Closed'], 'Cancelling');
  return tx(() => {
    update('rfqs', id, { status: 'Cancelled', cancel_reason: reason, closed_at: r.closed_at ?? now() });
    for (const ap of all<{ id: number; req_no: string; requester_id: number }>("SELECT id, req_no, requester_id FROM approvals WHERE object_type = 'rfq' AND object_id = ? AND status IN ('Pending','Clarification requested')", id)) {
      if (ap.requester_id === actor.id) withdraw(actor, ap.id, `RFQ cancelled: ${reason}`);
      else {
        run("UPDATE approvals SET status = 'Withdrawn', decided_at = ?, outcome = ? WHERE id = ?", now(), 'RFQ cancelled', ap.id);
        run("UPDATE approval_steps SET status = 'Skipped' WHERE approval_id = ? AND status IN ('Pending','Waiting')", ap.id);
      }
    }
    for (const l of linesOf(id)) releasePrLine(actor, l.pr_line_id, r, `RFQ ${r.rfq_no} cancelled: ${reason}`);
    if (r.status !== 'Draft' && r.status !== 'Pending approval') {
      for (const i of invitationsOf(id).filter((x) => x.sent_at)) {
        notify({ event: 'NTF-06', title: `RFQ ${r.rfq_no} cancelled`, body: `${r.title} has been cancelled by Equipcare. No quotation is needed.`, link: `/vendor/rfqs/${id}`, vendorId: i.vendor_id, objectType: 'rfq', objectId: id, dedupeKey: `NTF-06:cancel:${id}:${i.vendor_id}` });
      }
    }
    audit(actor, { action: 'rfq.cancelled', objectType: 'rfq', objectId: id, objectRef: rref(r), before: { status: r.status }, after: { status: 'Cancelled' }, reason });
    return getRfq(id)!;
  });
}

/** Re-float: a linked Draft copy carries the lines (and PR links), vendors, terms and attachments; old RFQ → Re-floated. */
export function refloat(actor: Actor, id: number, reason: string) {
  const r = ensureDue(mustRfq(id));
  assertBuyer(actor, r);
  assertState(r, ['Published', 'Closed', 'Under comparison'], 'Re-floating');
  return tx(() => {
    const ts = now();
    const rfqNo = nextNo('RFQ');
    const lines = linesOf(id).filter((l) => l.status === 'Active');
    const closing = closingDefault(prPriorities(id));
    const newId = insert('rfqs', {
      rfq_no: rfqNo, title: r.title, buyer_id: r.buyer_id, status: 'Draft', category: r.category, plant: r.plant, closing_at: closing,
      delivery_terms: r.delivery_terms, payment_terms: r.payment_terms, warranty: r.warranty, packing: r.packing, documents_required: r.documents_required,
      standard_terms: r.standard_terms, ship_to: r.ship_to, sealed: cfg<boolean>('rfq.sealed') ? 1 : 0, reminder_schedule_json: J(cfg('rfq.reminders')), extensions_json: J([]),
      parent_rfq_id: id, no_contract_snapshot_json: J(r.no_contract_snapshot), created_at: ts, kind: r.kind, opportunity_id: r.opportunity_id,
    });
    for (const l of lines) {
      const nl = insert('rfq_lines', {
        rfq_id: newId, line_no: l.line_no, pr_line_id: l.pr_line_id, material_id: l.material_id, description: l.description, qty: l.qty, uom: l.uom, required_date: l.required_date,
        due_at: closing, plant: l.plant, ship_to: l.ship_to, gst_rate: l.gst_rate, valuation_type: l.valuation_type, transport_req: l.transport_req, specs: l.specs, status: 'Active', autofill_json: J(l.autofill),
      });
      copyAttachments('rfq_line', l.id, nl);
      if (l.pr_line_id) run('UPDATE pr_lines SET rfq_id = ?, status = ? WHERE id = ?', newId, 'RFQ in progress', l.pr_line_id);
    }
    copyAttachments('rfq', id, newId);
    for (const i of invitationsOf(id)) {
      insert('rfq_invitations', { rfq_id: newId, vendor_id: i.vendor_id, suggested: i.suggested, suggest_reasons_json: J(i.suggest_reasons), added_justification: i.added_justification, status: 'Invited' });
    }
    for (const l of linesOf(id).filter((x) => x.status !== 'Active' && x.pr_line_id)) releasePrLine(actor, l.pr_line_id, r, `Not carried into re-float ${rfqNo}`);
    update('rfqs', id, { status: 'Re-floated', cancel_reason: reason, closed_at: r.closed_at ?? ts });
    if (r.opportunity_id) run('UPDATE opportunities SET rfq_id = ? WHERE id = ?', newId, r.opportunity_id);
    for (const i of invitationsOf(id).filter((x) => x.sent_at)) {
      notify({ event: 'NTF-06', title: `RFQ ${r.rfq_no} re-floated`, body: `${r.title} will be re-issued as a new RFQ. Quotations on ${r.rfq_no} will not be considered; watch for a new invitation.`, link: `/vendor/rfqs/${id}`, vendorId: i.vendor_id, objectType: 'rfq', objectId: id, dedupeKey: `NTF-06:refloat:${id}:${i.vendor_id}` });
    }
    audit(actor, { action: 'rfq.refloated', objectType: 'rfq', objectId: id, objectRef: rref(r), before: { status: r.status }, after: { status: 'Re-floated', new_rfq: rfqNo }, reason });
    audit(actor, { action: 'rfq.created_from_refloat', objectType: 'rfq', objectId: newId, objectRef: rfqNo, after: { parent: r.rfq_no, lines: lines.length, vendors: invitationsOf(newId).length } });
    return getRfq(newId)!;
  });
}

function copyAttachments(ownerType: string, fromId: number, toId: number) {
  run(
    `INSERT INTO attachments (owner_type, owner_id, label, filename, mime, size, sha256, storage_path, scan_status, scan_note, vendor_visible, restricted, uploaded_by, created_at)
     SELECT a.owner_type, ?, a.label, a.filename, a.mime, a.size, a.sha256, a.storage_path, a.scan_status, a.scan_note, a.vendor_visible, a.restricted, a.uploaded_by, a.created_at
     FROM attachments a JOIN users u ON u.id = a.uploaded_by WHERE a.owner_type = ? AND a.owner_id = ? AND u.vendor_id IS NULL`,
    toId, ownerType, fromId,
  );
}

/** Close: lock quotations, mark non-responders, NTF-07 to the buyer (FR-QTN-05). */
export function closeRfq(actor: Actor | null, id: number, mode: 'auto' | 'early') {
  const r = mustRfq(id);
  if (!LIVE.includes(r.status)) return r;
  return tx(() => {
    const ts = now();
    update('rfqs', id, { status: 'Closed', closed_at: ts });
    const locked = lockQuotations(id, null);
    run("UPDATE rfq_invitations SET status = 'Not responded' WHERE rfq_id = ? AND sent_at IS NOT NULL AND status IN ('Invited','Viewed')", id);
    const invs = invitationsOf(id).filter((i) => i.sent_at);
    const responded = invs.filter((i) => i.status === 'Responded');
    const missing = invs.filter((i) => i.status === 'Not responded');
    notify({
      event: 'NTF-07', title: responded.length ? `RFQ ${r.rfq_no} closed: ${responded.length} of ${invs.length} quotations received` : `RFQ ${r.rfq_no} closed with no quotations`,
      body: responded.length ? `${missing.length ? `Missing: ${missing.map((i) => i.vendor_name).join(', ')}. ` : ''}Quotations are locked and ready for the comparative statement.` : 'Extend the closing date, re-float the RFQ, or record an exception.',
      link: `/rfqs/${id}`, users: [r.buyer_id], objectType: 'rfq', objectId: id, severity: responded.length ? (missing.length ? 'warning' : 'success') : 'danger', dedupeKey: `NTF-07:${id}:${ts}`,
    });
    audit(actor, { action: mode === 'early' ? 'rfq.closed_early' : 'rfq.closed', objectType: 'rfq', objectId: id, objectRef: rref(r), before: { status: r.status }, after: { status: 'Closed', closed_at: ts, quotations_locked: locked, responded: responded.map((i) => i.vendor_name), not_responded: missing.map((i) => i.vendor_name), declined: invs.filter((i) => i.status === 'Declined').map((i) => i.vendor_name) } });
    return getRfq(id)!;
  });
}

export function closeEarly(actor: Actor, id: number) {
  const r = ensureDue(mustRfq(id));
  assertBuyer(actor, r);
  assertState(r, LIVE, 'Closing');
  const open = nonResponders(id);
  if (open.length) throw conflict(`Early close is possible once every invited vendor has responded or declined. Still waiting for: ${open.map((i) => i.vendor_name).join(', ')}.`);
  if (scalar<number>('SELECT COUNT(*) FROM rfq_invitations WHERE rfq_id = ? AND sent_at IS NULL', id)) throw conflict('An invitation is still waiting for approval.');
  return closeRfq(actor, id, 'early');
}

export function noResponseException(actor: Actor, id: number, reason: string) {
  const r = ensureDue(mustRfq(id));
  assertBuyer(actor, r);
  if (r.status !== 'Closed') throw conflict('An exception can be recorded only on a closed RFQ.');
  if ((scalar<number>("SELECT COUNT(*) FROM rfq_invitations WHERE rfq_id = ? AND status = 'Responded'", id) ?? 0) > 0) throw conflict('Quotations were received; continue with the comparative statement.');
  insert('comments', { object_type: 'rfq', object_id: id, user_id: actor.id, body: `No-response exception recorded: ${reason}`, internal: 1, created_at: now() });
  audit(actor, { action: 'rfq.no_response_exception', objectType: 'rfq', objectId: id, objectRef: rref(r), after: { invited: invitationsOf(id).length }, reason });
  notify({ event: 'NTF-07', title: `No-response exception on ${r.rfq_no}`, body: reason, link: `/rfqs/${id}`, roles: ['APR'], objectType: 'rfq', objectId: id, severity: 'warning', dedupeKey: `NTF-07x:${id}` });
  return getRfq(id)!;
}

/** Lazy close: any read or write after `closing_at` sees the RFQ closed even before the job runs. */
export function ensureDue(r: Rfq): Rfq {
  if (LIVE.includes(r.status) && new Date(r.closing_at).getTime() <= Date.now()) return closeRfq(null, r.id, 'auto');
  for (const ro of all<{ id: number }>("SELECT id FROM rfq_reopens WHERE rfq_id = ? AND status = 'Open' AND reopen_until <= ?", r.id, now())) lockReopen(null, ro.id);
  return getRfq(r.id)!;
}

// ------------------------------------------------------------------ reopen after close (FR-QTN-05, GOV-C03, NTF-09)
export interface Reopen { id: number; rfq_id: number; vendor_ids: number[]; reason: string; approval_id: number | null; status: string; reopen_until: string; requested_by: number; created_at: string }

export function requestReopen(actor: Actor, id: number, input: { vendor_ids: number[]; reason: string; reopen_until: string }) {
  const r = ensureDue(mustRfq(id));
  assertBuyer(actor, r);
  assertState(r, ['Closed', 'Under comparison'], 'Reopening quotations');
  const invs = invitationsOf(id).filter((i) => i.sent_at);
  const chosen = invs.filter((i) => input.vendor_ids.includes(i.vendor_id));
  if (!chosen.length || chosen.length !== new Set(input.vendor_ids).size) throw badRequest('Choose one or more invited vendors to reopen for.', { vendor_ids: 'Choose invited vendors' });
  const until = new Date(input.reopen_until);
  if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) throw badRequest('Reopen window must end in the future.', { reopen_until: 'Choose a future date and time' });
  if (until.getTime() > Date.now() + 30 * 86400000) throw badRequest('Reopen window can be at most 30 days.', { reopen_until: 'Within 30 days' });
  if (get("SELECT id FROM rfq_reopens WHERE rfq_id = ? AND status IN ('Pending approval','Open')", id)) throw conflict('A reopen is already pending or open on this RFQ.');
  return tx(() => {
    const rid = insert('rfq_reopens', { rfq_id: id, vendor_ids_json: J(chosen.map((c) => c.vendor_id)), reason: input.reason, status: 'Pending approval', reopen_until: until.toISOString(), requested_by: actor.id, created_at: now() });
    const ap = createApproval(actor, {
      type: 'rfq.reopen', objectType: 'rfq_reopen', objectId: rid, title: `Reopen quotations on ${r.rfq_no}`, summary: `${r.title}: ${chosen.map((c) => c.vendor_name).join(', ')} until ${fmtIST(until.toISOString())}`,
      value: estValue(id), reason: input.reason, context: { rfq_id: id, rfq_no: r.rfq_no, vendors: chosen.map((c) => c.vendor_name), reopen_until: until.toISOString() }, plant: r.plant === 'Multiple' ? null : r.plant, categoryCode: r.category,
    });
    update('rfq_reopens', rid, { approval_id: ap.id });
    audit(actor, { action: 'rfq.reopen_requested', objectType: 'rfq', objectId: id, objectRef: rref(r), after: { vendors: chosen.map((c) => c.vendor_name), until: until.toISOString(), approval: ap.req_no }, reason: input.reason });
    return get<Reopen>('SELECT * FROM rfq_reopens WHERE id = ?', rid)!;
  });
}

export function onReopenDecision(reopenId: number, outcome: string, actor: Actor | null, comment: string | null) {
  const ro = get<Reopen>('SELECT * FROM rfq_reopens WHERE id = ?', reopenId);
  if (!ro || ro.status !== 'Pending approval') return;
  const r = getRfq(ro.rfq_id)!;
  if (outcome !== 'Approved') {
    update('rfq_reopens', reopenId, { status: outcome === 'Withdrawn' ? 'Withdrawn' : 'Rejected' });
    audit(actor, { action: `rfq.reopen_${outcome.toLowerCase()}`, objectType: 'rfq', objectId: r.id, objectRef: r.rfq_no, reason: comment });
    return;
  }
  let until = ro.reopen_until;
  if (new Date(until).getTime() <= Date.now()) until = addDays(new Date(), 1);
  update('rfq_reopens', reopenId, { status: 'Open', reopen_until: until });
  for (const vid of ro.vendor_ids) {
    const q = get<{ id: number }>('SELECT id FROM quotations WHERE rfq_id = ? AND vendor_id = ?', r.id, vid);
    if (q) update('quotations', q.id, { status: 'Reopened', updated_at: now() });
    else insert('quotations', { rfq_id: r.id, vendor_id: vid, status: 'Reopened', version: 0, created_at: now(), updated_at: now() });
    notify({ event: 'NTF-09', title: `RFQ ${r.rfq_no} reopened for your revision`, body: `You can revise your quotation until ${fmtIST(until)}. After that it is locked again.`, link: `/vendor/rfqs/${r.id}`, vendorId: vid, objectType: 'rfq', objectId: r.id, dedupeKey: `NTF-09:${reopenId}:${vid}`, severity: 'warning' });
  }
  notify({ event: 'NTF-09', title: `Quotations reopened on ${r.rfq_no}`, body: `Vendors can revise until ${fmtIST(until)}.`, link: `/rfqs/${r.id}`, users: [r.buyer_id, ro.requested_by], objectType: 'rfq', objectId: r.id, dedupeKey: `NTF-09b:${reopenId}` });
  audit(actor, { action: 'rfq.reopened', objectType: 'rfq', objectId: r.id, objectRef: r.rfq_no, after: { vendor_ids: ro.vendor_ids, until }, reason: comment });
}

export function lockReopen(actor: Actor | null, reopenId: number) {
  const ro = get<Reopen>('SELECT * FROM rfq_reopens WHERE id = ?', reopenId);
  if (!ro) throw notFound('Reopen');
  if (ro.status !== 'Open') throw conflict('This reopen window is not open.');
  const r = getRfq(ro.rfq_id)!;
  return tx(() => {
    update('rfq_reopens', reopenId, { status: 'Closed', reopen_until: actor ? now() : ro.reopen_until });
    const n = lockQuotations(r.id, ro.vendor_ids);
    audit(actor, { action: 'rfq.reopen_locked', objectType: 'rfq', objectId: r.id, objectRef: r.rfq_no, after: { vendor_ids: ro.vendor_ids, quotations_locked: n, by: actor ? 'buyer' : 'schedule' } });
    notify({ event: 'NTF-07', title: `Reopen window on ${r.rfq_no} closed`, body: 'Revised quotations are locked again. Regenerate the comparative statement as a new version.', link: `/rfqs/${r.id}`, users: [r.buyer_id], objectType: 'rfq', objectId: r.id, dedupeKey: `NTF-07r:${reopenId}` });
    return get<Reopen>('SELECT * FROM rfq_reopens WHERE id = ?', reopenId)!;
  });
}

export function lockReopenNow(actor: Actor, rfqId: number, reopenId: number) {
  const r = mustRfq(rfqId);
  assertBuyer(actor, r);
  const ro = get<Reopen>('SELECT * FROM rfq_reopens WHERE id = ? AND rfq_id = ?', reopenId, rfqId);
  if (!ro) throw notFound('Reopen');
  return lockReopen(actor, reopenId);
}

/** Vendors currently allowed to revise on a closed RFQ. */
export function openReopenFor(rfqId: number, vendorId: number) {
  return all<Reopen>("SELECT * FROM rfq_reopens WHERE rfq_id = ? AND status = 'Open' AND reopen_until > ?", rfqId, now()).find((ro) => ro.vendor_ids.includes(vendorId)) ?? null;
}

// ------------------------------------------------------------------ jobs
export function lifecycleJob() {
  let closed = 0;
  for (const r of all<{ id: number }>("SELECT id FROM rfqs WHERE status = 'Published' AND closing_at <= ?", now())) { closeRfq(null, r.id, 'auto'); closed++; }
  let locked = 0;
  for (const ro of all<{ id: number }>("SELECT id FROM rfq_reopens WHERE status = 'Open' AND reopen_until <= ?", now())) { lockReopen(null, ro.id); locked++; }
  return `closed ${closed} RFQ(s), locked ${locked} reopen window(s)`;
}

/** NTF-05 on the configured schedule, only to vendors who have not responded or declined (AC-RFQ-07). */
export function remindersJob() {
  let sent = 0;
  const t = Date.now();
  for (const r of all<Rfq>("SELECT * FROM rfqs WHERE status IN ('Published','Closed')")) {
    const sched = r.reminder_schedule ?? cfg<ReminderSchedule>('rfq.reminders');
    const done = new Set(sched.sent ?? []);
    const close = new Date(r.closing_at).getTime();
    const due: string[] = [];
    if (r.status === 'Published' && t < close) {
      for (const d of sched.before_days ?? []) if (t >= close - d * 86400000 && !done.has(`before:${d}`)) due.push(`before:${d}`);
      if (due.length) sent += remindVendors(null, r, due.join('+'));
    } else if (r.status === 'Closed') {
      for (const d of sched.after_days ?? []) {
        const k = `after:${d}`;
        if (t >= close + d * 86400000 && !done.has(k)) {
          due.push(k);
          for (const i of all<{ vendor_id: number; id: number; reminders_sent: number }>("SELECT vendor_id, id, reminders_sent FROM rfq_invitations WHERE rfq_id = ? AND status = 'Not responded'", r.id)) {
            notify({ event: 'NTF-05', title: `RFQ ${r.rfq_no} closed without your quotation`, body: `${r.title}. If you can still quote, contact the Equipcare buyer — late quotations are considered only if the RFQ is reopened.`, link: `/vendor/rfqs/${r.id}`, vendorId: i.vendor_id, objectType: 'rfq', objectId: r.id, dedupeKey: `NTF-05:${r.id}:${i.vendor_id}:${k}` });
            update('rfq_invitations', i.id, { reminders_sent: i.reminders_sent + 1, last_reminder_at: now() });
            sent++;
          }
        }
      }
    }
    if (due.length) update('rfqs', r.id, { reminder_schedule_json: J({ ...sched, sent: [...done, ...due] }) });
  }
  return `${sent} reminder(s) sent`;
}

// ------------------------------------------------------------------ queries
export function listRfqs(actor: Actor, q: Record<string, string | undefined>) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (q.view === 'mine') { where.push('r.buyer_id = ?'); p.push(actor.id); }
  if (q.status) { where.push('r.status = ?'); p.push(q.status); }
  const rows = all<Rfq & { buyer_name: string; parent_no: string | null }>(
    `SELECT r.*, u.name AS buyer_name, pr.rfq_no AS parent_no FROM rfqs r LEFT JOIN users u ON u.id = r.buyer_id LEFT JOIN rfqs pr ON pr.id = r.parent_rfq_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE r.status WHEN 'Published' THEN 0 WHEN 'Pending approval' THEN 1 WHEN 'Draft' THEN 2 WHEN 'Closed' THEN 3 ELSE 4 END, r.closing_at`,
    ...p,
  );
  return rows.map((r) => {
    const c = get<{ invited: number; viewed: number; responded: number; declined: number; not_responded: number; failed: number }>(
      `SELECT COUNT(*) AS invited, SUM(CASE WHEN status = 'Viewed' THEN 1 ELSE 0 END) AS viewed, SUM(CASE WHEN status = 'Responded' THEN 1 ELSE 0 END) AS responded,
              SUM(CASE WHEN status = 'Declined' THEN 1 ELSE 0 END) AS declined, SUM(CASE WHEN status = 'Not responded' THEN 1 ELSE 0 END) AS not_responded,
              SUM(CASE WHEN delivery_status = 'Delivery failed' THEN 1 ELSE 0 END) AS failed
       FROM rfq_invitations WHERE rfq_id = ?`, r.id,
    )!;
    const lines = get<{ n: number; flagged: number }>("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'Flagged' THEN 1 ELSE 0 END) AS flagged FROM rfq_lines WHERE rfq_id = ? AND status != 'Removed'", r.id)!;
    const prs = all<{ pr_no: string }>('SELECT DISTINCT p.pr_no FROM rfq_lines l JOIN pr_lines p ON p.id = l.pr_line_id WHERE l.rfq_id = ?', r.id).map((x) => x.pr_no);
    const priority = topPriority(prPriorities(r.id));
    return {
      id: r.id, rfq_no: r.rfq_no, title: r.title, kind: r.kind ?? 'Spot', status: r.status, buyer_id: r.buyer_id, buyer_name: r.buyer_name, category: r.category, plant: r.plant,
      closing_at: r.closing_at, published_at: r.published_at, closed_at: r.closed_at, created_at: r.created_at, sealed: r.sealed, parent_no: r.parent_no, priority,
      lines: lines.n, flagged: lines.flagged ?? 0, prs, invited: c.invited, viewed: c.viewed ?? 0, responded: c.responded ?? 0, declined: c.declined ?? 0, not_responded: c.not_responded ?? 0, delivery_failed: c.failed ?? 0,
      est_value: estValue(r.id), hours_to_close: Math.round((new Date(r.closing_at).getTime() - Date.now()) / 3600000),
    };
  });
}

export function summary(actor: Actor) {
  const mine = actor.role === 'BUY' ? `AND buyer_id = ${actor.id}` : '';
  const n = (sql: string, ...p: unknown[]) => scalar<number>(sql, ...p) ?? 0;
  return {
    published: n(`SELECT COUNT(*) FROM rfqs WHERE status = 'Published' ${mine}`),
    closing_48h: n(`SELECT COUNT(*) FROM rfqs WHERE status = 'Published' AND closing_at <= ? ${mine}`, new Date(Date.now() + 48 * 3600000).toISOString()),
    closed: n(`SELECT COUNT(*) FROM rfqs WHERE status = 'Closed' ${mine}`),
    pending_approval: n(`SELECT COUNT(*) FROM rfqs WHERE status = 'Pending approval' ${mine}`),
    draft: n(`SELECT COUNT(*) FROM rfqs WHERE status = 'Draft' ${mine}`),
    flagged: n(`SELECT COUNT(DISTINCT l.rfq_id) FROM rfq_lines l JOIN rfqs r ON r.id = l.rfq_id WHERE l.status = 'Flagged' ${mine.replace('buyer_id', 'r.buyer_id')}`),
  };
}

/** Buyer / internal RFQ detail. Prices and quotation documents stay hidden while sealed (FR-RFQ-12). */
export function detail(actor: Actor, id: number) {
  const r = ensureDue(mustRfq(id));
  const sealed = isSealedNow(r);
  const buyer = get<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', r.buyer_id);
  const lines = linesOf(id, true).map((l) => {
    const pr = l.pr_line_id ? get<{ pr_no: string; item: number; status: string; flag: string | null; priority: string; requisitioner: string | null; category: string | null }>(
      'SELECT p.pr_no, p.item, p.status, p.flag, p.priority, u.name AS requisitioner, p.category FROM pr_lines p LEFT JOIN users u ON u.id = p.requisitioner_id WHERE p.id = ?', l.pr_line_id) : undefined;
    const m = l.material_id ? get<{ code: string; lpp: number | null; hsn: string | null; brand: string | null; category: string | null }>('SELECT code, lpp, hsn, brand, category FROM materials WHERE id = ?', l.material_id) : undefined;
    const files = scalar<number>("SELECT COUNT(*) FROM attachments a JOIN users u ON u.id = a.uploaded_by WHERE a.owner_type = 'rfq_line' AND a.owner_id = ? AND u.vendor_id IS NULL", l.id) ?? 0;
    return { ...l, pr_ref: pr ? `${pr.pr_no}/${pr.item}` : null, pr_status: pr?.status ?? null, pr_flag: pr?.flag ?? null, priority: pr?.priority ?? 'Normal', requisitioner: pr?.requisitioner ?? null, category: pr?.category ?? m?.category ?? null, material_code: m?.code ?? null, lpp: m?.lpp ?? null, hsn: m?.hsn ?? null, brand: m?.brand ?? null, files };
  });
  const quotes = all<{ id: number; vendor_id: number; status: string; version: number; ref_no: string | null; submitted_at: string | null; updated_at: string | null }>('SELECT id, vendor_id, status, version, ref_no, submitted_at, updated_at FROM quotations WHERE rfq_id = ?', id);
  const qByVendor = new Map(quotes.map((q) => [q.vendor_id, q]));
  const invitations = invitationsOf(id).map((i) => {
    const q = qByVendor.get(i.vendor_id);
    return { ...i, quotation: q && q.version > 0 ? { id: q.id, status: q.status, version: q.version, submitted_at: q.submitted_at, ref_no: sealed ? null : q.ref_no } : q?.status === 'Declined' ? { id: q.id, status: 'Declined', version: q.version, submitted_at: null, ref_no: null } : null };
  });
  const responded = invitations.filter((i) => i.status === 'Responded').length;
  const approvals = all("SELECT id, req_no, type, status, title, created_at, decided_at, outcome FROM approvals WHERE (object_type = 'rfq' AND object_id = ?) OR (object_type = 'rfq_reopen' AND object_id IN (SELECT id FROM rfq_reopens WHERE rfq_id = ?)) ORDER BY id DESC", id, id);
  const reopens = all<Reopen & { requested_by_name: string }>('SELECT ro.*, u.name AS requested_by_name FROM rfq_reopens ro LEFT JOIN users u ON u.id = ro.requested_by WHERE ro.rfq_id = ? ORDER BY ro.id DESC', id)
    .map((ro) => ({ ...ro, vendors: ro.vendor_ids.map((v) => get<{ name: string }>('SELECT name FROM vendors WHERE id = ?', v)?.name ?? String(v)) }));
  const children = all<{ id: number; rfq_no: string; status: string }>('SELECT id, rfq_no, status FROM rfqs WHERE parent_rfq_id = ?', id);
  const parent = r.parent_rfq_id ? get<{ id: number; rfq_no: string; status: string }>('SELECT id, rfq_no, status FROM rfqs WHERE id = ?', r.parent_rfq_id) : null;
  const sapOut = r.sap_rfq_ref || cfg<boolean>('sap.write.rfq') ? get<{ status: string; attempts: number; completed_at: string | null }>('SELECT status, attempts, completed_at FROM sap_outbound WHERE idempotency_key = ?', `RFQREF:${r.rfq_no}`) : undefined;
  const mv = minVendors(id);
  const opportunity = r.opportunity_id ? get('SELECT o.id, o.status, o.frequency, o.annual_value, m.code AS material_code FROM opportunities o LEFT JOIN materials m ON m.id = o.material_id WHERE o.id = ?', r.opportunity_id) : null;
  const quotations = sealed ? null : quotationsForBuyer(id);
  return {
    ...r, buyer_name: buyer?.name ?? null, buyer_email: buyer?.email ?? null, kind: r.kind ?? 'Spot', sealed_now: sealed, lines, invitations,
    counts: { invited: invitations.length, sent: invitations.filter((i) => i.sent_at).length, viewed: invitations.filter((i) => i.viewed_at).length, responded, declined: invitations.filter((i) => i.status === 'Declined').length, not_responded: invitations.filter((i) => i.status === 'Not responded').length, delivery_failed: invitations.filter((i) => i.delivery_status === 'Delivery failed').length },
    min_vendors: mv.min, categories: mv.categories, est_value: estValue(id), approvals, reopens, children, parent, opportunity,
    sap: { enabled: cfg<boolean>('sap.write.rfq'), ref: r.sap_rfq_ref, outbound: sapOut ?? null, decision: 'DEC-04' },
    publish_problems: EDITABLE.includes(r.status) ? publishProblems(r) : {},
    priority: topPriority(prPriorities(id)),
    quotations,
    comparison_link: CLOSED_STATES.includes(r.status) ? `/comparisons/rfq/${id}` : null,
    can_close_early: LIVE.includes(r.status) && nonResponders(id).length === 0 && invitations.length > 0,
    can_extend: LIVE.includes(r.status) || (r.status === 'Closed' && responded === 0),
    reopen_open: reopens.find((x) => x.status === 'Open') ?? null,
    viewer_can_manage: actor.perms.has('rfq.manage'),
  };
}

/** After close: every quotation (submitted version), its documents and version history (AC-QTN-03, AC-QTN-06). */
export function quotationsForBuyer(rfqId: number) {
  const qs = all<{ id: number; vendor_id: number; status: string; version: number; ref_no: string | null; submitted_at: string | null; vendor_name: string; sap_code: string | null }>(
    'SELECT q.id, q.vendor_id, q.status, q.version, q.ref_no, q.submitted_at, v.name AS vendor_name, v.sap_code FROM quotations q JOIN vendors v ON v.id = q.vendor_id WHERE q.rfq_id = ? ORDER BY v.name', rfqId,
  );
  return qs.filter((q) => q.version > 0 || q.status === 'Declined').map((q) => {
    const latest = restoreLatest(q.id);
    const docs = all('SELECT a.id, a.label, a.filename, a.size, a.mime, a.created_at, a.scan_status FROM attachments a WHERE a.owner_type = ? AND a.owner_id = ? ORDER BY a.id', 'quotation', q.id);
    const versions = all<{ id: number; version: number; created_at: string; note: string | null; header: Record<string, unknown> | null }>('SELECT id, version, created_at, note, header_json FROM quotation_versions WHERE quotation_id = ? ORDER BY version DESC', q.id)
      .map((v) => ({ version: v.version, created_at: v.created_at, note: v.note, ref_no: (v.header?._ref as string) ?? null, changes: (v.header?._changes as unknown[]) ?? [] }));
    return { ...q, header: latest?.header ?? null, lines: latest?.lines ?? [], documents: docs, versions };
  });
}

export const notInvited = () => notFound('Invitation');
