import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Play, Scale } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { Button, ButtonLink, Callout, Card, KV, Loader, PageHeader, Status } from '@/components/ui';

interface Elig {
  rfq: { id: number; rfq_no: string; title: string | null; status: string; closing_at: string | null };
  ok: boolean; reason: string | null; locked: number; invited: number; all_responded: boolean;
  latest: { id: number; cmp_no: string; version: number; status: string } | null; quotes_changed: boolean;
}

/** /comparisons/rfq/:rfqId — opens the RFQ's comparison, or offers to generate it. */
export default function RfqComparisonPage() {
  const rfqId = Number(useParams().rfqId);
  const navigate = useNavigate();
  const { can } = useAuth();
  const q = useQuery<Elig>({ queryKey: ['cmp', 'rfq', rfqId], queryFn: () => api.get(`/cmp/rfq/${rfqId}`) });
  const gen = useAction(() => api.post<{ id: number; ref: string; created: boolean }>(`/cmp/rfq/${rfqId}/generate`), {
    success: (r) => (r.created ? `Comparison ${r.ref} generated` : `Opened ${r.ref}`), invalidate: [['cmp']], onSuccess: (r) => navigate(`/comparisons/${r.id}`, { replace: true }),
  });
  useEffect(() => {
    if (q.data?.latest && !q.data.quotes_changed) navigate(`/comparisons/${q.data.latest.id}`, { replace: true });
  }, [q.data, navigate]);
  return (
    <Loader q={q}>{(e) => (
      <>
        <PageHeader eyebrow={<><Link to="/comparisons">Comparisons</Link><span>/</span><span className="mono">{e.rfq.rfq_no}</span></>} screen="SCR-CMP-01"
          title={`Comparison for ${e.rfq.rfq_no}`} sub={e.rfq.title ?? undefined} badges={<Status value={e.rfq.status} />} />
        <Card title="Comparative statement">
          <div className="stack">
            <KV items={[['RFQ', <Link className="mono" to={`/rfqs/${e.rfq.id}`}>{e.rfq.rfq_no}</Link>], ['Closing', fmtDateTime(e.rfq.closing_at)], ['Invited vendors', e.invited], ['Locked / final quotations', e.locked], ['Every vendor responded', e.all_responded ? 'Yes' : 'No']]} />
            {e.latest && e.quotes_changed && <Callout tone="warn" title="Quotations changed after the last comparison">{`${e.latest.cmp_no} v${e.latest.version} was generated before the RFQ was reopened. Generate a new version to compare the revised quotations.`}</Callout>}
            {!e.ok ? <Callout tone="warn" title="Not ready for comparison">{e.reason}</Callout> : !e.latest && <Callout tone="info" icon={<Scale size={18} />} title="No comparison yet">Generate the comparative statement from the locked quotations. The RFQ moves to Under comparison.</Callout>}
            <div className="row-wrap">
              {can('cmp.manage') && e.ok && <Button variant="primary" icon={<Play />} loading={gen.busy} onClick={gen.fire}>{e.latest ? 'Generate new version' : 'Generate comparison'}</Button>}
              {e.latest && <ButtonLink to={`/comparisons/${e.latest.id}`}>Open {e.latest.cmp_no} v{e.latest.version}</ButtonLink>}
              <ButtonLink to={`/rfqs/${e.rfq.id}`} variant="ghost">Back to RFQ</ButtonLink>
            </div>
          </div>
        </Card>
      </>
    )}</Loader>
  );
}
