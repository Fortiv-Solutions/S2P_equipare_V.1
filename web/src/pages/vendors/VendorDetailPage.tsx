import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, X, Send, MessageSquareWarning, ClipboardCheck, Copy, RefreshCw, UserPlus, FlaskConical, Ban, PlayCircle, Landmark } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtMoney, ago } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, Empty, Freshness, KV, Loader, PageHeader, Ref, SimBadge, Status, Tabs } from '@/components/ui';
import { Field, Input, Select, ErrorSummary, fieldError } from '@/components/forms';
import { Modal, ReasonDialog, useToast } from '@/components/overlay';
import { TrackChain } from '@/components/TrackChain';
import { AttachmentList } from '@/components/Attachments';
import { CommentThread } from '@/components/Thread';
import { AuditTrail } from '@/components/AuditTrail';
import { DataTable } from '@/components/DataTable';
import { DocStatus, Expiry, KycBadge, fileLink, onboardingChain, type DocRow } from './shared';
import { TempPasswordModal, UserActions, userState, type AdminUser } from '../admin/userParts';

type Tab = 'overview' | 'documents' | 'capabilities' | 'changes' | 'users' | 'activity' | 'thread' | 'audit';

export default function VendorDetailPage() {
  const id = Number(useParams().id);
  const q = useQuery<any>({ queryKey: ['vendors', 'detail', id], queryFn: () => api.get(`/vendors/${id}`) });
  return <Loader q={q} rows={10}>{(v) => <VendorView v={v} />}</Loader>;
}

function VendorView({ v }: { v: any }) {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'overview';
  const setTab = (t: Tab) => { sp.set('tab', t); setSp(sp, { replace: true }); };
  const openChanges = v.change_requests.filter((c: any) => ['Pending', 'Approved', 'Sent to SAP'].includes(c.status)).length;
  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/vendors">Vendors</Link><span>/</span><span className="mono">{v.sap_code ?? 'No SAP code'}</span></>} screen="SCR-VPT vendor 360"
        title={v.name}
        badges={<><Status value={v.onboarding_status} /><KycBadge state={v.kyc.state} />{v.sap_blocked ? <Badge tone="bad">Blocked in SAP</Badge> : null}</>}
        sub={<>{[v.city, v.state].filter(Boolean).join(', ') || 'Location not given'} · GSTIN <span className="mono">{v.gstin ?? '—'}</span> · portal {v.portal_status.toLowerCase()}{v.performance_score != null ? ` · score ${v.performance_score}` : ''}</>}
      />
      {v.onboarding_status !== 'Active' && (
        <Card title="Onboarding" className="no-print">
          <TrackChain label="Onboarding stages" steps={onboardingChain(v.onboarding_status)} />
        </Card>
      )}
      <div style={{ height: 16 }} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'documents', label: 'KYC documents', count: v.documents.filter((d: DocRow) => d.status === 'Pending review').length || undefined },
        { id: 'capabilities', label: 'Capabilities', count: v.capabilities.length },
        { id: 'changes', label: 'Change requests', count: openChanges || undefined },
        { id: 'users', label: 'Portal users', count: v.users.length },
        { id: 'activity', label: 'RFQs, POs & invoices' },
        { id: 'thread', label: 'Clarifications' },
        { id: 'audit', label: 'Audit history' },
      ]} />
      {tab === 'overview' && <Overview v={v} />}
      {tab === 'documents' && <Documents v={v} />}
      {tab === 'capabilities' && <Capabilities v={v} />}
      {tab === 'changes' && <Changes v={v} />}
      {tab === 'users' && <PortalUsers v={v} />}
      {tab === 'activity' && <Activity v={v} />}
      {tab === 'thread' && <Card title="Messages with the vendor"><p className="small muted" style={{ marginBottom: 12 }}>Clarification requests and the vendor's answers. Messages you post here are internal unless sent through “Request clarification”.</p><CommentThread objectType="vendor" objectId={v.id} /></Card>}
      {tab === 'audit' && <Card title="Audit history"><AuditTrail objectType="vendor" objectId={v.id} /></Card>}
    </>
  );
}

