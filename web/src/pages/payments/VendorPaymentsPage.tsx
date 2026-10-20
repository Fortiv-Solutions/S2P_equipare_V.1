import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileDown } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { fmtDate, fmtMoney } from '@/lib/format';
import { Callout, Card, DecisionTag, PageHeader, Ref, Status, Tabs } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';

interface PayRow { id: number; inv_ref: string; vendor_invoice_no: string | null; invoice_date: string | null; po_no: string; total_value: number | null; status?: string; due_date?: string; paid_at?: string; payment_ref?: string; tds?: number; deductions?: { label: string; amount: number }[]; advance_adjusted?: number; vendor_reason?: string; advice_available?: boolean }
interface AdvRow { id: number; adv_no: string; po_no: string | null; contract_no: string | null; amount: number; status: string; paid_date: string | null; adjusted_amount: number; outstanding: number; created_at: string }

/** Only the fields SAP provided and the vendor whitelist allows are listed; nothing is shown as zero (FR-PAY-05, FR-PAY-07, DEC-19). */
function Details({ r }: { r: PayRow }) {
  const items: [string, string][] = [];
  if (r.payment_ref) items.push(['Payment ref', r.payment_ref]);
  if (r.tds != null) items.push(['TDS deducted', fmtMoney(r.tds)]);
  if (r.deductions?.length) items.push(['Deductions', r.deductions.map((d) => `${d.label} ${fmtMoney(d.amount)}`).join(', ')]);
  if (r.advance_adjusted != null) items.push(['Advance adjusted', fmtMoney(r.advance_adjusted)]);
  if (r.vendor_reason) items.push(['Note from Equipcare', r.vendor_reason]);
  if (!items.length) return <span className="subtle">—</span>;
  return <dl className="small" style={{ margin: 0, display: 'grid', gap: 2 }}>{items.map(([k, v]) => <div key={k}><span className="muted">{k}:</span> <strong>{v}</strong></div>)}</dl>;
}

const Advice = ({ r }: { r: PayRow }) => (r.advice_available ? <a className="btn btn--secondary btn--sm" href={downloadUrl(`/payments/invoices/${r.id}/advice.pdf`)} target="_blank" rel="noreferrer"><FileDown size={14} /> Payment advice</a> : <span className="subtle small">After release</span>);

