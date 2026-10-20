import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { UserPlus, Download, Check, X } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { Badge, Button, ButtonLink, Card, Freshness, Kpi, PageHeader, Ref, Status, Tabs } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { ReasonDialog } from '@/components/overlay';
import { Expiry, KycBadge } from './shared';

type Tab = 'all' | 'onboarding' | 'changes' | 'capabilities' | 'kyc';

interface VendorRow {
  id: number; sap_code: string | null; name: string; city: string | null; state: string | null; categories: string | null; portal_status: string;
  onboarding_status: string; kyc_state: string; kyc_issues: string[]; performance_score: number | null; sap_blocked: number; proposed_caps: number;
  pending_changes: number; portal_users: number; invited_category: string | null; submitted_at: string | null; created_at: string | null; invite_expired: boolean;
}

export default function VendorsPage() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'all';
  const setTab = (t: Tab) => { sp.set('tab', t); setSp(sp, { replace: true }); };
  const { can } = useAuth();
  const vendors = useQuery<VendorRow[]>({ queryKey: ['vendors', 'list'], queryFn: () => api.get('/vendors') });
  const changes = useQuery<any[]>({ queryKey: ['vendors', 'changes'], queryFn: () => api.get('/vendors/change-requests', { status: 'open' }) });
  const caps = useQuery<any[]>({ queryKey: ['vendors', 'caps'], queryFn: () => api.get('/vendors/capabilities', { status: 'Proposed' }) });
  const kyc = useQuery<any[]>({ queryKey: ['vendors', 'kyc'], queryFn: () => api.get('/vendors/documents/expiring') });
  const rows = vendors.data ?? [];
  const queue = rows.filter((v) => v.onboarding_status !== 'Active');
  const waiting = queue.filter((v) => ['Submitted', 'Under review'].includes(v.onboarding_status)).length;

  return (
    <>
      <PageHeader
        title="Vendors" screen="SCR-VPT internal" eyebrow="Module 9"
        sub="SAP vendor master with Equipcare's onboarding, KYC documents, capability mapping and portal access for each vendor."
        badges={<Freshness flow="INT-M01" label="Vendor master" />}
        actions={<>
          <a className="btn btn--secondary" href={downloadUrl('/vendors', { format: 'csv' })}><Download size={16} /> Export all</a>
          {can('vendor.onboard') && <ButtonLink to="/vendors/invite" variant="primary" icon={<UserPlus size={16} />}>Invite a vendor</ButtonLink>}
        </>}
      />
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <Kpi label="Active vendors" value={rows.filter((v) => v.onboarding_status === 'Active').length} meta={`${rows.filter((v) => v.sap_blocked).length} blocked in SAP`} onClick={() => setTab('all')} />
        <Kpi label="Onboarding to review" value={waiting} tone={waiting ? 'warn' : undefined} meta={`${queue.length} not yet active`} onClick={() => setTab('onboarding')} />
        <Kpi label="Change requests open" value={changes.data?.length ?? '—'} meta={`${changes.data?.filter((c) => c.high_risk).length ?? 0} bank changes`} onClick={() => setTab('changes')} />
        <Kpi label="KYC expiring or expired" value={kyc.data?.length ?? '—'} tone={kyc.data?.some((d) => d.days_left < 0) ? 'bad' : kyc.data?.length ? 'warn' : undefined} meta={`${caps.data?.length ?? 0} capability proposals`} onClick={() => setTab('kyc')} />
      </div>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'all', label: 'All vendors', count: rows.length },
        { id: 'onboarding', label: 'Onboarding queue', count: queue.length },
        { id: 'changes', label: 'Change requests', count: changes.data?.length },
        { id: 'capabilities', label: 'Capability proposals', count: caps.data?.length },
        { id: 'kyc', label: 'KYC expiring', count: kyc.data?.length },
      ]} />
      {tab === 'all' && <AllVendors q={vendors} />}
      {tab === 'onboarding' && <Onboarding rows={queue} q={vendors} />}
      {tab === 'changes' && <Changes q={changes} />}
      {tab === 'capabilities' && <Capabilities q={caps} />}
      {tab === 'kyc' && <Kyc q={kyc} />}
    </>
  );
}