function Overview({ v }: { v: any }) {
  return (
    <div className="split">
      <div className="stack">
        {v.onboarding_status !== 'Active' && <OnboardingPanel v={v} />}
        <Card title="Vendor master" actions={v.sap_code ? <Freshness flow="INT-M01" label="Vendor master" /> : <Badge tone="warn">Application data — not yet in SAP</Badge>}>
          <KV cols items={[
            ['SAP vendor code', v.sap_code ? <span className="mono">{v.sap_code}</span> : 'Pending'], ['Legal name', v.legal_name], ['Address', v.address],
            ['City / state', [v.city, v.state].filter(Boolean).join(', ')], ['GSTIN', <span className="mono">{v.gstin ?? '—'}</span>], ['PAN', <span className="mono">{v.pan ?? '—'}</span>],
            ['MSME', v.msme_no ? `${v.msme_category ?? ''} · ${v.msme_no}` : 'Not declared'], ['Bank', v.bank_name], ['Account', <span className="mono">{v.bank_account_masked ?? '—'}</span>],
            ['IFSC', <span className="mono">{v.bank_ifsc ?? '—'}</span>], ['Blocked in SAP', v.sap_blocked ? 'Yes — no new RFQs or POs' : 'No'], ['Last synced', v.synced_at ? fmtDateTime(v.synced_at) : '—'],
          ]} />
          {v.freshness?.stale && <div style={{ marginTop: 12 }}><Callout tone="warn">This record is older than the {v.freshness.thresholdMinutes}-minute freshness threshold for INT-M01.</Callout></div>}
          <p className="small muted" style={{ marginTop: 12 }}>Master fields come from SAP. Vendor change requests show here only after SAP returns the new value (FR-VPT-02).</p>
        </Card>
      </div>
      <div className="stack">
        <Card title="Contacts">
          {(v.onboarding.contacts ?? []).length ? (
            <ul className="list-plain stack-sm">
              {v.onboarding.contacts.map((c: any, i: number) => <li key={i}><strong>{c.name}</strong> <span className="muted small">· {c.role}</span><div className="small">{c.email} · {c.phone}</div></li>)}
            </ul>
          ) : <KV items={[['Primary contact', v.contact_name], ['E-mail', v.contact_email], ['Phone', v.contact_phone]]} />}
        </Card>
        <Card title="At a glance">
          <KV items={[
            ['KYC', <KycBadge state={v.kyc.state} />],
            ['Issues', [...v.kyc.expired, ...v.kyc.rejected, ...v.kyc.missing, ...v.kyc.pending].join(', ') || 'None'],
            ['Approved capabilities', v.capabilities.filter((c: any) => c.status === 'Approved').length],
            ['Portal users', `${v.users.filter((u: any) => u.active).length} active`],
            ['RFQ invitations', v.counts.rfqs], ['Purchase orders', v.counts.pos], ['Invoices', v.counts.invoices], ['Disputes', v.counts.disputes],
          ]} />
        </Card>
      </div>
    </div>
  );
}

