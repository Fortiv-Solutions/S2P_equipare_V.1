/** Shared types and small components for the RFQ area (Module 2 / 3). */
import { useEffect, useState, type ReactNode } from 'react';
import { chainFrom, type ChainStep } from '@/components/TrackChain';
import { Badge } from '@/components/ui';
import { daysUntil, fmtDateTime } from '@/lib/format';

export interface Reason { code: string; label: string; points: number }
export interface SuggestedVendor { vendor_id: number; name: string; sap_code: string | null; city: string | null; score: number; lines: number[]; reasons: Reason[]; invited?: boolean }
export interface Excluded { vendor_id: number; name: string; sap_code: string | null; reasons: string[] }
export interface Autofill { gst_rate: number | null; valuation_type: string | null; plant: string | null; ship_to: string | null; transport_req: string | null; source: string }

export interface RfqLine {
  id: number; line_no: number; pr_line_id: number | null; pr_ref: string | null; pr_status: string | null; pr_flag: string | null; priority: string; requisitioner: string | null;
  material_id: number | null; material_code: string | null; description: string; qty: number; uom: string; required_date: string | null; due_at: string | null; plant: string | null;
  ship_to: string | null; gst_rate: number | null; valuation_type: string | null; transport_req: string | null; specs: string | null; status: string; flag_reason: string | null;
  autofill: Autofill | null; lpp: number | null; hsn: string | null; brand: string | null; category: string | null; files: number;
}
export interface Invitation {
  id: number; vendor_id: number; vendor_name: string; sap_code: string | null; contact_email: string | null; contact_name: string | null; city: string | null;
  suggested: number; suggest_reasons: { score: number; lines: number[]; reasons: Reason[] } | null; added_justification: string | null; status: string;
  sent_at: string | null; delivery_status: string | null; viewed_at: string | null; responded_at: string | null; declined_at: string | null; decline_reason: string | null;
  reminders_sent: number; last_reminder_at: string | null;
  quotation: { id: number; status: string; version: number; submitted_at: string | null; ref_no: string | null } | null;
}
export interface QLine {
  rfq_line_id: number; no_quote: boolean; quoted_qty: number | null; basic_price: number | null; discount_pct: number | null; gst_rate: number | null; freight: number | null;
  packing: number | null; delivery_days: number | null; make_brand: string | null; warranty: string | null; alternate: boolean; partial: boolean; remarks: string | null;
}
export interface QHeader { payment_terms: string | null; credit_days: number | null; delivery_terms: string | null; validity_date: string | null; remarks: string | null }
export interface Change { line: number | null; field: string; label: string; from: unknown; to: unknown }
export interface Version { version: number; created_at: string; note: string | null; ref_no: string | null; changes: Change[] }
export interface BuyerQuote {
  id: number; vendor_id: number; vendor_name: string; sap_code: string | null; status: string; version: number; ref_no: string | null; submitted_at: string | null;
  header: QHeader | null; lines: QLine[]; documents: { id: number; label: string | null; filename: string; size: number; created_at: string; scan_status: string }[]; versions: Version[];
}
export interface Reopen { id: number; vendor_ids: number[]; vendors: string[]; reason: string; status: string; reopen_until: string; requested_by_name: string; created_at: string; approval_id: number | null }
export interface Extension { from: string; to: string; reason: string; by_name: string; at: string; reopened_from_closed?: boolean }
export interface RfqDetail {
  id: number; rfq_no: string; title: string; kind: string; status: string; buyer_id: number; buyer_name: string | null; buyer_email: string | null; category: string | null; plant: string | null;
  closing_at: string; delivery_terms: string | null; payment_terms: string | null; warranty: string | null; packing: string | null; documents_required: string | null; standard_terms: string | null;
  ship_to: string | null; sealed: number; sealed_now: boolean; reminder_schedule: { before_days: number[]; after_days: number[]; sent?: string[] } | null; extensions: Extension[] | null;
  parent_rfq_id: number | null; cancel_reason: string | null; exception_reason: string | null; created_at: string; published_at: string | null; closed_at: string | null; sap_rfq_ref: string | null;
  no_contract_snapshot: { rfq_line_no: number; material_code: string | null; contract_no: string | null; contract_type: string | null; vendor: string | null; checked_at: string }[] | null;
  lines: RfqLine[]; invitations: Invitation[];
  counts: { invited: number; sent: number; viewed: number; responded: number; declined: number; not_responded: number; delivery_failed: number };
  min_vendors: number; categories: { code: string; name: string; min_vendors: number }[]; est_value: number; priority: string;
  approvals: { id: number; req_no: string; type: string; status: string; title: string; created_at: string; decided_at: string | null; outcome: string | null }[];
  reopens: Reopen[]; children: { id: number; rfq_no: string; status: string }[]; parent: { id: number; rfq_no: string; status: string } | null;
  opportunity: { id: number; status: string; material_code: string } | null;
  sap: { enabled: boolean; ref: string | null; outbound: { status: string; attempts: number; completed_at: string | null } | null; decision: string };
  publish_problems: Record<string, string>; quotations: BuyerQuote[] | null; comparison_link: string | null; can_close_early: boolean; can_extend: boolean;
  reopen_open: Reopen | null; viewer_can_manage: boolean;
}

