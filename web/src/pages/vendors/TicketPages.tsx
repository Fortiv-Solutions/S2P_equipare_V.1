/** Tickets: internal handling (SCR tickets) and vendor portal (SCR-VPT-10). */
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, UserCheck, Send, CheckCircle2, Shuffle } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { ago, fmtDate, fmtDateTime } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, KV, Loader, PageHeader, Ref, Status, Tabs } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { ErrorSummary, Field, Input, Select, Textarea, Checkbox, fieldError } from '@/components/forms';
import { ReasonDialog } from '@/components/overlay';
import { AttachmentList, FileDrop, type Uploaded } from '@/components/Attachments';
import { AuditTrail } from '@/components/AuditTrail';
import { Avatar } from '@/components/ui';
import { TICKET_PRIORITIES, slaText } from './shared';

interface TicketRow {
  id: number; tkt_no: string; vendor_id: number; vendor_name?: string; sap_code?: string; category: string; subject: string; status: string; priority: string;
  assignee_role: string | null; assignee_name: string | null; assignee_id: number | null; raised_by_name: string; sla_due: string | null; sla_breached: boolean;
  created_at: string; updated_at: string; messages: number;
}
const TEAM: Record<string, string> = { ADM: 'Portal administration', BUY: 'Procurement', APR: 'Procurement management', FIN: 'Finance / accounts', STO: 'Stores', SAP: 'SAP / IT' };
const base = (vendor: boolean) => (vendor ? '/vendor/tickets' : '/tickets');

