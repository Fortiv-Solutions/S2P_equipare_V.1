import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FilePlus2, Lightbulb, CalendarClock, ShieldAlert, Download } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtLakh, fmtMoney, plural } from '@/lib/format';
import { Badge, ButtonLink, Button, Callout, Card, Freshness, Kpi, PageHeader, Ref, Status, Tabs, Empty } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { ReasonDialog } from '@/components/overlay';
import { UtilBar } from './shared';
import type { AlertRow, ContractRow, Summary } from './types';

type Tab = 'all' | 'active' | 'expiring' | 'pending_sap' | 'alerts';

export default function ContractsPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'all';
  const setTab = (t: Tab) => { sp.set('tab', t); sp.delete('alert'); setSp(sp, { replace: true }); };
  const summary = useQuery<Summary>({ queryKey: ['contracts', 'summary'], queryFn: () => api.get('/contracts/summary') });
  const s = summary.data;

  return (
    <>
      <PageHeader
        title="Contracts" screen="SCR-CON-01" eyebrow="Module 6"
        sub="SAP outline agreements stay the official record. Here you track validity, utilisation and compliance, and prepare new contracts for SAP: ARC, OA, fixed discount structures, VMI and fixed-supplier."
        badges={<Freshness flow="INT-M06" label="OAs" />}
        actions={<>
          <ButtonLink to="/contracts/renewals" icon={<CalendarClock size={16} />}>Renewals</ButtonLink>
          <ButtonLink to="/contracts/opportunities" icon={<Lightbulb size={16} />}>Opportunities</ButtonLink>
          {can('con.manage') && <ButtonLink to="/contracts/new" variant="primary" icon={<FilePlus2 size={16} />}>New contract</ButtonLink>}
        </>}
      />
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <Kpi label="Active" value={s?.active ?? '—'} meta={s ? `${fmtLakh(s.value_in_force)} value cap in force` : undefined} onClick={() => setTab('active')} />
        <Kpi label="Expiring" value={s?.expiring ?? '—'} tone={s?.expiring ? 'warn' : undefined} meta="Within renewal lead time" onClick={() => setTab('expiring')} />
        <Kpi label="Pending SAP" value={s?.pending_sap ?? '—'} meta="Approved, cannot route PRs yet" onClick={() => setTab('pending_sap')} />
        <Kpi label="Off-contract alerts" value={s?.alerts ?? '—'} tone={s?.alerts ? 'bad' : undefined} meta="Open or awaiting approval" onClick={() => setTab('alerts')} />
      </div>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'all', label: 'All', count: s?.all }, { id: 'active', label: 'Active', count: s?.active }, { id: 'expiring', label: 'Expiring', count: s?.expiring },
        { id: 'pending_sap', label: 'Pending SAP', count: s?.pending_sap }, { id: 'alerts', label: 'Off-contract alerts', count: s?.alerts },
      ]} />
      {tab === 'alerts' ? <AlertsView focus={Number(sp.get('alert')) || undefined} /> : <ContractList tab={tab} />}
    </>
  );
}

