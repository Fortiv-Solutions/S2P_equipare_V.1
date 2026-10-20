import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Save, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtNum } from '@/lib/format';
import { Button, Callout, Card, DecisionTag, Empty, KV, LoadingBlock, ErrorState, PageHeader, SectionTitle, Status } from '@/components/ui';
import { Field, Input, Select, Textarea, Checkbox, ErrorSummary, fieldError } from '@/components/forms';
import { FileDrop, AttachmentList, type Uploaded } from '@/components/Attachments';
import { TermBadge, todayIso, addDaysIso } from './shared';
import type { AsnDetail, Prefill } from './types';

const DOCS = ['E-way bill', 'Invoice / challan', 'Packing list', 'LR copy'];

/** SCR-VPT-06 — vendor ASN create / revise with dispatch documents (FR-ASN-01..04, FR-VPT-05). */
export default function AsnFormPage() {
  const params = useParams();
  const editId = params.id ? Number(params.id) : null;
  const [sp] = useSearchParams();
  const existing = useQuery<AsnDetail>({ queryKey: ['asn', 'detail', editId], queryFn: () => api.get(`/asn/asns/${editId}`), enabled: !!editId });
  const poId = editId ? existing.data?.po_id : Number(sp.get('po'));
  const pre = useQuery<Prefill>({ queryKey: ['asn', 'prefill', poId, editId], queryFn: () => api.get('/asn/prefill', { po: poId, exclude: editId ?? undefined }), enabled: !!poId });
  if (!poId && !editId) return <Empty title="Choose a purchase order first" action={<Link className="btn btn--primary" to="/vendor/asns">Back to dispatch</Link>}>Open Create ASN from your dispatch list and pick the PO.</Empty>;
  if (pre.isLoading || existing.isLoading) return <LoadingBlock rows={10} />;
  if (pre.error || existing.error) return <ErrorState error={pre.error ?? existing.error} retry={() => { pre.refetch(); existing.refetch(); }} />;
  if (!pre.data) return null;
  return <AsnForm p={pre.data} existing={existing.data ?? null} />;
}

