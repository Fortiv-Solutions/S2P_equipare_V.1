import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Card, ErrorState, LoadingBlock, PageHeader } from '@/components/ui';
import { AiFooter, AskBox, AttentionList, KpiStrip, RiskList, type AiInfo, type Attention, type KpiCard, type RiskItem } from '@/components/insights';

interface Overview { act: Attention[]; actTotal: number; atRisk: RiskItem[]; atRiskTotal: number; kpis: KpiCard[]; ai: AiInfo }

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/** Home for the Administrator: ask, act now, what is at risk. The module screens live in the three workspaces. */
export default function AdminHome() {
  const { me } = useAuth();
  const q = useQuery<Overview>({ queryKey: ['insights', 'overview'], queryFn: () => api.get('/insights/overview'), refetchInterval: 60_000 });
  if (!me) return null;
  return (
    <>
      <PageHeader
        title={`${greeting()}, ${me.name.split(' ')[0]}`}
        eyebrow={<span>{new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</span>}
        sub="Ask a question, deal with what needs you, and catch what is about to go wrong; this is where the follow-up happens."
      />
      <div className="stack">
        {q.isLoading ? (
          <>
            <LoadingBlock rows={3} />
            <AskBox />
            <LoadingBlock rows={6} />
          </>
        ) : q.error ? (
          <>
            <AskBox />
            <ErrorState error={q.error} retry={q.refetch} />
          </>
        ) : q.data ? (
          <>
            <KpiStrip kpis={q.data.kpis} />
            <AskBox />
            <div className="split split--even">
              <Card title={<div className="row-wrap"><h2>Act now</h2><span className="small muted">{q.data.actTotal > q.data.act.length ? `${q.data.act.length} of ${q.data.actTotal}` : q.data.actTotal ? `${q.data.actTotal} item${q.data.actTotal === 1 ? '' : 's'}` : ''}</span></div>}
                actions={<span className="small muted">Most urgent first</span>} flush
                foot={<div className="row-wrap small"><span className="muted">Everything by area:</span><Link to="/sourcing">Sourcing</Link><Link to="/delivery">Delivery</Link><Link to="/finance">Finance</Link></div>}>
                <AttentionList items={q.data.act} />
              </Card>
              <Card title={<div className="row-wrap"><h2>At risk</h2><span className="small muted">{q.data.atRiskTotal > q.data.atRisk.length ? `${q.data.atRisk.length} of ${q.data.atRiskTotal}` : ''}</span></div>}
                actions={<span className="small muted">Rule-based, with reasons</span>}>
                <RiskList items={q.data.atRisk} />
              </Card>
            </div>
            <AiFooter ai={q.data.ai} />
          </>
        ) : null}
      </div>
    </>
  );
}
