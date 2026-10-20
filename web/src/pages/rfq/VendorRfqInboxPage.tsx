import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Badge, Card, Empty, Kpi, PageHeader, Ref, Status } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Countdown, KindBadge } from './shared';

interface Row {
  id: number; rfq_no: string; title: string; kind: string; closing_at: string; buyer_name: string; sent_at: string; rfq_status: string; editable: boolean; edit_until: string | null;
  invitation_status: string; quotation_status: string; version: number; submitted_at: string | null; ref_no: string | null; lines: number; hours_to_close: number;
}

/** SCR-VPT-03 — vendor RFQ inbox. */
export default function VendorRfqInboxPage() {
  const q = useQuery<Row[]>({ queryKey: ['rfq', 'vendor', 'inbox'], queryFn: () => api.get('/rfq/vendor/rfqs') });
  const rows = q.data ?? [];
  const toQuote = rows.filter((r) => r.editable && !['Submitted', 'Reopened'].includes(r.quotation_status) || (r.editable && r.quotation_status === 'Reopened')).length;
  const cols: Column<Row>[] = [
    { key: 'rfq_no', header: 'RFQ', render: (r) => <Ref to={`/vendor/rfqs/${r.id}`}>{r.rfq_no}</Ref>, nowrap: true },
    { key: 'title', header: 'Enquiry', render: (r) => <div style={{ minWidth: 220 }}><div style={{ fontWeight: 600 }}>{r.title}</div><div className="small subtle">{r.lines} line{r.lines === 1 ? '' : 's'} · buyer {r.buyer_name} <KindBadge kind={r.kind} /></div></div> },
    { key: 'closing_at', header: 'Closes', render: (r) => (r.rfq_status === 'Open' ? <div className="small"><Countdown at={r.closing_at} /><div className="subtle">{fmtDateTime(r.closing_at)}</div></div> : r.rfq_status === 'Reopened for you' ? <div className="small"><strong>Revise by {fmtDateTime(r.edit_until)}</strong></div> : <span className="small">{fmtDateTime(r.closing_at)}</span>), value: (r) => r.closing_at, nowrap: true },
    { key: 'rfq_status', header: 'RFQ', render: (r) => <Status value={r.rfq_status} tone={r.rfq_status === 'Open' ? 'info' : r.rfq_status === 'Reopened for you' ? 'warn' : 'neutral'} /> },
    { key: 'quotation_status', header: 'Your response', render: (r) => (
      <div><Status value={r.invitation_status === 'Declined' ? 'Declined' : r.quotation_status === 'Locked' ? 'Locked' : r.quotation_status} />
        {r.ref_no && <div className="small subtle">{r.ref_no} · v{r.version}</div>}</div>
    ) },
  ];
  return (
    <>
      <PageHeader title="RFQs" screen="SCR-VPT-03" eyebrow="Vendor portal" sub="Enquiries from Equipcare. Open one to see the requirement and enter your quotation line by line." />
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <Kpi label="Open for your quotation" value={q.isLoading ? '—' : rows.filter((r) => r.editable).length} tone={toQuote ? 'warn' : undefined} meta="Closing soonest first in the list" />
        <Kpi label="Submitted" value={q.isLoading ? '—' : rows.filter((r) => r.quotation_status === 'Submitted').length} meta="Can be revised until closing" />
        <Kpi label="Locked / closed" value={q.isLoading ? '—' : rows.filter((r) => !r.editable).length} />
      </div>
      <Card flush>
        <DataTable id="vendor-rfqs" rows={[...rows].sort((a, b) => Number(b.editable) - Number(a.editable) || new Date(a.closing_at).getTime() - new Date(b.closing_at).getTime())} loading={q.isLoading} error={q.error} refetch={q.refetch}
          rowKey={(r) => r.id} rowLink={(r) => `/vendor/rfqs/${r.id}`} columns={cols} savedViews={false}
          filters={[{ key: 'status', label: 'RFQ', value: (r) => r.rfq_status }, { key: 'resp', label: 'Your response', value: (r) => r.quotation_status }]}
          empty={<Empty title="No RFQs yet" icon={<Send size={22} />}>When Equipcare invites you to quote, the RFQ appears here and you receive an e-mail.</Empty>}
          mobile={{ title: (r) => <><span className="mono">{r.rfq_no}</span> · {r.title}</>, badge: (r) => <Status value={r.quotation_status} />, meta: (r) => [r.rfq_status === 'Open' ? <Countdown key="c" at={r.closing_at} /> : r.rfq_status, `${r.lines} lines`, r.invitation_status] }} />
      </Card>
      <p className="small muted" style={{ marginTop: 10 }}><Badge plain>Note</Badge> Quotations close automatically at the closing time. After that they are locked unless Equipcare reopens the RFQ for you.</p>
    </>
  );
}