function OnboardingPanel({ v }: { v: any }) {
  const { can } = useAuth();
  const toast = useToast();
  const inv = [['vendors']];
  const [dlg, setDlg] = useState<'clarify' | 'reject' | null>(null);
  const resend = useAction(() => api.post(`/vendors/${v.id}/invite/resend`), { success: 'New invitation link created', invalidate: inv });
  const start = useAction(() => api.post(`/vendors/${v.id}/onboarding/start-review`), { success: 'Review started', invalidate: inv });
  const review = useAction((area: string) => api.post(`/vendors/${v.id}/onboarding/review`, { area }), { success: (_r) => 'Review recorded', invalidate: inv });
  const clarify = useAction((message: string) => api.post(`/vendors/${v.id}/onboarding/clarify`, { message }), { success: 'Clarification sent to the vendor', invalidate: inv });
  const reject = useAction((reason: string) => api.post(`/vendors/${v.id}/onboarding/reject`, { reason }), { success: 'Application rejected', invalidate: inv });
  const approve = useAction(() => api.post(`/vendors/${v.id}/onboarding/submit-approval`), { success: 'Sent for onboarding approval', invalidate: inv });
  const sapCreate = useAction(() => api.post('/sap/sim/vendor', { vendor_id: v.id }), { success: 'Vendor created in the SAP simulator', invalidate: inv });
  const s = v.onboarding_status;
  const o = v.onboarding;
  const reviewing = ['Submitted', 'Under review'].includes(s);
  const link = v.invite_link ? `${window.location.origin}${v.invite_link}` : null;
  return (
    <Card title="Onboarding decision" actions={o.submitted_at ? <span className="small muted">Submitted {ago(o.submitted_at)}{o.resubmissions ? ` · resubmitted ${o.resubmissions}×` : ''}</span> : undefined}>
      <div className="stack">
        {s === 'Invited' && (
          <>
            <Callout tone={v.invite_expired ? 'bad' : 'info'} title={v.invite_expired ? 'Invitation link expired' : 'Waiting for the vendor to register'}>
              Invited by {v.invited_by_name ?? '—'} on {fmtDate(o.invite?.invited_at)} · link valid until {fmtDateTime(v.invite_expires_at)}.
            </Callout>
            {link && (
              <div className="sim-panel stack-sm">
                <SimBadge>E-mail not sent — simulated outbox</SimBadge>
                <code className="mono small" style={{ wordBreak: 'break-all' }}>{link}</code>
                <div className="row-wrap">
                  <Button size="sm" icon={<Copy />} onClick={() => navigator.clipboard?.writeText(link).then(() => toast('Registration link copied'), () => undefined)}>Copy link</Button>
                </div>
              </div>
            )}
            {can('vendor.onboard') && <div><Button icon={<RefreshCw />} loading={resend.busy} onClick={resend.fire}>Send a new link</Button></div>}
          </>
        )}
        {s === 'Registration in progress' && <Callout tone="info" title="Vendor is completing the onboarding form">Registered {fmtDateTime(o.registered_at)}. You will be notified when it is submitted.</Callout>}
        {s === 'Clarification requested' && <Callout tone="warn" title="Waiting for the vendor's clarification">{o.clarification?.note} — asked by {o.clarification?.by_name} {ago(o.clarification?.at)}.</Callout>}
        {reviewing && (
          <>
            {s === 'Submitted' && (can('vendor.onboard') || can('vendor.review_kyc') || can('vendor.review_bank')) && (
              <Callout tone="info" title="New application">Start the review to tell the vendor it is being looked at. <Button size="sm" variant="deep" icon={<PlayCircle />} loading={start.busy} onClick={start.fire}>Start review</Button></Callout>
            )}
            <div className="grid-2">
              <ReviewBox title="Procurement review" sub="Documents and capabilities" done={o.reviews?.procurement} can={can('vendor.onboard')} busy={review.busy} onDone={() => review.fire('procurement')} />
              <ReviewBox title="Finance review" sub="Bank details and KYC" done={o.reviews?.finance} can={can('vendor.review_bank')} busy={review.busy} onDone={() => review.fire('finance')} />
            </div>
            {v.approval && ['Pending', 'Clarification requested'].includes(v.approval.status) ? (
              <Callout tone="decision" title={`Waiting for approval ${v.approval.req_no}`}>Level {v.approval.current_level}: Procurement Manager, then Finance. <Ref to={`/approvals/${v.approval.id}`}>Open approval</Ref></Callout>
            ) : (
              <div className="row-wrap">
                {can('vendor.onboard') && <Button variant="decision" icon={<Send />} loading={approve.busy} disabled={s !== 'Under review'} onClick={approve.fire}>Send for onboarding approval</Button>}
                {(can('vendor.onboard') || can('vendor.review_kyc') || can('vendor.review_bank')) && <Button icon={<MessageSquareWarning />} onClick={() => setDlg('clarify')}>Request clarification</Button>}
                {can('vendor.onboard') && <Button variant="danger" icon={<Ban />} onClick={() => setDlg('reject')}>Reject application</Button>}
              </div>
            )}
          </>
        )}
        {s === 'Pending SAP code' && (
          <>
            <Callout tone="ok" title="Onboarding approved">{v.approval ? <>Approved through <Ref to={`/approvals/${v.approval.id}`}>{v.approval.req_no}</Ref>. </> : null}The SAP team creates the vendor master in SAP. The vendor code links automatically on the next vendor sync, matched by PAN / GSTIN.</Callout>
            {can('sapsim.all') ? (
              <div className="sim-panel row-wrap between">
                <span className="small"><SimBadge>SAP simulator</SimBadge> In this MVP the SAP simulator stands in for SAP vendor creation (XK01).</span>
                <div className="row-wrap">
                  <ButtonLink size="sm" to={`/sap-simulator?action=vendor&vendor=${v.id}`} icon={<FlaskConical size={14} />}>Open in SAP simulator</ButtonLink>
                  <Button size="sm" variant="deep" loading={sapCreate.busy} onClick={sapCreate.fire}>Create vendor in SAP simulator</Button>
                </div>
              </div>
            ) : <p className="small muted">The SAP team has been notified (NTF-24). Nothing to do here until the code links.</p>}
          </>
        )}
        {s === 'Rejected' && <Callout tone="bad" title="Application rejected">{o.rejected_reason} · {fmtDateTime(o.rejected_at)}</Callout>}
      </div>
      <ReasonDialog open={dlg === 'clarify'} onClose={() => setDlg(null)} title="Request clarification from the vendor" sub="The vendor sees this message and can edit and resubmit the application. Completed reviews restart." label="Message to the vendor" confirmLabel="Send clarification request" onSubmit={(m) => clarify.run(m)} />
      <ReasonDialog open={dlg === 'reject'} onClose={() => setDlg(null)} title="Reject this application" sub="The vendor sees the reason. This ends the onboarding." confirmLabel="Reject application" variant="danger" onSubmit={(r) => reject.run(r)} />
    </Card>
  );
}

