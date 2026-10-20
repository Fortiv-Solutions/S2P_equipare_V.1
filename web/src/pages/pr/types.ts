export interface Checks {
  ran_at: string;
  sap_unavailable: boolean;
  stale: boolean;
  stock: { unrestricted: number; covers: boolean; synced_at: string | null };
  open_po: { qty: number; lines: { po_no: string; item: number; open: number }[] };
  vmi: { active: boolean; contract_no: string | null };
  contract: { valid: boolean; contract_id: number | null; contract_no: string | null; type: string | null; sap_oa_no: string | null; vendor: string | null; unit_price: number | null; discount_pct: number | null; valid_to: string | null; remaining_value: number | null } | null;
  proposed: string;
  proposal_note: string;
}

export interface PrLine {
  id: number;
  ref: string;
  pr_no: string;
  item: number;
  material_code: string;
  description: string;
  material_group: string | null;
  category: string | null;
  plant: string;
  qty: number;
  uom: string;
  required_date: string;
  priority: string;
  status: string;
  route: string | null;
  route_proposed: string | null;
  buyer_id: number | null;
  buyer_name: string | null;
  requisitioner_name: string | null;
  department: string | null;
  age_days: number;
  est_value: number | null;
  est_unit_price: number | null;
  repeat_flag: number;
  repeat_info: { count: number; value: number; vendors: number; lookback_days: number } | null;
  checks: Checks | null;
  checks_at: string | null;
  rfq_id: number | null;
  rfq_no: string | null;
  rfq_status: string | null;
  po_no: string | null;
  sla_due: string | null;
  sla_breached: boolean;
  flag: string | null;
  is_capex: number;
  is_service: number;
  sap_status: string;
  synced_at: string | null;
  available_at: string | null;
  hold_reason: string | null;
}
