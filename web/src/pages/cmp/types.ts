export interface Cell {
  vendor_id: number; vendor_name: string; sap_code: string | null; quotation_id: number; quotation_ref: string | null; quotation_version: number;
  no_quote: boolean; quoted_qty: number | null; basic_price: number | null; discount_pct: number | null; net_unit: number | null; gst_rate: number | null; gamma: number;
  freight_quoted: number; freight_estimate: number; freight: number; packing: number; basic_value: number | null; taxable: number | null; gst_amount: number | null;
  gst_impact: number | null; pta: number | null; ld: number; rd: number; ld_pending: number; rd_pending: number; landed_before_discounts: number | null;
  landed: number | null; unit_landed: number | null; delivery_days: number | null; delivery_terms: string | null; credit_days: number | null; payment_terms: string | null;
  make_brand: string | null; warranty: string | null; alternate: boolean; partial: boolean; acceptable: boolean; remarks: string | null; eligible: boolean;
  rank: number | null; alt_rank: number | null; lowest: boolean; var_lpp_pct: number | null; var_contract_pct: number | null; var_budget_pct: number | null;
  var_lowest_pct: number | null; performance_score: number | null;
}
export interface Row {
  rfq_line_id: number; line_no: number; pr_line_id: number | null; pr_ref: string | null; pr_priority: string | null; material_id: number | null; material_code: string | null;
  description: string; qty: number; uom: string | null; plant: string | null; required_date: string | null; category: string | null; gamma: number; gamma_basis: string;
  lpp: number | null; lpp_date: string | null; lpp_vendor: string | null; budget_price: number | null;
  contract: { id: number; contract_no: string; type: string; sap_oa_no: string | null; vendor: string; unit_price: number | null; valid_to: string } | null;
  cells: Cell[]; lowest_vendor_ids: number[]; lowest_unit_landed: number | null; fastest_vendor_id: number | null;
}
export interface VendorSummary {
  vendor_id: number; name: string; sap_code: string | null; quotation_id: number; quotation_ref: string | null; quotation_status: string; version: number;
  lines_quoted: number; lines_total: number; complete: boolean; total_landed: number; lowest_lines: number; delivery_terms: string | null; payment_terms: string | null;
  credit_days: number | null; validity_date: string | null; performance_score: number | null; remarks: string | null;
}
export interface Coverage {
  invited: number; responded: number; declined: number; non_participating: number; coverage_pct: number | null;
  vendors: { vendor_id: number; name: string; sap_code: string | null; status: 'Responded' | 'Declined' | 'Non-participating'; detail: string | null; lines_quoted: number }[];
}
export interface Award { rfq_line_id: number; pr_line_id: number | null; vendor_id: number; vendor_name?: string; qty: number; unit_price: number; gst_rate: number; freight: number; landed_unit: number; landed_total?: number; lowest: boolean; reason: string | null; delivery_days?: number | null }
export interface Discount { rfq_line_id: number; vendor_id: number; late: number; risk: number; reason: string; status: string; approval_id: number | null; requested_at: string }
export interface LandedParams { gst_impact: string; payment_term_adjustment: { enabled: boolean; rate_pct: number; reference_days: number }; exw_freight_estimate_pct: number }

export interface Comparison {
  id: number; cmp_no: string; ref: string; version: number; status: string; rfq_id: number;
  params: { landed_cost: LandedParams; discounts: { late_discount: string; risk_discount: string; approval_required: boolean }; split_by_qty: boolean; snapshot_at: string; quotations: { id: number; vendor_id: number; version: number; status: string; ref_no: string | null }[]; acceptable: string[]; acceptable_reasons?: Record<string, string> };
  rows: Row[]; awards: Award[] | null; justification: string | null; deviation: number; deviation_reason: string | null; late_discount: Discount[] | null;
  summary: {
    vendors: VendorSummary[]; coverage: Coverage; lines: number; lowest_total: number; computed_at: string; superseded_by?: number | null; supersedes?: number | null; note?: string | null;
    recommendation?: { by: number; by_name: string; at: string; total_landed: number; lowest_total: number; difference: number; skipped: { rfq_line_id: number; reason: string }[]; deviation_lines: number } | null;
    submission?: { at: string; approval_ids: number[]; award_approval_id: number; deviation_approval_id: number | null; round: number } | null;
    released?: { at: string; by_name: string } | null; pdf_attachment_id?: number | null;
  };
  created_at: string; created_by_name: string | null; submitted_at: string | null; decided_at: string | null; sap_handoff_at: string | null;
  rfq: { id: number; rfq_no: string; title: string | null; status: string; plant: string | null; category: string | null; buyer_id: number | null; buyer_name: string | null; closing_at: string | null; closed_at: string | null; delivery_terms: string | null; payment_terms: string | null };
  approvals: { id: number; req_no: string; type: string; status: string; title: string; value: number | null; current_level: number; created_at: string; decided_at: string | null; matrix_version: number | null }[];
  versions: { id: number; version: number; status: string; created_at: string }[];
  pos: { id: number; po_no: string; vendor: string; status: string; po_date: string; total_value: number | null }[];
  pdf: { id: number; filename: string; created_at: string; size: number } | null;
  editable: boolean; quotes_changed: boolean;
}

export const CMP_STAGES = ['Draft', 'Recommendation recorded', 'Submitted for approval', 'Approved', 'Released for PO'];
