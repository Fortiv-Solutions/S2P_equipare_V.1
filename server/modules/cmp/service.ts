/**
 * Module 4 — Comparative statement, landed cost and award recommendation (FR-CMP-01..08, CMP-01..06).
 *
 * Lifecycle (statuses.ts): Draft → Recommendation recorded → Submitted for approval →
 * Approved | Returned | Rejected → Released for PO (the PO itself is created in SAP — DEC-05).
 *
 *  - Generated only from Locked / Final quotations (`quotations.lines_json` contract, ENGINEERING.md).
 *  - The parameter snapshot used (landed-cost components, DEC-21) is stored in `params_json`.
 *  - Late / risk discounts (CMP-03, DEC-18) are separate per vendor-line entries that apply only after
 *    a `cmp.discount` approval.
 *  - A recommendation that is not the lowest landed cost needs a reason and raises an `exc.deviation`
 *    approval next to the value-based `cmp.award` approval (CMP-05). Approved only when all are approved.
 */
import { all, get, insert, update, J, now, tx, round2, daysBetween } from '../../core/db.ts';
import { audit } from '../../core/audit.ts';
import { notify } from '../../core/notify.ts';
import { cfg } from '../../core/config.ts';
import { badRequest, conflict, notFound, HttpError } from '../../core/http.ts';
import { createApproval, getApproval, withdraw, type ApprovalRow } from '../../core/approvals.ts';
import { nextNo } from '../../core/numbering.ts';
import { storeGenerated } from '../../core/files.ts';
import { permsFor, type Role } from '../../core/permissions.ts';
import { validContract } from '../pr/service.ts';
import { landedCost, variance } from './landed.ts';
import type { Actor } from '../../core/auth.ts';

export const EDITABLE = ['Draft', 'Recommendation recorded', 'Returned'];

// ------------------------------------------------------------------ types
export interface QuoteLine {
  rfq_line_id: number;
  no_quote?: boolean;
  quoted_qty?: number | null;
  basic_price?: number | null;
  discount_pct?: number | null;
  gst_rate?: number | null;
  freight?: number | null;
  packing?: number | null;
  delivery_days?: number | null;
  make_brand?: string | null;
  warranty?: string | null;
  alternate?: boolean;
  partial?: boolean;
  remarks?: string | null;
}
interface QuotationRow {
  id: number; rfq_id: number; vendor_id: number; status: string; version: number; ref_no: string | null; submitted_at: string | null;
  lines: QuoteLine[] | null; validity_date: string | null; payment_terms: string | null; credit_days: number | null;
  delivery_terms: string | null; remarks: string | null; updated_at: string | null;
}
interface RfqRow {
  id: number; rfq_no: string; title: string | null; buyer_id: number | null; status: string; category: string | null; plant: string | null;
  closing_at: string | null; delivery_terms: string | null; payment_terms: string | null; closed_at: string | null; created_at: string | null;
}
interface RfqLineRow {
  id: number; rfq_id: number; line_no: number | null; pr_line_id: number | null; material_id: number | null; description: string | null;
  qty: number; uom: string | null; required_date: string | null; plant: string | null; gst_rate: number | null; status: string | null;
}

export interface LandedParams {
  gst_impact: string;
  payment_term_adjustment: { enabled: boolean; rate_pct: number; reference_days: number };
  exw_freight_estimate_pct: number;
}
export interface Params {
  landed_cost: LandedParams;
  discounts: { late_discount: string; risk_discount: string; approval_required: boolean };
  split_by_qty: boolean;
  snapshot_at: string;
  quotation_fingerprint: string;
  quotations: { id: number; vendor_id: number; version: number; status: string; ref_no: string | null }[];
  /** Alternate / partial quotes the buyer marked acceptable: `${rfq_line_id}:${vendor_id}`. */
  acceptable: string[];
  acceptable_reasons?: Record<string, string>;
}

export interface DiscountEntry {
  rfq_line_id: number;
  vendor_id: number;
  late: number;
  risk: number;
  reason: string;
  status: 'Draft' | 'Pending approval' | 'Approved' | 'Rejected' | 'Withdrawn' | 'Returned';
  approval_id: number | null;
  requested_by: number;
  requested_at: string;
  decided_at?: string | null;
}

export interface Cell {
  vendor_id: number;
  vendor_name: string;
  sap_code: string | null;
  quotation_id: number;
  quotation_ref: string | null;
  quotation_version: number;
  no_quote: boolean;
  quoted_qty: number | null;
  basic_price: number | null;
  discount_pct: number | null;
  net_unit: number | null;
  gst_rate: number | null;
  gamma: number;
  freight_quoted: number;
  freight_estimate: number;
  freight: number;
  packing: number;
  basic_value: number | null;
  taxable: number | null;
  gst_amount: number | null;
  gst_impact: number | null;
  pta: number | null;
  ld: number;
  rd: number;
  ld_pending: number;
  rd_pending: number;
  landed_before_discounts: number | null;
  landed: number | null;
  unit_landed: number | null;
  delivery_days: number | null;
  delivery_terms: string | null;
  credit_days: number | null;
  payment_terms: string | null;
  make_brand: string | null;
  warranty: string | null;
  alternate: boolean;
  partial: boolean;
  acceptable: boolean;
  remarks: string | null;
  eligible: boolean;
  rank: number | null;
  alt_rank: number | null;
  lowest: boolean;
  var_lpp_pct: number | null;
  var_contract_pct: number | null;
  var_budget_pct: number | null;
  var_lowest_pct: number | null;
  performance_score: number | null;
}

export interface Row {
  rfq_line_id: number;
  line_no: number;
  pr_line_id: number | null;
  pr_ref: string | null;
  pr_priority: string | null;
  material_id: number | null;
  material_code: string | null;
  description: string;
  qty: number;
  uom: string | null;
  plant: string | null;
  required_date: string | null;
  category: string | null;
  gamma: number;
  gamma_basis: string;
  lpp: number | null;
  lpp_date: string | null;
  lpp_vendor: string | null;
  budget_price: number | null;
  contract: { id: number; contract_no: string; type: string; sap_oa_no: string | null; vendor: string; unit_price: number | null; valid_to: string } | null;
  cells: Cell[];
  lowest_vendor_ids: number[];
  lowest_unit_landed: number | null;
  fastest_vendor_id: number | null;
}

export interface VendorSummary {
  vendor_id: number;
  name: string;
  sap_code: string | null;
  quotation_id: number;
  quotation_ref: string | null;
  quotation_status: string;
  version: number;
  lines_quoted: number;
  lines_total: number;
  complete: boolean;
  total_landed: number;
  lowest_lines: number;
  delivery_terms: string | null;
  payment_terms: string | null;
  credit_days: number | null;
  validity_date: string | null;
  performance_score: number | null;
  remarks: string | null;
}

export interface Coverage {
  invited: number;
  responded: number;
  declined: number;
  non_participating: number;
  coverage_pct: number | null;
  vendors: { vendor_id: number; name: string; sap_code: string | null; status: 'Responded' | 'Declined' | 'Non-participating'; detail: string | null; lines_quoted: number }[];
}

export interface Award {
  rfq_line_id: number;
  pr_line_id: number | null;
  vendor_id: number;
  vendor_name?: string;
  qty: number;
  /** Basic unit price after discount. */
  unit_price: number;
  gst_rate: number;
  /** Freight for the awarded quantity (pro-rata of the quoted line freight). */
  freight: number;
  landed_unit: number;
  landed_total?: number;
  lowest: boolean;
  reason: string | null;
  delivery_days?: number | null;
}

export interface Summary {
  vendors: VendorSummary[];
  coverage: Coverage;
  lines: number;
  lowest_total: number;
  computed_at: string;
  superseded_by?: number | null;
  supersedes?: number | null;
  recommendation?: {
    by: number; by_name: string; at: string; total_landed: number; lowest_total: number; difference: number;
    skipped: { rfq_line_id: number; reason: string }[]; deviation_lines: number;
  } | null;
  submission?: { at: string; by: number; approval_ids: number[]; award_approval_id: number; deviation_approval_id: number | null; round: number } | null;
  released?: { at: string; by: number; by_name: string } | null;
  pdf_attachment_id?: number | null;
  note?: string | null;
}