function ReviewBox({ title, sub, done, can, busy, onDone }: { title: string; sub: string; done?: { by_name: string; at: string; note?: string | null }; can: boolean; busy: boolean; onDone: () => void }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: 14 }} className="stack-sm">
      <div className="row between"><strong>{title}</strong>{done ? <Badge tone="ok">Complete</Badge> : <Badge tone="warn">Open</Badge>}</div>
      <span className="small muted">{sub}</span>
      {done ? <span className="small">{done.by_name} · {fmtDateTime(done.at)}{done.note ? ` · ${done.note}` : ''}</span>
        : can ? <div><Button size="sm" variant="deep" icon={<ClipboardCheck />} loading={busy} onClick={onDone}>Mark {title.toLowerCase()} complete</Button></div>
          : <span className="small subtle">Recorded by {title.startsWith('Finance') ? 'finance' : 'procurement'}.</span>}
    </div>
  );
}

function Documents({ v }: { v: any }) {
  const { can } = useAuth();
  const [rej, setRej] = useState<DocRow | null>(null);
  const review = useAction((id: number, decision: string, note?: string) => api.post(`/vendors/documents/${id}/review`, { decision, note }), { success: 'Document review recorded', invalidate: [['vendors']] });
  const canReview = can('vendor.review_kyc', 'vendor.onboard', 'vendor.review_bank');
  const rows: DocRow[] = v.documents;
  return (
    <div className="stack">
      {v.kyc.state !== 'Complete' && (
        <Callout tone={['Expired', 'Rejected'].includes(v.kyc.state) ? 'bad' : 'warn'} title={`KYC ${v.kyc.state.toLowerCase()}`}>
          {v.kyc.expired.length > 0 && <>Expired: {v.kyc.expired.join(', ')} — excluded from RFQ suggestions. </>}
          {v.kyc.missing.length > 0 && <>Missing: {v.kyc.missing.join(', ')}. </>}
          {v.kyc.pending.length > 0 && <>Waiting for review: {v.kyc.pending.join(', ')}. </>}
          {v.kyc.rejected.length > 0 && <>Rejected, new upload needed: {v.kyc.rejected.join(', ')}. </>}
          {v.kyc.expiring.length > 0 && <>Expiring soon: {v.kyc.expiring.join(', ')}.</>}
        </Callout>
      )}
      <Card flush title="Documents" actions={<span className="small muted">Mandatory: {v.mandatory_types.join(', ')}</span>}>
        <DataTable<DocRow>
          id="vendor-docs" rows={rows} rowKey={(r) => r.id} savedViews={false}
          columns={[
            { key: 'doc_type', header: 'Document', render: (r) => <div className="row-wrap">{r.doc_type}{r.mandatory ? <Badge plain tone="info">Mandatory</Badge> : null}</div> },
            { key: 'filename', header: 'File', render: (r) => fileLink(r.attachment_id, r.filename) },
            { key: 'doc_no', header: 'Number', render: (r) => <span className="mono small">{r.doc_no ?? '—'}</span> },
            { key: 'expiry_date', header: 'Expiry', render: (r) => <Expiry date={r.expiry_date} /> },
            { key: 'status', header: 'Status', render: (r) => <DocStatus d={r} /> },
            { key: 'created_at', header: 'Uploaded', render: (r) => fmtDate(r.created_at), nowrap: true },
            { key: 'reviewed_by_name', header: 'Reviewed by', render: (r) => r.reviewed_by_name ?? '—' },
            { key: 'act', header: '', sortable: false, exportable: false, render: (r) => canReview && r.status === 'Pending review' ? (
              <div className="row">
                <Button size="sm" variant="ok" icon={<Check />} loading={review.busy} onClick={() => review.fire(r.id, 'Valid')}>Approve</Button>
                <Button size="sm" variant="ghost" icon={<X />} onClick={() => setRej(r)}>Reject</Button>
              </div>
            ) : null },
          ]}
          filters={[{ key: 'status', label: 'Status', value: (r) => r.status }]}
          mobile={{ title: (r) => r.doc_type, badge: (r) => <Status value={r.status} />, meta: (r) => [r.filename ?? 'No file', r.expiry_date ? `Expires ${fmtDate(r.expiry_date)}` : 'No expiry'] }}
          empty={<div className="empty"><div className="empty__title">No documents uploaded</div><div>The vendor uploads KYC documents in onboarding or from their profile.</div></div>}
        />
      </Card>
      <ReasonDialog open={!!rej} onClose={() => setRej(null)} title={`Reject ${rej?.doc_type ?? 'document'}`} sub="The vendor sees this reason and uploads a corrected document." confirmLabel="Reject document" variant="danger"
        onSubmit={(r) => review.run(rej!.id, 'Rejected', r)} />
    </div>
  );
}

