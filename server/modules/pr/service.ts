/**
 * Module 1 — PR Workbench and procurement route decision (PR-01..PR-08, FR-PRW-01..12).
 */
import { all, get, insert, update, run, J, now, addHours, daysBetween, tx, scalar } from '../../core/db.ts';
import { audit } from '../../core/audit.ts';
import { notify } from '../../core/notify.ts';
import { cfg } from '../../core/config.ts';
import { badRequest, conflict, forbidden, notFound, HttpError } from '../../core/http.ts';
import { createApproval } from '../../core/approvals.ts';
import { simSettings, staleInfo } from '../../core/sap.ts';
import type { Actor } from '../../core/auth.ts';

export const ROUTES = ['ARC/OA', 'VMI', 'FDS', 'Fixed supplier', 'RFQ', 'Urgent/BD', 'Class 1', 'Capex', 'Service', 'Exception'] as const;
export type RouteName = (typeof ROUTES)[number];
export const CONTRACT_ROUTES: RouteName[] = ['ARC/OA', 'VMI', 'FDS', 'Fixed supplier'];
/** Routes whose lines go to an RFQ basket next. */
export const RFQ_ROUTES: RouteName[] = ['RFQ', 'Urgent/BD', 'Class 1', 'Capex', 'Service'];
/** Statuses where a line is still with procurement and ageing counts. */
export const OPEN_STATUSES = ['Synced', 'Unassigned', 'Assigned', 'Under review', 'Route decided', 'RFQ in progress', 'Contract/VMI PO pending', 'Exception pending approval', 'Clarification pending', 'On hold'];

export interface PrLine {
  id: number;
  pr_no: string;
  item: number;
  material_id: number | null;
  material_code: string;
  description: string;
  material_group: string | null;
  category: string | null;
  plant: string;
  storage_location: string | null;
  qty: number;
  uom: string;
  required_date: string;
  requisitioner_id: number | null;
  department: string | null;
  priority: string;
  est_unit_price: number | null;
  is_capex: number;
  is_service: number;
  sap_status: string;
  status: string;
  buyer_id: number | null;
  assigned_at: string | null;
  route: string | null;
  route_proposed: string | null;
  route_reason: string | null;
  checks: Checks | null;
  checks_at: string | null;
  repeat_flag: number;
  repeat_info: { count: number; value: number; vendors: number; lookback_days: number } | null;
  rfq_id: number | null;
  po_no: string | null;
  contract_id: number | null;
  hold_reason: string | null;
  sla_due: string | null;
  sap_created_at: string | null;
  available_at: string | null;
  synced_at: string | null;
  closed_at: string | null;
  flag: string | null;
}

export interface Checks {
  ran_at: string;
  sap_unavailable: boolean;
  stale: boolean;
  stock: { unrestricted: number; covers: boolean; synced_at: string | null };
  open_po: { qty: number; lines: { po_no: string; item: number; open: number }[] };
  vmi: { active: boolean; contract_no: string | null };
  contract: { valid: boolean; contract_id: number | null; contract_no: string | null; type: string | null; sap_oa_no: string | null; vendor: string | null; unit_price: number | null; discount_pct: number | null; valid_to: string | null; remaining_value: number | null } | null;
  proposed: RouteName;
  proposal_note: string;
}

export function getLine(id: number) {
  return get<PrLine>('SELECT * FROM pr_lines WHERE id = ?', id);
}
function mustLine(id: number) {
  const l = getLine(id);
  if (!l) throw notFound('PR line');
  return l;
}
const ref = (l: Pick<PrLine, 'pr_no' | 'item'>) => `${l.pr_no}/${l.item}`;

// ------------------------------------------------------------------ buyer assignment (FR-PRW-03)
export function matchBuyer(l: Pick<PrLine, 'category' | 'plant' | 'priority'>) {
  return get<{ buyer_id: number; backup_buyer_id: number | null }>(
    `SELECT buyer_id, backup_buyer_id FROM buyer_matrix
     WHERE active = 1 AND category = ? AND (plant = ? OR plant = '*') AND (priority_route = ? OR priority_route = '*')
     ORDER BY (plant = '*'), (priority_route = '*') LIMIT 1`,
    l.category ?? '', l.plant, l.priority,
  );
}

function slaDue(priority: string, from = new Date()) {
  const sla = cfg<Record<string, number>>('pr.sla_hours');
  return sla[priority] ? addHours(from, sla[priority]) : null;
}

export function autoAssign(lineId: number) {
  const l = mustLine(lineId);
  if (l.buyer_id) return l;
  const m = matchBuyer(l);
  const ts = now();
  if (!m) {
    update('pr_lines', lineId, { status: 'Unassigned', sla_due: slaDue(l.priority) });
    audit(null, { action: 'pr.unassigned', objectType: 'pr_line', objectId: lineId, objectRef: ref(l), after: { reason: 'No buyer-matrix row matches category/plant' } });
    notify({ event: 'NTF-01', title: `Unassigned PR line ${ref(l)}`, body: `${l.description} — no buyer matrix row for ${l.category ?? 'unmapped category'} / ${l.plant}`, link: `/pr?view=unassigned`, roles: ['APR'], objectType: 'pr_line', objectId: lineId, severity: 'warning' });
    return getLine(lineId)!;
  }
  update('pr_lines', lineId, { buyer_id: m.buyer_id, assigned_at: ts, status: 'Assigned', sla_due: slaDue(l.priority) });
  audit(null, { action: 'pr.assigned', objectType: 'pr_line', objectId: lineId, objectRef: ref(l), after: { buyer_id: m.buyer_id, by: 'buyer matrix' } });
  notifyAssigned(lineId);
  return getLine(lineId)!;
}

