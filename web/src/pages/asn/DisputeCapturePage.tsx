import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Camera, ClipboardX } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtMoney, fmtNum } from '@/lib/format';
import { Badge, Button, Callout, Card, DecisionTag, Empty, ErrorState, KV, LoadingBlock, PageHeader } from '@/components/ui';
import { Field, Input, Select, Textarea, ErrorSummary, fieldError } from '@/components/forms';
import { FileDrop, type Uploaded } from '@/components/Attachments';
import { TermBadge } from './shared';

interface Ctx {
  po: { id: number; po_no: string; plant: string; vendor_name: string; delivery_terms_text: string | null; buyer_name: string | null };
  asn: { id: number; asn_no: string; status: string; transporter: string | null; lr_no: string | null } | null;
  invoice: { id: number; inv_ref: string; vendor_invoice_no: string | null; status: string } | null;
  term: 'FOR' | 'Ex-Works'; selected_line: number | null; types: string[]; owner_by_type: Record<string, string>;
  photo_rule: { types: string[]; min_photos: number }; evidence_labels: string[];
  lines: { po_line_id: number; item: number; description: string; material_code: string | null; uom: string; ordered: number; accepted: number; received: number; shipped: number | null; suggested_shortage: number | null; unit_price: number; last_grn: { id: number; grn_no: string; qty: number; posting_date: string } | null; open_disputes: { dsp_no: string; type: string }[] }[];
}

/** SCR-ASN-04 — discrepancy capture, camera-first on the phone; type and quantity required, photo required for damage types (FR-DSP-01, FR-DSP-06, Q 7.8). */
export default function DisputeCapturePage() {
  const [sp] = useSearchParams();
  const params = { po_line: sp.get('po_line') ?? undefined, asn: sp.get('asn') ?? undefined, invoice: sp.get('invoice_id') ?? sp.get('invoice') ?? undefined, po: sp.get('po') ?? undefined };
  const q = useQuery<Ctx>({ queryKey: ['asn', 'dsp-context', params], queryFn: () => api.get('/asn/disputes/context', params) });
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  if (!q.data) return null;
  return <Form c={q.data} />;
}