function Capabilities({ v }: { v: any }) {
  const { can } = useAuth();
  const [rej, setRej] = useState<any | null>(null);
  const decide = useAction((id: number, decision: string, note?: string) => api.post(`/vendors/capabilities/${id}/decide`, { decision, note }), { success: 'Capability decision recorded', invalidate: [['vendors']] });
  return (
    <Card flush title="Capability mapping" actions={<span className="small muted">Approved rows drive RFQ vendor suggestions (FR-RFQ-02, FR-VPT-13)</span>}>
      <DataTable<any>
        id="vendor-capabilities" rows={v.capabilities} rowKey={(r) => r.id} savedViews={false}
        columns={[
          { key: 'category', header: 'Category', render: (r) => <>{r.category} <span className="small muted">{r.category_name}</span></> },
          { key: 'sub_category', header: 'Sub-category' }, { key: 'supplier_role', header: 'Supplier role' }, { key: 'brand', header: 'Brand' }, { key: 'region', header: 'Region' },
          { key: 'buyer_owner_name', header: 'Buyer owner' },
          { key: 'status', header: 'Status', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Status value={r.status} />{r.decision_note && <span className="small muted">{r.decision_note}</span>}</div> },
          { key: 'act', header: '', sortable: false, exportable: false, render: (r) => can('vendor.onboard') && r.status === 'Proposed' ? (
            <div className="row">
              <Button size="sm" variant="ok" icon={<Check />} loading={decide.busy} onClick={() => decide.fire(r.id, 'Approved')}>Approve</Button>
              <Button size="sm" variant="ghost" icon={<X />} onClick={() => setRej(r)}>Reject</Button>
            </div>
          ) : null },
        ]}
        mobile={{ title: (r) => `${r.category} · ${r.sub_category ?? ''}`, badge: (r) => <Status value={r.status} />, meta: (r) => [r.supplier_role ?? '—', r.brand ?? '—'] }}
        empty={<div className="empty"><div className="empty__title">No capabilities yet</div><div>The vendor proposes what it supplies; procurement approves each row.</div></div>}
      />
      <ReasonDialog open={!!rej} onClose={() => setRej(null)} title="Reject capability" sub="The vendor sees this reason." confirmLabel="Reject capability" variant="danger" onSubmit={(r) => decide.run(rej.id, 'Rejected', r)} />
    </Card>
  );
}

