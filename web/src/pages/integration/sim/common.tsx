import { useEffect, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { SimBadge } from '@/components/ui';
import type { SyncOutcome } from '../shared';

/** Everything a simulator action can change on the platform side. */
export const SIM_INVALIDATE = [['sim'], ['integration'], ['pr'], ['pos'], ['po'], ['invoices'], ['payments'], ['contracts'], ['vendors'], ['rfq'], ['cmp'], ['asn'], ['meta'], ['nav-counts']];

export interface SimResult { sync?: SyncOutcome; [k: string]: any }

export interface Lookups {
  plants: { code: string; name: string }[];
  materials: { code: string; description: string; uom: string; gst_rate: number; lpp: number | null; is_service: number }[];
  vendors: { id: number; sap_code: string; name: string; sap_blocked: number }[];
  buyers: { id: number; name: string; email: string }[];
  requisitioners: { id: number; name: string; email: string; department: string | null }[];
  priorities: string[];
}
export const useLookups = () => useQuery<Lookups>({ queryKey: ['sim', 'lookups'], queryFn: () => api.get('/sap/sim/lookups'), staleTime: 60_000 });

/** A panel whose actions are performed in the simulated SAP system. */
export function SimPanel({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      <div className="card__head">
        <div className="row-wrap"><h2>{title}</h2><SimBadge>SAP simulator</SimBadge></div>
        {actions && <div className="row-wrap">{actions}</div>}
      </div>
      <div className="card__body">{children}</div>
    </section>
  );
}

/** Scrolls to and highlights the element a deep link points at. */
export function useFocusScroll(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [active]);
  return ref;
}
export const focusStyle = (on: boolean) => (on ? { outline: '2px solid var(--amber-600)', outlineOffset: 2, borderRadius: 10 } : undefined);

export const today = () => new Date().toISOString().slice(0, 10);
export const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
