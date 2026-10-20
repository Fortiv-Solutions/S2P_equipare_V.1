/**
 * RPT-01 … RPT-12 (PRD Sec 13). Each report reads the platform tables directly (other modules create the
 * quotations, comparisons, acknowledgements, ASNs, disputes, invoices and advances) and returns an
 * empty-state message when there is no data yet.
 */
import { all, get } from '../../core/db.ts';
import { cfg } from '../../core/config.ts';
import { accuracy } from '../invoices/ocr.ts';
import { OPEN_STATUSES } from '../pr/service.ts';
import { daysDiff, hoursDiff, median, round, today, type ReportDef, type Row, type Col } from './engine.ts';

const ageDays = (from: string | null | undefined, to?: string | null) => (from ? Math.max(0, Math.floor((new Date(to ?? Date.now()).getTime() - new Date(from).getTime()) / 86400000)) : null);
const bucketOf = (age: number, bounds: number[]) => {
  for (let i = 0; i < bounds.length; i++) if (age <= bounds[i]) return i === 0 ? `0–${bounds[0]} d` : `${bounds[i - 1] + 1}–${bounds[i]} d`;
  return `> ${bounds[bounds.length - 1]} d`;
};
const bucketLabels = (bounds: number[]) => [...bounds.map((b, i) => (i === 0 ? `0–${b} d` : `${bounds[i - 1] + 1}–${b} d`)), `> ${bounds[bounds.length - 1]} d`];
const slug = (s: string) => 'b:' + s;
const CONTRACT_TYPES = ['ARC', 'OA', 'FDS', 'VMI'];
const POSTED = ['Posted', 'Payment due', 'Payment released', 'Payment blocked'];
const MATCHED_OR_LATER = ['Matched', 'Parked', ...POSTED];

/** On-time delivery basis for KPI-07 / RPT-11: first or latest vendor commitment (Q 7.7). */
export function commitmentBasis() {
  return cfg<string>('reports.kpi07_commitment') === 'first' ? 'first' : 'latest';
}

/** Fully received PO lines with last GRN date and on-time flag (KPI-07). */
export function receivedLines() {
  const basis = commitmentBasis();
  return all<{ id: number; po_id: number; po_no: string; item: number; vendor_id: number; vendor: string; plant: string; qty: number; received_qty: number; delivery_date: string; commit_date: string | null; first_commit_date: string | null; last_grn: string | null; buyer_id: number | null; category: string | null; description: string }>(
    `SELECT pl.id, pl.po_id, p.po_no, pl.item, p.vendor_id, v.name AS vendor, p.plant, pl.qty, pl.received_qty, pl.delivery_date, pl.commit_date, pl.first_commit_date,
            (SELECT MAX(g.posting_date) FROM grns g WHERE g.po_line_id = pl.id) AS last_grn, p.buyer_id, m.category, pl.description
     FROM po_lines pl JOIN pos p ON p.id = pl.po_id JOIN vendors v ON v.id = p.vendor_id LEFT JOIN materials m ON m.id = pl.material_id
     WHERE pl.status != 'Cancelled' AND pl.received_qty >= pl.qty AND pl.qty > 0`,
  ).filter((l) => l.last_grn).map((l) => {
    const committed = (basis === 'first' ? l.first_commit_date ?? l.commit_date : l.commit_date) ?? l.delivery_date;
    return { ...l, committed, on_time: !!l.last_grn && l.last_grn <= committed };
  });
}

/** Quotation counted as quoted for KPI-03 / RPT-02. */
const QUOTED = "q.submitted_at IS NOT NULL AND q.status NOT IN ('Draft','Not started','Declined')";

// ====================================================================== RPT-01
const rpt01: ReportDef = {
  id: 'rpt-01', no: 'RPT-01', title: 'PR ageing & buyer workload', screen: 'SCR-RPT-01', roles: ['BUY', 'APR', 'MGT'],
  description: 'Open PR lines with procurement by buyer, plant, material group, priority and route: open count, ageing buckets, assigned and unassigned.',
  filters: ['date', 'plant', 'category', 'buyer', 'priority', 'route'], dateLabel: 'Arrived from SAP', flows: ['INT-M03'],
  build: () => {
    const bounds = cfg<number[]>('reports.pr_ageing_buckets');
    const rows: Row[] = all<{ id: number; pr_no: string; item: number; description: string; material_code: string; plant: string; category: string | null; material_group: string | null; priority: string; route: string | null; status: string; buyer_id: number | null; buyer: string | null; available_at: string | null; sla_due: string | null; requisitioner_id: number | null }>(
      `SELECT l.*, b.name AS buyer FROM pr_lines l LEFT JOIN users b ON b.id = l.buyer_id WHERE l.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`, ...OPEN_STATUSES,
    ).map((l) => {
      const age = ageDays(l.available_at) ?? 0;
      const bucket = bucketOf(age, bounds);
      const sla = !!l.sla_due && new Date(l.sla_due).getTime() < Date.now();
      return {
        id: l.id, link: `/pr/${l.id}`, ref: `${l.pr_no}/${l.item}`, description: l.description, material_code: l.material_code, plant: l.plant, category: l.category ?? '—',
        material_group: l.material_group ?? '—', priority: l.priority, route: l.route ?? 'Not routed', buyer: l.buyer ?? 'Unassigned', status: l.status, age_days: age, bucket,
        arrived: l.available_at, sla_breached: sla ? 'Yes' : 'No',
        tags: ['open', slug(bucket), l.buyer_id ? 'assigned' : 'unassigned', ...(l.priority !== 'Normal' ? ['priority'] : []), ...(sla ? ['sla'] : [])],
        _date: l.available_at, _plant: l.plant, _category: l.category, _buyer_id: l.buyer_id, _priority: l.priority, _route: l.route ?? 'Not routed', _req_id: l.requisitioner_id,
      };
    });
    const labels = bucketLabels(bounds);
    return {
      rows,
      columns: [
        { key: 'ref', header: 'PR / item', kind: 'ref' }, { key: 'description', header: 'Material' }, { key: 'plant', header: 'Plant' }, { key: 'material_group', header: 'Material group' },
        { key: 'priority', header: 'Priority', kind: 'status' }, { key: 'route', header: 'Route' }, { key: 'buyer', header: 'Buyer' }, { key: 'status', header: 'Status', kind: 'status' },
        { key: 'age_days', header: 'Age', kind: 'days' }, { key: 'bucket', header: 'Bucket' }, { key: 'sla_breached', header: 'SLA breached', hidden: true }, { key: 'arrived', header: 'Arrived', kind: 'datetime', hidden: true },
      ],
      tiles: [
        { key: 'open', label: 'Open PR lines', agg: 'count', tag: 'open', format: 'count' },
        { key: 'unassigned', label: 'Unassigned', agg: 'count', tag: 'unassigned', format: 'count' },
        ...labels.map((b) => ({ key: slug(b), label: `Age ${b}`, agg: 'count' as const, tag: slug(b), format: 'count' as const })),
        { key: 'priority', label: 'Urgent / BD / Class 1', agg: 'count', tag: 'priority', format: 'count' },
        { key: 'sla', label: 'Past priority SLA', agg: 'count', tag: 'sla', format: 'count' },
      ],
      chart: { title: 'Open lines by ageing bucket', groups: [{ key: 'buyer', label: 'Buyer' }, { key: 'plant', label: 'Plant' }, { key: 'material_group', label: 'Material group' }, { key: 'priority', label: 'Priority' }, { key: 'route', label: 'Route' }], value: 'count', format: 'count', parts: labels.map((b) => ({ label: b, tag: slug(b) })) },
      empty: 'No open PR lines with procurement. New released PRs arrive from SAP on the next INT-M03 sync.',
      notes: ['Age counts calendar days from when the line arrived from SAP (working-day basis pending DEC-15).'], decisions: ['DEC-15'],
    };
  },
};