export interface ComparisonRow {
  id: number; cmp_no: string; rfq_id: number; version: number; status: string;
  params: Params; rows: Row[] | null; summary: Summary | null; awards: Award[] | null;
  justification: string | null; deviation: number; deviation_reason: string | null; late_discount: DiscountEntry[] | null;
  approval_id: number | null; created_by: number; created_at: string; submitted_at: string | null; decided_at: string | null; sap_handoff_at: string | null;
}

// ------------------------------------------------------------------ helpers
export function getComparison(id: number) {
  return get<ComparisonRow>('SELECT * FROM comparisons WHERE id = ?', id);
}
function mustComparison(id: number) {
  const c = getComparison(id);
  if (!c) throw notFound('Comparison');
  return c;
}
function mustRfq(id: number) {
  const r = get<RfqRow>('SELECT * FROM rfqs WHERE id = ?', id);
  if (!r) throw notFound('RFQ');
  return r;
}
const label = (c: Pick<ComparisonRow, 'cmp_no' | 'version'>) => `${c.cmp_no} v${c.version}`;
const inr = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Math.round(n));

function lockedQuotations(rfqId: number) {
  return all<QuotationRow>("SELECT * FROM quotations WHERE rfq_id = ? AND status IN ('Locked','Final') ORDER BY vendor_id", rfqId);
}
function fingerprint(qs: QuotationRow[]) {
  return qs.map((q) => `${q.id}:${q.version}:${q.status}:${q.updated_at ?? ''}`).join('|');
}
function rfqLines(rfqId: number) {
  return all<RfqLineRow>("SELECT * FROM rfq_lines WHERE rfq_id = ? AND COALESCE(status, 'Active') NOT IN ('Removed','Cancelled') ORDER BY COALESCE(line_no, id), id", rfqId);
}

/** Actor for the system to act as a given user (used to withdraw sibling requests the user raised). */
function actorById(id: number): Actor | null {
  const u = get<{ id: number; name: string; email: string; roles: string; vendor_id: number | null; department: string | null }>('SELECT * FROM users WHERE id = ?', id);
  if (!u) return null;
  const roles = u.roles.split(',') as Role[];
  return { id: u.id, name: u.name, email: u.email, roles, role: roles[0], perms: permsFor(roles[0]), vendorId: null, plants: '*', categories: [], department: u.department, sessionId: 'system', channel: 'system' };
}

function snapshotParams(fp: string, qs: QuotationRow[], acceptable: string[] = [], reasons: Record<string, string> = {}): Params {
  return {
    landed_cost: cfg<LandedParams>('cmp.landed_cost'),
    discounts: cfg<Params['discounts']>('cmp.discounts'),
    split_by_qty: !!cfg<{ enabled: boolean }>('cmp.split_award_by_qty')?.enabled,
    snapshot_at: now(),
    quotation_fingerprint: fp,
    quotations: qs.map((q) => ({ id: q.id, vendor_id: q.vendor_id, version: q.version, status: q.status, ref_no: q.ref_no })),
    acceptable,
    acceptable_reasons: reasons,
  };
}

function gammaFor(mode: string, category: string | null): { gamma: number; basis: string } {
  if (mode === 'always_cost' || mode === 'include') return { gamma: 1, basis: 'γ = 1: GST treated as a cost for all purchases (configuration)' };
  if (mode === 'recoverable' || mode === 'exclude') return { gamma: 0, basis: 'γ = 0: GST treated as recoverable for all purchases (configuration)' };
  const c = category ? get<{ name: string; itc_recoverable: number }>('SELECT name, itc_recoverable FROM spend_categories WHERE code = ?', category) : undefined;
  if (!c) return { gamma: 1, basis: 'γ = 1: spend category unknown, GST treated as a cost' };
  return c.itc_recoverable
    ? { gamma: 0, basis: `γ = 0: input tax credit recoverable for ${c.name} (${category})` }
    : { gamma: 1, basis: `γ = 1: input tax credit not available for ${c.name} (${category}) — GST is a cost` };
}

