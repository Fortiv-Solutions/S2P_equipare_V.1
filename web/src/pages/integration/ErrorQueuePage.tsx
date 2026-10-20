import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw, Trash2, Pencil } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { ago, fmtDateTime } from '@/lib/format';
import { Badge, Button, Callout, Card, KV, Loader, PageHeader, SectionTitle, Segmented, SimBadge, Status } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Drawer, Modal, ReasonDialog } from '@/components/overlay';
import { ErrorSummary, Field, Textarea } from '@/components/forms';
import { IntegrationNav, prettyJson } from './shared';

interface Err {
  id: number; flow: string; flow_name: string; direction: string; message_id: string; idempotency_key: string | null; doc_type: string | null; doc_key: string | null; pull_failure: boolean;
  payload: unknown; error: string; error_type: 'transient' | 'business'; attempts: number; status: string; next_retry_at: string | null; created_at: string; updated_at: string;
  resolved_by_name: string | null; resolution_reason: string | null; open: boolean; editable: boolean; can_replay: boolean;
}
interface ErrDetail extends Err { outbound: { status: string; attempts: number; sap_doc_key: string | null } | null; sap_document: { payload: unknown; changed_at: string } | null; trail: { id: number; ts: string; actor_name: string; role: string; action: string; reason: string | null }[] }

type StatusView = 'open' | 'Failed' | 'Retrying' | 'Resolved' | 'all';

export default function ErrorQueuePage() {
  const [sp, setSp] = useSearchParams();
  const status = (sp.get('status') as StatusView) ?? 'open';
  const flow = sp.get('flow') ?? undefined;
  const focus = sp.get('focus');
  const q = useQuery<Err[]>({ queryKey: ['integration', 'errors', status, flow], queryFn: () => api.get('/sap/errors', { status, flow }) });
  const setStatus = (v: StatusView) => { sp.set('status', v); setSp(sp, { replace: true }); };
  const open = (id: number | null) => { if (id) sp.set('focus', String(id)); else sp.delete('focus'); setSp(sp, { replace: true }); };

  const cols: Column<Err>[] = useMemo(() => [
    { key: 'id', header: '#', render: (r) => <span className="mono">{r.id}</span>, value: (r) => r.id, width: 50 },
    { key: 'flow', header: 'Flow', render: (r) => <div><span className="mono">{r.flow}</span><div className="small subtle">{r.flow_name}</div></div>, value: (r) => `${r.flow} ${r.flow_name}` },
    { key: 'direction', header: 'Direction' },
    { key: 'doc_key', header: 'Message', render: (r) => <span className="mono small">{r.doc_type} {r.doc_key}</span>, value: (r) => `${r.doc_type} ${r.doc_key}` },
    { key: 'error', header: 'Error', render: (r) => <span className="small">{r.error}</span> },
    { key: 'error_type', header: 'Type', render: (r) => <Badge tone={r.error_type === 'business' ? 'bad' : 'warn'}>{r.error_type === 'business' ? 'Business' : 'Transient'}</Badge> },
    { key: 'attempts', header: 'Attempts', align: 'right' },
    { key: 'next_retry_at', header: 'Next retry', render: (r) => (r.status === 'Retrying' && r.next_retry_at ? <span title={fmtDateTime(r.next_retry_at)}>{ago(r.next_retry_at)}</span> : r.error_type === 'business' && r.open ? <span className="small muted">No automatic retry</span> : '—'), nowrap: true },
    { key: 'status', header: 'Status', render: (r) => <Status value={r.status} /> },
    { key: 'updated_at', header: 'Updated', render: (r) => fmtDateTime(r.updated_at), hidden: true },
  ], []);

  return (
    <>
      <PageHeader title="Integration error queue" screen="SCR-SAP-02" eyebrow="Module 12"
        sub="Failed and queued SAP messages with payload, error and attempts. Transient errors retry automatically with back-off; business errors wait for SAP/IT to correct, replay or discard them."
        badges={<SimBadge>Simulated SAP</SimBadge>} />
      <IntegrationNav counts={{ errors: status === 'open' ? q.data?.length : undefined }} />
      <div className="row-wrap between" style={{ margin: '16px 0 12px' }}>
        <Segmented<StatusView> label="Status" value={status} onChange={setStatus} options={[{ id: 'open', label: 'Open' }, { id: 'Failed', label: 'Failed (business)' }, { id: 'Retrying', label: 'Retrying' }, { id: 'Resolved', label: 'Resolved' }, { id: 'all', label: 'All' }]} />
        {flow && <Button size="sm" variant="ghost" onClick={() => { sp.delete('flow'); setSp(sp); }}>Showing {flow} only — show all flows</Button>}
      </div>
      <Card flush>
        <DataTable id="sap-errors" rows={q.data} loading={q.isLoading} error={q.error} refetch={q.refetch} rowKey={(r) => r.id} columns={cols} onRowClick={(r) => open(r.id)}
          filters={[{ key: 'flow', label: 'Flow', value: (r) => r.flow }, { key: 'type', label: 'Type', value: (r) => r.error_type }, { key: 'direction', label: 'Direction', value: (r) => r.direction }]}
          initialSort={{ key: 'id', dir: 'desc' }}
          empty={<div className="empty"><div className="empty__title">{status === 'open' ? 'No open integration errors' : 'Nothing in this view'}</div><div>Every SAP message in this view has been processed.</div></div>}
          mobile={{ title: (r) => <><span className="mono">{r.flow}</span> · {r.doc_key}</>, badge: (r) => <Status value={r.status} />, meta: (r) => [r.error_type, `${r.attempts} attempts`, r.error] }} />
      </Card>
      <ErrorDrawer id={focus ? Number(focus) : null} onClose={() => open(null)} />
    </>
  );
}

function ErrorDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { can } = useAuth();
  const q = useQuery<ErrDetail>({ queryKey: ['integration', 'error', id], queryFn: () => api.get(`/sap/errors/${id}`), enabled: !!id });
  const [dialog, setDialog] = useState<'edit' | 'discard' | null>(null);
  const inv = [['integration'], ['nav-counts'], ['meta']];
  const replay = useAction(() => api.post<{ result: { status: string; message: string } }>(`/sap/errors/${id}/replay`, {}), { success: (r) => (r.result.status === 'Failed' ? `Replay finished but the error remains: ${r.result.message}` : `Replayed: ${r.result.message}`), invalidate: inv });
  const discard = useAction((reason: string) => api.post(`/sap/errors/${id}/discard`, { reason }), { success: `Message ${id} discarded`, invalidate: inv });
  return (
    <Drawer open={!!id} onClose={onClose} title={`Integration message #${id ?? ''}`}
      footer={q.data?.open && can('sap.replay') ? (
        <>
          <Button variant="danger" icon={<Trash2 />} onClick={() => setDialog('discard')}>Discard</Button>
          {q.data.editable && <Button icon={<Pencil />} onClick={() => setDialog('edit')}>Edit and replay</Button>}
          <Button variant="deep" icon={<RotateCcw />} loading={replay.busy} onClick={replay.fire}>Replay</Button>
        </>
      ) : undefined}>
      <Loader q={q}>{(e) => (
        <div className="stack">
          <div className="row-wrap"><Status value={e.status} /><Badge tone={e.error_type === 'business' ? 'bad' : 'warn'}>{e.error_type === 'business' ? 'Business error — no automatic retry' : 'Transient — retried with back-off'}</Badge></div>
          <Callout tone={e.open ? (e.error_type === 'business' ? 'bad' : 'warn') : 'ok'} title={e.error}>{e.resolution_reason ? `${e.status}: ${e.resolution_reason}${e.resolved_by_name ? ` (${e.resolved_by_name})` : ''}` : e.open ? (e.direction === 'S2P → SAP' ? 'Replaying re-sends with the same idempotency key, so SAP never gets a second document.' : 'Correct the data in SAP (or the missing master/PO first), then replay to re-read it.') : null}</Callout>
          <KV items={[
            ['Flow', `${e.flow} ${e.flow_name}`], ['Direction', e.direction], ['Message', <span className="mono">{e.doc_type} {e.doc_key}</span>], ['Idempotency key', e.idempotency_key ? <span className="mono small">{e.idempotency_key}</span> : '—'],
            ['Attempts', e.attempts], ['Next retry', e.status === 'Retrying' && e.next_retry_at ? fmtDateTime(e.next_retry_at) : '—'], ['First failed', fmtDateTime(e.created_at)], ['Last update', fmtDateTime(e.updated_at)],
            ['Outbound record', e.outbound ? `${e.outbound.status} · ${e.outbound.attempts} attempt(s)` : '—'], ['SAP document', e.sap_document ? `Exists in SAP simulator (changed ${fmtDateTime(e.sap_document.changed_at)})` : 'Not in SAP'],
          ]} />
          <SectionTitle>Payload</SectionTitle>
          <pre className="mono small" style={{ background: 'var(--steel-50)', border: '1px solid var(--line)', borderRadius: 8, padding: 12, overflow: 'auto', maxHeight: 280, margin: 0 }}>{prettyJson(e.payload)}</pre>
          <SectionTitle>History</SectionTitle>
          {e.trail.length ? (
            <ol className="timeline">{e.trail.map((t) => <li key={t.id}><span className="timeline__dot" /><div className="timeline__title">{t.action.replace(/[._]/g, ' ')}</div><div className="timeline__meta">{t.actor_name} · {t.role} · {fmtDateTime(t.ts)}</div>{t.reason && <div className="timeline__body">{t.reason}</div>}</li>)}</ol>
          ) : <p className="small muted">No manual actions yet.</p>}
          <EditDialog e={e} open={dialog === 'edit'} onClose={() => setDialog(null)} />
          <ReasonDialog open={dialog === 'discard'} onClose={() => setDialog(null)} title={`Discard message #${e.id}`} variant="danger" confirmLabel="Discard message"
            sub="The message will not be retried. Use this when the document was reversed in SAP or the change is no longer needed." onSubmit={(r) => discard.run(r)} />
        </div>
      )}</Loader>
    </Drawer>
  );
}

