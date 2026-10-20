/**
 * TrackChain — the platform's lifecycle tracker, drawn as linked track-chain links: the
 * undercarriage component Equipcare rebuilds every day. Done links are amber, the current link is
 * purple with a live pin, blocked links are red. Each step's label is text, so state never relies on
 * colour alone.
 */
import type { ReactNode } from 'react';

export type ChainState = 'done' | 'current' | 'todo' | 'blocked' | 'skipped';
export interface ChainStep {
  label: string;
  state: ChainState;
  sub?: ReactNode;
}

export function TrackChain({ steps, compact, dark, label = 'Progress' }: { steps: ChainStep[]; compact?: boolean; dark?: boolean; label?: string }) {
  return (
    <ol className={`chain${compact ? ' chain--compact' : ''}${dark ? ' chain--dark' : ''}`} aria-label={label} style={{ listStyle: 'none', margin: 0 }}>
      {steps.map((s, i) => (
        <li key={i} className="chain__step" data-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
          <span className="chain__link" aria-hidden>
            <span className="chain__pin" />
            <span className="chain__pin" />
          </span>
          <span className="chain__bar" aria-hidden />
          <span className="chain__label">
            {s.label}
            <span className="sr-only"> — {s.state === 'done' ? 'complete' : s.state === 'current' ? 'in progress' : s.state === 'blocked' ? 'blocked' : s.state === 'skipped' ? 'not applicable' : 'not started'}</span>
          </span>
          {s.sub && <span className="chain__sub">{s.sub}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Build steps from an ordered list and the index of the current step. */
export function chainFrom(labels: string[], current: number, opts: { blockedAt?: number; subs?: Record<number, ReactNode>; skipped?: number[] } = {}): ChainStep[] {
  return labels.map((label, i) => ({
    label,
    sub: opts.subs?.[i],
    state: opts.skipped?.includes(i) ? 'skipped' : opts.blockedAt === i ? 'blocked' : i < current ? 'done' : i === current ? 'current' : 'todo',
  }));
}

/** The source-to-pay chain for a PR line, derived from its status and linked documents. */
export function prLineChain(l: { status: string; route?: string | null; rfq_no?: string | null; po_no?: string | null; ack_status?: string | null; asn_status?: string | null; received_qty?: number | null; qty?: number }): ChainStep[] {
  const labels = ['Synced', 'Buyer', 'Checks', 'Route', 'RFQ / contract', 'PO', 'Acknowledged', 'Dispatched', 'Received'];
  const s = l.status;
  let cur = 0;
  if (['Assigned', 'Clarification pending', 'On hold'].includes(s)) cur = 2;
  else if (s === 'Unassigned' || s === 'Synced') cur = 1;
  else if (s === 'Under review') cur = 3;
  else if (['Route decided', 'Exception pending approval'].includes(s)) cur = 4;
  else if (['RFQ in progress', 'Contract/VMI PO pending'].includes(s)) cur = 5;
  else if (s === 'PO created') {
    cur = 6;
    if (l.ack_status && /accept/i.test(l.ack_status)) cur = 7;
    if (l.asn_status) cur = 8;
    if (l.received_qty && l.qty && l.received_qty >= l.qty) cur = 9;
  } else if (s === 'Closed') cur = 9;
  const blockedAt = ['Cancelled in SAP'].includes(s) ? 0 : s === 'On hold' || s === 'Exception pending approval' ? cur : undefined;
  return chainFrom(labels, cur, { blockedAt, subs: { 3: l.route ?? undefined, 4: l.rfq_no ?? undefined, 5: l.po_no ?? undefined } });
}
