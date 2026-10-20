import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2, Save, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtMoney, todayISO } from '@/lib/format';
import { Button, Callout, Card, DecisionTag, Loader, PageHeader, SectionTitle } from '@/components/ui';
import { Field, Input, Select, Textarea, Checkbox, ErrorSummary, fieldError } from '@/components/forms';
import { FileDrop } from '@/components/Attachments';
import { TYPE_LABEL, type ContractDetail, type Options } from './types';

interface Line { material_id: string; unit_price: string; qty_cap: string; discount_pct: string; list_price: string; vmi_min: string; vmi_max: string }
const blank: Line = { material_id: '', unit_price: '', qty_cap: '', discount_pct: '', list_price: '', vmi_min: '', vmi_max: '' };
const n = (v: string) => (v.trim() === '' ? null : Number(v));
const addYear = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCFullYear(x.getUTCFullYear() + 1); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

export default function ContractFormPage() {
  const id = Number(useParams().id) || null;
  const opts = useQuery<Options>({ queryKey: ['contracts', 'options'], queryFn: () => api.get('/contracts/options') });
  const existing = useQuery<ContractDetail>({ queryKey: ['contracts', 'detail', id], queryFn: () => api.get(`/contracts/${id}`), enabled: !!id });
  if (id) return <Loader q={{ ...existing, isLoading: existing.isLoading || opts.isLoading, data: existing.data && opts.data ? existing.data : undefined }}>{(c) => <Form opts={opts.data!} existing={c} />}</Loader>;
  return <Loader q={opts}>{(o) => <Form opts={o} />}</Loader>;
}