// ------------------------------------------------------------------ computation (FR-CMP-01..04, 06)
export function compute(rfqId: number, params: Params, discounts: DiscountEntry[]) {
  const lines = rfqLines(rfqId);
  const quotes = all<QuotationRow & { vendor_name: string; sap_code: string | null; performance_score: number | null }>(
    `SELECT q.*, v.name AS vendor_name, v.sap_code, v.performance_score FROM quotations q JOIN vendors v ON v.id = q.vendor_id
     WHERE q.id IN (${params.quotations.map(() => '?').join(',') || 'NULL'}) ORDER BY v.name`,
    ...params.quotations.map((q) => q.id),
  );
  const lc = params.landed_cost;
  const acceptable = new Set(params.acceptable);
  const rows: Row[] = [];
  for (const [idx, l] of lines.entries()) {
    const pr = l.pr_line_id ? get<{ pr_no: string; item: number; category: string | null; priority: string; material_code: string | null; plant: string }>('SELECT pr_no, item, category, priority, material_code, plant FROM pr_lines WHERE id = ?', l.pr_line_id) : undefined;
    const mat = l.material_id ? get<{ id: number; code: string; category: string | null; lpp: number | null; lpp_date: string | null; lpp_vendor_id: number | null; budget_price: number | null; description: string }>('SELECT * FROM materials WHERE id = ?', l.material_id) : undefined;
    const category = mat?.category ?? pr?.category ?? null;
    const g = gammaFor(lc.gst_impact, category);
    const plant = l.plant ?? pr?.plant ?? null;
    const ctr = mat && plant ? validContract(mat.id, plant) : undefined;
    const lppVendor = mat?.lpp_vendor_id ? get<{ name: string }>('SELECT name FROM vendors WHERE id = ?', mat.lpp_vendor_id)?.name ?? null : null;
    const cells: Cell[] = quotes.map((q) => {
      const ql = (q.lines ?? []).find((x) => x.rfq_line_id === l.id);
      const base = {
        vendor_id: q.vendor_id, vendor_name: q.vendor_name, sap_code: q.sap_code, quotation_id: q.id, quotation_ref: q.ref_no, quotation_version: q.version,
        delivery_terms: q.delivery_terms, credit_days: q.credit_days, payment_terms: q.payment_terms, performance_score: q.performance_score,
      };
      if (!ql || ql.no_quote || ql.basic_price == null) {
        return {
          ...base, no_quote: true, quoted_qty: null, basic_price: null, discount_pct: null, net_unit: null, gst_rate: null, gamma: g.gamma,
          freight_quoted: 0, freight_estimate: 0, freight: 0, packing: 0, basic_value: null, taxable: null, gst_amount: null, gst_impact: null, pta: null,
          ld: 0, rd: 0, ld_pending: 0, rd_pending: 0, landed_before_discounts: null, landed: null, unit_landed: null, delivery_days: null, make_brand: null, warranty: null,
          alternate: false, partial: false, acceptable: false, remarks: ql?.remarks ?? null, eligible: false, rank: null, alt_rank: null, lowest: false,
          var_lpp_pct: null, var_contract_pct: null, var_budget_pct: null, var_lowest_pct: null,
        } satisfies Cell;
      }
      const qty = ql.quoted_qty && ql.quoted_qty > 0 ? ql.quoted_qty : l.qty;
      const d = ql.discount_pct ?? 0;
      const basicValue = ql.basic_price * (1 - d / 100) * qty;
      const exw = /ex.?works/i.test(q.delivery_terms ?? '') && lc.exw_freight_estimate_pct > 0 ? round2(basicValue * (lc.exw_freight_estimate_pct / 100)) : 0;
      const freightQuoted = ql.freight ?? 0;
      const disc = discounts.filter((x) => x.rfq_line_id === l.id && x.vendor_id === q.vendor_id);
      const approved = disc.filter((x) => x.status === 'Approved');
      const pending = disc.filter((x) => x.status === 'Pending approval' || x.status === 'Draft');
      const r = landedCost({
        P: ql.basic_price, d, q: qty, F: freightQuoted + exw, K: ql.packing ?? 0, G: ql.gst_rate ?? 0, gamma: g.gamma,
        pta: { ...lc.payment_term_adjustment, credit_days: q.credit_days },
        LD: approved.reduce((s, x) => s + x.late, 0), RD: approved.reduce((s, x) => s + x.risk, 0),
      });
      const alt = !!ql.alternate;
      const partial = !!ql.partial || (ql.quoted_qty != null && ql.quoted_qty > 0 && ql.quoted_qty < l.qty);
      const isAcc = acceptable.has(`${l.id}:${q.vendor_id}`);
      return {
        ...base, no_quote: false, quoted_qty: qty, basic_price: ql.basic_price, discount_pct: d, net_unit: r.net_unit, gst_rate: ql.gst_rate ?? 0, gamma: g.gamma,
        freight_quoted: freightQuoted, freight_estimate: exw, freight: round2(freightQuoted + exw), packing: ql.packing ?? 0, basic_value: r.basic_value, taxable: r.taxable,
        gst_amount: r.gst_amount, gst_impact: r.gst_impact, pta: r.pta, ld: r.ld, rd: r.rd,
        ld_pending: pending.reduce((s, x) => s + x.late, 0), rd_pending: pending.reduce((s, x) => s + x.risk, 0),
        landed_before_discounts: r.landed_before_discounts, landed: r.landed, unit_landed: r.unit_landed,
        delivery_days: ql.delivery_days ?? null, make_brand: ql.make_brand ?? null, warranty: ql.warranty ?? null, alternate: alt, partial, acceptable: isAcc,
        remarks: ql.remarks ?? null, eligible: !(alt || partial) || isAcc, rank: null, alt_rank: null, lowest: false,
        var_lpp_pct: variance(r.net_unit, mat?.lpp), var_contract_pct: variance(r.net_unit, ctr?.unit_price), var_budget_pct: variance(r.net_unit, mat?.budget_price), var_lowest_pct: null,
      } satisfies Cell;
    });
    // Ranking: eligible quotes by unit landed cost; alternates / partials not marked acceptable ranked separately.
    const rankGroup = (group: Cell[], key: 'rank' | 'alt_rank') => {
      const sorted = [...group].sort((a, b) => (a.unit_landed ?? 0) - (b.unit_landed ?? 0));
      let rank = 0;
      let prev: number | null = null;
      sorted.forEach((c, i) => {
        if (prev === null || Math.abs((c.unit_landed ?? 0) - prev) >= 0.005) rank = i + 1;
        c[key] = rank;
        prev = c.unit_landed ?? 0;
      });
    };
    const eligible = cells.filter((c) => c.eligible);
    rankGroup(eligible, 'rank');
    rankGroup(cells.filter((c) => !c.no_quote && !c.eligible), 'alt_rank');
    const min = eligible.length ? Math.min(...eligible.map((c) => c.unit_landed ?? Infinity)) : null;
    for (const c of eligible) if (min != null && Math.abs((c.unit_landed ?? 0) - min) < 0.005) c.lowest = true;
    for (const c of cells) if (!c.no_quote && min) c.var_lowest_pct = variance(c.unit_landed, min);
    const fastest = [...eligible].filter((c) => c.delivery_days != null).sort((a, b) => (a.delivery_days! - b.delivery_days!) || ((a.unit_landed ?? 0) - (b.unit_landed ?? 0)))[0];
    rows.push({
      rfq_line_id: l.id, line_no: l.line_no ?? (idx + 1) * 10, pr_line_id: l.pr_line_id, pr_ref: pr ? `${pr.pr_no}/${pr.item}` : null, pr_priority: pr?.priority ?? null,
      material_id: l.material_id, material_code: mat?.code ?? pr?.material_code ?? null, description: l.description ?? mat?.description ?? 'Line',
      qty: l.qty, uom: l.uom, plant, required_date: l.required_date, category, gamma: g.gamma, gamma_basis: g.basis,
      lpp: mat?.lpp ?? null, lpp_date: mat?.lpp_date ?? null, lpp_vendor: lppVendor, budget_price: mat?.budget_price ?? null,
      contract: ctr ? { id: ctr.id, contract_no: ctr.contract_no, type: ctr.type, sap_oa_no: ctr.sap_oa_no, vendor: ctr.vendor, unit_price: ctr.unit_price, valid_to: ctr.valid_to } : null,
      cells, lowest_vendor_ids: eligible.filter((c) => c.lowest).map((c) => c.vendor_id), lowest_unit_landed: min, fastest_vendor_id: fastest?.vendor_id ?? null,
    });
  }
  const vendors: VendorSummary[] = quotes.map((q) => {
    const cs = rows.map((r) => r.cells.find((c) => c.vendor_id === q.vendor_id)!).filter((c) => c && !c.no_quote);
    return {
      vendor_id: q.vendor_id, name: q.vendor_name, sap_code: q.sap_code, quotation_id: q.id, quotation_ref: q.ref_no, quotation_status: q.status, version: q.version,
      lines_quoted: cs.length, lines_total: rows.length, complete: cs.length === rows.length, total_landed: round2(cs.reduce((s, c) => s + (c.landed ?? 0), 0)),
      lowest_lines: rows.filter((r) => r.lowest_vendor_ids.includes(q.vendor_id)).length,
      delivery_terms: q.delivery_terms, payment_terms: q.payment_terms, credit_days: q.credit_days, validity_date: q.validity_date, performance_score: q.performance_score, remarks: q.remarks,
    };
  });
  const coverage = coverageFor(rfqId, params.quotations.map((q) => q.vendor_id), vendors);
  const lowestTotal = round2(rows.reduce((s, r) => s + (r.lowest_unit_landed != null ? r.lowest_unit_landed * r.qty : 0), 0));
  return { rows, vendors, coverage, lowest_total: lowestTotal };
}

/** Enquiry coverage (CMP-06): invited, responded, declined, non-participating with names. */
export function coverageFor(rfqId: number, respondedIds: number[], vendors: VendorSummary[]): Coverage {
  const inv = all<{ vendor_id: number; status: string; decline_reason: string | null; name: string; sap_code: string | null; declined_at: string | null }>(
    'SELECT i.vendor_id, i.status, i.decline_reason, i.declined_at, v.name, v.sap_code FROM rfq_invitations i JOIN vendors v ON v.id = i.vendor_id WHERE i.rfq_id = ? ORDER BY v.name', rfqId,
  );
  const qStatus = new Map(all<{ vendor_id: number; status: string }>('SELECT vendor_id, status FROM quotations WHERE rfq_id = ?', rfqId).map((q) => [q.vendor_id, q.status]));
  const out: Coverage['vendors'] = inv.map((i) => {
    const vs = vendors.find((v) => v.vendor_id === i.vendor_id);
    if (respondedIds.includes(i.vendor_id)) return { vendor_id: i.vendor_id, name: i.name, sap_code: i.sap_code, status: 'Responded', detail: vs ? `${vs.lines_quoted} of ${vs.lines_total} lines quoted` : null, lines_quoted: vs?.lines_quoted ?? 0 };
    if (i.status === 'Declined' || qStatus.get(i.vendor_id) === 'Declined') return { vendor_id: i.vendor_id, name: i.name, sap_code: i.sap_code, status: 'Declined', detail: i.decline_reason ?? 'No reason given', lines_quoted: 0 };
    const qs = qStatus.get(i.vendor_id);
    return { vendor_id: i.vendor_id, name: i.name, sap_code: i.sap_code, status: 'Non-participating', detail: qs ? `Quotation ${qs.toLowerCase()} — not submitted before closing` : `Invitation ${i.status.toLowerCase()}, no quotation`, lines_quoted: 0 };
  });
  // Vendors with a locked quotation but no invitation row (should not happen) still count as responded.
  for (const v of vendors) if (!out.some((o) => o.vendor_id === v.vendor_id)) out.push({ vendor_id: v.vendor_id, name: v.name, sap_code: v.sap_code, status: 'Responded', detail: `${v.lines_quoted} of ${v.lines_total} lines quoted`, lines_quoted: v.lines_quoted });
  const n = (s: string) => out.filter((o) => o.status === s).length;
  return { invited: out.length, responded: n('Responded'), declined: n('Declined'), non_participating: n('Non-participating'), coverage_pct: out.length ? n('Responded') / out.length : null, vendors: out };
}

