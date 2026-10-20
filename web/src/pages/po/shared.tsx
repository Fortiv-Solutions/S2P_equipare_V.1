/** Pieces shared by the internal and vendor PO screens (Module 7). */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, todayISO } from '@/lib/format';
import { Badge, Callout, DecisionTag, Status } from '@/components/ui';
import { Field, Input, Select, Textarea, ErrorSummary, fieldError } from '@/components/forms';
import { Modal } from '@/components/overlay';
import { Button } from '@/components/ui';
import { chainFrom, type ChainStep } from '@/components/TrackChain';
import type { Amendment, Followup, PoDetail, PoLineDetail, SapAck } from './types';

const PENDING = ['Pending', 'Pending re-acknowledgement'];
export const ACKED = ['Accepted', 'Partially accepted', 'Deemed accepted'];

/** PO lifecycle (PRD 7.7 states): Published → Viewed → Acknowledged → In dispatch → Received → Closed. */
export function poChain(d: PoDetail): ChainStep[] {
  const labels = ['Published', 'Viewed', 'Acknowledged', 'In dispatch', 'Received', 'Closed'];
  const live = d.lines.filter((l) => l.status !== 'Cancelled' && l.ack_status !== 'Cancelled');
  const acked = live.length > 0 && live.every((l) => !PENDING.includes(l.ack_status));
  const anyReceived = live.some((l) => l.received_qty > 0);
  const allReceived = live.length > 0 && live.every((l) => l.status === 'Received' || l.status === 'Closed' || l.ack_status === 'Rejected');
  let cur = 1;
  if (d.viewed_at || acked) cur = 2;
  if (acked) cur = 3;
  if (d.in_dispatch || anyReceived) cur = 4;
  if (allReceived) cur = 5;
  if (d.status === 'Closed') cur = 6;
  const rejected = live.filter((l) => l.ack_status === 'Rejected').length;
  const partial = live.filter((l) => l.ack_status === 'Partially accepted').length;
  const deemed = live.some((l) => l.ack_status === 'Deemed accepted');
  const subs: Record<number, string> = {
    0: `v${d.version} · ${fmtDate(d.published_at)}`,
    1: d.viewed_at ? fmtDate(d.viewed_at) : 'Not yet opened',
    2: deemed ? 'Deemed accepted' : rejected ? `${rejected} rejected` : partial ? `${partial} partial` : acked ? 'All lines' : `${live.filter((l) => PENDING.includes(l.ack_status)).length} pending`,
    4: anyReceived && !allReceived ? 'Partially received' : '',
  };
  const steps = chainFrom(labels, cur, { subs, blockedAt: d.status === 'Cancelled' ? Math.min(cur, 5) : rejected && cur === 2 ? 2 : undefined });
  if (d.status === 'Cancelled') steps[Math.min(cur, 5)].sub = 'Cancelled';
  return steps;
}

/** Amendment workflow (WF-13): Requested → Approved → Changed in SAP → Republished → Re-acknowledged. */
export function amendmentChain(a: Amendment): ChainStep[] {
  const labels = ['Requested', 'Approved', 'Changed in SAP', 'Republished', 'Re-acknowledged'];
  const idx = labels.indexOf(a.status);
  if (a.status === 'Rejected' || a.status === 'Withdrawn') return chainFrom(labels, 1, { blockedAt: 1, subs: { 1: a.status } });
  return chainFrom(labels, a.status === 'Re-acknowledged' ? 5 : Math.max(0, idx), { subs: { 0: fmtDate(a.created_at), 2: a.sap_changed_at ? fmtDate(a.sap_changed_at) : undefined, 4: a.reack_at ? fmtDate(a.reack_at) : undefined } });
}

export function AckStatus({ l }: { l: Pick<PoLineDetail, 'ack_status' | 'accepted_qty' | 'qty' | 'uom'> }) {
  return (
    <span className="stack-sm" style={{ gap: 2 }}>
      <Status value={l.ack_status} />
      {l.ack_status === 'Partially accepted' && <span className="small muted">{l.accepted_qty} of {l.qty} {l.uom}</span>}
    </span>
  );
}

/** INT-M08: real status of the SAP write, or the DEC-25 statement that the platform is the record. */
export function SapAckCell({ ack, mode }: { ack: SapAck | null; mode: boolean }) {
  if (!ack) return mode ? <span className="small subtle">Not written yet</span> : <span className="small muted">Platform record <DecisionTag id="DEC-25" /></span>;
  return (
    <span className="stack-sm" style={{ gap: 2 }} title={ack.error ?? ack.key}>
      <Status value={ack.status} />
      <span className="small subtle mono">{ack.key}</span>
      {ack.error && <span className="small" style={{ color: 'var(--bad)' }}>{ack.error}</span>}
    </span>
  );
}