function Changes({ v }: { v: any }) {
  const { can } = useAuth();
  const [dlg, setDlg] = useState<{ kind: 'reject' | 'verify'; cr: any } | null>(null);
  const inv = [['vendors']];
  const decide = useAction((id: number, decision: string, note?: string) => api.post(`/vendors/change-requests/${id}/decide`, { decision, note }), { success: 'Change request decision recorded', invalidate: inv });
  const verify = useAction((id: number, note: string) => api.post<{ req_no: string }>(`/vendors/change-requests/${id}/send-for-approval`, { note }), { success: (r) => `Sent for finance approval (${r.req_no})`, invalidate: inv });
  const sapApply = useAction((id: number) => api.post(`/sap/sim/vendor/${v.id}/bank`, { change_request_id: id }), { success: 'Change applied in the SAP simulator', invalidate: inv });
  if (!v.change_requests.length) return <Card><Empty title="No change requests">The vendor requests profile and bank changes from the portal. Nothing changes in master data until SAP returns the value.</Empty></Card>;
  return (
    <div className="stack">
      {v.change_requests.map((c: any) => (
        <Card key={c.id} title={<div className="row-wrap"><h2>{c.field_label}</h2>{c.high_risk ? <Badge tone="bad">High-risk change</Badge> : null}<Status value={c.status} /></div>}
          actions={<span className="small muted">Requested by {c.requested_by_name} · {fmtDateTime(c.created_at)}</span>}>
          <div className="split" style={{ gridTemplateColumns: 'minmax(0,1fr) 300px' }}>
            <div className="stack">
              <KV cols items={[
                ['Current value (SAP)', <span className="mono">{c.old_value ?? '—'}</span>], ['Requested value', <span className="mono">{c.new_value}</span>],
                ...(c.details ? [['New bank', c.details.bank_name], ['New IFSC', <span className="mono">{c.details.bank_ifsc}</span>]] as [string, React.ReactNode][] : []),
                ['Reason', c.reason], ['Decision', c.decision_note ? `${c.decided_by_name ?? ''}: ${c.decision_note}` : c.decided_by_name ?? '—'],
                ['Approval', c.approval_no ? <Ref to={`/approvals/${c.approval_id}`}>{`${c.approval_no} · ${c.approval_status}`}</Ref> : '—'],
                ['Sent to SAP', fmtDateTime(c.sent_to_sap_at)], ['Applied from SAP', fmtDateTime(c.applied_at)],
              ]} />
              {c.status === 'Pending' && !c.high_risk && can('vendor.onboard', 'vendor.review_kyc') && (
                <div className="row-wrap">
                  <Button variant="ok" icon={<Check />} loading={decide.busy} onClick={() => decide.fire(c.id, 'Approved')}>Approve change</Button>
                  <Button icon={<X />} onClick={() => setDlg({ kind: 'reject', cr: c })}>Reject</Button>
                </div>
              )}
              {c.status === 'Pending' && c.high_risk && !c.approval_id && (can('vendor.review_bank')
                ? <div className="row-wrap"><Button variant="decision" icon={<Landmark />} onClick={() => setDlg({ kind: 'verify', cr: c })}>Verify and send for finance approval</Button><span className="small muted">A second finance user approves (maker–checker).</span></div>
                : <Callout tone="info">Finance verifies the cancelled cheque and sends this bank change for approval.</Callout>)}
              {c.status === 'Sent to SAP' && (
                can('sapsim.all') ? (
                  <div className="sim-panel row-wrap between">
                    <span className="small"><SimBadge>SAP simulator</SimBadge> The SAP team updates the vendor master; the platform marks the request Applied when the vendor sync returns the new value.</span>
                    <div className="row-wrap">
                      <ButtonLink size="sm" to={`/sap-simulator?action=vendor_change&vendor=${v.id}&change_request=${c.id}`} icon={<FlaskConical size={14} />}>Open in SAP simulator</ButtonLink>
                      <Button size="sm" variant="deep" loading={sapApply.busy} onClick={() => sapApply.fire(c.id)}>Apply in SAP simulator</Button>
                    </div>
                  </div>
                ) : <Callout tone="info" title="With the SAP team">The vendor master is unchanged until SAP returns the new value on the next vendor sync (AC-VPT-04).</Callout>
              )}
            </div>
            <div className="stack-sm">
              <span className="small muted">Supporting documents</span>
              <AttachmentList ownerType="vendor_change" ownerId={c.id} />
            </div>
          </div>
        </Card>
      ))}
      <ReasonDialog open={dlg?.kind === 'reject'} onClose={() => setDlg(null)} title="Reject change request" sub="The vendor sees this reason." confirmLabel="Reject change" variant="danger" onSubmit={(r) => decide.run(dlg!.cr.id, 'Rejected', r)} />
      <ReasonDialog open={dlg?.kind === 'verify'} onClose={() => setDlg(null)} title="Verify bank change" sub="Confirm how you verified the new account (cancelled cheque, call-back on the registered number). A second finance user then approves." label="Verification note" confirmLabel="Send for finance approval" variant="decision" onSubmit={(r) => verify.run(dlg!.cr.id, r)} />
    </div>
  );
}

