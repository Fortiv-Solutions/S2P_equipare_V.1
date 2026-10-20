import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, OctagonAlert, Plus } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtLakh, fmtMoney } from '@/lib/format';
import { Badge, ButtonLink, Card, DecisionTag, Empty, Kpi, PageHeader, Ref, Segmented, Status, Tabs } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Bars } from '@/components/charts';
import { AgeCell, TermBadge } from './shared';
import type { DisputeRow } from './types';

type View = 'open' | 'mine' | 'vendor' | 'closed' | 'all' | 'ageing';
interface Ageing {
  by: string; buckets: string[]; threshold_days: number;
  rows: { key: string; count: number; value: number; counts: number[]; max_age: number; closed: number; avg_closure_days: number | null }[];
  totals: { open: number; value: number; escalated: number; closed: number; avg_closure_days: number | null; median_closure_days: number | null; over_threshold: number };
}

/** Dispute list with ageing buckets by owner / type / vendor / delivery term (FR-DSP-03, RPT-08). Vendors: SCR-VPT-09. */
export default function DisputeListPage({ vendor = false }: { vendor?: boolean }) {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const view = (sp.get('view') as View) ?? 'open';
  const setView = (v: View) => { sp.set('view', v); setSp(sp, { replace: true }); };
  const q = useQuery<DisputeRow[]>({ queryKey: ['asn', 'disputes', vendor], queryFn: () => api.get('/asn/disputes') });
  const rep = useQuery<Ageing>({ queryKey: ['asn', 'dsp-ageing', 'owner'], queryFn: () => api.get('/asn/disputes/ageing', { by: 'owner' }), enabled: !vendor });
  const { me } = useAuth();
  const base = vendor ? '/vendor/disputes' : '/disputes';
  const filterBucket = sp.get('bucket');
  const filterOwner = sp.get('owner');

  const rows = useMemo(() => (q.data ?? []).filter((r) => {
    if (filterBucket && r.bucket !== filterBucket) return false;
    if (filterOwner && r.owner_party !== filterOwner && r.type !== filterOwner && r.vendor_name !== filterOwner && r.delivery_term !== filterOwner) return false;
    if (view === 'open') return r.open;
    if (view === 'mine') return r.open && (vendor ? r.awaiting_you : r.owner_name === me?.name);
    if (view === 'vendor') return r.open && r.status === 'Awaiting response';
    if (view === 'closed') return !r.open;
    return true;
  }), [q.data, view, vendor, me, filterBucket, filterOwner]);

  const columns: Column<DisputeRow>[] = useMemo(() => [
    { key: 'dsp_no', header: 'Dispute', render: (r) => <div><Ref to={`${base}/${r.id}`}>{r.dsp_no}</Ref>{r.escalated && <div className="small" style={{ color: 'var(--bad)', fontWeight: 600 }}>Escalated</div>}</div>, nowrap: true },
    { key: 'type', header: 'Type', render: (r) => <span style={{ fontWeight: 600 }}>{r.type}</span> },
    { key: 'status', header: 'Status', render: (r) => <Status value={r.awaiting_you ? 'Awaiting your response' : r.status} /> },
    { key: 'po', header: 'PO / item', render: (r) => <div style={{ minWidth: 160 }}><span className="mono">{r.po_no}/{r.item}</span><div className="small subtle">{r.description}</div></div>, value: (r) => `${r.po_no}/${r.item} ${r.description}` },
    ...(vendor ? [] : [{ key: 'vendor_name', header: 'Vendor', render: (r: DisputeRow) => <div style={{ minWidth: 160 }}>{r.vendor_name}</div> }]),
    { key: 'qty', header: 'Qty', align: 'right', render: (r) => <span className="num">{r.qty} {r.uom}</span>, value: (r) => r.qty },
    { key: 'value', header: 'Value', align: 'right', render: (r) => fmtMoney(r.value, true), value: (r) => r.value },
    { key: 'delivery_term', header: 'Terms', render: (r) => <TermBadge term={r.delivery_term} /> },
    { key: 'owner_label', header: 'Owner', render: (r) => <span>{r.owner_label}</span> },
    { key: 'age_days', header: 'Age', align: 'right', render: (r) => <AgeCell days={r.age_days} open={r.open} threshold={rep.data?.threshold_days} />, value: (r) => r.age_days },
    { key: 'bucket', header: 'Ageing', render: (r) => r.open ? <span className="small">{r.bucket}</span> : <span className="small subtle">Closed in {r.closure_tat_days ?? '—'} d</span> },
    { key: 'plant', header: 'Plant', hidden: true },
    { key: 'source', header: 'Source', hidden: true },
    { key: 'outcome', header: 'Outcome', hidden: !['closed', 'all'].includes(view) },
    { key: 'created_at', header: 'Raised', render: (r) => fmtDate(r.created_at), hidden: true },
  ], [base, vendor, view, rep.data]);

  const t = rep.data?.totals;
  return (
    <>
      <PageHeader
        title="Disputes" screen={vendor ? 'SCR-VPT-09' : 'SCR-ASN-05'} eyebrow="Module 8"
        sub={vendor ? 'Shortage, damage, transit loss and other receipt discrepancies Equipcare recorded on your deliveries. Respond with documents.' : 'Receipt discrepancies and their owners, by ageing. The default owner comes from the delivery-term responsibility matrix.'}
        badges={vendor ? undefined : <DecisionTag id="DEC-24" />}
        actions={vendor ? undefined : <>
          <a className="btn btn--secondary" href={downloadUrl('/asn/disputes', { format: 'csv' })}><Download size={16} /> Export</a>
          {can('dsp.raise') && can('asn.receive') && <ButtonLink to="/receipts" variant="primary" icon={<Plus size={16} />}>Record receipt issue</ButtonLink>}
        </>}
      />
      {!vendor && (
        <div className="grid-4" style={{ marginBottom: 20 }}>
          <Kpi label="Open disputes" value={t?.open ?? '—'} meta={t ? `${fmtLakh(t.value)} disputed` : undefined} onClick={() => setView('open')} />
          <Kpi label={`Open ≥ ${rep.data?.threshold_days ?? '—'} days`} value={t?.over_threshold ?? '—'} tone={t?.over_threshold ? 'bad' : undefined} meta={`${t?.escalated ?? 0} escalated (NTF-23)`} onClick={() => setView('ageing')} />
          <Kpi label="Awaiting vendor response" value={(q.data ?? []).filter((r) => r.open && r.status === 'Awaiting response').length} onClick={() => setView('vendor')} />
          <Kpi label="Closure TAT (KPI-12)" value={t?.avg_closure_days != null ? `${t.avg_closure_days} d` : '—'} meta={t?.closed ? `${t.closed} closed · median ${t.median_closure_days} d · Baseline: to be measured` : 'Baseline: to be measured'} onClick={() => setView('closed')} />
        </div>
      )}
      <Tabs<View> value={view} onChange={(v) => { sp.delete('bucket'); sp.delete('owner'); setView(v); }} tabs={vendor ? [
        { id: 'mine', label: 'Awaiting your response', count: (q.data ?? []).filter((r) => r.awaiting_you).length },
        { id: 'open', label: 'Open', count: (q.data ?? []).filter((r) => r.open).length },
        { id: 'closed', label: 'Resolved & closed' }, { id: 'all', label: 'All' },
      ] : [
        { id: 'open', label: 'Open', count: (q.data ?? []).filter((r) => r.open).length },
        { id: 'mine', label: 'Owned by me', count: (q.data ?? []).filter((r) => r.open && r.owner_name === me?.name).length },
        { id: 'vendor', label: 'Awaiting vendor' },
        { id: 'closed', label: 'Resolved & closed' }, { id: 'all', label: 'All' }, { id: 'ageing', label: 'Ageing (RPT-08)' },
      ]} />
      {view === 'ageing' && !vendor ? <AgeingView onDrill={(key, bucket) => { sp.set('view', 'open'); sp.set('owner', key); if (bucket) sp.set('bucket', bucket); else sp.delete('bucket'); setSp(sp); }} /> : (
        <Card flush>
          {(filterBucket || filterOwner) && <div style={{ padding: '10px 14px 0' }} className="row-wrap"><Badge tone="info">Filtered: {[filterOwner, filterBucket].filter(Boolean).join(' · ')}</Badge><button className="btn btn--ghost btn--sm" onClick={() => { sp.delete('bucket'); sp.delete('owner'); setSp(sp); }}>Clear</button></div>}
          <DataTable
            id={vendor ? 'vendor-disputes' : 'disputes'} rows={rows} loading={q.isLoading} error={q.error} refetch={q.refetch}
            rowKey={(r) => r.id} rowLink={(r) => `${base}/${r.id}`} columns={columns} initialSort={{ key: 'age_days', dir: 'desc' }}
            filters={[
              { key: 'type', label: 'Type', value: (r) => r.type },
              { key: 'owner', label: 'Owner', value: (r) => r.owner_party },
              { key: 'term', label: 'Terms', value: (r) => r.delivery_term },
              { key: 'bucket', label: 'Ageing', value: (r) => r.bucket },
              ...(vendor ? [] : [{ key: 'vendor', label: 'Vendor', value: (r: DisputeRow) => r.vendor_name }, { key: 'plant', label: 'Plant', value: (r: DisputeRow) => r.plant }]),
            ]}
            searchPlaceholder="Search dispute, PO, material…"
            empty={<Empty title={vendor && view === 'mine' ? 'Nothing waiting for you' : 'No disputes in this view'} icon={<OctagonAlert size={24} />}>{vendor ? 'Equipcare records receipt discrepancies here. You will be notified when one needs your response.' : 'Stores record discrepancies from Expected receipts; finance from an invoice exception.'}</Empty>}
            mobile={{
              title: (r) => <><span className="mono">{r.dsp_no}</span> · {r.type}</>,
              badge: (r) => <Status value={r.awaiting_you ? 'Awaiting your response' : r.status} />,
              meta: (r) => [`PO ${r.po_no}/${r.item}`, `${r.qty} ${r.uom}`, vendor ? r.owner_party : r.vendor_name, `${r.age_days} d`, r.owner_label],
            }}
          />
        </Card>
      )}
    </>
  );
}

