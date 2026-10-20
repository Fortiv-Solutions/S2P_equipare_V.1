import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtLakh } from '@/lib/format';
import { Badge, Button, Card, DecisionTag, Empty, Kpi, PageHeader, Ref, Status } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Bars } from '@/components/charts';
import { RenewalActions, UtilBar } from './shared';
import { KIND_LABEL } from './types';

interface Row {
  id: number; contract_no: string; sap_oa_no: string | null; type: string; title: string | null; vendor_name: string; owner_name: string | null; category: string | null;
  valid_to: string; status: string; days_to_expiry: number; lead_days: number; utilisation_pct: number | null; value_cap: number | null; bucket: string;
  decision: { kind: string; status: string; reason: string | null; at: string; after: any } | null; renewal: { id: number; contract_no: string; status: string } | null;
}

export default function RenewalsPage() {
  const { can } = useAuth();
  const q = useQuery<{ rows: Row[]; lead_days: number; later: number }>({ queryKey: ['contracts', 'renewals'], queryFn: () => api.get('/contracts/renewals') });
  const run = useAction(() => api.post<{ message: string }>('/contracts/renewals/run'), { success: (r) => `Expiry check done: ${r.message}`, invalidate: [['contracts']] });
  const rows = q.data?.rows ?? [];
  const order = ['Expired', '0–15 days', '16–30 days', `31–${q.data?.lead_days ?? 45} days`, 'Up to 90 days'];
  const buckets = order.map((b) => ({ label: b, value: rows.filter((r) => r.bucket === b).length }));
  const noDecision = rows.filter((r) => r.status === 'Expiring' && !r.decision).length;
  const columns: Column<Row>[] = [
    { key: 'contract_no', header: 'Contract', nowrap: true, render: (r) => <div><Ref to={`/contracts/${r.id}`}>{r.contract_no}</Ref><div className="small subtle">{r.type}</div></div> },
    { key: 'title', header: 'Title / vendor', render: (r) => <div style={{ minWidth: 200 }}><div style={{ fontWeight: 600 }}>{r.title}</div><div className="small subtle">{r.vendor_name}</div></div> },
    { key: 'days_to_expiry', header: 'Days to expiry', align: 'right', render: (r) => <span className="num" style={{ fontWeight: 700, color: r.days_to_expiry < 0 ? 'var(--bad)' : r.days_to_expiry <= 15 ? 'var(--bad)' : r.days_to_expiry <= r.lead_days ? 'var(--warn)' : undefined }}>{r.days_to_expiry < 0 ? `${-r.days_to_expiry} d ago` : `${r.days_to_expiry} d`}</span> },
    { key: 'valid_to', header: 'Valid to', render: (r) => fmtDate(r.valid_to) },
    { key: 'status', header: 'Status', render: (r) => <Status value={r.status} /> },
    { key: 'utilisation_pct', header: 'Utilisation', render: (r) => <UtilBar pct={r.utilisation_pct} />, value: (r) => r.utilisation_pct ?? -1 },
    { key: 'decision', header: 'Decision', render: (r) => r.renewal ? <span className="small">Renewal <Ref to={`/contracts/${r.renewal.id}`}>{r.renewal.contract_no}</Ref> · {r.renewal.status}</span> : r.decision ? <span className="small"><Badge tone={r.decision.kind === 'let_expire' ? 'neutral' : 'info'}>{KIND_LABEL[r.decision.kind]}</Badge> {r.decision.status}{r.decision.after?.valid_to ? ` → ${fmtDate(r.decision.after.valid_to)}` : ''}</span> : <span className="small" style={{ color: r.status === 'Expiring' ? 'var(--warn)' : undefined, fontWeight: 600 }}>{r.status === 'Expiring' ? 'Decision needed' : '—'}</span>, value: (r) => r.decision?.kind ?? '' },
    { key: 'owner_name', header: 'Owner' },
    { key: 'actions', header: '', sortable: false, exportable: false, render: (r) => can('con.manage') && !r.renewal && (!r.decision || r.decision.kind === 'let_expire') && r.status !== 'Renewed' ? <div className="row-wrap" style={{ justifyContent: 'flex-end' }}><RenewalActions c={r} /></div> : null },
  ];
  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/contracts">Contracts</Link><span>/</span><span>Renewals</span></>} screen="SCR-CON-04" title="Renewal dashboard"
        sub={<>Contracts by days to expiry. The daily job marks contracts Expiring within their lead time ({q.data?.lead_days ?? 45} days by default <DecisionTag id="Q 7.6" />) and notifies the owner and their manager (NTF-13).</>}
        actions={can('con.manage') && <Button variant="deep" icon={<Play />} loading={run.busy} onClick={run.fire}>Run expiry check now</Button>}
      />
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <Kpi label="Expiring within lead time" value={q.data ? rows.filter((r) => r.status === 'Expiring').length : '—'} tone={noDecision ? 'warn' : undefined} meta={`${noDecision} without a decision`} />
        <Kpi label="Next 15 days" value={q.data ? rows.filter((r) => r.days_to_expiry >= 0 && r.days_to_expiry <= 15).length : '—'} tone={rows.some((r) => r.days_to_expiry >= 0 && r.days_to_expiry <= 15) ? 'bad' : undefined} />
        <Kpi label="Expired in last 90 days" value={q.data ? rows.filter((r) => r.days_to_expiry < 0).length : '—'} />
        <Kpi label="Value cap expiring (90 days)" value={q.data ? fmtLakh(rows.filter((r) => r.days_to_expiry >= 0).reduce((s, r) => s + (r.value_cap ?? 0), 0)) : '—'} meta={q.data ? `${q.data.later} contracts beyond 90 days` : undefined} />
      </div>
      <div className="split">
        <Card flush title="Contracts due for a decision">
          <DataTable id="contract-renewals" rows={rows} loading={q.isLoading} error={q.error} refetch={q.refetch} rowKey={(r) => r.id} rowLink={(r) => `/contracts/${r.id}`} columns={columns}
            initialSort={{ key: 'days_to_expiry', dir: 'asc' }}
            filters={[{ key: 'bucket', label: 'Days to expiry', value: (r) => r.bucket, options: order }, { key: 'status', label: 'Status', value: (r) => r.status }, { key: 'type', label: 'Type', value: (r) => r.type }]}
            empty={<Empty title="Nothing expires in the next 90 days">The expiry job runs daily; contracts appear here as they approach their end date.</Empty>}
            mobile={{ title: (r) => <><span className="mono">{r.contract_no}</span> · {r.title}</>, badge: (r) => <Status value={r.status} />, meta: (r) => [r.days_to_expiry < 0 ? `Ended ${-r.days_to_expiry} d ago` : `${r.days_to_expiry} d left`, r.vendor_name, r.decision ? KIND_LABEL[r.decision.kind] : 'No decision'] }}
          />
        </Card>
        <Card title="By days to expiry">
          <Bars title="Contracts by days to expiry" data={buckets} format={(n) => String(n)} />
        </Card>
      </div>
    </>
  );
}
