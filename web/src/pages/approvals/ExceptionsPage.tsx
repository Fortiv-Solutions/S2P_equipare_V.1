import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, Download } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtLakh } from '@/lib/format';
import { Badge, Button, Card, Kpi, PageHeader, Ref, Status, SectionTitle } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Field, Input } from '@/components/forms';
import { ReasonDialog } from '@/components/overlay';

interface Row {
  id: number; req_no: string; type: string; type_label: string; title: string; summary: string | null; reason: string | null; value: number | null; requester_name: string | null;
  created_at: string; status: string; outcome: string; outcome_comment: string | null; decided_at: string | null; approvers: string | null;
  linked_label: string; linked_ref: string | null; linked_link: string | null; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null;
}
interface Data { rows: Row[]; review: { type: string; label: string; total: number; approved: number; rejected: number; open: number; other: number; value: number }[]; total: number; reviewed: number }

const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function ExceptionsPage() {
  const { can } = useAuth();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState<string | undefined>();
  const [review, setReview] = useState<Row | null>(null);
  const q = useQuery<Data>({ queryKey: ['approvals', 'exceptions', from, to, type], queryFn: () => api.get('/approvals/exceptions', { from, to, type }) });
  const act = useAction((note: string) => api.post(`/approvals/exceptions/${review!.id}/review`, { note }), { success: 'Review recorded', invalidate: [['approvals', 'exceptions']] });
  const preset = (days: number | 'fy') => {
    const t = new Date();
    setTo(iso(t));
    setFrom(days === 'fy' ? `${t.getUTCMonth() >= 3 ? t.getUTCFullYear() : t.getUTCFullYear() - 1}-04-01` : iso(new Date(Date.now() - days * 86400000)));
  };
  const csvHref = downloadUrl('/approvals/exceptions', { format: 'csv', from, to, type });

  const columns: Column<Row>[] = useMemo(() => [
    { key: 'req_no', header: 'Request', render: (r) => <Ref to={`/approvals/${r.id}`}>{r.req_no}</Ref>, nowrap: true },
    { key: 'type_label', header: 'Exception type', render: (r) => <Badge tone="decision">{r.type_label}</Badge>, value: (r) => r.type_label },
    { key: 'reason', header: 'Reason', render: (r) => <div style={{ minWidth: 240, whiteSpace: 'normal' }}><div>{r.reason ?? <span className="subtle">No reason recorded</span>}</div><div className="small muted">{r.title}</div></div>, value: (r) => `${r.reason ?? ''} ${r.title}` },
    { key: 'value', header: 'Value', align: 'right', render: (r) => (r.value != null ? fmtLakh(r.value) : '—') },
    { key: 'requester_name', header: 'Raised by' },
    { key: 'approvers', header: 'Approver', render: (r) => r.approvers ?? <span className="subtle">Pending</span>, value: (r) => r.approvers },
    { key: 'outcome', header: 'Outcome', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Status value={r.outcome} />{r.outcome_comment && <span className="small muted">{r.outcome_comment}</span>}</div> },
    { key: 'created_at', header: 'Raised', render: (r) => fmtDate(r.created_at), nowrap: true },
    { key: 'linked', header: 'Record', render: (r) => (r.linked_link ? <Ref to={r.linked_link}>{r.linked_ref ?? r.linked_label}</Ref> : '—'), value: (r) => r.linked_ref },
    { key: 'reviewed', header: 'Periodic review', render: (r) => r.reviewed_by ? <span className="small"><Badge tone="ok">Reviewed</Badge> {r.reviewed_by}, {fmtDate(r.reviewed_at)}</span> : can('exc.view') && r.outcome !== 'Open' ? <Button size="sm" variant="ghost" icon={<ClipboardCheck />} onClick={() => setReview(r)}>Mark reviewed</Button> : <span className="subtle">—</span>, value: (r) => r.reviewed_by },
  ], [can]);

  const d = q.data;
  return (
    <>
      <PageHeader title="Exception register" screen="SCR-APR-03" eyebrow="Module 5"
        sub="Every exception with its type, reason, approver and outcome — single source, urgent, PO after receipt, off-contract, price amendment, deviation from lowest cost."
        actions={<a className="btn btn--secondary" href={csvHref}><Download size={16} /> Export CSV</a>} />
      <Card>
        <div className="row-wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="From"><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></Field>
          <div className="row-wrap">
            <Button size="sm" onClick={() => preset(30)}>Last 30 days</Button><Button size="sm" onClick={() => preset(90)}>Last quarter</Button><Button size="sm" onClick={() => preset('fy')}>This financial year</Button>
            {(from || to || type) && <Button size="sm" variant="ghost" onClick={() => { setFrom(''); setTo(''); setType(undefined); }}>Clear period</Button>}
          </div>
        </div>
      </Card>
      <div style={{ height: 16 }} />
      <div className="grid-4" style={{ marginBottom: 16 }}>
        <Kpi label="Exceptions in period" value={d?.total ?? '—'} />
        <Kpi label="Still open" value={d?.review.reduce((t, r) => t + r.open, 0) ?? '—'} tone={d?.review.some((r) => r.open) ? 'warn' : undefined} />
        <Kpi label="Rejected" value={d?.review.reduce((t, r) => t + r.rejected, 0) ?? '—'} />
        <Kpi label="Reviewed in periodic review" value={d ? `${d.reviewed} / ${d.total}` : '—'} />
      </div>
      {d && d.review.length > 0 && (
        <Card title="Periodic review by exception type" flush>
          <div className="tbl-wrap">
            <table className="tbl tbl--dense">
              <thead><tr><th>Type</th><th className="num">Total</th><th className="num">Approved</th><th className="num">Rejected</th><th className="num">Open</th><th className="num">Value</th><th /></tr></thead>
              <tbody>{d.review.map((r) => (
                <tr key={r.type}><td>{r.label}</td><td className="num">{r.total}</td><td className="num">{r.approved}</td><td className="num">{r.rejected}</td><td className="num">{r.open}</td><td className="num">{fmtLakh(r.value)}</td>
                  <td className="right"><Button size="sm" variant={type === r.type ? 'deep' : 'ghost'} onClick={() => setType(type === r.type ? undefined : r.type)}>{type === r.type ? 'Showing' : 'Show'}</Button></td></tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
      )}
      <div style={{ height: 16 }} />
      <SectionTitle>Register</SectionTitle>
      <Card flush>
        <DataTable id="exception-register" rows={d?.rows} loading={q.isLoading} error={q.error} refetch={q.refetch} rowKey={(r) => r.id} rowLink={(r) => `/approvals/${r.id}`} columns={columns}
          filters={[{ key: 'type', label: 'Type', value: (r) => r.type_label }, { key: 'outcome', label: 'Outcome', value: (r) => r.outcome }]}
          searchPlaceholder="Search reason, request, record…" exportName="exception-register"
          empty={<div className="empty"><div className="empty__title">No exceptions in this period</div><div>Exceptions are logged here automatically when a buyer routes off-contract, buys from a single source, deviates from the lowest landed cost and so on.</div></div>}
          mobile={{ title: (r) => <><span className="mono">{r.req_no}</span> · {r.type_label}</>, badge: (r) => <Status value={r.outcome} />, meta: (r) => [r.reason ?? 'No reason', r.value != null ? fmtLakh(r.value) : '', `Raised by ${r.requester_name ?? '—'}`, r.approvers ?? 'Pending'].filter(Boolean) }} />
      </Card>
      <ReasonDialog open={!!review} onClose={() => setReview(null)} title={`Mark ${review?.req_no} reviewed`} label="Review note" confirmLabel="Record review" variant="deep" sub="Recorded in the audit trail and shown in the register and export." onSubmit={(n) => act.run(n)} />
    </>
  );
}
