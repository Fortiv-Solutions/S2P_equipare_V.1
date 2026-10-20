/**
 * Platform schema. SAP-owned records (vendor master, material, PR, PO, GRN/SES, invoice/payment
 * status) are held here only as synchronised copies keyed by SAP identifiers (PRD Sec 11).
 * The simulated SAP system lives in `sap_documents` and is never read by business modules directly.
 */
import { db } from './db.ts';

export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS plants (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT, state TEXT, gstin TEXT,
  ship_to_address TEXT, calendar TEXT DEFAULT 'Mon-Sat'
);

CREATE TABLE IF NOT EXISTS spend_categories (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, parent TEXT, min_vendors INTEGER DEFAULT 3,
  rfq_rule TEXT, itc_recoverable INTEGER DEFAULT 1, description TEXT
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY, sap_code TEXT UNIQUE, name TEXT NOT NULL, legal_name TEXT,
  pan TEXT, gstin TEXT, msme_no TEXT, msme_category TEXT,
  address TEXT, city TEXT, state TEXT,
  contact_name TEXT, contact_email TEXT, contact_phone TEXT,
  bank_name TEXT, bank_account_masked TEXT, bank_ifsc TEXT,
  sap_blocked INTEGER DEFAULT 0,
  onboarding_status TEXT DEFAULT 'Active',
  portal_status TEXT DEFAULT 'Not invited',
  performance_score REAL,
  invited_by INTEGER, invite_token TEXT, invite_expires_at TEXT,
  created_at TEXT, synced_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT,
  roles TEXT NOT NULL, department TEXT, plant_scope TEXT DEFAULT '*', categories TEXT,
  title TEXT, vendor_id INTEGER REFERENCES vendors(id), vendor_role TEXT,
  password_hash TEXT NOT NULL, active INTEGER DEFAULT 1, locked INTEGER DEFAULT 0,
  failed_attempts INTEGER DEFAULT 0, manager_id INTEGER, delegate_id INTEGER, delegate_until TEXT,
  notif_prefs_json TEXT DEFAULT '{}', last_login TEXT, created_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), active_role TEXT,
  created_at TEXT, expires_at TEXT, last_seen TEXT, ip TEXT,
  mfa_pending INTEGER DEFAULT 0, otp_hash TEXT, otp_expires_at TEXT, acting_vendor_id INTEGER
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, description TEXT NOT NULL, uom TEXT,
  material_group TEXT, category TEXT, sub_category TEXT, brand TEXT, gst_rate REAL, hsn TEXT,
  valuation_type TEXT, is_service INTEGER DEFAULT 0,
  lpp REAL, lpp_vendor_id INTEGER, lpp_date TEXT, budget_price REAL, synced_at TEXT
);

CREATE TABLE IF NOT EXISTS stock (
  material_id INTEGER NOT NULL, plant TEXT NOT NULL, unrestricted REAL DEFAULT 0,
  open_po_qty REAL DEFAULT 0, vmi INTEGER DEFAULT 0, synced_at TEXT,
  PRIMARY KEY (material_id, plant)
);

CREATE TABLE IF NOT EXISTS vendor_capabilities (
  id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  category TEXT NOT NULL, sub_category TEXT, supplier_role TEXT, brand TEXT, region TEXT,
  criticality TEXT, buyer_owner_id INTEGER, status TEXT DEFAULT 'Proposed',
  created_at TEXT, decided_by INTEGER, decided_at TEXT, decision_note TEXT
);

CREATE TABLE IF NOT EXISTS vendor_documents (
  id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  doc_type TEXT NOT NULL, doc_no TEXT, attachment_id INTEGER, issued_on TEXT, expiry_date TEXT,
  status TEXT DEFAULT 'Pending review', mandatory INTEGER DEFAULT 0, review_note TEXT,
  reviewed_by INTEGER, created_at TEXT
);

CREATE TABLE IF NOT EXISTS vendor_change_requests (
  id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL, field TEXT NOT NULL, old_value TEXT, new_value TEXT,
  reason TEXT, status TEXT DEFAULT 'Pending', requested_by INTEGER, decided_by INTEGER, decided_at TEXT,
  decision_note TEXT, high_risk INTEGER DEFAULT 0, created_at TEXT
);

