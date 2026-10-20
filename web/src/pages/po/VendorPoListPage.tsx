import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fmtDate, fmtLakh, plural } from '@/lib/format';
import { Badge, Card, Kpi, PageHeader, Priority, Ref, Segmented, Status } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import type { VendorPoRow } from './types';

type Filter = 'ack' | 'open' | 'all';

/** SCR-VPT-05 — vendor PO list: POs to acknowledge first, then newest. */
export default function VendorPoListPage() {
  const q = useQuery<VendorPoRow[]>({ queryKey: ['po', 'vendor', 'list'], queryFn: () => api.get('/po/vendor/pos') });
  const [filter, setFilter] = useState<Filter>('ack');
  const all = q.data ?? [];
  const toAck = all.filter((r) => r.to_acknowledge);
  const effective: Filter = filter === 'ack' && q.data && !toAck.length ? 'open' : filter;
  const rows = useMemo(() => all.filter((r) => effective === 'ack' ? r.to_acknowledge : effective === 'open' ? ['Published', 'Partially received'].includes(r.status) : true), [all, effective]);
  const columns: Column<VendorPoRow>[] = [
    { key: 'po_no', header: 'PO', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Ref to={`/vendor/pos/${r.id}`}>{r.po_no}</Ref>{r.version > 1 && <span className="small subtle">Version {r.version}</span>}</div> },
    { key: 'po_date', header: 'PO date', render: (r) => fmtDate(r.po_date) },
    { key: 'plant', header: 'Deliver to', render: (r) => r.plant_name ?? r.plant },
    { key: 'urgency', header: 'Urgency', render: (r) => <Priority value={r.urgency} /> },
    { key: 'lines', header: 'Lines', align: 'right' },
    { key: 'pending_ack', header: 'To acknowledge', render: (r) => r.cancel_ack ? <Badge tone="warn">Confirm cancellation</Badge> : r.pending_ack ? <span style={{ color: r.ack_overdue ? 'var(--bad)' : undefined, fontWeight: 600 }}>{plural(r.pending_ack, 'line')}{r.reack ? ' (changed)' : ''}{r.ack_due_at ? ` · by ${fmtDate(r.ack_due_at)}` : ''}</span> : <span className="subtle">Done</span>, value: (r) => r.pending_ack },
    { key: 'next_delivery', header: 'Next delivery', render: (r) => fmtDate(r.next_delivery) },
    { key: 'total_value', header: 'Value', align: 'right', render: (r) => fmtLakh(r.total_value) },
    { key: 'status', header: 'Status', render: (r) => <Status value={r.status} /> },
  ];
  return (
    <>
      <PageHeader title="Purchase orders" screen="SCR-VPT-05" sub="Released purchase orders from Equipcare. Acknowledge each line with your delivery commitment."
        actions={<Segmented label="Show" value={effective} onChange={setFilter} options={[{ id: 'ack', label: `To acknowledge (${toAck.length})` }, { id: 'open', label: 'Open' }, { id: 'all', label: 'All' }]} />} />
      <div className="grid-3" style={{ marginBottom: 18 }}>
        <Kpi label="To acknowledge" value={q.data ? toAck.length : '—'} tone={toAck.some((r) => r.ack_overdue) ? 'bad' : toAck.length ? 'warn' : undefined} meta={toAck.some((r) => r.ack_overdue) ? 'Some are past the due time' : 'Accept, partially accept or reject'} onClick={() => setFilter('ack')} />
        <Kpi label="Open POs" value={q.data ? all.filter((r) => ['Published', 'Partially received'].includes(r.status)).length : '—'} onClick={() => setFilter('open')} />
        <Kpi label="Open value" value={q.data ? fmtLakh(all.filter((r) => ['Published', 'Partially received'].includes(r.status)).reduce((s, r) => s + r.total_value, 0)) : '—'} onClick={() => setFilter('open')} />
      </div>
      <Card flush>
        <DataTable id="vendor-pos" rows={rows} loading={q.isLoading} error={q.error} refetch={q.refetch} columns={columns} rowKey={(r) => r.id} rowLink={(r) => `/vendor/pos/${r.id}`}
          searchPlaceholder="Search PO number…" savedViews={false}
          empty={<div className="empty"><div className="empty__title">No purchase orders here</div><div>New POs appear when Equipcare releases them in SAP. You are notified by e-mail and in the portal.</div></div>}
          mobile={{
            title: (r) => <><span className="mono">{r.po_no}</span> · {r.plant_name ?? r.plant}</>,
            badge: (r) => r.to_acknowledge ? <Badge tone={r.ack_overdue ? 'bad' : 'warn'}>{r.cancel_ack ? 'Confirm cancellation' : `Acknowledge ${r.pending_ack}`}</Badge> : <Status value={r.status} />,
            meta: (r) => [fmtDate(r.po_date), <Priority key="u" value={r.urgency} />, plural(r.lines, 'line'), fmtLakh(r.total_value), r.next_delivery ? `Next delivery ${fmtDate(r.next_delivery)}` : ''],
          }} />
      </Card>
    </>
  );
}
