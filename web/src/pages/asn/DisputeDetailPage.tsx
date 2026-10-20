import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Lock, MessageSquare, RotateCcw, Send, UserCog, Undo2, Gavel, HandHelping, FilePlus2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, ago } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, DecisionTag, KV, Loader, PageHeader, Ref, Status, Tabs } from '@/components/ui';
import { Field, Input, Select, Textarea, Checkbox, ErrorSummary, fieldError } from '@/components/forms';
import { Modal, ReasonDialog } from '@/components/overlay';
import { AttachmentList, FileDrop, type Uploaded } from '@/components/Attachments';
import { AuditTrail } from '@/components/AuditTrail';
import { TrackChain } from '@/components/TrackChain';
import { AgeCell, disputeChain, TermBadge, useAsnMeta } from './shared';
import type { DisputeDetail, DisputeEvent } from './types';

/** SCR-ASN-05 dispute detail (internal) and SCR-VPT-09 vendor view: timeline, evidence, responses, linked invoices, actions. */
export default function DisputeDetailPage({ vendor = false }: { vendor?: boolean }) {
  const id = Number(useParams().id);
  const q = useQuery<DisputeDetail>({ queryKey: ['asn', 'dispute', id], queryFn: () => api.get(`/asn/disputes/${id}`) });
  return <Loader q={q} rows={10}>{(d) => <View d={d} vendor={vendor} />}</Loader>;
}

const KIND_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'decision' | undefined> = {
  raised: 'warn', escalated: 'bad', outcome: 'ok', closed: 'ok', reopened: 'warn', vendor_response: 'decision', note: undefined, closure_requested: 'decision', closure_rejected: 'bad',
};
const KIND_LABEL: Record<string, string> = {
  raised: 'Raised', assigned: 'Assigned', reassigned: 'Reassigned', note: 'Internal note', message: 'Message to vendor', evidence: 'Evidence added', response_requested: 'Response requested',
  vendor_response: 'Vendor response', status: 'Status', outcome: 'Outcome recorded', closed: 'Closed', reopened: 'Reopened', escalated: 'Escalated to Procurement Manager', closure_requested: 'Closure sent for approval', closure_rejected: 'Closure not approved',
};