CREATE TABLE IF NOT EXISTS buyer_matrix (
  id INTEGER PRIMARY KEY, category TEXT NOT NULL, plant TEXT NOT NULL DEFAULT '*',
  priority_route TEXT DEFAULT '*', buyer_id INTEGER NOT NULL, backup_buyer_id INTEGER,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pr_lines (
  id INTEGER PRIMARY KEY, pr_no TEXT NOT NULL, item INTEGER NOT NULL,
  material_id INTEGER, material_code TEXT, description TEXT, material_group TEXT, category TEXT,
  plant TEXT, storage_location TEXT, qty REAL, uom TEXT, required_date TEXT,
  requisitioner_id INTEGER, department TEXT, priority TEXT DEFAULT 'Normal',
  est_unit_price REAL, is_capex INTEGER DEFAULT 0, is_service INTEGER DEFAULT 0,
  sap_status TEXT DEFAULT 'Released', status TEXT DEFAULT 'Synced',
  buyer_id INTEGER, assigned_at TEXT, route TEXT, route_proposed TEXT, route_reason TEXT,
  checks_json TEXT, checks_at TEXT, repeat_flag INTEGER DEFAULT 0, repeat_info_json TEXT,
  rfq_id INTEGER, po_no TEXT, contract_id INTEGER, hold_reason TEXT, sla_due TEXT,
  sap_created_at TEXT, available_at TEXT, synced_at TEXT, closed_at TEXT, flag TEXT,
  UNIQUE (pr_no, item)
);

CREATE TABLE IF NOT EXISTS route_decisions (
  id INTEGER PRIMARY KEY, pr_line_id INTEGER NOT NULL, proposed TEXT, decided TEXT,
  override INTEGER DEFAULT 0, reason TEXT, checks_json TEXT, contract_id INTEGER, approval_id INTEGER,
  decided_by INTEGER, decided_at TEXT
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY, object_type TEXT NOT NULL, object_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL, body TEXT NOT NULL, internal INTEGER DEFAULT 1, created_at TEXT
);

CREATE TABLE IF NOT EXISTS rfqs (
  id INTEGER PRIMARY KEY, rfq_no TEXT UNIQUE NOT NULL, title TEXT, buyer_id INTEGER, status TEXT DEFAULT 'Draft',
  category TEXT, plant TEXT, closing_at TEXT, delivery_terms TEXT, payment_terms TEXT, warranty TEXT,
  packing TEXT, documents_required TEXT, standard_terms TEXT, ship_to TEXT, sealed INTEGER DEFAULT 1,
  reminder_schedule_json TEXT, extensions_json TEXT, parent_rfq_id INTEGER, cancel_reason TEXT,
  exception_approval_id INTEGER, no_contract_snapshot_json TEXT,
  created_at TEXT, published_at TEXT, closed_at TEXT, sap_rfq_ref TEXT
);

CREATE TABLE IF NOT EXISTS rfq_lines (
  id INTEGER PRIMARY KEY, rfq_id INTEGER NOT NULL REFERENCES rfqs(id), line_no INTEGER,
  pr_line_id INTEGER, material_id INTEGER, description TEXT, qty REAL, uom TEXT, required_date TEXT,
  due_at TEXT, plant TEXT, ship_to TEXT, gst_rate REAL, valuation_type TEXT, transport_req TEXT,
  specs TEXT, status TEXT DEFAULT 'Active', flag_reason TEXT
);

CREATE TABLE IF NOT EXISTS rfq_invitations (
  id INTEGER PRIMARY KEY, rfq_id INTEGER NOT NULL REFERENCES rfqs(id), vendor_id INTEGER NOT NULL,
  suggested INTEGER DEFAULT 1, suggest_reasons_json TEXT, added_justification TEXT,
  status TEXT DEFAULT 'Invited', sent_at TEXT, delivery_status TEXT, viewed_at TEXT, responded_at TEXT,
  declined_at TEXT, decline_reason TEXT, reminders_sent INTEGER DEFAULT 0, last_reminder_at TEXT,
  UNIQUE (rfq_id, vendor_id)
);

CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY, rfq_id INTEGER NOT NULL, vendor_id INTEGER NOT NULL,
  status TEXT DEFAULT 'Draft', version INTEGER DEFAULT 0, ref_no TEXT, submitted_at TEXT,
  lines_json TEXT, validity_date TEXT, payment_terms TEXT, credit_days INTEGER, delivery_terms TEXT,
  remarks TEXT, updated_at TEXT, created_at TEXT,
  UNIQUE (rfq_id, vendor_id)
);

