import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtMoney, todayISO } from '@/lib/format';
import { Button, Callout, Card, Empty, Loader, PageHeader, Segmented, Status } from '@/components/ui';
import { Field, Input, Textarea, ErrorSummary, fieldError, Checkbox } from '@/components/forms';
import type { PoDetail } from './types';

type AmdType = 'Quantity' | 'Price' | 'Date' | 'Terms' | 'Cancel';

/** SCR-POM-03 — amendment / cancellation request: old vs new per line, type, reason (FR-POM-09, FR-APR-07). */
export default function AmendPage() {
  const id = Number(useParams().id);
  const q = useQuery<PoDetail>({ queryKey: ['po', 'detail', id], queryFn: () => api.get(`/po/pos/${id}`) });
  return <Loader q={q} rows={8}>{(d) => <AmendForm d={d} />}</Loader>;
}

function AmendForm({ d }: { d: PoDetail }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [type, setType] = useState<AmdType>('Quantity');
  const [vals, setVals] = useState<Record<number, string>>({});
  const [cancelSel, setCancelSel] = useState<Record<number, boolean>>({});
  const [terms, setTerms] = useState({ payment_terms: d.payment_terms ?? '', delivery_terms: d.delivery_terms ?? '' });
  const [reason, setReason] = useState('');
  const editable = d.lines.filter((l) => l.status !== 'Cancelled' && l.ack_status !== 'Cancelled');
  const changed = useMemo(() => editable.filter((l) => {
    const v = vals[l.id];
    if (!v) return false;
    return type === 'Quantity' ? Number(v) !== l.qty : type === 'Price' ? Number(v) !== l.unit_price : type === 'Date' ? v !== l.delivery_date : false;
  }), [vals, type, editable]);
  const delta = type === 'Quantity' ? changed.reduce((s, l) => s + (Number(vals[l.id]) - l.qty) * (l.unit_price ?? 0), 0)
    : type === 'Price' ? changed.reduce((s, l) => s + (Number(vals[l.id]) - (l.unit_price ?? 0)) * l.qty, 0)
    : type === 'Cancel' ? -editable.filter((l) => cancelSel[l.id]).reduce((s, l) => s + (l.qty - l.received_qty) * (l.unit_price ?? 0), 0) : 0;
  const cancelAll = type === 'Cancel' && !Object.values(cancelSel).some(Boolean);
  const needsConfirm = type === 'Cancel' && (d.asns.some((a) => ['Submitted', 'In transit', 'Delivered'].includes(a.status)) || editable.some((l) => (cancelAll || cancelSel[l.id]) && l.received_qty > 0));
  const act = useAction(() => api.post<{ id: number; amd_no: string; approval_id: number | null }>(`/po/pos/${d.id}/amendments`, {
    type, reason,
    lines: type === 'Cancel' ? editable.filter((l) => cancelSel[l.id]).map((l) => ({ line_id: l.id }))
      : type === 'Terms' ? [] : changed.map((l) => ({ line_id: l.id, ...(type === 'Quantity' ? { qty: Number(vals[l.id]) } : type === 'Price' ? { unit_price: Number(vals[l.id]) } : { delivery_date: vals[l.id] }) })),
    ...(type === 'Terms' ? { terms } : {}),
  }), { success: (r) => `${r.amd_no} sent for approval`, invalidate: [['po']], onSuccess: () => navigate(`/pos/${d.id}?tab=amend`), silentError: true });

  if (!can('po.amend')) return <Empty title="Your role cannot request PO amendments" />;
  if (!['Published', 'Partially received'].includes(d.status)) return <Empty title={`PO ${d.po_no} is ${d.status.toLowerCase()}`}>Closed or cancelled POs cannot be amended.</Empty>;
  if (d.open_amendment) return <Empty title={`${d.open_amendment.amd_no} is still ${d.open_amendment.status.toLowerCase()}`} action={<Link className="btn btn--deep" to={`/pos/${d.id}?tab=amend`}>Open the amendment</Link>}>Finish or withdraw it before raising another change on this PO.</Empty>;

  const canSubmit = reason.trim().length >= 10 && (type === 'Cancel' || (type === 'Terms' ? (terms.payment_terms !== (d.payment_terms ?? '') || terms.delivery_terms !== (d.delivery_terms ?? '')) : changed.length > 0));
  return (
    <>
      <PageHeader eyebrow={<><Link to="/pos">Purchase orders</Link><span>/</span><Link to={`/pos/${d.id}`} className="mono">{d.po_no}</Link><span>/</span><span>Amendment</span></>} screen="SCR-POM-03"
        title={`Amend or cancel PO ${d.po_no}`} sub={`${d.vendor.name} · version ${d.version}. The request goes to approval, then the buyer applies it in SAP; the vendor re-acknowledges the new version.`} />
      <div className="split">
        <div className="stack">
          <Card title="Change">
            <div className="stack">
              <ErrorSummary error={act.error} />
              <Field label="Type of change" required>
                <Segmented label="Type of change" value={type} onChange={(t) => { setType(t); setVals({}); setCancelSel({}); }} options={[{ id: 'Quantity', label: 'Quantity' }, { id: 'Price', label: 'Price' }, { id: 'Date', label: 'Date' }, { id: 'Terms', label: 'Terms' }, { id: 'Cancel', label: 'Cancel' }]} />
              </Field>
              {type === 'Terms' ? (
                <div className="form-grid">
                  <Field label={`Payment terms (now: ${d.payment_terms ?? '—'})`}><Input value={terms.payment_terms} onChange={(e) => setTerms({ ...terms, payment_terms: e.target.value })} maxLength={200} /></Field>
                  <Field label={`Delivery terms (now: ${d.delivery_terms ?? '—'})`}><Input value={terms.delivery_terms} onChange={(e) => setTerms({ ...terms, delivery_terms: e.target.value })} maxLength={200} /></Field>
                </div>
              ) : (
                <div className="tbl-wrap"><table className="tbl">
                  <thead><tr><th>Line</th><th>Description</th><th className="num">Received</th><th>{type === 'Cancel' ? 'Cancel' : 'Old'}</th>{type !== 'Cancel' && <th>New</th>}</tr></thead>
                  <tbody>{editable.map((l) => {
                    const old = type === 'Quantity' ? `${l.qty} ${l.uom}` : type === 'Price' ? fmtMoney(l.unit_price) : fmtDate(l.delivery_date);
                    const full = l.received_qty >= l.qty;
                    return (
                      <tr key={l.id}>
                        <td className="mono">{l.item}</td>
                        <td><div style={{ minWidth: 180 }}>{l.description}</div><div className="small subtle"><Status value={l.ack_status} /></div></td>
                        <td className="num">{l.received_qty} {l.uom}</td>
                        {type === 'Cancel' ? (
                          <td><Checkbox label={full ? 'Fully received' : `Cancel ${l.qty - l.received_qty} ${l.uom} open`} disabled={full} checked={!!cancelSel[l.id]} onChange={(e) => setCancelSel({ ...cancelSel, [l.id]: e.target.checked })} /></td>
                        ) : (
                          <>
                            <td className="nowrap">{old}</td>
                            <td style={{ minWidth: 150 }}>
                              <Input aria-label={`New ${type.toLowerCase()} for line ${l.item}`} type={type === 'Date' ? 'date' : 'number'} min={type === 'Date' ? todayISO() : type === 'Quantity' ? l.received_qty : 0} step="any"
                                value={vals[l.id] ?? ''} placeholder={type === 'Date' ? undefined : 'Unchanged'} onChange={(e) => setVals({ ...vals, [l.id]: e.target.value })} />
                              {fieldError(act.error, `lines.${changed.findIndex((x) => x.id === l.id)}.${type === 'Quantity' ? 'qty' : type === 'Price' ? 'unit_price' : 'delivery_date'}`) && <span className="field__error">{fieldError(act.error, `lines.${changed.findIndex((x) => x.id === l.id)}.${type === 'Quantity' ? 'qty' : type === 'Price' ? 'unit_price' : 'delivery_date'}`)}</span>}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}</tbody>
                </table></div>
              )}
              {type === 'Cancel' && <p className="small muted">{cancelAll ? 'No line selected: the whole PO (all open quantity) is cancelled.' : 'Only the selected lines are cancelled.'}</p>}
              <Field label="Reason" required hint="At least 10 characters. The approver and the audit trail see it." error={fieldError(act.error, 'reason')}>
                <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              </Field>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Button variant="decision" icon={<Send />} loading={act.busy} disabled={!canSubmit} onClick={act.fire}>Send for approval</Button>
              </div>
            </div>
          </Card>
        </div>
        <div className="stack">
          <Card title="What happens next">
            <ol className="timeline">
              {['Approval: ' + (type === 'Cancel' ? 'PO cancellation' : 'PO amendment') + (type === 'Price' ? ' + price-amendment exception' : ''), 'Buyer applies the change in SAP', 'New PO version syncs: Changed in SAP', 'Republished to the vendor (NTF-20)', 'Vendor re-acknowledges'].map((s, i) => (
                <li key={i}><span className="timeline__dot" aria-hidden /><div className="timeline__title">{s}</div></li>
              ))}
            </ol>
          </Card>
          {type === 'Price' && <Callout tone="decision" title="Price amendment">Every price change also needs a price-amendment exception approval and is recorded in the exception register (FR-APR-04).</Callout>}
          {needsConfirm && <Callout tone="warn" title="Stores and vendor confirmation needed">An ASN or goods receipt exists. Stores and the vendor must confirm the cancellation (recorded with user and time) before it can go to SAP.</Callout>}
          {delta !== 0 && <Card title="Value impact"><strong style={{ fontSize: 'var(--fs-20)' }}>{fmtMoney(delta)}</strong><div className="small muted">Before GST, on the changed lines.</div></Card>}
        </div>
      </div>
    </>
  );
}
