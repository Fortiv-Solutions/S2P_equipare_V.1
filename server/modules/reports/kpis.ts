/**
 * KPI-01 … KPI-15 (PRD Sec 13) with the PRD formulas, median and P90 where stated, and the record set
 * behind every value. No baselines or targets exist yet: "Baseline: to be measured · Target: pending approval".
 */
import { all } from '../../core/db.ts';
import { cfg } from '../../core/config.ts';
import type { Actor } from '../../core/auth.ts';
import { daysDiff, hoursDiff, median, p90, round, teamOf, type Col } from './engine.ts';
import { invoiceRows, poValueLines, receivedLines, vendorScores, commitmentBasis } from './defs.ts';

export interface KpiResult {
  id: string; name: string; formula: string; unit: 'days' | 'hours' | 'pct' | 'score' | 'lines' | 'money';
  value: number | null; median?: number | null; p90?: number | null; numerator?: number; denominator?: number; n: number;
  columns: Col[]; rows: Record<string, unknown>[]; empty: string; note?: string; decision?: string;
  baseline: string; target: string; period_applies: boolean;
}

const inPeriod = (d: string | null | undefined, from: string, to: string) => !!d && d.slice(0, 10) >= from && d.slice(0, 10) <= to;
const base = { baseline: 'To be measured', target: 'Pending approval' };