// ====================================================================== RPT-02
const rpt02: ReportDef = {
  id: 'rpt-02', no: 'RPT-02', title: 'RFQ coverage', screen: 'SCR-RPT-02', roles: ['BUY', 'APR', 'MGT'],
  description: 'RFQs floated with invited, responded, declined and non-participating vendors, and RFQs below the category minimum vendor count.',
  filters: ['date', 'plant', 'category', 'buyer'], dateLabel: 'Published', flows: ['INT-M01'],
  build: () => {
    const rows: Row[] = all<{ id: number; rfq_no: string; title: string | null; status: string; category: string | null; plant: string | null; buyer_id: number | null; buyer: string | null; published_at: string | null; min_vendors: number | null; invited: number; declined: number; responded: number; quoted: number }>(
      `SELECT r.id, r.rfq_no, r.title, r.status, r.category, r.plant, r.buyer_id, b.name AS buyer, r.published_at, c.min_vendors,
              (SELECT COUNT(*) FROM rfq_invitations i WHERE i.rfq_id = r.id) AS invited,
              (SELECT COUNT(*) FROM rfq_invitations i WHERE i.rfq_id = r.id AND (i.status = 'Declined' OR i.declined_at IS NOT NULL)) AS declined,
              (SELECT COUNT(*) FROM rfq_invitations i WHERE i.rfq_id = r.id AND i.status != 'Declined' AND i.declined_at IS NULL AND (i.status = 'Responded' OR i.responded_at IS NOT NULL OR EXISTS (SELECT 1 FROM quotations q WHERE q.rfq_id = r.id AND q.vendor_id = i.vendor_id AND ${QUOTED}))) AS responded,
              (SELECT COUNT(*) FROM quotations q WHERE q.rfq_id = r.id AND ${QUOTED}) AS quoted
       FROM rfqs r LEFT JOIN users b ON b.id = r.buyer_id LEFT JOIN spend_categories c ON c.code = r.category
       WHERE r.status NOT IN ('Draft') AND r.published_at IS NOT NULL`,
    ).map((r) => {
      const nonPart = Math.max(0, r.invited - r.responded - r.declined);
      const below = r.min_vendors != null && r.invited < r.min_vendors;
      return {
        id: r.id, link: `/rfqs/${r.id}`, rfq_no: r.rfq_no, title: r.title ?? '—', status: r.status, category: r.category ?? '—', plant: r.plant ?? '—', buyer: r.buyer ?? '—', published_at: r.published_at,
        invited: r.invited, responded: r.responded, declined: r.declined, non_participating: nonPart, quoted: r.quoted, min_vendors: r.min_vendors, below_minimum: below ? 'Yes' : 'No',
        response_rate: r.invited ? round(r.responded / r.invited, 4) : null,
        tags: ['floated', ...(below ? ['below_min'] : []), ...(r.declined ? ['declines'] : []), ...(nonPart ? ['nonpart'] : [])],
        _date: r.published_at, _plant: r.plant, _category: r.category, _buyer_id: r.buyer_id,
      };
    });
    return {
      rows,
      columns: [
        { key: 'rfq_no', header: 'RFQ', kind: 'ref' }, { key: 'title', header: 'Title' }, { key: 'status', header: 'Status', kind: 'status' }, { key: 'category', header: 'Category' }, { key: 'buyer', header: 'Buyer' },
        { key: 'published_at', header: 'Published', kind: 'date' }, { key: 'invited', header: 'Invited', kind: 'num' }, { key: 'responded', header: 'Responded', kind: 'num' }, { key: 'declined', header: 'Declined', kind: 'num' },
        { key: 'non_participating', header: 'Not participating', kind: 'num' }, { key: 'min_vendors', header: 'Category minimum', kind: 'num' }, { key: 'below_minimum', header: 'Below minimum' }, { key: 'response_rate', header: 'Response rate', kind: 'pct' },
      ],
      tiles: [
        { key: 'floated', label: 'RFQs floated', agg: 'count', tag: 'floated', format: 'count' },
        { key: 'invited', label: 'Vendors invited', agg: 'sum', field: 'invited', format: 'count' },
        { key: 'responded', label: 'Responded', agg: 'sum', field: 'responded', format: 'count' },
        { key: 'declines', label: 'Declined', agg: 'sum', field: 'declined', tag: 'declines', format: 'count' },
        { key: 'nonpart', label: 'Not participating', agg: 'sum', field: 'non_participating', tag: 'nonpart', format: 'count' },
        { key: 'below_min', label: 'Below category minimum', agg: 'count', tag: 'below_min', format: 'count' },
        { key: 'rate', label: 'Response rate', agg: 'ratio_sum', num_field: 'responded', den_field: 'invited', format: 'pct' },
      ],
      chart: { title: 'Vendor participation', groups: [{ key: 'category', label: 'Category' }, { key: 'buyer', label: 'Buyer' }, { key: 'plant', label: 'Plant' }], value: { sum: 'invited' }, format: 'count', parts: [{ label: 'Responded', field: 'responded' }, { label: 'Declined', field: 'declined' }, { label: 'Not participating', field: 'non_participating' }] },
      empty: 'No RFQs have been published yet. RFQs appear here once a buyer publishes one from the RFQ builder.',
    };
  },
};

// ====================================================================== RPT-03
const rpt03: ReportDef = {
  id: 'rpt-03', no: 'RPT-03', title: 'Quotation & approval cycle time', screen: 'SCR-RPT-03', roles: ['BUY', 'APR', 'FIN', 'MGT'],
  description: 'RFQ-to-quote time, comparison time after close (KPI-04), approval ageing (KPI-05) and rework per RFQ.',
  filters: ['date', 'plant', 'category', 'buyer'], dateLabel: 'Published', flows: [],
  build: () => {
    const rfqs = all<{ id: number; rfq_no: string; title: string | null; status: string; category: string | null; plant: string | null; buyer_id: number | null; buyer: string | null; published_at: string; closed_at: string | null }>(
      "SELECT r.id, r.rfq_no, r.title, r.status, r.category, r.plant, r.buyer_id, b.name AS buyer, r.published_at, r.closed_at FROM rfqs r LEFT JOIN users b ON b.id = r.buyer_id WHERE r.published_at IS NOT NULL",
    );
    const rows: Row[] = rfqs.map((r) => {
      const qs = all<{ submitted_at: string }>(`SELECT q.submitted_at FROM quotations q WHERE q.rfq_id = ? AND ${QUOTED}`, r.id);
      const quoteDays = median(qs.map((q) => daysDiff(r.published_at, q.submitted_at) ?? NaN));
      const cmp = get<{ id: number; cmp_no: string | null; version: number; status: string; submitted_at: string | null }>('SELECT id, cmp_no, version, status, submitted_at FROM comparisons WHERE rfq_id = ? ORDER BY version DESC, id DESC LIMIT 1', r.id);
      const cmpTat = cmp?.submitted_at && r.closed_at ? daysDiff(r.closed_at, cmp.submitted_at) : null;
      const aps = cmp ? all<{ status: string; created_at: string; decided_at: string | null }>("SELECT status, created_at, decided_at FROM approvals WHERE object_type = 'comparison' AND object_id IN (SELECT id FROM comparisons WHERE rfq_id = ?) ORDER BY id", r.id) : [];
      const ap = aps.at(-1);
      const apAge = ap ? daysDiff(ap.created_at, ap.decided_at ?? new Date().toISOString()) : null;
      const rework = aps.filter((a) => a.status === 'Returned').length + Math.max(0, (cmp?.version ?? 1) - 1);
      const pending = ap && ['Pending', 'Clarification requested'].includes(ap.status);
      return {
        id: r.id, link: `/rfqs/${r.id}`, rfq_no: r.rfq_no, title: r.title ?? '—', status: r.status, buyer: r.buyer ?? '—', category: r.category ?? '—', plant: r.plant ?? '—', published_at: r.published_at, closed_at: r.closed_at,
        quotes: qs.length, quote_days: quoteDays, comparison: cmp?.cmp_no ?? (cmp ? `#${cmp.id}` : '—'), comparison_status: cmp?.status ?? '—', comparison_tat_days: cmpTat,
        approval_status: ap?.status ?? '—', approval_age_days: apAge, rework,
        tags: ['rfq', ...(quoteDays != null ? ['quoted'] : []), ...(cmpTat != null ? ['compared'] : []), ...(pending ? ['pending'] : []), ...(pending && (apAge ?? 0) > 3 ? ['aged'] : []), ...(rework ? ['rework'] : [])],
        _date: r.published_at, _plant: r.plant, _category: r.category, _buyer_id: r.buyer_id,
      };
    });
    return {
      rows,
      columns: [
        { key: 'rfq_no', header: 'RFQ', kind: 'ref' }, { key: 'title', header: 'Title' }, { key: 'status', header: 'Status', kind: 'status' }, { key: 'buyer', header: 'Buyer' },
        { key: 'quotes', header: 'Quotes', kind: 'num' }, { key: 'quote_days', header: 'RFQ → quote (median)', kind: 'days' }, { key: 'comparison', header: 'Comparison' },
        { key: 'comparison_tat_days', header: 'Close → comparison', kind: 'days' }, { key: 'approval_status', header: 'Approval', kind: 'status' }, { key: 'approval_age_days', header: 'Approval age', kind: 'days' },
        { key: 'rework', header: 'Rework', kind: 'num' }, { key: 'published_at', header: 'Published', kind: 'date', hidden: true }, { key: 'closed_at', header: 'Closed', kind: 'datetime', hidden: true },
      ],
      tiles: [
        { key: 'rfq', label: 'RFQs published', agg: 'count', tag: 'rfq', format: 'count' },
        { key: 'quoted', label: 'Median RFQ-to-quote', agg: 'median', field: 'quote_days', tag: 'quoted', format: 'days' },
        { key: 'compared', label: 'Median comparison TAT (KPI-04)', agg: 'median', field: 'comparison_tat_days', tag: 'compared', format: 'days' },
        { key: 'pending', label: 'Approvals pending', agg: 'count', tag: 'pending', format: 'count' },
        { key: 'aged', label: 'Pending > 3 days', agg: 'count', tag: 'aged', format: 'count' },
        { key: 'rework', label: 'Returned / reworked', agg: 'count', tag: 'rework', format: 'count' },
      ],
      chart: { title: 'Average days from RFQ close to comparison submitted', groups: [{ key: 'buyer', label: 'Buyer' }, { key: 'category', label: 'Category' }], value: { avg: 'comparison_tat_days' }, format: 'days' },
      empty: 'No RFQs have been published yet, so there are no quotation or approval cycle times to show.',
    };
  },
};