function PortalUsers({ v }: { v: any }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const meta = useQuery<{ vendor_roles: string[] }>({ queryKey: ['admin', 'users', 'meta'], queryFn: () => api.get('/admin/users/meta'), enabled: can('adm.users') });
  const [f, setF] = useState({ name: '', email: '', phone: '', vendor_role: 'Sales' });
  const [pw, setPw] = useState<{ temporary_password: string; delivery?: string } | null>(null);
  const create = useAction(() => api.post<{ temporary_password: string; delivery: string }>('/admin/users', { ...f, vendor_id: v.id }), {
    success: () => `Portal user ${f.name} created`, invalidate: [['vendors'], ['admin']], silentError: true,
    onSuccess: (r) => { setOpen(false); setPw(r); },
  });
  return (
    <Card flush title="Portal users" actions={can('adm.users') && v.onboarding_status === 'Active' ? <Button size="sm" variant="deep" icon={<UserPlus />} onClick={() => setOpen(true)}>Create portal user</Button> : undefined}>
      {v.onboarding_status !== 'Active' && can('adm.users') && <div style={{ padding: '12px 14px 0' }}><Callout tone="info">The vendor administrator is created when the invitation is accepted. More users can be added once the vendor is active.</Callout></div>}
      <DataTable<AdminUser>
        id="vendor-users" rows={v.users} rowKey={(r) => r.id} savedViews={false}
        columns={[
          { key: 'name', header: 'Name', render: (r) => <><strong>{r.name}</strong><span className="small subtle" style={{ display: 'block' }}>{r.email}</span></> },
          { key: 'vendor_role', header: 'Vendor role' },
          { key: 'state', header: 'Status', value: (r) => userState(r), render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Status value={userState(r)} />{r.failed_attempts > 0 && <span className="small muted">{r.failed_attempts} failed sign-in(s)</span>}</div> },
          { key: 'last_login', header: 'Last sign-in', render: (r) => (r.last_login ? ago(r.last_login) : 'Never'), nowrap: true },
          { key: 'act', header: '', sortable: false, exportable: false, render: (r) => (can('adm.users') ? <UserActions u={r} invalidate={[['vendors'], ['admin']]} compact /> : null) },
        ]}
        mobile={{ title: (r) => r.name, badge: (r) => <Status value={userState(r)} />, meta: (r) => [r.vendor_role ?? '—', r.email] }}
        empty={<div className="empty"><div className="empty__title">No portal users</div><div>{can('adm.users') ? 'Create the first user for this vendor (WF-06: existing SAP vendors get users from the administrator).' : 'The administrator creates portal users.'}</div></div>}
      />
      <Modal open={open} onClose={() => setOpen(false)} title={`New portal user for ${v.name}`} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="deep" loading={create.busy} disabled={!f.name || !f.email} onClick={create.fire}>Create user</Button></>}>
        <div className="stack">
          <ErrorSummary error={create.error} />
          <Field label="Full name" required error={fieldError(create.error, 'name')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="E-mail" required error={fieldError(create.error, 'email')}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Mobile"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Vendor role" required error={fieldError(create.error, 'vendor_role')}><Select value={f.vendor_role} onChange={(e) => setF({ ...f, vendor_role: e.target.value })} options={meta.data?.vendor_roles ?? ['Vendor administrator', 'Sales', 'Dispatch', 'Accounts']} /></Field>
        </div>
      </Modal>
      <TempPasswordModal value={pw} onClose={() => setPw(null)} who={f.name} />
    </Card>
  );
}

