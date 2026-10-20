import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CheckCircle2, Download, Save, Send, XCircle, Lock } from 'lucide-react';
import { api, ApiError, downloadUrl } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtNum } from '@/lib/format';
import { Badge, Button, Callout, Card, KV, Loader, PageHeader, Progress, Segmented, Status } from '@/components/ui';
import { Checkbox, ErrorSummary, Field, Input, Select, Textarea } from '@/components/forms';
import { Modal, ReasonDialog } from '@/components/overlay';
import { AttachmentList } from '@/components/Attachments';
import { Countdown, KindBadge, money, type Change, type QHeader, type QLine, type Version } from './shared';

interface VLine {
  id: number; line_no: number; material_code: string | null; hsn: string | null; brand: string | null; description: string; qty: number; uom: string; required_date: string | null; due_at: string | null;
  plant: string | null; ship_to: string | null; gst_rate: number | null; valuation_type: string | null; transport_req: string | null; specs: string | null; flagged: boolean;
  files: { id: number; label: string | null; filename: string; size: number }[];
}
interface View {
  id: number; rfq_no: string; title: string; kind: string; status: string; closing_at: string; published_at: string | null; delivery_terms: string | null; payment_terms: string | null; warranty: string | null;
  packing: string | null; documents_required: string | null; standard_terms: string | null; ship_to: string | null; extensions: { from: string; to: string; at: string }[]; buyer: { name: string; email: string } | null;
  invitation: { status: string; sent_at: string; viewed_at: string | null; responded_at: string | null; declined_at: string | null; decline_reason: string | null };
  edit: { editable: boolean; mode: 'open' | 'reopen' | null; until: string | null; reason: string | null }; lines: VLine[]; files: { id: number; label: string | null; filename: string; size: number }[];
  quotation: { id: number; status: string; version: number; ref_no: string | null; submitted_at: string | null; updated_at: string | null; header: QHeader; lines: QLine[] } | null;
  documents: { id: number; label: string | null; filename: string }[]; versions: Version[]; gst_rates: number[];
}
interface Ack { ref_no: string; submitted_at: string; version: number; rfq_no: string; lines_quoted: number; editable_until: string | null }

interface LF { no_quote: boolean; quoted_qty: string; basic_price: string; discount_pct: string; gst_rate: string; freight: string; packing: string; delivery_days: string; make_brand: string; warranty: string; alternate: boolean; remarks: string }
interface HF { payment_terms: string; credit_days: string; delivery_terms: string; validity_date: string; remarks: string }

const s = (v: unknown) => (v == null ? '' : String(v));
const n = (v: string) => (v.trim() === '' ? null : Number(v));
const kb = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function initLine(l: VLine, q?: QLine): LF {
  return {
    no_quote: q?.no_quote ?? false, quoted_qty: s(q?.quoted_qty ?? l.qty), basic_price: s(q?.basic_price), discount_pct: s(q?.discount_pct), gst_rate: s(q?.gst_rate ?? l.gst_rate),
    freight: s(q?.freight), packing: s(q?.packing), delivery_days: s(q?.delivery_days), make_brand: s(q?.make_brand), warranty: s(q?.warranty), alternate: q?.alternate ?? false, remarks: s(q?.remarks),
  };
}
const toPayload = (l: VLine, f: LF) => ({
  rfq_line_id: l.id, no_quote: f.no_quote, quoted_qty: n(f.quoted_qty), basic_price: n(f.basic_price), discount_pct: n(f.discount_pct), gst_rate: n(f.gst_rate), freight: n(f.freight), packing: n(f.packing),
  delivery_days: n(f.delivery_days), make_brand: f.make_brand || null, warranty: f.warranty || null, alternate: f.alternate, remarks: f.remarks || null,
});

