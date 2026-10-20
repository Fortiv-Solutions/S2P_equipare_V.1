/**
 * Business rules as versioned configuration data (FR-PLT-08). Values marked with a decision
 * reference are proposed defaults awaiting an Equipcare decision (PRD Sec 18) — the UI shows them
 * as "Pending decision" and nothing here invents an approved business rule.
 */
import { get, all, insert, run, J, now, tx } from './db.ts';

export interface ConfigDef {
  key: string;
  label: string;
  group: string;
  description: string;
  value: unknown;
  requiresApproval?: boolean;
  decision?: string; // e.g. 'DEC-07'
}

export const CONFIG_DEFS: ConfigDef[] = [
  // Security
  { key: 'security.max_failed_logins', label: 'Failed sign-ins before lock', group: 'Security', description: 'Account locks after this many consecutive failed sign-ins (AC-VPT-01).', value: 5, decision: 'DEC-12' },
  { key: 'security.vendor_mfa', label: 'Vendor one-time code (MFA)', group: 'Security', description: 'Vendors confirm sign-in with a one-time code.', value: true, decision: 'DEC-12' },
  // Integration
  { key: 'sap.freshness_minutes', label: 'SAP data freshness thresholds (minutes)', group: 'SAP integration', description: 'A record older than its threshold shows a stale badge (FR-PLT-04).', value: { 'INT-M01': 1440, 'INT-M02': 1440, 'INT-M03': 60, 'INT-M04': 240, 'INT-M06': 1440, 'INT-M07': 30, 'INT-M10': 30, 'INT-M12': 240 }, decision: 'DEC-23' },
  { key: 'sap.auto_sync_minutes', label: 'Scheduled sync interval (minutes)', group: 'SAP integration', description: 'How often scheduled inbound flows run against the SAP simulator.', value: 5, decision: 'DEC-17' },
  { key: 'sap.write.ack', label: 'Write PO acknowledgements to SAP', group: 'SAP integration', description: 'Off: the platform is the record of acknowledgement (FR-POM-10).', value: false, decision: 'DEC-25' },
  { key: 'sap.write.invoice_parking', label: 'Create parked invoices in SAP', group: 'SAP integration', description: 'Off: finance enters approved invoices in SAP manually (DEC-06).', value: false, decision: 'DEC-06' },
  { key: 'sap.write.rfq', label: 'Create RFQ reference in SAP', group: 'SAP integration', description: 'Off: RFQ is executed in the platform; SAP holds no RFQ document (DEC-04).', value: false, decision: 'DEC-04' },
  // PR workbench
  { key: 'pr.route_order', label: 'Route proposal order', group: 'PR workbench', description: 'Order in which eligible routes are proposed. Urgency changes SLA, not eligibility.', value: ['ARC/OA', 'FDS', 'VMI', 'Fixed supplier', 'RFQ'], decision: 'RSK-14' },
  { key: 'pr.repeat_purchase', label: 'Repeat-purchase flag', group: 'PR workbench', description: 'Flag a PR line when a material is bought this many times in the look-back period without ARC/OA.', value: { lookback_days: 365, min_count: 3, min_value: 0 }, decision: 'DEC-09' },
  { key: 'pr.ageing_alert_days', label: 'PR ageing alert (days)', group: 'PR workbench', description: 'Notify the buyer, then the manager, when a PR line exceeds this age (NTF-02).', value: 7, decision: 'DEC-15' },
  { key: 'pr.sla_hours', label: 'Priority SLA (hours)', group: 'PR workbench', description: 'Separate SLA clocks for urgent, breakdown and Class 1 lines (FR-PRW-10).', value: { Urgent: 72, BD: 24, 'Class 1': 24 }, decision: 'DEC-15' },
  { key: 'pr.grouping', label: 'Multi-PR RFQ grouping rules', group: 'PR workbench', description: 'Which attributes lines must share to be grouped in one RFQ.', value: { same_buyer: true, same_plant: false, same_material_group: false }, decision: 'Q 18.1' },
  // RFQ
  { key: 'rfq.reminders', label: 'RFQ reminder schedule', group: 'RFQ', description: 'Days before closing (and after, for late responders) when non-responding vendors are reminded.', value: { before_days: [2, 1], after_days: [1] }, decision: 'Q 7.2' },
  { key: 'rfq.sealed', label: 'Sealed quotations', group: 'RFQ', description: 'Buyers see who responded but not prices until the RFQ closes (FR-RFQ-12).', value: true, decision: 'Q 18.1' },
  { key: 'rfq.allow_prospective_vendors', label: 'Invite vendors without SAP code', group: 'RFQ', description: 'Off: only vendors with an SAP code can be invited.', value: false, decision: 'Q 18.1' },
  // Comparison
  { key: 'cmp.landed_cost', label: 'Landed-cost components', group: 'Comparison', description: 'GST impact by category ITC flag; payment-term adjustment and Ex-Works freight estimate are off until approved.', value: { gst_impact: 'category_itc', payment_term_adjustment: { enabled: false, rate_pct: 0, reference_days: 30 }, exw_freight_estimate_pct: 0 }, decision: 'DEC-21' },
  { key: 'cmp.discounts', label: 'Late and risk discount definitions', group: 'Comparison', description: 'Both are entered as positive amounts that reduce landed cost and always require approval.', value: { late_discount: 'Reduction offered after closing, amount', risk_discount: 'Reduction for supply/quality risk, amount', approval_required: true }, decision: 'DEC-18' },
  // Approvals
  { key: 'approval.timing', label: 'Approval reminder and escalation (hours)', group: 'Approvals', description: 'Remind the approver after the first value; escalate to the next level after the second.', value: { remind_after_hours: 24, escalate_after_hours: 48 }, decision: 'DEC-13' },
  // PO
  { key: 'po.deemed_acceptance', label: 'Deemed acceptance', group: 'Purchase orders', description: 'When on, an unacknowledged PO is marked deemed accepted after the timeline; non-response is still reported.', value: { enabled: false, hours: 72 }, decision: 'DEC-16' },
  { key: 'po.reminders', label: 'PO reminder schedule', group: 'Purchase orders', description: 'Acknowledgement reminder after N hours; dispatch reminder N days before commitment; overdue reminder N days after.', value: { ack_after_hours: 24, dispatch_days_before: 2, overdue_days_after: 1 }, decision: 'Q 7.7' },
  { key: 'po.escalation', label: 'Escalation matrix (days after first reminder)', group: 'Purchase orders', description: 'Level 2 goes to the buyer\'s manager, level 3 to the department head.', value: { level2_days: 2, level3_days: 5 }, decision: 'Q 14.1' },
  { key: 'po.delay_reasons', label: 'Delay reason codes', group: 'Purchase orders', description: 'Code list used when a commitment date changes (FR-POM-06).', value: ['Raw material shortage', 'Production capacity', 'Transport unavailable', 'Awaiting technical clarification', 'Payment / advance pending', 'Import / OEM lead time', 'Quality rework', 'Other'] },
  { key: 'asn.qty_tolerance_pct', label: 'ASN quantity tolerance (%)', group: 'Purchase orders', description: 'ASN quantity may exceed acknowledged open quantity by this percentage.', value: 0, decision: 'Q 7.8' },
  // Disputes
  { key: 'dispute.responsibility', label: 'Delivery-term responsibility matrix', group: 'Disputes', description: 'Default dispute owner by discrepancy type and delivery term (illustrative until DEC-24).', value: {
    FOR: { 'Transit damage': 'Vendor', 'Transit loss': 'Vendor', Shortage: 'Vendor', Excess: 'Procurement', Damage: 'Vendor', 'Wrong material': 'Vendor', 'Quality rejection': 'Vendor', 'Accidental loss': 'Stores', 'Document mismatch': 'Vendor' },
    'Ex-Works': { 'Transit damage': 'Logistics', 'Transit loss': 'Logistics', Shortage: 'Vendor', Excess: 'Procurement', Damage: 'Logistics', 'Wrong material': 'Vendor', 'Quality rejection': 'Vendor', 'Accidental loss': 'Stores', 'Document mismatch': 'Vendor' },
  }, decision: 'DEC-24' },
  { key: 'dispute.hold_rule', label: 'Invoice hold for open disputes', group: 'Disputes', description: 'full = hold the whole invoice; partial = hold only disputed lines.', value: 'full', decision: 'DEC-20' },
  { key: 'dispute.closure_approval', label: 'Dispute closure needs approval', group: 'Disputes', description: 'When on, closing a dispute routes to the Procurement Manager.', value: false, decision: 'Q 7.8' },
  { key: 'dispute.ageing_escalate_days', label: 'Dispute ageing escalation (days)', group: 'Disputes', description: 'Escalate open disputes older than this to the manager (NTF-23).', value: 7, decision: 'DEC-15' },
  // Invoice / finance
  { key: 'tolerance.3wm', label: '3-way match tolerances', group: 'Invoice matching', description: 'Zero until procurement and finance jointly approve values (GOV-C07). Changes need both approvals.', value: { price_pct: 0, price_abs: 0, qty_pct: 0, tax_abs: 0, freight_abs: 0, total_abs: 0 }, requiresApproval: true, decision: 'DEC-07' },
  { key: 'ocr.confidence', label: 'OCR confidence thresholds', group: 'Invoice matching', description: 'Fields below their threshold go to the exception queue (OCR-05).', value: { default: 0.85, vendor_gstin: 0.95, invoice_no: 0.9, total_value: 0.92, bank_account: 0.95 }, decision: 'Q KPI-10' },
  { key: 'ocr.duplicate_scope', label: 'Duplicate invoice scope', group: 'Invoice matching', description: 'Duplicate check on normalised number per vendor within this scope.', value: 'financial_year', decision: 'Q 7.10' },
  { key: 'pay.vendor_fields', label: 'Vendor-visible payment fields', group: 'Payments', description: 'Whitelist of payment fields vendors may see (FR-PAY-07).', value: ['status', 'due_date', 'paid_at', 'payment_ref', 'payment_advice', 'tds', 'deductions', 'advance_adjusted', 'vendor_reason'], decision: 'DEC-19' },
  { key: 'pay.advance_buckets', label: 'Advance ageing buckets (days)', group: 'Payments', description: 'Upper bounds of ageing buckets for KPI-15.', value: [30, 60, 90], decision: 'Q KPI-15' },
  // Contracts / vendors
  { key: 'contract.opportunity', label: 'ARC/OA opportunity thresholds', group: 'Contracts', description: 'Items above these purchase frequency/value thresholds without an ARC/OA appear as opportunities.', value: { lookback_days: 365, min_frequency: 3, min_annual_value: 100000 }, decision: 'DEC-09' },
  { key: 'contract.renewal_lead_days', label: 'Contract renewal lead time (days)', group: 'Contracts', description: 'Owner is reminded this many days before expiry.', value: 45, decision: 'Q 7.6' },
  { key: 'kyc.expiry_lead_days', label: 'KYC document expiry reminder (days)', group: 'Vendors', description: 'Vendor and procurement are reminded before mandatory documents expire.', value: 30 },
  { key: 'vendor.scorecard_weights', label: 'Vendor scorecard weights', group: 'Vendors', description: 'Weights for the composite vendor score (KPI-13).', value: { rfq_response: 20, ack_tat: 20, delivery: 30, disputes: 15, invoice_accuracy: 15 }, decision: 'DEC-22' },
  { key: 'tickets.routing', label: 'Vendor ticket routing', group: 'Vendors', description: 'Internal team that receives each ticket category (VP-A09).', value: { 'Login / access': 'ADM', 'RFQ access': 'BUY', 'PO visibility': 'BUY', 'Invoice upload': 'FIN', 'Payment query': 'FIN', 'Document issue': 'BUY', 'Dispute clarification': 'BUY' } },
  // Notifications
  { key: 'notify.channels', label: 'Notification channels', group: 'Notifications', description: 'In-app is always on. E-mail is recorded to the simulated outbox because no provider is connected. SMS/WhatsApp wait for DEC-14.', value: { email: true, sms: false, whatsapp: false, push: false }, decision: 'DEC-14' },
  { key: 'notify.dedupe_minutes', label: 'Duplicate notification window (minutes)', group: 'Notifications', description: 'One notification per event, record and recipient within this window, so a reminder is sent at most once a day.', value: 1440 },
  // Files
  { key: 'files.limits', label: 'Attachment limits', group: 'Platform', description: 'Per-file size limit and allowed file types (FR-PLT-07).', value: { max_mb: 20, types: ['pdf', 'png', 'jpg', 'webp', 'docx', 'xlsx', 'doc', 'xls', 'csv', 'txt'] }, decision: 'Q FR-PLT-07' },
  { key: 'calendar.mode', label: 'TAT day basis', group: 'Platform', description: 'Calendar days or working days for TAT and ageing.', value: 'calendar', decision: 'DEC-15' },
];