function ContractList({ tab }: { tab: Exclude<Tab, 'alerts'> }) {
  const { can } = useAuth();
  const q = useQuery<ContractRow[]>({ queryKey: ['contracts', 'list', tab], queryFn: () => api.get('/contracts', { tab }) });
  const columns: Column<ContractRow>[] = useMemo(() => [
    { key: 'contract_no', header: 'Contract', nowrap: true, render: (r) => <div><Ref to={`/contracts/${r.id}`}>{r.contract_no}</Ref><div className="small subtle">{r.sap_oa_no ? <>SAP OA <span className="mono">{r.sap_oa_no}</span></> : 'No SAP OA yet'}</div></div>, value: (r) => `${r.contract_no} ${r.sap_oa_no ?? ''}` },
    { key: 'title', header: 'Title & scope', render: (r) => <div style={{ minWidth: 220 }}><div style={{ fontWeight: 600 }}>{r.title}</div><div className="small subtle mono">{r.scope || '—'}</div></div>, value: (r) => `${r.title} ${r.scope}` },
    { key: 'type', header: 'Type', render: (r) => <Badge tone="deep">{r.type}</Badge> },
    { key: 'vendor_name', header: 'Vendor', render: (r) => <div><div>{r.vendor_name}</div><div className="small subtle mono">{r.vendor_sap_code ?? '—'}</div></div> },
    { key: 'category', header: 'Category', hidden: true, render: (r) => r.category_name ?? r.category ?? '—' },
    { key: 'valid_to', header: 'Validity', nowrap: true, render: (r) => <div><div>{fmtDate(r.valid_from)} – {fmtDate(r.valid_to)}</div><div className="small" style={{ color: r.days_to_expiry < 0 ? 'var(--bad)' : r.status === 'Expiring' ? 'var(--warn)' : 'var(--text-3)', fontWeight: r.status === 'Expiring' ? 600 : 400 }}>{r.days_to_expiry < 0 ? `Ended ${-r.days_to_expiry} d ago` : `${r.days_to_expiry} d left`}</div></div> },
    { key: 'status', header: 'Status', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Status value={r.status} />{r.status === 'Pending SAP' && <span className="small subtle">Not routable</span>}</div> },
    { key: 'utilisation_pct', header: 'Utilisation', render: (r) => <UtilBar pct={r.utilisation_pct} />, value: (r) => r.utilisation_pct ?? -1 },
    { key: 'value_cap', header: 'Value cap', align: 'right', hidden: true, render: (r) => fmtLakh(r.value_cap) },
    { key: 'owner_name', header: 'Owner', hidden: true },
    { key: 'plant', header: 'Plant', hidden: true, render: (r) => (r.plant === '*' ? 'All plants' : r.plant) },
  ], []);
  return (
    <Card flush>
      {tab === 'pending_sap' && (
        <div style={{ padding: '12px 14px 0' }}>
          <Callout tone="info" title="Approved in the platform, waiting for the SAP outline agreement">PRs cannot route to these contracts until SAP creates the OA and it syncs back (FR-CON-09).</Callout>
        </div>
      )}
      <DataTable
        id={`contracts-${tab}`} rows={q.data} loading={q.isLoading} error={q.error} refetch={q.refetch} rowKey={(r) => r.id} rowLink={(r) => `/contracts/${r.id}`} columns={columns}
        filters={[
          { key: 'vendor', label: 'Vendor', value: (r) => r.vendor_name },
          { key: 'category', label: 'Category', value: (r) => r.category_name ?? r.category },
          { key: 'type', label: 'Type', value: (r) => r.type },
          { key: 'status', label: 'Status', value: (r) => r.status },
        ]}
        searchPlaceholder="Search contract, SAP OA, vendor, material…"
        toolbar={<a className="btn btn--ghost btn--sm" href={downloadUrl('/contracts', { tab, format: 'csv' })}><Download size={14} /> Export all</a>}
        empty={<Empty title="No contracts in this view" action={can('con.manage') ? <ButtonLink to="/contracts/new" variant="primary">New contract</ButtonLink> : undefined}>Contracts arrive from SAP outline agreements on the next sync, or create one here.</Empty>}
        mobile={{
          title: (r) => <><span className="mono">{r.contract_no}</span> · {r.title}</>,
          badge: (r) => <Status value={r.status} />,
          meta: (r) => [r.type, r.vendor_name, `to ${fmtDate(r.valid_to)}`, r.utilisation_pct != null ? `${Math.round(r.utilisation_pct * 100)}% used` : 'No cap'],
        }}
      />
    </Card>
  );
}