/** SCR-VPT-08 — vendor payment status, payment advice download and advances. */
export default function VendorPaymentsPage() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') === 'advances' ? 'advances' : 'invoices';
  const focus = Number(sp.get('invoice')) || null;
  const inv = useQuery<PayRow[]>({ queryKey: ['payments', 'vendor-invoices'], queryFn: () => api.get('/payments/vendor/invoices') });
  const adv = useQuery<AdvRow[]>({ queryKey: ['payments', 'vendor-advances'], queryFn: () => api.get('/payments/vendor/advances') });
  const rows = inv.data ?? [];
  const f = focus ? rows.find((r) => r.id === focus) : null;

  const cols: Column<PayRow>[] = [
    { key: 'vendor_invoice_no', header: 'Your invoice', render: (r) => <div><Ref to={`/vendor/invoices/${r.id}`}>{r.vendor_invoice_no ?? r.inv_ref}</Ref><div className="small subtle">PO {r.po_no} · {fmtDate(r.invoice_date)}</div></div>, value: (r) => `${r.vendor_invoice_no ?? ''} ${r.po_no}` },
    { key: 'total_value', header: 'Invoice total', align: 'right', render: (r) => <span className="num">{fmtMoney(r.total_value)}</span>, value: (r) => r.total_value },
    { key: 'status', header: 'Status', render: (r) => (r.status ? <Status value={r.status} /> : <span className="subtle">—</span>), value: (r) => r.status },
    { key: 'due_date', header: 'Payment due', render: (r) => (r.due_date ? fmtDate(r.due_date) : <span className="subtle">—</span>), value: (r) => r.due_date, nowrap: true },
    { key: 'paid_at', header: 'Paid on', render: (r) => (r.paid_at ? fmtDate(r.paid_at) : <span className="subtle">—</span>), value: (r) => r.paid_at, nowrap: true },
    { key: 'details', header: 'Payment details', render: (r) => <Details r={r} />, sortable: false, exportable: false },
    { key: 'advice', header: 'Advice', render: (r) => <Advice r={r} />, sortable: false, exportable: false },
  ];
  const advCols: Column<AdvRow>[] = [
    { key: 'adv_no', header: 'Advance', render: (r) => <span className="mono">{r.adv_no}</span> },
    { key: 'against', header: 'Against', render: (r) => <span className="mono">{r.po_no ?? r.contract_no ?? '—'}</span>, value: (r) => r.po_no ?? r.contract_no },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => <span className="num">{fmtMoney(r.amount, true)}</span>, value: (r) => r.amount },
    { key: 'status', header: 'Status', render: (r) => <Status value={r.status} /> },
    { key: 'paid_date', header: 'Paid on', render: (r) => (r.paid_date ? fmtDate(r.paid_date) : <span className="subtle">—</span>), nowrap: true },
    { key: 'adjusted_amount', header: 'Adjusted against invoices', align: 'right', render: (r) => (r.paid_date ? fmtMoney(r.adjusted_amount, true) : <span className="subtle">—</span>), value: (r) => r.adjusted_amount },
    { key: 'outstanding', header: 'Still to adjust', align: 'right', render: (r) => (r.outstanding ? fmtMoney(r.outstanding, true) : <span className="subtle">—</span>), value: (r) => r.outstanding },
  ];

  return (
    <>
      <PageHeader title="Payments" screen="SCR-VPT-08" sub="Where each approved invoice stands, payment advice after release, and advances paid to you." badges={<span className="small muted">Fields shown follow the approved vendor list <DecisionTag id="DEC-19" /></span>} />
      {f && f.status === 'Payment released' && <div style={{ marginBottom: 14 }}><Callout tone="ok" title={`Payment released for invoice ${f.vendor_invoice_no ?? f.inv_ref}`}>{f.payment_ref ? `Payment reference ${f.payment_ref}. ` : ''}{f.advice_available && <Advice r={f} />}</Callout></div>}
      <Tabs value={tab} onChange={(t) => { sp.set('tab', t); setSp(sp, { replace: true }); }} tabs={[{ id: 'invoices', label: 'Invoice payments', count: rows.length }, { id: 'advances', label: 'Advances', count: adv.data?.length }]} />
      {tab === 'invoices' ? (
        <Card flush>
          <DataTable id="vendor-payments" rows={rows} loading={inv.isLoading} error={inv.error} refetch={inv.refetch} rowKey={(r) => r.id} rowLink={(r) => `/vendor/invoices/${r.id}`} columns={cols}
            initialSort={{ key: 'due_date', dir: 'desc' }} searchPlaceholder="Search invoice number or PO…" filters={[{ key: 'status', label: 'Status', value: (r) => r.status }]}
            empty={<div className="empty"><div className="empty__title">No payments to show yet</div><div>Invoices appear here once Equipcare has approved them for payment.</div></div>}
            mobile={{ title: (r) => <>{r.vendor_invoice_no ?? r.inv_ref}</>, badge: (r) => (r.status ? <Status value={r.status} /> : null), meta: (r) => [`PO ${r.po_no}`, fmtMoney(r.total_value, true), r.due_date ? `Due ${fmtDate(r.due_date)}` : '', r.paid_at ? `Paid ${fmtDate(r.paid_at)}` : '', r.payment_ref ? `Ref ${r.payment_ref}` : '', r.tds != null ? `TDS ${fmtMoney(r.tds)}` : '', r.advice_available ? <Advice key="a" r={r} /> : ''].filter(Boolean) }} />
        </Card>
      ) : (
        <Card flush>
          <DataTable id="vendor-advances" rows={adv.data} loading={adv.isLoading} error={adv.error} refetch={adv.refetch} rowKey={(r) => r.id} columns={advCols} searchPlaceholder="Search advance or PO…"
            empty={<div className="empty"><div className="empty__title">No advances</div><div>Advances Equipcare pays against your orders are listed here with how much has been adjusted.</div></div>}
            mobile={{ title: (r) => <>{r.adv_no}</>, badge: (r) => <Status value={r.status} />, meta: (r) => [r.po_no ?? r.contract_no ?? '', fmtMoney(r.amount, true), r.paid_date ? `Paid ${fmtDate(r.paid_date)}` : '', r.outstanding ? `${fmtMoney(r.outstanding, true)} to adjust` : ''].filter(Boolean) }} />
        </Card>
      )}
    </>
  );
}