// ====================================================================== RPT-04 / RPT-05 shared open PO lines
interface OpenLine { id: number; po_id: number; po_no: string; item: number; vendor_id: number; vendor: string; buyer_id: number | null; buyer: string | null; plant: string; urgency: string; po_date: string; description: string; material_code: string | null; category: string | null; qty: number; received_qty: number; unit_price: number; uom: string; delivery_date: string; commit_date: string | null; delay_reason: string | null; ack_status: string; ack_at: string | null; status: string; next_action_date: string | null; published_at: string | null; requisitioner_id: number | null; route: string | null }
function openLines() {
  return all<OpenLine>(
    `SELECT pl.id, pl.po_id, p.po_no, pl.item, p.vendor_id, v.name AS vendor, p.buyer_id, b.name AS buyer, p.plant, p.urgency, p.po_date, pl.description, m.code AS material_code, m.category,
            pl.qty, pl.received_qty, pl.unit_price, pl.uom, pl.delivery_date, pl.commit_date, pl.delay_reason, pl.ack_status, pl.ack_at, pl.status, pl.next_action_date, p.published_at,
            pr.requisitioner_id, pr.route
     FROM po_lines pl JOIN pos p ON p.id = pl.po_id JOIN vendors v ON v.id = p.vendor_id LEFT JOIN users b ON b.id = p.buyer_id
     LEFT JOIN materials m ON m.id = pl.material_id LEFT JOIN pr_lines pr ON pr.id = pl.pr_line_id
     WHERE p.status NOT IN ('Closed','Cancelled') AND pl.status NOT IN ('Received','Closed','Cancelled') AND p.sap_released = 1`,
  );
}
const lineScope = (l: OpenLine) => ({ _date: l.po_date, _plant: l.plant, _category: l.category, _buyer_id: l.buyer_id, _vendor_id: l.vendor_id, _priority: l.urgency, _route: l.route, _req_id: l.requisitioner_id });

const rpt04: ReportDef = {
  id: 'rpt-04', no: 'RPT-04', title: 'Open PO', screen: 'SCR-RPT-04', roles: ['REQ', 'BUY', 'APR', 'STO', 'FIN', 'MGT'], own: true,
  description: 'Open PO lines by vendor, buyer, plant, material and urgency: open quantity, delivery date, commitment, delay reason and overdue.',
  filters: ['date', 'plant', 'category', 'buyer', 'vendor', 'priority', 'route'], dateLabel: 'PO date', flows: ['INT-M07', 'INT-M10'],
  build: () => {
    const t = today();
    const rows: Row[] = openLines().map((l) => {
      const open = round(l.qty - l.received_qty, 3);
      const due = l.commit_date ?? l.delivery_date;
      const overdue = due < t ? Math.floor((Date.parse(t) - Date.parse(due)) / 86400000) : 0;
      const pendingAck = ['Pending', 'Pending re-acknowledgement'].includes(l.ack_status);
      return {
        id: l.id, link: `/pos/${l.po_id}`, ref: `${l.po_no}/${l.item}`, vendor: l.vendor, vendor_link: `/vendors/${l.vendor_id}`, buyer: l.buyer ?? '—', plant: l.plant, urgency: l.urgency, po_date: l.po_date,
        material: l.material_code ?? '—', description: l.description, qty: l.qty, received: l.received_qty, open_qty: open, uom: l.uom, open_value: round(open * l.unit_price), delivery_date: l.delivery_date,
        commitment: l.commit_date, delay_reason: l.delay_reason ?? '—', ack_status: l.ack_status, overdue_days: overdue,
        tags: ['open', overdue ? 'overdue' : 'on_track', ...(pendingAck ? ['pending_ack'] : []), ...(l.ack_status === 'Rejected' ? ['rejected'] : []), ...(l.urgency !== 'General stock' ? ['urgent'] : [])],
        ...lineScope(l),
      };
    });
    return {
      rows,
      columns: [
        { key: 'ref', header: 'PO / item', kind: 'ref' }, { key: 'vendor', header: 'Vendor', link: 'vendor_link' }, { key: 'buyer', header: 'Buyer' }, { key: 'plant', header: 'Plant' },
        { key: 'urgency', header: 'Urgency', kind: 'status' }, { key: 'description', header: 'Material' }, { key: 'open_qty', header: 'Open qty', kind: 'num' }, { key: 'uom', header: 'UoM', hidden: true },
        { key: 'open_value', header: 'Open value', kind: 'money', restricted: true }, { key: 'delivery_date', header: 'PO delivery', kind: 'date' }, { key: 'commitment', header: 'Commitment', kind: 'date' },
        { key: 'delay_reason', header: 'Delay reason' }, { key: 'ack_status', header: 'Acknowledgement', kind: 'status' }, { key: 'overdue_days', header: 'Overdue', kind: 'days' },
        { key: 'po_date', header: 'PO date', kind: 'date', hidden: true }, { key: 'material', header: 'Material code', hidden: true }, { key: 'qty', header: 'Ordered', kind: 'num', hidden: true }, { key: 'received', header: 'Received', kind: 'num', hidden: true },
      ],
      tiles: [
        { key: 'open', label: 'Open PO lines', agg: 'count', tag: 'open', format: 'count' },
        { key: 'overdue', label: 'Overdue', agg: 'count', tag: 'overdue', format: 'count' },
        { key: 'pending_ack', label: 'Awaiting acknowledgement', agg: 'count', tag: 'pending_ack', format: 'count' },
        { key: 'urgent', label: 'BD / urgent / Class 1', agg: 'count', tag: 'urgent', format: 'count' },
        { key: 'value', label: 'Open value', agg: 'sum', field: 'open_value', format: 'money', restricted: true },
      ],
      chart: { title: 'Open lines (overdue highlighted)', groups: [{ key: 'vendor', label: 'Vendor' }, { key: 'buyer', label: 'Buyer' }, { key: 'plant', label: 'Plant' }, { key: 'urgency', label: 'Urgency' }], value: 'count', format: 'count', parts: [{ label: 'Overdue', tag: 'overdue' }, { label: 'On track', tag: 'on_track' }] },
      empty: 'No open PO lines. Released SAP POs appear here after the INT-M07 sync.',
    };
  },
};