function AsnForm({ p, existing }: { p: Prefill; existing: AsnDetail | null }) {
  const navigate = useNavigate();
  const isEqDefault = p.defaults.delivery_terms === 'Ex-Works';
  const [f, setF] = useState(() => ({
    dispatch_date: existing?.dispatch_date ?? todayIso(),
    expected_date: existing?.expected_date ?? addDaysIso(3),
    transporter: existing?.transporter ?? '', lr_no: existing?.lr_no ?? '', vehicle_no: existing?.vehicle_no ?? '', eway_bill: existing?.eway_bill ?? '',
    invoice_ref: existing?.invoice_ref ?? '', packing_details: existing?.packing_details ?? '',
    pickup_by: (existing?.pickup_by ?? p.defaults.pickup_by) as 'Vendor' | 'Equipcare',
  }));
  const [qty, setQty] = useState<Record<number, string>>(() => {
    const out: Record<number, string> = {};
    if (existing) for (const l of existing.lines) out[l.po_line_id] = String(l.qty);
    else for (const l of p.lines) if (l.eligible) out[l.po_line_id] = String(l.open);
    return out;
  });
  const [docs, setDocs] = useState<Record<string, Uploaded[]>>({});
  const [reason, setReason] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const isDraft = !existing || existing.status === 'Draft';
  const equipcare = isEqDefault && f.pickup_by === 'Equipcare';
  const lrRequired = p.lr_mandatory && !equipcare;

  const lines = Object.entries(qty).filter(([, v]) => v !== '').map(([id, v]) => ({ po_line_id: Number(id), qty: Number(v) }));
  const body = (submit: boolean) => ({
    po_id: p.po.id, ...f, pickup_by: isEqDefault ? f.pickup_by : 'Vendor', lines,
    attachment_ids: Object.values(docs).flat().map((d) => d.id), submit, reason: reason || undefined,
  });
  const save = useAction((submit: boolean) => (existing ? api.put<{ id: number; asn_no: string; status: string; version: number }>(`/asn/asns/${existing.id}`, body(submit)) : api.post<{ id: number; asn_no: string; status: string }>('/asn/asns', body(submit))), {
    success: (r: any) => existing && !isDraft ? `ASN ${r.asn_no} revised (version ${r.version})` : r.status === 'Draft' ? `ASN ${r.asn_no} saved as draft` : `ASN ${r.asn_no} submitted to Equipcare`,
    invalidate: [['asn']], onSuccess: (r: any) => navigate(`/vendor/asns/${r.id}`), silentError: true,
  });
  const submitDraft = useAction(async () => {
    const r = await api.put<{ id: number }>(`/asn/asns/${existing!.id}`, body(false));
    return api.post<{ id: number; asn_no: string }>(`/asn/asns/${r.id}/submit`);
  }, { success: (r) => `ASN ${r.asn_no} submitted to Equipcare`, invalidate: [['asn']], onSuccess: (r) => navigate(`/vendor/asns/${r.id}`), silentError: true });
  const err = save.error ?? submitDraft.error;
  const total = useMemo(() => lines.reduce((s, l) => s + (l.qty || 0), 0), [lines]);

  useEffect(() => { if (err) window.scrollTo({ top: 0, behavior: 'smooth' }); }, [err]);

  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/vendor/asns">Dispatch</Link><span>/</span>{existing ? <span className="mono">{existing.asn_no}</span> : <span>New ASN</span>}</>} screen="SCR-VPT-06"
        title={existing ? (isDraft ? `Edit draft ${existing.asn_no}` : `Revise ${existing.asn_no}`) : `Create ASN for PO ${p.po.po_no}`}
        badges={existing ? <Status value={existing.status} /> : undefined}
        sub={<>Delivering to {p.po.plant_name} ({p.po.plant}){p.po.buyer_name ? ` · buyer ${p.po.buyer_name}` : ''}. Quantities are limited to what you acknowledged and have not yet delivered.</>}
      />
      {p.blocked && !existing && <div style={{ marginBottom: 16 }}><Callout tone="bad" title="An ASN cannot be created for this PO">{p.blocked}</Callout></div>}
      {err ? <div style={{ marginBottom: 16 }}><ErrorSummary error={err} /></div> : null}
      {existing && !isDraft && <div style={{ marginBottom: 16 }}><Callout tone="info" title={`This creates version ${existing.version + 1}`}>Equipcare stores and the buyer are notified of the change. The previous version stays in the history.</Callout></div>}
      <div className="split">
        <div className="stack">
          <Card title="Lines to dispatch" actions={<span className="small muted">Tolerance {p.tolerance_pct}% <DecisionTag id="Q 7.8" /></span>}>
            <div className="stack-sm">
              {p.lines.map((l) => {
                const on = qty[l.po_line_id] !== undefined;
                const idx = lines.findIndex((x) => x.po_line_id === l.po_line_id);
                const fe = idx >= 0 ? fieldError(err, `lines.${idx}.qty`) : null;
                return (
                  <div key={l.po_line_id} style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: 12, opacity: l.eligible || on ? 1 : 0.65 }}>
                    <div className="row between" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
                      <div style={{ minWidth: 0, flex: '1 1 260px' }}>
                        <Checkbox label={<span><span className="mono">{l.item}</span> · <strong>{l.description}</strong></span>} checked={on} disabled={!l.eligible && !on}
                          onChange={(e) => { const n = { ...qty }; if (e.target.checked) n[l.po_line_id] = String(l.open); else delete n[l.po_line_id]; setQty(n); }} />
                        <div className="small muted" style={{ marginTop: 4, marginLeft: 24 }}>
                          Ordered {fmtNum(l.ordered)} · accepted {fmtNum(l.accepted)} · received {fmtNum(l.received)} · on other ASNs {fmtNum(l.in_transit)} · <strong>open {fmtNum(l.open)} {l.uom}</strong> · due {fmtDate(l.delivery_date)}
                        </div>
                        {!l.eligible && <div className="small" style={{ marginLeft: 24, color: 'var(--warn)', fontWeight: 600 }}>{l.reason}</div>}
                      </div>
                      {on && (
                        <Field label={`Dispatch qty (${l.uom})`} error={fe} className="" >
                          <Input type="number" inputMode="decimal" min={0} step="any" max={l.max} value={qty[l.po_line_id]} onChange={(e) => setQty({ ...qty, [l.po_line_id]: e.target.value })} style={{ width: 140 }} />
                        </Field>
                      )}
                    </div>
                  </div>
                );
              })}
              <div className="small muted">{lines.length} line(s), {fmtNum(total)} units in this consignment.</div>
            </div>
          </Card>

          <Card title={equipcare ? 'Ready for pickup' : 'Dispatch details'}>
            <div className="form-grid">
              {isEqDefault && (
                <Field label="Transport arranged by" required hint={<>Ex-Works default: Equipcare collects from your works <DecisionTag id="DEC-24" /></>} className="span-2">
                  <Select value={f.pickup_by} onChange={set('pickup_by')} options={[{ value: 'Equipcare', label: 'Equipcare arranges pickup' }, { value: 'Vendor', label: 'We arrange transport (to pay)' }]} />
                </Field>
              )}
              <Field label={equipcare ? 'Ready for pickup on' : 'Dispatch date'} required error={fieldError(err, 'dispatch_date')}><Input type="date" value={f.dispatch_date} onChange={set('dispatch_date')} /></Field>
              <Field label="Expected delivery" required error={fieldError(err, 'expected_date')}><Input type="date" value={f.expected_date} min={f.dispatch_date} onChange={set('expected_date')} /></Field>
              {!equipcare && <Field label="Transporter / courier" required={lrRequired} error={fieldError(err, 'transporter')}><Input value={f.transporter} onChange={set('transporter')} maxLength={120} /></Field>}
              {!equipcare && <Field label="LR / AWB number" required={lrRequired} error={fieldError(err, 'lr_no')} hint={lrRequired ? <>Mandatory for {p.defaults.delivery_terms} <DecisionTag id="Q 7.8" /></> : 'Add when the transporter issues it.'}><Input value={f.lr_no} onChange={set('lr_no')} maxLength={60} className="mono" /></Field>}
              {!equipcare && <Field label="Vehicle number"><Input value={f.vehicle_no} onChange={set('vehicle_no')} maxLength={30} placeholder="MH12AB1234" className="mono" /></Field>}
              <Field label="E-way bill number" error={fieldError(err, 'eway_bill')}><Input value={f.eway_bill} onChange={set('eway_bill')} maxLength={30} inputMode="numeric" className="mono" /></Field>
              <Field label="Invoice / challan reference"><Input value={f.invoice_ref} onChange={set('invoice_ref')} maxLength={60} /></Field>
              <Field label="Packing details" className="span-2" hint="Packages, crates, pallets, weights."><Textarea rows={2} value={f.packing_details} onChange={set('packing_details')} maxLength={1000} /></Field>
            </div>
          </Card>

          <Card title="Dispatch documents" actions={<span className="small muted">Photos from your phone camera work too</span>}>
            <div className="stack">
              {existing && <><SectionTitle>Already attached</SectionTitle><AttachmentList ownerType="asn" ownerId={existing.id} /></>}
              {DOCS.map((d) => (
                <div key={d}>
                  <FileDrop label={d} camera compact onUploaded={(files) => setDocs((x) => ({ ...x, [d]: files }))} />
                </div>
              ))}
            </div>
          </Card>

          {existing && !isDraft && (
            <Card title="Reason for the change">
              <Field label="Why did the dispatch details change?" required hint="At least 10 characters. Shown to Equipcare with the new version." error={fieldError(err, 'reason')}>
                <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              </Field>
            </Card>
          )}

          <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Link className="btn btn--ghost" to={existing ? `/vendor/asns/${existing.id}` : '/vendor/asns'}>Cancel</Link>
            {isDraft && <Button icon={<Save />} loading={save.busy} disabled={!lines.length} onClick={() => save.fire(false)}>Save draft</Button>}
            {existing && isDraft
              ? <Button variant="primary" icon={<Send />} loading={submitDraft.busy} disabled={!lines.length} onClick={submitDraft.fire}>Submit ASN</Button>
              : <Button variant="primary" icon={<Send />} loading={save.busy} disabled={!lines.length || (!!existing && reason.trim().length < 10) || (!!p.blocked && !existing)} onClick={() => save.fire(true)}>{existing ? 'Save new version' : 'Submit ASN'}</Button>}
          </div>
        </div>

        <div className="stack">
          <Card title="Terms from the PO">
            <KV items={[
              ['PO', <span className="mono">{p.po.po_no}</span>], ['PO date', fmtDate(p.po.po_date)], ['Delivery terms', <><TermBadge term={p.defaults.delivery_terms} /> <span className="small subtle">{p.po.delivery_terms_text}</span></>],
              ['Freight', p.defaults.freight_mode], ['Transit risk', p.defaults.transit_risk === 'Vendor' ? 'Vendor (until delivery)' : 'Equipcare (from pickup)'],
              ['Pickup', equipcare ? 'Equipcare arranges' : 'Vendor arranges'], ['Ship to', p.po.ship_to ?? p.po.plant_name], ['Payment terms', p.po.payment_terms],
            ]} />
            <p className="small muted" style={{ marginTop: 10 }}>Defaulted from the PO and the delivery-term matrix <DecisionTag id="DEC-24" />. Contact the buyer if these are wrong.</p>
          </Card>
          {equipcare && <Callout tone="info" title="Equipcare pickup">The buyer schedules the vehicle and records the LR at pickup. You will be notified of the pickup date.</Callout>}
        </div>
      </div>
    </>
  );
}
