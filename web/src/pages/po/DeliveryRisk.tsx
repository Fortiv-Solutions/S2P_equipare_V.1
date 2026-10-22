import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, ClipboardPaste, Lightbulb } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Callout, Card, ErrorState, LoadingBlock } from '@/components/ui';
import { Field, Input, Select, Textarea, ErrorSummary, fieldError } from '@/components/forms';
import { Modal, useToast } from '@/components/overlay';
import { SourceTag } from '@/components/insights';

interface LineRisk {
  line_id: number; item: number; description: string; score: number; band: 'High' | 'Medium' | 'Low'; factors: { label: string; points: number }[];
  commitment: string; overdue_days: number; open_qty: number; uom: string;
  action: { type: 'remind' | 'escalate' | 'call' | 'monitor'; reminder?: string; label: string; why: string }; preview: { title: string; body: string } | null;
}
interface Reading {
  line_id: number; reasons: string[]; dates: { date: string; matched: string; confidence: 'high' | 'medium' }[]; suggested_date: string | null; suggested_reason: string | null;
  signals: { dispatched: boolean; refs: string[] }; note: string;
}

/**
 * Delivery risk for the open lines of a PO: the score and each factor behind it, the recommended step, and the exact
 * message the vendor would receive. Sending the reminder is one click and reuses the "Remind vendor" function.
 */
export function DeliveryRisk({ poId }: { poId: number }) {
  const q = useQuery<{ lines: LineRisk[] }>({ queryKey: ['insights', 'po-risk', poId], queryFn: () => api.get(`/insights/po/${poId}/risk`) });
  const [reply, setReply] = useState<LineRisk | null>(null);
  if (q.isLoading) return <Card title="Delivery risk"><LoadingBlock rows={2} /></Card>;
  if (q.error) return <Card title="Delivery risk"><ErrorState error={q.error} retry={q.refetch} /></Card>;
  const lines = (q.data?.lines ?? []).filter((l) => l.band !== 'Low' || l.action.type !== 'monitor');
  return (
    <Card title={<div className="row-wrap"><h2>Delivery risk</h2><SourceTag source="rules" /><span className="small muted">Every point comes from a factor listed below</span></div>}>
      {lines.length === 0 ? (
        <Callout tone="ok" title="No delivery risk found on this PO">Open lines are acknowledged and on track against their commitment dates.</Callout>
      ) : (
        <ul className="list-plain risks">
          {lines.map((l) => <LineCard key={l.line_id} poId={poId} l={l} onReply={() => setReply(l)} />)}
        </ul>
      )}
      {reply && <ReplyDialog line={reply} onClose={() => setReply(null)} />}
    </Card>
  );
}

