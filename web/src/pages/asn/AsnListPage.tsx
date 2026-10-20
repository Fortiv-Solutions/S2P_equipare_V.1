import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Plus, Truck, Warehouse } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { Badge, Button, ButtonLink, Card, Empty, Kpi, PageHeader, Ref, Status, Tabs } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal } from '@/components/overlay';
import { TermBadge } from './shared';
import type { AsnListRow } from './types';

type View = 'open' | 'overdue' | 'delivered' | 'all';

/** SCR-ASN-01 (internal) and the vendor's dispatch list — ASNs by status, plant and expected date (FR-ASN-01..05). */
export default function AsnListPage({ vendor = false }: { vendor?: boolean }) {
  const { me } = useAuth();
  const [sp, setSp] = useSearchParams();
  const view = (sp.get('view') as View) ?? 'open';
  const setView = (v: View) => { sp.set('view', v); setSp(sp, { replace: true }); };
  const q = useQuery<AsnListRow[]>({ queryKey: ['asn', 'list', vendor], queryFn: () => api.get('/asn/asns') });
  const s = useQuery<{ open: number; due_week: number; delivery_overdue: number; pickup_overdue: number; with_disputes: number }>({ queryKey: ['asn', 'summary', vendor], queryFn: () => api.get('/asn/asns/summary') });
  const [pick, setPick] = useState(false);
  const base = vendor ? '/vendor/asns' : '/asns';

  const rows = useMemo(() => (q.data ?? []).filter((r) => {
    if (view === 'open') return ['Draft', 'Submitted', 'In transit'].includes(r.status);
    if (view === 'overdue') return r.delivery_overdue || r.pickup_overdue;
    if (view === 'delivered') return r.status === 'Delivered';
    return true;
  }), [q.data, view]);

  const columns: Column<AsnListRow>[] = useMemo(() => [
    { key: 'asn_no', header: 'ASN', render: (r) => <div><Ref to={`${base}/${r.id}`}>{r.asn_no}</Ref>{r.version > 1 && <span className="small subtle"> v{r.version}</span>}</div>, nowrap: true },
    { key: 'po_no', header: 'PO', render: (r) => <span className="mono">{r.po_no}</span> },
    ...(vendor ? [] : [{ key: 'vendor_name', header: 'Vendor', render: (r: AsnListRow) => <div style={{ minWidth: 180 }}>{r.vendor_name}</div> }]),
    { key: 'plant', header: 'Plant' },
    { key: 'status', header: 'Status', render: (r) => (
      <div className="stack-sm" style={{ gap: 2 }}>
        <Status value={r.status} />
        {r.pickup_overdue && <span className="small" style={{ color: 'var(--bad)', fontWeight: 600 }}>Pickup overdue</span>}
        {r.delivery_overdue && <span className="small" style={{ color: 'var(--bad)', fontWeight: 600 }}>Past expected date</span>}
      </div>
    ) },
    { key: 'delivery_terms', header: 'Terms', render: (r) => <TermBadge term={r.delivery_terms} /> },
    { key: 'dispatch_date', header: 'Dispatch', render: (r) => fmtDate(r.dispatch_date), nowrap: true },
    { key: 'expected_date', header: 'Expected', render: (r) => fmtDate(r.expected_date), nowrap: true },
    { key: 'total_qty', header: 'Qty', align: 'right', render: (r) => <span className="num">{r.total_qty}</span>, value: (r) => r.total_qty },
    { key: 'transport', header: 'Transport', render: (r) => r.pickup_by === 'Equipcare' ? <span>Equipcare pickup · {r.pickup_status ?? 'Requested'}</span> : <span>{r.transporter ?? '—'}{r.lr_no ? <span className="small subtle mono"> · {r.lr_no}</span> : null}</span>, value: (r) => `${r.transporter ?? ''} ${r.lr_no ?? ''}` },
    { key: 'grn_nos', header: 'GRN', render: (r) => r.grn_nos ? <span className="mono">{r.grn_nos}</span> : <span className="subtle">—</span> },
    { key: 'open_disputes', header: 'Disputes', align: 'right', render: (r) => r.open_disputes ? <Badge tone="bad">{r.open_disputes} open</Badge> : <span className="subtle">—</span>, value: (r) => r.open_disputes },
    { key: 'vehicle_no', header: 'Vehicle', hidden: true },
    { key: 'eway_bill', header: 'E-way bill', hidden: true },
    { key: 'invoice_ref', header: 'Invoice ref', hidden: true },
    ...(vendor ? [] : [{ key: 'buyer_name', header: 'Buyer', hidden: true }]),
  ], [vendor, base]);

  const d = s.data;
  return (
    <>
      <PageHeader
        title={vendor ? 'Dispatch (ASN)' : 'ASN & dispatch'} screen={vendor ? 'SCR-VPT-06' : 'SCR-ASN-01'} eyebrow="Module 8"
        sub={vendor ? `Advance shipping notices ${me?.vendor?.name ?? 'your company'} sent to Equipcare. Create one for each consignment against acknowledged PO lines.` : 'Advance shipping notices from vendors: what is coming, to which plant, when, and how it travels.'}
        actions={vendor
          ? <Button variant="primary" icon={<Plus />} onClick={() => setPick(true)}>Create ASN</Button>
          : <>
              {me?.merged && <ButtonLink to="/receipts" icon={<Warehouse />}>Expected receipts</ButtonLink>}
              <a className="btn btn--secondary" href={downloadUrl('/asn/asns', { format: 'csv' })}><Download size={16} /> Export all</a>
            </>}
      />
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <Kpi label="Open ASNs" value={d?.open ?? '—'} meta="Submitted or in transit" onClick={() => setView('open')} />
        <Kpi label="Due in 7 days" value={d?.due_week ?? '—'} onClick={() => setView('open')} />
        <Kpi label="Past expected date" value={d?.delivery_overdue ?? '—'} tone={d?.delivery_overdue ? 'bad' : undefined} onClick={() => setView('overdue')} />
        <Kpi label="Equipcare pickup overdue" value={d?.pickup_overdue ?? '—'} tone={d?.pickup_overdue ? 'bad' : undefined} meta="AC-ASN-03" onClick={() => setView('overdue')} />
      </div>
      <Tabs<View> value={view} onChange={setView} tabs={[
        { id: 'open', label: 'Open', count: (q.data ?? []).filter((r) => ['Draft', 'Submitted', 'In transit'].includes(r.status)).length },
        { id: 'overdue', label: 'Overdue', count: (q.data ?? []).filter((r) => r.delivery_overdue || r.pickup_overdue).length },
        { id: 'delivered', label: 'Delivered' },
        { id: 'all', label: 'All' },
      ]} />
      <Card flush>
        <DataTable
          id={vendor ? 'vendor-asns' : 'asn-list'} rows={rows} loading={q.isLoading} error={q.error} refetch={q.refetch}
          rowKey={(r) => r.id} rowLink={(r) => `${base}/${r.id}`} columns={columns} initialSort={{ key: 'expected_date', dir: 'asc' }}
          filters={[
            { key: 'status', label: 'Status', value: (r) => r.status },
            { key: 'plant', label: 'Plant', value: (r) => r.plant },
            { key: 'delivery_terms', label: 'Terms', value: (r) => r.delivery_terms },
            ...(vendor ? [] : [{ key: 'vendor', label: 'Vendor', value: (r: AsnListRow) => r.vendor_name }]),
          ]}
          searchPlaceholder="Search ASN, PO, LR, vehicle…"
          empty={<Empty title={view === 'overdue' ? 'Nothing overdue' : 'No ASNs in this view'} icon={<Truck size={24} />} action={vendor ? <Button variant="primary" icon={<Plus />} onClick={() => setPick(true)}>Create ASN</Button> : undefined}>
            {vendor ? 'Create an ASN when material is ready to dispatch against an acknowledged PO.' : 'Vendors create ASNs on the portal when they dispatch. They appear here and in stores\' expected receipts.'}
          </Empty>}
          mobile={{
            title: (r) => <><span className="mono">{r.asn_no}</span> · PO {r.po_no}</>,
            badge: (r) => <Status value={r.pickup_overdue ? 'Pickup overdue' : r.status} />,
            meta: (r) => [vendor ? r.plant : r.vendor_name, `ETA ${fmtDate(r.expected_date)}`, `${r.total_qty} units`, r.delivery_terms],
          }}
        />
      </Card>
      {vendor && <PickPo open={pick} onClose={() => setPick(false)} />}
    </>
  );
}