function EditDialog({ e, open, onClose }: { e: ErrDetail; open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [parseErr, setParseErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setText(prettyJson(e.payload)); setParseErr(null); } }, [open, e.payload]);
  const act = useAction((payload: unknown) => api.post<{ result: { message: string } }>(`/sap/errors/${e.id}/replay`, { payload }), { success: (r) => `Corrected and replayed: ${r.result.message}`, invalidate: [['integration'], ['nav-counts']], onSuccess: onClose, silentError: true });
  const submit = () => {
    try {
      const v = JSON.parse(text);
      setParseErr(null);
      act.fire(v);
    } catch (x) {
      setParseErr(`The payload is not valid JSON: ${(x as Error).message}. Fix it and try again.`);
    }
  };
  return (
    <Modal open={open} onClose={onClose} wide title={`Correct payload and replay #${e.id}`} sub="The corrected payload and the original are both kept in the audit trail. The idempotency key does not change."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={act.busy} onClick={submit}>Replay with corrected payload</Button></>}>
      <div className="stack">
        {parseErr && <div className="error-summary" role="alert"><strong>{parseErr}</strong></div>}
        <ErrorSummary error={act.error instanceof ApiError ? act.error : null} />
        <Field label="Payload (JSON)" required><Textarea className="mono" rows={16} value={text} onChange={(ev) => setText(ev.target.value)} spellCheck={false} /></Field>
      </div>
    </Modal>
  );
}