const rpt05: ReportDef = {
  id: 'rpt-05', no: 'RPT-05', title: 'Vendor follow-up', screen: 'SCR-RPT-05', roles: ['BUY', 'APR', 'MGT'],
  description: 'PO lines pending acknowledgement or dispatch, with reminder count, latest vendor response and next action date.',
  filters: ['date', 'plant', 'category', 'buyer', 'vendor', 'priority'], dateLabel: 'PO date', flows: ['INT-M07'],
  build: () => {
    const t = today();
    const rows: Row[] = [];
    for (const l of openLines()) {
      const pendingAck = ['Pending', 'Pending re-acknowledgement'].includes(l.ack_status);
      const inDispatch = !!get("SELECT 1 FROM asns WHERE po_id = ? AND status IN ('Submitted','In transit')", l.po_id);
      const pendingDispatch = !pendingAck && ['Accepted', 'Partially accepted', 'Deemed accepted'].includes(l.ack_status) && l.status === 'Published' && !inDispatch && l.received_qty < l.qty;
      if (!pendingAck && !pendingDispatch) continue;
      const fu = all<{ kind: string; note: string | null; created_at: string; next_action_date: string | null }>('SELECT kind, note, created_at, next_action_date FROM po_followups WHERE po_id = ? AND (po_line_id = ? OR po_line_id IS NULL) ORDER BY id', l.po_id, l.id);
      const reminders = fu.filter((f) => /remind/i.test(f.kind)).length;
      const escalations = fu.filter((f) => /escalat/i.test(f.kind)).length;
      const vendorResp = [...fu].reverse().find((f) => /vendor/i.test(f.kind));
      const latest = vendorResp?.created_at ?? l.ack_at;
      const next = l.next_action_date ?? [...fu].reverse().find((f) => f.next_action_date)?.next_action_date ?? null;
      const due = l.commit_date ?? l.delivery_date;
      const overdue = due < t;
      rows.push({
        id: l.id, link: `/pos/${l.po_id}`, ref: `${l.po_no}/${l.item}`, vendor: l.vendor, vendor_link: `/vendors/${l.vendor_id}`, buyer: l.buyer ?? '—', plant: l.plant, urgency: l.urgency, description: l.description,
        stage: pendingAck ? 'Pending acknowledgement' : 'Pending dispatch', ack_status: l.ack_status, published_at: l.published_at, due, reminders, escalations,
        latest_response: latest, latest_note: vendorResp?.note ?? (l.ack_at ? 'Acknowledged' : 'No response yet'), next_action: next,
        tags: [pendingAck ? 'pending_ack' : 'pending_dispatch', ...(overdue ? ['overdue'] : []), ...(next ? [] : ['no_next']), ...(escalations ? ['escalated'] : [])],
        ...lineScope(l),
      });
    }
    return {
      rows,
      columns: [
        { key: 'ref', header: 'PO / item', kind: 'ref' }, { key: 'vendor', header: 'Vendor', link: 'vendor_link' }, { key: 'buyer', header: 'Buyer' }, { key: 'stage', header: 'Pending', kind: 'status' },
        { key: 'description', header: 'Material' }, { key: 'due', header: 'Due / committed', kind: 'date' }, { key: 'reminders', header: 'Reminders', kind: 'num' }, { key: 'escalations', header: 'Escalations', kind: 'num' },
        { key: 'latest_response', header: 'Latest response', kind: 'datetime' }, { key: 'latest_note', header: 'Response' }, { key: 'next_action', header: 'Next action', kind: 'date' },
        { key: 'published_at', header: 'Published', kind: 'datetime', hidden: true }, { key: 'urgency', header: 'Urgency', hidden: true },
      ],
      tiles: [
        { key: 'pending_ack', label: 'Pending acknowledgement', agg: 'count', tag: 'pending_ack', format: 'count' },
        { key: 'pending_dispatch', label: 'Pending dispatch', agg: 'count', tag: 'pending_dispatch', format: 'count' },
        { key: 'overdue', label: 'Past due date', agg: 'count', tag: 'overdue', format: 'count' },
        { key: 'reminders', label: 'Reminders sent', agg: 'sum', field: 'reminders', format: 'count' },
        { key: 'no_next', label: 'No next action date', agg: 'count', tag: 'no_next', format: 'count' },
        { key: 'escalated', label: 'Escalated', agg: 'count', tag: 'escalated', format: 'count' },
      ],
      chart: { title: 'Lines awaiting the vendor', groups: [{ key: 'vendor', label: 'Vendor' }, { key: 'buyer', label: 'Buyer' }], value: 'count', format: 'count', parts: [{ label: 'Pending acknowledgement', tag: 'pending_ack' }, { label: 'Pending dispatch', tag: 'pending_dispatch' }] },
      empty: 'No PO lines are waiting for a vendor acknowledgement or dispatch.',
    };
  },
};

// ====================================================================== RPT-06
const rpt06: ReportDef = {
  id: 'rpt-06', no: 'RPT-06', title: 'ARC / OA opportunity', screen: 'SCR-RPT-06', roles: ['BUY', 'APR', 'FIN', 'MGT'],
  description: 'Materials bought repeatedly without an ARC/OA, by annual frequency, value and vendor concentration, with the review status.',
  filters: ['category'], flows: ['INT-M07', 'INT-M06'],
  build: () => {
    const th = cfg<{ lookback_days: number; min_frequency: number; min_annual_value: number }>('contract.opportunity');
    const since = new Date(Date.now() - th.lookback_days * 86400000).toISOString().slice(0, 10);
    const hist = all<{ material_id: number; code: string; description: string; category: string | null; frequency: number; value: number; vendors: number; last_po: string }>(
      `SELECT m.id AS material_id, m.code, m.description, m.category, COUNT(DISTINCT p.id) AS frequency, SUM(pl.qty * pl.unit_price) AS value, COUNT(DISTINCT p.vendor_id) AS vendors, MAX(p.po_date) AS last_po
       FROM po_lines pl JOIN pos p ON p.id = pl.po_id JOIN materials m ON m.id = pl.material_id
       WHERE p.po_date >= ? AND p.contract_id IS NULL AND pl.status != 'Cancelled' AND p.status != 'Cancelled' GROUP BY m.id`, since,
    );
    const opps = new Map(all<{ material_id: number; status: string; suggested_action: string | null; decision_reason: string | null }>('SELECT material_id, status, suggested_action, decision_reason FROM opportunities').map((o) => [o.material_id, o]));
    const covered = new Set(all<{ material_id: number }>("SELECT ci.material_id FROM contract_items ci JOIN contracts c ON c.id = ci.contract_id WHERE c.status IN ('Active','Expiring') AND c.valid_to >= date('now')").map((r) => r.material_id));
    const rows: Row[] = hist.filter((h) => (h.frequency >= th.min_frequency && h.value >= th.min_annual_value && !covered.has(h.material_id)) || opps.has(h.material_id)).map((h) => {
      const o = opps.get(h.material_id);
      const status = o?.status ?? 'Not reviewed';
      return {
        id: h.material_id, link: `/pr?material=${encodeURIComponent(h.code)}`, code: h.code, description: h.description, category: h.category ?? '—', frequency: h.frequency, annual_value: round(h.value),
        vendors: h.vendors, concentration: h.vendors === 1 ? 'Single vendor' : `${h.vendors} vendors`, last_po: h.last_po, status, suggested_action: o?.suggested_action ?? (h.vendors > 1 ? 'ARC via annual-rate RFQ' : 'OA with current vendor'),
        tags: ['opp', 'st:' + status], _category: h.category,
      };
    });
    return {
      rows,
      columns: [
        { key: 'code', header: 'Material', kind: 'ref' }, { key: 'description', header: 'Description' }, { key: 'category', header: 'Category' }, { key: 'frequency', header: 'POs / year', kind: 'num' },
        { key: 'annual_value', header: 'Annual value', kind: 'money' }, { key: 'concentration', header: 'Vendor concentration' }, { key: 'last_po', header: 'Last PO', kind: 'date' },
        { key: 'status', header: 'Review status', kind: 'status' }, { key: 'suggested_action', header: 'Suggested action' },
      ],
      tiles: [
        { key: 'opp', label: 'Opportunities', agg: 'count', tag: 'opp', format: 'count' },
        { key: 'value', label: 'Annual spend in scope', agg: 'sum', field: 'annual_value', format: 'money' },
        { key: 'st:Not reviewed', label: 'Not reviewed', agg: 'count', tag: 'st:Not reviewed', format: 'count' },
        { key: 'st:Under review', label: 'Under review', agg: 'count', tag: 'st:Under review', format: 'count' },
        { key: 'st:Accepted', label: 'Accepted (sourcing)', agg: 'count', tag: 'st:Accepted', format: 'count' },
      ],
      chart: { title: 'Annual spend without contract', groups: [{ key: 'category', label: 'Category' }, { key: 'status', label: 'Review status' }], value: { sum: 'annual_value' }, format: 'money' },
      empty: `No material was bought ${th.min_frequency}+ times for ₹${th.min_annual_value.toLocaleString('en-IN')}+ in the last ${th.lookback_days} days without a contract.`,
      notes: [`Thresholds: ${th.min_frequency} POs and ₹${th.min_annual_value.toLocaleString('en-IN')} in ${th.lookback_days} days (configurable).`], decisions: ['DEC-09'],
    };
  },
};