export function AckRecordNote({ mode }: { mode: boolean }) {
  return mode ? (
    <Callout tone="info" title="Acknowledgements are written to SAP (INT-M08)">Each acknowledgement and commitment change is sent to SAP with an idempotency key; the status shown per line is the real outcome (Written, Queued or Failed). <DecisionTag id="DEC-25" /></Callout>
  ) : (
    <p className="small muted">Platform is the record of acknowledgement (DEC-25). Acknowledgements are not written to SAP until Equipcare decides the SAP record. <DecisionTag id="DEC-25" /></p>
  );
}

export function CommitCell({ l }: { l: Pick<PoLineDetail, 'commit_date' | 'first_commit_date' | 'delivery_date' | 'overdue' | 'overdue_days'> }) {
  return (
    <span className="stack-sm" style={{ gap: 2 }}>
      <span style={{ fontWeight: 600, color: l.overdue ? 'var(--bad)' : undefined }}>{l.commit_date ? fmtDate(l.commit_date) : <span className="muted">PO date {fmtDate(l.delivery_date)}</span>}</span>
      {l.first_commit_date && l.commit_date && l.first_commit_date !== l.commit_date && <span className="small subtle">First: {fmtDate(l.first_commit_date)}</span>}
      {l.overdue && <span className="small" style={{ color: 'var(--bad)', fontWeight: 600 }}>Overdue {l.overdue_days} d</span>}
    </span>
  );
}

const KIND_TONE: Record<string, string> = { Reminder: 'warn', Escalation: 'bad', 'Vendor update': 'ok', System: 'decision' };