function AgeingView({ onDrill }: { onDrill: (key: string, bucket?: string) => void }) {
  const [by, setBy] = useState<'owner' | 'type' | 'vendor' | 'delivery_term'>('owner');
  const q = useQuery<Ageing>({ queryKey: ['asn', 'dsp-ageing', by], queryFn: () => api.get('/asn/disputes/ageing', { by }) });
  return (
    <div className="stack">
      <Card title={<div className="row-wrap"><h2>Dispute ageing</h2><span className="muted small">{q.data?.totals.open ?? 0} open · RPT-08</span></div>}
        actions={<Segmented label="Group by" value={by} onChange={setBy} options={[{ id: 'owner', label: 'Owner' }, { id: 'type', label: 'Type' }, { id: 'vendor', label: 'Vendor' }, { id: 'delivery_term', label: 'Delivery term' }]} />}>
        {q.data && <Bars title="Open disputes by ageing bucket" legend={q.data.buckets} data={q.data.rows.filter((r) => r.count > 0).map((r) => ({ label: r.key, value: r.count, parts: r.counts.map((c, i) => ({ label: q.data!.buckets[i], value: c })), onClick: () => onDrill(r.key), hint: `Oldest ${r.max_age} days` }))} />}
        <p className="small muted" style={{ marginTop: 12 }}>Select a bar to open those disputes. Age counts calendar days from when the dispute was raised (working-day basis pending <DecisionTag id="DEC-15" />). Escalation after {q.data?.threshold_days ?? '—'} days.</p>
      </Card>
      <Card title="Count, value and closure TAT" flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>{by === 'delivery_term' ? 'Delivery term' : by[0].toUpperCase() + by.slice(1)}</th>{q.data?.buckets.map((b) => <th key={b} className="num">{b}</th>)}<th className="num">Open</th><th className="num">Value</th><th className="num">Closed</th><th className="num">Avg closure</th></tr></thead>
            <tbody>
              {q.data?.rows.map((r) => (
                <tr key={r.key}>
                  <td style={{ fontWeight: 600 }}>{r.key}</td>
                  {r.counts.map((c, i) => <td key={i} className="num">{c ? <button className="btn btn--ghost btn--sm" onClick={() => onDrill(r.key, q.data!.buckets[i])}>{c}</button> : <span className="subtle">0</span>}</td>)}
                  <td className="num"><strong>{r.count}</strong></td><td className="num">{fmtLakh(r.value)}</td><td className="num">{r.closed}</td><td className="num">{r.avg_closure_days != null ? `${r.avg_closure_days} d` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