function Form({ c }: { c: Ctx }) {
  const navigate = useNavigate();
  const [lineId, setLineId] = useState<string>(c.selected_line ? String(c.selected_line) : '');
  const [type, setType] = useState('');
  const [qty, setQty] = useState('');
  const [value, setValue] = useState('');
  const [valueEdited, setValueEdited] = useState(false);
  const [desc, setDesc] = useState('');
  const [files, setFiles] = useState<Uploaded[]>([]);
  const line = c.lines.find((l) => String(l.po_line_id) === lineId);
  const photos = files.filter((f) => f.mime.startsWith('image/')).length;
  const photoNeeded = c.photo_rule.types.includes(type);
  const owner = type ? c.owner_by_type[type] : null;
  const autoValue = line && Number(qty) > 0 ? Math.round(line.unit_price * Number(qty) * 100) / 100 : null;

  const pickLine = (id: string) => {
    setLineId(id);
    const l = c.lines.find((x) => String(x.po_line_id) === id);
    if (l?.suggested_shortage && !qty) { setQty(String(l.suggested_shortage)); if (!type) setType('Shortage'); }
  };

  const act = useAction(() => api.post<{ id: number; dsp_no: string; owner_party: string }>('/asn/disputes', {
    po_line_id: Number(lineId), asn_id: c.asn?.id ?? undefined, grn_id: line?.last_grn?.id, invoice_id: c.invoice?.id ?? undefined,
    type, qty: Number(qty), value: valueEdited && value !== '' ? Number(value) : undefined, description: desc.trim() || undefined, attachment_ids: files.map((f) => f.id),
  }), {
    success: (r) => `Dispute ${r.dsp_no} raised — owner ${r.owner_party}`, invalidate: [['asn']], onSuccess: (r) => navigate(`/disputes/${r.id}`), silentError: true,
  });
  const ready = !!lineId && !!type && Number(qty) > 0 && (!photoNeeded || photos >= c.photo_rule.min_photos);
  const missing = useMemo(() => [!lineId && 'PO line', !type && 'type', !(Number(qty) > 0) && 'quantity', photoNeeded && photos < c.photo_rule.min_photos && `${c.photo_rule.min_photos - photos} more photo${c.photo_rule.min_photos - photos > 1 ? 's' : ''}`].filter(Boolean), [lineId, type, qty, photoNeeded, photos, c.photo_rule.min_photos]);

  return (
    <>
      <PageHeader
        eyebrow={<><Link to={c.asn ? `/asns/${c.asn.id}` : '/receipts'}>{c.asn ? c.asn.asn_no : 'Expected receipts'}</Link><span>/</span><span>Record receipt issue</span></>} screen="SCR-ASN-04"
        title="Record receipt issue"
        sub={<>PO <span className="mono">{c.po.po_no}</span> · {c.po.vendor_name} · {c.po.plant}{c.invoice ? <> · from invoice exception <span className="mono">{c.invoice.inv_ref}</span></> : null}</>}
      />
      <ErrorSummary error={act.error} />
      <div className="split" style={{ marginTop: act.error ? 16 : 0 }}>
        <div className="stack">
          <Card title="1. Take photos">
            <div className="stack">
              <FileDrop camera label="Photos of the material, packing and labels" accept="image/*,application/pdf,.docx,.xlsx" onUploaded={setFiles} compact />
              {photoNeeded && (
                <Callout tone={photos >= c.photo_rule.min_photos ? 'ok' : 'warn'} title={photos >= c.photo_rule.min_photos ? `${photos} photo${photos > 1 ? 's' : ''} attached` : `${type} needs at least ${c.photo_rule.min_photos} photo${c.photo_rule.min_photos > 1 ? 's' : ''}`}>
                  Photo rule <DecisionTag id="Q 7.8" />: required for {c.photo_rule.types.join(' and ')}. Other documents (GRN note, rejection note, shortage report) can be added later on the dispute.
                </Callout>
              )}
              {fieldError(act.error, 'attachment_ids') && <div className="field__error">{fieldError(act.error, 'attachment_ids')}</div>}
            </div>
          </Card>
          <Card title="2. What is wrong?">
            <div className="form-grid">
              <Field label="PO line" required error={fieldError(act.error, 'po_line_id')} className="span-2">
                <Select value={lineId} onChange={(e) => pickLine(e.target.value)} placeholder="Choose the line" options={c.lines.map((l) => ({ value: l.po_line_id, label: `${l.item} · ${l.description}${l.shipped != null ? ` (ASN ${fmtNum(l.shipped)} ${l.uom})` : ''}` }))} />
              </Field>
              <Field label="Discrepancy type" required error={fieldError(act.error, 'type')}>
                <Select value={type} onChange={(e) => setType(e.target.value)} placeholder="Choose the type" options={c.types} />
              </Field>
              <Field label={`Affected quantity${line ? ` (${line.uom})` : ''}`} required error={fieldError(act.error, 'qty')} hint={line?.suggested_shortage ? `ASN ${fmtNum(line.shipped)} minus GRN ${fmtNum(line.shipped! - line.suggested_shortage)} = ${fmtNum(line.suggested_shortage)} short` : undefined}>
                <Input type="number" inputMode="decimal" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
              </Field>
              <Field label="Disputed value (INR)" hint={autoValue != null ? `Defaults to PO price × qty = ${fmtMoney(autoValue)}` : 'Defaults to PO price × quantity'} error={fieldError(act.error, 'value')}>
                <Input type="number" inputMode="decimal" min={0} step="any" value={valueEdited ? value : autoValue ?? ''} onChange={(e) => { setValue(e.target.value); setValueEdited(true); }} />
              </Field>
              <Field label="What did you see?" className="span-2" hint="Condition, packaging, count, labels — whatever helps the vendor or transporter respond.">
                <Textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} />
              </Field>
            </div>
          </Card>
          <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {!ready && <span className="small muted">Still needed: {missing.join(', ')}</span>}
            <Link className="btn btn--ghost" to={c.asn ? `/asns/${c.asn.id}` : '/receipts'}>Cancel</Link>
            <Button variant="primary" icon={<ClipboardX />} loading={act.busy} disabled={!ready} onClick={act.fire}>Raise dispute</Button>
          </div>
        </div>
        <div className="stack">
          <Card title="Who will own it">
            {owner ? (
              <div className="stack-sm">
                <div className="row" style={{ gap: 8 }}><Badge tone={owner === 'Vendor' ? 'warn' : 'info'}>{owner}</Badge><TermBadge term={c.term} /> <DecisionTag id="DEC-24" /></div>
                <p className="small muted">{c.term} {type.toLowerCase()}: default owner is <strong>{owner}</strong>{owner === 'Vendor' ? ` (${c.po.vendor_name}), who is asked to respond` : owner === 'Logistics' ? ' (the PO buyer arranges the transporter claim)' : owner === 'Stores' ? ' (plant stores)' : ''}. Procurement can reassign with a reason.</p>
              </div>
            ) : <p className="small muted">Choose the type to see the default owner for {c.term} deliveries.</p>}
          </Card>
          <Card title="Context">
            <KV items={[
              ['PO', <span className="mono">{c.po.po_no}</span>], ['Delivery terms', <TermBadge term={c.term} />], ['Buyer', c.po.buyer_name],
              ...(c.asn ? [['ASN', <span className="mono">{c.asn.asn_no}</span>], ['Transporter / LR', `${c.asn.transporter ?? '—'} · ${c.asn.lr_no ?? '—'}`]] as [string, React.ReactNode][] : []),
              ...(line ? [['Ordered / received', `${fmtNum(line.ordered)} / ${fmtNum(line.received)} ${line.uom}`], ['Last GRN', line.last_grn ? `${line.last_grn.grn_no} · ${fmtNum(line.last_grn.qty)}` : 'None yet'], ['Unit price', fmtMoney(line.unit_price)]] as [string, React.ReactNode][] : []),
            ]} />
            {line && line.open_disputes.length > 0 && <div style={{ marginTop: 10 }}><Callout tone="warn" title="Open disputes on this line">{line.open_disputes.map((d) => `${d.dsp_no} (${d.type})`).join(', ')}</Callout></div>}
          </Card>
          {!c.lines.length && <Empty title="No lines">This PO has no lines to dispute.</Empty>}
        </div>
      </div>
    </>
  );
}