export function FollowupTimeline({ items, empty = 'No follow-up yet.' }: { items: Followup[]; empty?: string }) {
  if (!items.length) return <p className="muted small">{empty}</p>;
  return (
    <ol className="timeline">
      {items.map((f) => (
        <li key={f.id}>
          <span className="timeline__dot" data-tone={KIND_TONE[f.kind]} aria-hidden />
          <div className="timeline__title row-wrap">
            <span>{f.kind}{f.meta?.level ? ` · level ${f.meta.level}` : ''}</span>
            {f.item != null && <span className="chip">Line {f.item}</span>}
            {f.meta?.manual === false && f.kind === 'Reminder' && <Badge tone="neutral">Automatic</Badge>}
          </div>
          <div className="timeline__meta">{f.user_name}{f.by_vendor ? ' (vendor)' : ''} · {fmtDateTime(f.created_at)}</div>
          {f.note && <div className="timeline__body">{f.note}</div>}
          {(f.commit_date || f.delay_reason || f.next_action_date) && (
            <div className="small row-wrap" style={{ marginTop: 4, gap: 12 }}>
              {f.commit_date && <span>Commitment <strong>{fmtDate(f.commit_date)}</strong></span>}
              {f.delay_reason && <span>Delay reason <strong>{f.delay_reason}</strong></span>}
              {f.next_action_date && <span>Next action <strong>{fmtDate(f.next_action_date)}</strong></span>}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

export function CommitmentHistory({ lines }: { lines: PoLineDetail[] }) {
  const withHistory = lines.filter((l) => l.commitment_history.length);
  if (!withHistory.length) return <p className="muted small">No commitments yet. They appear when the vendor acknowledges a line.</p>;
  return (
    <div className="stack">
      {withHistory.map((l) => (
        <div key={l.id}>
          <div className="row-wrap" style={{ marginBottom: 6 }}><strong>Line {l.item}</strong><span className="small muted">{l.description}</span></div>
          <ol className="timeline">
            {l.commitment_history.map((h, i) => (
              <li key={i}>
                <span className="timeline__dot" data-tone={i === l.commitment_history.length - 1 ? 'ok' : undefined} aria-hidden />
                <div className="timeline__title">{h.old ? <><s className="subtle">{fmtDate(h.old)}</s> → </> : null}{fmtDate(h.commit_date)}{i === 0 ? ' · first commitment' : i === l.commitment_history.length - 1 ? ' · latest' : ''}</div>
                <div className="timeline__meta">{h.by} · {h.kind} · {fmtDateTime(h.at)}</div>
                {h.delay_reason && <div className="timeline__body">Delay reason: {h.delay_reason}</div>}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

/** Commitment change after acknowledgement — needs a delay-reason code (FR-POM-06). */
export function CommitDialog({ line, url, reasons, onClose, invalidate }: { line: PoLineDetail | null; url: (l: PoLineDetail) => string; reasons: string[]; onClose: () => void; invalidate: unknown[][] }) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { setDate(''); setReason(''); setNote(''); }, [line?.id]);
  const act = useAction(() => api.post(url(line!), { commit_date: date, delay_reason: reason, note: note || null }), { success: `Commitment for line ${line?.item} updated`, invalidate, onSuccess: onClose, silentError: true });
  return (
    <Modal open={!!line} onClose={onClose} title={`Update commitment · line ${line?.item ?? ''}`} sub={line ? `${line.description}. Current commitment ${fmtDate(line.commit_date ?? line.delivery_date)}.` : undefined}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={act.busy} disabled={!date || !reason} onClick={act.fire}>Update commitment</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="New commitment date" required error={fieldError(act.error, 'commit_date')}><Input type="date" min={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Delay reason" required hint="A change after acknowledgement needs a reason code. The first and latest commitments are both kept." error={fieldError(act.error, 'delay_reason')}>
          <Select value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Choose a reason" options={reasons} />
        </Field>
        <Field label="Note" required={reason === 'Other'} error={fieldError(act.error, 'note')}><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

const KINDS = ['Call', 'E-mail', 'Meeting / visit', 'Vendor update', 'Note'];

/** Buyer follow-up log entry: kind, note, commitment, delay reason, next action date (FR-POM-06). */
export function FollowupDialog({ po, open, onClose, invalidate, lineId }: { po: { id: number; po_no: string; lines: Pick<PoLineDetail, 'id' | 'item' | 'description' | 'ack_status' | 'active'>[]; reasons: string[] } | null; open: boolean; onClose: () => void; invalidate: unknown[][]; lineId?: number | null }) {
  const [line, setLine] = useState('');
  const [kind, setKind] = useState('Call');
  const [note, setNote] = useState('');
  const [commit, setCommit] = useState('');
  const [reason, setReason] = useState('');
  const [next, setNext] = useState('');
  useEffect(() => { if (open) { setLine(lineId ? String(lineId) : ''); setKind('Call'); setNote(''); setCommit(''); setReason(''); setNext(''); } }, [open, lineId]);
  const act = useAction(() => api.post(`/po/pos/${po!.id}/followups`, { po_line_id: line ? Number(line) : null, kind, note, commit_date: commit || null, delay_reason: reason || null, next_action_date: next || null }), {
    success: `Follow-up logged on PO ${po?.po_no}`, invalidate, onSuccess: onClose, silentError: true,
  });
  const sel = po?.lines.find((l) => String(l.id) === line);
  const canCommit = !!sel && ACKED.includes(sel.ack_status);
  return (
    <Modal open={open && !!po} onClose={onClose} title={`Log follow-up · PO ${po?.po_no ?? ''}`} sub="Record a call, e-mail or visit with the vendor. Internal — not shown to the vendor."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={act.busy} disabled={note.trim().length < 5 || (!!commit && !reason)} onClick={act.fire}>Log follow-up</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <div className="form-grid">
          <Field label="Line"><Select value={line} onChange={(e) => { setLine(e.target.value); setCommit(''); }} options={[{ value: '', label: 'Whole PO (all open lines)' }, ...(po?.lines ?? []).map((l) => ({ value: l.id, label: `Line ${l.item} · ${l.description.slice(0, 40)}` }))]} /></Field>
          <Field label="Kind" required><Select value={kind} onChange={(e) => setKind(e.target.value)} options={KINDS} /></Field>
          <Field label="Note" required className="span-2" error={fieldError(act.error, 'note')}><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="What the vendor said, what was agreed" /></Field>
          <Field label="New commitment date" hint={sel ? (canCommit ? 'Optional. Changes the line commitment; needs a delay reason.' : `Line is ${sel.ack_status.toLowerCase()} — no commitment to change.`) : 'Choose a line to record a new commitment.'} error={fieldError(act.error, 'commit_date')}>
            <Input type="date" min={todayISO()} value={commit} disabled={!canCommit} onChange={(e) => setCommit(e.target.value)} />
          </Field>
          <Field label="Delay reason" required={!!commit} error={fieldError(act.error, 'delay_reason')}><Select value={reason} onChange={(e) => setReason(e.target.value)} placeholder="None" options={po?.reasons ?? []} /></Field>
          <Field label="Next action date" error={fieldError(act.error, 'next_action_date')}><Input type="date" min={todayISO()} value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}