function notifyAssigned(lineId: number) {
  const l = getLine(lineId)!;
  const buyer = get<{ name: string }>('SELECT name FROM users WHERE id = ?', l.buyer_id);
  notify({ event: 'NTF-01', title: `PR line ${ref(l)} assigned to you`, body: `${l.description} · ${l.qty} ${l.uom} · ${l.plant}${l.priority !== 'Normal' ? ` · ${l.priority}` : ''}`, link: `/pr/${lineId}`, users: [l.buyer_id], objectType: 'pr_line', objectId: lineId, severity: l.priority !== 'Normal' ? 'warning' : 'info', dedupeKey: `NTF-01:${lineId}:${l.buyer_id}` });
  notify({ event: 'NTF-01', title: `Buyer assigned for ${ref(l)}`, body: `${buyer?.name ?? 'A buyer'} is handling ${l.description}.`, link: `/my-requirements?focus=${lineId}`, users: [l.requisitioner_id], objectType: 'pr_line', objectId: lineId, dedupeKey: `NTF-01r:${lineId}:${l.buyer_id}` });
}

export function reassign(actor: Actor, lineId: number, buyerId: number, reason: string | undefined) {
  const l = mustLine(lineId);
  if (!OPEN_STATUSES.includes(l.status)) throw conflict(`PR line is ${l.status.toLowerCase()} and cannot be reassigned.`);
  const buyer = get<{ id: number; roles: string; active: number }>('SELECT id, roles, active FROM users WHERE id = ?', buyerId);
  if (!buyer || !buyer.active || !buyer.roles.split(',').includes('BUY')) throw badRequest('Choose an active buyer.', { buyer_id: 'Not a buyer' });
  if (l.buyer_id && l.buyer_id !== buyerId && (!reason || reason.trim().length < 10)) throw badRequest('Reassignment needs a reason of at least 10 characters.', { reason: 'Reason is required' });
  if (l.buyer_id === buyerId) throw badRequest('Line is already assigned to this buyer.');
  update('pr_lines', lineId, { buyer_id: buyerId, assigned_at: now(), status: l.status === 'Unassigned' || l.status === 'Synced' ? 'Assigned' : l.status });
  audit(actor, { action: l.buyer_id ? 'pr.reassigned' : 'pr.assigned', objectType: 'pr_line', objectId: lineId, objectRef: ref(l), before: { buyer_id: l.buyer_id }, after: { buyer_id: buyerId }, reason: reason ?? null });
  notifyAssigned(lineId);
  return getLine(lineId)!;
}

// ------------------------------------------------------------------ repeat purchase (PR-08)
export function computeRepeat(lineId: number) {
  const l = mustLine(lineId);
  if (!l.material_id) return;
  const rp = cfg<{ lookback_days: number; min_count: number; min_value: number }>('pr.repeat_purchase');
  const since = new Date(Date.now() - rp.lookback_days * 86400000).toISOString().slice(0, 10);
  const r = get<{ n: number; value: number; vendors: number }>(
    `SELECT COUNT(DISTINCT p.id) AS n, COALESCE(SUM(pl.qty * pl.unit_price), 0) AS value, COUNT(DISTINCT p.vendor_id) AS vendors
     FROM po_lines pl JOIN pos p ON p.id = pl.po_id
     WHERE pl.material_id = ? AND p.po_date >= ? AND p.contract_id IS NULL AND pl.status != 'Cancelled'`,
    l.material_id, since,
  )!;
  const hasContract = !!validContract(l.material_id, l.plant);
  const flag = !hasContract && r.n >= rp.min_count && r.value >= rp.min_value;
  update('pr_lines', lineId, { repeat_flag: flag ? 1 : 0, repeat_info_json: J({ count: r.n, value: Math.round(r.value), vendors: r.vendors, lookback_days: rp.lookback_days }) });
}

// ------------------------------------------------------------------ checks & route proposal (PR-04, PR-05)
export function validContract(materialId: number, plant: string) {
  const today = now().slice(0, 10);
  return get<{ id: number; contract_no: string; type: string; sap_oa_no: string | null; vendor: string; vendor_id: number; unit_price: number | null; discount_pct: number | null; valid_to: string; value_cap: number | null; consumed_value: number; qty_cap: number | null; consumed_qty: number; contract_discount: number | null }>(
    `SELECT c.id, c.contract_no, c.type, c.sap_oa_no, v.name AS vendor, c.vendor_id, ci.unit_price, ci.discount_pct, c.valid_to, c.value_cap, c.consumed_value,
            ci.qty_cap, ci.consumed_qty, c.discount_pct AS contract_discount
     FROM contracts c JOIN contract_items ci ON ci.contract_id = c.id JOIN vendors v ON v.id = c.vendor_id
     WHERE ci.material_id = ? AND c.status IN ('Active','Expiring') AND c.sap_oa_no IS NOT NULL
       AND c.valid_from <= ? AND c.valid_to >= ? AND (c.plant = '*' OR c.plant = ? OR c.plant IS NULL)
       AND (c.value_cap IS NULL OR c.consumed_value < c.value_cap) AND (ci.qty_cap IS NULL OR ci.consumed_qty < ci.qty_cap)
       AND v.sap_blocked = 0
     ORDER BY CASE c.type WHEN 'ARC' THEN 1 WHEN 'OA' THEN 1 WHEN 'FDS' THEN 2 WHEN 'VMI' THEN 3 ELSE 4 END LIMIT 1`,
    materialId, today, today, plant,
  );
}

