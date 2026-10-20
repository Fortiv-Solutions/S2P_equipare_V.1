import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Send } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, fmtLakh } from '@/lib/format';
import { ButtonLink, Card, DecisionTag, Empty, Kpi, PageHeader, Priority, Progress, Ref, Status, Tabs } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Countdown, KindBadge } from './shared';

interface Row {
  id: number; rfq_no: string; title: string; kind: string; status: string; buyer_name: string; category: string | null; plant: string | null; closing_at: string; published_at: string | null;
  created_at: string; parent_no: string | null; priority: string; lines: number; flagged: number; prs: string[]; invited: number; viewed: number; responded: number; declined: number;
  not_responded: number; delivery_failed: number; est_value: number; hours_to_close: number; sealed: number;
}

export default function RfqListPage() {
  const { can, me } = useAuth();
  const [sp, setSp] = useSearchParams();
  const defaultView = me?.role === 'BUY' ? 'mine' : 'all';
  const view = (sp.get('view') as 'mine' | 'all') ?? defaultView;
  const status = sp.get('status') ?? undefined;
  const set = (k: string, v?: string) => { if (v) sp.set(k, v); else sp.delete(k); setSp(sp, { replace: true }); };
  const summary = useQuery<Record<string, number>>({ queryKey: ['rfq', 'summary'], queryFn: () => api.get('/rfq/summary') });
  const list = useQuery<Row[]>({ queryKey: ['rfq', 'list', view], queryFn: () => api.get('/rfq/rfqs', { view }) });
  const rows = useMemo(() => {
    const all = list.data ?? [];
    if (status === 'closing') return all.filter((r) => r.status === 'Published' && r.hours_to_close <= 48);
    if (status === 'flagged') return all.filter((r) => r.flagged > 0);
    return status ? all.filter((r) => r.status === status) : all;
  }, [list.data, status]);

  const columns: Column<Row>[] = [
    { key: 'rfq_no', header: 'RFQ', render: (r) => <Ref to={`/rfqs/${r.id}`}>{r.rfq_no}</Ref>, nowrap: true },
    { key: 'title', header: 'Title', render: (r) => (
      <div style={{ minWidth: 220 }}>
        <div style={{ fontWeight: 600 }}>{r.title}</div>
        <div className="row-wrap small subtle" style={{ gap: 6 }}>
          {r.prs.length ? <span className="mono">PR {r.prs.join(', ')}</span> : null}
          <KindBadge kind={r.kind} />{r.priority !== 'Normal' && <Priority value={r.priority} />}
          {r.parent_no && <span>re-float of <span className="mono">{r.parent_no}</span></span>}
          {r.flagged > 0 && <span style={{ color: 'var(--bad)', fontWeight: 600 }}>{r.flagged} flagged line{r.flagged > 1 ? 's' : ''}</span>}
        </div>
      </div>
    ), value: (r) => `${r.title} ${r.prs.join(' ')}` },
    { key: 'status', header: 'Status', render: (r) => <Status value={r.status} /> },
    { key: 'participation', header: 'Responses', render: (r) => r.invited ? (
      <div style={{ minWidth: 120 }}>
        <div className="small"><strong>{r.responded}</strong> of {r.invited} responded{r.declined ? ` · ${r.declined} declined` : ''}</div>
        <Progress value={r.responded + r.declined} max={r.invited} label="Responses" />
        {r.delivery_failed > 0 && <div className="small" style={{ color: 'var(--bad)' }}>{r.delivery_failed} delivery failed</div>}
      </div>
    ) : <span className="subtle small">No vendors yet</span>, value: (r) => r.responded },
    { key: 'closing_at', header: 'Closing', render: (r) => (r.status === 'Published' ? <div className="small"><Countdown at={r.closing_at} /><div className="subtle">{fmtDateTime(r.closing_at)}</div></div> : <span className="small">{fmtDateTime(r.closing_at)}</span>), value: (r) => r.closing_at, nowrap: true },
    { key: 'lines', header: 'Lines', align: 'right' },
    { key: 'plant', header: 'Plant' },
    { key: 'buyer_name', header: 'Buyer' },
    { key: 'est_value', header: 'Est. value', align: 'right', render: (r) => fmtLakh(r.est_value), hidden: true },
    { key: 'category', header: 'Category', hidden: true },
  ];

  const s = summary.data;
  return (
    <>
      <PageHeader
        title="RFQs" screen="SCR-RFQ-03" eyebrow="Module 2"
        sub={<>Enquiries built from PR lines, their invited vendors and responses. Prices stay sealed until closing <DecisionTag id="Q 18.1" />.</>}
        actions={<>
          <a className="btn btn--secondary" href={downloadUrl('/rfq/rfqs', { view, format: 'csv' })}><Download size={16} /> Export</a>
          {can('rfq.manage') && <ButtonLink to="/pr?view=mine&status=Route+decided" variant="primary" icon={<Send size={16} />}>New RFQ from PR lines</ButtonLink>}
        </>}
      />
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <Kpi label="Open for quotes" value={s?.published ?? '—'} meta={`${s?.closing_48h ?? 0} closing within 48 h`} tone={s?.closing_48h ? 'warn' : undefined} onClick={() => set('status', 'Published')} />
        <Kpi label="Closed, ready to compare" value={s?.closed ?? '—'} meta="Quotations locked" onClick={() => set('status', 'Closed')} />
        <Kpi label="Waiting for approval" value={s?.pending_approval ?? '—'} meta="Limited-source / vendor exceptions" onClick={() => set('status', 'Pending approval')} />
        <Kpi label="Drafts" value={s?.draft ?? '—'} meta={s?.flagged ? `${s.flagged} RFQ with flagged lines` : 'Not yet published'} tone={s?.flagged ? 'bad' : undefined} onClick={() => set('status', s?.flagged ? 'flagged' : 'Draft')} />
      </div>
      <Tabs<'mine' | 'all'> value={view} onChange={(v) => set('view', v)} tabs={[...(can('rfq.manage') ? [{ id: 'mine' as const, label: 'My RFQs' }] : []), { id: 'all', label: 'All RFQs' }]} />
      <Card flush>
        {status && (
          <div className="row-wrap small" style={{ padding: '10px 14px 0' }}>
            Showing <strong>{status === 'closing' ? 'closing within 48 h' : status === 'flagged' ? 'RFQs with flagged lines' : status}</strong>
            <button className="btn btn--ghost btn--sm" onClick={() => set('status')}>Show all</button>
          </div>
        )}
        <DataTable
          id="rfq-list" rows={rows} loading={list.isLoading} error={list.error} refetch={list.refetch} rowKey={(r) => r.id} rowLink={(r) => `/rfqs/${r.id}`} columns={columns}
          filters={[{ key: 'plant', label: 'Plant', value: (r) => r.plant }, { key: 'buyer', label: 'Buyer', value: (r) => r.buyer_name }, { key: 'kind', label: 'Type', value: (r) => (r.kind === 'ARC' ? 'Annual rate' : 'Spot') }]}
          searchPlaceholder="Search RFQ, title, PR…"
          empty={<Empty title="No RFQs in this view">{can('rfq.manage') ? 'Select lines with route decided in the PR workbench and choose "Create RFQ".' : 'RFQs appear here when buyers create them.'}</Empty>}
          mobile={{ title: (r) => <><span className="mono">{r.rfq_no}</span> · {r.title}</>, badge: (r) => <Status value={r.status} />, meta: (r) => [`${r.responded}/${r.invited} responded`, r.status === 'Published' ? <Countdown key="c" at={r.closing_at} /> : fmtDateTime(r.closing_at), r.plant ?? '', r.buyer_name] }}
        />
      </Card>
    </>
  );
}