/** Recompute rows/summary for an existing comparison from its parameter snapshot. */
export function recompute(id: number) {
  const c = mustComparison(id);
  const r = compute(c.rfq_id, c.params, c.late_discount ?? []);
  const summary: Summary = { ...(c.summary ?? {} as Summary), vendors: r.vendors, coverage: r.coverage, lines: r.rows.length, lowest_total: r.lowest_total, computed_at: now() };
  // Re-derive award figures from the fresh rows.
  const awards = (c.awards ?? []).map((a) => deriveAward(r.rows, a.rfq_line_id, a.vendor_id, a.qty, a.reason));
  update('comparisons', id, { rows_json: J(r.rows), summary_json: J(summary), awards_json: c.awards ? J(awards) : null });
  return getComparison(id)!;
}

function deriveAward(rows: Row[], lineId: number, vendorId: number, qty: number, reason: string | null): Award {
  const row = rows.find((r) => r.rfq_line_id === lineId);
  if (!row) throw badRequest(`RFQ line ${lineId} is not part of this comparison.`);
  const cell = row.cells.find((c) => c.vendor_id === vendorId);
  if (!cell || cell.no_quote) throw badRequest(`${cell?.vendor_name ?? 'This vendor'} did not quote line ${row.line_no} (${row.description}).`, { awards: 'Choose a vendor who quoted this line' });
  const freight = cell.quoted_qty ? round2((cell.freight + cell.packing) * (qty / cell.quoted_qty)) : 0;
  return {
    rfq_line_id: lineId, pr_line_id: row.pr_line_id, vendor_id: vendorId, vendor_name: cell.vendor_name, qty, unit_price: cell.net_unit ?? 0, gst_rate: cell.gst_rate ?? 0,
    freight, landed_unit: cell.unit_landed ?? 0, landed_total: round2((cell.unit_landed ?? 0) * qty), lowest: cell.lowest, reason, delivery_days: cell.delivery_days,
  };
}

// ------------------------------------------------------------------ generation (FR-CMP-01)
export function eligibility(rfqId: number) {
  const rfq = mustRfq(rfqId);
  const inv = all<{ status: string }>('SELECT status FROM rfq_invitations WHERE rfq_id = ?', rfqId);
  const allResponded = inv.length > 0 && inv.every((i) => ['Responded', 'Declined'].includes(i.status));
  const locked = lockedQuotations(rfqId);
  const latest = latestFor(rfqId);
  let ok = true;
  let reason: string | null = null;
  if (!['Closed', 'Under comparison', 'Awarded'].includes(rfq.status) && !(rfq.status === 'Published' && allResponded)) {
    ok = false;
    reason = `RFQ is ${rfq.status.toLowerCase()}. A comparison can be generated once the RFQ is closed (or every invited vendor has responded).`;
  } else if (!locked.length) {
    ok = false;
    reason = 'No locked quotations. Quotations lock when the RFQ closes; only locked or final quotations are compared.';
  }
  const fp = fingerprint(locked);
  const stale = !!latest && latest.params?.quotation_fingerprint !== fp;
  return { rfq, ok, reason, locked: locked.length, invited: inv.length, all_responded: allResponded, latest: latest ? { id: latest.id, cmp_no: latest.cmp_no, version: latest.version, status: latest.status } : null, quotes_changed: stale };
}

export function latestFor(rfqId: number) {
  return get<ComparisonRow>('SELECT * FROM comparisons WHERE rfq_id = ? ORDER BY version DESC, id DESC LIMIT 1', rfqId);
}

export function generate(actor: Actor, rfqId: number) {
  const el = eligibility(rfqId);
  if (!el.ok) throw new HttpError(409, 'not_eligible', el.reason!);
  const rfq = el.rfq;
  const latest = latestFor(rfqId);
  const qs = lockedQuotations(rfqId);
  const fp = fingerprint(qs);
  if (latest && latest.params?.quotation_fingerprint === fp) return { id: latest.id, created: false, comparison: latest };
  if (latest && ['Approved', 'Released for PO'].includes(latest.status)) {
    throw conflict(`${label(latest)} is already ${latest.status.toLowerCase()}. Quotations changed afterwards — cancel or re-float the RFQ instead of re-comparing.`);
  }
  return tx(() => {
    const ts = now();
    const params = snapshotParams(fp, qs, latest?.params?.acceptable ?? [], latest?.params?.acceptable_reasons ?? {});
    const r = compute(rfqId, params, []);
    const version = (latest?.version ?? 0) + 1;
    const cmpNo = latest?.cmp_no ?? nextNo('CMP');
    const summary: Summary = { vendors: r.vendors, coverage: r.coverage, lines: r.rows.length, lowest_total: r.lowest_total, computed_at: ts, supersedes: latest?.id ?? null };
    const id = insert('comparisons', {
      cmp_no: cmpNo, rfq_id: rfqId, version, status: 'Draft', params_json: J(params), rows_json: J(r.rows), summary_json: J(summary),
      awards_json: null, late_discount_json: J([]), deviation: 0, created_by: actor.id, created_at: ts,
    });
    if (latest) {
      // Re-generation after a reopen: the old version is superseded; its pending approvals are withdrawn.
      update('comparisons', latest.id, { summary_json: J({ ...(latest.summary ?? {}), superseded_by: id }) });
      withdrawOpen(latest.id, `Superseded by ${cmpNo} v${version} after quotations changed`);
      audit(actor, { action: 'cmp.superseded', objectType: 'comparison', objectId: latest.id, objectRef: label(latest), after: { superseded_by: id, version } });
    }
    if (!['Under comparison', 'Awarded'].includes(rfq.status)) {
      update('rfqs', rfqId, { status: 'Under comparison' });
      audit(actor, { action: 'rfq.under_comparison', objectType: 'rfq', objectId: rfqId, objectRef: rfq.rfq_no, before: { status: rfq.status }, after: { status: 'Under comparison', comparison: `${cmpNo} v${version}` } });
    }
    audit(actor, {
      action: 'cmp.generated', objectType: 'comparison', objectId: id, objectRef: `${cmpNo} v${version}`,
      after: { rfq: rfq.rfq_no, version, lines: r.rows.length, quotations: params.quotations.map((q) => `${q.ref_no ?? q.id} v${q.version} (${q.status})`), landed_cost: params.landed_cost },
    });
    return { id, created: true, comparison: getComparison(id)! };
  });
}

function assertEditable(c: ComparisonRow) {
  if (c.summary?.superseded_by) throw conflict(`${label(c)} has been superseded by a newer version. Open the latest version.`);
  if (!EDITABLE.includes(c.status)) throw conflict(`${label(c)} is ${c.status.toLowerCase()} and cannot be changed.`);
}

/** Refresh the landed-cost parameter snapshot from current configuration (DEC-21 changes). */
export function refreshParams(actor: Actor, id: number) {
  const c = mustComparison(id);
  assertEditable(c);
  const before = c.params.landed_cost;
  const qs = lockedQuotations(c.rfq_id);
  const fp = fingerprint(qs);
  if (fp !== c.params.quotation_fingerprint) throw conflict('Quotations changed since this version was generated. Generate a new version from the RFQ instead.');
  const params = snapshotParams(fp, qs, c.params.acceptable, c.params.acceptable_reasons ?? {});
  update('comparisons', id, { params_json: J(params), status: c.status === 'Recommendation recorded' ? 'Draft' : c.status });
  recompute(id);
  audit(actor, { action: 'cmp.parameters_refreshed', objectType: 'comparison', objectId: id, objectRef: label(c), before, after: params.landed_cost });
  return getComparison(id)!;
}

// ------------------------------------------------------------------ alternates (QTN-04 / CMP rule)
export function setAcceptable(actor: Actor, id: number, lineId: number, vendorId: number, acceptable: boolean, reason?: string) {
  const c = mustComparison(id);
  assertEditable(c);
  const row = c.rows?.find((r) => r.rfq_line_id === lineId);
  const cell = row?.cells.find((x) => x.vendor_id === vendorId);
  if (!row || !cell || cell.no_quote) throw badRequest('That vendor did not quote this line.');
  if (!cell.alternate && !cell.partial) throw badRequest('Only alternate or partial-quantity quotes need to be marked acceptable.');
  if (acceptable && (!reason || reason.trim().length < 10)) throw badRequest('Say why the alternate / partial quote is acceptable (at least 10 characters).', { reason: 'Reason is required' });
  const key = `${lineId}:${vendorId}`;
  const set = new Set(c.params.acceptable);
  const reasons = { ...(c.params.acceptable_reasons ?? {}) };
  if (acceptable) { set.add(key); reasons[key] = reason!.trim(); } else { set.delete(key); delete reasons[key]; }
  update('comparisons', id, { params_json: J({ ...c.params, acceptable: [...set], acceptable_reasons: reasons }), status: c.status === 'Recommendation recorded' ? 'Draft' : c.status });
  audit(actor, { action: acceptable ? 'cmp.alternate_accepted' : 'cmp.alternate_unaccepted', objectType: 'comparison', objectId: id, objectRef: label(c), after: { line: row.line_no, vendor: cell.vendor_name, alternate: cell.alternate, partial: cell.partial }, reason: reason ?? null });
  return recompute(id);
}