function AlertsView({ focus }: { focus?: number }) {
  const { can } = useAuth();
  const [view, setView] = useState<'open' | 'all'>('open');
  const q = useQuery<AlertRow[]>({ queryKey: ['contracts', 'alerts', view], queryFn: () => api.get('/contracts/alerts', view === 'open' ? { status: 'open' } : undefined) });
  const [dlg, setDlg] = useState<{ row: AlertRow; kind: 'justify' | 'dismiss' } | null>(null);
  const justify = useAction((id: number, reason: string) => api.post(`/contracts/alerts/${id}/justify`, { reason }), { success: 'Justification sent for off-contract approval', invalidate: [['contracts']] });
  const dismiss = useAction((id: number, reason: string) => api.post(`/contracts/alerts/${id}/dismiss`, { reason }), { success: 'Alert dismissed', invalidate: [['contracts']] });
  const columns: Column<AlertRow>[] = [
    { key: 'po_no', header: 'SAP PO', nowrap: true, render: (r) => <div><Ref to={`/pos/${r.po_id}`}>{`${r.po_no}/${r.item}`}</Ref><div className="small subtle">{fmtDate(r.po_date)} · {r.plant}</div></div>, value: (r) => `${r.po_no}/${r.item}` },
    { key: 'material_code', header: 'Material', render: (r) => <div style={{ minWidth: 180 }}><div style={{ fontWeight: 600 }}>{r.description}</div><div className="small subtle mono">{r.material_code} · {r.qty} {r.uom}</div></div> },
    { key: 'po_vendor', header: 'Bought from', render: (r) => <div><div>{r.po_vendor}</div><div className="small subtle">{fmtMoney(r.unit_price)} / {r.uom}</div></div> },
    { key: 'contract_no', header: 'Valid contract', render: (r) => <div><Ref to={`/contracts/${r.contract_id}`}>{r.contract_no}</Ref><div className="small subtle">{r.contract_type} · OA <span className="mono">{r.sap_oa_no}</span> · {r.contract_vendor} · {fmtMoney(r.contract_price)}</div></div> },
    { key: 'price_variance', header: 'Extra cost', align: 'right', render: (r) => (r.price_variance == null ? '—' : <span style={{ color: r.price_variance > 0 ? 'var(--bad)' : undefined, fontWeight: 600 }}>{fmtMoney(r.price_variance, true)}</span>), value: (r) => r.price_variance },
    { key: 'buyer_name', header: 'Buyer' },
    { key: 'status', header: 'Status', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Status value={r.status} />{r.req_no && <Ref to={`/approvals/${r.approval_id}`}>{r.req_no}</Ref>}{r.reason && <span className="small muted" style={{ maxWidth: 220 }}>{r.reason}</span>}</div> },
    { key: 'actions', header: '', sortable: false, exportable: false, render: (r) => (r.status === 'Open' && can('con.manage') ? (
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button size="sm" variant="decision" onClick={() => setDlg({ row: r, kind: 'justify' })}>Record justification</Button>
        <Button size="sm" variant="ghost" onClick={() => setDlg({ row: r, kind: 'dismiss' })}>Dismiss</Button>
      </div>) : null) },
  ];
  const rows = q.data;
  return (
    <Card flush title={<div className="row-wrap"><ShieldAlert size={18} color="var(--bad)" /><h2>Off-contract purchases</h2><span className="small muted">SAP POs without contract reference while a valid ARC / OA / FDS existed (CON-03)</span></div>}
      actions={<div className="seg" role="group" aria-label="Show"><button aria-pressed={view === 'open'} onClick={() => setView('open')}>Open</button><button aria-pressed={view === 'all'} onClick={() => setView('all')}>All</button></div>}>
      {focus && rows && !rows.some((r) => r.id === focus) && view === 'open' && <div style={{ padding: '10px 14px 0' }}><Callout tone="info">The alert you opened is no longer open. <Button size="sm" variant="ghost" onClick={() => setView('all')}>Show all alerts</Button></Callout></div>}
      <DataTable
        id="contract-alerts" rows={rows} loading={q.isLoading} error={q.error} refetch={q.refetch} rowKey={(r) => r.id} columns={columns}
        rowTone={(r) => (r.id === focus ? 'selected' : undefined)}
        filters={[{ key: 'status', label: 'Status', value: (r) => r.status }, { key: 'contract', label: 'Contract', value: (r) => r.contract_no }]}
        empty={<Empty title="No off-contract alerts">Synced SAP POs are checked against valid contracts as they arrive.</Empty>}
        mobile={{
          title: (r) => <><span className="mono">{r.po_no}/{r.item}</span> · {r.material_code}</>, badge: (r) => <Status value={r.status} />,
          meta: (r) => [r.po_vendor, `Contract ${r.contract_no}`, r.price_variance != null ? `Extra ${fmtMoney(r.price_variance, true)}` : '', ...(r.status === 'Open' && can('con.manage') ? [<Button key="j" size="sm" variant="decision" onClick={() => setDlg({ row: r, kind: 'justify' })}>Record justification</Button>, <Button key="d" size="sm" variant="ghost" onClick={() => setDlg({ row: r, kind: 'dismiss' })}>Dismiss</Button>] : [])],
        }}
      />
      <ReasonDialog open={dlg?.kind === 'justify'} onClose={() => setDlg(null)} title={`Justify off-contract PO ${dlg?.row.po_no}/${dlg?.row.item}`} variant="decision" confirmLabel="Send for approval" label="Justification"
        sub={dlg ? `${dlg.row.contract_no} (${dlg.row.contract_vendor}) covered ${dlg.row.material_code}. The Procurement Manager approves the exception; it is logged in the exception register.` : undefined}
        onSubmit={(r) => justify.run(dlg!.row.id, r)} />
      <ReasonDialog open={dlg?.kind === 'dismiss'} onClose={() => setDlg(null)} title={`Dismiss alert for ${dlg?.row.po_no}/${dlg?.row.item}`} confirmLabel="Dismiss alert"
        sub="Use when the contract did not apply (e.g. different specification). The reason is audited." onSubmit={(r) => dismiss.run(dlg!.row.id, r)} />
      {rows && rows.length > 0 && <div className="small muted" style={{ padding: '0 14px 12px' }}>{plural(rows.filter((r) => r.status === 'Open').length, 'alert')} waiting for a decision.</div>}
    </Card>
  );
}
