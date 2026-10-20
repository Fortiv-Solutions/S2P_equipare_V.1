export interface AsnLine { po_line_id: number; item: number; qty: number; packing?: string | null }

export interface AsnListRow {
  id: number; asn_no: string; po_id: number; po_no: string; vendor_id: number; vendor_name: string; vendor_code: string | null; buyer_name: string | null;
  plant: string; status: string; dispatch_date: string | null; expected_date: string | null; transporter: string | null; lr_no: string | null; vehicle_no: string | null;
  eway_bill: string | null; invoice_ref: string | null; delivery_terms: 'FOR' | 'Ex-Works'; freight_mode: string | null; transit_risk: string | null;
  pickup_by: 'Vendor' | 'Equipcare'; pickup_date: string | null; pickup_status: string | null; lines: AsnLine[] | null; version: number;
  line_count: number; total_qty: number; pickup_overdue: boolean; delivery_overdue: boolean; open_disputes: number; doc_count: number; grn_nos: string | null;
  created_at: string; submitted_at: string | null; delivered_at: string | null; cancel_reason: string | null; packing_details: string | null;
}

export interface AsnDetail extends AsnListRow {
  po: { id: number; po_no: string; po_date: string; status: string; urgency: string; delivery_terms_text: string | null; freight_terms_text: string | null; payment_terms: string | null; buyer_name: string | null; vendor_name: string; version: number };
  plant_name: string; ship_to: string | null;
  lines: (AsnLine & { description: string; material_code: string | null; uom: string; ordered: number; accepted: number; po_received: number; received_on_asn: number | null; line_status: string | null; unit_price: number | null })[];
  grns: { id: number; grn_no: string; po_line_id: number; qty: number; value: number | null; posting_date: string; plant: string; item: number }[];
  grn_links: { grn_no: string; matched_by: string; linked_at: string }[];
  disputes: { id: number; dsp_no: string; type: string; status: string; qty: number; po_line_id: number; owner_party: string; created_at: string }[];
  versions: { id: number; version: number; snapshot: Record<string, any>; reason: string; created_at: string; created_by_name: string | null }[];
  lr_mandatory: boolean;
  actions: { submit: boolean; edit: boolean; cancel: boolean; dispatch: boolean; pickup: boolean; raise_dispute: boolean; post_grn: boolean };
}

export interface Availability {
  po_line_id: number; item: number; description: string; material_code: string | null; uom: string; ordered: number; ack_status: string; accepted: number;
  received: number; in_transit: number; open: number; max: number; delivery_date: string; unit_price: number; eligible: boolean; reason: string | null;
}

export interface Prefill {
  po: { id: number; po_no: string; plant: string; plant_name: string; ship_to: string | null; po_date: string; status: string; urgency: string; delivery_terms_text: string | null; freight_terms_text: string | null; payment_terms: string | null; buyer_name: string | null; vendor_name: string; sap_change_pending: boolean };
  defaults: { delivery_terms: 'FOR' | 'Ex-Works'; freight_mode: string; transit_risk: string; pickup_by: 'Vendor' | 'Equipcare' };
  lr_mandatory: boolean; tolerance_pct: number; lines: Availability[]; blocked: string | null;
}

export interface DisputeRow {
  id: number; dsp_no: string; type: string; status: string; po_id: number; po_no: string; po_line_id: number; item: number; description: string; uom: string;
  plant: string; vendor_id: number; vendor_name: string; qty: number; value: number | null; delivery_term: string; owner_party: string; owner_name: string | null; owner_label: string;
  raised_by_name: string; created_at: string; source: string; outcome: string | null; asn_id: number | null; asn_no: string | null; age_days: number; bucket: string; bucket_index: number;
  open: boolean; escalated: boolean; closed_at: string | null; resolved_at: string | null; closure_tat_days: number | null; awaiting_you: boolean;
}

export interface DisputeEvent { id: number; kind: string; body: string; vendor_visible: number; created_at: string; user_name: string | null; user_role: string | null; is_vendor: number }

export interface DisputeDetail extends DisputeRow {
  description_text: string | null; outcome_note: string | null; outcome_amount: number | null; due_at: string | null; owner_user_id: number | null;
  po: { id: number; po_no: string; delivery_terms_text: string | null; buyer_name: string | null; plant: string; vendor_name: string };
  line: { id: number; item: number; description: string; material_code: string | null; qty: number; uom: string; unit_price: number | null; received_qty: number };
  asn: { id: number; asn_no: string; status: string; transporter: string | null; lr_no: string | null; dispatch_date: string | null; delivered_at: string | null; delivery_terms: string; transit_risk: string | null; freight_mode: string | null } | null;
  grn: { id: number; grn_no: string; qty: number; posting_date: string } | null;
  invoices: { id: number; inv_ref: string; vendor_invoice_no: string | null; status: string; sub_reason: string | null; dispute_hold: number; total_value: number | null; invoice_date: string | null }[];
  approval: { id: number; req_no: string; status: string } | null;
  events: DisputeEvent[];
  default_owner: string; threshold_days: number; closure_approval: boolean;
  actions: { respond: boolean; reassign: boolean; note: boolean; evidence: boolean; request_response: boolean; under_resolution: boolean; outcome: boolean; close: boolean; reopen: boolean };
}

export interface AsnMeta {
  dispute_types: string[]; outcomes: string[]; owner_parties: string[]; evidence_labels: string[];
  responsibility: Record<string, Record<string, string>>; photo_rule: { types: string[]; min_photos: number }; lr_mandatory: Record<string, boolean>;
  tolerance_pct: number; closure_approval: boolean; escalate_days: number; buckets: string[]; hold_rule: string;
}