// ------------------------------------------------------------------ late / risk discounts (CMP-03, DEC-18)
export function saveDiscount(actor: Actor, id: number, input: { rfq_line_id: number; vendor_id: number; late: number; risk: number; reason: string }) {
  const c = mustComparison(id);
  assertEditable(c);
  const row = c.rows?.find((r) => r.rfq_line_id === input.rfq_line_id);
  const cell = row?.cells.find((x) => x.vendor_id === input.vendor_id);
  if (!row || !cell || cell.no_quote) throw badRequest('Choose a line and a vendor who quoted it.', { vendor_id: 'Vendor did not quote this line' });
  if (input.late < 0 || input.risk < 0) throw badRequest('Discount amounts cannot be negative.');
  if (input.late === 0 && input.risk === 0) throw badRequest('Enter a late discount, a risk discount or both.', { late: 'Enter an amount' });
  if ((input.late + input.risk) >= (cell.landed_before_discounts ?? 0)) throw badRequest(`Discounts cannot exceed the landed cost of ${inr(cell.landed_before_discounts ?? 0)}.`);
  const list = (c.late_discount ?? []).filter((d) => d.status !== 'Draft' || d.rfq_line_id !== input.rfq_line_id || d.vendor_id !== input.vendor_id);
  if (list.some((d) => d.rfq_line_id === input.rfq_line_id && d.vendor_id === input.vendor_id && d.status === 'Pending approval')) throw conflict('A discount for this vendor and line is already waiting for approval.');
  list.push({ ...input, status: 'Draft', approval_id: null, requested_by: actor.id, requested_at: now() });
  update('comparisons', id, { late_discount_json: J(list) });
  audit(actor, { action: 'cmp.discount_drafted', objectType: 'comparison', objectId: id, objectRef: label(c), after: { line: row.line_no, vendor: cell.vendor_name, late: input.late, risk: input.risk }, reason: input.reason });
  return recompute(id);
}

export function removeDiscount(actor: Actor, id: number, lineId: number, vendorId: number) {
  const c = mustComparison(id);
  assertEditable(c);
  const list = c.late_discount ?? [];
  const keep = list.filter((d) => !(d.rfq_line_id === lineId && d.vendor_id === vendorId && d.status === 'Draft'));
  if (keep.length === list.length) throw notFound('Draft discount');
  update('comparisons', id, { late_discount_json: J(keep) });
  audit(actor, { action: 'cmp.discount_removed', objectType: 'comparison', objectId: id, objectRef: label(c), after: { rfq_line_id: lineId, vendor_id: vendorId } });
  return recompute(id);
}

export function submitDiscounts(actor: Actor, id: number) {
  const c = mustComparison(id);
  assertEditable(c);
  const list = c.late_discount ?? [];
  const drafts = list.filter((d) => d.status === 'Draft');
  if (!drafts.length) throw badRequest('There are no draft discounts to send for approval.');
  const rfq = mustRfq(c.rfq_id);
  const required = c.params.discounts?.approval_required !== false;
  return tx(() => {
    const ctxLines = drafts.map((d) => {
      const row = c.rows!.find((r) => r.rfq_line_id === d.rfq_line_id)!;
      const cell = row.cells.find((x) => x.vendor_id === d.vendor_id)!;
      return { line: row.line_no, material: row.description, vendor: cell.vendor_name, landed_before: cell.landed_before_discounts, late_discount: d.late, risk_discount: d.risk, landed_after: round2((cell.landed_before_discounts ?? 0) - d.late - d.risk), reason: d.reason };
    });
    if (!required) {
      for (const d of drafts) Object.assign(d, { status: 'Approved', decided_at: now() });
      update('comparisons', id, { late_discount_json: J(list), status: c.status === 'Recommendation recorded' ? 'Draft' : c.status });
      audit(actor, { action: 'cmp.discount_applied_without_approval', objectType: 'comparison', objectId: id, objectRef: label(c), after: ctxLines, reason: 'Configuration cmp.discounts.approval_required = false (DEC-18)' });
      return recompute(id);
    }
    const total = round2(drafts.reduce((s, d) => s + d.late + d.risk, 0));
    const ap = createApproval(actor, {
      type: 'cmp.discount', objectType: 'comparison', objectId: id, title: `Late / risk discounts on ${label(c)} (${rfq.rfq_no})`,
      summary: `${drafts.length} vendor-line discount${drafts.length === 1 ? '' : 's'} totalling ${inr(total)}`, value: total,
      reason: drafts.map((d) => d.reason).join(' | '),
      context: { comparison: label(c), rfq: rfq.rfq_no, recommended_by: actor.id, definitions: c.params.discounts, discounts: ctxLines },
      plant: rfq.plant, categoryCode: rfq.category,
    });
    for (const d of drafts) Object.assign(d, { status: 'Pending approval', approval_id: ap.id });
    update('comparisons', id, { late_discount_json: J(list) });
    audit(actor, { action: 'cmp.discount_submitted', objectType: 'comparison', objectId: id, objectRef: label(c), after: { approval: ap.req_no, total } });
    return recompute(id);
  });
}

export function onDiscountDecision(ap: ApprovalRow, outcome: string, actor: Actor | null) {
  const c = getComparison(ap.object_id);
  if (!c) return;
  const list = c.late_discount ?? [];
  let changed = false;
  for (const d of list) {
    if (d.approval_id === ap.id && d.status === 'Pending approval') {
      d.status = outcome === 'Approved' ? 'Approved' : outcome === 'Returned' ? 'Draft' : (outcome as DiscountEntry['status']);
      if (outcome === 'Returned') d.approval_id = null;
      d.decided_at = now();
      changed = true;
    }
  }
  if (!changed) return;
  const resetRec = outcome === 'Approved' && c.status === 'Recommendation recorded';
  update('comparisons', c.id, { late_discount_json: J(list), ...(resetRec ? { status: 'Draft' } : {}) });
  recompute(c.id);
  if (resetRec) {
    const s = getComparison(c.id)!.summary!;
    update('comparisons', c.id, { summary_json: J({ ...s, note: `Landed costs changed after ${ap.req_no} was approved. Review the recommendation and record it again.` }) });
  }
  audit(actor, { action: `cmp.discount_${outcome.toLowerCase()}`, objectType: 'comparison', objectId: c.id, objectRef: label(c), after: { approval: ap.req_no } });
  const rfq = get<{ buyer_id: number | null }>('SELECT buyer_id FROM rfqs WHERE id = ?', c.rfq_id);
  notify({ event: 'NTF-12', title: `Discounts ${outcome.toLowerCase()} on ${label(c)}`, body: outcome === 'Approved' ? 'Approved late / risk discounts are now applied in the landed cost.' : 'The discounts are not applied.', link: `/comparisons/${c.id}`, users: [rfq?.buyer_id, c.created_by], objectType: 'comparison', objectId: c.id, dedupeKey: `cmp-disc:${ap.id}:${outcome}` });
}

// ------------------------------------------------------------------ recommendation (FR-CMP-05, 07)
export interface AwardInput { rfq_line_id: number; vendor_id: number | null; qty?: number; reason?: string | null }