// ====================================================================== RPT-07
export function poValueLines() {
  return all<{ id: number; po_id: number; po_no: string; item: number; vendor_id: number; vendor: string; buyer_id: number | null; plant: string; po_date: string; category: string | null; description: string; value: number; contract_type: string | null; contract_no: string | null; contract_id: number | null; urgency: string; route: string | null; requisitioner_id: number | null }>(
    `SELECT pl.id, p.id AS po_id, p.po_no, pl.item, p.vendor_id, v.name AS vendor, p.buyer_id, p.plant, p.po_date, m.category, pl.description, pl.qty * pl.unit_price AS value,
            c.type AS contract_type, c.contract_no, c.id AS contract_id, p.urgency, pr.route, pr.requisitioner_id
     FROM po_lines pl JOIN pos p ON p.id = pl.po_id JOIN vendors v ON v.id = p.vendor_id LEFT JOIN materials m ON m.id = pl.material_id
     LEFT JOIN contracts c ON c.id = p.contract_id LEFT JOIN pr_lines pr ON pr.id = pl.pr_line_id
     WHERE p.status != 'Cancelled' AND pl.status != 'Cancelled'`,
  ).map((l) => {
    const coverage = l.contract_type ? (CONTRACT_TYPES.includes(l.contract_type) ? l.contract_type : 'Fixed supplier') : 'Spot';
    return { ...l, value: round(l.value), coverage };
  });
}

const rpt07: ReportDef = {
  id: 'rpt-07', no: 'RPT-07', title: 'Contract coverage', screen: 'SCR-RPT-07', roles: ['BUY', 'APR', 'FIN', 'MGT'],
  description: 'PO spend under ARC / OA / FDS / VMI against spot buying (KPI-08 contract coverage, KPI-09 spot dependency).',
  filters: ['date', 'plant', 'category', 'buyer', 'vendor'], dateLabel: 'PO date', flows: ['INT-M07', 'INT-M06'],
  build: () => {
    const rows: Row[] = poValueLines().map((l) => ({
      id: l.id, link: `/pos/${l.po_id}`, ref: `${l.po_no}/${l.item}`, vendor: l.vendor, vendor_link: `/vendors/${l.vendor_id}`, po_date: l.po_date, plant: l.plant, category: l.category ?? '—',
      description: l.description, value: l.value, coverage: l.coverage, contract: l.contract_no ?? '—', contract_link: l.contract_id ? `/contracts/${l.contract_id}` : null,
      contract_value: CONTRACT_TYPES.includes(l.coverage) ? l.value : 0, spot_value: l.coverage === 'Spot' ? l.value : 0, other_value: l.coverage === 'Fixed supplier' ? l.value : 0,
      tags: ['all', CONTRACT_TYPES.includes(l.coverage) ? 'contract' : l.coverage === 'Spot' ? 'spot' : 'fixed', 'cov:' + l.coverage],
      _date: l.po_date, _plant: l.plant, _category: l.category, _buyer_id: l.buyer_id, _vendor_id: l.vendor_id,
    }));
    return {
      rows,
      columns: [
        { key: 'ref', header: 'PO / item', kind: 'ref' }, { key: 'po_date', header: 'PO date', kind: 'date' }, { key: 'vendor', header: 'Vendor', link: 'vendor_link' }, { key: 'category', header: 'Category' },
        { key: 'description', header: 'Material' }, { key: 'value', header: 'Value (basic)', kind: 'money' }, { key: 'coverage', header: 'Coverage', kind: 'status' }, { key: 'contract', header: 'Contract', link: 'contract_link' },
      ],
      tiles: [
        { key: 'all', label: 'PO value', agg: 'sum', field: 'value', tag: 'all', format: 'money' },
        { key: 'contract', label: 'Under ARC / OA / FDS / VMI', agg: 'sum', field: 'value', tag: 'contract', format: 'money' },
        { key: 'spot', label: 'Spot', agg: 'sum', field: 'value', tag: 'spot', format: 'money' },
        { key: 'kpi08', label: 'Contract coverage (KPI-08)', agg: 'ratio_sum', tag: 'contract', num_field: 'value', den_tag: 'all', den_field: 'value', format: 'pct' },
        { key: 'kpi09', label: 'Spot dependency (KPI-09)', agg: 'ratio_sum', tag: 'spot', num_field: 'value', den_tag: 'all', den_field: 'value', format: 'pct' },
      ],
      chart: { title: 'Spend by coverage', groups: [{ key: 'category', label: 'Category' }, { key: 'vendor', label: 'Vendor' }, { key: 'plant', label: 'Plant' }], value: { sum: 'value' }, format: 'money', parts: [{ label: 'ARC / OA / FDS / VMI', field: 'contract_value' }, { label: 'Spot', field: 'spot_value' }, { label: 'Fixed supplier', field: 'other_value' }] },
      empty: 'No PO spend in this period.',
      notes: ['Value = PO quantity × unit price (basic, before GST and freight). Fixed-supplier arrangements are shown separately; KPI-08 counts ARC/OA/FDS/VMI as the PRD defines.'],
    };
  },
};

// ====================================================================== RPT-08
const rpt08: ReportDef = {
  id: 'rpt-08', no: 'RPT-08', title: 'Dispute ageing', screen: 'SCR-RPT-08', roles: ['BUY', 'APR', 'STO', 'FIN', 'MGT'],
  description: 'Receipt and invoice disputes by type, owner, vendor and delivery term: count, value, ageing and closure TAT (KPI-12).',
  filters: ['date', 'plant', 'vendor', 'buyer'], dateLabel: 'Raised', flows: ['INT-M10'],
  build: () => {
    const bounds = cfg<number[]>('reports.dispute_buckets');
    const rows: Row[] = all<{ id: number; dsp_no: string | null; type: string; owner_party: string | null; owner: string | null; status: string; qty: number | null; value: number | null; delivery_term: string | null; created_at: string; resolved_at: string | null; closed_at: string | null; po_id: number | null; po_no: string | null; vendor_id: number | null; vendor: string | null; plant: string | null; buyer_id: number | null; outcome: string | null }>(
      `SELECT d.*, u.name AS owner, p.po_no, p.vendor_id, v.name AS vendor, p.plant, p.buyer_id FROM disputes d LEFT JOIN users u ON u.id = d.owner_user_id
       LEFT JOIN pos p ON p.id = d.po_id LEFT JOIN vendors v ON v.id = p.vendor_id`,
    ).map((d) => {
      const done = ['Resolved', 'Closed'].includes(d.status);
      const end = d.resolved_at ?? d.closed_at;
      const age = ageDays(d.created_at, done ? end : null) ?? 0;
      const bucket = bucketOf(age, bounds);
      return {
        id: d.id, link: `/disputes/${d.id}`, dsp_no: d.dsp_no ?? `#${d.id}`, type: d.type, owner_party: d.owner_party ?? '—', owner: d.owner ?? '—', vendor: d.vendor ?? '—', po_no: d.po_no ?? '—',
        delivery_term: d.delivery_term ?? '—', qty: d.qty, value: d.value, status: d.status, age_days: age, bucket: done ? 'Closed' : bucket, created_at: d.created_at, outcome: d.outcome ?? '—',
        closure_tat_days: done && end ? daysDiff(d.created_at, end) : null, open_value: done ? 0 : d.value ?? 0,
        tags: done ? ['closed'] : ['open', slug(bucket)],
        _date: d.created_at, _plant: d.plant, _vendor_id: d.vendor_id, _buyer_id: d.buyer_id,
      };
    });
    const labels = bucketLabels(bounds);
    return {
      rows,
      columns: [
        { key: 'dsp_no', header: 'Dispute', kind: 'ref' }, { key: 'type', header: 'Type' }, { key: 'owner_party', header: 'Owner' }, { key: 'owner', header: 'Owner user', hidden: true }, { key: 'vendor', header: 'Vendor' },
        { key: 'po_no', header: 'PO' }, { key: 'delivery_term', header: 'Delivery term' }, { key: 'value', header: 'Value', kind: 'money' }, { key: 'status', header: 'Status', kind: 'status' },
        { key: 'age_days', header: 'Age', kind: 'days' }, { key: 'bucket', header: 'Bucket' }, { key: 'closure_tat_days', header: 'Closure TAT', kind: 'days' }, { key: 'outcome', header: 'Outcome', hidden: true },
      ],
      tiles: [
        { key: 'open', label: 'Open disputes', agg: 'count', tag: 'open', format: 'count' },
        { key: 'open_value', label: 'Open value', agg: 'sum', field: 'open_value', tag: 'open', format: 'money' },
        ...labels.map((b) => ({ key: slug(b), label: `Open ${b}`, agg: 'count' as const, tag: slug(b), format: 'count' as const })),
        { key: 'closed', label: 'Median closure TAT (KPI-12)', agg: 'median', field: 'closure_tat_days', tag: 'closed', format: 'days' },
      ],
      chart: { title: 'Open disputes by age', groups: [{ key: 'type', label: 'Type' }, { key: 'owner_party', label: 'Owner' }, { key: 'vendor', label: 'Vendor' }, { key: 'delivery_term', label: 'Delivery term' }], value: 'count', format: 'count', parts: labels.map((b) => ({ label: b, tag: slug(b) })) },
      empty: 'No disputes have been raised. Stores raise receipt discrepancies from the expected-receipts screen.',
      decisions: ['DEC-15'],
    };
  },
};