function PickPo({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useQuery<{ id: number; po_no: string; plant: string; po_date: string; term: string; urgency: string; dispatchable: number; open_qty: number; pending_ack: number; lines: number }[]>({ queryKey: ['asn', 'eligible'], queryFn: () => api.get('/asn/eligible-pos'), enabled: open });
  return (
    <Modal open={open} onClose={onClose} title="Choose the purchase order" sub="ASNs are created against acknowledged PO lines with quantity still to dispatch.">
      {q.isLoading ? <p className="muted">Loading your open POs…</p> : !q.data?.length ? (
        <Empty title="No open POs">You have no open purchase orders from Equipcare.</Empty>
      ) : (
        <ul className="list-plain stack-sm">
          {q.data.map((p) => (
            <li key={p.id} className="row between" style={{ padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div><span className="mono" style={{ fontWeight: 600 }}>{p.po_no}</span> · {p.plant} · <TermBadge term={p.term} /></div>
                <div className="small muted">{p.dispatchable ? `${p.dispatchable} of ${p.lines} lines ready · ${p.open_qty} units open` : p.pending_ack ? `${p.pending_ack} line(s) waiting for your acknowledgement` : 'Nothing left to dispatch'}</div>
              </div>
              {p.dispatchable ? <ButtonLink to={`/vendor/asns/new?po=${p.id}`} size="sm" variant="primary">Create ASN</ButtonLink>
                : p.pending_ack ? <ButtonLink to={`/vendor/pos/${p.id}`} size="sm">Acknowledge PO</ButtonLink> : <Badge>Nothing to ship</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