function useNarrow() {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const h = () => setM(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return m;
}

/** SCR-VPT-04 — RFQ view and quote entry (line-by-line stepper on a phone). */
export default function VendorRfqPage() {
  const id = Number(useParams().id);
  const q = useQuery<View>({ queryKey: ['rfq', 'vendor', id], queryFn: () => api.get(`/rfq/vendor/rfqs/${id}`), refetchOnWindowFocus: false });
  return <Loader q={q} rows={9}>{(v) => <Entry key={v.id} v={v} />}</Loader>;
}

function Entry({ v }: { v: View }) {
  const qc = useQueryClient();
  const narrow = useNarrow();
  const [lf, setLf] = useState<Record<number, LF>>(() => Object.fromEntries(v.lines.map((l) => [l.id, initLine(l, v.quotation?.lines.find((x) => x.rfq_line_id === l.id))])));
  const [hf, setHf] = useState<HF>(() => ({
    payment_terms: s(v.quotation?.header.payment_terms ?? v.payment_terms), credit_days: s(v.quotation?.header.credit_days), delivery_terms: s(v.quotation?.header.delivery_terms ?? v.delivery_terms ?? 'FOR'),
    validity_date: s(v.quotation?.header.validity_date), remarks: s(v.quotation?.header.remarks),
  }));
  const [step, setStep] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [ack, setAck] = useState<Ack | null>(null);
  const [declining, setDeclining] = useState(false);
  const [tab, setTab] = useState<'rfq' | 'quote'>('quote');
  const edit = v.edit;
  const body = () => ({
    header: { payment_terms: hf.payment_terms || null, credit_days: n(hf.credit_days), delivery_terms: hf.delivery_terms || null, validity_date: hf.validity_date || null, remarks: hf.remarks || null },
    lines: v.lines.map((l) => toPayload(l, lf[l.id])),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['rfq'] });
  const save = useAction(() => api.put(`/rfq/vendor/rfqs/${v.id}/quotation`, body()), { success: 'Draft saved', onSuccess: () => { setDirty(false); refresh(); }, silentError: true });
  const submit = useAction(() => api.post<{ ack: Ack }>(`/rfq/vendor/rfqs/${v.id}/quotation/submit`, body()), { onSuccess: (r) => { setAck(r.ack); setDirty(false); refresh(); }, silentError: true });
  const decline = useAction((reason: string) => api.post(`/rfq/vendor/rfqs/${v.id}/decline`, { reason }), { success: 'You declined this RFQ', onSuccess: refresh });
  const err = submit.error ?? save.error;
  const fields = err instanceof ApiError ? err.fields ?? {} : {};
  const setL = (id: number, patch: Partial<LF>) => { setLf((x) => ({ ...x, [id]: { ...x[id], ...patch } })); setDirty(true); };
  const setH = (patch: Partial<HF>) => { setHf((x) => ({ ...x, ...patch })); setDirty(true); };
  const filled = v.lines.filter((l) => lf[l.id].no_quote || lf[l.id].basic_price.trim() !== '').length;
  const total = useMemo(() => v.lines.reduce((sum, l) => {
    const f = lf[l.id];
    if (f.no_quote || f.basic_price.trim() === '') return sum;
    const qty = Number(f.quoted_qty || l.qty);
    const taxable = Number(f.basic_price) * (1 - Number(f.discount_pct || 0) / 100) * qty + Number(f.freight || 0) + Number(f.packing || 0);
    return sum + taxable * (1 + Number(f.gst_rate || 0) / 100);
  }, 0), [lf, v.lines]);
  const declined = v.invitation.status === 'Declined';
  const lineErr = (l: VLine) => Object.entries(fields).filter(([k]) => k.startsWith(`lines.${l.line_no}.`)).length;
  const firstErrLine = v.lines.findIndex((l) => lineErr(l) > 0);

  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/vendor/rfqs">RFQs</Link><span>/</span><span className="mono">{v.rfq_no}</span></>} screen="SCR-VPT-04" title={v.title}
        badges={<><Status value={v.status} tone={v.status === 'Open' ? 'info' : v.status === 'Reopened for you' ? 'warn' : 'neutral'} /><KindBadge kind={v.kind} />{v.quotation && v.quotation.version > 0 && <Badge tone="ok">Submitted v{v.quotation.version}</Badge>}{declined && <Badge tone="bad">Declined</Badge>}</>}
        sub={<>Buyer {v.buyer?.name} · {edit.mode === 'reopen' ? <strong>Reopened — revise by {fmtDateTime(edit.until)}</strong> : v.status === 'Open' ? <Countdown at={v.closing_at} /> : <>closed {fmtDateTime(v.closing_at)}</>}</>}
        actions={<a className="btn btn--secondary" href={downloadUrl(`/rfq/vendor/rfqs/${v.id}/pdf`)}><Download size={16} /> RFQ PDF</a>}
      />
      {!edit.editable && <Callout tone="warn" title="This RFQ is closed for changes" icon={<Lock />}>{edit.reason}{v.quotation?.ref_no && <> Your last submission: <strong>{v.quotation.ref_no}</strong> (version {v.quotation.version}).</>}</Callout>}
      {edit.mode === 'reopen' && <Callout tone="warn" title="Equipcare reopened this RFQ for you">You can revise your quotation until {fmtDateTime(edit.until)}. The previous version is kept; every revision is numbered and shows what changed.</Callout>}
      {declined && edit.editable && <Callout tone="info" title="You declined this RFQ">Saving or submitting a quotation withdraws the decline. Reason given: {v.invitation.decline_reason}</Callout>}
      <div style={{ height: 8 }} />

      {narrow && <div style={{ marginBottom: 12 }}><Segmented label="Section" value={tab} onChange={setTab} options={[{ id: 'quote', label: 'Your quotation' }, { id: 'rfq', label: 'RFQ details' }]} /></div>}

      <div className="split">
        <div className="stack" style={{ order: narrow && tab === 'rfq' ? 2 : 0, display: narrow && tab === 'rfq' ? 'none' : undefined }}>
          {edit.editable ? (
            <>
              <ErrorSummary error={err} />
              <Card title={<div className="row-wrap"><h2>{narrow ? `Line ${step + 1} of ${v.lines.length}` : 'Quote line by line'}</h2><span className="small muted">{filled} of {v.lines.length} lines entered</span></div>}
                actions={<span className="small muted">Amounts in ₹, per unit unless stated</span>}>
                <div className="stack">
                  <Progress value={filled} max={v.lines.length} label="Lines entered" />
                  {narrow ? (
                    <>
                      <LineForm l={v.lines[step]} f={lf[v.lines[step].id]} gst={v.gst_rates} errors={fields} onChange={(p) => setL(v.lines[step].id, p)} />
                      <div className="row between">
                        <Button icon={<ArrowLeft />} disabled={step === 0} onClick={() => setStep(step - 1)}>Previous</Button>
                        <span className="small muted">{step + 1} / {v.lines.length}</span>
                        <Button variant="deep" disabled={step >= v.lines.length - 1} onClick={() => setStep(step + 1)}>Next <ArrowRight size={16} /></Button>
                      </div>
                      {firstErrLine >= 0 && firstErrLine !== step && <Button size="sm" variant="danger" onClick={() => setStep(firstErrLine)}>Go to line {v.lines[firstErrLine].line_no} with a problem</Button>}
                    </>
                  ) : v.lines.map((l) => <LineForm key={l.id} l={l} f={lf[l.id]} gst={v.gst_rates} errors={fields} onChange={(p) => setL(l.id, p)} />)}
                </div>
              </Card>
              <Card title="Commercial terms">
                <div className="form-grid">
                  <Field label="Delivery terms" required error={fields['header.delivery_terms']} hint={`RFQ asks for ${v.delivery_terms}`}>
                    <Segmented label="Delivery terms" value={(hf.delivery_terms || 'FOR') as 'FOR' | 'Ex-Works'} onChange={(x) => setH({ delivery_terms: x })} options={[{ id: 'FOR', label: 'FOR (delivered)' }, { id: 'Ex-Works', label: 'Ex-Works' }]} />
                  </Field>
                  <Field label="Quotation valid until" required error={fields['header.validity_date']} hint={`On or after the closing date (${fmtDate(v.closing_at)})`}><Input type="date" value={hf.validity_date} onChange={(e) => setH({ validity_date: e.target.value })} /></Field>
                  <Field label="Payment terms" required error={fields['header.payment_terms']}><Input value={hf.payment_terms} onChange={(e) => setH({ payment_terms: e.target.value })} /></Field>
                  <Field label="Credit days" error={fields['header.credit_days']}><Input type="number" min={0} inputMode="numeric" value={hf.credit_days} onChange={(e) => setH({ credit_days: e.target.value })} /></Field>
                  <Field label="Remarks to Equipcare" className="span-2"><Textarea rows={2} value={hf.remarks} onChange={(e) => setH({ remarks: e.target.value })} maxLength={2000} /></Field>
                </div>
              </Card>
              {v.quotation && (
                <Card title="Your documents" actions={<span className="small muted">Signed quotation, datasheet, price list, warranty terms</span>}>
                  <AttachmentList ownerType="quotation" ownerId={v.quotation.id} canUpload uploadLabel="Quotation document" />
                </Card>
              )}
              <Card>
                <div className="row-wrap between">
                  <div><div className="small muted">Indicative total including GST</div><div style={{ fontSize: 'var(--fs-20)', fontWeight: 600 }} className="num">{money(Math.round(total * 100) / 100)}</div></div>
                  <div className="row-wrap">
                    {!declined && v.quotation?.version === 0 && <Button variant="ghost" icon={<XCircle />} onClick={() => setDeclining(true)}>Decline RFQ</Button>}
                    <Button icon={<Save />} loading={save.busy} onClick={save.fire}>Save draft</Button>
                    <Button variant="primary" icon={<Send />} loading={submit.busy} onClick={submit.fire}>{v.quotation && v.quotation.version > 0 ? 'Submit revision' : 'Submit quotation'}</Button>
                  </div>
                </div>
                {dirty && <p className="small muted" style={{ marginTop: 8 }}>You have unsaved changes.</p>}
              </Card>
            </>
          ) : v.quotation && v.quotation.version > 0 ? (
            <Card title="Your submitted quotation" actions={<Badge tone="ok">{v.quotation.ref_no} · v{v.quotation.version}</Badge>} flush>
              <div className="tbl-wrap"><table className="tbl tbl--dense">
                <thead><tr><th>Line</th><th className="num">Qty</th><th className="num">Basic</th><th className="num">Disc %</th><th className="num">GST</th><th className="num">Freight</th><th className="num">Packing</th><th className="num">Days</th><th>Make</th></tr></thead>
                <tbody>{v.quotation.lines.map((ql) => { const l = v.lines.find((x) => x.id === ql.rfq_line_id); return (
                  <tr key={ql.rfq_line_id}><td className="mono">{l?.line_no}</td>{ql.no_quote ? <td colSpan={8} className="muted">Not quoted</td> : <><td className="num">{fmtNum(ql.quoted_qty)}</td><td className="num">{money(ql.basic_price)}</td><td className="num">{ql.discount_pct ?? 0}</td><td className="num">{ql.gst_rate}%</td><td className="num">{money(ql.freight)}</td><td className="num">{money(ql.packing)}</td><td className="num">{ql.delivery_days}</td><td>{ql.make_brand}{ql.alternate ? ' (alternate)' : ''}</td></>}</tr>); })}</tbody>
              </table></div>
            </Card>
          ) : (
            <Card><div className="small muted">{declined ? `You declined this RFQ: ${v.invitation.decline_reason}` : 'You did not submit a quotation for this RFQ.'}</div></Card>
          )}
          {v.versions.length > 0 && (
            <Card title="Submission history" actions={<span className="small muted">Every submit is a numbered version (QTN-06)</span>}>
              <ol className="timeline">{v.versions.map((x) => (
                <li key={x.version}><span className="timeline__dot" data-tone={x.version > 1 ? 'warn' : 'ok'} /><div className="timeline__title">Version {x.version} · {x.ref_no}</div><div className="timeline__meta">{fmtDateTime(x.created_at)} · {x.note}</div>
                  {x.changes.length > 0 && <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 16 }}>{(x.changes as Change[]).map((c, i) => <li key={i}>{c.line ? `Line ${c.line} ` : ''}{c.label}: <s className="subtle">{s(c.from) || '—'}</s> → {s(c.to) || '—'}</li>)}</ul>}</li>
              ))}</ol>
            </Card>
          )}
        </div>
        <div className="stack" style={{ display: narrow && tab === 'quote' ? 'none' : undefined }}>
          <Card title="RFQ terms"><KV items={[['Delivery terms', v.delivery_terms], ['Payment terms', v.payment_terms], ['Warranty', v.warranty], ['Packing', v.packing], ['Documents required', v.documents_required], ['Closing', fmtDateTime(v.closing_at)], ['Ship-to', v.ship_to], ['Buyer', v.buyer ? `${v.buyer.name} · ${v.buyer.email}` : '—']]} /></Card>
          <Card title="Standard terms"><p className="small" style={{ whiteSpace: 'pre-wrap' }}>{v.standard_terms}</p></Card>
          <Card title="Drawings and specifications">
            {v.files.length === 0 ? <p className="small muted">No RFQ-level attachments.</p> : <ul className="list-plain stack-sm small">{v.files.map((f) => <li key={f.id} className="row"><span className="grow">{f.label ? `${f.label} — ` : ''}{f.filename} <span className="subtle">{kb(f.size)}</span></span><a className="btn btn--ghost btn--sm" href={`/api/files/${f.id}/download`}><Download size={14} /> Download</a></li>)}</ul>}
            {v.lines.some((l) => l.files.length) && <><h3 style={{ margin: '12px 0 6px' }}>Line attachments</h3><ul className="list-plain stack-sm small">{v.lines.flatMap((l) => l.files.map((f) => <li key={f.id} className="row"><span className="grow">Line {l.line_no}: {f.filename} <span className="subtle">{kb(f.size)}</span></span><a className="btn btn--ghost btn--sm" href={`/api/files/${f.id}/download`}><Download size={14} /></a></li>))}</ul></>}
          </Card>
          {v.extensions.length > 0 && <Card title="Closing date changes"><ul className="list-plain small stack-sm">{v.extensions.map((e, i) => <li key={i}>Extended from {fmtDateTime(e.from)} to <strong>{fmtDateTime(e.to)}</strong></li>)}</ul></Card>}
        </div>
      </div>

      <Modal open={!!ack} onClose={() => setAck(null)} title="Quotation submitted" footer={<Button variant="deep" onClick={() => setAck(null)}>Done</Button>}>
        {ack && (
          <div className="stack">
            <Callout tone="ok" title={`Reference ${ack.ref_no}`} icon={<CheckCircle2 />}>Keep this reference for your records. You received this acknowledgement at the time shown.</Callout>
            <KV items={[['RFQ', ack.rfq_no], ['Reference', <span className="mono">{ack.ref_no}</span>], ['Version', ack.version], ['Submitted', fmtDateTime(ack.submitted_at)], ['Lines quoted', ack.lines_quoted], ['You can revise until', ack.editable_until ? fmtDateTime(ack.editable_until) : '—']]} />
          </div>
        )}
      </Modal>
      <ReasonDialog open={declining} onClose={() => setDeclining(false)} title="Decline this RFQ" variant="danger" confirmLabel="Decline RFQ" sub="Tell Equipcare why you are not quoting. You can still submit later while the RFQ is open." onSubmit={(r) => decline.run(r)} />
    </>
  );
}