function AllVendors({ q }: { q: { data?: VendorRow[]; isLoading: boolean; error: unknown; refetch: () => unknown } }) {
  return (
    <Card flush>
      <DataTable<VendorRow>
        id="vendors" rows={q.data} loading={q.isLoading} error={q.error} refetch={() => q.refetch()} rowKey={(r) => r.id} rowLink={(r) => `/vendors/${r.id}`}
        searchPlaceholder="Search name, SAP code, city…"
        columns={[
          { key: 'sap_code', header: 'SAP code', render: (r) => (r.sap_code ? <Ref to={`/vendors/${r.id}`}>{r.sap_code}</Ref> : <span className="subtle">No code</span>), nowrap: true },
          { key: 'name', header: 'Vendor', render: (r) => <span style={{ fontWeight: 600 }}>{r.name}</span> },
          { key: 'city', header: 'City', render: (r) => <>{r.city ?? '—'}<span className="small subtle" style={{ display: 'block' }}>{r.state}</span></> },
          { key: 'categories', header: 'Categories', render: (r) => <div className="row-wrap" style={{ gap: 4 }}>{(r.categories ?? r.invited_category ?? '').split(',').filter(Boolean).map((c) => <span key={c} className="chip">{c}</span>)}</div> },
          { key: 'portal_status', header: 'Portal', render: (r) => <Status value={r.portal_status} /> },
          { key: 'onboarding_status', header: 'Onboarding', render: (r) => <Status value={r.onboarding_status} /> },
          { key: 'kyc_state', header: 'KYC', render: (r) => <span title={r.kyc_issues.join(', ')}><KycBadge state={r.kyc_state} /></span> },
          { key: 'performance_score', header: 'Score', align: 'right', render: (r) => (r.performance_score != null ? <span className="num">{r.performance_score}</span> : '—') },
          { key: 'sap_blocked', header: 'Blocked', render: (r) => (r.sap_blocked ? <Badge tone="bad">Blocked in SAP</Badge> : <span className="subtle">No</span>), value: (r) => (r.sap_blocked ? 'Blocked' : 'No') },
          { key: 'portal_users', header: 'Portal users', align: 'right', hidden: true },
        ]}
        filters={[
          { key: 'onboarding', label: 'Onboarding', value: (r) => r.onboarding_status },
          { key: 'kyc', label: 'KYC', value: (r) => r.kyc_state },
          { key: 'portal', label: 'Portal', value: (r) => r.portal_status },
          { key: 'blocked', label: 'Blocked', value: (r) => (r.sap_blocked ? 'Blocked in SAP' : 'Not blocked') },
        ]}
        mobile={{ title: (r) => r.name, badge: (r) => <Status value={r.onboarding_status} />, meta: (r) => [r.sap_code ?? 'No SAP code', r.city ?? '—', `KYC ${r.kyc_state.toLowerCase()}`, r.categories ?? ''] }}
        empty={<div className="empty"><div className="empty__title">No vendors yet</div><div>Vendors arrive from the SAP vendor master or by invitation.</div></div>}
      />
    </Card>
  );
}

