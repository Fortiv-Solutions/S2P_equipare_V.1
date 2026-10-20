import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Scale, Play } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtLakh } from '@/lib/format';
import { Badge, Button, Card, Kpi, PageHeader, Ref, Status, Empty } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';

interface Item {
  id: number; cmp_no: string; ref: string; version: number; status: string; rfq_id: number; rfq_no: string; rfq_title: string | null; rfq_status: string;
  buyer_name: string | null; plant: string | null; category: string | null; created_by_name: string | null; created_at: string; submitted_at: string | null;
  lines: number; vendors: number; coverage: string; lowest_total: number | null; awarded_total: number | null; deviation: boolean; approval_status: string | null; approval_req_no: string | null; age_days: number;
}
interface Ready { id: number; rfq_no: string; title: string | null; status: string; closing_at: string | null; closed_at: string | null; buyer_name: string | null; plant: string | null; invited: number; locked: number; declined: number; responded: number; ready: boolean }

export default function ComparisonsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useQuery<Item[]>({ queryKey: ['cmp', 'list'], queryFn: () => api.get('/cmp') });
  const ready = useQuery<Ready[]>({ queryKey: ['cmp', 'ready'], queryFn: () => api.get('/cmp/ready-rfqs') });
  const gen = useAction((rfqId: number) => api.post<{ id: number; ref: string; created: boolean }>(`/cmp/rfq/${rfqId}/generate`), {
    success: (r) => (r.created ? `Comparison ${r.ref} generated` : `Opened ${r.ref}`), invalidate: [['cmp']], onSuccess: (r) => navigate(`/comparisons/${r.id}`),
  });
  const rows = list.data ?? [];
  const count = (s: string[]) => rows.filter((r) => s.includes(r.status)).length;

  const columns: Column<Item>[] = useMemo(() => [
    { key: 'ref', header: 'Comparison', render: (r) => <Ref to={`/comparisons/${r.id}`}>{r.ref}</Ref>, nowrap: true },
    { key: 'rfq_no', header: 'RFQ', render: (r) => <div style={{ minWidth: 200 }}><Ref to={`/rfqs/${r.rfq_id}`}>{r.rfq_no}</Ref><div className="small muted">{r.rfq_title}</div></div>, value: (r) => `${r.rfq_no} ${r.rfq_title ?? ''}` },
    { key: 'status', header: 'Status', render: (r) => <div className="row-wrap" style={{ gap: 4 }}><Status value={r.status} />{r.deviation && <Badge tone="decision">Deviation</Badge>}</div> },
    { key: 'lines', header: 'Lines', align: 'right' },
    { key: 'coverage', header: 'Responded', align: 'right', render: (r) => <span className="num">{r.coverage}</span> },
    { key: 'lowest_total', header: 'Lowest landed', align: 'right', render: (r) => fmtLakh(r.lowest_total) },
    { key: 'awarded_total', header: 'Recommended', align: 'right', render: (r) => fmtLakh(r.awarded_total) },
    { key: 'approval_status', header: 'Approval', render: (r) => (r.approval_req_no ? <span className="small"><span className="mono">{r.approval_req_no}</span> · {r.approval_status}</span> : <span className="subtle">—</span>) },
    { key: 'buyer_name', header: 'Buyer' },
    { key: 'plant', header: 'Plant', hidden: true },
    { key: 'created_at', header: 'Generated', render: (r) => fmtDate(r.created_at), nowrap: true },
    { key: 'age_days', header: 'Age', align: 'right', render: (r) => `${r.age_days} d` },
  ], []);

  return (
    <>
      <PageHeader title="Comparative statements" screen="SCR-CMP-01" eyebrow="Module 4"
        sub="Line-wise landed-cost comparison of locked quotations, award recommendation and approval for each closed RFQ." />
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <Kpi label="Ready to compare" value={ready.data?.filter((r) => r.ready).length ?? '—'} meta="Closed RFQs without a comparison" onClick={() => document.getElementById('ready')?.scrollIntoView({ behavior: 'smooth' })} />
        <Kpi label="Draft / to recommend" value={list.data ? count(['Draft', 'Recommendation recorded', 'Returned']) : '—'} tone={count(['Returned']) ? 'warn' : undefined} meta={count(['Returned']) ? `${count(['Returned'])} returned` : 'With buyers'} />
        <Kpi label="Waiting for approval" value={list.data ? count(['Submitted for approval']) : '—'} />
        <Kpi label="Approved, not released" value={list.data ? count(['Approved']) : '—'} tone={count(['Approved']) ? 'warn' : undefined} meta="Release so the PO can be created in SAP" />
      </div>

      <Card title="Closed RFQs ready for comparison" id="ready" flush>
        {ready.isLoading ? null : !ready.data?.length ? (
          <Empty title="No RFQs waiting for a comparison" icon={<Scale size={24} />}>A closed RFQ appears here until its comparative statement is generated.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>RFQ</th><th>Status</th><th className="num">Invited</th><th className="num">Locked quotes</th><th className="num">Declined</th><th>Closed</th><th>Buyer</th><th /></tr></thead>
              <tbody>
                {ready.data.map((r) => (
                  <tr key={r.id}>
                    <td><Ref to={`/rfqs/${r.id}`}>{r.rfq_no}</Ref><div className="small muted">{r.title}</div></td>
                    <td><Status value={r.status} /></td>
                    <td className="num">{r.invited}</td><td className="num">{r.locked}</td><td className="num">{r.declined}</td>
                    <td className="nowrap">{fmtDateTime(r.closed_at ?? r.closing_at)}</td>
                    <td>{r.buyer_name ?? '—'}</td>
                    <td className="right">
                      {can('cmp.manage') ? (
                        <Button size="sm" variant="primary" icon={<Play />} disabled={!r.ready} title={r.ready ? undefined : 'No locked quotations yet'} loading={gen.busy} onClick={() => gen.fire(r.id)}>Generate comparison</Button>
                      ) : <span className="small muted">Buyer generates</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div style={{ height: 16 }} />
      <Card flush>
        <DataTable
          id="cmp-list" rows={list.data} loading={list.isLoading} error={list.error} refetch={list.refetch} rowKey={(r) => r.id} rowLink={(r) => `/comparisons/${r.id}`}
          columns={columns} initialSort={{ key: 'created_at', dir: 'desc' }}
          filters={[{ key: 'status', label: 'Status', value: (r) => r.status }, { key: 'buyer', label: 'Buyer', value: (r) => r.buyer_name }, { key: 'plant', label: 'Plant', value: (r) => r.plant }]}
          searchPlaceholder="Search comparison, RFQ, title…"
          empty={<Empty title="No comparisons yet">Generate one from a closed RFQ above.</Empty>}
          mobile={{ title: (r) => <><span className="mono">{r.ref}</span> · {r.rfq_no}</>, badge: (r) => <Status value={r.status} />, meta: (r) => [r.rfq_title ?? '', `${r.lines} lines`, `Responded ${r.coverage}`, `Recommended ${fmtLakh(r.awarded_total)}`] }}
        />
      </Card>
    </>
  );
}