function LineForm({ l, f, gst, errors, onChange }: { l: VLine; f: LF; gst: number[]; errors: Record<string, string>; onChange: (p: Partial<LF>) => void }) {
  const e = (k: string) => errors[`lines.${l.line_no}.${k}`];
  const qty = Number(f.quoted_qty || l.qty);
  const taxable = f.basic_price.trim() === '' ? null : Number(f.basic_price) * (1 - Number(f.discount_pct || 0) / 100) * qty + Number(f.freight || 0) + Number(f.packing || 0);
  const partial = !f.no_quote && Number(f.quoted_qty) > 0 && Number(f.quoted_qty) < l.qty;
  const num = (k: keyof LF, label: string, extra: { required?: boolean; hint?: string; step?: string } = {}) => (
    <Field label={label} required={extra.required} hint={extra.hint} error={e(k as string)}>
      <Input type="number" inputMode="decimal" min={0} step={extra.step ?? 'any'} value={f[k] as string} onChange={(ev) => onChange({ [k]: ev.target.value } as Partial<LF>)} disabled={f.no_quote} />
    </Field>
  );
  return (
    <div style={{ border: `1px solid ${Object.keys(errors).some((k) => k.startsWith(`lines.${l.line_no}.`)) ? 'var(--bad)' : 'var(--line)'}`, borderRadius: 'var(--r-md)', padding: 14 }} className="stack">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontWeight: 600 }}><span className="mono">{l.line_no}</span> · {l.description}</div>
          <div className="small muted">{l.material_code && <span className="mono">{l.material_code} · </span>}{fmtNum(l.qty)} {l.uom} · needed {fmtDate(l.required_date)} · deliver to {l.plant}{l.hsn ? ` · HSN ${l.hsn}` : ''}</div>
          {l.specs && <div className="small muted">{l.specs}</div>}
          {l.transport_req && <div className="small subtle">Transport: {l.transport_req}</div>}
          {l.flagged && <div className="small" style={{ color: 'var(--bad)' }}>Equipcare is reviewing this line — you may skip it.</div>}
        </div>
        <Checkbox label="Not quoting this line" checked={f.no_quote} onChange={(ev) => onChange({ no_quote: ev.target.checked })} />
      </div>
      {!f.no_quote && (
        <>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            {num('basic_price', 'Basic price', { required: true, hint: `₹ per ${l.uom}` })}
            {num('discount_pct', 'Discount %', { hint: '0 – 100' })}
            <Field label="GST rate" required error={e('gst_rate')} hint={l.gst_rate != null ? `Master: ${l.gst_rate}%` : undefined}>
              <Select value={f.gst_rate} onChange={(ev) => onChange({ gst_rate: ev.target.value })} placeholder="Choose" options={gst.map((g) => ({ value: String(g), label: `${g}%` }))} />
            </Field>
            {num('freight', 'Freight', { hint: 'Line total, ₹' })}
            {num('packing', 'Packing & forwarding', { hint: 'Line total, ₹' })}
            {num('delivery_days', 'Delivery (days)', { required: true, step: '1' })}
            {num('quoted_qty', `Quantity you can supply (${l.uom})`, { hint: partial ? `Partial — less than ${l.qty}` : `RFQ quantity ${l.qty}` })}
            <Field label="Make / brand" error={e('make_brand')} hint={l.brand ? `Specified: ${l.brand}` : undefined}><Input value={f.make_brand} onChange={(ev) => onChange({ make_brand: ev.target.value })} maxLength={200} /></Field>
            <Field label="Warranty"><Input value={f.warranty} onChange={(ev) => onChange({ warranty: ev.target.value })} maxLength={300} /></Field>
          </div>
          <div className="row-wrap">
            <Checkbox label="Alternate make / brand (not the one specified)" checked={f.alternate} onChange={(ev) => onChange({ alternate: ev.target.checked })} />
            {partial && <Badge tone="warn">Partial quantity {f.quoted_qty} / {l.qty}</Badge>}
          </div>
          <Field label="Remarks"><Input value={f.remarks} onChange={(ev) => onChange({ remarks: ev.target.value })} maxLength={1000} /></Field>
          <div className="small muted">Line value: <strong className="num">{taxable == null ? '—' : money(Math.round(taxable * (1 + Number(f.gst_rate || 0) / 100) * 100) / 100)}</strong> including GST {taxable != null && <span className="subtle">(taxable {money(Math.round(taxable * 100) / 100)})</span>}</div>
        </>
      )}
      {Object.entries(errors).filter(([k]) => k === `lines.${l.line_no}.due_at`).map(([k, m]) => <div key={k} className="field__error">{m}</div>)}
    </div>
  );
}
