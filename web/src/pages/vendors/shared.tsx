/** Shared pieces for vendor management (internal) and the vendor portal. */
import { Badge, Status } from '@/components/ui';
import { daysUntil, fmtDate } from '@/lib/format';
import type { ChainStep } from '@/components/TrackChain';

export const ONBOARDING_STEPS = ['Invited', 'Registration in progress', 'Submitted', 'Under review', 'Approved', 'Pending SAP code', 'Active'];

/** Onboarding lifecycle for TrackChain (WF-06). */
export function onboardingChain(status: string): ChainStep[] {
  const labels = ['Invited', 'Registered', 'Submitted', 'Under review', 'Approved', 'SAP code', 'Active'];
  if (status === 'Rejected') return labels.map((l, i) => ({ label: i === 3 ? 'Rejected' : l, state: i < 3 ? 'done' : i === 3 ? 'blocked' : 'skipped' }));
  let cur = ONBOARDING_STEPS.indexOf(status);
  if (status === 'Clarification requested') cur = 3;
  return labels.map((label, i) => ({
    label: status === 'Clarification requested' && i === 3 ? 'Clarification' : label,
    state: status === 'Active' ? 'done' : i < cur ? 'done' : i === cur ? (status === 'Clarification requested' ? 'blocked' : 'current') : 'todo',
  }));
}

export function KycBadge({ state }: { state: string }) {
  const tone = state === 'Complete' ? 'ok' : state === 'Expiring' || state === 'Pending review' ? 'warn' : state === 'Incomplete' ? 'neutral' : 'bad';
  return <Badge tone={tone}>KYC {state.toLowerCase()}</Badge>;
}

/** Expiry cell: date plus days left, red when expired, amber inside the lead time. */
export function Expiry({ date, lead = 30 }: { date: string | null; lead?: number }) {
  if (!date) return <span className="subtle">No expiry</span>;
  const d = daysUntil(date) ?? 0;
  const color = d < 0 ? 'var(--bad)' : d <= lead ? 'var(--warn)' : undefined;
  return (
    <span style={{ color, fontWeight: color ? 600 : undefined }} className="nowrap">
      {fmtDate(date)}
      <span className="small" style={{ display: 'block', fontWeight: 500 }}>{d < 0 ? `expired ${-d} d ago` : d === 0 ? 'expires today' : `${d} d left`}</span>
    </span>
  );
}

export interface DocRow {
  id: number; doc_type: string; doc_no: string | null; attachment_id: number | null; issued_on: string | null; expiry_date: string | null;
  status: string; mandatory: number; review_note: string | null; created_at: string; filename?: string | null; reviewed_by_name?: string | null;
}

export function DocStatus({ d }: { d: DocRow }) {
  return (
    <div className="stack-sm" style={{ gap: 2 }}>
      <Status value={d.status} />
      {d.review_note && d.status !== 'Valid' && <span className="small muted">{d.review_note}</span>}
    </div>
  );
}

export const fileLink = (id: number | null, name?: string | null) =>
  id ? <a href={`/api/files/${id}/download`} target="_blank" rel="noreferrer">{name ?? 'Open file'}</a> : <span className="subtle">No file</span>;

export const TICKET_PRIORITIES = ['Normal', 'High', 'Urgent'];

export const slaText = (t: { sla_due: string | null; sla_breached?: boolean; status: string }) =>
  !t.sla_due || ['Resolved', 'Closed'].includes(t.status) ? '—' : t.sla_breached ? 'Breached' : `Due ${fmtDate(t.sla_due)}`;