const defs = new Map(CONFIG_DEFS.map((d) => [d.key, d]));

/** Modules add their own settings at init (before seeding). */
export function registerConfig(...items: ConfigDef[]) {
  for (const d of items) {
    if (defs.has(d.key)) continue;
    CONFIG_DEFS.push(d);
    defs.set(d.key, d);
  }
}

export function seedConfig(actorId: number | null = null) {
  for (const d of CONFIG_DEFS) {
    const exists = get('SELECT key FROM config WHERE key = ?', d.key);
    if (exists) continue;
    insert('config', {
      key: d.key, value_json: J(d.value), version: 1, label: d.label, group_name: d.group, description: d.description,
      requires_approval: d.requiresApproval ? 1 : 0, decision_ref: d.decision ?? null, status: 'Active',
      updated_by: actorId, updated_at: now(),
    });
    insert('config_history', { key: d.key, value_json: J(d.value), version: 1, status: 'Active', effective_from: now(), reason: 'Initial proposed default', requested_by: actorId, requested_at: now(), decided_at: now() });
  }
}

export function cfg<T = unknown>(key: string): T {
  const row = get<{ value: T }>('SELECT value_json FROM config WHERE key = ?', key);
  if (row) return row.value;
  const d = defs.get(key);
  if (!d) throw new Error(`Unknown config key ${key}`);
  return d.value as T;
}

export function listConfig() {
  return all('SELECT * FROM config ORDER BY group_name, label');
}

/** Apply a new value immediately (non-approval keys) — creates a new version. */
export function applyConfig(key: string, value: unknown, actorId: number, reason: string, historyId?: number) {
  return tx(() => {
    const cur = get<{ version: number }>('SELECT version FROM config WHERE key = ?', key);
    const version = (cur?.version ?? 0) + 1;
    run("UPDATE config_history SET status = 'Superseded' WHERE key = ? AND status = 'Active'", key);
    run('UPDATE config SET value_json = ?, version = ?, updated_by = ?, updated_at = ?, status = ? WHERE key = ?', J(value), version, actorId, now(), 'Active', key);
    if (historyId) run("UPDATE config_history SET status = 'Active', version = ?, decided_at = ?, effective_from = ? WHERE id = ?", version, now(), now(), historyId);
    else insert('config_history', { key, value_json: J(value), version, status: 'Active', effective_from: now(), reason, requested_by: actorId, requested_at: now(), decided_at: now() });
    return version;
  });
}