// ====================================================================== RPT-09
export function invoiceRows() {
  return all<{ id: number; inv_ref: string; vendor_id: number; vendor: string; po_no: string | null; po_id: number | null; plant: string | null; buyer_id: number | null; vendor_invoice_no: string | null; invoice_date: string | null; total_value: number | null; status: string; sub_reason: string | null; extracted: any; created_at: string; on_behalf: number }>(
    `SELECT i.id, i.inv_ref, i.vendor_id, v.name AS vendor, p.po_no, p.id AS po_id, p.plant, p.buyer_id, i.vendor_invoice_no, i.invoice_date, i.total_value, i.status, i.sub_reason, i.extracted_json, i.created_at, i.on_behalf
     FROM invoices i JOIN vendors v ON v.id = i.vendor_id LEFT JOIN pos p ON p.id = i.po_id`,
  ).map((i) => {
    const rules = all<{ rule: string; status: string }>('SELECT rule, status FROM invoice_exceptions WHERE invoice_id = ?', i.id);
    const corrected = new Set(all<{ field: string }>('SELECT DISTINCT field FROM invoice_corrections WHERE invoice_id = ?', i.id).map((c) => c.field));
    let acc = { extracted: 0, corrected: 0, not_found: 0, accuracy: null as number | null };
    try { acc = accuracy(i.extracted && i.extracted.header ? i.extracted : null, corrected); } catch { /* unexpected shape */ }
    const ocrOk = !!i.extracted && !['Uploaded', 'OCR pending'].includes(i.status);
    const clean = rules.length === 0 && MATCHED_OR_LATER.includes(i.status);
    return { ...i, rules: [...new Set(rules.map((r) => r.rule))], open_rules: rules.filter((r) => r.status === 'Open').length, ocr_ok: ocrOk, clean, acc };
  });
}

const rpt09: ReportDef = {
  id: 'rpt-09', no: 'RPT-09', title: 'Invoice OCR & 3-way match', screen: 'SCR-RPT-09', roles: ['BUY', 'APR', 'FIN', 'MGT'],
  description: 'Invoices uploaded, OCR success, match success without exception (KPI-11), exception reasons, pending, parked / posted and OCR field accuracy (KPI-10).',
  filters: ['date', 'plant', 'vendor', 'buyer'], dateLabel: 'Uploaded', flows: ['INT-M12'],
  build: () => {
    const rows: Row[] = invoiceRows().map((i) => {
      const posted = POSTED.includes(i.status);
      const pending = !posted && !['Parked', 'Rejected'].includes(i.status);
      return {
        id: i.id, link: `/invoices/${i.id}`, inv_ref: i.inv_ref, vendor: i.vendor, vendor_invoice_no: i.vendor_invoice_no ?? '—', po_no: i.po_no ?? '—', invoice_date: i.invoice_date, total_value: i.total_value,
        status: i.status, exceptions: i.rules.length ? i.rules.join(', ') : '—', reasons: i.rules, ocr: i.ocr_ok ? 'Read' : 'Not read', clean_match: i.clean ? 'Yes' : 'No',
        extracted_fields: i.acc.extracted, corrected_fields: i.acc.corrected, unchanged_fields: i.acc.extracted - i.acc.corrected, field_accuracy: i.acc.accuracy, created_at: i.created_at,
        tags: ['uploaded', ...(i.ocr_ok ? ['ocr_ok'] : []), ...(i.clean ? ['clean'] : []), ...(i.rules.length ? ['exception'] : []), ...(pending ? ['pending'] : []), ...(i.status === 'Parked' ? ['parked'] : []), ...(posted ? ['posted'] : [])],
        _date: i.created_at, _plant: i.plant, _vendor_id: i.vendor_id, _buyer_id: i.buyer_id,
      };
    });
    return {
      rows,
      columns: [
        { key: 'inv_ref', header: 'Invoice', kind: 'ref' }, { key: 'vendor', header: 'Vendor' }, { key: 'vendor_invoice_no', header: 'Vendor invoice no.' }, { key: 'po_no', header: 'PO' },
        { key: 'total_value', header: 'Total', kind: 'money' }, { key: 'status', header: 'Status', kind: 'status' }, { key: 'ocr', header: 'OCR' }, { key: 'clean_match', header: 'Matched without exception' },
        { key: 'exceptions', header: 'Exception reasons' }, { key: 'field_accuracy', header: 'Field accuracy', kind: 'pct' }, { key: 'invoice_date', header: 'Invoice date', kind: 'date', hidden: true },
      ],
      tiles: [
        { key: 'uploaded', label: 'Invoices uploaded', agg: 'count', tag: 'uploaded', format: 'count' },
        { key: 'ocr_ok', label: 'OCR success', agg: 'count', tag: 'ocr_ok', format: 'count' },
        { key: 'kpi11', label: '3WM success (KPI-11)', agg: 'ratio_count', tag: 'clean', den_tag: 'uploaded', format: 'pct' },
        { key: 'exception', label: 'With exceptions', agg: 'count', tag: 'exception', format: 'count' },
        { key: 'pending', label: 'Pending', agg: 'count', tag: 'pending', format: 'count' },
        { key: 'parked', label: 'Parked', agg: 'count', tag: 'parked', format: 'count' },
        { key: 'posted', label: 'Posted', agg: 'count', tag: 'posted', format: 'count' },
        { key: 'kpi10', label: 'OCR field accuracy (KPI-10)', agg: 'ratio_sum', tag: 'ocr_ok', num_field: 'unchanged_fields', den_tag: 'ocr_ok', den_field: 'extracted_fields', format: 'pct' },
      ],
      chart: { title: 'Exception reasons', groups: [{ key: 'reasons', label: 'Exception reason' }, { key: 'status', label: 'Status' }, { key: 'vendor', label: 'Vendor' }], value: 'count', format: 'count' },
      empty: 'No invoices have been uploaded yet. Vendors upload invoices against POs from the vendor portal.',
      notes: ['OCR is simulated in this MVP (no OCR engine connected).'],
    };
  },
};

