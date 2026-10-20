export interface PoListRow {
  id: number; po_id: number; po_no: string; item: number; ref: string; po_date: string; rfq_date: string | null; po_status: string; version: number;
  urgency: string; plant: string; buyer_id: number | null; buyer_name: string | null; vendor_id: number; vendor_name: string; vendor_code: string | null;
  material_code: string | null; material_group: string | null; description: string; qty: number; uom: string; unit_price: number | null; line_value: number | null;
  delivery_date: string; ack_status: string; accepted_qty: number | null; commit_date: string | null; first_commit_date: string | null; ack_at: string | null;
  ack_due_at: string | null; viewed_at: string | null; received_qty: number; invoiced_qty: number; status: string; delay_reason: string | null;
  next_action_date: string | null; pr_ref: string | null; requisitioner_name: string | null; deemed_accepted: number; sap_change_pending: number;
  amendment: { amd_no: string; status: string } | null; open_qty: number; commitment: string; overdue: boolean; overdue_days: number; ack_overdue: boolean;
  dispatch_due: boolean; active: boolean; next_action: string; needs_action: boolean; escalation_level: number; reminders: number;
  last_response_at: string | null; last_followup: { kind: string; note: string | null; at: string; by: string } | null; closed: boolean;
}

export interface PoSummary {
  needs_action: number; open_lines: number; open_pos: number; pending_ack: number; ack_overdue: number; overdue: number; rejected: number; partial: number;
  deemed: number; escalated: number; amendments: number; counts: { needs: number; open: number; closed: number; all: number };
}

export interface SapAck { key: string; status: string; attempts: number; at: string; error: string | null }

export interface PoLineDetail {
  id: number; po_id: number; item: number; description: string; qty: number; uom: string; unit_price: number | null; gst_rate: number; freight: number | null;
  line_value: number | null; delivery_date: string; ack_status: string; accepted_qty: number | null; commit_date: string | null; first_commit_date: string | null;
  ack_remarks: string | null; ack_at: string | null; received_qty: number; invoiced_qty: number; status: string; delay_reason: string | null;
  next_action_date: string | null; material_code: string | null; material_group: string | null; hsn: string | null; pr_ref: string | null; pr_line_id: number | null;
  requisitioner_name: string | null; own_pr?: boolean; open_qty: number; commitment: string; overdue: boolean; overdue_days: number; ack_overdue: boolean;
  dispatch_due: boolean; active: boolean; next_action: string; needs_action: boolean;
  commitment_history: { at: string; commit_date: string; delay_reason: string | null; by: string; kind: string; type: string | null; old: string | null }[];
  sap_ack: SapAck | null;
}

export interface Followup {
  id: number; po_line_id: number | null; item: number | null; kind: string; note: string | null; commit_date: string | null; delay_reason: string | null;
  next_action_date: string | null; created_at: string; user_name: string; by_vendor: boolean; meta: Record<string, any> | null;
}

export interface AmdConf { user_id: number; name: string; role: string; at: string; on_behalf: boolean; note: string | null }
export interface AmdLineChange {
  line_id: number; item: number; description: string; uom: string;
  old: { qty: number; unit_price: number | null; delivery_date: string };
  new: { qty?: number; unit_price?: number | null; delivery_date?: string; deleted?: boolean };
}
export interface Amendment {
  id: number; amd_no: string; type: string; status: string; reason: string; raised_by_vendor: boolean; requested_by: number; requested_by_name: string | null;
  created_at: string; sap_changed_at: string | null; reack_at: string | null; summary: string;
  approvals: { id: number; req_no: string; type: string; status: string; current_level: number; created_at: string; decided_at: string | null }[];
  changes: {
    lines: AmdLineChange[]; terms?: { old: Record<string, string | null>; new: Record<string, string | null> }; scope?: 'po' | 'lines';
    requires_confirmation: boolean; confirmation_reason?: string; confirmations: { stores?: AmdConf; vendor?: AmdConf }; value_delta: number | null;
    forwarded_by?: { name: string; at: string }; sap_request?: { at: string; by_name: string };
  };
}

export interface PoDetail {
  id: number; po_no: string; po_date: string; status: string; version: number; urgency: string; plant: string; delivery_terms: string | null;
  payment_terms: string | null; freight_terms: string | null; currency: string; total_value: number | null;
  totals: { goods: number; gst: number; freight: number; total: number } | null; rfq_date: string | null; published_at: string | null; viewed_at: string | null;
  ack_due_at: string | null; deemed_accepted: boolean; sap_change_pending: boolean; synced_at: string | null; closed_at: string | null; stale: boolean;
  freshness_minutes: number;
  vendor: { id: number; name: string; sap_code: string | null; gstin: string | null; address?: string | null; city?: string | null; contact_name?: string | null; contact_email?: string | null; contact_phone?: string | null; msme_category?: string | null };
  plant_info: { code: string; name: string; gstin: string; ship_to_address: string } | null;
  buyer: { id: number; name: string; email: string; phone: string | null } | null; buyer_manager: { id: number; name: string } | null;
  contract: { id: number; contract_no: string; type: string; sap_oa_no: string } | null; rfq: { id: number; rfq_no: string } | null;
  lines: PoLineDetail[]; followups: Followup[]; amendments: Amendment[];
  publications: { version: number; kind: string; published_at: string; amendment_id: number | null; recipients: number }[];
  asns: { id: number; asn_no: string; status: string; dispatch_date: string | null; expected_date: string | null; transporter: string | null; lr_no: string | null; created_at: string }[];
  grns: { grn_no: string; posting_date: string; qty: number; value: number | null; item: number; is_service: number }[];
  invoices: { id: number; inv_ref: string; vendor_invoice_no: string | null; invoice_date: string | null; status: string; total_value: number | null }[];
  disputes: { id: number; dsp_no: string; type: string; status: string; owner_party: string | null; item: number | null; created_at: string }[];
  escalation_level: number; reminders: number; in_dispatch: boolean; open_amendment: { id: number; amd_no: string; status: string; type: string } | null;
  config: {
    sap_write_ack: boolean; deemed_acceptance: { enabled: boolean; hours: number }; reminders: { ack_after_hours: number; dispatch_days_before: number; overdue_days_after: number };
    escalation: { level2_days: number; level3_days: number }; delay_reasons: string[];
  };
  view: 'internal' | 'vendor' | 'requisitioner';
}

export interface VendorPoRow {
  id: number; po_no: string; po_date: string; status: string; version: number; urgency: string; plant: string; plant_name: string | null; total_value: number;
  lines: number; pending_ack: number; reack: boolean; ack_due_at: string | null; viewed_at: string | null; next_delivery: string | null; open_lines: number;
  delivery_terms: string | null; to_acknowledge: boolean; cancel_ack: string | null; ack_overdue: boolean;
}