export function saveRecommendation(actor: Actor, id: number, input: { awards: AwardInput[]; justification: string }) {
  let c = mustComparison(id);
  assertEditable(c);
  if ((c.late_discount ?? []).some((d) => d.status === 'Pending approval')) throw conflict('Late / risk discounts are waiting for approval. Record the recommendation after they are decided.');
  c = recompute(id);
  const rows = c.rows!;
  const justification = input.justification?.trim() ?? '';
  if (justification.length < 10) throw badRequest('Write a justification for the recommendation (at least 10 characters).', { justification: 'Justification is required' });
  const split = c.params.split_by_qty;
  const awards: Award[] = [];
  const skipped: { rfq_line_id: number; reason: string }[] = [];
  const problems: Record<string, string> = {};
  for (const row of rows) {
    const entries = input.awards.filter((a) => a.rfq_line_id === row.rfq_line_id);
    const tag = `line_${row.line_no}`;
    if (!entries.length) { problems[tag] = `Line ${row.line_no} (${row.description}): choose a vendor or record why it is not awarded.`; continue; }
    const skip = entries.find((e) => e.vendor_id == null);
    if (skip) {
      if (entries.length > 1) { problems[tag] = `Line ${row.line_no}: either award the line or mark it not awarded, not both.`; continue; }
      if (!skip.reason || skip.reason.trim().length < 10) { problems[tag] = `Line ${row.line_no}: say why the line is not awarded (at least 10 characters).`; continue; }
      skipped.push({ rfq_line_id: row.rfq_line_id, reason: skip.reason.trim() });
      continue;
    }
    if (!split && entries.length > 1) { problems[tag] = `Line ${row.line_no}: split award by quantity is not enabled (Q FR-CMP-07). Award the line to one vendor.`; continue; }
    if (new Set(entries.map((e) => e.vendor_id)).size !== entries.length) { problems[tag] = `Line ${row.line_no}: each vendor can appear once.`; continue; }
    let sum = 0;
    for (const e of entries) {
      const cell = row.cells.find((x) => x.vendor_id === e.vendor_id);
      if (!cell || cell.no_quote) { problems[tag] = `Line ${row.line_no}: ${cell?.vendor_name ?? 'that vendor'} did not quote this line.`; break; }
      if (!cell.eligible) { problems[tag] = `Line ${row.line_no}: ${cell.vendor_name}'s quote is ${cell.alternate ? 'an alternate make' : 'for a partial quantity'}. Mark it acceptable before awarding it.`; break; }
      const qty = e.qty ?? Math.min(row.qty, cell.quoted_qty ?? row.qty);
      if (!(qty > 0)) { problems[tag] = `Line ${row.line_no}: award quantity must be more than zero.`; break; }
      if (cell.quoted_qty != null && qty > cell.quoted_qty + 1e-9) { problems[tag] = `Line ${row.line_no}: ${cell.vendor_name} quoted only ${cell.quoted_qty} ${row.uom ?? ''}.`; break; }
      sum += qty;
      const reason = e.reason?.trim() || null;
      // CMP-05: anything other than the lowest landed cost needs a reason and a deviation approval.
      if (!cell.lowest && (!reason || reason.length < 10)) { problems[tag] = `Line ${row.line_no}: ${cell.vendor_name} is not the lowest landed cost. Give a reason of at least 10 characters.`; break; }
      awards.push(deriveAward(rows, row.rfq_line_id, cell.vendor_id, qty, reason));
    }
    if (!problems[tag] && sum > row.qty + 1e-9) problems[tag] = `Line ${row.line_no}: awarded ${sum} is more than the required ${row.qty} ${row.uom ?? ''}.`;
  }
  if (Object.keys(problems).length) throw badRequest(Object.values(problems)[0], problems);
  if (!awards.length) throw badRequest('Award at least one line, or cancel / re-float the RFQ instead.');
  const total = round2(awards.reduce((s, a) => s + (a.landed_total ?? 0), 0));
  const lowestTotal = round2(awards.reduce((s, a) => { const r = rows.find((x) => x.rfq_line_id === a.rfq_line_id)!; return s + (r.lowest_unit_landed ?? a.landed_unit) * a.qty; }, 0));
  const deviations = awards.filter((a) => !a.lowest);
  const devReason = deviations.length ? deviations.map((a) => { const r = rows.find((x) => x.rfq_line_id === a.rfq_line_id)!; return `Line ${r.line_no}: ${a.reason}`; }).join(' | ') : null;
  const summary: Summary = {
    ...c.summary!, note: null,
    recommendation: { by: actor.id, by_name: actor.name, at: now(), total_landed: total, lowest_total: lowestTotal, difference: round2(total - lowestTotal), skipped, deviation_lines: deviations.length },
  };
  update('comparisons', id, {
    awards_json: J(awards), justification, deviation: deviations.length ? 1 : 0, deviation_reason: devReason, summary_json: J(summary), status: 'Recommendation recorded',
  });
  audit(actor, {
    action: 'cmp.recommendation_recorded', objectType: 'comparison', objectId: id, objectRef: label(c), before: { status: c.status, awards: c.awards },
    after: { status: 'Recommendation recorded', awards: awards.map((a) => ({ line: a.rfq_line_id, vendor: a.vendor_name, qty: a.qty, landed_unit: a.landed_unit, lowest: a.lowest })), total, deviation: !!deviations.length, skipped },
    reason: justification,
  });
  return getComparison(id)!;
}

/** Rich context for the award / deviation approvals (APP-02). */
function approvalLines(c: ComparisonRow) {
  return (c.awards ?? []).map((a) => {
    const r = c.rows!.find((x) => x.rfq_line_id === a.rfq_line_id)!;
    const cell = r.cells.find((x) => x.vendor_id === a.vendor_id)!;
    const low = r.cells.filter((x) => x.lowest);
    const lowCell = low[0];
    const expected = cell.delivery_days != null ? new Date(Date.now() + cell.delivery_days * 86400000).toISOString().slice(0, 10) : null;
    const late = expected && r.required_date ? daysBetween(r.required_date, expected) : null;
    return {
      line: r.line_no, pr: r.pr_ref, material: r.description, qty: `${a.qty} ${r.uom ?? ''}`.trim(), selected_vendor: a.vendor_name, selected_unit_landed: a.landed_unit,
      lowest_vendor: low.map((x) => x.vendor_name).join(' / '), lowest_unit_landed: r.lowest_unit_landed, difference: round2((a.landed_unit - (r.lowest_unit_landed ?? a.landed_unit)) * a.qty),
      lpp: r.lpp, contract_price: r.contract?.unit_price ?? null, contract_no: r.contract?.contract_no ?? null, variance_vs_lpp_pct: cell.var_lpp_pct,
      delivery_days: cell.delivery_days, lowest_delivery_days: lowCell?.delivery_days ?? null, required_date: r.required_date,
      delivery_impact: late == null ? 'No delivery days quoted' : late > 0 ? `${late} day${late === 1 ? '' : 's'} after the required date` : 'Meets the required date',
      reason: a.reason,
    };
  });
}