/** RFQ lifecycle on the track chain (PRD 7.2 states). */
export function rfqChain(r: { status: string; approvals?: { type: string }[]; closing_at: string; published_at?: string | null; closed_at?: string | null }): ChainStep[] {
  const labels = ['Draft', 'Approval', 'Published', 'Closed', 'Comparison', 'Awarded'];
  const hadApproval = (r.approvals ?? []).some((a) => a.type.startsWith('exc.'));
  const idx: Record<string, number> = { Draft: 0, 'Pending approval': 1, Published: 2, Closed: 3, 'Under comparison': 4, Awarded: 6 };
  const skipped = hadApproval || r.status === 'Pending approval' ? [] : [1];
  if (r.status === 'Cancelled' || r.status === 'Re-floated') {
    const at = r.closed_at && r.published_at ? 3 : r.published_at ? 2 : 0;
    return chainFrom(labels, at, { blockedAt: at, skipped, subs: { [at]: r.status } });
  }
  return chainFrom(labels, idx[r.status] ?? 0, { skipped, subs: { 2: r.published_at ? fmtDateTime(r.published_at).replace(' IST', '') : undefined, 3: fmtDateTime(r.closing_at).replace(' IST', '') } });
}

/** "Closes in 2 d 4 h" / "Closed 3 h ago" with urgency colour. */
export function Countdown({ at, closed }: { at: string; closed?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 60000); return () => clearInterval(t); }, []);
  const ms = new Date(at).getTime() - Date.now();
  if (closed || ms <= 0) return <span className="muted">Closed {fmtDateTime(at)}</span>;
  const h = Math.floor(ms / 3600000);
  const txt = h >= 48 ? `${Math.floor(h / 24)} d ${h % 24} h` : h >= 1 ? `${h} h ${Math.floor((ms % 3600000) / 60000)} min` : `${Math.max(1, Math.floor(ms / 60000))} min`;
  return <span style={{ color: h < 24 ? 'var(--bad)' : h < 48 ? 'var(--warn)' : undefined, fontWeight: 600 }} title={fmtDateTime(at)}>Closes in {txt}</span>;
}

export function KindBadge({ kind }: { kind: string }) {
  return kind === 'ARC' ? <Badge tone="decision" title="Annual-rate RFQ for an ARC/OA opportunity">Annual rate (ARC)</Badge> : null;
}

/** ISO ⇄ <input type="datetime-local"> in the browser's zone. */
export function toLocalInput(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : '');

export const money = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);

/** Line value as quoted: P(1−d)q + freight + packing, and with GST. */
export function lineValue(q: QLine, rfqQty: number) {
  if (q.no_quote || q.basic_price == null) return null;
  const qty = q.quoted_qty ?? rfqQty;
  const taxable = q.basic_price * (1 - (q.discount_pct ?? 0) / 100) * qty + (q.freight ?? 0) + (q.packing ?? 0);
  return { taxable, withGst: taxable * (1 + (q.gst_rate ?? 0) / 100), qty };
}

export function Pill({ children, tone }: { children: ReactNode; tone?: 'warn' | 'decision' | 'info' }) {
  return <Badge tone={tone ?? 'neutral'} plain>{children}</Badge>;
}

export const daysLeft = (iso: string) => daysUntil(iso);
