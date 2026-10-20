import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { chainFrom, type ChainStep } from '@/components/TrackChain';
import { fmtDate } from '@/lib/format';
import { Badge } from '@/components/ui';
import type { AsnListRow, AsnMeta } from './types';

export const useAsnMeta = () => useQuery<AsnMeta>({ queryKey: ['asn', 'meta'], queryFn: () => api.get('/asn/meta'), staleTime: 300_000 });

/** ASN lifecycle: Draft → Submitted → (Picked up) → In transit → Delivered | Cancelled. */
export function asnChain(a: Pick<AsnListRow, 'status' | 'pickup_by' | 'pickup_status' | 'pickup_date' | 'dispatch_date' | 'expected_date' | 'delivered_at' | 'grn_nos' | 'pickup_overdue'>): ChainStep[] {
  const eq = a.pickup_by === 'Equipcare';
  const labels = eq ? ['Draft', 'Submitted', 'Pickup', 'In transit', 'Delivered (GRN)'] : ['Draft', 'Submitted', 'In transit', 'Delivered (GRN)'];
  // Index of the current step: Submitted waits for pickup / dispatch, In transit waits for the GRN.
  const current = a.status === 'Draft' ? 0 : a.status === 'Submitted' ? (eq ? 2 : 1) : a.status === 'In transit' ? (eq ? 3 : 2) : a.status === 'Delivered' ? labels.length : 0;
  const subs: Record<number, string | undefined> = eq
    ? { 2: a.pickup_status ? `${a.pickup_status}${a.pickup_date ? ` · ${fmtDate(a.pickup_date)}` : ''}` : undefined, 3: a.dispatch_date ? fmtDate(a.dispatch_date) : undefined, 4: a.grn_nos ?? (a.expected_date ? `ETA ${fmtDate(a.expected_date)}` : undefined) }
    : { 2: a.dispatch_date ? fmtDate(a.dispatch_date) : undefined, 3: a.grn_nos ?? (a.expected_date ? `ETA ${fmtDate(a.expected_date)}` : undefined) };
  if (a.status === 'Cancelled') return labels.map((l, i) => ({ label: l, state: i === 0 ? 'done' : i === 1 ? 'blocked' : 'skipped', sub: i === 1 ? 'Cancelled' : undefined }));
  return chainFrom(labels, current, { blockedAt: a.pickup_overdue ? 2 : undefined, subs });
}

/** Dispute lifecycle (PRD 7.8 states). */
export function disputeChain(status: string, owner?: string): ChainStep[] {
  const labels = ['Raised', 'Assigned', 'Awaiting response', 'Under resolution', 'Resolved', 'Closed'];
  const map: Record<string, number> = { Raised: 1, Assigned: 2, 'Awaiting response': 2, 'Under resolution': 3, Reopened: 3, Resolved: 4, Closed: 6 };
  const cur = map[status] ?? 0;
  const steps = chainFrom(labels, cur, { subs: { 1: owner } });
  if (status === 'Assigned') steps[2] = { ...steps[2], state: 'todo' };
  if (status === 'Reopened') steps[3] = { ...steps[3], sub: 'Reopened' };
  return steps;
}

export function TermBadge({ term }: { term: string }) {
  return <Badge tone={term === 'Ex-Works' ? 'amber' : 'deep'} plain>{term}</Badge>;
}

export function AgeCell({ days, threshold, open }: { days: number; threshold?: number; open: boolean }) {
  const late = open && threshold != null && days >= threshold;
  return <span className="num" style={{ color: late ? 'var(--bad)' : days > 3 && open ? 'var(--warn)' : undefined, fontWeight: late ? 700 : 500 }}>{days} d</span>;
}

export const todayIso = () => new Date().toISOString().slice(0, 10);
export const addDaysIso = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