const routeForContract = (type: string): RouteName => (type === 'ARC' || type === 'OA' ? 'ARC/OA' : (type as RouteName));

export function runChecks(actor: Actor | null, lineId: number) {
  const l = mustLine(lineId);
  if (!l.material_id) throw badRequest('Material is not in the material master; checks cannot run.');
  const sim = simSettings();
  const st = get<{ unrestricted: number; open_po_qty: number; vmi: number; synced_at: string | null }>('SELECT * FROM stock WHERE material_id = ? AND plant = ?', l.material_id, l.plant);
  const openLines = all<{ po_no: string; item: number; open: number }>(
    `SELECT p.po_no, pl.item, (pl.qty - pl.received_qty) AS open FROM po_lines pl JOIN pos p ON p.id = pl.po_id
     WHERE pl.material_id = ? AND p.plant = ? AND pl.status NOT IN ('Received','Closed','Cancelled') AND (pl.qty - pl.received_qty) > 0 AND (pl.pr_line_id IS NULL OR pl.pr_line_id != ?)`,
    l.material_id, l.plant, lineId,
  );
  const c = validContract(l.material_id, l.plant);
  const stockFresh = staleInfo('INT-M04', lastSuccess('INT-M04'));
  const contractFresh = staleInfo('INT-M06', lastSuccess('INT-M06'));
  const unrestricted = st?.unrestricted ?? 0;
  const vmiContract = c?.type === 'VMI' ? c : null;
  const checks: Checks = {
    ran_at: now(),
    sap_unavailable: sim.offline,
    stale: stockFresh.stale || contractFresh.stale,
    stock: { unrestricted, covers: unrestricted >= l.qty, synced_at: st?.synced_at ?? null },
    open_po: { qty: openLines.reduce((s, x) => s + x.open, 0), lines: openLines },
    vmi: { active: !!(st?.vmi || vmiContract), contract_no: vmiContract?.contract_no ?? null },
    contract: c
      ? { valid: true, contract_id: c.id, contract_no: c.contract_no, type: c.type, sap_oa_no: c.sap_oa_no, vendor: c.vendor, unit_price: c.unit_price, discount_pct: c.discount_pct ?? c.contract_discount, valid_to: c.valid_to, remaining_value: c.value_cap != null ? c.value_cap - c.consumed_value : null }
      : { valid: false, contract_id: null, contract_no: null, type: null, sap_oa_no: null, vendor: null, unit_price: null, discount_pct: null, valid_to: null, remaining_value: null },
    proposed: 'RFQ',
    proposal_note: '',
  };
  const order = cfg<string[]>('pr.route_order');
  let proposed: RouteName | null = null;
  if (c) {
    const r = routeForContract(c.type);
    if (order.includes(r)) proposed = r;
  }
  const notes: string[] = [];
  if (!proposed) {
    if (l.is_capex) proposed = 'Capex';
    else if (l.is_service) proposed = 'Service';
    else if (l.priority === 'Class 1') proposed = 'Class 1';
    else if (l.priority === 'BD' || l.priority === 'Urgent') proposed = 'Urgent/BD';
    else proposed = 'RFQ';
  }
  if (c) notes.push(`Valid ${c.type} ${c.contract_no} with ${c.vendor} until ${c.valid_to}.`);
  else notes.push('No valid ARC / OA / FDS / VMI / fixed-supplier arrangement covers this material.');
  if (checks.stock.covers) notes.push(`Unrestricted stock (${unrestricted} ${l.uom}) covers the requirement — consider closing the line.`);
  else if (checks.open_po.qty > 0) notes.push(`${checks.open_po.qty} ${l.uom} already on open POs for this plant.`);
  if (l.priority !== 'Normal') notes.push(`${l.priority} priority — separate SLA clock applies.`);
  checks.proposed = proposed;
  checks.proposal_note = notes.join(' ');
  update('pr_lines', lineId, {
    checks_json: J(checks), checks_at: checks.ran_at, route_proposed: proposed, contract_id: c?.id ?? null,
    status: ['Assigned', 'Synced'].includes(l.status) ? 'Under review' : l.status,
  });
  audit(actor, { action: 'pr.checks_run', objectType: 'pr_line', objectId: lineId, objectRef: ref(l), after: { stock: unrestricted, open_po: checks.open_po.qty, vmi: checks.vmi.active, contract: c?.contract_no ?? null, proposed, stale: checks.stale, sap_unavailable: checks.sap_unavailable } });
  computeRepeat(lineId);
  return getLine(lineId)!;
}

function lastSuccess(flowId: string) {
  return scalar<string>('SELECT MIN(last_success) FROM sync_state WHERE flow LIKE ?', `${flowId}:%`) ?? null;
}

export interface RouteInput {
  route: RouteName;
  reason?: string;
  acknowledgeStale?: boolean;
}

