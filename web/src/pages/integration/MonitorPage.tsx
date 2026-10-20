import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Play, RefreshCw, ArrowRightLeft, ArrowRight, ListRestart } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { ago, fmtDateTime } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, DecisionTag, Kpi, Loader, PageHeader, SimBadge, Status } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { IntegrationNav } from './shared';

interface FlowCard {
  id: string; name: string; direction: string; trigger: string; mechanism: string; release: string; doc_types: string[]; inbound: boolean; outbound: boolean;
  write: { label: string; enabled: boolean; decision: string | null };
  last_run: string | null; last_success: string | null; last_status: string | null; last_message: string | null; success_24h: number; failure_24h: number;
  writes: { written: number; queued: number; failed: number } | null; queue_depth: number; business_errors: number; retrying: number; next_retry_at: string | null;
  freshness: { age_minutes: number | null; threshold_minutes: number; stale: boolean } | null;
}
interface Overview { generated_at: string; flows: FlowCard[]; alerts: { tone: 'bad' | 'warn' | 'info'; title: string; body: string; link?: string }[]; settings: { offline: boolean } }
interface Job { id: number; flow: string; direction: string; trigger: string; started_at: string; finished_at: string | null; status: string; read_count: number; upserted: number; error_count: number; message: string }

const DirIcon = ({ d }: { d: string }) => (d === 'SAP ↔ S2P' ? <ArrowRightLeft size={14} aria-hidden /> : <ArrowRight size={14} aria-hidden />);

export default function MonitorPage() {
  const { can } = useAuth();
  const q = useQuery<Overview>({ queryKey: ['integration', 'flows'], queryFn: () => api.get('/sap/flows'), refetchInterval: 30_000 });
  const jobs = useQuery<Job[]>({ queryKey: ['integration', 'jobs'], queryFn: () => api.get('/sap/jobs', { limit: 120 }), refetchInterval: 30_000 });
  const recon = useQuery<{ latest: { diff_count: number; ran_at: string } | null }>({ queryKey: ['integration', 'recon'], queryFn: () => api.get('/sap/reconcile') });
  const inv = [['integration'], ['meta'], ['nav-counts']];
  const runAll = useAction(() => api.post<{ status: string; message: string }>('/jobs/sap.inbound/run'), { success: (r) => `Inbound sync ran: ${r.status}`, invalidate: inv });
  const queue = useAction(() => api.post<{ message: string }>('/sap/queue/process', {}), { success: (r) => r.message, invalidate: inv });

  return (
    <>
      <PageHeader
        title="SAP integration monitor" screen="SCR-SAP-01" eyebrow="Module 12"
        sub="Every interface between the platform and SAP: direction, trigger, last run, failures, queue depth and data freshness. SAP is simulated in this MVP."
        badges={<SimBadge title="No live SAP system is connected (DEC-17). The SAP simulator stands in for SAP.">Simulated SAP</SimBadge>}
        actions={can('sap.replay') ? (
          <>
            <Button icon={<ListRestart />} loading={queue.busy} onClick={queue.fire}>Process write queue</Button>
            <Button variant="deep" icon={<RefreshCw />} loading={runAll.busy} onClick={runAll.fire}>Run all inbound now</Button>
          </>
        ) : undefined}
      />
      <Loader q={q} rows={8}>{(d) => <Body d={d} jobs={jobs} reconDiffs={recon.data?.latest?.diff_count ?? null} />}</Loader>
    </>
  );
}

function Body({ d, jobs, reconDiffs }: { d: Overview; jobs: { data?: Job[]; isLoading: boolean; error: unknown; refetch: () => unknown }; reconDiffs: number | null }) {
  const stale = d.flows.filter((f) => f.freshness?.stale).length;
  const depth = d.flows.reduce((s, f) => s + f.queue_depth, 0);
  const business = d.flows.reduce((s, f) => s + f.business_errors, 0);
  const jobCols: Column<Job>[] = useMemo(() => [
    { key: 'started_at', header: 'Started', render: (r) => fmtDateTime(r.started_at), nowrap: true },
    { key: 'flow', header: 'Flow', render: (r) => <span className="mono">{r.flow}</span> },
    { key: 'trigger', header: 'Trigger' },
    { key: 'status', header: 'Status', render: (r) => <Status value={r.status} /> },
    { key: 'read_count', header: 'Read', align: 'right' },
    { key: 'upserted', header: 'Upserted', align: 'right' },
    { key: 'error_count', header: 'Errors', align: 'right', render: (r) => <span style={{ color: r.error_count ? 'var(--bad)' : undefined, fontWeight: r.error_count ? 700 : 400 }}>{r.error_count}</span>, value: (r) => r.error_count },
    { key: 'message', header: 'Message', render: (r) => <span className="small">{r.message}</span> },
  ], []);
  return (
    <>
      <IntegrationNav counts={{ errors: depth }} />
      <div className="grid-4" style={{ margin: '16px 0 20px' }}>
        <Kpi label="Flows beyond freshness" value={stale} tone={stale ? 'warn' : 'ok'} meta={`of ${d.flows.filter((f) => f.inbound).length} inbound flows`} to="/integration/runbook" />
        <Kpi label="Queue depth" value={depth} tone={depth ? 'warn' : 'ok'} meta="Open errors and queued writes" to="/integration/errors?status=open" />
        <Kpi label="Business errors" value={business} tone={business ? 'bad' : 'ok'} meta="Not retried — need SAP/IT" to="/integration/errors?status=Failed" />
        <Kpi label="Reconciliation differences" value={reconDiffs ?? '—'} tone={reconDiffs ? 'warn' : 'ok'} meta="Latest run" to="/integration/reconciliation" />
      </div>

      {d.alerts.length > 0 && (
        <Card title="Alerts" className="no-print">
          <div className="stack-sm">
            {d.alerts.map((a, i) => (
              <Callout key={i} tone={a.tone} title={a.title}>{a.body} {a.link && <Link to={a.link}>Open</Link>}</Callout>
            ))}
          </div>
        </Card>
      )}
      <div style={{ height: 16 }} />
      <div className="grid-3">
        {d.flows.map((f) => <FlowTile key={f.id} f={f} />)}
      </div>
      <div style={{ height: 20 }} />
      <Card title="Recent job runs" flush>
        <DataTable id="sap-jobs" rows={jobs.data} loading={jobs.isLoading} error={jobs.error} refetch={() => jobs.refetch()} rowKey={(r) => r.id} columns={jobCols} dense
          filters={[{ key: 'flow', label: 'Flow', value: (r) => r.flow }, { key: 'status', label: 'Status', value: (r) => r.status }, { key: 'trigger', label: 'Trigger', value: (r) => r.trigger }]}
          empty={<div className="empty"><div className="empty__title">No sync runs yet</div><div>Scheduled inbound syncs run every few minutes.</div></div>}
          mobile={{ title: (r) => <><span className="mono">{r.flow}</span> · {r.trigger}</>, badge: (r) => <Status value={r.status} />, meta: (r) => [fmtDateTime(r.started_at), `${r.upserted} upserted`, `${r.error_count} errors`] }} />
      </Card>
    </>
  );
}