function Onboarding({ rows, q }: { rows: VendorRow[]; q: { isLoading: boolean; error: unknown; refetch: () => unknown } }) {
  return (
    <Card flush>
      <DataTable<VendorRow>
        id="vendors-onboarding" rows={rows} loading={q.isLoading} error={q.error} refetch={() => q.refetch()} rowKey={(r) => r.id} rowLink={(r) => `/vendors/${r.id}`}
        initialSort={{ key: 'submitted_at', dir: 'asc' }}
        columns={[
          { key: 'name', header: 'Vendor', render: (r) => <span style={{ fontWeight: 600 }}>{r.name}</span> },
          { key: 'invited_category', header: 'Category', render: (r) => r.invited_category ?? r.categories ?? '—' },
          { key: 'onboarding_status', header: 'Status', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Status value={r.onboarding_status} />{r.invite_expired && <span className="small" style={{ color: 'var(--bad)' }}>Invitation link expired</span>}</div> },
          { key: 'kyc_state', header: 'Documents', render: (r) => <KycBadge state={r.kyc_state} /> },
          { key: 'proposed_caps', header: 'Capabilities to review', align: 'right' },
          { key: 'submitted_at', header: 'Submitted', render: (r) => fmtDateTime(r.submitted_at), nowrap: true },
          { key: 'created_at', header: 'Invited', render: (r) => fmtDate(r.created_at), nowrap: true },
        ]}
        filters={[{ key: 'status', label: 'Status', value: (r) => r.onboarding_status }]}
        mobile={{ title: (r) => r.name, badge: (r) => <Status value={r.onboarding_status} />, meta: (r) => [r.invited_category ?? '—', `Submitted ${fmtDate(r.submitted_at)}`] }}
        empty={<div className="empty"><div className="empty__title">No vendors in onboarding</div><div>Invite a new vendor to start WF-06.</div></div>}
      />
    </Card>
  );
}

function Changes({ q }: { q: { data?: any[]; isLoading: boolean; error: unknown; refetch: () => unknown } }) {
  return (
    <Card flush>
      <DataTable<any>
        id="vendor-changes" rows={q.data} loading={q.isLoading} error={q.error} refetch={() => q.refetch()} rowKey={(r) => r.id} rowLink={(r) => `/vendors/${r.vendor_id}?tab=changes`}
        columns={[
          { key: 'vendor_name', header: 'Vendor', render: (r) => <><span style={{ fontWeight: 600 }}>{r.vendor_name}</span><span className="small subtle mono" style={{ display: 'block' }}>{r.sap_code}</span></> },
          { key: 'field_label', header: 'Change', render: (r) => <div className="row-wrap">{r.field_label}{r.high_risk ? <Badge tone="bad">High risk</Badge> : null}</div> },
          { key: 'old_value', header: 'Current (SAP)', render: (r) => <span className="mono small">{r.old_value ?? '—'}</span> },
          { key: 'new_value', header: 'Requested', render: (r) => <span className="mono small">{r.new_value}</span> },
          { key: 'status', header: 'Status', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Status value={r.status} />{r.approval_no && <Ref to={`/approvals/${r.approval_id}`}>{r.approval_no}</Ref>}</div> },
          { key: 'requested_by_name', header: 'Requested by' },
          { key: 'created_at', header: 'Raised', render: (r) => fmtDateTime(r.created_at), nowrap: true },
        ]}
        filters={[{ key: 'status', label: 'Status', value: (r) => r.status }, { key: 'field', label: 'Change', value: (r) => r.field_label }]}
        mobile={{ title: (r) => `${r.vendor_name} — ${r.field_label}`, badge: (r) => <Status value={r.status} />, meta: (r) => [r.new_value, fmtDate(r.created_at)] }}
        empty={<div className="empty"><div className="empty__title">No open change requests</div><div>Vendors request profile and bank changes from their portal profile.</div></div>}
      />
    </Card>
  );
}