CREATE TABLE IF NOT EXISTS quotation_versions (
  id INTEGER PRIMARY KEY, quotation_id INTEGER NOT NULL, version INTEGER NOT NULL,
  lines_json TEXT, header_json TEXT, created_at TEXT, created_by INTEGER, note TEXT
);

CREATE TABLE IF NOT EXISTS rfq_reopens (
  id INTEGER PRIMARY KEY, rfq_id INTEGER NOT NULL, vendor_ids_json TEXT, reason TEXT, approval_id INTEGER,
  status TEXT DEFAULT 'Pending approval', reopen_until TEXT, requested_by INTEGER, created_at TEXT
);

CREATE TABLE IF NOT EXISTS comparisons (
  id INTEGER PRIMARY KEY, cmp_no TEXT, rfq_id INTEGER NOT NULL, version INTEGER DEFAULT 1,
  status TEXT DEFAULT 'Draft', params_json TEXT, rows_json TEXT, summary_json TEXT, awards_json TEXT,
  justification TEXT, deviation INTEGER DEFAULT 0, deviation_reason TEXT,
  late_discount_json TEXT, approval_id INTEGER, created_by INTEGER, created_at TEXT,
  submitted_at TEXT, decided_at TEXT, sap_handoff_at TEXT
);

CREATE TABLE IF NOT EXISTS approval_matrix (
  id INTEGER PRIMARY KEY, version INTEGER NOT NULL, type TEXT NOT NULL, name TEXT,
  conditions_json TEXT, levels_json TEXT NOT NULL, effective_from TEXT, active INTEGER DEFAULT 1,
  created_by INTEGER, created_at TEXT, note TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY, req_no TEXT UNIQUE, type TEXT NOT NULL, category TEXT DEFAULT 'approval',
  object_type TEXT, object_id INTEGER, title TEXT, summary TEXT, value REAL,
  requester_id INTEGER, status TEXT DEFAULT 'Pending', current_level INTEGER DEFAULT 1,
  matrix_id INTEGER, matrix_version INTEGER, context_json TEXT, reason TEXT, outcome TEXT,
  urgency TEXT, plant TEXT, category_code TEXT,
  created_at TEXT, decided_at TEXT
);

CREATE TABLE IF NOT EXISTS approval_steps (
  id INTEGER PRIMARY KEY, approval_id INTEGER NOT NULL REFERENCES approvals(id), level INTEGER NOT NULL,
  approver_role TEXT, approver_id INTEGER, status TEXT DEFAULT 'Waiting', comment TEXT,
  acted_by INTEGER, acted_at TEXT, device TEXT, due_at TEXT, escalated INTEGER DEFAULT 0,
  delegated_from INTEGER, parallel_group INTEGER
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY, contract_no TEXT UNIQUE, type TEXT NOT NULL, vendor_id INTEGER NOT NULL,
  title TEXT, category TEXT, plant TEXT DEFAULT '*', sap_oa_no TEXT, valid_from TEXT, valid_to TEXT,
  status TEXT DEFAULT 'Draft', value_cap REAL, consumed_value REAL DEFAULT 0, currency TEXT DEFAULT 'INR',
  payment_terms TEXT, delivery_terms TEXT, discount_pct REAL, price_list_version INTEGER,
  invoice_validation INTEGER DEFAULT 0, vmi_json TEXT, renewal_lead_days INTEGER DEFAULT 45,
  price_revision_date TEXT, owner_id INTEGER, approval_id INTEGER, terms TEXT,
  created_by INTEGER, created_at TEXT, synced_at TEXT, terminated_reason TEXT, renewed_from_id INTEGER
);

CREATE TABLE IF NOT EXISTS contract_items (
  id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contracts(id), material_id INTEGER,
  unit_price REAL, qty_cap REAL, consumed_qty REAL DEFAULT 0, uom TEXT, discount_pct REAL
);

CREATE TABLE IF NOT EXISTS price_lists (
  id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL, version INTEGER NOT NULL, effective_from TEXT,
  items_json TEXT, created_by INTEGER, created_at TEXT, note TEXT
);

CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY, material_id INTEGER, category TEXT, frequency INTEGER, annual_value REAL,
  vendor_count INTEGER, current_coverage TEXT, suggested_action TEXT, status TEXT DEFAULT 'Identified',
  decision_reason TEXT, decided_by INTEGER, decided_at TEXT, identified_at TEXT, rfq_id INTEGER,
  UNIQUE (material_id)
);

CREATE TABLE IF NOT EXISTS pos (
  id INTEGER PRIMARY KEY, po_no TEXT UNIQUE NOT NULL, vendor_id INTEGER NOT NULL, buyer_id INTEGER,
  plant TEXT, po_date TEXT, status TEXT DEFAULT 'Published', sap_released INTEGER DEFAULT 1,
  version INTEGER DEFAULT 1, urgency TEXT DEFAULT 'General stock', delivery_terms TEXT,
  payment_terms TEXT, currency TEXT DEFAULT 'INR', total_value REAL, contract_id INTEGER,
  rfq_id INTEGER, comparison_id INTEGER, rfq_date TEXT, published_at TEXT, viewed_at TEXT,
  ack_due_at TEXT, deemed_accepted INTEGER DEFAULT 0, sap_change_pending INTEGER DEFAULT 0,
  freight_terms TEXT, synced_at TEXT, closed_at TEXT
);

CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES pos(id), item INTEGER NOT NULL,
  pr_line_id INTEGER, material_id INTEGER, description TEXT, qty REAL, uom TEXT, unit_price REAL,
  gst_rate REAL, freight REAL DEFAULT 0, delivery_date TEXT,
  ack_status TEXT DEFAULT 'Pending', accepted_qty REAL, commit_date TEXT, first_commit_date TEXT,
  ack_remarks TEXT, ack_at TEXT, received_qty REAL DEFAULT 0, invoiced_qty REAL DEFAULT 0,
  status TEXT DEFAULT 'Published', delay_reason TEXT, next_action_date TEXT, contract_item_id INTEGER,
  UNIQUE (po_id, item)
);

CREATE TABLE IF NOT EXISTS po_followups (
  id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL, po_line_id INTEGER, user_id INTEGER,
  kind TEXT, note TEXT, commit_date TEXT, delay_reason TEXT, next_action_date TEXT, created_at TEXT
);

CREATE TABLE IF NOT EXISTS po_amendments (
  id INTEGER PRIMARY KEY, amd_no TEXT, po_id INTEGER NOT NULL, type TEXT, changes_json TEXT, reason TEXT,
  status TEXT DEFAULT 'Requested', approval_id INTEGER, requested_by INTEGER, raised_by_vendor INTEGER DEFAULT 0,
  created_at TEXT, sap_changed_at TEXT, reack_at TEXT
);

CREATE TABLE IF NOT EXISTS asns (
  id INTEGER PRIMARY KEY, asn_no TEXT UNIQUE, po_id INTEGER NOT NULL, vendor_id INTEGER NOT NULL, plant TEXT,
  status TEXT DEFAULT 'Draft', dispatch_date TEXT, expected_date TEXT, transporter TEXT, lr_no TEXT,
  vehicle_no TEXT, eway_bill TEXT, invoice_ref TEXT, packing_details TEXT, delivery_terms TEXT,
  freight_mode TEXT, transit_risk TEXT, pickup_by TEXT DEFAULT 'Vendor', pickup_date TEXT,
  pickup_status TEXT, lines_json TEXT, version INTEGER DEFAULT 1, cancel_reason TEXT,
  created_by INTEGER, created_at TEXT, submitted_at TEXT, delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS grns (
  id INTEGER PRIMARY KEY, grn_no TEXT NOT NULL, year TEXT, po_id INTEGER, po_line_id INTEGER,
  qty REAL, value REAL, posting_date TEXT, is_service INTEGER DEFAULT 0, plant TEXT, asn_id INTEGER,
  synced_at TEXT, UNIQUE (grn_no, po_line_id)
);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY, dsp_no TEXT UNIQUE, po_id INTEGER, po_line_id INTEGER, asn_id INTEGER, grn_id INTEGER,
  invoice_id INTEGER, type TEXT NOT NULL, qty REAL, value REAL, delivery_term TEXT,
  owner_party TEXT, owner_user_id INTEGER, status TEXT DEFAULT 'Raised', description TEXT,
  outcome TEXT, outcome_note TEXT, raised_by INTEGER, source TEXT DEFAULT 'Receipt',
  created_at TEXT, due_at TEXT, resolved_at TEXT, closed_at TEXT, closed_by INTEGER, closure_approval_id INTEGER
);

