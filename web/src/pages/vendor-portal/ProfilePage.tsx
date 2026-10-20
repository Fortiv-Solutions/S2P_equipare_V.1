/** SCR-VPT-02 vendor profile & KYC (FR-VPT-02, FR-VPT-15). */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Landmark, Pencil, UserPlus, X as XIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { ago, fmtDate, fmtDateTime } from '@/lib/format';
import { Badge, Button, Callout, Card, Freshness, KV, Loader, PageHeader, Status, Tabs } from '@/components/ui';
import { ErrorSummary, Field, Input, Select, fieldError } from '@/components/forms';
import { Modal, ReasonDialog } from '@/components/overlay';
import { FileDrop, type Uploaded } from '@/components/Attachments';
import { DataTable } from '@/components/DataTable';
import { DocStatus, Expiry, KycBadge, fileLink } from '../vendors/shared';
import { CapabilityForm, CapabilityTable, DocumentUpload } from './OnboardingPage';
import { TempPasswordModal, userState } from '../admin/userParts';

type Tab = 'profile' | 'documents' | 'capabilities' | 'changes' | 'users';

export default function VendorProfilePage() {
  const q = useQuery<any>({ queryKey: ['vendor-profile'], queryFn: () => api.get('/vendors/me') });
  return (
    <>
      <PageHeader title="Profile & documents" screen="SCR-VPT-02" sub="Your company record, KYC documents, capabilities and portal users. Master data comes from SAP; changes you request are reviewed by Equipcare before SAP is updated." />
      <Loader q={q} rows={8}>{(p) => <Profile p={p} />}</Loader>
    </>
  );
}

function Profile({ p }: { p: any }) {
  const [tab, setTab] = useState<Tab>('profile');
  const v = p.vendor;
  const active = v.onboarding_status === 'Active';
  return (
    <div className="stack">
      {!active && <Callout tone="info" title="Your application is not active yet">Finish and track it in <Link to="/vendor/onboarding">Registration & onboarding</Link>. Change requests open once your SAP vendor code is linked.</Callout>}
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'profile', label: 'Company & bank' }, { id: 'documents', label: 'Documents', count: p.kyc.expired.length + p.kyc.expiring.length || undefined },
        { id: 'capabilities', label: 'Capabilities' }, { id: 'changes', label: 'Change requests', count: p.change_requests.filter((c: any) => ['Pending', 'Approved', 'Sent to SAP'].includes(c.status)).length || undefined },
        ...(p.is_vendor_admin ? [{ id: 'users' as Tab, label: 'Portal users', count: p.users.length }] : []),
      ]} />
      {tab === 'profile' && <Company p={p} active={active} />}
      {tab === 'documents' && <Docs p={p} active={active} />}
      {tab === 'capabilities' && (
        <Card title="Capabilities" actions={<span className="small muted">Approved rows are used for RFQ suggestions</span>}>
          <div className="stack"><CapabilityTable rows={p.capabilities} /><CapabilityForm categories={p.categories} roles={p.supplier_roles} /></div>
        </Card>
      )}
      {tab === 'changes' && <Changes p={p} active={active} />}
      {tab === 'users' && p.is_vendor_admin && <Users p={p} />}
      <span hidden>{v.id}</span>
    </div>
  );
}

function Company({ p, active }: { p: any; active: boolean }) {
  const v = p.vendor;
  return (
    <div className="split">
      <div className="stack">
        <Card title="Company" actions={v.sap_code ? <Freshness flow="INT-M01" label="Vendor master" /> : undefined}>
          <KV cols items={[
            ['SAP vendor code', <span className="mono">{v.sap_code ?? 'Pending'}</span>], ['Legal name', v.legal_name], ['Registered address', v.address],
            ['City / state', [v.city, v.state].filter(Boolean).join(', ')], ['GSTIN', <><span className="mono">{v.gstin ?? '—'}</span> {v.gstin && (v.gstin_valid ? <Badge tone="ok">Valid</Badge> : <Badge tone="bad">Check digit invalid</Badge>)}</>],
            ['PAN', <span className="mono">{v.pan ?? '—'}</span>], ['MSME', v.msme_no ? `${v.msme_category} · ${v.msme_no}` : 'Not registered'],
          ]} />
        </Card>
        <Card title="Bank account"><KV cols items={[['Bank', v.bank_name], ['Account (masked)', <span className="mono">{v.bank_account_masked ?? '—'}</span>], ['IFSC', <span className="mono">{v.bank_ifsc ?? '—'}</span>], ['Status', v.bank_account_masked ? <Badge tone="ok">On file in SAP</Badge> : <Badge tone="warn">Not on file</Badge>]]} />
          <p className="small muted" style={{ marginTop: 10 }}>Bank changes need Equipcare finance approval and show here only after SAP is updated.</p></Card>
      </div>
      <div className="stack">
        <Card title="Contacts"><KV items={[['Primary contact', v.contact_name], ['E-mail', v.contact_email], ['Phone', v.contact_phone]]} />
          {p.contacts.length > 1 && <ul className="list-plain stack-sm" style={{ marginTop: 10 }}>{p.contacts.slice(1).map((c: any, i: number) => <li key={i} className="small"><strong>{c.name}</strong> · {c.role} · {c.email}</li>)}</ul>}</Card>
        <Card title="Status"><KV items={[['Onboarding', <Status value={v.onboarding_status} />], ['Portal', <Status value={v.portal_status} />], ['KYC', <KycBadge state={p.kyc.state} />], ['SAP block', v.sap_blocked ? <Badge tone="bad">Blocked</Badge> : 'Not blocked']]} />
          {!active && <p className="small muted">Master fields are read from your application until SAP creates your vendor record.</p>}</Card>
      </div>
    </div>
  );
}