function FlowTile({ f }: { f: FlowCard }) {
  const { can } = useAuth();
  const run = useAction(() => api.post<{ message: string; ok: boolean }>(`/sap/flows/${f.id}/run`), { success: (r) => r.message, invalidate: [['integration'], ['meta'], ['nav-counts']] });
  const tone = f.business_errors ? 'bad' : f.freshness?.stale || f.queue_depth ? 'warn' : undefined;
  return (
    <section className="card" style={{ borderTop: `3px solid ${tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--warn)' : 'var(--primary-600)'}` }}>
      <div className="card__head">
        <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
          <span className="mono small subtle">{f.id} · {f.release}</span>
          <h2 style={{ fontSize: 16 }}>{f.name}</h2>
        </div>
        <Badge tone="deep"><DirIcon d={f.direction} /> {f.direction}</Badge>
      </div>
      <div className="card__body stack-sm">
        <div className="small muted">{f.trigger} · {f.mechanism.replace(' (simulated)', '')} <SimBadge>simulated SAP</SimBadge></div>
        <div className="row-wrap small"><span>{f.write.label}</span><DecisionTag id={f.write.decision} /></div>
        <dl className="kv" style={{ marginTop: 4 }}>
          <dt>Last run</dt><dd>{f.last_run ? <span title={fmtDateTime(f.last_run)}>{ago(f.last_run)}</span> : 'Never'} {f.last_status && <Status value={f.last_status} />}</dd>
          <dt>Last success</dt><dd>{f.last_success ? <span title={fmtDateTime(f.last_success)}>{ago(f.last_success)}</span> : '—'}</dd>
          <dt>Last 24 h</dt><dd><span style={{ color: 'var(--ok)', fontWeight: 600 }}>{f.success_24h} ok</span> · <span style={{ color: f.failure_24h ? 'var(--bad)' : undefined, fontWeight: 600 }}>{f.failure_24h} failed</span></dd>
          {f.writes && <><dt>Writes</dt><dd>{f.writes.written} written · {f.writes.queued} queued · {f.writes.failed} failed</dd></>}
          <dt>Queue depth</dt><dd>{f.queue_depth ? <Link to={`/integration/errors?status=open&flow=${f.id}`}>{f.queue_depth} open{f.business_errors ? ` (${f.business_errors} business)` : ''}</Link> : '0'}{f.next_retry_at && <span className="small muted"> · next retry {ago(f.next_retry_at)}</span>}</dd>
          <dt>Freshness</dt>
          <dd>{f.freshness ? (
            <span className={f.freshness.stale ? 'stale' : 'fresh'}>{f.freshness.age_minutes != null ? `${f.freshness.age_minutes} min` : 'never'} / {f.freshness.threshold_minutes} min {f.freshness.stale ? '— stale' : ''}</span>
          ) : <span className="subtle">Not applicable (outbound)</span>}<DecisionTag id={f.freshness ? 'DEC-23' : null} /></dd>
        </dl>
      </div>
      {can('sap.replay') && (
        <div className="card__foot row between">
          <ButtonLink to={`/integration/runbook#${f.id}`} size="sm" variant="ghost">Runbook</ButtonLink>
          <Button size="sm" variant={f.inbound ? 'deep' : 'secondary'} icon={f.inbound ? <Play /> : <ListRestart />} loading={run.busy} onClick={run.fire}>{f.inbound ? 'Run now' : 'Process queue'}</Button>
        </div>
      )}
    </section>
  );
}