CREATE TABLE IF NOT EXISTS dispute_events (
  id INTEGER PRIMARY KEY, dispute_id INTEGER NOT NULL, user_id INTEGER, kind TEXT, body TEXT,
  vendor_visible INTEGER DEFAULT 1, created_at TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY, inv_ref TEXT UNIQUE, vendor_id INTEGER NOT NULL, po_id INTEGER, asn_id INTEGER,
  vendor_invoice_no TEXT, normalized_no TEXT, invoice_date TEXT, fy TEXT,
  status TEXT DEFAULT 'Uploaded', sub_reason TEXT,
  taxable_value REAL, gst_amount REAL, total_value REAL, freight REAL DEFAULT 0, other_charges REAL DEFAULT 0,
  currency TEXT DEFAULT 'INR', extracted_json TEXT, match_json TEXT, ocr_engine TEXT, ocr_at TEXT,
  on_behalf INTEGER DEFAULT 0, uploaded_by INTEGER, attachment_id INTEGER, is_service INTEGER DEFAULT 0,
  approved_by INTEGER, approved_at TEXT, sap_doc_no TEXT, parked_at TEXT, posted_at TEXT,
  due_date TEXT, paid_at TEXT, payment_ref TEXT, payment_advice_json TEXT, deductions_json TEXT,
  tds REAL, retention REAL, advance_adjusted REAL, block_reason_internal TEXT, vendor_reason TEXT,
  dispute_hold INTEGER DEFAULT 0, duplicate_of INTEGER, rejected_reason TEXT,
  created_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS invoice_corrections (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL, field TEXT, old_value TEXT, new_value TEXT,
  reason TEXT, user_id INTEGER, created_at TEXT
);

CREATE TABLE IF NOT EXISTS invoice_exceptions (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL, rule TEXT, severity TEXT, message TEXT,
  expected TEXT, actual TEXT, tolerance TEXT, owner_role TEXT, status TEXT DEFAULT 'Open',
  resolution TEXT, resolved_by INTEGER, resolved_at TEXT, created_at TEXT
);

CREATE TABLE IF NOT EXISTS advances (
  id INTEGER PRIMARY KEY, adv_no TEXT UNIQUE, po_id INTEGER, contract_id INTEGER, vendor_id INTEGER,
  amount REAL, reason TEXT, status TEXT DEFAULT 'Requested', approval_id INTEGER, requested_by INTEGER,
  paid_date TEXT, sap_doc TEXT, adjusted_amount REAL DEFAULT 0, created_at TEXT, cancel_reason TEXT
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY, tkt_no TEXT UNIQUE, vendor_id INTEGER, raised_by INTEGER, category TEXT,
  subject TEXT, status TEXT DEFAULT 'Open', assignee_role TEXT, assignee_id INTEGER, priority TEXT DEFAULT 'Normal',
  object_type TEXT, object_ref TEXT, sla_due TEXT, created_at TEXT, updated_at TEXT, resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, user_id INTEGER, body TEXT, internal INTEGER DEFAULT 0, created_at TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY, owner_type TEXT, owner_id INTEGER, label TEXT, filename TEXT, mime TEXT, size INTEGER,
  sha256 TEXT, storage_path TEXT, scan_status TEXT, scan_note TEXT, vendor_visible INTEGER DEFAULT 1,
  restricted INTEGER DEFAULT 0, uploaded_by INTEGER, created_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, event TEXT, title TEXT, body TEXT, link TEXT,
  severity TEXT DEFAULT 'info', object_type TEXT, object_id INTEGER, dedupe_key TEXT,
  read_at TEXT, created_at TEXT, vendor_id INTEGER
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY, notification_id INTEGER, channel TEXT, recipient TEXT, subject TEXT, body TEXT,
  template TEXT, status TEXT, created_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor_id INTEGER, actor_name TEXT, role TEXT, action TEXT NOT NULL,
  object_type TEXT, object_id TEXT, object_ref TEXT, before_json TEXT, after_json TEXT, reason TEXT,
  ip TEXT, channel TEXT, prev_hash TEXT, hash TEXT
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY, value_json TEXT, version INTEGER DEFAULT 1, label TEXT, group_name TEXT,
  description TEXT, requires_approval INTEGER DEFAULT 0, decision_ref TEXT, status TEXT DEFAULT 'Active',
  updated_by INTEGER, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS config_history (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL, value_json TEXT, version INTEGER, status TEXT,
  effective_from TEXT, reason TEXT, requested_by INTEGER, requested_at TEXT,
  approvals_json TEXT, decided_at TEXT
);

CREATE TABLE IF NOT EXISTS sap_documents (
  id INTEGER PRIMARY KEY, doc_type TEXT NOT NULL, doc_key TEXT NOT NULL, payload_json TEXT,
  changed_at TEXT, deleted INTEGER DEFAULT 0, created_by TEXT,
  UNIQUE (doc_type, doc_key)
);

CREATE TABLE IF NOT EXISTS sap_outbound (
  id INTEGER PRIMARY KEY, flow TEXT, idempotency_key TEXT UNIQUE, payload_json TEXT, status TEXT,
  sap_doc_key TEXT, attempts INTEGER DEFAULT 0, created_at TEXT, completed_at TEXT
);

CREATE TABLE IF NOT EXISTS integration_jobs (
  id INTEGER PRIMARY KEY, flow TEXT, direction TEXT, trigger TEXT, started_at TEXT, finished_at TEXT,
  status TEXT, read_count INTEGER DEFAULT 0, upserted INTEGER DEFAULT 0, error_count INTEGER DEFAULT 0, message TEXT
);

CREATE TABLE IF NOT EXISTS integration_errors (
  id INTEGER PRIMARY KEY, flow TEXT, message_id TEXT, idempotency_key TEXT, payload_json TEXT, error TEXT,
  error_type TEXT, attempts INTEGER DEFAULT 1, status TEXT DEFAULT 'Queued', next_retry_at TEXT,
  created_at TEXT, updated_at TEXT, resolved_by INTEGER, resolution_reason TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  flow TEXT PRIMARY KEY, watermark TEXT, last_success TEXT, last_run TEXT, last_status TEXT, last_message TEXT
);

CREATE TABLE IF NOT EXISTS saved_views (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, screen TEXT NOT NULL, name TEXT NOT NULL,
  state_json TEXT, created_at TEXT
);

CREATE TABLE IF NOT EXISTS material_group_map (material_group TEXT PRIMARY KEY, category TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sap_sim_settings (key TEXT PRIMARY KEY, value_json TEXT);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY, job TEXT, started_at TEXT, finished_at TEXT, status TEXT, message TEXT
);

CREATE INDEX IF NOT EXISTS ix_pr_lines_buyer ON pr_lines(buyer_id, status);
CREATE INDEX IF NOT EXISTS ix_pr_lines_req ON pr_lines(requisitioner_id);
CREATE INDEX IF NOT EXISTS ix_rfq_inv_vendor ON rfq_invitations(vendor_id);
CREATE INDEX IF NOT EXISTS ix_po_vendor ON pos(vendor_id);
CREATE INDEX IF NOT EXISTS ix_po_lines_po ON po_lines(po_id);
CREATE INDEX IF NOT EXISTS ix_po_lines_pr ON po_lines(pr_line_id);
CREATE INDEX IF NOT EXISTS ix_inv_vendor ON invoices(vendor_id, status);
CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS ix_audit_obj ON audit_events(object_type, object_id);
CREATE INDEX IF NOT EXISTS ix_steps_approver ON approval_steps(approver_role, status);
CREATE INDEX IF NOT EXISTS ix_attach_owner ON attachments(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS ix_comments_obj ON comments(object_type, object_id);
CREATE INDEX IF NOT EXISTS ix_sapdocs_changed ON sap_documents(doc_type, changed_at);
`;

/** Add a column to an existing table if it is missing (upgrades databases created before the column existed). */
export function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function migrate() {
  db.exec(SCHEMA);
  ensureColumn('sessions', 'acting_vendor_id', 'INTEGER');
  ensureColumn('notifications', 'vendor_id', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS ix_notif_vendor ON notifications(vendor_id)');
}
