import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, CalendarClock, DatabaseZap, ListRestart } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { Badge, Button, Callout, Card, DecisionTag, Loader, PageHeader, SimBadge } from '@/components/ui';
import { ConfirmDialog, Modal } from '@/components/overlay';
import { ErrorSummary, Field, Input, Select, Textarea } from '@/components/forms';
import { IntegrationNav } from './shared';

interface Entry { flow: string; name: string; direction: string; doc_types: string[]; inbound: boolean; decision: string | null; symptoms: string[]; checks: string[]; steps: string[]; keyHint?: string }
interface Result { ok: boolean; message: string; error: { id: number; error: string } | null }

export default function RunbookPage() {
  const q = useQuery<Entry[]>({ queryKey: ['integration', 'runbook'], queryFn: () => api.get('/sap/runbook') });
  const hash = useLocation().hash.slice(1);
  useEffect(() => { if (hash && q.data) document.getElementById(hash)?.scrollIntoView({ block: 'start' }); }, [hash, q.data]);
  return (
    <>
      <PageHeader title="Recovery runbook" screen="SCR-SAP-01" eyebrow="Module 12 · FR-SAP-10"
        sub="Manual recovery steps per flow, with working actions: re-sync one document, re-sync from a date (resets the read position) or run a full re-sync. Each action is audited."
        badges={<SimBadge>Simulated SAP</SimBadge>} />
      <IntegrationNav />
      <div className="stack" style={{ marginTop: 16 }}>
        <Loader q={q} rows={8}>{(d) => <>{d.map((e) => <FlowEntry key={e.flow} e={e} />)}</>}</Loader>
      </div>
    </>
  );
}

function FlowEntry({ e }: { e: Entry }) {
  const { can } = useAuth();
  const [mode, setMode] = useState<'document' | 'from_date' | 'full' | null>(null);
  const queue = useAction(() => api.post<{ message: string }>('/sap/queue/process', { flow: e.flow }), { success: (r) => r.message, invalidate: [['integration'], ['nav-counts']] });
  return (
    <Card id={e.flow} title={<div className="row-wrap"><span className="mono">{e.flow}</span><h2>{e.name}</h2><Badge tone="deep">{e.direction}</Badge><DecisionTag id={e.decision} /></div>}
      actions={can('sap.replay') ? (e.inbound ? (
        <>
          <Button size="sm" icon={<DatabaseZap />} onClick={() => setMode('document')}>Re-sync one document</Button>
          <Button size="sm" icon={<CalendarClock />} onClick={() => setMode('from_date')}>Re-sync from a date</Button>
          <Button size="sm" variant="deep" icon={<RefreshCw />} onClick={() => setMode('full')}>Full re-sync</Button>
        </>
      ) : <Button size="sm" variant="deep" icon={<ListRestart />} loading={queue.busy} onClick={queue.fire}>Process queue now</Button>) : undefined}>
      <div className="grid-3">
        <div><h3 className="section-title">Symptoms</h3><ul className="stack-sm" style={{ paddingLeft: 18, margin: 0 }}>{e.symptoms.map((s) => <li key={s}>{s}</li>)}</ul></div>
        <div><h3 className="section-title">Check first</h3><ul className="stack-sm" style={{ paddingLeft: 18, margin: 0 }}>{e.checks.map((s) => <li key={s}>{s}</li>)}</ul></div>
        <div><h3 className="section-title">Recovery steps</h3><ol className="stack-sm" style={{ paddingLeft: 18, margin: 0 }}>{e.steps.map((s) => <li key={s}>{s}</li>)}</ol></div>
      </div>
      {!can('sap.replay') && <p className="small muted" style={{ marginTop: 10 }}>Recovery actions are run by SAP / IT.</p>}
      <ResyncDialog e={e} mode={mode} onClose={() => setMode(null)} />
    </Card>
  );
}

function ResyncDialog({ e, mode, onClose }: { e: Entry; mode: 'document' | 'from_date' | 'full' | null; onClose: () => void }) {
  const [docType, setDocType] = useState(e.doc_types[0]);
  const [key, setKey] = useState('');
  const [from, setFrom] = useState(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => { if (mode) { setResult(null); setKey(''); setReason(''); setDocType(e.doc_types[0]); } }, [mode, e.doc_types]);
  const act = useAction(() => api.post<Result>('/sap/resync', { flow: e.flow, mode, doc_type: docType, key: key.trim() || undefined, from: mode === 'from_date' ? from : undefined, reason: reason.trim() || undefined }), {
    invalidate: [['integration'], ['nav-counts'], ['meta']], onSuccess: (r) => setResult(r), silentError: true,
  });
  const title = mode === 'document' ? `Re-sync one ${e.name.toLowerCase()} document` : mode === 'from_date' ? `Re-sync ${e.name.toLowerCase()} from a date` : `Full re-sync of ${e.name.toLowerCase()}`;
  if (mode === 'full' && !result) {
    return (
      <ConfirmDialog open onClose={onClose} title={title} confirmLabel="Run full re-sync" variant="deep"
        onConfirm={async () => { const r = await api.post<Result>('/sap/resync', { flow: e.flow, mode: 'full', reason: 'Full re-sync from runbook' }); setResult(r); }}>
        <p>Reads every {e.doc_types.join(' / ')} document from SAP again and upserts it by SAP key. It is safe to repeat; existing records are updated, not duplicated.</p>
      </ConfirmDialog>
    );
  }
  return (
    <Modal open={!!mode} onClose={onClose} title={title} sub="SAP is simulated in this MVP."
      footer={result ? <Button variant="deep" onClick={onClose}>Done</Button> : <><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={act.busy} disabled={mode === 'document' && !key.trim()} onClick={act.fire}>Run re-sync</Button></>}>
      <div className="stack">
        {result ? <Callout tone={result.ok ? 'ok' : 'warn'} title={result.ok ? 'Re-sync finished' : 'Re-sync finished with errors'}>{result.message}{result.error && <> — {result.error.error}</>}</Callout> : (
          <>
            <ErrorSummary error={act.error} />
            {e.doc_types.length > 1 && <Field label="Document type" required><Select value={docType} onChange={(ev) => setDocType(ev.target.value)} options={e.doc_types} /></Field>}
            {mode === 'document' && <Field label="SAP document key" required hint={e.keyHint}><Input value={key} onChange={(ev) => setKey(ev.target.value)} className="mono" data-autofocus /></Field>}
            {mode === 'from_date' && <Field label="Re-sync documents changed since" required hint="The read position for this flow is reset to this date, then the flow runs."><Input type="date" value={from} max={new Date().toISOString().slice(0, 10)} onChange={(ev) => setFrom(ev.target.value)} /></Field>}
            <Field label="Reason" hint="Recorded in the audit trail."><Textarea rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={500} /></Field>
          </>
        )}
      </div>
    </Modal>
  );
}
