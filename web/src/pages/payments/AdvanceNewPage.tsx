import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtMoney } from '@/lib/format';
import { Button, Callout, Card, KV, Loader, PageHeader, Ref, Status } from '@/components/ui';
import { Field, Input, Select, Textarea, ErrorSummary, fieldError } from '@/components/forms';

interface Ctx { po: { id: number; po_no: string; vendor_name: string; vendor_code: string; plant: string; total_value: number; po_date: string; payment_terms: string | null; status: string }; existing: { id: number; adv_no: string; amount: number; status: string }[]; committed: number; available: number }

/** SCR-PAY-02 — advance request against a PO: amount ≤ PO value, reason required, then approval (Module 5). */
export default function AdvanceNewPage() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [poId, setPoId] = useState(sp.get('po') ?? '');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const pos = useQuery<{ id: number; po_no: string; vendor_name: string; plant: string; total_value: number; status: string }[]>({ queryKey: ['payments', 'po-options'], queryFn: () => api.get('/payments/po-options') });
  const ctx = useQuery<Ctx>({ queryKey: ['payments', 'advance-context', poId], queryFn: () => api.get(`/payments/advance-context/${poId}`), enabled: !!poId });
  const c = ctx.data;
  const submit = useAction(async () => {
    const e: Record<string, string> = {};
    const amt = Number(amount.replace(/,/g, ''));
    if (!poId) e.po_id = 'Choose the purchase order.';
    if (!(amt > 0)) e.amount = 'Enter the advance amount.';
    else if (c && amt > c.available + 0.005) e.amount = `The advance cannot exceed the PO value. Up to ${fmtMoney(c.available)} is available.`;
    if (reason.trim().length < 10) e.reason = 'Give the reason for the advance (at least 10 characters).';
    setLocal(e);
    if (Object.keys(e).length) throw new ApiError(400, 'validation_failed', 'Fix the highlighted items and submit again.', e);
    return api.post<{ id: number; adv_no: string }>('/payments/advances', { po_id: Number(poId), amount: amt, reason: reason.trim() });
  }, { success: (r) => `Advance ${r.adv_no} sent for approval`, invalidate: [['payments'], ['approvals']], onSuccess: (r) => nav(`/advances/${r.id}`), silentError: true });
  const fe = (k: string) => local[k] ?? fieldError(submit.error, k);
  const pct = c && Number(amount) > 0 ? Math.round((Number(amount) / c.po.total_value) * 1000) / 10 : null;

  return (
    <>
      <PageHeader title="Request an advance" screen="SCR-PAY-02" eyebrow={<><Link to="/payments?tab=advances">Payments</Link><span>/</span><span>New advance</span></>}
        sub="The amount cannot exceed the PO value and a reason is required. The request goes through approval; Finance then pays it in SAP." />
      <div className="stack">
        <ErrorSummary error={submit.error} />
        <Card title="Purchase order">
          <div className="stack">
            <Loader q={pos}>{(list) => (
              <Field label="Purchase order" required error={fe('po_id')}>
                <Select value={poId} onChange={(e) => setPoId(e.target.value)} placeholder="Choose a PO" options={list.map((p) => ({ value: p.id, label: `${p.po_no} — ${p.vendor_name} — ${fmtMoney(p.total_value, true)} (${p.status})` }))} />
              </Field>
            )}</Loader>
            {ctx.isLoading && <p className="muted small">Loading PO…</p>}
            {ctx.error && <Callout tone="bad">{(ctx.error as Error).message}</Callout>}
            {c && (
              <>
                <KV cols items={[['PO', <Ref to={`/pos/${c.po.id}`}>{c.po.po_no}</Ref>], ['Vendor', `${c.po.vendor_name} (${c.po.vendor_code})`], ['Plant', c.po.plant], ['PO date', fmtDate(c.po.po_date)], ['PO value', fmtMoney(c.po.total_value)], ['Payment terms', c.po.payment_terms]]} />
                <KV cols items={[['Already requested or paid', fmtMoney(c.committed)], ['Available for an advance', <strong>{fmtMoney(c.available)}</strong>]]} />
                {c.existing.length > 0 && <p className="small muted" style={{ margin: 0 }}>Earlier advances on this PO: {c.existing.map((x) => <span key={x.id} style={{ marginRight: 8 }}><Ref to={`/advances/${x.id}`}>{x.adv_no}</Ref> <Status value={x.status} /></span>)}</p>}
              </>
            )}
          </div>
        </Card>
        {c && (
          <Card title="Advance">
            <div className="stack">
              <div className="form-grid">
                <Field label="Amount (₹)" required error={fe('amount')} hint={pct != null ? `${pct}% of the PO value` : `Maximum ${fmtMoney(c.available)}`}><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
              </div>
              <Field label="Reason for the advance" required error={fe('reason')} hint="Why an advance is needed and what the vendor must do with it. At least 10 characters; shown to approvers."><Textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
              <Callout tone="info" title="What happens next">Approvers are chosen by the approval matrix for the amount. After approval, Finance pays the advance in SAP; the paid date and any adjustment against invoices are synchronised back.</Callout>
              <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                <Button onClick={() => nav(-1)}>Cancel</Button>
                <Button variant="primary" icon={<Send />} loading={submit.busy} onClick={submit.fire}>Send for approval</Button>
              </div>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
