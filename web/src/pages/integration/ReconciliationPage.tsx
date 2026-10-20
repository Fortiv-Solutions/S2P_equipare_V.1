import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, GitCompareArrows } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDateTime, fmtNum } from '@/lib/format';
import { Badge, Button, Callout, Card, Loader, PageHeader, SimBadge } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { IntegrationNav } from './shared';

interface Diff { object: string; key: string; issue: string; action: { flow: string; doc_type: string; key: string } | null; link: string | null }
interface Run { id: number; ran_at: string; trigger: string; ran_by: string | null; diff_count: number; counts: { object: string; sap: number; platform: number; sapTotal?: number; platformTotal?: number }[]; diffs: Diff[] }
interface Data { latest: Run | null; history: { id: number; ran_at: string; trigger: string; diff_count: number }[] }

export default function ReconciliationPage() {
  const { can } = useAuth();
  const q = useQuery<Data>({ queryKey: ['integration', 'recon'], queryFn: () => api.get('/sap/reconcile') });
  const run = useAction(() => api.post<Run>('/sap/reconcile'), { success: (r) => `Reconciliation complete: ${r.diff_count} difference${r.diff_count === 1 ? '' : 's'}`, invalidate: [['integration']] });
  return (
    <>
      <PageHeader title="SAP reconciliation" screen="SCR-SAP-03" eyebrow="Module 12"
        sub="Counts and totals per object in SAP against the platform, with every difference listed and a re-sync button. Also runs daily."
        badges={<SimBadge>Simulated SAP</SimBadge>}
        actions={can('sap.replay') ? <Button variant="deep" icon={<GitCompareArrows />} loading={run.busy} onClick={run.fire}>Run reconciliation now</Button> : undefined} />
      <IntegrationNav />
      <div style={{ height: 16 }} />
      <Loader q={q} rows={6}>{(d) => d.latest ? <Result r={d.latest} /> : (
        <Card><Callout tone="info" title="No reconciliation has run yet">{can('sap.replay') ? 'Run it now to compare SAP and the platform.' : 'SAP/IT runs reconciliation.'}</Callout></Card>
      )}</Loader>
    </>
  );
}

function Result({ r }: { r: Run }) {
  const { can } = useAuth();
  const resync = useAction((d: Diff) => api.post<{ ok: boolean; message: string }>('/sap/resync', { flow: d.action!.flow, mode: 'document', doc_type: d.action!.doc_type, key: d.action!.key, reason: `Re-sync from reconciliation: ${d.object} ${d.key}` }), {
    success: (x) => x.message, invalidate: [['integration'], ['nav-counts']],
  });
  const rerun = useAction(() => api.post('/sap/reconcile'), { invalidate: [['integration']] });
  const cols: Column<Diff>[] = useMemo(() => [
    { key: 'object', header: 'Object', render: (d) => <Badge tone="deep">{d.object}</Badge> },
    { key: 'key', header: 'Key', render: (d) => (d.link ? <Link to={d.link} className="mono">{d.key}</Link> : <span className="mono">{d.key}</span>) },
    { key: 'issue', header: 'Difference', render: (d) => <span style={{ fontWeight: 600 }}>{d.issue}</span> },
    { key: 'act', header: '', sortable: false, exportable: false, render: (d) => d.action && can('sap.replay')
      ? <Button size="sm" variant="deep" icon={<RefreshCw />} loading={resync.busy} onClick={async () => { await resync.fire(d); await rerun.fire(); }}>Re-sync {d.action.doc_type} {d.action.key}</Button>
      : d.action ? <span className="small muted">SAP/IT can re-sync</span> : <span className="small muted">Platform-only record: review in the platform</span> },
  ], [can, resync, rerun]);
  return (
    <div className="stack">
      <Card title={<div className="row-wrap"><h2>Counts and totals</h2><span className="small muted">Run {fmtDateTime(r.ran_at)} · {r.trigger}{r.ran_by ? ` · ${r.ran_by}` : ''}</span></div>} flush>
        <div className="tbl-wrap"><table className="tbl tbl--dense">
          <thead><tr><th>Object</th><th className="num">SAP</th><th className="num">Platform</th><th className="num">Difference</th><th className="num">SAP total qty</th><th className="num">Platform total qty</th></tr></thead>
          <tbody>{r.counts.map((c) => {
            const dc = c.sap - c.platform; const dt = c.sapTotal != null ? c.sapTotal - (c.platformTotal ?? 0) : null;
            return (
              <tr key={c.object}><td>{c.object}</td><td className="num">{fmtNum(c.sap)}</td><td className="num">{fmtNum(c.platform)}</td>
                <td className="num" style={{ color: dc ? 'var(--bad)' : undefined, fontWeight: dc ? 700 : 400 }}>{dc}</td>
                <td className="num">{fmtNum(c.sapTotal)}</td><td className="num">{fmtNum(c.platformTotal)}{dt ? <span style={{ color: 'var(--bad)', fontWeight: 700 }}> ({dt > 0 ? '+' : ''}{dt})</span> : null}</td></tr>
            );
          })}</tbody>
        </table></div>
      </Card>
      <Card title={`Differences (${r.diffs.length})`} flush>
        <DataTable id="sap-recon" rows={r.diffs} rowKey={(d) => `${d.object}:${d.key}`} columns={cols} searchable={false} savedViews={false}
          empty={<div className="empty"><div className="empty__title">SAP and the platform agree</div><div>No missing, extra or mismatching records in the compared objects.</div></div>}
          mobile={{ title: (d) => <>{d.object} <span className="mono">{d.key}</span></>, meta: (d) => [d.issue] }} />
      </Card>
    </div>
  );
}
