import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtMoney } from '@/lib/format';
import { Badge, Button, Callout, Card, DecisionTag, KV, Loader, PageHeader, SimBadge } from '@/components/ui';
import { Field, Input, Select, ErrorSummary, fieldError } from '@/components/forms';
import { FileDrop, type Uploaded } from '@/components/Attachments';
import { OCR_NOTE } from './shared';

interface PoOpt { id: number; po_no: string; vendor_name: string; plant: string; po_date: string; status: string; total_value: number | null }
interface Ctx {
  po: { id: number; po_no: string; po_date: string; plant: string; payment_terms: string | null; delivery_terms: string | null; freight_terms: string | null; total_value: number | null };
  vendor: { name: string; sap_code: string | null; gstin: string | null }; plant: { code: string; name?: string; gstin?: string | null } | null;
  lines: { id: number; item: number; material_code: string | null; description: string; qty: number; uom: string; unit_price: number; gst_rate: number; hsn: string | null; received_qty?: number; billable?: number }[];
  asns: { id: number; asn_no: string; status: string; dispatch_date: string | null; eway_bill: string | null }[];
  invoices: { id: number; inv_ref: string; vendor_invoice_no: string | null; status: string }[]; on_behalf_enabled: boolean;
}
interface LineState { po_item: number; material_code: string | null; description: string; uom: string; include: boolean; qty: string; rate: string; hsn: string; gst_rate: string }
const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(/,/g, '')));
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Invoice upload — SCR-VPT-07 (vendor, camera or file) and finance upload on the vendor's behalf (FR-INV-10).
 * The uploader types the invoice values next to the file; the simulated OCR engine "reads" those values.
 */