function Docs({ p, active }: { p: any; active: boolean }) {
  const [renew, setRenew] = useState<string | null>(null);
  const rows = p.documents.filter((d: any) => d.status !== 'Superseded');
  return (
    <div className="stack">
      {p.kyc.expired.length > 0 && <Callout tone="bad" title="Expired mandatory documents">{p.kyc.expired.join(', ')} — upload renewed copies. New RFQ invitations are paused until they are approved.</Callout>}
      {p.kyc.expiring.length > 0 && <Callout tone="warn" title="Documents expiring soon">{p.kyc.expiring.join(', ')} — upload the renewed version before it expires.</Callout>}
      <Card flush title="Documents" actions={<span className="small muted">Uploading a new version keeps the old one until Equipcare approves it</span>}>
        <DataTable<any>
          id="vendor-profile-docs" rows={rows} rowKey={(r) => r.id} savedViews={false}
          columns={[
            { key: 'doc_type', header: 'Document', render: (r) => <div className="row-wrap">{r.doc_type}{r.mandatory ? <Badge plain tone="info">Mandatory</Badge> : null}</div> },
            { key: 'filename', header: 'File', render: (r) => fileLink(r.attachment_id, r.filename) },
            { key: 'expiry_date', header: 'Expiry', render: (r) => <Expiry date={r.expiry_date} /> },
            { key: 'status', header: 'Status', render: (r) => <DocStatus d={r} /> },
            { key: 'created_at', header: 'Uploaded', render: (r) => fmtDate(r.created_at), nowrap: true },
            { key: 'act', header: '', sortable: false, exportable: false, render: (r) => <Button size="sm" onClick={() => setRenew(r.doc_type)}>Upload new version</Button> },
          ]}
          mobile={{ title: (r) => r.doc_type, badge: (r) => <Status value={r.status} />, meta: (r) => [r.expiry_date ? `Expires ${fmtDate(r.expiry_date)}` : 'No expiry'] }}
          empty={<div className="empty"><div className="empty__title">No documents yet</div><div>Upload your KYC documents below.</div></div>}
        />
      </Card>
      <Card title="Upload a document" ><DocumentUpload key={renew ?? 'new'} vendorId={p.vendor.id} types={p.document_types} mandatory={p.mandatory_types} initialType={renew ?? undefined} onDone={() => setRenew(null)} /></Card>
      <span hidden>{String(active)}</span>
    </div>
  );
}