function Form({ opts, existing }: { opts: Options; existing?: ContractDetail }) {
  const navigate = useNavigate();
  const t = todayISO();
  const [h, setH] = useState(() => ({
    type: existing?.type ?? 'ARC', vendor_id: existing ? String(existing.vendor_id) : '', title: existing?.title ?? '', category: existing?.category ?? '', plant: existing?.plant ?? '*',
    valid_from: existing?.valid_from ?? t, valid_to: existing?.valid_to ?? addYear(t), value_cap: existing?.value_cap != null ? String(existing.value_cap) : '',
    payment_terms: existing?.payment_terms ?? '', delivery_terms: existing?.delivery_terms ?? 'FOR destination', discount_pct: existing?.discount_pct != null ? String(existing.discount_pct) : '',
    invoice_validation: !!existing?.invoice_validation, renewal_lead_days: String(existing?.renewal_lead_days ?? opts.renewal_lead_days), price_revision_date: existing?.price_revision_date ?? '',
    terms: existing?.terms ?? '', owner_id: existing?.owner_id ? String(existing.owner_id) : '',
    vmi_freq: existing?.vmi?.replenishment_frequency ?? 'Weekly', vmi_billing: existing?.vmi?.billing_cycle ?? 'Monthly on consumption', vmi_recon: existing?.vmi?.reconciliation ?? '',
  }));
  const [lines, setLines] = useState<Line[]>(() => existing?.items.length ? existing.items.map((i) => {
    const pl = existing.price_lists.find((p) => p.state === 'Current') ?? existing.price_lists[0];
    const v = existing.vmi?.items.find((x) => x.material_id === i.material_id);
    return { material_id: String(i.material_id), unit_price: String(i.unit_price), qty_cap: i.qty_cap != null ? String(i.qty_cap) : '', discount_pct: i.discount_pct != null ? String(i.discount_pct) : '', list_price: String(pl?.items.find((x) => x.material_id === i.material_id)?.list_price ?? ''), vmi_min: v ? String(v.min) : '', vmi_max: v ? String(v.max) : '' };
  }) : [{ ...blank }]);
  const [files, setFiles] = useState<number[]>([]);
  const set = (k: keyof typeof h, v: string | boolean) => setH((x) => ({ ...x, [k]: v }));
  const setLine = (i: number, k: keyof Line, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const isFds = h.type === 'FDS';
  const isVmi = h.type === 'VMI';
  const mats = useMemo(() => new Map(opts.materials.map((m) => [String(m.id), m])), [opts.materials]);
  const vendors = opts.vendors.filter((v) => !v.sap_blocked);
  useEffect(() => { if (isFds && !existing) set('invoice_validation', true); /* eslint-disable-next-line */ }, [isFds]);

  const netPrice = (l: Line) => {
    const lp = n(l.list_price);
    const d = n(l.discount_pct) ?? n(h.discount_pct) ?? 0;
    return lp != null ? Math.round(lp * (1 - d / 100) * 100) / 100 : null;
  };
  const body = (submit: boolean) => ({
    type: h.type, vendor_id: Number(h.vendor_id) || 0, title: h.title, category: h.category, plant: h.plant, valid_from: h.valid_from, valid_to: h.valid_to,
    value_cap: n(h.value_cap), payment_terms: h.payment_terms, delivery_terms: h.delivery_terms, discount_pct: n(h.discount_pct), invoice_validation: h.invoice_validation,
    renewal_lead_days: Number(h.renewal_lead_days) || undefined, price_revision_date: h.price_revision_date || null, terms: h.terms || null, owner_id: h.owner_id ? Number(h.owner_id) : null,
    items: lines.filter((l) => l.material_id).map((l) => ({ material_id: Number(l.material_id), unit_price: isFds ? netPrice(l) ?? Number(l.unit_price || 0) : Number(l.unit_price || 0), qty_cap: n(l.qty_cap), discount_pct: n(l.discount_pct), list_price: isFds ? n(l.list_price) : null })),
    vmi: isVmi ? { items: lines.filter((l) => l.material_id && l.vmi_min !== '' && l.vmi_max !== '').map((l) => ({ material_id: Number(l.material_id), min: Number(l.vmi_min), max: Number(l.vmi_max) })), replenishment_frequency: h.vmi_freq, billing_cycle: h.vmi_billing, reconciliation: h.vmi_recon || 'Monthly joint stock count', plant: h.plant !== '*' ? h.plant : null } : null,
    price_list: isFds ? { effective_from: h.valid_from, items: lines.filter((l) => l.material_id && n(l.list_price)).map((l) => ({ material_id: Number(l.material_id), list_price: Number(l.list_price) })), note: existing ? 'Price list from draft edit' : 'Initial price list' } : null,
    attachment_ids: files, submit,
  });
  const save = useAction((submit: boolean) => (existing ? api.put(`/contracts/${existing.id}`, body(submit)) : api.post('/contracts', body(submit))), {
    success: (r: any) => (r.status === 'Pending approval' ? `Contract ${r.contract_no} sent for approval` : `Draft ${r.contract_no} saved`),
    invalidate: [['contracts']], onSuccess: (r: any) => navigate(`/contracts/${r.id}`), silentError: true,
  });
  const fe = (k: string) => fieldError(save.error, k);
  const total = lines.reduce((s, l) => s + (isFds ? netPrice(l) ?? 0 : Number(l.unit_price || 0)) * Number(l.qty_cap || 0), 0);

  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/contracts">Contracts</Link><span>/</span><span>{existing ? existing.contract_no : 'New'}</span></>} screen="SCR-CON-02"
        title={existing ? `Edit draft ${existing.contract_no}` : 'New platform contract'}
        sub="The contract is approved here, then the SAP team creates the outline agreement. It can route PRs only after the SAP OA syncs back (FR-CON-09)."
      />
      <div className="stack" style={{ maxWidth: 1100 }}>
        <ErrorSummary error={save.error} />
        <Card title="Contract">
          <div className="form-grid">
            <Field label="Type" required error={fe('type')}><Select value={h.type} onChange={(e) => set('type', e.target.value)} options={opts.types.map((x) => ({ value: x, label: `${x} — ${TYPE_LABEL[x]}` }))} /></Field>
            <Field label="Vendor" required error={fe('vendor_id')} hint="Vendor needs an SAP code for the outline agreement."><Select value={h.vendor_id} onChange={(e) => set('vendor_id', e.target.value)} placeholder="Choose a vendor" options={vendors.map((v) => ({ value: v.id, label: `${v.name}${v.sap_code ? ` (${v.sap_code})` : ' — no SAP code'}` }))} /></Field>
            <Field label="Title" required error={fe('title')} className="span-2"><Input value={h.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Annual rate contract – final drive bearings" maxLength={160} /></Field>
            <Field label="Spend category" required error={fe('category')}><Select value={h.category} onChange={(e) => set('category', e.target.value)} placeholder="Choose a category" options={opts.categories.map((c) => ({ value: c.code, label: `${c.name} (${c.code})` }))} /></Field>
            <Field label="Plant" error={fe('plant')}><Select value={h.plant} onChange={(e) => set('plant', e.target.value)} options={[{ value: '*', label: 'All plants' }, ...opts.plants.map((p) => ({ value: p.code, label: `${p.code} — ${p.name}` }))]} /></Field>
            <Field label="Valid from" required error={fe('valid_from')}><Input type="date" value={h.valid_from} onChange={(e) => set('valid_from', e.target.value)} /></Field>
            <Field label="Valid to" required error={fe('valid_to')}><Input type="date" value={h.valid_to} onChange={(e) => set('valid_to', e.target.value)} /></Field>
            <Field label="Value cap (₹)" error={fe('value_cap')} hint={total ? `Items × quantity caps = ${fmtMoney(total, true)}` : 'Leave empty for no value cap.'}><Input type="number" min={0} inputMode="decimal" value={h.value_cap} onChange={(e) => set('value_cap', e.target.value)} /></Field>
            <Field label="Owner" hint="Receives renewal and alert notifications."><Select value={h.owner_id} onChange={(e) => set('owner_id', e.target.value)} placeholder="Me" options={opts.buyers.map((b) => ({ value: b.id, label: b.name }))} /></Field>
            <Field label="Payment terms" required error={fe('payment_terms')}><Input value={h.payment_terms} onChange={(e) => set('payment_terms', e.target.value)} placeholder="e.g. 45 days from GRN" /></Field>
            <Field label="Delivery terms" required error={fe('delivery_terms')}><Input value={h.delivery_terms} onChange={(e) => set('delivery_terms', e.target.value)} placeholder="e.g. FOR destination" /></Field>
            <Field label={isFds ? 'Fixed discount (%)' : 'Discount (%)'} required={isFds} error={fe('discount_pct')} hint={isFds ? 'Applied to the price list effective on the PO date.' : 'Optional.'}><Input type="number" min={0} max={100} step="0.01" value={h.discount_pct} onChange={(e) => set('discount_pct', e.target.value)} /></Field>
            <Field label={<>Renewal lead time (days) <DecisionTag id="Q 7.6" /></>} error={fe('renewal_lead_days')}><Input type="number" min={1} max={365} value={h.renewal_lead_days} onChange={(e) => set('renewal_lead_days', e.target.value)} /></Field>
            <Field label="Price revision date" error={fe('price_revision_date')}><Input type="date" value={h.price_revision_date} onChange={(e) => set('price_revision_date', e.target.value)} /></Field>
            <div className="field" style={{ alignSelf: 'end' }}><Checkbox label="Validate invoices against this contract's price list (Module 10)" checked={h.invoice_validation} onChange={(e) => set('invoice_validation', e.target.checked)} /></div>
            <Field label="Terms and conditions" className="span-2"><Textarea rows={3} value={h.terms} onChange={(e) => set('terms', e.target.value)} maxLength={4000} placeholder="Price firmness, delivery lead time, warranty, revision clause…" /></Field>
          </div>
        </Card>

        <Card title={isFds ? 'Items and price list (v1)' : isVmi ? 'Items, prices and VMI levels' : 'Items and prices'} actions={<Button size="sm" icon={<Plus />} onClick={() => setLines((l) => [...l, { ...blank }])}>Add item</Button>}>
          {fe('items') && <div className="field__error" role="alert" style={{ marginBottom: 8 }}>{fe('items')}</div>}
          <div className="stack">
            {lines.map((l, i) => {
              const m = mats.get(l.material_id);
              return (
                <div key={i} className="stack-sm" style={{ padding: 12, border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
                  <div className="row between"><SectionTitle>Item {i + 1}{m ? ` · ${m.code}` : ''}</SectionTitle>{lines.length > 1 && <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove item {i + 1}</Button>}</div>
                  <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                    <Field label="Material" required error={fe(`items.${i}.material_id`)} className="span-2"><Select value={l.material_id} onChange={(e) => setLine(i, 'material_id', e.target.value)} placeholder="Choose a material" options={opts.materials.filter((x) => !h.category || x.category === h.category || String(x.id) === l.material_id).map((x) => ({ value: x.id, label: `${x.code} — ${x.description}` }))} /></Field>
                    {isFds ? (
                      <>
                        <Field label="List price (₹)" required error={fe(`items.${i}.list_price`)}><Input type="number" min={0} value={l.list_price} onChange={(e) => setLine(i, 'list_price', e.target.value)} /></Field>
                        <Field label="Net contract price" hint="List × (1 − discount)"><Input value={netPrice(l) != null ? fmtMoney(netPrice(l)) : '—'} readOnly /></Field>
                      </>
                    ) : (
                      <Field label="Contract price (₹)" required error={fe(`items.${i}.unit_price`)} hint={m?.lpp ? `Last purchase ${fmtMoney(m.lpp)}` : undefined}><Input type="number" min={0} inputMode="decimal" value={l.unit_price} onChange={(e) => setLine(i, 'unit_price', e.target.value)} /></Field>
                    )}
                    <Field label={`Quantity cap${m ? ` (${m.uom})` : ''}`} error={fe(`items.${i}.qty_cap`)}><Input type="number" min={0} value={l.qty_cap} onChange={(e) => setLine(i, 'qty_cap', e.target.value)} /></Field>
                    <Field label="Item discount (%)" error={fe(`items.${i}.discount_pct`)}><Input type="number" min={0} max={100} value={l.discount_pct} onChange={(e) => setLine(i, 'discount_pct', e.target.value)} placeholder={h.discount_pct || '—'} /></Field>
                    {isVmi && (
                      <>
                        <Field label="VMI minimum" required error={fe(`vmi.items.${i}.min`)}><Input type="number" min={0} value={l.vmi_min} onChange={(e) => setLine(i, 'vmi_min', e.target.value)} /></Field>
                        <Field label="VMI maximum" required error={fe(`vmi.items.${i}.max`)}><Input type="number" min={0} value={l.vmi_max} onChange={(e) => setLine(i, 'vmi_max', e.target.value)} /></Field>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {isVmi && (
          <Card title="VMI terms">
            {fe('vmi') && <Callout tone="bad">{fe('vmi')}</Callout>}
            <div className="form-grid">
              <Field label="Replenishment frequency" required><Input value={h.vmi_freq} onChange={(e) => set('vmi_freq', e.target.value)} /></Field>
              <Field label="Billing cycle" required><Input value={h.vmi_billing} onChange={(e) => set('vmi_billing', e.target.value)} /></Field>
              <Field label="Reconciliation" required className="span-2"><Textarea rows={2} value={h.vmi_recon} onChange={(e) => set('vmi_recon', e.target.value)} placeholder="How and when stock is jointly counted and variances settled" /></Field>
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>Stock levels come from SAP (INT-M04). Vendor and buyer are alerted when unrestricted stock falls below the minimum.</p>
          </Card>
        )}

        <Card title="Documents">
          <FileDrop onUploaded={(f) => setFiles(f.map((x) => x.id))} label="Signed contract, rate annexure, correspondence" />
        </Card>

        <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
          <Button onClick={() => navigate(existing ? `/contracts/${existing.id}` : '/contracts')}>Cancel</Button>
          <Button variant="deep" icon={<Save />} loading={save.busy} onClick={() => save.fire(false)}>Save draft</Button>
          <Button variant="primary" icon={<Send />} loading={save.busy} onClick={() => save.fire(true)}>Save and send for approval</Button>
        </div>
      </div>
    </>
  );
}
