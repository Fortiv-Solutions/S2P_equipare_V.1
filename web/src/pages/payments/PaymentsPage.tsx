import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, HandCoins } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtLakh, fmtMoney } from '@/lib/format';
import { Badge, ButtonLink, Card, DecisionTag, Freshness, Kpi, PageHeader, Ref, Status, Tabs } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Bars } from '@/components/charts';

interface PayRow { id: number; inv_ref: string; vendor_invoice_no: string | null; vendor_name: string; po_no: string; status: string; total_value: number | null; due_date: string | null; paid_at: string | null; payment_ref: string | null; tds: number | null; advance_adjusted: number | null; balance_payable: number | null; overdue: boolean; dispute_hold: number; sap_doc_no: string | null; approved_at: string | null }
interface AdvRow { id: number; adv_no: string; vendor_name: string; vendor_id: number; po_no: string | null; contract_no: string | null; amount: number; status: string; outstanding: number; adjusted_amount: number; age_days: number | null; bucket: string | null; paid_date: string | null; requested_by_name: string | null; created_at: string; approval_no: string | null }
interface Reg { buckets: string[]; rows: AdvRow[]; by_vendor: { vendor: string; vendor_id: number; outstanding: number; buckets: number[] }[]; totals: { requested: number; approved: number; paid: number; adjusted: number; outstanding: number; bucket_totals: number[] }; baseline: string; target: string }