function Changes({ p, active }: { p: any; active: boolean }) {
  const [open, setOpen] = useState<'field' | 'bank' | null>(null);
  const withdraw = useAction((id: number) => api.post(`/vendors/me/change-requests/${id}/withdraw`), { success: 'Change request withdrawn', invalidate: [['vendor-profile']] });
  return (
    <div className="stack">
      <Card title="Request a change" actions={active ? <div className="row-wrap"><Button size="sm" icon={<Pencil />} onClick={() => setOpen('field')}>Change company or contact detail</Button><Button size="sm" variant="deep" icon={<Landmark />} onClick={() => setOpen('bank')}>Change bank account</Button></div> : undefined}>
        {active ? <p className="small muted" style={{ margin: 0 }}>Changes go to Equipcare for review. Company master data is updated in SAP only after approval, and your profile shows the new value once SAP returns it. Bank changes are high-risk and need finance approval.</p>
          : <p className="small muted" style={{ margin: 0 }}>Available when your SAP vendor code is active. Until then edit the onboarding form.</p>}
      </Card>
      <Card flush title="Your requests">
        <DataTable<any>
          id="vendor-my-changes" rows={p.change_requests} rowKey={(r) => r.id} savedViews={false}
          columns={[
            { key: 'field_label', header: 'Change', render: (r) => <div className="row-wrap">{r.field_label}{r.high_risk ? <Badge tone="bad">High risk</Badge> : null}</div> },
            { key: 'old_value', header: 'Current', render: (r) => <span className="mono small">{r.old_value ?? '—'}</span> },
            { key: 'new_value', header: 'Requested', render: (r) => <span className="mono small">{r.new_value}</span> },
            { key: 'status', header: 'Status', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Status value={r.status} />{r.decision_note && <span className="small muted">{r.decision_note}</span>}<span className="small subtle">{r.status === 'Sent to SAP' ? 'Waiting for SAP to update the master' : r.status === 'Applied' ? `Applied ${fmtDate(r.applied_at ?? r.decided_at)}` : ''}</span></div> },
            { key: 'created_at', header: 'Raised', render: (r) => fmtDateTime(r.created_at), nowrap: true },
            { key: 'act', header: '', sortable: false, exportable: false, render: (r) => (r.status === 'Pending' ? <Button size="sm" variant="ghost" icon={<XIcon />} onClick={() => withdraw.fire(r.id)}>Withdraw</Button> : null) },
          ]}
          mobile={{ title: (r) => r.field_label, badge: (r) => <Status value={r.status} />, meta: (r) => [r.new_value, fmtDate(r.created_at)] }}
          empty={<div className="empty"><div className="empty__title">No change requests</div><div>Use the buttons above when a company or bank detail changes.</div></div>}
        />
      </Card>
      {open === 'field' && <FieldChange p={p} onClose={() => setOpen(null)} />}
      {open === 'bank' && <BankChange onClose={() => setOpen(null)} />}
    </div>
  );
}

function FieldChange({ p, onClose }: { p: any; onClose: () => void }) {
  const fields = p.change_fields.filter((f: any) => !f.high_risk);
  const [f, setF] = useState({ field: fields[0]?.key ?? '', new_value: '' });
  const act = useAction((reason: string) => api.post('/vendors/me/change-requests', { field: f.field, new_value: f.new_value, reason }), { success: 'Change request sent to Equipcare', invalidate: [['vendor-profile']], silentError: true });
  const cur = f.field === 'bank_account' ? '' : p.vendor[f.field] ?? '—';
  return (
    <ReasonDialog open onClose={onClose} title="Request a company or contact change" sub="Equipcare reviews it. SAP-owned fields are updated in SAP after approval and appear here once synced." label="Why is it changing?" confirmLabel="Send change request" extraValid={!!f.new_value.trim()} onSubmit={(r) => act.run(r)}>
      <Field label="What changes?" required><Select value={f.field} onChange={(e) => setF({ field: e.target.value, new_value: '' })} options={fields.map((x: any) => ({ value: x.key, label: `${x.label}${x.sap_owned ? ' (SAP)' : ''}` }))} /></Field>
      <Field label="Current value"><Input readOnly value={String(cur)} /></Field>
      <Field label="New value" required hint={f.field === 'msme_no' ? 'Format UDYAM-MH-26-0071234' : undefined}>
        {f.field === 'state' ? <Select value={f.new_value} onChange={(e) => setF({ ...f, new_value: e.target.value })} placeholder="Choose a state" options={p.states} />
          : f.field === 'msme_category' ? <Select value={f.new_value} onChange={(e) => setF({ ...f, new_value: e.target.value })} placeholder="Choose" options={['Micro', 'Small', 'Medium']} />
            : <Input value={f.new_value} onChange={(e) => setF({ ...f, new_value: e.target.value })} />}
      </Field>
    </ReasonDialog>
  );
}