export default function InvoiceUploadPage({ vendor }: { vendor?: boolean }) {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [poId, setPoId] = useState(sp.get('po') ?? '');
  const base = vendor ? '/vendor/invoices' : '/invoices';
  const pos = useQuery<PoOpt[]>({ queryKey: ['invoices', 'po-options'], queryFn: () => api.get('/invoices/po-options') });
  const ctx = useQuery<Ctx>({ queryKey: ['invoices', 'po-context', poId], queryFn: () => api.get(`/invoices/po-context/${poId}`), enabled: !!poId });
  const [files, setFiles] = useState<Uploaded[]>([]);
  const [asn, setAsn] = useState('');
  const [h, setH] = useState<Record<string, string>>({ invoice_no: '', invoice_date: '', vendor_gstin: '', buyer_gstin: '', po_no: '', payment_terms: '', eway_bill: '', bank_account: '', bank_ifsc: '', freight: '', other_charges: '' });
  const [totals, setTotals] = useState<{ taxable_value?: string; gst_amount?: string; total_value?: string }>({});
  const [lines, setLines] = useState<LineState[]>([]);
  const [clientErr, setClientErr] = useState<Record<string, string>>({});
  const setHv = (k: string, v: string) => setH((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (!ctx.data) return;
    setH((x) => ({ ...x, po_no: ctx.data!.po.po_no }));
    setLines(ctx.data.lines.map((l) => ({ po_item: l.item, material_code: l.material_code, description: l.description, uom: l.uom, include: true, qty: String(vendor ? l.qty : Math.max(l.billable ?? l.qty, 0) || l.qty), rate: String(l.unit_price), hsn: l.hsn ?? '', gst_rate: String(l.gst_rate) })));
    setAsn('');
    setTotals({});
  }, [ctx.data?.po.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const calc = useMemo(() => {
    const used = lines.filter((l) => l.include);
    const taxable = r2(used.reduce((s, l) => s + (num(l.qty) ?? 0) * (num(l.rate) ?? 0), 0));
    const gst = r2(used.reduce((s, l) => s + ((num(l.qty) ?? 0) * (num(l.rate) ?? 0) * (num(l.gst_rate) ?? 0)) / 100, 0));
    const total = r2(taxable + gst + (num(h.freight) ?? 0) + (num(h.other_charges) ?? 0));
    return { taxable, gst, total };
  }, [lines, h.freight, h.other_charges]);

  const submit = useAction(async () => {
    const e: Record<string, string> = {};
    if (!poId) e.po = 'Choose the purchase order this invoice is for.';
    if (!files.length) e.file = 'Upload the invoice as a PDF or a photo first.';
    if (!h.invoice_no.trim()) e.invoice_no = 'Enter the invoice number exactly as printed.';
    if (!h.invoice_date) e.invoice_date = 'Enter the invoice date.';
    const used = lines.filter((l) => l.include && (num(l.qty) ?? 0) > 0);
    if (!used.length) e.lines = 'Enter a quantity for at least one invoice line.';
    setClientErr(e);
    if (Object.keys(e).length) throw new ApiError(400, 'validation_failed', 'Fix the highlighted items and submit again.', e);
    const header: Record<string, string | number | null> = { ...h, taxable_value: num(totals.taxable_value ?? String(calc.taxable)), gst_amount: num(totals.gst_amount ?? String(calc.gst)), total_value: num(totals.total_value ?? String(calc.total)), freight: num(h.freight) ?? 0, other_charges: num(h.other_charges) ?? 0 };
    return api.post<{ id: number; inv_ref: string; status: string; sub_reason: string | null }>('/invoices', {
      po_id: Number(poId), attachment_id: files[files.length - 1].id, asn_id: asn ? Number(asn) : null, header,
      lines: used.map((l) => ({ po_item: l.po_item, material_code: l.material_code, description: l.description, hsn: l.hsn || null, qty: num(l.qty), rate: num(l.rate), taxable_value: r2((num(l.qty) ?? 0) * (num(l.rate) ?? 0)), gst_rate: num(l.gst_rate), gst_amount: r2(((num(l.qty) ?? 0) * (num(l.rate) ?? 0) * (num(l.gst_rate) ?? 0)) / 100) })),
    });
  }, {
    success: (r) => `Invoice ${r.inv_ref} uploaded — ${r.status.toLowerCase()}${r.sub_reason ? `: ${r.sub_reason}` : ''}`, invalidate: [['invoices'], ['payments'], ['nav-counts']],
    onSuccess: (r) => nav(`${base}/${r.id}`), silentError: true,
  });
  const err = submit.error;
  const fe = (k: string) => clientErr[k] ?? fieldError(err, k);
  const c = ctx.data;
  const blocked = !vendor && c && !c.on_behalf_enabled;

  return (
    <>
      <PageHeader
        title={vendor ? 'Upload an invoice' : 'Upload an invoice for a vendor'} screen={vendor ? 'SCR-VPT-07' : 'SCR-INV-01'}
        eyebrow={<><Link to={base}>Invoices</Link><span>/</span><span>Upload</span></>}
        sub={vendor ? 'Choose the purchase order, add the invoice file (PDF, or a photo from your phone), then confirm the invoice details.' : 'Finance upload on the vendor’s behalf. The invoice is marked as uploaded on behalf and the vendor is told.'}
        badges={<SimBadge title="No OCR engine is connected (DEC-01)">Simulated OCR</SimBadge>}
      />
      <div className="stack">
        <Callout tone="info" title="How reading works in this MVP">{OCR_NOTE}. Type the values exactly as they appear on the invoice; the engine reads them with a confidence score and the checks run on what it read. A phone photo reads with lower confidence than a PDF.</Callout>
        {!vendor && <Callout tone="decision" title="Uploaded on the vendor’s behalf"><span>This invoice will be marked “uploaded on behalf of the vendor” on every screen. Allowed by setting <span className="mono">inv.upload_on_behalf</span> <DecisionTag id="Q 7.10" />.</span></Callout>}
        {blocked && <Callout tone="bad" title="Upload on behalf is switched off">Business rules currently refuse finance uploads for vendors (decision Q 7.10). Ask the vendor to upload the invoice in the portal.</Callout>}
        <ErrorSummary error={err} />

        <Card title="1. Purchase order">
          <div className="stack">
            <Loader q={pos}>{(list) => (
              <Field label="Purchase order" required error={fe('po') ?? fieldError(err, 'po_id')} hint={vendor ? 'Only your own purchase orders are listed.' : 'Invoices are always uploaded against a PO.'}>
                <Select value={poId} onChange={(e) => setPoId(e.target.value)} placeholder="Choose a PO" options={list.map((p) => ({ value: p.id, label: `${p.po_no} — ${vendor ? '' : `${p.vendor_name} — `}${p.plant} — ${fmtMoney(p.total_value, true)} (${p.status})` }))} />
              </Field>
            )}</Loader>
            {poId && ctx.isLoading && <p className="muted small">Loading PO…</p>}
            {ctx.error && <Callout tone="bad">The PO could not be loaded. {(ctx.error as Error).message}</Callout>}
            {c && (
              <>
                <KV cols items={[['PO', <span className="mono">{c.po.po_no}</span>], ['Vendor', `${c.vendor.name}${c.vendor.sap_code ? ` (${c.vendor.sap_code})` : ''}`], ['PO date', fmtDate(c.po.po_date)], ['Plant', c.po.plant], ['Payment terms', c.po.payment_terms], ['Delivery / freight', `${c.po.delivery_terms ?? '—'} · ${c.po.freight_terms ?? '—'}`]]} />
                {c.invoices.length > 0 && <p className="small muted" style={{ margin: 0 }}>Already on this PO: {c.invoices.map((i) => `${i.vendor_invoice_no ?? i.inv_ref} (${i.status})`).join(', ')}.</p>}
              </>
            )}
          </div>
        </Card>

        {c && (
          <>
            <Card title="2. Invoice file">
              <div className="stack-sm">
                <FileDrop label="Invoice (PDF or photo)" accept="application/pdf,image/png,image/jpeg,image/webp" multiple={false} camera={vendor} vendorVisible onUploaded={setFiles} />
                {fe('file') && <div className="field__error" role="alert">{fe('file')}</div>}
                {fe('attachment_id') && <div className="field__error" role="alert">{fe('attachment_id')}</div>}
                {c.asns.length > 0 && (
                  <Field label="Against ASN" hint="Optional — links the invoice to a dispatch.">
                    <Select value={asn} onChange={(e) => setAsn(e.target.value)} placeholder="Not linked to an ASN" options={c.asns.map((a) => ({ value: a.id, label: `${a.asn_no} — ${a.status}${a.dispatch_date ? ` — dispatched ${fmtDate(a.dispatch_date)}` : ''}` }))} />
                  </Field>
                )}
              </div>
            </Card>

            <Card title={<div className="row-wrap"><h2>3. Invoice details</h2><SimBadge>Simulated OCR</SimBadge></div>} actions={<span className="small muted">Enter what the invoice shows</span>}>
              <div className="stack">
                <div className="form-grid">
                  <Field label="Invoice number" required error={fe('invoice_no')}><Input value={h.invoice_no} onChange={(e) => setHv('invoice_no', e.target.value)} maxLength={40} /></Field>
                  <Field label="Invoice date" required error={fe('invoice_date')}><Input type="date" value={h.invoice_date} onChange={(e) => setHv('invoice_date', e.target.value)} /></Field>
                  <Field label="Vendor GSTIN" hint={c.vendor.gstin ? `Registered: ${c.vendor.gstin}` : undefined}><Input className="mono" value={h.vendor_gstin} onChange={(e) => setHv('vendor_gstin', e.target.value.toUpperCase())} maxLength={15} autoCapitalize="characters" /></Field>
                  <Field label="Buyer GSTIN (Equipcare)" hint={c.plant?.gstin ? `Plant ${c.po.plant}: ${c.plant.gstin}` : undefined}><Input className="mono" value={h.buyer_gstin} onChange={(e) => setHv('buyer_gstin', e.target.value.toUpperCase())} maxLength={15} autoCapitalize="characters" /></Field>
                  <Field label="PO number on the invoice"><Input className="mono" value={h.po_no} onChange={(e) => setHv('po_no', e.target.value)} maxLength={20} /></Field>
                  <Field label="Payment terms"><Input value={h.payment_terms} onChange={(e) => setHv('payment_terms', e.target.value)} maxLength={80} placeholder={c.po.payment_terms ?? undefined} /></Field>
                  <Field label="E-way bill number"><Input className="mono" value={h.eway_bill} onChange={(e) => setHv('eway_bill', e.target.value)} maxLength={20} inputMode="numeric" /></Field>
                  <Field label="Bank account on the invoice"><Input className="mono" value={h.bank_account} onChange={(e) => setHv('bank_account', e.target.value)} maxLength={24} inputMode="numeric" /></Field>
                  <Field label="Bank IFSC"><Input className="mono" value={h.bank_ifsc} onChange={(e) => setHv('bank_ifsc', e.target.value.toUpperCase())} maxLength={11} autoCapitalize="characters" /></Field>
                </div>

                <h3 className="section-title">Lines</h3>
                {fe('lines') && <div className="field__error" role="alert">{fe('lines')}</div>}
                <div className="stack-sm">
                  {lines.map((l, i) => (
                    <div key={l.po_item} style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: 12, opacity: l.include ? 1 : 0.55 }} className="stack-sm">
                      <div className="row between">
                        <label className="check"><input type="checkbox" checked={l.include} onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, include: e.target.checked } : y)))} /><span><strong>PO item {l.po_item}</strong> · {l.description} {l.material_code ? <span className="mono subtle">({l.material_code})</span> : null}</span></label>
                        <Badge plain>{l.uom}</Badge>
                      </div>
                      {l.include && (
                        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
                          <Field label="Quantity"><Input inputMode="decimal" value={l.qty} onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, qty: e.target.value } : y)))} /></Field>
                          <Field label="Rate (₹)"><Input inputMode="decimal" value={l.rate} onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, rate: e.target.value } : y)))} /></Field>
                          <Field label="HSN / SAC"><Input className="mono" value={l.hsn} onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, hsn: e.target.value } : y)))} /></Field>
                          <Field label="GST %"><Input inputMode="decimal" value={l.gst_rate} onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, gst_rate: e.target.value } : y)))} /></Field>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <h3 className="section-title">Charges and totals</h3>
                <div className="form-grid">
                  <Field label="Freight (₹)" hint="Only if billed on the invoice."><Input inputMode="decimal" value={h.freight} onChange={(e) => setHv('freight', e.target.value)} /></Field>
                  <Field label="Other charges (₹)"><Input inputMode="decimal" value={h.other_charges} onChange={(e) => setHv('other_charges', e.target.value)} /></Field>
                  <Field label="Taxable value (₹)" hint="Calculated from the lines; change it if the invoice shows another figure."><Input inputMode="decimal" value={totals.taxable_value ?? String(calc.taxable)} onChange={(e) => setTotals((t) => ({ ...t, taxable_value: e.target.value }))} /></Field>
                  <Field label="GST amount (₹)"><Input inputMode="decimal" value={totals.gst_amount ?? String(calc.gst)} onChange={(e) => setTotals((t) => ({ ...t, gst_amount: e.target.value }))} /></Field>
                  <Field label="Invoice total (₹)" required><Input inputMode="decimal" value={totals.total_value ?? String(calc.total)} onChange={(e) => setTotals((t) => ({ ...t, total_value: e.target.value }))} /></Field>
                </div>
              </div>
            </Card>

            <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
              <Button onClick={() => nav(base)}>Cancel</Button>
              <Button variant="primary" size="lg" icon={<Send />} loading={submit.busy} disabled={!!blocked} onClick={submit.fire}>{vendor ? 'Submit invoice' : 'Upload on vendor’s behalf'}</Button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