function LineCard({ poId, l, onReply }: { poId: number; l: LineRisk; onReply: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => { for (const k of ['insights', 'po', 'home', 'nav-counts']) qc.invalidateQueries({ queryKey: [k] }); };
  const remind = useAction(() => api.post<{ lines: number; recipients: number }>(`/insights/po/${poId}/remind`, { line_id: l.line_id }), {
    success: (r) => `Reminder sent for line ${l.item}${r.recipients ? '' : ' (logged only: the vendor has no portal user)'}`, onSuccess: refresh,
  });
  const dismiss = useAction(() => api.post(`/insights/po/${poId}/dismiss`, { line_id: l.line_id }), { onSuccess: () => { toast('Hidden from the home lists for 24 hours', 'info'); refresh(); } });
  return (
    <li className="risk" data-sev={l.band === 'High' ? 'High' : 'Medium'}>
      <div className="row between" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div className="grow"><strong>Line {l.item} · {l.description}</strong><div className="small muted">Committed {fmtDate(l.commitment)}{l.overdue_days ? ` · ${l.overdue_days} day${l.overdue_days === 1 ? '' : 's'} late` : ''}</div></div>
        <Badge tone={l.band === 'High' ? 'bad' : l.band === 'Medium' ? 'warn' : 'neutral'}>{l.band} · {l.score}</Badge>
      </div>
      <ul className="risk__why">{l.factors.map((f) => <li key={f.label}>{f.label} <span className="subtle">(+{f.points})</span></li>)}</ul>
      <div className="small hint"><Lightbulb size={12} aria-hidden /> <strong>{l.action.label}.</strong> {l.action.why}</div>
      {l.preview && (
        <div className="preview" aria-label="Message the vendor will see">
          <div className="small subtle">The vendor will see (portal notification; e-mail is simulated)</div>
          <div style={{ fontWeight: 600 }}>{l.preview.title}</div>
          <div className="small">{l.preview.body}</div>
        </div>
      )}
      <div className="row-wrap" style={{ marginTop: 8 }}>
        {l.action.type === 'remind' && <Button size="sm" variant="primary" icon={<BellRing />} loading={remind.busy} onClick={remind.fire}>{l.action.label}</Button>}
        <Button size="sm" icon={<ClipboardPaste />} onClick={onReply}>Read the vendor’s reply</Button>
        <Button size="sm" variant="ghost" loading={dismiss.busy} onClick={dismiss.fire}>Not now</Button>
      </div>
    </li>
  );
}

function ReplyDialog({ line, onClose }: { line: LineRisk; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [reading, setReading] = useState<Reading | null>(null);
  const read = useAction(() => api.post<Reading>(`/insights/po-lines/${line.line_id}/read-reply`, { text }), {
    silentError: true, onSuccess: (r) => { setReading(r); setDate(r.suggested_date ?? ''); setReason(r.suggested_reason ?? ''); },
  });
  const apply = useAction(() => api.post(`/insights/po-lines/${line.line_id}/apply-reply`, { text, commit_date: date, delay_reason: reason }), {
    success: `Commitment recorded for line ${line.item}`, silentError: true,
    onSuccess: () => { for (const k of ['insights', 'po', 'home', 'nav-counts']) qc.invalidateQueries({ queryKey: [k] }); onClose(); },
  });
  return (
    <Modal open onClose={onClose} wide title={`Read the vendor’s reply · line ${line.item}`} sub="Paste what the vendor wrote. The date and reason are read by rules; nothing is saved until you confirm."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {!reading
          ? <Button variant="primary" loading={read.busy} disabled={text.trim().length < 5} onClick={read.fire}>Read reply</Button>
          : <Button variant="primary" loading={apply.busy} disabled={!date || !reason} onClick={apply.fire}>Record commitment</Button>}
      </>}>
      <div className="stack">
        <Field label="Vendor’s reply (from e-mail or WhatsApp)" error={fieldError(read.error, 'text')} required>
          <Textarea rows={4} value={text} maxLength={2000} onChange={(e) => { setText(e.target.value); setReading(null); }} placeholder="e.g. We will dispatch by 25 Nov. Truck not available this week." />
        </Field>
        {!!read.error && !reading && <ErrorSummary error={read.error} />}
        {reading && (
          <>
            <Callout tone={reading.suggested_date ? 'info' : 'warn'} title={reading.suggested_date ? 'What I read' : 'No usable date found'}>
              {reading.note}
              {reading.dates.length > 0 && <div className="row-wrap" style={{ marginTop: 6 }}>{reading.dates.map((d) => <button key={d.date} type="button" className="chip chip--btn" onClick={() => setDate(d.date)} title={`Found as “${d.matched}”`}>{fmtDate(d.date)} · {d.confidence}</button>)}</div>}
              {reading.signals.dispatched && <div className="small" style={{ marginTop: 6 }}>The reply says the goods have been dispatched{reading.signals.refs.length ? ` (reference ${reading.signals.refs.join(', ')})` : ''}. Ask the vendor to submit the ASN.</div>}
            </Callout>
            <div className="form-grid">
              <Field label="New commitment date" required error={fieldError(apply.error, 'commit_date')}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
              <Field label="Delay reason" required hint={reading.suggested_reason ? 'Suggested from the wording of the reply. Change it if it is wrong.' : 'The reply did not match a reason code. Choose one.'} error={fieldError(apply.error, 'delay_reason')}>
                <Select value={reason} onChange={(e) => setReason(e.target.value)} options={reading.reasons} placeholder="Choose a reason" />
              </Field>
            </div>
            {!!apply.error && <ErrorSummary error={apply.error} />}
          </>
        )}
      </div>
    </Modal>
  );
}
