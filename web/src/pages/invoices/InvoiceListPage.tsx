import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, ListChecks, Upload } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import { Badge, ButtonLink, Card, Freshness, Kpi, PageHeader, Ref, Status, Tabs } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { OcrNote, TABS } from './shared';

export interface InvRow {
  id: number; inv_ref: string; vendor_invoice_no: string | null; invoice_date: string | null; vendor_name: string; po_no: string; plant: string; status: string; sub_reason: string | null;
  total_value: number | null; tab: string; open_exceptions: number; owners: string | null; age_days: number; due_date: string | null; on_behalf: number; dispute_hold: number; payment_ref: string | null;
  balance_payable: number | null; advance_outstanding: number; approved_at: string | null; created_at: string; dup_ref: string | null;
}

type Tab = (typeof TABS)[number]['id'] | 'all';

/** SCR-INV-01 — invoice list, tabs by status (FR-PLT-05 filters, saved views and export come from DataTable). */
export default function InvoiceListPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'all';
  const q = useQuery<InvRow[]>({ queryKey: ['invoices', 'list'], queryFn: () => api.get('/invoices') });
  const rows = q.data ?? [];
  const count = (t: string) => rows.filter((r) => r.tab === t).length;
  const shown = useMemo(() => (tab === 'all' ? rows : rows.filter((r) => r.tab === tab)), [rows, tab]);
  const setTab = (t: Tab) => { if (t === 'all') sp.delete('tab'); else sp.set('tab', t); setSp(sp, { replace: true }); };

  const columns: Column<InvRow>[] = [
    { key: 'inv_ref', header: 'Invoice', render: (r) => <div><Ref to={`/invoices/${r.id}`}>{r.inv_ref}</Ref><div className="small subtle">{r.vendor_invoice_no ?? 'No. not found'}</div></div>, value: (r) => `${r.inv_ref} ${r.vendor_invoice_no ?? ''}`, nowrap: true },
    { key: 'vendor_name', header: 'Vendor', render: (r) => <div style={{ minWidth: 160 }}>{r.vendor_name}{r.on_behalf ? <div className="small"><Badge tone="deep" plain>Uploaded on vendor’s behalf</Badge></div> : null}</div> },
    { key: 'po_no', header: 'PO', render: (r) => <span className="mono">{r.po_no}</span> },
    { key: 'invoice_date', header: 'Invoice date', render: (r) => fmtDate(r.invoice_date), nowrap: true },
    { key: 'total_value', header: 'Total', align: 'right', render: (r) => <span className="num">{fmtMoney(r.total_value)}</span>, value: (r) => r.total_value },
    { key: 'status', header: 'Status', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><div className="row-wrap"><Status value={r.status} />{r.status === 'Matched' && r.approved_at ? <Badge tone="ok" plain>Approved</Badge> : null}</div>{r.sub_reason && <span className="small muted">{r.sub_reason}</span>}</div>, value: (r) => `${r.status} ${r.sub_reason ?? ''}` },
    { key: 'owners', header: 'Owner', render: (r) => r.owners ?? <span className="subtle">—</span> },
    { key: 'age_days', header: 'Age', align: 'right', render: (r) => <span className="num" style={{ color: r.age_days > 7 && !['paid', 'rejected'].includes(r.tab) ? 'var(--warn)' : undefined }}>{r.age_days} d</span>, value: (r) => r.age_days },
    { key: 'plant', header: 'Plant', hidden: true },
    { key: 'due_date', header: 'Payment due', render: (r) => fmtDate(r.due_date), hidden: true },
    { key: 'payment_ref', header: 'Payment ref', hidden: true },
  ];

  return (
    <>
      <PageHeader
        title="Invoices" screen="SCR-INV-01" eyebrow="Module 10"
        sub="Vendor invoices from upload to SAP posting and payment. Finance approves matched invoices; parking and posting happen in SAP."
        badges={<><Freshness flow="INT-M12" label="Invoice status" /><OcrNote compact /></>}
        actions={<>
          <ButtonLink to="/invoices/exceptions" icon={<ListChecks size={16} />}>Exception queue{count('exception') ? ` (${count('exception')})` : ''}</ButtonLink>
          {can('inv.upload_behalf') && <ButtonLink to="/invoices/upload" variant="deep" icon={<Upload size={16} />}>Upload for a vendor</ButtonLink>}
          <a className="btn btn--secondary" href={downloadUrl('/invoices', { format: 'csv' })}><Download size={16} /> Export all</a>
        </>}
      />
      <div className="grid-4" style={{ marginBottom: 18 }}>
        <Kpi label="Exceptions" value={count('exception')} tone={count('exception') ? 'bad' : undefined} meta="Need a decision" onClick={() => setTab('exception')} />
        <Kpi label="Waiting for GRN / SES" value={count('pending')} meta="Re-match automatically" onClick={() => setTab('pending')} />
        <Kpi label="Matched — to approve" value={count('matched')} tone={count('matched') ? 'warn' : undefined} meta="Finance approval needed" onClick={() => setTab('matched')} />
        <Kpi label="Approved — to park / post" value={count('approved')} meta="Hand over to SAP" onClick={() => setTab('approved')} />
      </div>
      <Tabs<Tab>
        value={tab} onChange={setTab}
        tabs={[{ id: 'all', label: 'All', count: rows.length }, ...TABS.map((t) => ({ id: t.id as Tab, label: t.label, count: count(t.id) }))]}
      />
      <Card flush>
        <DataTable
          id="invoice-list" rows={shown} loading={q.isLoading} error={q.error} refetch={q.refetch} rowKey={(r) => r.id} rowLink={(r) => `/invoices/${r.id}`}
          columns={columns} initialSort={{ key: 'age_days', dir: 'desc' }} exportName="invoices" searchPlaceholder="Search invoice, vendor, PO…"
          filters={[
            { key: 'vendor', label: 'Vendor', value: (r) => r.vendor_name },
            { key: 'plant', label: 'Plant', value: (r) => r.plant },
            { key: 'status', label: 'Status', value: (r) => r.status },
          ]}
          empty={<div className="empty"><div className="empty__title">No invoices in this view</div><div>Invoices appear when vendors upload them{can('inv.upload_behalf') ? ' — or upload one on a vendor’s behalf.' : '.'}</div></div>}
          mobile={{
            title: (r) => <><span className="mono">{r.inv_ref}</span> · {r.vendor_name}</>,
            badge: (r) => <Status value={r.status} />,
            meta: (r) => [r.vendor_invoice_no ?? '—', `PO ${r.po_no}`, fmtMoney(r.total_value, true), r.sub_reason ?? '', `${r.age_days} d old`].filter(Boolean),
          }}
        />
      </Card>
    </>
  );
}