function stat(id: string, name: string, formula: string, unit: KpiResult['unit'], rows: Record<string, unknown>[], field: string, columns: Col[], empty: string, extra: Partial<KpiResult> = {}): KpiResult {
  const vals = rows.map((r) => r[field]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return { id, name, formula, unit, value: median(vals), median: median(vals), p90: p90(vals), n: vals.length, columns, rows, empty, period_applies: true, ...base, ...extra };
}
function ratio(id: string, name: string, formula: string, rows: Record<string, unknown>[], num: number, den: number, columns: Col[], empty: string, extra: Partial<KpiResult> = {}): KpiResult {
  return { id, name, formula, unit: 'pct', value: den ? round(num / den, 4) : null, numerator: round(num, 2), denominator: round(den, 2), n: rows.length, columns, rows, empty, period_applies: true, ...base, ...extra };
}

export function computeKpis(actor: Actor, from: string, to: string): KpiResult[] {
  const team = actor.role === 'BUY' ? teamOf(actor) : null;
  const okBuyer = (id: number | null | undefined) => !team || id == null || team.has(id);
  const okPlant = (p: string | null | undefined) => actor.plants === '*' || !p || actor.plants.includes(p);
  const out: KpiResult[] = [];

  // KPI-01 PR-to-RFQ TAT: RFQ release − buyer assignment
  const k1 = all<{ id: number; pr_line_id: number; pr_no: string; item: number; rfq_id: number; rfq_no: string; assigned_at: string | null; published_at: string; buyer_id: number | null; plant: string | null }>(
    `SELECT rl.id, l.id AS pr_line_id, l.pr_no, l.item, r.id AS rfq_id, r.rfq_no, l.assigned_at, r.published_at, r.buyer_id, l.plant
     FROM rfq_lines rl JOIN rfqs r ON r.id = rl.rfq_id JOIN pr_lines l ON l.id = rl.pr_line_id WHERE r.published_at IS NOT NULL`,
  ).filter((r) => inPeriod(r.published_at, from, to) && okBuyer(r.buyer_id) && okPlant(r.plant))
    .map((r) => ({ id: r.id, link: `/pr/${r.pr_line_id}`, ref: `${r.pr_no}/${r.item}`, rfq_no: r.rfq_no, rfq_link: `/rfqs/${r.rfq_id}`, assigned_at: r.assigned_at, published_at: r.published_at, tat_days: daysDiff(r.assigned_at, r.published_at) }));
  out.push(stat('KPI-01', 'PR-to-RFQ TAT', 'Median and P90 of (RFQ release − buyer assignment) per PR line', 'days', k1, 'tat_days',
    [{ key: 'ref', header: 'PR / item', kind: 'ref' }, { key: 'rfq_no', header: 'RFQ', link: 'rfq_link' }, { key: 'assigned_at', header: 'Buyer assigned', kind: 'datetime' }, { key: 'published_at', header: 'RFQ released', kind: 'datetime' }, { key: 'tat_days', header: 'TAT', kind: 'days' }],
    'No RFQ was released in this period.'));

  // KPI-02 PR-to-PO TAT: PO date − PR available
  const k2 = all<{ id: number; po_id: number; po_no: string; item: number; pr_no: string; pr_item: number; available_at: string | null; po_date: string; buyer_id: number | null; plant: string }>(
    `SELECT pl.id, p.id AS po_id, p.po_no, pl.item, l.pr_no, l.item AS pr_item, l.available_at, p.po_date, p.buyer_id, p.plant
     FROM po_lines pl JOIN pos p ON p.id = pl.po_id JOIN pr_lines l ON l.id = pl.pr_line_id WHERE pl.status != 'Cancelled'`,
  ).filter((r) => inPeriod(r.po_date, from, to) && okBuyer(r.buyer_id) && okPlant(r.plant))
    .map((r) => ({ id: r.id, link: `/pos/${r.po_id}`, ref: `${r.po_no}/${r.item}`, pr: `${r.pr_no}/${r.pr_item}`, available_at: r.available_at, po_date: r.po_date, tat_days: r.available_at ? Math.max(0, daysDiff(r.available_at, `${r.po_date}T12:00:00.000Z`) ?? 0) : null }));
  out.push(stat('KPI-02', 'PR-to-PO TAT', 'Median and P90 of (PO date − PR available in platform) per PO line', 'days', k2, 'tat_days',
    [{ key: 'ref', header: 'PO / item', kind: 'ref' }, { key: 'pr', header: 'PR / item' }, { key: 'available_at', header: 'PR available', kind: 'datetime' }, { key: 'po_date', header: 'PO date', kind: 'date' }, { key: 'tat_days', header: 'TAT', kind: 'days' }],
    'No PO linked to a PR line was dated in this period.'));

  // KPI-03 RFQ response rate: quoted ÷ invited
  const k3 = all<{ id: number; rfq_id: number; rfq_no: string; vendor: string; status: string; published_at: string; buyer_id: number | null; plant: string | null; quoted: number }>(
    `SELECT i.id, r.id AS rfq_id, r.rfq_no, v.name AS vendor, i.status, r.published_at, r.buyer_id, r.plant,
            EXISTS (SELECT 1 FROM quotations q WHERE q.rfq_id = r.id AND q.vendor_id = i.vendor_id AND q.submitted_at IS NOT NULL AND q.status NOT IN ('Draft','Not started','Declined')) AS quoted
     FROM rfq_invitations i JOIN rfqs r ON r.id = i.rfq_id JOIN vendors v ON v.id = i.vendor_id WHERE r.published_at IS NOT NULL`,
  ).filter((r) => inPeriod(r.published_at, from, to) && okBuyer(r.buyer_id) && okPlant(r.plant))
    .map((r) => ({ id: r.id, link: `/rfqs/${r.rfq_id}`, rfq_no: r.rfq_no, vendor: r.vendor, invitation: r.status, quoted: r.quoted ? 'Yes' : 'No', published_at: r.published_at }));
  out.push(ratio('KPI-03', 'RFQ response rate', 'Vendors that quoted ÷ vendors invited (RFQs published in the period)', k3, k3.filter((r) => r.quoted === 'Yes').length, k3.length,
    [{ key: 'rfq_no', header: 'RFQ', kind: 'ref' }, { key: 'vendor', header: 'Vendor' }, { key: 'invitation', header: 'Invitation', kind: 'status' }, { key: 'quoted', header: 'Quoted' }, { key: 'published_at', header: 'Published', kind: 'date' }],
    'No vendor was invited to an RFQ in this period.'));

  // KPI-04 comparison TAT: RFQ close → comparison submitted
  const k4 = all<{ id: number; cmp_no: string | null; rfq_id: number; rfq_no: string; closed_at: string | null; submitted_at: string; buyer_id: number | null; plant: string | null }>(
    'SELECT c.id, c.cmp_no, r.id AS rfq_id, r.rfq_no, r.closed_at, c.submitted_at, r.buyer_id, r.plant FROM comparisons c JOIN rfqs r ON r.id = c.rfq_id WHERE c.submitted_at IS NOT NULL',
  ).filter((r) => inPeriod(r.submitted_at, from, to) && okBuyer(r.buyer_id) && okPlant(r.plant))
    .map((r) => ({ id: r.id, link: `/rfqs/${r.rfq_id}`, comparison: r.cmp_no ?? `#${r.id}`, rfq_no: r.rfq_no, closed_at: r.closed_at, submitted_at: r.submitted_at, tat_days: daysDiff(r.closed_at, r.submitted_at) }));
  out.push(stat('KPI-04', 'Comparison TAT', 'Median and P90 of (comparison submitted − RFQ closed)', 'days', k4, 'tat_days',
    [{ key: 'comparison', header: 'Comparison', kind: 'ref' }, { key: 'rfq_no', header: 'RFQ' }, { key: 'closed_at', header: 'RFQ closed', kind: 'datetime' }, { key: 'submitted_at', header: 'Submitted', kind: 'datetime' }, { key: 'tat_days', header: 'TAT', kind: 'days' }],
    'No comparison was submitted for approval in this period.'));

  // KPI-05 approval ageing (pending approvals, buckets 1/3/6 days — AC-APR-05)
  const ab = cfg<number[]>('reports.approval_buckets');
  const k5 = all<{ id: number; req_no: string | null; type: string; title: string | null; status: string; created_at: string; value: number | null; plant: string | null }>(
    "SELECT id, req_no, type, title, status, created_at, value, plant FROM approvals WHERE status IN ('Pending','Clarification requested')",
  ).filter((r) => okPlant(r.plant)).map((r) => {
    const age = daysDiff(r.created_at, new Date().toISOString()) ?? 0;
    const bucket = age <= ab[0] ? `≤ ${ab[0]} d` : age <= ab[1] ? `${ab[0]}–${ab[1]} d` : age <= ab[2] ? `${ab[1]}–${ab[2]} d` : `> ${ab[2]} d`;
    return { id: r.id, link: `/approvals/${r.id}`, req_no: r.req_no ?? `#${r.id}`, type: r.type, title: r.title, status: r.status, created_at: r.created_at, age_days: age, bucket };
  });
  out.push(stat('KPI-05', 'Approval ageing', 'Median and P90 age of pending approval requests (now − submitted), in buckets', 'days', k5, 'age_days',
    [{ key: 'req_no', header: 'Request', kind: 'ref' }, { key: 'type', header: 'Type' }, { key: 'title', header: 'Title' }, { key: 'status', header: 'Status', kind: 'status' }, { key: 'created_at', header: 'Submitted', kind: 'datetime' }, { key: 'age_days', header: 'Age', kind: 'days' }, { key: 'bucket', header: 'Bucket' }],
    'No approval request is pending.', { period_applies: false, note: 'Current pending requests; the period selector does not apply.', decision: 'DEC-15' }));

  // KPI-06 PO acknowledgement TAT: ack − publication
  const k6 = all<{ id: number; po_id: number; po_no: string; item: number; vendor: string; published_at: string; ack_at: string; ack_status: string; buyer_id: number | null; plant: string }>(
    `SELECT pl.id, p.id AS po_id, p.po_no, pl.item, v.name AS vendor, p.published_at, pl.ack_at, pl.ack_status, p.buyer_id, p.plant FROM po_lines pl JOIN pos p ON p.id = pl.po_id JOIN vendors v ON v.id = p.vendor_id
     WHERE pl.ack_at IS NOT NULL AND p.published_at IS NOT NULL AND pl.ack_status NOT IN ('Deemed accepted','Pending','Pending re-acknowledgement')`,
  ).filter((r) => inPeriod(r.ack_at, from, to) && okBuyer(r.buyer_id) && okPlant(r.plant))
    .map((r) => ({ id: r.id, link: `/pos/${r.po_id}`, ref: `${r.po_no}/${r.item}`, vendor: r.vendor, published_at: r.published_at, ack_at: r.ack_at, ack_status: r.ack_status, tat_hours: Math.max(0, hoursDiff(r.published_at, r.ack_at) ?? 0) }));
  out.push(stat('KPI-06', 'PO acknowledgement TAT', 'Median and P90 of (acknowledgement − PO publication) per PO line; deemed acceptances excluded', 'hours', k6, 'tat_hours',
    [{ key: 'ref', header: 'PO / item', kind: 'ref' }, { key: 'vendor', header: 'Vendor' }, { key: 'published_at', header: 'Published', kind: 'datetime' }, { key: 'ack_at', header: 'Acknowledged', kind: 'datetime' }, { key: 'ack_status', header: 'Response', kind: 'status' }, { key: 'tat_hours', header: 'TAT', kind: 'hours' }],
    'No vendor acknowledged a PO line in this period.', { decision: 'DEC-16' }));

  // KPI-07 on-time delivery
  const k7 = receivedLines().filter((l) => inPeriod(l.last_grn, from, to) && okBuyer(l.buyer_id) && okPlant(l.plant))
    .map((l) => ({ id: l.id, link: `/pos/${l.po_id}`, ref: `${l.po_no}/${l.item}`, vendor: l.vendor, description: l.description, committed: l.committed, last_grn: l.last_grn, on_time: l.on_time ? 'Yes' : 'No' }));
  out.push(ratio('KPI-07', 'On-time delivery', `PO lines fully received with last GRN date ≤ ${commitmentBasis()} committed date ÷ PO lines received`, k7, k7.filter((r) => r.on_time === 'Yes').length, k7.length,
    [{ key: 'ref', header: 'PO / item', kind: 'ref' }, { key: 'vendor', header: 'Vendor' }, { key: 'description', header: 'Material' }, { key: 'committed', header: 'Committed', kind: 'date' }, { key: 'last_grn', header: 'GRN date', kind: 'date' }, { key: 'on_time', header: 'On time' }],
    'No PO line was fully received in this period.', { note: 'Committed date = vendor commitment, else PO delivery date. First vs latest commitment is configurable (Q 7.7).', decision: 'Q 7.7' }));

  // KPI-08 / KPI-09 contract coverage and spot dependency
  const pv = poValueLines().filter((l) => inPeriod(l.po_date, from, to) && okBuyer(l.buyer_id) && okPlant(l.plant))
    .map((l) => ({ id: l.id, link: `/pos/${l.po_id}`, ref: `${l.po_no}/${l.item}`, vendor: l.vendor, po_date: l.po_date, value: l.value, coverage: l.coverage, contract: l.contract_no ?? '—' }));
  const total = pv.reduce((s, r) => s + r.value, 0);
  const pvCols: Col[] = [{ key: 'ref', header: 'PO / item', kind: 'ref' }, { key: 'vendor', header: 'Vendor' }, { key: 'po_date', header: 'PO date', kind: 'date' }, { key: 'value', header: 'Value (basic)', kind: 'money' }, { key: 'coverage', header: 'Coverage', kind: 'status' }, { key: 'contract', header: 'Contract' }];
  out.push(ratio('KPI-08', 'Contract coverage', 'PO value under ARC / OA / FDS / VMI ÷ total PO value', pv, pv.filter((r) => ['ARC', 'OA', 'FDS', 'VMI'].includes(r.coverage)).reduce((s, r) => s + r.value, 0), total, pvCols, 'No PO spend in this period.'));
  out.push(ratio('KPI-09', 'Spot dependency', 'PO value bought spot (no contract) ÷ total PO value', pv, pv.filter((r) => r.coverage === 'Spot').reduce((s, r) => s + r.value, 0), total, pvCols, 'No PO spend in this period.'));

  // KPI-10 / KPI-11 invoices
  const inv = invoiceRows().filter((i) => inPeriod(i.created_at, from, to) && okBuyer(i.buyer_id) && okPlant(i.plant));
  const k10 = inv.filter((i) => i.acc.extracted > 0).map((i) => ({ id: i.id, link: `/invoices/${i.id}`, inv_ref: i.inv_ref, vendor: i.vendor, extracted: i.acc.extracted, corrected: i.acc.corrected, accuracy: i.acc.accuracy }));
  out.push(ratio('KPI-10', 'OCR field accuracy', 'Extracted fields left unchanged by the reviewer ÷ fields extracted', k10, k10.reduce((s, r) => s + (r.extracted - r.corrected), 0), k10.reduce((s, r) => s + r.extracted, 0),
    [{ key: 'inv_ref', header: 'Invoice', kind: 'ref' }, { key: 'vendor', header: 'Vendor' }, { key: 'extracted', header: 'Fields extracted', kind: 'num' }, { key: 'corrected', header: 'Corrected', kind: 'num' }, { key: 'accuracy', header: 'Accuracy', kind: 'pct' }],
    'No invoice was read by OCR in this period.', { note: 'OCR is simulated in this MVP.', decision: 'Q KPI-10' }));
  const k11 = inv.map((i) => ({ id: i.id, link: `/invoices/${i.id}`, inv_ref: i.inv_ref, vendor: i.vendor, status: i.status, exceptions: i.rules.join(', ') || '—', clean: i.clean ? 'Yes' : 'No' }));
  out.push(ratio('KPI-11', '3-way match success', 'Invoices matched without any exception ÷ invoices uploaded', k11, k11.filter((r) => r.clean === 'Yes').length, k11.length,
    [{ key: 'inv_ref', header: 'Invoice', kind: 'ref' }, { key: 'vendor', header: 'Vendor' }, { key: 'status', header: 'Status', kind: 'status' }, { key: 'exceptions', header: 'Exceptions' }, { key: 'clean', header: 'Matched without exception' }],
    'No invoice was uploaded in this period.'));

  // KPI-12 dispute closure TAT
  const k12 = all<{ id: number; dsp_no: string | null; type: string; created_at: string; resolved_at: string | null; closed_at: string | null; status: string; plant: string | null; buyer_id: number | null }>(
    "SELECT d.id, d.dsp_no, d.type, d.created_at, d.resolved_at, d.closed_at, d.status, p.plant, p.buyer_id FROM disputes d LEFT JOIN pos p ON p.id = d.po_id WHERE d.status IN ('Resolved','Closed')",
  ).map((d) => ({ ...d, end: d.resolved_at ?? d.closed_at })).filter((d) => inPeriod(d.end, from, to) && okBuyer(d.buyer_id) && okPlant(d.plant))
    .map((d) => ({ id: d.id, link: `/disputes/${d.id}`, dsp_no: d.dsp_no ?? `#${d.id}`, type: d.type, raised: d.created_at, closed: d.end, tat_days: daysDiff(d.created_at, d.end) }));
  out.push(stat('KPI-12', 'Dispute closure TAT', 'Median and P90 of (dispute resolved or closed − raised)', 'days', k12, 'tat_days',
    [{ key: 'dsp_no', header: 'Dispute', kind: 'ref' }, { key: 'type', header: 'Type' }, { key: 'raised', header: 'Raised', kind: 'datetime' }, { key: 'closed', header: 'Resolved', kind: 'datetime' }, { key: 'tat_days', header: 'TAT', kind: 'days' }],
    'No dispute was resolved in this period.'));

  // KPI-13 vendor score
  const k13 = vendorScores().map((s) => ({ id: s.vendor.id, link: `/vendors/${s.vendor.id}`, vendor: s.vendor.name, rfq: s.components.rfq_response, ack: s.components.ack_tat, delivery: s.components.delivery, disputes: s.components.disputes, invoice: s.components.invoice_accuracy, score: s.score }));
  const w = cfg<Record<string, number>>('vendor.scorecard_weights');
  out.push({ ...stat('KPI-13', 'Vendor score', `Weighted composite: RFQ response ${w.rfq_response} · ack TAT ${w.ack_tat} · delivery ${w.delivery} · disputes ${w.disputes} · invoice accuracy ${w.invoice_accuracy} (median across vendors)`, 'score', k13, 'score',
    [{ key: 'vendor', header: 'Vendor', kind: 'ref' }, { key: 'rfq', header: 'RFQ response', kind: 'score' }, { key: 'ack', header: 'Ack TAT', kind: 'score' }, { key: 'delivery', header: 'Delivery', kind: 'score' }, { key: 'disputes', header: 'Disputes', kind: 'score' }, { key: 'invoice', header: 'Invoice accuracy', kind: 'score' }, { key: 'score', header: 'Composite', kind: 'score' }],
    'No vendor has enough history to score.', { decision: 'DEC-22', period_applies: false, note: 'Uses the full history; weights and vendor visibility pending DEC-22.' }), p90: undefined });

  // KPI-14 buyer productivity (coaching, not ranking)
  const decided = all<{ pr_line_id: number; decided_by: number; decided_at: string }>('SELECT pr_line_id, decided_by, MAX(decided_at) AS decided_at FROM route_decisions GROUP BY pr_line_id, decided_by').filter((d) => inPeriod(d.decided_at, from, to));
  const closed = all<{ id: number; buyer_id: number; closed_at: string }>("SELECT id, buyer_id, closed_at FROM pr_lines WHERE status = 'Closed' AND buyer_id IS NOT NULL").filter((c) => inPeriod(c.closed_at, from, to));
  const buyers = all<{ id: number; name: string }>("SELECT id, name FROM users WHERE active = 1 AND (',' || roles || ',') LIKE '%,BUY,%' ORDER BY name").filter((b) => okBuyer(b.id));
  const k14 = buyers.map((b) => {
    const lines = new Set([...decided.filter((d) => d.decided_by === b.id).map((d) => d.pr_line_id), ...closed.filter((c) => c.buyer_id === b.id).map((c) => c.id)]);
    return { id: b.id, link: `/pr?view=open&buyer=${b.id}`, buyer: b.name, lines: lines.size };
  });
  out.push({ ...stat('KPI-14', 'Buyer productivity', 'PR lines processed per buyer (route decided or line closed) in the period — median across buyers', 'lines', k14, 'lines',
    [{ key: 'buyer', header: 'Buyer', kind: 'ref' }, { key: 'lines', header: 'Lines processed', kind: 'num' }], 'No buyers in scope.'), p90: undefined, note: 'For coaching, not ranking: buyers are listed alphabetically.' });

  // KPI-15 advance outstanding ageing
  const bounds = cfg<number[]>('pay.advance_buckets');
  const k15 = all<{ id: number; adv_no: string; vendor: string | null; amount: number; adjusted_amount: number; paid_date: string | null; status: string; plant: string | null; buyer_id: number | null }>(
    "SELECT a.id, a.adv_no, v.name AS vendor, a.amount, a.adjusted_amount, a.paid_date, a.status, p.plant, p.buyer_id FROM advances a LEFT JOIN vendors v ON v.id = a.vendor_id LEFT JOIN pos p ON p.id = a.po_id WHERE a.status IN ('Paid','Partially adjusted')",
  ).filter((a) => okBuyer(a.buyer_id) && okPlant(a.plant)).map((a) => {
    const age = a.paid_date ? Math.floor((Date.now() - Date.parse(a.paid_date)) / 86400000) : 0;
    const i = bounds.findIndex((b) => age <= b);
    return { id: a.id, link: `/advances/${a.id}`, adv_no: a.adv_no, vendor: a.vendor ?? '—', paid_date: a.paid_date, outstanding: round(a.amount - (a.adjusted_amount ?? 0)), age_days: age, bucket: i === -1 ? `> ${bounds.at(-1)} d` : i === 0 ? `0–${bounds[0]} d` : `${bounds[i - 1] + 1}–${bounds[i]} d` };
  }).filter((a) => a.outstanding > 0);
  out.push({
    id: 'KPI-15', name: 'Advance outstanding ageing', formula: 'Σ (advance paid − adjusted) for unadjusted advances, aged from SAP payment date in configured buckets', unit: 'money',
    value: round(k15.reduce((s, r) => s + r.outstanding, 0)), median: median(k15.map((r) => r.age_days)), n: k15.length, rows: k15,
    columns: [{ key: 'adv_no', header: 'Advance', kind: 'ref' }, { key: 'vendor', header: 'Vendor' }, { key: 'paid_date', header: 'Paid', kind: 'date' }, { key: 'outstanding', header: 'Outstanding', kind: 'money' }, { key: 'age_days', header: 'Age', kind: 'days' }, { key: 'bucket', header: 'Bucket' }],
    empty: 'No unadjusted advance is outstanding.', note: 'Median shown is the median age in days.', decision: 'Q KPI-15', period_applies: false, ...base,
  });
  return out;
}