function Activity({ v }: { v: any }) {
  const list = (title: string, rows: any[], render: (r: any) => React.ReactNode, emptyText: string, count: number) => (
    <Card title={`${title} (${count})`}>
      {rows.length ? <ul className="list-plain stack-sm">{rows.map((r) => <li key={r.id} className="row between" style={{ borderBottom: '1px solid var(--steel-100)', paddingBottom: 6 }}>{render(r)}</li>)}</ul> : <Empty title={emptyText} />}
    </Card>
  );
  return (
    <div className="grid-2">
      {list('RFQ invitations', v.rfqs, (r) => <><span><Ref to={`/rfqs/${r.id}`}>{r.rfq_no}</Ref> <span className="small muted">{r.title}</span></span><span className="row"><Status value={r.invitation_status} /><Status value={r.status} /></span></>, 'No RFQ invitations yet', v.counts.rfqs)}
      {list('Purchase orders', v.pos, (r) => <><span><Ref to={`/pos/${r.id}`}>{r.po_no}</Ref> <span className="small muted">{fmtDate(r.po_date)} · {r.plant}</span></span><span className="row"><span className="num small">{fmtMoney(r.total_value, true)}</span><Status value={r.status} /></span></>, 'No purchase orders', v.counts.pos)}
      {list('Invoices', v.invoices, (r) => <><span><Ref to={`/invoices/${r.id}`}>{r.inv_ref}</Ref> <span className="small muted">{r.vendor_invoice_no ?? ''}</span></span><span className="row"><span className="num small">{fmtMoney(r.total_value, true)}</span><Status value={r.status} /></span></>, 'No invoices', v.counts.invoices)}
      {list('Tickets', v.tickets, (r) => <><span><Ref to={`/tickets/${r.id}`}>{r.tkt_no}</Ref> <span className="small muted">{r.subject}</span></span><Status value={r.status} /></>, 'No tickets', v.tickets.length)}
    </div>
  );
}
