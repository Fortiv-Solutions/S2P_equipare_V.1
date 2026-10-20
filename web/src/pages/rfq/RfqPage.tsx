import { lazy } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Loader } from '@/components/ui';
import type { RfqDetail } from './shared';

const RfqBuilder = lazy(() => import('./RfqBuilder'));
const RfqDetailView = lazy(() => import('./RfqDetailView'));

/** /rfqs/:id — a Draft opens in the builder (SCR-RFQ-01); anything else in detail & participation (SCR-RFQ-02). */
export default function RfqPage() {
  const id = Number(useParams().id);
  const { can } = useAuth();
  const q = useQuery<RfqDetail>({ queryKey: ['rfq', 'detail', id], queryFn: () => api.get(`/rfq/rfqs/${id}`), refetchInterval: 60_000 });
  return <Loader q={q} rows={10}>{(r) => (r.status === 'Draft' && can('rfq.manage') ? <RfqBuilder r={r} /> : <RfqDetailView r={r} />)}</Loader>;
}