export function submit(actor: Actor, id: number) {
  const c = mustComparison(id);
  if (c.summary?.superseded_by) throw conflict(`${label(c)} has been superseded by a newer version.`);
  if (c.status !== 'Recommendation recorded') throw conflict(c.status === 'Draft' || c.status === 'Returned' ? 'Record the award recommendation before submitting it for approval.' : `${label(c)} is ${c.status.toLowerCase()}.`);
  if ((c.late_discount ?? []).some((d) => d.status === 'Pending approval')) throw conflict('Late / risk discounts are still waiting for approval.');
  const rfq = mustRfq(c.rfq_id);
  const fp = fingerprint(lockedQuotations(c.rfq_id));
  if (fp !== c.params.quotation_fingerprint) throw conflict('Quotations changed after this comparison was generated (RFQ reopened). Generate a new version first.');
  const rec = c.summary!.recommendation!;
  const lines = approvalLines(c);
  const priorities = ['BD', 'Class 1', 'Urgent'];
  const urgency = priorities.find((p) => c.rows!.some((r) => r.pr_priority === p && c.awards!.some((a) => a.rfq_line_id === r.rfq_line_id))) ?? 'Normal';
  const vendors = [...new Set((c.awards ?? []).map((a) => a.vendor_name))].join(', ');
  const cov = c.summary!.coverage;
  return tx(() => {
    const recommender = rec.by;
    const recommenderName = rec.by_name;
    const common = {
      comparison: label(c), rfq: rfq.rfq_no, rfq_title: rfq.title, recommended_by: recommender, recommended_by_name: recommenderName,
      justification: c.justification, selected_vendors: vendors, total_awarded_landed: rec.total_landed, lowest_landed_total: rec.lowest_total,
      difference_vs_lowest: rec.difference, coverage: `${cov.responded} of ${cov.invited} invited vendors responded (${cov.declined} declined, ${cov.non_participating} non-participating)`,
      landed_cost_basis: c.params.landed_cost,
    };
    const award = createApproval(actor, {
      type: 'cmp.award', objectType: 'comparison', objectId: id, title: `Award ${rfq.rfq_no} — ${vendors}`,
      summary: `${c.awards!.length} line${c.awards!.length === 1 ? '' : 's'} · landed ${inr(rec.total_landed)}${c.deviation ? ' · includes deviation from lowest' : ''}`,
      value: rec.total_landed, reason: c.justification ?? undefined, context: { ...common, lines, deviation: !!c.deviation, deviation_reason: c.deviation_reason },
      urgency, plant: rfq.plant, categoryCode: rfq.category,
    });
    let dev: ApprovalRow | null = null;
    if (c.deviation) {
      const devLines = lines.filter((l) => c.awards!.find((a) => a.vendor_name === l.selected_vendor && !a.lowest));
      dev = createApproval(actor, {
        type: 'exc.deviation', objectType: 'comparison', objectId: id, title: `Deviation from lowest landed cost — ${rfq.rfq_no}`,
        summary: `${rec.deviation_lines} line${rec.deviation_lines === 1 ? '' : 's'} not awarded to the lowest landed cost (+${inr(rec.difference)})`,
        value: rec.difference, reason: c.deviation_reason ?? undefined, context: { ...common, lines: devLines.length ? devLines : lines, deviation_reason: c.deviation_reason },
        urgency, plant: rfq.plant, categoryCode: rfq.category,
      });
    }
    const round = (c.summary?.submission?.round ?? 0) + 1;
    const summary: Summary = { ...c.summary!, submission: { at: now(), by: actor.id, approval_ids: [award.id, ...(dev ? [dev.id] : [])], award_approval_id: award.id, deviation_approval_id: dev?.id ?? null, round } };
    update('comparisons', id, { status: 'Submitted for approval', submitted_at: now(), approval_id: award.id, summary_json: J(summary) });
    audit(actor, { action: 'cmp.submitted', objectType: 'comparison', objectId: id, objectRef: label(c), before: { status: c.status }, after: { status: 'Submitted for approval', award_approval: award.req_no, deviation_approval: dev?.req_no ?? null, value: rec.total_landed, matrix_version: award.matrix_version } });
    return getComparison(id)!;
  });
}

/** Withdraw any open approvals for a comparison (system action on behalf of the requester). */
function withdrawOpen(id: number, reason: string) {
  const open = all<ApprovalRow>("SELECT * FROM approvals WHERE object_type = 'comparison' AND object_id = ? AND status IN ('Pending','Clarification requested')", id);
  for (const a of open) {
    const as = actorById(a.requester_id);
    if (as) withdraw(as, a.id, reason);
  }
}

/** onDecision for cmp.award and exc.deviation. Approved only when every approval of the submission is approved. */
export function onAwardDecision(ap: ApprovalRow, outcome: string, actor: Actor | null, comment: string | null) {
  if (ap.object_type !== 'comparison') return;
  const c = getComparison(ap.object_id);
  if (!c || c.status !== 'Submitted for approval') return;
  const ids = c.summary?.submission?.approval_ids ?? [];
  if (!ids.includes(ap.id)) return;
  const ts = now();
  const rfq = get<{ buyer_id: number | null; rfq_no: string }>('SELECT buyer_id, rfq_no FROM rfqs WHERE id = ?', c.rfq_id);
  const users = [rfq?.buyer_id, c.created_by, c.summary?.recommendation?.by];
  if (outcome === 'Approved') {
    const states = ids.map((x) => getApproval(x)?.status);
    if (!states.every((s) => s === 'Approved')) return;
    update('comparisons', c.id, { status: 'Approved', decided_at: ts });
    audit(actor, { action: 'cmp.approved', objectType: 'comparison', objectId: c.id, objectRef: label(c), before: { status: c.status }, after: { status: 'Approved', approvals: ids } });
    notify({ event: 'NTF-12', title: `${label(c)} approved — release for PO`, body: `All approvals for ${rfq?.rfq_no} are complete. Release the award so the PO can be created in SAP.`, link: `/comparisons/${c.id}`, users, objectType: 'comparison', objectId: c.id, severity: 'success', dedupeKey: `cmp-ok:${c.id}:${ts}` });
    // FR-CMP-08: locked PDF of the approved statement.
    setImmediate(() => { lockPdf(c.id).catch((e) => console.error('comparison PDF failed', e)); });
    return;
  }
  const status = outcome === 'Rejected' ? 'Rejected' : outcome === 'Returned' ? 'Returned' : 'Recommendation recorded';
  update('comparisons', c.id, { status, decided_at: outcome === 'Withdrawn' ? null : ts });
  audit(actor, { action: `cmp.${outcome.toLowerCase()}`, objectType: 'comparison', objectId: c.id, objectRef: label(c), before: { status: c.status }, after: { status, via: ap.req_no }, reason: comment });
  withdrawOpen(c.id, `${ap.req_no} was ${outcome.toLowerCase()}; linked request closed automatically`);
  if (outcome !== 'Withdrawn') {
    notify({
      event: 'NTF-12', title: `${label(c)} ${outcome.toLowerCase()}`, body: outcome === 'Returned' ? `Returned for changes: ${comment ?? ''}` : `Rejected: ${comment ?? ''}. Cancel or re-float the RFQ.`,
      link: `/comparisons/${c.id}`, users, objectType: 'comparison', objectId: c.id, severity: 'warning', dedupeKey: `cmp-${outcome}:${c.id}:${ts}`,
    });
  }
}

/** Generate and store the locked PDF of an approved statement once (FR-CMP-08). */
export async function lockPdf(id: number) {
  const c = getComparison(id);
  if (!c || !['Approved', 'Released for PO'].includes(c.status) || c.summary?.pdf_attachment_id) return c?.summary?.pdf_attachment_id ?? null;
  const { renderPdf } = await import('./pdf.ts');
  const buf = await renderPdf(c, true);
  const again = getComparison(id)!;
  if (again.summary?.pdf_attachment_id) return again.summary.pdf_attachment_id;
  const attId = storeGenerated(buf, `${c.cmp_no}-v${c.version}-approved.pdf`, 'application/pdf', { ownerType: 'comparison', ownerId: id, label: 'Approved comparative statement (locked)', vendorVisible: false });
  update('comparisons', id, { summary_json: J({ ...(again.summary ?? {}), pdf_attachment_id: attId }) });
  audit(null, { action: 'cmp.pdf_locked', objectType: 'comparison', objectId: id, objectRef: label(c), after: { attachment_id: attId, bytes: buf.length } });
  return attId;
}

// ------------------------------------------------------------------ release for PO (WF-01, DEC-05)
export function release(actor: Actor, id: number) {
  const c = mustComparison(id);
  if (c.status !== 'Approved') throw conflict(c.status === 'Released for PO' ? 'Already released for PO.' : `Only an approved comparison can be released (this one is ${c.status.toLowerCase()}).`);
  const rfq = mustRfq(c.rfq_id);
  return tx(() => {
    const ts = now();
    // Final award contract (ENGINEERING.md): rfq_line_id, pr_line_id, vendor_id, qty, unit_price, gst_rate, freight, landed_unit, lowest, reason.
    const awards = (c.awards ?? []).map((a) => ({ rfq_line_id: a.rfq_line_id, pr_line_id: a.pr_line_id, vendor_id: a.vendor_id, qty: a.qty, unit_price: a.unit_price, gst_rate: a.gst_rate, freight: a.freight, landed_unit: a.landed_unit, lowest: a.lowest, reason: a.reason, vendor_name: a.vendor_name, landed_total: a.landed_total, delivery_days: a.delivery_days }));
    update('comparisons', id, { status: 'Released for PO', sap_handoff_at: ts, awards_json: J(awards), summary_json: J({ ...c.summary!, released: { at: ts, by: actor.id, by_name: actor.name } }) });
    update('rfqs', c.rfq_id, { status: 'Awarded' });
    audit(actor, { action: 'cmp.released_for_po', objectType: 'comparison', objectId: id, objectRef: label(c), before: { status: c.status }, after: { status: 'Released for PO', awards: awards.length } });
    audit(actor, { action: 'rfq.awarded', objectType: 'rfq', objectId: c.rfq_id, objectRef: rfq.rfq_no, before: { status: rfq.status }, after: { status: 'Awarded', comparison: label(c) } });
    notify({ event: 'NTF-12', title: `${rfq.rfq_no} awarded — create the PO in SAP`, body: `${label(c)} is released for PO. The PO is created and released in SAP (DEC-05).`, link: `/comparisons/${id}`, users: [rfq.buyer_id, c.created_by], roles: ['SAP'], objectType: 'comparison', objectId: id, dedupeKey: `cmp-rel:${id}` });
    return getComparison(id)!;
  });
}

