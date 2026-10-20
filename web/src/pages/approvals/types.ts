export interface Linked { label: string; ref: string | null; link: string | null }
export interface ApprovalItem {
  id: number; req_no: string; type: string; type_label: string; category: 'approval' | 'exception'; title: string; summary: string | null; value: number | null;
  status: string; current_level: number; levels: number | null; requester_id: number; requester_name: string | null; created_at: string; decided_at: string | null;
  age_days: number; age_hours: number; bucket: string | null; waiting_on: string[]; waiting_on_label: string | null; can_act: boolean; urgency: string | null; plant: string | null;
  matrix_version: number | null; linked: Linked; bulk_allowed: boolean;
}
export interface Summary {
  mine: number; mine_value: number; mine_overdue: number; raised_open: number; clarifications: number; all_open: number | null; can_all: boolean;
  bulk_types: string[]; buckets: string[]; types: { id: string; label: string; category: string }[];
}
export interface AgeingData { by: string; buckets: string[]; rows: { key: string; label: string; counts: number[]; total: number; oldest: number; names?: string }[]; total: number }
export interface Delegation {
  can_delegate: boolean; active: boolean; delegate: { id: number; name: string; title: string | null } | null; until: string | null; expired: boolean;
  incoming: { id: number; name: string; roles: string[]; delegate_until: string }[]; candidates: { id: number; name: string; title: string | null; roles: string }[];
}
export interface Step {
  id: number; level: number; approver_role: string; role_label: string; status: string; comment: string | null; acted_by: number | null; acted_by_name?: string; acted_at: string | null;
  due_at: string | null; escalated: number; device: string | null; delegated_from: number | null; delegated_from_name: string | null; parallel_group: number | null; holders: string[];
}
export interface Detail extends Omit<ApprovalItem, 'linked' | 'levels'> {
  object_type: string; object_id: number; reason: string | null; outcome: string | null; context: Record<string, unknown>; recommended_by_name: string | null;
  requester_title: string | null; requester_department: string | null; steps: Step[]; levels: { level: number; roles: string[]; label?: string }[];
  matrix: { id: number | null; name: string; version: number | null; effective_from: string | null; note: string | null; fallback: boolean };
  linked: Linked; panel: any; comments: { id: number; body: string; created_at: string; user_id: number; user_name: string; internal: number }[];
  why_not: string | null; acting_as_delegate_for: string | null; can_answer: boolean; can_withdraw: boolean;
}
