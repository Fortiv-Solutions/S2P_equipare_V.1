import { useQuery } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDate, fmtMoney } from '@/lib/format';
import { Badge, ButtonLink, Callout, Card, PageHeader, Ref, Status } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';

interface Row { id: number; inv_ref: string; vendor_invoice_no: string | null; invoice_date: string | null; po_no: string; total_value: number | null; status: string; on_behalf: number; created_at: string; rejected_reason: string | null; action_needed: boolean; reasons: string[] }

/** SCR-VPT-07 — vendor invoice list with vendor-safe status and reasons. */
export default function VendorInvoicesPage() {
  const q = useQuery<Row[]>({ queryKey: ['invoices', 'vendor-list'], queryFn: () => api.get('/invoices/vendor') });
  const rows = q.data ?? [];
  const attention = rows.filter((r) => r.action_needed);
  const columns: Column<Row>[] = [
    { key: 'vendor_invoice_no', header: 'Your invoice no.', render: (r) => <div><Ref to={`/vendor/invoices/${r.id}`}>{r.vendor_invoice_no ?? r.inv_ref}</Ref><div className="small subtle">Ref {r.inv_ref}</div></div>, value: (r) => `${r.vendor_invoice_no ?? ''} ${r.inv_ref}` },
    { key: 'po_no', header: 'PO', render: (r) => <span className="mono">{r.po_no}</span> },
    { key: 'invoice_date', header: 'Invoice date', render: (r) => fmtDate(r.invoice_date), nowrap: true },
    { key: 'total_value', header: 'Total', align: 'right', render: (r) => <span className="num">{fmtMoney(r.total_value)}</span>, value: (r) => r.total_value },
    { key: 'status', header: 'Status', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><div className="row-wrap"><Status value={r.status} />{r.on_behalf ? <Badge tone="deep" plain>Uploaded by Equipcare for you</Badge> : null}</div>{r.reasons.slice(0, 1).map((m) => <span key={m} className="small muted">{m}</span>)}{r.rejected_reason && <span className="small muted">{r.rejected_reason}</span>}</div>, value: (r) => r.status },
    { key: 'created_at', header: 'Uploaded', render: (r) => fmtDate(r.created_at), nowrap: true },
  ];
  return (
    <>
      <PageHeader title="Invoices" screen="SCR-VPT-07" sub="Upload invoices against your purchase orders and follow each one until payment." actions={<ButtonLink to="/vendor/invoices/upload" variant="primary" icon={<Upload size={16} />}>Upload invoice</ButtonLink>} />
      {attention.length > 0 && <div style={{ marginBottom: 14 }}><Callout tone="warn" title={`${attention.length} invoice${attention.length === 1 ? ' needs' : 's need'} your attention`}>Open an invoice to see what to fix. Where a correction is needed, upload a revised invoice against the same PO.</Callout></div>}
      <Card flush>
        <DataTable
          id="vendor-invoices" rows={rows} loading={q.isLoading} error={q.error} refetch={q.refetch} rowKey={(r) => r.id} rowLink={(r) => `/vendor/invoices/${r.id}`} columns={columns}
          initialSort={{ key: 'created_at', dir: 'desc' }} searchPlaceholder="Search invoice number or PO…" filters={[{ key: 'status', label: 'Status', value: (r) => r.status }]}
          empty={<div className="empty"><div className="empty__title">No invoices yet</div><div>Upload an invoice from a purchase order. You can take a photo of a paper invoice on your phone.</div><ButtonLink to="/vendor/invoices/upload" variant="primary" icon={<Upload size={16} />}>Upload invoice</ButtonLink></div>}
          mobile={{ title: (r) => <>{r.vendor_invoice_no ?? r.inv_ref}</>, badge: (r) => <Status value={r.status} />, meta: (r) => [`PO ${r.po_no}`, fmtMoney(r.total_value, true), ...r.reasons.slice(0, 1), r.rejected_reason ?? ''].filter(Boolean) }}
        />
      </Card>
    </>
  );
}