// ====================================================================== RPT-10
const rpt10: ReportDef = {
  id: 'rpt-10', no: 'RPT-10', title: 'Advance payment', screen: 'SCR-RPT-10', roles: ['BUY', 'APR', 'FIN', 'MGT'],
  description: 'Advances requested, approved, paid and adjusted, with outstanding amount and ageing (KPI-15).',
  filters: ['date', 'plant', 'vendor', 'buyer'], dateLabel: 'Requested', flows: ['INT-M12'],
  build: () => {
    const bounds = cfg<number[]>('pay.advance_buckets');
    const rows: Row[] = all<{ id: number; adv_no: string; vendor_id: number | null; vendor: string | null; po_no: string | null; plant: string | null; buyer_id: number | null; amount: number; status: string; created_at: string; paid_date: string | null; adjusted_amount: number; reason: string | null; requested_by: number | null }>(
      `SELECT a.*, v.name AS vendor, p.po_no, p.plant, p.buyer_id FROM advances a LEFT JOIN vendors v ON v.id = a.vendor_id LEFT JOIN pos p ON p.id = a.po_id`,
    ).map((a) => {
      const paid = ['Paid', 'Partially adjusted', 'Fully adjusted'].includes(a.status);
      const outstanding = paid ? round(a.amount - (a.adjusted_amount ?? 0)) : 0;
      const age = paid && outstanding > 0 ? ageDays(a.paid_date) ?? 0 : null;
      const bucket = age != null ? bucketOf(age, bounds) : '—';
      return {
        id: a.id, link: `/advances/${a.id}`, adv_no: a.adv_no, vendor: a.vendor ?? '—', po_no: a.po_no ?? '—', amount: a.amount, status: a.status, requested: a.created_at, paid_date: a.paid_date,
        adjusted: a.adjusted_amount ?? 0, outstanding, age_days: age, bucket,
        tags: ['requested', ...(['Approved', 'Paid', 'Partially adjusted', 'Fully adjusted'].includes(a.status) ? ['approved'] : []), ...(paid ? ['paid'] : []), ...(a.status === 'Fully adjusted' ? ['adjusted'] : []), ...(outstanding > 0 ? ['outstanding', slug(bucket)] : [])],
        _date: a.created_at, _plant: a.plant, _vendor_id: a.vendor_id, _buyer_id: a.buyer_id,
      };
    });
    const labels = bucketLabels(bounds);
    return {
      rows,
      columns: [
        { key: 'adv_no', header: 'Advance', kind: 'ref' }, { key: 'vendor', header: 'Vendor' }, { key: 'po_no', header: 'PO' }, { key: 'amount', header: 'Amount', kind: 'money' }, { key: 'status', header: 'Status', kind: 'status' },
        { key: 'requested', header: 'Requested', kind: 'date' }, { key: 'paid_date', header: 'Paid (SAP)', kind: 'date' }, { key: 'adjusted', header: 'Adjusted', kind: 'money' }, { key: 'outstanding', header: 'Outstanding', kind: 'money' },
        { key: 'age_days', header: 'Age since payment', kind: 'days' }, { key: 'bucket', header: 'Bucket' },
      ],
      tiles: [
        { key: 'requested', label: 'Requested', agg: 'count', tag: 'requested', format: 'count' },
        { key: 'approved', label: 'Approved', agg: 'count', tag: 'approved', format: 'count' },
        { key: 'paid', label: 'Paid in SAP', agg: 'count', tag: 'paid', format: 'count' },
        { key: 'adjusted', label: 'Fully adjusted', agg: 'count', tag: 'adjusted', format: 'count' },
        { key: 'outstanding', label: 'Outstanding (KPI-15)', agg: 'sum', field: 'outstanding', tag: 'outstanding', format: 'money' },
        ...labels.map((b) => ({ key: slug(b), label: `Outstanding ${b}`, agg: 'sum' as const, field: 'outstanding', tag: slug(b), format: 'money' as const })),
      ],
      chart: { title: 'Outstanding advances by age', groups: [{ key: 'vendor', label: 'Vendor' }, { key: 'status', label: 'Status' }], value: { sum: 'outstanding' }, format: 'money' },
      empty: 'No advance requests yet. Buyers request advances against a PO or contract from Payments & advances.',
      decisions: ['Q KPI-15'],
    };
  },
};

// ====================================================================== RPT-11
export function vendorScores() {
  const w = cfg<Record<string, number>>('vendor.scorecard_weights');
  const norm = cfg<{ ack_full_marks_hours: number; ack_zero_marks_hours: number; dispute_rate_zero_marks: number }>('reports.scorecard_normalisation');
  const rec = receivedLines();
  const vendors = all<{ id: number; name: string; sap_code: string }>('SELECT id, name, sap_code FROM vendors WHERE sap_code IS NOT NULL');
  return vendors.map((v) => {
    const invited = get<{ n: number }>('SELECT COUNT(*) AS n FROM rfq_invitations WHERE vendor_id = ?', v.id)!.n;
    const quoted = get<{ n: number }>(`SELECT COUNT(*) AS n FROM quotations q WHERE q.vendor_id = ? AND ${QUOTED}`, v.id)!.n;
    const acks = all<{ h: number }>("SELECT (julianday(pl.ack_at) - julianday(p.published_at)) * 24 AS h FROM po_lines pl JOIN pos p ON p.id = pl.po_id WHERE p.vendor_id = ? AND pl.ack_at IS NOT NULL AND p.published_at IS NOT NULL AND pl.ack_status NOT IN ('Deemed accepted','Pending','Pending re-acknowledgement')", v.id).map((r) => Math.max(0, r.h));
    const mine = rec.filter((l) => l.vendor_id === v.id);
    const onTime = mine.filter((l) => l.on_time).length;
    const disputes = get<{ n: number }>('SELECT COUNT(*) AS n FROM disputes d JOIN pos p ON p.id = d.po_id WHERE p.vendor_id = ?', v.id)!.n;
    const inv = invoiceRows().filter((i) => i.vendor_id === v.id && MATCHED_OR_LATER.concat(['Exception']).includes(i.status));
    const ackH = median(acks);
    const comp: Record<string, number | null> = {
      rfq_response: invited ? (quoted / invited) * 100 : null,
      ack_tat: ackH == null ? null : Math.max(0, Math.min(100, ((norm.ack_zero_marks_hours - ackH) / (norm.ack_zero_marks_hours - norm.ack_full_marks_hours)) * 100)),
      delivery: mine.length ? (onTime / mine.length) * 100 : null,
      disputes: mine.length ? Math.max(0, (1 - disputes / mine.length / norm.dispute_rate_zero_marks) * 100) : null,
      invoice_accuracy: inv.length ? (inv.filter((i) => i.clean).length / inv.length) * 100 : null,
    };
    let ws = 0;
    let total = 0;
    for (const [k, val] of Object.entries(comp)) if (val != null && w[k]) { ws += w[k]; total += w[k] * val; }
    return {
      vendor: v, invited, quoted, rfq_rate: invited ? round(quoted / invited, 4) : null, ack_hours: ackH, received: mine.length, on_time: onTime,
      delivery_rate: mine.length ? round(onTime / mine.length, 4) : null, disputes, invoices: inv.length, invoice_rate: inv.length ? round(inv.filter((i) => i.clean).length / inv.length, 4) : null,
      components: Object.fromEntries(Object.entries(comp).map(([k, x]) => [k, x == null ? null : round(x, 1)])), score: ws ? round(total / ws, 1) : null, weights_used: ws,
    };
  }).filter((s) => s.score != null);
}