// ------------------------------------------------------------------ list
export function TicketsListPage({ vendor }: { vendor?: boolean }) {
  const { me } = useAuth();
  const [sp, setSp] = useSearchParams();
  const queue = sp.get('queue') ?? (vendor ? 'all' : 'role');
  const q = useQuery<TicketRow[]>({ queryKey: ['tickets', 'list', queue], queryFn: () => api.get('/vendors/tickets', vendor ? {} : { queue: queue === 'all' ? undefined : queue }) });
  const set = (v: string) => { sp.set('queue', v); setSp(sp, { replace: true }); };
  return (
    <>
      <PageHeader
        title={vendor ? 'Help & tickets' : 'Vendor tickets'} screen={vendor ? 'SCR-VPT-10' : 'FR-VPT-09'} eyebrow="Module 9"
        sub={vendor ? 'Ask Equipcare for help with access, RFQs, purchase orders, invoices, payments or documents. Your ticket goes to the right team.' : `Tickets from vendors, routed by category to a team. You are viewing as ${me?.roleLabel}.`}
        actions={vendor ? <ButtonLink to="/vendor/tickets/new" variant="primary" icon={<Plus size={16} />}>New ticket</ButtonLink> : undefined}
      />
      {!vendor && (
        <Tabs value={queue} onChange={set} tabs={[{ id: 'role', label: 'My team' }, { id: 'mine', label: 'Assigned to me' }, { id: 'all', label: 'All tickets' }]} />
      )}
      <Card flush>
        <DataTable<TicketRow>
          id={vendor ? 'vendor-tickets' : 'tickets'} rows={q.data} loading={q.isLoading} error={q.error} refetch={() => q.refetch()} rowKey={(r) => r.id} rowLink={(r) => `${base(!!vendor)}/${r.id}`}
          initialSort={{ key: 'updated_at', dir: 'desc' }}
          columns={[
            { key: 'tkt_no', header: 'Ticket', render: (r) => <Ref to={`${base(!!vendor)}/${r.id}`}>{r.tkt_no}</Ref>, nowrap: true },
            { key: 'subject', header: 'Subject', render: (r) => <div style={{ minWidth: 220 }}><strong>{r.subject}</strong><div className="small subtle">{r.category}{!vendor && r.vendor_name ? ` · ${r.vendor_name}` : ''}</div></div>, value: (r) => `${r.subject} ${r.category} ${r.vendor_name ?? ''}` },
            { key: 'status', header: 'Status', render: (r) => <Status value={r.status} /> },
            { key: 'priority', header: 'Priority', render: (r) => <span className={`chip${r.priority !== 'Normal' ? ' chip--priority chip--Urgent' : ''}`}>{r.priority}</span> },
            ...(vendor ? [] : [
              { key: 'assignee_role', header: 'Team', render: (r: TicketRow) => TEAM[r.assignee_role ?? ''] ?? r.assignee_role ?? '—' },
              { key: 'assignee_name', header: 'Assignee', render: (r: TicketRow) => r.assignee_name ?? <span className="subtle">Unassigned</span> },
              { key: 'sla', header: 'SLA', value: (r: TicketRow) => slaText(r), render: (r: TicketRow) => <span style={{ color: r.sla_breached ? 'var(--bad)' : undefined, fontWeight: r.sla_breached ? 700 : 500 }}>{slaText(r)}</span> },
            ]),
            { key: 'messages', header: 'Messages', align: 'right' },
            { key: 'updated_at', header: 'Updated', render: (r) => ago(r.updated_at), value: (r) => r.updated_at, nowrap: true },
          ]}
          filters={[{ key: 'status', label: 'Status', value: (r) => r.status }, { key: 'category', label: 'Category', value: (r) => r.category }, ...(vendor ? [] : [{ key: 'vendor', label: 'Vendor', value: (r: TicketRow) => r.vendor_name }])]}
          searchPlaceholder="Search ticket, subject, vendor…"
          mobile={{ title: (r) => r.subject, badge: (r) => <Status value={r.status} />, meta: (r) => [r.tkt_no, r.category, ago(r.updated_at), ...(vendor ? [] : [r.vendor_name ?? ''])] }}
          empty={<div className="empty"><div className="empty__title">{vendor ? 'No tickets yet' : 'No tickets in this queue'}</div><div>{vendor ? 'Raise a ticket if you need help — we reply here and notify you.' : 'Vendor tickets routed to your team appear here.'}</div>{vendor && <ButtonLink to="/vendor/tickets/new" variant="primary">Raise a ticket</ButtonLink>}</div>}
        />
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ new (vendor)
export function NewTicketPage() {
  const navigate = useNavigate();
  const meta = useQuery<{ categories: string[]; sla_hours: Record<string, number> }>({ queryKey: ['tickets', 'meta'], queryFn: () => api.get('/vendors/tickets/meta') });
  const [f, setF] = useState({ category: '', subject: '', body: '', priority: 'Normal', object_ref: '' });
  const [files, setFiles] = useState<Uploaded[]>([]);
  const create = useAction(() => api.post<{ id: number; tkt_no: string }>('/vendors/tickets', { ...f, object_ref: f.object_ref || undefined, attachment_ids: files.map((x) => x.id) }), {
    success: (r) => `Ticket ${r.tkt_no} raised`, invalidate: [['tickets']], onSuccess: (r) => navigate(`/vendor/tickets/${r.id}`), silentError: true,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const hints: Record<string, string> = { 'Login / access': 'Portal administration', 'RFQ access': 'Procurement', 'PO visibility': 'Procurement', 'Invoice upload': 'Finance', 'Payment query': 'Finance', 'Document issue': 'Procurement', 'Dispute clarification': 'Procurement' };
  return (
    <>
      <PageHeader eyebrow={<><Link to="/vendor/tickets">Help & tickets</Link><span>/</span><span>New</span></>} screen="SCR-VPT-10" title="Raise a ticket" />
      <div className="split">
        <Card>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); create.fire(); }}>
            <ErrorSummary error={create.error} />
            <div className="form-grid">
              <Field label="What is it about?" required hint={f.category ? `Goes to: ${hints[f.category] ?? 'the right Equipcare team'}` : undefined} error={fieldError(create.error, 'category')}>
                <Select value={f.category} onChange={set('category')} placeholder="Choose a category" options={meta.data?.categories ?? []} />
              </Field>
              <Field label="Priority" hint={meta.data ? `We aim to respond within ${meta.data.sla_hours[f.priority] ?? '—'} hours.` : undefined}><Select value={f.priority} onChange={set('priority')} options={TICKET_PRIORITIES} /></Field>
              <Field label="Subject" required className="span-2" error={fieldError(create.error, 'subject')}><Input value={f.subject} onChange={set('subject')} maxLength={140} /></Field>
              <Field label="Related document (optional)" hint="PO, invoice, RFQ or dispute number" ><Input value={f.object_ref} onChange={set('object_ref')} maxLength={60} /></Field>
              <Field label="Describe the problem" required className="span-2" error={fieldError(create.error, 'body')}><Textarea rows={6} value={f.body} onChange={set('body')} maxLength={4000} /></Field>
            </div>
            <FileDrop label="Screenshots or documents (optional)" onUploaded={setFiles} compact camera />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <ButtonLink to="/vendor/tickets">Cancel</ButtonLink>
              <Button type="submit" variant="primary" icon={<Send />} loading={create.busy} disabled={!f.category || f.subject.trim().length < 5 || f.body.trim().length < 10}>Raise ticket</Button>
            </div>
          </form>
        </Card>
        <Card title="How tickets work"><p className="small muted">Each category goes to the Equipcare team that can fix it. You will see replies here and get a notification when the status changes. Internal discussion between Equipcare staff is never shown to you.</p></Card>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ detail
export function TicketDetailPage({ vendor }: { vendor?: boolean }) {
  const id = Number(useParams().id);
  const q = useQuery<any>({ queryKey: ['tickets', 'detail', id], queryFn: () => api.get(`/vendors/tickets/${id}`) });
  return <Loader q={q} rows={8}>{(t) => <TicketView t={t} vendor={!!vendor} />}</Loader>;
}

function TicketView({ t, vendor }: { t: any; vendor: boolean }) {
  const { me, can } = useAuth();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [dlg, setDlg] = useState<'resolve' | 'route' | null>(null);
  const [route, setRoute] = useState('');
  const inv = [['tickets'], ['notifications']];
  const reply = useAction(() => api.post(`/vendors/tickets/${t.id}/messages`, { body, internal: !vendor && internal }), { success: internal ? 'Internal note added' : 'Reply sent', invalidate: inv, onSuccess: () => setBody('') });
  const status = useAction((s: string, note?: string) => api.post(`/vendors/tickets/${t.id}/status`, { status: s, note: note || undefined }), { success: 'Ticket status updated', invalidate: inv });
  const assign = useAction((userId?: number) => api.post(`/vendors/tickets/${t.id}/assign`, { user_id: userId }), { success: 'Ticket assigned', invalidate: inv });
  const reroute = useAction((reason: string) => api.post(`/vendors/tickets/${t.id}/route`, { role: route, reason }), { success: 'Ticket re-routed', invalidate: inv });
  const closed = t.status === 'Closed';
  const handler = !vendor && can('tkt.handle');
  return (
    <>
      <PageHeader
        eyebrow={<><Link to={base(vendor)}>{vendor ? 'Help & tickets' : 'Vendor tickets'}</Link><span>/</span><span className="mono">{t.tkt_no}</span></>} screen={vendor ? 'SCR-VPT-10' : 'FR-VPT-09'}
        title={t.subject} badges={<><Status value={t.status} />{t.priority !== 'Normal' && <Badge tone="warn">{t.priority}</Badge>}</>}
        sub={<>{t.category} · raised {fmtDateTime(t.created_at)}{t.object_ref ? ` · about ${t.object_ref}` : ''}</>}
        actions={handler && !closed ? (
          <>
            {t.assignee_id !== me?.id && <Button icon={<UserCheck />} loading={assign.busy} onClick={() => assign.fire()}>Assign to me</Button>}
            {!['Resolved'].includes(t.status) && <Button variant="ok" icon={<CheckCircle2 />} onClick={() => setDlg('resolve')}>Resolve</Button>}
          </>
        ) : vendor && t.status === 'Resolved' ? <Button variant="ok" icon={<CheckCircle2 />} loading={status.busy} onClick={() => status.fire('Closed')}>Close ticket</Button> : undefined}
      />
      <div className="split">
        <div className="stack">
          {vendor && t.status === 'Awaiting vendor' && <Callout tone="warn" title="Equipcare is waiting for your reply">Answer below so the team can continue.</Callout>}
          {vendor && t.status === 'Resolved' && <Callout tone="ok" title="Marked resolved">Close the ticket, or reply below if the problem is not fixed — that reopens it.</Callout>}
          <Card title="Conversation">
            <div className="thread">
              {t.messages.map((m: any) => (
                <div key={m.id} className="msg" data-mine={m.user_id === me?.id} style={m.internal ? { opacity: 1 } : undefined}>
                  <Avatar name={m.user_name} size="sm" />
                  <div style={{ minWidth: 0 }}>
                    <div className="msg__meta" title={fmtDateTime(m.created_at)}>{m.user_name}{m.from_vendor ? '' : vendor ? ' · Equipcare' : ''} · {ago(m.created_at)}{m.internal ? ' · internal note' : ''}</div>
                    <div className="msg__bubble" style={{ whiteSpace: 'pre-wrap', ...(m.internal ? { background: 'var(--warn-bg)', border: '1px dashed var(--amber-600)' } : {}) }}>{m.body}</div>
                  </div>
                </div>
              ))}
            </div>
            {!closed ? (
              <form className="stack-sm" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); reply.fire(); }}>
                <Textarea aria-label="Message" rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} placeholder={internal ? 'Internal note — visible to Equipcare staff only' : vendor ? 'Write your reply…' : 'Reply to the vendor…'} />
                <div className="row between" style={{ flexWrap: 'wrap' }}>
                  {handler ? <Checkbox label="Internal note (not visible to the vendor)" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> : <span />}
                  <Button type="submit" variant="deep" icon={<Send />} loading={reply.busy} disabled={body.trim().length < 3}>{internal ? 'Add internal note' : 'Send reply'}</Button>
                </div>
              </form>
            ) : <Callout tone="info">This ticket is closed. Raise a new ticket if you need more help.</Callout>}
          </Card>
          {handler && <Card title="Audit history"><AuditTrail objectType="ticket" objectId={t.id} /></Card>}
        </div>
        <div className="stack">
          <Card title="Details">
            <KV items={[
              ['Ticket', <span className="mono">{t.tkt_no}</span>], ['Category', t.category], ['Status', <Status value={t.status} />],
              ...(vendor ? [['Handled by', t.team]] as [string, React.ReactNode][] : [
                ['Vendor', t.vendor ? <Link to={`/vendors/${t.vendor.id}`}>{t.vendor.name}</Link> : '—'], ['Raised by', t.raised_by_name], ['Team', t.team], ['Assignee', t.assignee_name ?? 'Unassigned'],
              ] as [string, React.ReactNode][]),
              ...(vendor ? [] : [['SLA', <span style={{ color: t.sla_breached ? 'var(--bad)' : undefined, fontWeight: t.sla_breached ? 700 : 500 }}>{t.sla_due ? `${slaText(t)}${['Resolved', 'Closed'].includes(t.status) ? '' : ` · ${fmtDate(t.sla_due)}`}` : '—'}</span>]] as [string, React.ReactNode][]),
              ['Updated', ago(t.updated_at)], ['Resolved', t.resolved_at ? fmtDateTime(t.resolved_at) : '—'],
            ]} />
          </Card>
          {handler && !closed && (
            <Card title="Handle">
              <div className="stack">
                <Field label="Status"><Select value={t.status} onChange={(e) => { if (e.target.value === 'Resolved') setDlg('resolve'); else status.fire(e.target.value); }} options={t.statuses} /></Field>
                {t.assignees?.length > 0 && <Field label="Assign to"><Select value={t.assignee_id ?? ''} placeholder="Choose a person" onChange={(e) => e.target.value && assign.fire(Number(e.target.value))} options={t.assignees.map((u: any) => ({ value: u.id, label: u.name }))} /></Field>}
                <Button icon={<Shuffle />} onClick={() => { setRoute(''); setDlg('route'); }}>Re-route to another team</Button>
                <p className="small muted">Routed by category from business configuration (tickets.routing).</p>
              </div>
            </Card>
          )}
          <Card title="Attachments"><AttachmentList ownerType="ticket" ownerId={t.id} canUpload={!closed} /></Card>
        </div>
      </div>
      <ReasonDialog open={dlg === 'resolve'} onClose={() => setDlg(null)} title="Resolve ticket" sub="The vendor is notified and sees this note." label="Resolution note" confirmLabel="Mark resolved" variant="ok" onSubmit={(n) => status.run('Resolved', n)} />
      <ReasonDialog open={dlg === 'route'} onClose={() => setDlg(null)} title="Re-route ticket" sub="The new team is notified. The reason is added as an internal note." confirmLabel="Re-route" extraValid={!!route} onSubmit={(r) => reroute.run(r)}>
        <Field label="Team" required><Select value={route} onChange={(e) => setRoute(e.target.value)} placeholder="Choose a team" options={Object.entries(TEAM).filter(([k]) => k !== t.assignee_role).map(([value, label]) => ({ value, label }))} /></Field>
      </ReasonDialog>
    </>
  );
}