/** SCR-PAY-01 — invoice payment status and the advance register with ageing (FR-PAY-01, FR-PAY-03, RPT-10). */
export default function PaymentsPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') === 'advances' ? 'advances' : 'invoices';
  const setTab = (t: string) => { sp.set('tab', t); setSp(sp, { replace: true }); };
  const inv = useQuery<PayRow[]>({ queryKey: ['payments', 'invoices'], queryFn: () => api.get('/payments/invoices') });
  const adv = useQuery<Reg>({ queryKey: ['payments', 'advances'], queryFn: () => api.get('/payments/advances') });
  const [bucket, setBucket] = useState<string | null>(null);
  const rows = inv.data ?? [];
  const n = (s: string[]) => rows.filter((r) => s.includes(r.status)).length;
  const a = adv.data;
  const advRows = (a?.rows ?? []).filter((r) => !bucket || r.bucket === bucket);

  const invCols: Column<PayRow>[] = [
    { key: 'inv_ref', header: 'Invoice', render: (r) => <div><Ref to={`/invoices/${r.id}`}>{r.inv_ref}</Ref><div className="small subtle">{r.vendor_invoice_no}</div></div>, value: (r) => `${r.inv_ref} ${r.vendor_invoice_no ?? ''}`, nowrap: true },
    { key: 'vendor_name', header: 'Vendor', render: (r) => <span style={{ display: 'inline-block', minWidth: 150 }}>{r.vendor_name}</span> },
    { key: 'po_no', header: 'PO', render: (r) => <span className="mono">{r.po_no}</span> },
    { key: 'status', header: 'SAP status', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Status value={r.status} />{r.status === 'Matched' && !r.approved_at && <span className="small muted">Awaiting finance approval</span>}{r.dispute_hold ? <span className="small" style={{ color: 'var(--bad)' }}>Dispute hold</span> : null}</div>, value: (r) => r.status },
    { key: 'total_value', header: 'Invoice total', align: 'right', render: (r) => <span className="num">{fmtMoney(r.total_value)}</span>, value: (r) => r.total_value },
    { key: 'balance_payable', header: 'Balance payable', align: 'right', render: (r) => <span className="num">{fmtMoney(r.balance_payable)}</span>, value: (r) => r.balance_payable, hidden: true },
    { key: 'due_date', header: 'Due', render: (r) => <span style={{ color: r.overdue ? 'var(--bad)' : undefined, fontWeight: r.overdue ? 700 : 500 }}>{fmtDate(r.due_date)}{r.overdue ? ' · overdue' : ''}</span>, value: (r) => r.due_date, nowrap: true },
    { key: 'paid_at', header: 'Paid', render: (r) => fmtDate(r.paid_at), nowrap: true },
    { key: 'payment_ref', header: 'Payment ref', render: (r) => r.payment_ref ?? '—' },
    { key: 'tds', header: 'TDS', align: 'right', render: (r) => (r.tds != null ? fmtMoney(r.tds) : <span className="subtle">Not provided</span>), value: (r) => r.tds, hidden: true },
    { key: 'sap_doc_no', header: 'SAP document', render: (r) => r.sap_doc_no ?? '—', hidden: true },
  ];
  const advCols: Column<AdvRow>[] = [
    { key: 'adv_no', header: 'Advance', render: (r) => <Ref to={`/advances/${r.id}`}>{r.adv_no}</Ref>, nowrap: true },
    { key: 'vendor_name', header: 'Vendor', render: (r) => <span style={{ display: 'inline-block', minWidth: 150 }}>{r.vendor_name}</span> },
    { key: 'against', header: 'Against', render: (r) => <span className="mono">{r.po_no ?? r.contract_no ?? '—'}</span>, value: (r) => r.po_no ?? r.contract_no },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => <span className="num">{fmtMoney(r.amount, true)}</span>, value: (r) => r.amount },
    { key: 'status', header: 'Status', render: (r) => <Status value={r.status} /> },
    { key: 'outstanding', header: 'Outstanding', align: 'right', render: (r) => <span className="num" style={{ fontWeight: r.outstanding ? 700 : 500 }}>{r.outstanding ? fmtMoney(r.outstanding, true) : '—'}</span>, value: (r) => r.outstanding },
    { key: 'age_days', header: 'Age since paid', align: 'right', render: (r) => (r.age_days != null && r.outstanding ? `${r.age_days} d` : '—'), value: (r) => (r.outstanding ? r.age_days : null) },
    { key: 'bucket', header: 'Ageing bucket', render: (r) => (r.bucket ? <Badge tone={r.bucket.startsWith('>') || r.bucket.startsWith('61') ? 'warn' : 'neutral'}>{r.bucket}</Badge> : '—'), value: (r) => r.bucket },
    { key: 'paid_date', header: 'Paid in SAP', render: (r) => fmtDate(r.paid_date), nowrap: true },
    { key: 'requested_by_name', header: 'Requested by', hidden: true },
  ];

  return (
    <>
      <PageHeader
        title="Payments and advances" screen="SCR-PAY-01" eyebrow="Module 11"
        sub="Payment status comes from SAP (INT-M12); payments are executed in SAP. Advances are requested here and approved through the approval workflow."
        badges={<Freshness flow="INT-M12" label="Payment status" />}
        actions={<>
          {can('adv.request') && <ButtonLink to="/advances/new" variant="deep" icon={<HandCoins size={16} />}>Request advance</ButtonLink>}
          <a className="btn btn--secondary" href={downloadUrl('/payments/invoices', { format: 'csv' })}><Download size={16} /> Export invoices</a>
        </>}
      />
      <div className="grid-4" style={{ marginBottom: 18 }}>
        <Kpi label="Awaiting posting" value={n(['Matched', 'Parked'])} meta="Matched or parked, not yet posted" onClick={() => setTab('invoices')} />
        <Kpi label="Posted / payment due" value={n(['Posted', 'Payment due'])} tone={rows.some((r) => r.overdue) ? 'warn' : undefined} meta={`${rows.filter((r) => r.overdue).length} overdue`} onClick={() => setTab('invoices')} />
        <Kpi label="Advance outstanding" value={fmtLakh(a?.totals.outstanding)} meta="Paid, not yet adjusted (KPI-15)" onClick={() => setTab('advances')} />
        <Kpi label="Payment blocked" value={n(['Payment blocked'])} tone={n(['Payment blocked']) ? 'bad' : undefined} meta="Blocked in SAP" onClick={() => setTab('invoices')} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'invoices', label: 'Invoice payment status', count: rows.length }, { id: 'advances', label: 'Advance register', count: a?.rows.length }]} />

      {tab === 'invoices' ? (
        <Card flush>
          <DataTable id="payments-invoices" rows={rows} loading={inv.isLoading} error={inv.error} refetch={inv.refetch} rowKey={(r) => r.id} rowLink={(r) => `/invoices/${r.id}`} columns={invCols}
            initialSort={{ key: 'due_date', dir: 'desc' }} searchPlaceholder="Search invoice, vendor, PO, payment ref…"
            filters={[{ key: 'status', label: 'Status', value: (r) => r.status }, { key: 'vendor', label: 'Vendor', value: (r) => r.vendor_name }]}
            empty={<div className="empty"><div className="empty__title">No invoices have reached payment yet</div><div>Matched and approved invoices appear here once finance approves them; SAP then reports posting and payment.</div></div>}
            mobile={{ title: (r) => <><span className="mono">{r.inv_ref}</span> · {r.vendor_name}</>, badge: (r) => <Status value={r.status} />, meta: (r) => [`PO ${r.po_no}`, fmtMoney(r.total_value, true), r.due_date ? `Due ${fmtDate(r.due_date)}` : '', r.overdue ? 'Overdue' : '', r.payment_ref ?? ''].filter(Boolean) }} />
        </Card>
      ) : (
        <div className="stack">
          <Card title={<div className="row-wrap"><h2>Outstanding advances by vendor and age</h2><span className="small muted">Buckets from <span className="mono">pay.advance_buckets</span> <DecisionTag id="Q KPI-15" /></span></div>}>
            <div className="grid-4" style={{ marginBottom: 14 }}>
              {a?.buckets.map((b, i) => <Kpi key={b} label={b} value={fmtLakh(a.totals.bucket_totals[i])} tone={a.totals.bucket_totals[i] && i >= 2 ? 'warn' : undefined} onClick={() => setBucket(bucket === b ? null : b)} meta={bucket === b ? 'Filtering the list — select again to clear' : 'Select to filter'} />)}
            </div>
            <Bars title="Outstanding advance by vendor" format={(v) => fmtLakh(v)} legend={a?.buckets} data={(a?.by_vendor ?? []).map((v) => ({ label: v.vendor, value: v.outstanding, parts: v.buckets.map((x, i) => ({ label: a!.buckets[i], value: x })) }))} />
            <p className="small muted" style={{ marginTop: 10 }}>{a?.baseline} · {a?.target}. Requested {fmtLakh(a?.totals.requested)} · approved, unpaid {fmtLakh(a?.totals.approved)} · paid {fmtLakh(a?.totals.paid)} · adjusted {fmtLakh(a?.totals.adjusted)}.</p>
          </Card>
          <Card flush>
            <DataTable id="payments-advances" rows={advRows} loading={adv.isLoading} error={adv.error} refetch={adv.refetch} rowKey={(r) => r.id} rowLink={(r) => `/advances/${r.id}`} columns={advCols}
              initialSort={{ key: 'age_days', dir: 'desc' }} searchPlaceholder="Search advance, vendor, PO…"
              filters={[{ key: 'status', label: 'Status', value: (r) => r.status }, { key: 'vendor', label: 'Vendor', value: (r) => r.vendor_name }, { key: 'bucket', label: 'Ageing', value: (r) => r.bucket, options: a?.buckets }]}
              empty={<div className="empty"><div className="empty__title">No advances yet</div><div>Request an advance against a PO from the PO page or here.</div>{can('adv.request') && <ButtonLink to="/advances/new" variant="deep">Request advance</ButtonLink>}</div>}
              mobile={{ title: (r) => <><span className="mono">{r.adv_no}</span> · {r.vendor_name}</>, badge: (r) => <Status value={r.status} />, meta: (r) => [r.po_no ?? r.contract_no ?? '', fmtMoney(r.amount, true), r.outstanding ? `Outstanding ${fmtMoney(r.outstanding, true)}` : '', r.bucket ?? ''].filter(Boolean) }} />
          </Card>
        </div>
      )}
    </>
  );
}