function View({ d, vendor }: { d: DisputeDetail; vendor: boolean }) {
  const { can } = useAuth();
  const [tab, setTab] = useState<'work' | 'audit'>('work');
  const [dialog, setDialog] = useState<'reassign' | 'outcome' | 'close' | 'reopen' | 'request' | 'resolution' | null>(null);
  const base = vendor ? '/vendor/disputes' : '/disputes';
  const inv = [['asn']];
  const close = useAction((note: string) => api.post<{ pending_approval: string | null }>(`/asn/disputes/${d.id}/close`, { note: note || undefined }), {
    success: (r) => (r.pending_approval ? `Closure sent for approval (${r.pending_approval})` : `Dispute ${d.dsp_no} closed`), invalidate: inv,
  });
  const reopen = useAction((reason: string) => api.post(`/asn/disputes/${d.id}/reopen`, { reason }), { success: `Dispute ${d.dsp_no} reopened`, invalidate: inv });
  const resolution = useAction(() => api.post(`/asn/disputes/${d.id}/under-resolution`, {}), { success: 'Marked under resolution', invalidate: inv });
  const request = useAction((message: string) => api.post(`/asn/disputes/${d.id}/request-response`, { message }), { success: 'Vendor asked to respond', invalidate: inv });
  const a = d.actions;

  return (
    <>
      <PageHeader
        eyebrow={<><Link to={base}>Disputes</Link><span>/</span><span className="mono">{d.dsp_no}</span></>} screen={vendor ? 'SCR-VPT-09' : 'SCR-ASN-05'}
        title={<>{d.type} · <span className="mono">{d.dsp_no}</span></>}
        badges={<><Status value={d.awaiting_you ? 'Awaiting your response' : d.status} />{d.escalated && !vendor && <Badge tone="bad">Escalated</Badge>}<TermBadge term={d.delivery_term} /></>}
        sub={<>PO <span className="mono">{d.po.po_no}/{d.line.item}</span> · {d.line.description} · {fmtNum(d.qty)} {d.line.uom} · {vendor ? d.po.plant : d.vendor_name}</>}
        actions={!vendor ? (
          <>
            {a.request_response && <Button icon={<HandHelping />} onClick={() => setDialog('request')}>Ask vendor to respond</Button>}
            {a.under_resolution && <Button icon={<Gavel />} loading={resolution.busy} onClick={resolution.fire}>Mark under resolution</Button>}
            {a.reassign && <Button icon={<UserCog />} onClick={() => setDialog('reassign')}>Reassign</Button>}
            {a.outcome && <Button variant="primary" icon={<CheckCircle2 />} onClick={() => setDialog('outcome')}>Record outcome</Button>}
            {a.close && <Button variant="deep" icon={<Lock />} onClick={() => setDialog('close')}>{d.closure_approval ? 'Send closure for approval' : 'Close dispute'}</Button>}
            {a.reopen && <Button icon={<RotateCcw />} onClick={() => setDialog('reopen')}>Reopen</Button>}
          </>
        ) : undefined}
      />

      <Card title={<div className="row-wrap"><h2>Lifecycle</h2><span className="small muted">Owner: <strong>{d.owner_label}</strong></span></div>}
        actions={<span className="small muted">Open {d.age_days} days{d.open ? ` · ${d.bucket}` : d.closure_tat_days != null ? ` · closed in ${d.closure_tat_days} days` : ''}</span>}>
        <TrackChain steps={disputeChain(d.status, d.owner_party)} />
        {d.approval && !vendor && ['Pending', 'Clarification requested'].includes(d.approval.status) && (
          <div style={{ marginTop: 12 }}><Callout tone="decision" title="Closure waiting for approval">Request <Ref to={`/approvals/${d.approval.id}`}>{d.approval.req_no}</Ref> is with the Procurement Manager <DecisionTag id="Q 7.8" />.</Callout></div>
        )}
        {d.awaiting_you && <div style={{ marginTop: 12 }}><Callout tone="warn" title="Equipcare is waiting for your response">Explain what happened and attach supporting documents (packing list, LR, photos, credit note). Use Respond below.</Callout></div>}
      </Card>

      <div style={{ height: 16 }} />
      {!vendor && <Tabs value={tab} onChange={setTab} tabs={[{ id: 'work', label: 'Timeline & evidence' }, { id: 'audit', label: 'Audit history' }]} />}

      {tab === 'work' && (
        <div className="split">
          <div className="stack">
            {a.respond && <RespondCard d={d} />}
            <Card title="Timeline" actions={vendor ? undefined : <span className="small muted"><Lock size={12} aria-hidden /> Internal entries are hidden from the vendor</span>}>
              <Timeline events={d.events} vendor={vendor} />
              {a.note && <NoteForm id={d.id} />}
            </Card>
            <Card title="Evidence and documents">
              <div className="stack">
                <AttachmentList ownerType="dispute" ownerId={d.id} />
                {a.evidence && <EvidenceAdder d={d} />}
              </div>
            </Card>
          </div>
          <div className="stack">
            <Card title="Dispute">
              <KV items={[
                ['Type', d.type], ['Quantity', `${fmtNum(d.qty)} ${d.line.uom}`], ['Value', fmtMoney(d.value, true)],
                ['Delivery term', <><TermBadge term={d.delivery_term} /> <DecisionTag id="DEC-24" /></>],
                ['Owner', <><strong>{d.owner_label}</strong>{!vendor && d.owner_party !== d.default_owner && <div className="small subtle">Default was {d.default_owner}</div>}</>],
                ['Raised', `${fmtDateTime(d.created_at)} by ${vendor ? 'Equipcare' : d.raised_by_name}`], ['Source', vendor ? 'Receipt at plant' : d.source],
                ['Age', <AgeCell days={d.age_days} open={d.open} threshold={d.threshold_days} />],
                ['Outcome', d.outcome ? <><strong>{d.outcome}</strong>{d.outcome_amount ? ` · ${fmtMoney(d.outcome_amount, true)}` : ''}</> : '—'],
              ]} />
              {d.description_text && <p className="small muted" style={{ marginTop: 10 }}>“{d.description_text}”</p>}
              {d.outcome_note && <p className="small muted" style={{ marginTop: 6 }}>Outcome note: {d.outcome_note}</p>}
            </Card>
            <Card title="Receipt">
              <KV items={[
                ['PO line', <span className="mono">{d.po.po_no}/{d.line.item}</span>], ['Material', d.line.description], ['Ordered / received', `${fmtNum(d.line.qty)} / ${fmtNum(d.line.received_qty)} ${d.line.uom}`],
                ...(d.line.unit_price != null ? [['Unit price', fmtMoney(d.line.unit_price)]] as [string, React.ReactNode][] : []),
                ['ASN', d.asn ? <Link className="mono" to={vendor ? `/vendor/asns/${d.asn.id}` : `/asns/${d.asn.id}`}>{d.asn.asn_no}</Link> : '—'],
                ...(d.asn ? [['Transporter / LR', `${d.asn.transporter ?? '—'} · ${d.asn.lr_no ?? '—'}`], ['Transit risk', d.asn.transit_risk]] as [string, React.ReactNode][] : []),
                ['GRN', d.grn ? <span className="mono">{d.grn.grn_no} · {fmtNum(d.grn.qty)} · {fmtDate(d.grn.posting_date)}</span> : '—'],
                ['Plant', d.po.plant],
              ]} />
            </Card>
            <Card title="Invoices on this PO" actions={<span className="small muted">Hold rule <DecisionTag id="DEC-20" /></span>}>
              {d.invoices.length ? (
                <ul className="list-plain stack-sm">
                  {d.invoices.map((i) => (
                    <li key={i.id} className="row between" style={{ gap: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        {vendor ? <Link className="mono" to={`/vendor/invoices/${i.id}`}>{i.inv_ref}</Link> : <Link className="mono" to={`/invoices/${i.id}`}>{i.inv_ref}</Link>}
                        <div className="small subtle">{i.vendor_invoice_no ?? '—'} · {fmtMoney(i.total_value, true)}</div>
                        {!vendor && i.dispute_hold ? <div className="small" style={{ color: 'var(--warn)', fontWeight: 600 }}>Held for dispute</div> : null}
                      </div>
                      <Status value={i.status} />
                    </li>
                  ))}
                </ul>
              ) : <p className="small muted">No invoice has been uploaded for this PO yet.</p>}
              {!vendor && d.open && <p className="small muted" style={{ marginTop: 10 }}>While this dispute is open, finance sees it as a dispute hold on invoices for line {d.line.item}. Resolving it releases the hold.</p>}
            </Card>
          </div>
        </div>
      )}
      {tab === 'audit' && !vendor && <Card title="Audit history"><AuditTrail objectType="dispute" objectId={d.id} /></Card>}

      {!vendor && (
        <>
          <ReassignDialog d={d} open={dialog === 'reassign'} onClose={() => setDialog(null)} />
          <OutcomeDialog d={d} open={dialog === 'outcome'} onClose={() => setDialog(null)} />
          <ReasonDialog open={dialog === 'close'} onClose={() => setDialog(null)} title={d.closure_approval ? 'Send closure for approval' : `Close ${d.dsp_no}`} confirmLabel={d.closure_approval ? 'Send for approval' : 'Close dispute'} variant="deep" minLength={0} label="Closing note (optional)"
            sub={d.closure_approval ? <>Closure needs Procurement Manager approval <DecisionTag id="Q 7.8" />.</> : `Outcome ${d.outcome ?? ''} is recorded. Invoices held for this dispute can be released.`} onSubmit={(n) => close.run(n)} />
          <ReasonDialog open={dialog === 'reopen'} onClose={() => setDialog(null)} title={`Reopen ${d.dsp_no}`} confirmLabel="Reopen dispute" variant="primary" sub="The previous outcome is cleared and the owner is notified." onSubmit={(r) => reopen.run(r)} />
          <ReasonDialog open={dialog === 'request'} onClose={() => setDialog(null)} title="Ask the vendor to respond" confirmLabel="Send request" label="What do you need from the vendor?" sub="Shown to the vendor on the timeline and sent as a notification." onSubmit={(m) => request.run(m)} />
        </>
      )}
    </>
  );
}

function Timeline({ events, vendor }: { events: DisputeEvent[]; vendor: boolean }) {
  return (
    <ol className="timeline">
      {[...events].reverse().map((e) => (
        <li key={e.id}>
          <span className="timeline__dot" data-tone={KIND_TONE[e.kind]} aria-hidden />
          <div className="timeline__title">
            {KIND_LABEL[e.kind] ?? e.kind}
            {!vendor && !e.vendor_visible && <span className="small" style={{ marginLeft: 8, color: 'var(--text-3)' }}><Lock size={11} aria-hidden /> internal</span>}
          </div>
          <div className="timeline__meta" title={fmtDateTime(e.created_at)}>{e.user_name ?? 'System'}{e.is_vendor ? ' (vendor)' : ''} · {ago(e.created_at)}</div>
          <div className="timeline__body" style={{ whiteSpace: 'pre-wrap' }}>{e.body}</div>
        </li>
      ))}
    </ol>
  );
}

function NoteForm({ id }: { id: number }) {
  const [body, setBody] = useState('');
  const [visible, setVisible] = useState(false);
  const act = useAction(() => api.post(`/asn/disputes/${id}/notes`, { body, vendor_visible: visible }), {
    success: visible ? 'Message sent to the vendor' : 'Internal note added', invalidate: [['asn']], onSuccess: () => setBody(''),
  });
  return (
    <div className="stack-sm" style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <Textarea aria-label="Note" rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} placeholder={visible ? 'Message the vendor will see…' : 'Internal note (not visible to the vendor)…'} />
      <div className="row between" style={{ flexWrap: 'wrap' }}>
        <Checkbox label="Visible to the vendor" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
        <Button variant="deep" size="sm" icon={visible ? <Send /> : <MessageSquare />} loading={act.busy} disabled={body.trim().length < 3} onClick={act.fire}>{visible ? 'Send to vendor' : 'Add internal note'}</Button>
      </div>
    </div>
  );
}

function EvidenceAdder({ d }: { d: DisputeDetail }) {
  const meta = useAsnMeta();
  const [label, setLabel] = useState('Transporter claim');
  const [files, setFiles] = useState<Uploaded[]>([]);
  const [visible, setVisible] = useState(true);
  const [reset, setReset] = useState(0);
  const act = useAction(() => api.post(`/asn/disputes/${d.id}/evidence`, { attachment_ids: files.map((f) => f.id) }), {
    success: `${files.length} document${files.length === 1 ? '' : 's'} added to ${d.dsp_no}`, invalidate: [['asn'], ['files', 'dispute', d.id]], onSuccess: () => { setFiles([]); setReset((n) => n + 1); },
  });
  return (
    <div className="stack-sm" style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div className="row-wrap">
        <Field label="Document type"><Select value={label} onChange={(e) => { setLabel(e.target.value); setFiles([]); setReset((n) => n + 1); }} options={meta.data?.evidence_labels ?? ['Photo', 'GRN note', 'Rejection note', 'Shortage report', 'Transporter claim', 'Insurance claim', 'Other']} style={{ minWidth: 200 }} /></Field>
        <Checkbox label="Visible to the vendor" checked={visible} onChange={(e) => { setVisible(e.target.checked); setFiles([]); setReset((n) => n + 1); }} />
      </div>
      <FileDrop key={`${label}-${visible}-${reset}`} label={label} camera compact vendorVisible={visible} onUploaded={setFiles} />
      <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="deep" size="sm" icon={<FilePlus2 />} loading={act.busy} disabled={!files.length} onClick={act.fire}>Add to dispute</Button></div>
    </div>
  );
}

function RespondCard({ d }: { d: DisputeDetail }) {
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<Uploaded[]>([]);
  const [reset, setReset] = useState(0);
  const act = useAction(() => api.post(`/asn/disputes/${d.id}/respond`, { body, attachment_ids: files.map((f) => f.id) }), {
    success: `Response sent to Equipcare for ${d.dsp_no}`, invalidate: [['asn'], ['files', 'dispute', d.id], ['nav-counts']], onSuccess: () => { setBody(''); setFiles([]); setReset((n) => n + 1); }, silentError: true,
  });
  return (
    <Card title="Respond to Equipcare">
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="Your response" required hint="Say what you will do: replace, credit, dispute the claim, and when. Attach packing list, LR, photos or a credit note below." error={fieldError(act.error, 'body')}>
          <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={3000} />
        </Field>
        <FileDrop key={reset} label="Vendor response" camera compact onUploaded={setFiles} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="primary" icon={<Send />} loading={act.busy} disabled={body.trim().length < 10} onClick={act.fire}>Send response</Button>
        </div>
      </div>
    </Card>
  );
}

function ReassignDialog({ d, open, onClose }: { d: DisputeDetail; open: boolean; onClose: () => void }) {
  const meta = useAsnMeta();
  const owners = useQuery<{ id: number; name: string; roles: string; title: string | null }[]>({ queryKey: ['asn', 'owners'], queryFn: () => api.get('/asn/disputes/owners'), enabled: open });
  const [party, setParty] = useState(d.owner_party);
  const [user, setUser] = useState('');
  const act = useAction(async (reason: string) => api.post(`/asn/disputes/${d.id}/reassign`, { owner_party: party, owner_user_id: user ? Number(user) : undefined, reason }), {
    success: `${d.dsp_no} reassigned to ${party}`, invalidate: [['asn']],
  });
  return (
    <ReasonDialog open={open} onClose={onClose} title={`Reassign ${d.dsp_no}`} confirmLabel="Reassign" variant="deep" label="Reason for reassignment" onSubmit={(r) => act.run(r)}
      sub={<>Default owner for {d.delivery_term} {d.type.toLowerCase()} is {d.default_owner} <DecisionTag id="DEC-24" />. Vendor owners are notified; the change is audited.</>}>
      <Field label="New owner" required><Select value={party} onChange={(e) => { setParty(e.target.value); setUser(''); }} options={meta.data?.owner_parties ?? ['Vendor', 'Procurement', 'Logistics', 'Stores', 'Finance']} /></Field>
      {party !== 'Vendor' && (
        <Field label="Owner (optional)" hint="Leave empty to use the PO buyer, plant stores user or finance team.">
          <Select value={user} onChange={(e) => setUser(e.target.value)} placeholder="Default for this party" options={(owners.data ?? []).map((u) => ({ value: u.id, label: `${u.name}${u.title ? ` — ${u.title}` : ''}` }))} />
        </Field>
      )}
    </ReasonDialog>
  );
}

function OutcomeDialog({ d, open, onClose }: { d: DisputeDetail; open: boolean; onClose: () => void }) {
  const meta = useAsnMeta();
  const [outcome, setOutcome] = useState('');
  const [amount, setAmount] = useState('');
  const needsAmount = ['Credit note', 'Debit note', 'Transporter claim', 'Insurance claim'].includes(outcome);
  const act = useAction((note: string) => api.post(`/asn/disputes/${d.id}/outcome`, { outcome, note, amount: amount ? Number(amount) : undefined }), {
    success: `Outcome recorded: ${outcome}`, invalidate: [['asn']],
  });
  return (
    <ReasonDialog open={open} onClose={onClose} title={`Record outcome for ${d.dsp_no}`} confirmLabel="Record outcome" variant="primary" label="Outcome note" extraValid={!!outcome && (!needsAmount || Number(amount) > 0)}
      sub="The dispute becomes Resolved. Procurement then closes it; invoices held for this dispute are released or adjusted by finance." onSubmit={(n) => act.run(n)}>
      <Field label="Outcome" required><Select value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Choose the outcome" options={meta.data?.outcomes ?? ['Replacement', 'Credit note', 'Debit note', 'Transporter claim', 'Insurance claim', 'Accepted as-is', 'Claim rejected']} /></Field>
      {needsAmount && <Field label="Amount (INR)" required><Input type="number" inputMode="decimal" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>}
    </ReasonDialog>
  );
}