export function decideRoute(actor: Actor, lineId: number, input: RouteInput) {
  const l = mustLine(lineId);
  if (l.buyer_id !== actor.id && !actor.perms.has('pr.assign')) throw forbidden('Only the assigned buyer can decide the route.');
  if (!['Under review', 'Route decided', 'Assigned', 'Clarification pending'].includes(l.status)) throw conflict(`Route cannot be decided while the line is ${l.status.toLowerCase()}.`);
  if (!l.checks) throw new HttpError(409, 'checks_required', 'Run the stock, open PO, VMI and contract checks before deciding the route.');
  if (!ROUTES.includes(input.route)) throw badRequest('Unknown route.', { route: 'Choose a route' });
  const checks = l.checks;
  const reason = input.reason?.trim();
  const override = input.route !== l.route_proposed;
  if ((override || input.route === 'Exception') && (!reason || reason.length < 10)) {
    throw badRequest(override ? `Overriding the proposed route (${l.route_proposed}) needs a reason of at least 10 characters.` : 'An exception route needs a reason.', { reason: 'Reason is required' });
  }
  if (checks.stale && !checks.sap_unavailable && !input.acknowledgeStale) {
    throw new HttpError(409, 'stale_ack_required', 'SAP stock or contract data is older than its freshness threshold. Confirm you have reviewed it before routing.');
  }
  if (CONTRACT_ROUTES.includes(input.route) && (!checks.contract?.valid || routeForContract(checks.contract.type ?? '') !== input.route)) {
    throw badRequest(`No valid ${input.route} arrangement was found in the checks for this line.`, { route: 'Not eligible' });
  }

  return tx(() => {
    const ts = now();
    let status = CONTRACT_ROUTES.includes(input.route) ? 'Contract/VMI PO pending' : 'Route decided';
    let approvalId: number | null = null;
    const val = (l.est_unit_price ?? 0) * l.qty;
    // Off-contract: a valid contract exists but the buyer routes away from it (APP-04, CON-03).
    const offContract = !!checks.contract?.valid && !CONTRACT_ROUTES.includes(input.route);
    if (checks.sap_unavailable) {
      const ap = createApproval(actor, { type: 'exc.stale_routing', objectType: 'pr_line', objectId: lineId, title: `Route ${ref(l)} while SAP is unavailable`, summary: `${l.description} → ${input.route}`, value: val, reason, context: { route: input.route, pr_ref: ref(l) }, plant: l.plant, categoryCode: l.category, urgency: l.priority });
      approvalId = ap.id;
      status = 'Exception pending approval';
    } else if (offContract) {
      const ap = createApproval(actor, { type: 'exc.off_contract', objectType: 'pr_line', objectId: lineId, title: `Off-contract route for ${ref(l)}`, summary: `${l.description}: ${checks.contract!.contract_no} (${checks.contract!.vendor}) bypassed → ${input.route}`, value: val, reason, context: { route: input.route, contract_no: checks.contract!.contract_no, pr_ref: ref(l) }, plant: l.plant, categoryCode: l.category, urgency: l.priority });
      approvalId = ap.id;
      status = 'Exception pending approval';
      notify({ event: 'NTF-14', title: `Off-contract purchase proposed: ${ref(l)}`, body: `${checks.contract!.contract_no} covers ${l.description}. Reason: ${reason}`, link: `/approvals/${ap.id}`, roles: ['APR'], users: [l.buyer_id], objectType: 'pr_line', objectId: lineId, severity: 'warning' });
    } else if (input.route === 'Exception') {
      const ap = createApproval(actor, { type: 'exc.single_source', objectType: 'pr_line', objectId: lineId, title: `Exception route for ${ref(l)}`, summary: l.description, value: val, reason, context: { route: input.route, pr_ref: ref(l) }, plant: l.plant, categoryCode: l.category, urgency: l.priority });
      approvalId = ap.id;
      status = 'Exception pending approval';
    }
    insert('route_decisions', { pr_line_id: lineId, proposed: l.route_proposed, decided: input.route, override: override ? 1 : 0, reason: reason ?? null, checks_json: J(checks), contract_id: CONTRACT_ROUTES.includes(input.route) ? checks.contract?.contract_id ?? null : null, approval_id: approvalId, decided_by: actor.id, decided_at: ts });
    update('pr_lines', lineId, { route: input.route, route_reason: reason ?? null, status });
    audit(actor, { action: override ? 'pr.route_overridden' : 'pr.route_confirmed', objectType: 'pr_line', objectId: lineId, objectRef: ref(l), before: { route: l.route, proposed: l.route_proposed }, after: { route: input.route, status, approval_id: approvalId, stale_acknowledged: !!input.acknowledgeStale }, reason: reason ?? null });
    return getLine(lineId)!;
  });
}

/** Approval outcome for off-contract / exception / stale-data routing. */
export function onRouteApproval(lineId: number, outcome: string, actor: Actor | null, comment: string | null) {
  const l = getLine(lineId);
  if (!l || l.status !== 'Exception pending approval') return;
  if (outcome === 'Approved') {
    const status = l.route && CONTRACT_ROUTES.includes(l.route as RouteName) ? 'Contract/VMI PO pending' : 'Route decided';
    update('pr_lines', lineId, { status });
    audit(actor, { action: 'pr.route_exception_approved', objectType: 'pr_line', objectId: lineId, objectRef: ref(l), after: { route: l.route, status } });
    notify({ event: 'NTF-12', title: `Route approved for ${ref(l)}`, body: `${l.route} — continue with the next step.`, link: `/pr/${lineId}`, users: [l.buyer_id], objectType: 'pr_line', objectId: lineId, severity: 'success', dedupeKey: `route-ok:${lineId}:${now()}` });
  } else {
    update('pr_lines', lineId, { status: 'Under review', route: null });
    audit(actor, { action: 'pr.route_exception_' + outcome.toLowerCase(), objectType: 'pr_line', objectId: lineId, objectRef: ref(l), reason: comment });
  }
}

