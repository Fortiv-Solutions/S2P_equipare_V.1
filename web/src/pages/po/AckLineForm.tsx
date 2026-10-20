/** Line-by-line acknowledgement (FR-POM-02): accept, partially accept (qty + reason) or reject (reason). */
import { useState } from 'react';
import { Check } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtMoney, todayISO } from '@/lib/format';
import { Button, Segmented, Status } from '@/components/ui';
import { Field, Input, Textarea } from '@/components/forms';
import type { PoLineDetail } from './types';

export interface AckPayload { line_id: number; decision: 'accept' | 'partial' | 'reject'; accepted_qty?: number | null; commit_date?: string | null; reason?: string | null; remarks?: string | null }

export function AckLineForm({ line, onSubmit, busy, submitLabel }: { line: PoLineDetail; onSubmit: (p: AckPayload) => Promise<unknown>; busy?: boolean; submitLabel?: string }) {
  const [decision, setDecision] = useState<'accept' | 'partial' | 'reject'>('accept');
  const [qty, setQty] = useState('');
  const [date, setDate] = useState(line.delivery_date >= todayISO() ? line.delivery_date : '');
  const [reason, setReason] = useState('');
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const f = (k: string) => error?.fields?.[`lines.0.${k}`] ?? null;
  const q = Number(qty);
  const valid = decision === 'reject' ? reason.trim().length >= 10 : !!date && (decision === 'accept' || (q > 0 && q < line.qty && reason.trim().length >= 10));
  const submit = async () => {
    setError(null);
    try {
      await onSubmit({ line_id: line.id, decision, accepted_qty: decision === 'partial' ? q : null, commit_date: decision === 'reject' ? null : date, reason: reason.trim() || null, remarks: remarks.trim() || null });
    } catch (e) {
      if (e instanceof ApiError) setError(e);
    }
  };
  return (
    <section className="card" aria-label={`Line ${line.item}`}>
      <div className="card__body stack" style={{ gap: 12 }}>
        <div className="row between" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div className="row-wrap"><strong>Line {line.item}</strong><span className="mono small subtle">{line.material_code}</span><Status value={line.ack_status} /></div>
            <div style={{ marginTop: 2 }}>{line.description}</div>
            <div className="small muted">{line.qty} {line.uom}{line.unit_price != null ? ` × ${fmtMoney(line.unit_price)}` : ''} · GST {line.gst_rate}% · PO delivery {fmtDate(line.delivery_date)}</div>
          </div>
        </div>
        {error && !Object.keys(error.fields ?? {}).length && <div className="error-summary" role="alert"><strong>{error.message}</strong></div>}
        <Segmented label={`Decision for line ${line.item}`} value={decision} onChange={setDecision} options={[{ id: 'accept', label: 'Accept' }, { id: 'partial', label: 'Partially accept' }, { id: 'reject', label: 'Reject' }]} />
        <div className="form-grid">
          {decision === 'partial' && (
            <Field label={`Accepted quantity (of ${line.qty} ${line.uom})`} required error={f('accepted_qty')} hint="Less than the ordered quantity.">
              <Input type="number" inputMode="decimal" min={0} max={line.qty} step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
          )}
          {decision !== 'reject' && (
            <Field label="Delivery commitment date" required error={f('commit_date')} hint="The date you commit to deliver this line.">
              <Input type="date" min={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          )}
          {decision !== 'accept' && (
            <Field label={decision === 'reject' ? 'Reason for rejection' : 'Reason for partial acceptance'} required className="span-2" error={f('reason')} hint="At least 10 characters. Equipcare's buyer is alerted immediately.">
              <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </Field>
          )}
          <Field label="Deviation remarks" className="span-2" error={f('remarks')} hint="Optional: make, packing, partial dispatch plan or other deviations.">
            <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={500} />
          </Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant={decision === 'reject' ? 'danger' : 'primary'} icon={<Check />} loading={busy} disabled={!valid} onClick={submit}>
            {submitLabel ?? (decision === 'accept' ? `Accept line ${line.item}` : decision === 'partial' ? `Partially accept line ${line.item}` : `Reject line ${line.item}`)}
          </Button>
        </div>
      </div>
    </section>
  );
}