function BankChange({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ bank_name: '', bank_ifsc: '', account_no: '', account_confirm: '' });
  const [files, setFiles] = useState<Uploaded[]>([]);
  const act = useAction((reason: string) => api.post('/vendors/me/change-requests', { field: 'bank_account', reason, bank: f, attachment_ids: files.map((x) => x.id) }), { success: 'Bank change sent to Equipcare finance', invalidate: [['vendor-profile']], silentError: true });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <ReasonDialog open onClose={onClose} title="Request a bank account change" sub="High-risk change: finance verifies your cancelled cheque and approves. SAP is updated afterwards." label="Why is the account changing?" confirmLabel="Send bank change request"
      extraValid={!!f.bank_name && !!f.bank_ifsc && !!f.account_no && f.account_no === f.account_confirm && files.length > 0} onSubmit={(r) => act.run(r)}>
      <Field label="Bank name" required><Input value={f.bank_name} onChange={set('bank_name')} /></Field>
      <Field label="IFSC" required><Input className="mono" maxLength={11} value={f.bank_ifsc} onChange={(e) => setF({ ...f, bank_ifsc: e.target.value.toUpperCase() })} /></Field>
      <Field label="Account number" required><Input inputMode="numeric" autoComplete="off" value={f.account_no} onChange={set('account_no')} /></Field>
      <Field label="Confirm account number" required error={f.account_confirm && f.account_no !== f.account_confirm ? 'The two account numbers do not match.' : undefined}><Input inputMode="numeric" autoComplete="off" value={f.account_confirm} onChange={set('account_confirm')} /></Field>
      <FileDrop label="Cancelled cheque or bank letter (required)" compact camera multiple={false} onUploaded={setFiles} />
    </ReasonDialog>
  );
}

function Users({ p }: { p: any }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', email: '', phone: '', vendor_role: 'Sales' });
  const [pw, setPw] = useState<{ temporary_password: string; delivery?: string } | null>(null);
  const [off, setOff] = useState<any | null>(null);
  const create = useAction(() => api.post<{ temporary_password: string; delivery: string }>('/vendors/me/users', { ...f, phone: f.phone || undefined }), {
    success: () => `${f.name} added`, invalidate: [['vendor-profile']], silentError: true, onSuccess: (r) => { setOpen(false); setPw(r); },
  });
  const react = useAction((id: number) => api.post(`/vendors/me/users/${id}/reactivate`), { success: 'User reactivated', invalidate: [['vendor-profile']] });
  const deact = useAction((id: number, reason: string) => api.post(`/vendors/me/users/${id}/deactivate`, { reason }), { success: 'User deactivated', invalidate: [['vendor-profile']] });
  return (
    <Card flush title="Portal users of your company" actions={<Button size="sm" variant="deep" icon={<UserPlus />} onClick={() => { setF({ name: '', email: '', phone: '', vendor_role: 'Sales' }); setOpen(true); }}>Invite a colleague</Button>}>
      <DataTable<any>
        id="vendor-my-users" rows={p.users} rowKey={(r) => r.id} savedViews={false}
        columns={[
          { key: 'name', header: 'Name', render: (r) => <><strong>{r.name}</strong><span className="small subtle" style={{ display: 'block' }}>{r.email}</span></> },
          { key: 'vendor_role', header: 'Role' },
          { key: 'state', header: 'Status', value: (r) => userState(r), render: (r) => <Status value={userState(r)} /> },
          { key: 'last_login', header: 'Last sign-in', render: (r) => (r.last_login ? ago(r.last_login) : 'Never'), nowrap: true },
          { key: 'act', header: '', sortable: false, exportable: false, render: (r) => (r.vendor_role === 'Vendor administrator' ? null : r.active ? <Button size="sm" variant="ghost" onClick={() => setOff(r)}>Deactivate</Button> : <Button size="sm" variant="ghost" onClick={() => react.fire(r.id)}>Reactivate</Button>) },
        ]}
        mobile={{ title: (r) => r.name, badge: (r) => <Status value={userState(r)} />, meta: (r) => [r.vendor_role, r.email] }}
        empty={<div className="empty"><div className="empty__title">No users</div></div>}
      />
      <Modal open={open} onClose={() => setOpen(false)} title="Invite a colleague" sub="They get a sign-in with a temporary password shown once. Roles: Sales, Dispatch, Accounts." footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="deep" loading={create.busy} disabled={!f.name || !f.email} onClick={create.fire}>Create user</Button></>}>
        <div className="stack">
          <ErrorSummary error={create.error} />
          <Field label="Full name" required error={fieldError(create.error, 'name')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="E-mail" required error={fieldError(create.error, 'email')}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Mobile"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Role" required error={fieldError(create.error, 'vendor_role')}><Select value={f.vendor_role} onChange={(e) => setF({ ...f, vendor_role: e.target.value })} options={p.vendor_roles} /></Field>
        </div>
      </Modal>
      <ReasonDialog open={!!off} onClose={() => setOff(null)} title={`Deactivate ${off?.name ?? ''}`} sub="They are signed out and can no longer sign in." confirmLabel="Deactivate user" variant="danger" onSubmit={(r) => deact.run(off.id, r)} />
      <TempPasswordModal value={pw} onClose={() => setPw(null)} who={f.name} />
    </Card>
  );
}