/** PO creation reference for contract routes (FR-PRW-11). */
export function poReference(lineId: number) {
  const l = mustLine(lineId);
  if (!l.route || !CONTRACT_ROUTES.includes(l.route as RouteName)) throw conflict('A PO creation reference is produced only for ARC/OA, FDS, VMI and fixed-supplier routes.');
  const c = l.contract_id ? get<{ id: number; contract_no: string; type: string; sap_oa_no: string; valid_from: string; valid_to: string; status: string; vendor_id: number; payment_terms: string; delivery_terms: string; discount_pct: number | null }>('SELECT * FROM contracts WHERE id = ?', l.contract_id) : undefined;
  if (!c) throw conflict('The contract for this line is no longer available. Run checks again.');
  const today = now().slice(0, 10);
  const stillValid = c.valid_from <= today && c.valid_to >= today && ['Active', 'Expiring'].includes(c.status);
  const vendor = get<{ name: string; sap_code: string }>('SELECT name, sap_code FROM vendors WHERE id = ?', c.vendor_id)!;
  const item = get<{ unit_price: number; discount_pct: number | null }>('SELECT unit_price, discount_pct FROM contract_items WHERE contract_id = ? AND material_id = ?', c.id, l.material_id);
  return {
    valid: stillValid,
    message: stillValid ? 'Create the PO in SAP against this outline agreement.' : 'The contract expired after the check. Re-run checks and re-route the line.',
    pr_ref: ref(l), material_code: l.material_code, description: l.description, qty: l.qty, uom: l.uom, plant: l.plant, required_date: l.required_date,
    contract_no: c.contract_no, contract_type: c.type, sap_oa_no: c.sap_oa_no, vendor: vendor.name, vendor_sap_code: vendor.sap_code,
    unit_price: item?.unit_price ?? null, discount_pct: item?.discount_pct ?? c.discount_pct, valid_from: c.valid_from, valid_to: c.valid_to,
    payment_terms: c.payment_terms, delivery_terms: c.delivery_terms,
  };
}

// ------------------------------------------------------------------ hold, close, clarifications
export function hold(actor: Actor, lineId: number, reason: string) {
  const l = mustLine(lineId);
  if (!OPEN_STATUSES.includes(l.status) || l.status === 'On hold') throw conflict(`Line is ${l.status.toLowerCase()}.`);
  update('pr_lines', lineId, { status: 'On hold', hold_reason: `${l.status}|${reason}` });
  audit(actor, { action: 'pr.on_hold', objectType: 'pr_line', objectId: lineId, objectRef: ref(l), before: { status: l.status }, reason });
  return getLine(lineId)!;
}
export function release(actor: Actor, lineId: number) {
  const l = mustLine(lineId);
  if (l.status !== 'On hold') throw conflict('Line is not on hold.');
  const prev = (l.hold_reason ?? '').split('|')[0] || 'Assigned';
  update('pr_lines', lineId, { status: prev, hold_reason: null });
  audit(actor, { action: 'pr.released_from_hold', objectType: 'pr_line', objectId: lineId, objectRef: ref(l), after: { status: prev } });
  return getLine(lineId)!;
}
export function closeLine(actor: Actor, lineId: number, reason: string) {
  const l = mustLine(lineId);
  if (['PO created', 'Closed'].includes(l.status)) throw conflict(`Line is already ${l.status.toLowerCase()}.`);
  if (l.status === 'RFQ in progress') throw conflict('Remove the line from its RFQ before closing it.');
  update('pr_lines', lineId, { status: 'Closed', closed_at: now(), hold_reason: reason });
  audit(actor, { action: 'pr.closed', objectType: 'pr_line', objectId: lineId, objectRef: ref(l), before: { status: l.status }, reason });
  notify({ event: 'NTF-03', title: `PR line ${ref(l)} closed by procurement`, body: reason, link: `/my-requirements?focus=${lineId}`, users: [l.requisitioner_id], objectType: 'pr_line', objectId: lineId });
  return getLine(lineId)!;
}

export function clarify(actor: Actor, lineId: number, body: string) {
  const l = mustLine(lineId);
  insert('comments', { object_type: 'pr_line', object_id: lineId, user_id: actor.id, body, internal: 1, created_at: now() });
  const fromReq = actor.id === l.requisitioner_id;
  if (!fromReq && OPEN_STATUSES.includes(l.status) && l.status !== 'Clarification pending' && !['RFQ in progress', 'Exception pending approval'].includes(l.status)) {
    update('pr_lines', lineId, { status: 'Clarification pending', hold_reason: `${l.status}|clarification` });
  } else if (fromReq && l.status === 'Clarification pending') {
    const prev = (l.hold_reason ?? '').split('|')[0] || 'Under review';
    update('pr_lines', lineId, { status: prev, hold_reason: null });
  }
  audit(actor, { action: 'pr.clarification_posted', objectType: 'pr_line', objectId: lineId, objectRef: ref(l), after: { from: fromReq ? 'requisitioner' : 'procurement' } });
  notify({
    event: 'NTF-03', title: `Clarification on ${ref(l)}`, body: body.slice(0, 160),
    link: fromReq ? `/pr/${lineId}` : `/my-requirements?focus=${lineId}`, users: [fromReq ? l.buyer_id : l.requisitioner_id],
    objectType: 'pr_line', objectId: lineId, dedupeKey: `NTF-03:${lineId}:${now()}`,
  });
  return getLine(lineId)!;
}

