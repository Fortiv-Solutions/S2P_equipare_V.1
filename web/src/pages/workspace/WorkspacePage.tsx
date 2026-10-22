import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { WORKSPACES } from '@/nav';
import { Card, ErrorState, Kpi, LoadingBlock, PageHeader } from '@/components/ui';
import { AiFooter, AttentionList, KpiStrip, Pipeline, RiskList, type AiInfo, type Attention, type KpiCard, type RiskItem, type Stage } from '@/components/insights';

interface Data {
  key: string; stages: Stage[]; side: { label: string; value: number | string; link: string; tone?: 'ok' | 'warn' | 'bad' }[];
  attention: Attention[]; risks: RiskItem[]; kpis: KpiCard[]; ai: AiInfo;
}

/** Overview of one workspace: where the work sits in the pipeline, what needs a person, what is at risk. */
export default function WorkspacePage({ wkey }: { wkey: 'sourcing' | 'delivery' | 'finance' }) {
  const { me } = useAuth();
  const w = WORKSPACES.find((x) => x.key === wkey)!;
  const q = useQuery<Data>({ queryKey: ['insights', 'workspace', wkey], queryFn: () => api.get(`/insights/workspace/${wkey}`), enabled: !!me?.merged, refetchInterval: 60_000 });
  if (me && !me.merged) return <Navigate to="/" replace />;
  return (
    <>
      <PageHeader title={w.label} eyebrow={<span>Workspace</span>} sub={w.blurb} />
      {q.isLoading ? <LoadingBlock rows={8} /> : q.error ? <ErrorState error={q.error} retry={q.refetch} /> : q.data && (
        <div className="stack">
          <KpiStrip kpis={q.data.kpis} />
          <Card title="Where the work sits"><Pipeline stages={q.data.stages} /></Card>
          <div className="grid-3">
            {q.data.side.map((s) => <Kpi key={s.label} label={s.label} value={s.value} tone={s.tone && Number(s.value) ? s.tone : undefined} to={s.link} />)}
          </div>
          <div className="split split--even">
            <Card title={<div className="row-wrap"><h2>Needs you</h2><span className="small muted">{q.data.attention.length ? `${q.data.attention.length} item${q.data.attention.length === 1 ? '' : 's'}` : ''}</span></div>} flush>
              <AttentionList items={q.data.attention} empty={`Nothing in ${w.label.toLowerCase()} needs a decision from you right now.`} />
            </Card>
            <Card title={<div className="row-wrap"><h2>At risk</h2><span className="small muted">from the rules, not a prediction model</span></div>}>
              <RiskList items={q.data.risks} empty={`Nothing in ${w.label.toLowerCase()} looks at risk.`} />
            </Card>
          </div>
          <AiFooter ai={q.data.ai} />
        </div>
      )}
    </>
  );
}