// ------------------------------------------------------------------ queries
export function list(q: Record<string, string | undefined>) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (q.status) { where.push('c.status = ?'); p.push(q.status); }
  if (q.rfq) { where.push('c.rfq_id = ?'); p.push(Number(q.rfq)); }
  if (q.latest !== '0') where.push('c.version = (SELECT MAX(version) FROM comparisons x WHERE x.rfq_id = c.rfq_id)');
  const rows = all<ComparisonRow & { rfq_no: string; rfq_title: string | null; rfq_status: string; buyer_name: string | null; plant: string | null; category: string | null; created_by_name: string | null; approval_status: string | null; approval_req_no: string | null }>(
    `SELECT c.*, r.rfq_no, r.title AS rfq_title, r.status AS rfq_status, r.plant, r.category, b.name AS buyer_name, u.name AS created_by_name,
            a.status AS approval_status, a.req_no AS approval_req_no
     FROM comparisons c JOIN rfqs r ON r.id = c.rfq_id LEFT JOIN users b ON b.id = r.buyer_id LEFT JOIN users u ON u.id = c.created_by
     LEFT JOIN approvals a ON a.id = c.approval_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.created_at DESC, c.id DESC`,
    ...p,
  );
  return rows.map((c) => ({
    id: c.id, cmp_no: c.cmp_no, ref: label(c), version: c.version, status: c.status, rfq_id: c.rfq_id, rfq_no: c.rfq_no, rfq_title: c.rfq_title, rfq_status: c.rfq_status,
    buyer_name: c.buyer_name, plant: c.plant, category: c.category, created_by_name: c.created_by_name, created_at: c.created_at, submitted_at: c.submitted_at, decided_at: c.decided_at,
    lines: c.summary?.lines ?? 0, vendors: c.summary?.vendors?.length ?? 0, coverage: c.summary?.coverage ? `${c.summary.coverage.responded}/${c.summary.coverage.invited}` : '—',
    lowest_total: c.summary?.lowest_total ?? null, awarded_total: c.summary?.recommendation?.total_landed ?? null, deviation: !!c.deviation,
    superseded: !!c.summary?.superseded_by, approval_status: c.approval_status, approval_req_no: c.approval_req_no, age_days: daysBetween(c.created_at),
  }));
}

/** RFQs that can be compared but have no comparison yet (buyer generates live). */
export function readyRfqs() {
  const rows = all<{ id: number; rfq_no: string; title: string | null; status: string; closing_at: string | null; closed_at: string | null; buyer_name: string | null; plant: string | null; invited: number; locked: number; declined: number; responded: number }>(
    `SELECT r.id, r.rfq_no, r.title, r.status, r.closing_at, r.closed_at, r.plant, b.name AS buyer_name,
            (SELECT COUNT(*) FROM rfq_invitations i WHERE i.rfq_id = r.id) AS invited,
            (SELECT COUNT(*) FROM rfq_invitations i WHERE i.rfq_id = r.id AND i.status IN ('Responded','Declined')) AS responded,
            (SELECT COUNT(*) FROM rfq_invitations i WHERE i.rfq_id = r.id AND i.status = 'Declined') AS declined,
            (SELECT COUNT(*) FROM quotations q WHERE q.rfq_id = r.id AND q.status IN ('Locked','Final')) AS locked
     FROM rfqs r LEFT JOIN users b ON b.id = r.buyer_id
     WHERE NOT EXISTS (SELECT 1 FROM comparisons c WHERE c.rfq_id = r.id) AND r.status IN ('Closed','Under comparison','Published')
     ORDER BY COALESCE(r.closed_at, r.closing_at) DESC`,
  );
  return rows.filter((r) => r.status !== 'Published' || (r.invited > 0 && r.responded === r.invited)).map((r) => ({ ...r, ready: r.locked > 0 }));
}

export function detail(id: number) {
  const c = mustComparison(id);
  const rfq = get<RfqRow & { buyer_name: string | null }>('SELECT r.*, b.name AS buyer_name FROM rfqs r LEFT JOIN users b ON b.id = r.buyer_id WHERE r.id = ?', c.rfq_id)!;
  const approvals = all<{ id: number; req_no: string; type: string; status: string; title: string; value: number | null; current_level: number; created_at: string; decided_at: string | null; matrix_version: number | null }>(
    "SELECT id, req_no, type, status, title, value, current_level, created_at, decided_at, matrix_version FROM approvals WHERE object_type = 'comparison' AND object_id = ? ORDER BY id DESC", id,
  );
  const versions = all<{ id: number; version: number; status: string; created_at: string }>('SELECT id, version, status, created_at FROM comparisons WHERE rfq_id = ? ORDER BY version DESC', c.rfq_id);
  const pos = all<{ id: number; po_no: string; vendor: string; status: string; po_date: string; total_value: number | null }>(
    'SELECT p.id, p.po_no, v.name AS vendor, p.status, p.po_date, p.total_value FROM pos p JOIN vendors v ON v.id = p.vendor_id WHERE p.comparison_id = ? ORDER BY p.id', id,
  );
  const creator = get<{ name: string }>('SELECT name FROM users WHERE id = ?', c.created_by);
  const pdf = c.summary?.pdf_attachment_id ? get<{ id: number; filename: string; created_at: string; size: number }>('SELECT id, filename, created_at, size FROM attachments WHERE id = ?', c.summary.pdf_attachment_id) : null;
  return {
    ...c, ref: label(c), rfq: { id: rfq.id, rfq_no: rfq.rfq_no, title: rfq.title, status: rfq.status, plant: rfq.plant, category: rfq.category, buyer_id: rfq.buyer_id, buyer_name: rfq.buyer_name, closing_at: rfq.closing_at, closed_at: rfq.closed_at, delivery_terms: rfq.delivery_terms, payment_terms: rfq.payment_terms },
    approvals, versions, pos, created_by_name: creator?.name ?? null, pdf, editable: EDITABLE.includes(c.status) && !c.summary?.superseded_by,
    quotes_changed: fingerprint(lockedQuotations(c.rfq_id)) !== c.params.quotation_fingerprint,
    config: { split_by_qty: c.params.split_by_qty, discount_definitions: c.params.discounts },
  };
}

/** Panel shown on the approval decision screen for comparison approvals (APP-02). */
export function approvalPanel(id: number) {
  const c = getComparison(id);
  if (!c) return null;
  const rfq = get<{ id: number; rfq_no: string; title: string | null }>('SELECT id, rfq_no, title FROM rfqs WHERE id = ?', c.rfq_id);
  return {
    id: c.id, ref: label(c), status: c.status, rfq, justification: c.justification, deviation: !!c.deviation, deviation_reason: c.deviation_reason,
    recommendation: c.summary?.recommendation ?? null, coverage: c.summary?.coverage ?? null, lines: c.awards ? approvalLines(c) : [],
    skipped: (c.summary?.recommendation?.skipped ?? []).map((s) => ({ ...s, line: c.rows?.find((r) => r.rfq_line_id === s.rfq_line_id)?.line_no, material: c.rows?.find((r) => r.rfq_line_id === s.rfq_line_id)?.description })),
    vendors: c.summary?.vendors ?? [], landed_cost: c.params.landed_cost,
    discounts: (c.late_discount ?? []).map((d) => {
      const r = c.rows?.find((x) => x.rfq_line_id === d.rfq_line_id);
      return { ...d, line: r?.line_no, material: r?.description, vendor: r?.cells.find((x) => x.vendor_id === d.vendor_id)?.vendor_name };
    }),
  };
}

export const comparisonLabel = label;