// ------------------------------------------------------------------ RFQ basket eligibility (PR-06, FR-PRW-09)
export function basketCheck(lineIds: number[], actorId?: number) {
  const grouping = cfg<{ same_buyer: boolean; same_plant: boolean; same_material_group: boolean }>('pr.grouping');
  const lines = lineIds.map((id) => getLine(id)).filter(Boolean) as PrLine[];
  const problems: { id: number; ref: string; problem: string }[] = [];
  if (lines.length !== lineIds.length) problems.push({ id: 0, ref: '—', problem: 'One or more lines no longer exist.' });
  for (const l of lines) {
    if (l.rfq_id) {
      const r = get<{ rfq_no: string; status: string }>('SELECT rfq_no, status FROM rfqs WHERE id = ?', l.rfq_id);
      if (r && !['Cancelled', 'Awarded', 'Re-floated'].includes(r.status)) problems.push({ id: l.id, ref: ref(l), problem: `Already in active RFQ ${r.rfq_no}` });
    }
    if (l.status !== 'Route decided' || !RFQ_ROUTES.includes(l.route as RouteName)) problems.push({ id: l.id, ref: ref(l), problem: l.status === 'Route decided' ? `Route ${l.route} does not go to RFQ` : `Status is ${l.status}; confirm an RFQ route first` });
    if (!l.checks) problems.push({ id: l.id, ref: ref(l), problem: 'Checks have not run' });
    if (l.checks && l.checks.open_po.lines.some((x) => x.open >= l.qty)) problems.push({ id: l.id, ref: ref(l), problem: `Covered by open PO ${l.checks.open_po.lines.find((x) => x.open >= l.qty)!.po_no}` });
    if (actorId && l.buyer_id !== actorId) problems.push({ id: l.id, ref: ref(l), problem: 'Assigned to another buyer' });
  }
  const distinct = (k: keyof PrLine) => new Set(lines.map((l) => l[k])).size;
  if (grouping.same_buyer && distinct('buyer_id') > 1) problems.push({ id: 0, ref: '—', problem: 'Lines belong to different buyers (grouping rule: same buyer).' });
  if (grouping.same_plant && distinct('plant') > 1) problems.push({ id: 0, ref: '—', problem: 'Lines are for different plants (grouping rule: same plant).' });
  if (grouping.same_material_group && distinct('material_group') > 1) problems.push({ id: 0, ref: '—', problem: 'Lines are from different material groups (grouping rule).' });
  return { ok: problems.length === 0, problems, lines };
}

// ------------------------------------------------------------------ queries
export function listLines(actor: Actor, q: Record<string, string | undefined>) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (!actor.perms.has('pr.view')) {
    where.push('l.requisitioner_id = ?');
    p.push(actor.id);
  }
  const view = q.view ?? 'all';
  if (view === 'mine') { where.push('l.buyer_id = ?'); p.push(actor.id); }
  if (view === 'unassigned') where.push("l.status = 'Unassigned'");
  if (view === 'open' || view === 'mine') where.push(`l.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`), p.push(...OPEN_STATUSES);
  if (view === 'priority') where.push("l.priority != 'Normal' AND l.status NOT IN ('PO created','Closed','Cancelled in SAP')");
  if (view === 'repeat') where.push('l.repeat_flag = 1');
  for (const [k, col] of [['status', 'l.status'], ['plant', 'l.plant'], ['priority', 'l.priority'], ['route', 'l.route'], ['category', 'l.category'], ['material_group', 'l.material_group']] as const) {
    if (q[k]) { where.push(`${col} = ?`); p.push(q[k]); }
  }
  if (q.buyer) { where.push('l.buyer_id = ?'); p.push(Number(q.buyer)); }
  if (q.material) { where.push('l.material_code = ?'); p.push(q.material); }
  if (q.q) { where.push('(l.pr_no LIKE ? OR l.description LIKE ? OR l.material_code LIKE ?)'); p.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const rows = all<PrLine & { buyer_name: string | null; requisitioner_name: string | null; rfq_no: string | null; rfq_status: string | null }>(
    `SELECT l.*, b.name AS buyer_name, r.name AS requisitioner_name, q.rfq_no, q.status AS rfq_status
     FROM pr_lines l LEFT JOIN users b ON b.id = l.buyer_id LEFT JOIN users r ON r.id = l.requisitioner_id LEFT JOIN rfqs q ON q.id = l.rfq_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE l.priority WHEN 'BD' THEN 0 WHEN 'Class 1' THEN 1 WHEN 'Urgent' THEN 2 ELSE 3 END, l.available_at`,
    ...p,
  );
  return rows.map(decorate);
}

export function decorate<T extends PrLine>(l: T) {
  const end = l.closed_at ?? (l.status === 'PO created' ? null : undefined);
  const age = daysBetween(l.available_at ?? l.sap_created_at ?? now(), end ?? new Date());
  return {
    ...l,
    ref: ref(l),
    age_days: age,
    est_value: l.est_unit_price != null ? Math.round(l.est_unit_price * l.qty) : null,
    sla_breached: !!l.sla_due && OPEN_STATUSES.includes(l.status) && new Date(l.sla_due).getTime() < Date.now(),
  };
}