function Capabilities({ q }: { q: { data?: any[]; isLoading: boolean; error: unknown; refetch: () => unknown } }) {
  const { can } = useAuth();
  const [reject, setReject] = useState<any | null>(null);
  const decide = useAction((id: number, decision: string, note?: string) => api.post(`/vendors/capabilities/${id}/decide`, { decision, note }), {
    success: (_r) => 'Capability decision recorded', invalidate: [['vendors']],
  });
  return (
    <Card flush>
      <DataTable<any>
        id="vendor-caps" rows={q.data} loading={q.isLoading} error={q.error} refetch={() => q.refetch()} rowKey={(r) => r.id}
        columns={[
          { key: 'vendor_name', header: 'Vendor', render: (r) => <Ref to={`/vendors/${r.vendor_id}`}>{r.vendor_name}</Ref> },
          { key: 'category', header: 'Category', render: (r) => <>{r.category} <span className="small muted">{r.category_name}</span></> },
          { key: 'sub_category', header: 'Sub-category' },
          { key: 'supplier_role', header: 'Supplier role' },
          { key: 'brand', header: 'Brand' },
          { key: 'region', header: 'Region' },
          { key: 'onboarding_status', header: 'Vendor status', render: (r) => <Status value={r.onboarding_status} /> },
          { key: 'actions', header: '', sortable: false, exportable: false, render: (r) => can('vendor.onboard') ? (
            <div className="row">
              <Button size="sm" variant="ok" icon={<Check />} loading={decide.busy} onClick={() => decide.fire(r.id, 'Approved')}>Approve</Button>
              <Button size="sm" variant="ghost" icon={<X />} onClick={() => setReject(r)}>Reject</Button>
            </div>
          ) : null },
        ]}
        mobile={{ title: (r) => `${r.vendor_name} — ${r.category}`, meta: (r) => [r.sub_category ?? '—', r.supplier_role ?? '—'] }}
        empty={<div className="empty"><div className="empty__title">No capability proposals waiting</div><div>Vendors propose what they supply during onboarding or from their profile (FR-VPT-13).</div></div>}
      />
      <ReasonDialog open={!!reject} onClose={() => setReject(null)} title={`Reject ${reject?.category ?? ''} capability`} sub="The vendor sees this reason." confirmLabel="Reject capability" variant="danger"
        onSubmit={(r) => decide.run(reject.id, 'Rejected', r)} />
    </Card>
  );
}

function Kyc({ q }: { q: { data?: any[]; isLoading: boolean; error: unknown; refetch: () => unknown } }) {
  return (
    <Card flush>
      <DataTable<any>
        id="vendor-kyc" rows={q.data} loading={q.isLoading} error={q.error} refetch={() => q.refetch()} rowKey={(r) => r.id} rowLink={(r) => `/vendors/${r.vendor_id}?tab=documents`}
        initialSort={{ key: 'expiry_date', dir: 'asc' }}
        columns={[
          { key: 'vendor_name', header: 'Vendor', render: (r) => <span style={{ fontWeight: 600 }}>{r.vendor_name}</span> },
          { key: 'sap_code', header: 'SAP code', render: (r) => <span className="mono">{r.sap_code ?? '—'}</span> },
          { key: 'doc_type', header: 'Document', render: (r) => <div className="row-wrap">{r.doc_type}{r.mandatory ? <Badge plain tone="info">Mandatory</Badge> : null}</div> },
          { key: 'expiry_date', header: 'Expiry', render: (r) => <Expiry date={r.expiry_date} /> },
          { key: 'status', header: 'Status', render: (r) => <Status value={r.status} /> },
          { key: 'impact', header: 'Impact', render: (r) => (r.days_left < 0 && r.mandatory ? <span className="small" style={{ color: 'var(--bad)' }}>Excluded from RFQ suggestions</span> : <span className="small muted">Reminder sent (NTF-25)</span>), sortable: false },
        ]}
        filters={[{ key: 'status', label: 'Status', value: (r) => r.status }, { key: 'doc', label: 'Document', value: (r) => r.doc_type }]}
        mobile={{ title: (r) => `${r.vendor_name} — ${r.doc_type}`, badge: (r) => <Status value={r.status} />, meta: (r) => [fmtDate(r.expiry_date), `${r.days_left} d`] }}
        empty={<div className="empty"><div className="empty__title">No documents expiring</div><div>Documents inside the reminder lead time appear here.</div></div>}
      />
    </Card>
  );
}
