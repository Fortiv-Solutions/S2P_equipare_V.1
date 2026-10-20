export interface ContractRow {
  id: number;
  contract_no: string;
  type: string;
  vendor_id: number;
  vendor_name: string;
  vendor_sap_code: string | null;
  title: string | null;
  category: string | null;
  category_name: string | null;
  plant: string | null;
  sap_oa_no: string | null;
  valid_from: string;
  valid_to: string;
  status: string;
  value_cap: number | null;
  consumed: number;
  owner_name: string | null;
  scope: string;
  items_count: number;
  days_to_expiry: number;
  utilisation_pct: number | null;
  utilisation_warn: boolean;
  routable: boolean;
  has_vmi: boolean;
  discount_pct: number | null;
}

export interface Summary { all: number; active: number; expiring: number; pending_sap: number; draft: number; alerts: number; opportunities: number; value_in_force: number }

export interface AlertRow {
  id: number; po_id: number; po_no: string; item: number; material_code: string; description: string; uom: string; contract_id: number; contract_no: string;
  sap_oa_no: string; contract_type: string; contract_vendor: string; po_vendor: string; po_date: string; plant: string; qty: number; unit_price: number;
  contract_price: number | null; value: number; price_variance: number | null; buyer_name: string | null; status: string; reason: string | null;
  req_no: string | null; approval_id: number | null; approval_status: string | null; decided_by_name: string | null; decided_at: string | null; created_at: string; age_days: number;
}

export interface Item {
  id: number; material_id: number; material_code: string; description: string; uom: string | null; material_uom: string; unit_price: number; qty_cap: number | null;
  consumed_qty: number; discount_pct: number | null; utilisation?: { consumed_qty: number; qty_cap: number | null; pct: number | null; warn: boolean };
}
export interface PriceList { id: number; version: number; effective_from: string; state: string; note: string | null; created_by_name?: string | null; created_at?: string; items: { material_id: number; material_code: string; description: string; list_price: number }[] }
export interface VmiStatus { material_id: number; material_code: string; description: string; uom: string; plant: string | null; min: number; max: number; unrestricted: number; open_po_qty: number; synced_at: string | null; state: string; replenish_qty: number }
export interface Change { id: number; kind: string; status: string; before: any; after: any; reason: string | null; created_at: string; requested_by_name: string | null; req_no: string | null; approval_id: number | null; note: string | null; applied_at: string | null }

export interface ContractDetail {
  id: number; contract_no: string; type: string; vendor_id: number; title: string | null; category: string | null; category_name: string | null; plant: string | null;
  sap_oa_no: string | null; valid_from: string; valid_to: string; status: string; value_cap: number | null; consumed_value: number; payment_terms: string | null;
  delivery_terms: string | null; discount_pct: number | null; price_list_version: number | null; invoice_validation: number; renewal_lead_days: number | null;
  price_revision_date: string | null; terms: string | null; owner_id: number | null; created_by: number | null; created_at: string; synced_at: string | null; terminated_reason: string | null; renewed_from_id: number | null;
  vmi: { items: { material_id: number; material_code?: string; min: number; max: number }[]; replenishment_frequency: string; billing_cycle: string; reconciliation: string; plant?: string | null } | null;
  vendor: { id: number; name: string; sap_code: string | null; city: string; contact_name: string; contact_email: string; contact_phone: string };
  owner: { id: number; name: string; email: string } | null;
  owner_manager: { id: number; name: string } | null;
  items: Item[];
  utilisation: { consumed: number; cap: number | null; pct: number | null; warn: boolean; warn_pct: number; basis: string; linked_po_value: number; linked_pos: number; remaining: number | null };
  routable: boolean; reason: string; days_to_expiry: number; lead_days: number;
  price_lists: PriceList[]; vmi_status: VmiStatus[];
  pos: { id: number; po_no: string; po_date: string; status: string; total_value: number; basic_value: number; plant: string; buyer_name: string | null }[];
  approvals: { id: number; req_no: string; type: string; status: string; title: string; created_at: string; decided_at: string | null; outcome: string | null }[];
  alerts: AlertRow[]; changes: Change[];
  renewals: { id: number; contract_no: string; status: string; valid_from: string; valid_to: string }[];
  renewed_from: { id: number; contract_no: string; status: string; valid_to: string } | null;
  opportunity: { id: number; status: string; material_code: string } | null;
  renewal_decision: { kind: string; status: string; reason: string | null; at: string; by: string | null; after: any } | null;
  pending_change: Change | null;
  last_decision: { status: string; outcome: string | null; decided_at: string | null; req_no: string } | null;
  freshness: { stale: boolean; thresholdMinutes: number };
}

export interface Options {
  vendors: { id: number; name: string; sap_code: string | null; city: string; sap_blocked: number }[];
  materials: { id: number; code: string; description: string; uom: string; category: string | null; lpp: number | null }[];
  categories: { code: string; name: string }[];
  plants: { code: string; name: string }[];
  buyers: { id: number; name: string }[];
  types: string[];
  renewal_lead_days: number;
}

export const TYPE_LABEL: Record<string, string> = { ARC: 'Annual rate contract', OA: 'Outline agreement', FDS: 'Fixed discount structure', VMI: 'Vendor-managed inventory', 'Fixed supplier': 'Fixed supplier' };
export const KIND_LABEL: Record<string, string> = { terms: 'Commercial terms', price_list: 'New price list', extension: 'Validity extension', renewal: 'Renewal started', let_expire: 'Let expire' };