export function lineDetail(actor: Actor, id: number) {
  const l = mustLine(id);
  if (!actor.perms.has('pr.view') && l.requisitioner_id !== actor.id) throw notFound('PR line');
  const own = !actor.perms.has('pr.view');
  const base = get<PrLine & { buyer_name: string | null; buyer_email: string | null; requisitioner_name: string | null }>(
    'SELECT l.*, b.name AS buyer_name, b.email AS buyer_email, r.name AS requisitioner_name FROM pr_lines l LEFT JOIN users b ON b.id = l.buyer_id LEFT JOIN users r ON r.id = l.requisitioner_id WHERE l.id = ?', id,
  )!;
  const material = l.material_id ? get('SELECT * FROM materials WHERE id = ?', l.material_id) : null;
  const decisions = own ? [] : all('SELECT d.*, u.name AS decided_by_name FROM route_decisions d LEFT JOIN users u ON u.id = d.decided_by WHERE pr_line_id = ? ORDER BY id DESC', id);
  const approvals = own ? [] : all("SELECT id, req_no, type, status, title, created_at, decided_at FROM approvals WHERE object_type = 'pr_line' AND object_id = ? ORDER BY id DESC", id);
  const rfq = l.rfq_id ? get('SELECT id, rfq_no, title, status, closing_at FROM rfqs WHERE id = ?', l.rfq_id) : null;
  const poLines = all<{ po_id: number; po_no: string; item: number; qty: number; ack_status: string; commit_date: string | null; delivery_date: string; received_qty: number; status: string; vendor: string; delay_reason: string | null; po_date: string }>(
    `SELECT p.id AS po_id, p.po_no, pl.item, pl.qty, pl.ack_status, pl.commit_date, pl.delivery_date, pl.received_qty, pl.status, ${own ? "'' AS vendor" : 'v.name AS vendor'}, pl.delay_reason, p.po_date
     FROM po_lines pl JOIN pos p ON p.id = pl.po_id JOIN vendors v ON v.id = p.vendor_id WHERE pl.pr_line_id = ?`, id,
  );
  const asns = poLines.length ? all(`SELECT a.id, a.asn_no, a.status, a.dispatch_date, a.expected_date FROM asns a WHERE a.po_id IN (${poLines.map(() => '?').join(',')}) AND a.status != 'Draft'`, ...poLines.map((x) => x.po_id)) : [];
  const comments = all('SELECT c.id, c.body, c.created_at, c.user_id, u.name AS user_name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.object_type = ? AND c.object_id = ? ORDER BY c.id', 'pr_line', id);
  const stock = l.material_id ? get('SELECT * FROM stock WHERE material_id = ? AND plant = ?', l.material_id, l.plant) : null;
  const contract = !own && l.contract_id ? get('SELECT c.id, c.contract_no, c.type, c.sap_oa_no, c.valid_to, v.name AS vendor FROM contracts c JOIN vendors v ON v.id = c.vendor_id WHERE c.id = ?', l.contract_id) : null;
  return {
    ...decorate(base),
    ...(own ? { est_unit_price: null, est_value: null, checks: null } : {}),
    material: own ? null : material, decisions, approvals, rfq, po_lines: poLines, asns, comments, stock: own ? null : stock, contract,
    freshness: { 'INT-M03': staleInfo('INT-M03', lastSuccess('INT-M03')), 'INT-M04': staleInfo('INT-M04', lastSuccess('INT-M04')), 'INT-M06': staleInfo('INT-M06', lastSuccess('INT-M06')) },
    sap_last_success: { 'INT-M03': lastSuccess('INT-M03'), 'INT-M04': lastSuccess('INT-M04'), 'INT-M06': lastSuccess('INT-M06') },
  };
}

/** Requisitioner view (PR-02, FR-POM-11, RPT-12): own lines with status, buyer, PO, dispatch. */
export function myRequirements(actor: Actor) {
  const lines = all<PrLine & { buyer_name: string | null; buyer_email: string | null; rfq_no: string | null; rfq_status: string | null; rfq_closing: string | null }>(
    `SELECT l.*, b.name AS buyer_name, b.email AS buyer_email, q.rfq_no, q.status AS rfq_status, q.closing_at AS rfq_closing
     FROM pr_lines l LEFT JOIN users b ON b.id = l.buyer_id LEFT JOIN rfqs q ON q.id = l.rfq_id
     WHERE l.requisitioner_id = ? ORDER BY l.available_at DESC`, actor.id,
  );
  return lines.map((l) => {
    const po = get<{ po_no: string; po_date: string; ack_status: string; commit_date: string | null; delivery_date: string; received_qty: number; qty: number; status: string; delay_reason: string | null; po_id: number }>(
      'SELECT p.po_no, p.po_date, p.id AS po_id, pl.ack_status, pl.commit_date, pl.delivery_date, pl.received_qty, pl.qty, pl.status, pl.delay_reason FROM po_lines pl JOIN pos p ON p.id = pl.po_id WHERE pl.pr_line_id = ? ORDER BY p.id DESC LIMIT 1', l.id,
    );
    const asn = po ? get<{ asn_no: string; status: string; expected_date: string }>("SELECT asn_no, status, expected_date FROM asns WHERE po_id = ? AND status NOT IN ('Draft','Cancelled') ORDER BY id DESC LIMIT 1", po.po_id) : undefined;
    const lastComment = get<{ body: string; created_at: string; name: string }>("SELECT c.body, c.created_at, u.name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.object_type = 'pr_line' AND c.object_id = ? ORDER BY c.id DESC LIMIT 1", l.id);
    const d = decorate(l);
    return {
      id: l.id, ref: d.ref, pr_no: l.pr_no, item: l.item, description: l.description, qty: l.qty, uom: l.uom, plant: l.plant,
      required_date: l.required_date, priority: l.priority, status: l.status, route: l.route, buyer_name: l.buyer_name, buyer_email: l.buyer_email,
      age_days: d.age_days, rfq_no: l.rfq_no, rfq_status: l.rfq_status, rfq_closing: l.rfq_closing,
      expected_po_date: po?.po_date ?? l.sla_due?.slice(0, 10) ?? null, expected_po_basis: po ? 'PO created' : l.sla_due ? 'Priority SLA target' : null,
      po_no: po?.po_no ?? l.po_no, po_status: po?.status ?? null, ack_status: po?.ack_status ?? null, commit_date: po?.commit_date ?? null,
      delivery_date: po?.delivery_date ?? null, received_qty: po?.received_qty ?? null, delay_reason: po?.delay_reason ?? null,
      asn_no: asn?.asn_no ?? null, asn_status: asn?.status ?? null, asn_expected: asn?.expected_date ?? null,
      flag: l.flag, latest_remark: lastComment ? { body: lastComment.body, at: lastComment.created_at, by: lastComment.name } : null,
    };
  });
}