const rpt11: ReportDef = {
  id: 'rpt-11', no: 'RPT-11', title: 'Vendor performance scorecard', screen: 'SCR-RPT-11', roles: ['BUY', 'APR', 'FIN', 'MGT'],
  description: 'RFQ response, acknowledgement TAT, delivery adherence, disputes and invoice accuracy, with the composite score (KPI-13).',
  filters: ['vendor', 'category'], flows: ['INT-M07', 'INT-M10'],
  build: () => {
    const cats = new Map(all<{ vendor_id: number; cats: string }>("SELECT vendor_id, GROUP_CONCAT(DISTINCT category) AS cats FROM vendor_capabilities WHERE status = 'Approved' GROUP BY vendor_id").map((r) => [r.vendor_id, r.cats]));
    const rows: Row[] = vendorScores().map((s) => ({
      id: s.vendor.id, link: `/vendors/${s.vendor.id}`, vendor: s.vendor.name, sap_code: s.vendor.sap_code, categories: cats.get(s.vendor.id) ?? '—', rfq_rate: s.rfq_rate, invited: s.invited,
      ack_hours: s.ack_hours, delivery_rate: s.delivery_rate, received: s.received, disputes: s.disputes, invoice_rate: s.invoice_rate, score: s.score,
      tags: ['scored', ...(s.rfq_rate != null ? ['rfq'] : []), ...(s.delivery_rate != null ? ['delivery'] : [])],
      _vendor_id: s.vendor.id, _category: (cats.get(s.vendor.id) ?? '').split(',')[0] || null,
    }));
    const w = cfg<Record<string, number>>('vendor.scorecard_weights');
    return {
      rows,
      columns: [
        { key: 'vendor', header: 'Vendor', kind: 'ref' }, { key: 'sap_code', header: 'SAP code' }, { key: 'categories', header: 'Categories', hidden: true }, { key: 'rfq_rate', header: 'RFQ response', kind: 'pct' },
        { key: 'ack_hours', header: 'Ack TAT (median)', kind: 'hours' }, { key: 'delivery_rate', header: 'On-time delivery', kind: 'pct' }, { key: 'received', header: 'Lines received', kind: 'num', hidden: true },
        { key: 'disputes', header: 'Disputes', kind: 'num' }, { key: 'invoice_rate', header: 'Invoice accuracy', kind: 'pct' }, { key: 'score', header: 'Composite score', kind: 'score' },
      ],
      tiles: [
        { key: 'scored', label: 'Vendors scored', agg: 'count', tag: 'scored', format: 'count' },
        { key: 'score', label: 'Median composite score', agg: 'median', field: 'score', tag: 'scored', format: 'score' },
        { key: 'rfq', label: 'Median RFQ response', agg: 'median', field: 'rfq_rate', tag: 'rfq', format: 'pct' },
        { key: 'delivery', label: 'Median on-time delivery', agg: 'median', field: 'delivery_rate', tag: 'delivery', format: 'pct' },
      ],
      chart: { title: 'Composite score', groups: [{ key: 'vendor', label: 'Vendor' }], value: { avg: 'score' }, format: 'score' },
      empty: 'No vendor has enough RFQ, PO, receipt or invoice history to score yet.',
      notes: [`Weights: RFQ response ${w.rfq_response}, acknowledgement TAT ${w.ack_tat}, delivery ${w.delivery}, disputes ${w.disputes}, invoice accuracy ${w.invoice_accuracy}. Components without data are left out and the weights re-normalised. Vendor visibility of the scorecard is pending DEC-22.`],
      decisions: ['DEC-22'],
    };
  },
};

// ====================================================================== RPT-12
const rpt12: ReportDef = {
  id: 'rpt-12', no: 'RPT-12', title: 'User requirement status', screen: 'SCR-RPT-12', roles: ['REQ', 'BUY', 'APR', 'STO', 'MGT'], own: true,
  description: 'Every requirement from SAP PR to receipt: buyer, route, RFQ, PO, acknowledgement, dispatch and receipt status.',
  filters: ['date', 'plant', 'category', 'buyer', 'priority', 'route'], dateLabel: 'PR created', flows: ['INT-M03', 'INT-M07', 'INT-M10'],
  build: () => {
    const t = today();
    const rows: Row[] = all<{ id: number; pr_no: string; item: number; description: string; plant: string; category: string | null; priority: string; route: string | null; status: string; department: string | null; buyer_id: number | null; buyer: string | null; requisitioner_id: number | null; requisitioner: string | null; required_date: string; qty: number; uom: string; sap_created_at: string | null; rfq_no: string | null; po_no: string | null; ack_status: string | null; received_qty: number | null; po_qty: number | null; asn_status: string | null }>(
      `SELECT l.id, l.pr_no, l.item, l.description, l.plant, l.category, l.priority, l.route, l.status, l.department, l.buyer_id, b.name AS buyer, l.requisitioner_id, r.name AS requisitioner,
              l.required_date, l.qty, l.uom, l.sap_created_at, q.rfq_no, COALESCE(p.po_no, l.po_no) AS po_no, pl.ack_status, pl.received_qty, pl.qty AS po_qty,
              (SELECT a.status FROM asns a WHERE a.po_id = p.id AND a.status NOT IN ('Draft','Cancelled') ORDER BY a.id DESC LIMIT 1) AS asn_status
       FROM pr_lines l LEFT JOIN users b ON b.id = l.buyer_id LEFT JOIN users r ON r.id = l.requisitioner_id LEFT JOIN rfqs q ON q.id = l.rfq_id
       LEFT JOIN po_lines pl ON pl.id = (SELECT x.id FROM po_lines x WHERE x.pr_line_id = l.id ORDER BY x.id DESC LIMIT 1) LEFT JOIN pos p ON p.id = pl.po_id`,
    ).map((l) => {
      const received = l.po_qty != null && (l.received_qty ?? 0) >= l.po_qty;
      const stage = ['Closed', 'Cancelled in SAP'].includes(l.status) ? 'Closed / cancelled' : received ? 'Received' : l.status === 'PO created' || l.po_no ? 'PO placed' : l.status === 'RFQ in progress' ? 'RFQ in progress' : 'With procurement';
      const overdue = l.required_date < t && !['Received', 'Closed / cancelled'].includes(stage);
      return {
        id: l.id, link: `/pr/${l.id}`, ref: `${l.pr_no}/${l.item}`, description: l.description, plant: l.plant, department: l.department ?? '—', requisitioner: l.requisitioner ?? '—', buyer: l.buyer ?? 'Unassigned',
        priority: l.priority, route: l.route ?? '—', status: l.status, stage, rfq_no: l.rfq_no ?? '—', po_no: l.po_no ?? '—', ack_status: l.ack_status ?? '—', asn_status: l.asn_status ?? '—',
        received: l.received_qty != null ? `${l.received_qty} of ${l.po_qty} ${l.uom}` : '—', required_date: l.required_date, created: l.sap_created_at,
        tags: ['all', 'stage:' + stage, overdue ? 'overdue' : 'not_overdue'],
        _date: l.sap_created_at, _plant: l.plant, _category: l.category, _buyer_id: l.buyer_id, _priority: l.priority, _route: l.route, _req_id: l.requisitioner_id,
      };
    });
    const stages = ['With procurement', 'RFQ in progress', 'PO placed', 'Received', 'Closed / cancelled'];
    return {
      rows,
      columns: [
        { key: 'ref', header: 'PR / item', kind: 'ref' }, { key: 'description', header: 'Material' }, { key: 'plant', header: 'Plant' }, { key: 'requisitioner', header: 'Requisitioner' }, { key: 'buyer', header: 'Buyer' },
        { key: 'stage', header: 'Stage', kind: 'status' }, { key: 'status', header: 'PR status', kind: 'status', hidden: true }, { key: 'rfq_no', header: 'RFQ' }, { key: 'po_no', header: 'PO' }, { key: 'ack_status', header: 'Acknowledgement', kind: 'status' },
        { key: 'asn_status', header: 'Dispatch', kind: 'status' }, { key: 'received', header: 'Received' }, { key: 'required_date', header: 'Required', kind: 'date' }, { key: 'department', header: 'Department', hidden: true },
      ],
      tiles: [
        { key: 'all', label: 'Requirements', agg: 'count', tag: 'all', format: 'count' },
        ...stages.map((s) => ({ key: 'stage:' + s, label: s, agg: 'count' as const, tag: 'stage:' + s, format: 'count' as const })),
        { key: 'overdue', label: 'Past required date', agg: 'count', tag: 'overdue', format: 'count' },
      ],
      chart: { title: 'Requirements by stage', groups: [{ key: 'stage', label: 'Stage' }, { key: 'department', label: 'Department' }, { key: 'plant', label: 'Plant' }, { key: 'buyer', label: 'Buyer' }], value: 'count', format: 'count', parts: [{ label: 'Past required date', tag: 'overdue' }, { label: 'On time', tag: 'not_overdue' }] },
      empty: 'No requirements found. Released PRs from SAP appear here after the INT-M03 sync.',
    };
  },
};

export const REPORTS: ReportDef[] = [rpt01, rpt02, rpt03, rpt04, rpt05, rpt06, rpt07, rpt08, rpt09, rpt10, rpt11, rpt12];
export type { Col };