export function ageing(actor: Actor, by: string) {
  const dims: Record<string, string> = { buyer: "COALESCE(b.name, 'Unassigned')", plant: 'l.plant', material_group: "COALESCE(l.material_group, '—')", priority: 'l.priority', route: "COALESCE(l.route, 'Not routed')", category: "COALESCE(l.category, '—')" };
  const dim = dims[by] ?? dims.buyer;
  const lines = all<{ key: string; available_at: string; id: number }>(
    `SELECT ${dim} AS key, l.available_at, l.id FROM pr_lines l LEFT JOIN users b ON b.id = l.buyer_id
     WHERE l.status IN (${OPEN_STATUSES.map(() => '?').join(',')}) ${actor.perms.has('pr.view') ? '' : 'AND l.requisitioner_id = ' + actor.id}`,
    ...OPEN_STATUSES,
  );
  const buckets = ['0–3 days', '4–7 days', '8–15 days', '> 15 days'];
  const map = new Map<string, { key: string; total: number; counts: number[]; ids: number[][]; maxAge: number }>();
  for (const l of lines) {
    const age = daysBetween(l.available_at);
    const b = age <= 3 ? 0 : age <= 7 ? 1 : age <= 15 ? 2 : 3;
    const row = map.get(l.key) ?? { key: l.key, total: 0, counts: [0, 0, 0, 0], ids: [[], [], [], []], maxAge: 0 };
    row.total++;
    row.counts[b]++;
    row.ids[b].push(l.id);
    row.maxAge = Math.max(row.maxAge, age);
    map.set(l.key, row);
  }
  return { by, buckets, rows: [...map.values()].sort((a, b) => b.total - a.total), total: lines.length };
}

/** Scheduler: PR ageing breach (NTF-02) and priority SLA breach. */
export function ageingJob() {
  const days = cfg<number>('pr.ageing_alert_days');
  const lines = all<PrLine>(`SELECT * FROM pr_lines WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})`, ...OPEN_STATUSES);
  let n = 0;
  for (const l of lines) {
    const age = daysBetween(l.available_at ?? now());
    if (age >= days) {
      n += notify({ event: 'NTF-02', title: `PR line ${ref(l)} is ${age} days old`, body: `${l.description} — ${l.status}`, link: `/pr/${l.id}`, users: [l.buyer_id], objectType: 'pr_line', objectId: l.id, dedupeKey: `NTF-02:${l.id}:${age >= days * 2 ? 2 : 1}`, severity: 'warning' }).length;
      if (age >= days * 2) n += notify({ event: 'NTF-02', title: `Escalation: PR line ${ref(l)} ${age} days old`, body: `${l.description} — buyer ${l.buyer_id ? 'assigned' : 'not assigned'}`, link: `/pr/${l.id}`, roles: ['APR'], objectType: 'pr_line', objectId: l.id, dedupeKey: `NTF-02m:${l.id}`, severity: 'danger' }).length;
    }
    if (l.sla_due && new Date(l.sla_due).getTime() < Date.now()) {
      n += notify({ event: 'NTF-02', title: `${l.priority} SLA breached: ${ref(l)}`, body: l.description, link: `/pr/${l.id}`, users: [l.buyer_id], roles: ['APR'], objectType: 'pr_line', objectId: l.id, dedupeKey: `NTF-02sla:${l.id}`, severity: 'danger' }).length;
    }
  }
  return `${lines.length} open lines checked, ${n} notifications`;
}

export function summary(actor: Actor) {
  const mine = actor.role === 'BUY';
  const cond = mine ? 'AND buyer_id = ' + actor.id : '';
  const count = (sql: string, ...p: unknown[]) => scalar<number>(sql, ...p) ?? 0;
  const open = OPEN_STATUSES.map(() => '?').join(',');
  return {
    open: count(`SELECT COUNT(*) FROM pr_lines WHERE status IN (${open}) ${cond}`, ...OPEN_STATUSES),
    unassigned: count("SELECT COUNT(*) FROM pr_lines WHERE status = 'Unassigned'"),
    to_review: count(`SELECT COUNT(*) FROM pr_lines WHERE status IN ('Assigned','Under review') ${cond}`),
    priority: count(`SELECT COUNT(*) FROM pr_lines WHERE priority != 'Normal' AND status IN (${open}) ${cond}`, ...OPEN_STATUSES),
    sla_breached: count(`SELECT COUNT(*) FROM pr_lines WHERE sla_due < ? AND status IN (${open}) ${cond}`, now(), ...OPEN_STATUSES),
    repeat: count(`SELECT COUNT(*) FROM pr_lines WHERE repeat_flag = 1 AND status IN (${open}) ${cond}`, ...OPEN_STATUSES),
    ready_for_rfq: count(`SELECT COUNT(*) FROM pr_lines WHERE status = 'Route decided' ${cond}`),
    contract_po_pending: count(`SELECT COUNT(*) FROM pr_lines WHERE status = 'Contract/VMI PO pending' ${cond}`),
    clarification: count(`SELECT COUNT(*) FROM pr_lines WHERE status = 'Clarification pending' ${cond}`),
  };
}
