import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CheckCheck, FileText, FilePenLine, Send } from 'lucide-react';
import { api, ApiError, downloadUrl } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum } from '@/lib/format';
import { Badge, Button, Callout, Card, Empty, KV, Loader, PageHeader, Priority, Ref, Status } from '@/components/ui';
import { Field, Input, Select, Textarea, ErrorSummary, fieldError } from '@/components/forms';
import { Modal, useToast } from '@/components/overlay';
import { TrackChain } from '@/components/TrackChain';
import { AckLineForm, type AckPayload } from './AckLineForm';
import { ACKED, AckStatus, CommitCell, CommitDialog, FollowupTimeline, poChain } from './shared';
import { ChangeTable } from './PoDetailPage';
import type { PoDetail, PoLineDetail } from './types';

/** SCR-VPT-05 — vendor PO detail: line-by-line acknowledgement (FR-POM-02, FR-VPT-04). */
export default function VendorPoDetailPage() {
  const id = Number(useParams().id);
  const q = useQuery<PoDetail>({ queryKey: ['po', 'vendor', 'detail', id], queryFn: () => api.get(`/po/vendor/pos/${id}`) });
  return <Loader q={q} rows={8}>{(d) => <View d={d} />}</Loader>;
}

function View({ d }: { d: PoDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const inv = [['po'], ['nav-counts']];
  const [commitLine, setCommitLine] = useState<PoLineDetail | null>(null);
  const [dev, setDev] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const open = ['Published', 'Partially received'].includes(d.status);
  const pending = d.lines.filter((l) => ['Pending', 'Pending re-acknowledgement'].includes(l.ack_status) && l.status !== 'Cancelled');
  const decided = d.lines.filter((l) => !pending.includes(l));
  const cancelAmd = d.amendments.find((a) => a.type === 'Cancel' && a.status === 'Republished');
  const confirmAmd = d.amendments.find((a) => a.type === 'Cancel' && a.raised_by_vendor === false && ['Requested', 'Approved'].includes(a.status) && a.changes.requires_confirmation && !a.changes.confirmations.vendor);
  const ack = async (p: AckPayload) => {
    setBusyId(p.line_id);
    try {
      const r = await api.post<{ results: { item: number; ack_status: string }[] }>(`/po/vendor/pos/${d.id}/acknowledge`, { lines: [p] });
      toast(`Line ${r.results[0].item} ${r.results[0].ack_status.toLowerCase()}. Equipcare has been notified.`);
      await qc.invalidateQueries({ queryKey: ['po'] });
      await qc.invalidateQueries({ queryKey: ['nav-counts'] });
    } finally {
      setBusyId(null);
    }
  };
  const cancelAck = useAction(() => api.post(`/po/vendor/amendments/${cancelAmd!.id}/acknowledge`), { success: 'Cancellation confirmed', invalidate: inv });
  const confirm = useAction(() => api.post(`/po/vendor/amendments/${confirmAmd!.id}/confirm`, {}), { success: 'Cancellation confirmed. Equipcare can now apply it in SAP.', invalidate: inv });
  const reack = pending.filter((l) => l.ack_status === 'Pending re-acknowledgement');
  const ownDeviations = d.amendments.filter((a) => a.raised_by_vendor);

  return (
    <>
      <PageHeader eyebrow={<><Link to="/vendor/pos">Purchase orders</Link><span>/</span><span className="mono">{d.po_no}</span></>} screen="SCR-VPT-05"
        title={<>PO <span className="mono">{d.po_no}</span></>}
        badges={<><Status value={d.status} /><Priority value={d.urgency} />{d.version > 1 && <Badge tone="deep">Version {d.version}</Badge>}</>}
        sub={<>Deliver to {d.plant_info?.name ?? d.plant} · PO date {fmtDate(d.po_date)}{d.total_value != null ? ` · ${fmtMoney(d.total_value, true)} incl. GST` : ''}{d.buyer ? ` · Buyer ${d.buyer.name}` : ''}</>}
        actions={<>
          <a className="btn btn--secondary" href={downloadUrl(`/po/vendor/pos/${d.id}/pdf`, { download: 1 })}><FileText size={16} /> Download PO PDF</a>
          {open && <Button icon={<FilePenLine />} onClick={() => setDev(true)}>Request a change</Button>}
        </>} />

      <Card title="Progress"><TrackChain steps={poChain(d)} /></Card>
      <div style={{ height: 16 }} />

      <div className="stack">
        {cancelAmd && (
          <Callout tone="bad" title={`Equipcare has cancelled this PO (${cancelAmd.amd_no})`}>
            Confirm you have received the cancellation. <Button size="sm" variant="primary" icon={<CheckCheck />} loading={cancelAck.busy} onClick={cancelAck.fire}>Confirm cancellation</Button>
          </Callout>
        )}
        {confirmAmd && (
          <Callout tone="warn" title={`Equipcare plans to cancel ${confirmAmd.changes.scope === 'po' ? 'this PO' : `line(s) ${confirmAmd.changes.lines.map((c) => c.item).join(', ')}`}`}>
            {confirmAmd.reason} Goods are already dispatched or received, so your confirmation is needed before SAP is changed.{' '}
            <Button size="sm" variant="primary" icon={<CheckCheck />} loading={confirm.busy} onClick={confirm.fire}>Confirm cancellation</Button>
          </Callout>
        )}
        {d.sap_change_pending && <Callout tone="info" title="A change to this PO is being processed">You will be notified when the new version is published.</Callout>}
        {reack.length > 0 && <Callout tone="warn" title="This PO was amended">Version {d.version} changed {reack.length} line(s). Please acknowledge them again with a delivery commitment.</Callout>}
        {pending.length > 0 && open && <Callout tone={d.ack_due_at && d.ack_due_at < new Date().toISOString() ? 'bad' : 'info'} title={`${pending.length} line(s) to acknowledge`}>Please respond by {fmtDateTime(d.ack_due_at)}. Accept, accept part of the quantity with a reason, or reject with a reason.</Callout>}

        {open && pending.map((l) => <AckLineForm key={`${l.id}-${l.ack_status}`} line={l} busy={busyId === l.id} onSubmit={ack} />)}

        <Card flush title="Lines">
          <div className="tbl-wrap" data-cards="true"><table className="tbl">
            <thead><tr><th>Item</th><th>Material</th><th className="num">Ordered</th><th className="num">Unit price</th><th>Acknowledgement</th><th>Commitment</th><th className="num">Received</th><th /></tr></thead>
            <tbody>{d.lines.map((l) => (
              <tr key={l.id}>
                <td className="mono">{l.item}</td>
                <td><div style={{ minWidth: 200 }}>{l.description}</div><div className="small subtle mono">{l.material_code}</div></td>
                <td className="num">{fmtNum(l.qty)} {l.uom}</td>
                <td className="num">{fmtMoney(l.unit_price)}<div className="small subtle">GST {l.gst_rate}%</div></td>
                <td><AckStatus l={l} />{l.ack_remarks && <div className="small muted" style={{ maxWidth: 220 }}>{l.ack_remarks}</div>}</td>
                <td><CommitCell l={{ ...l }} />{l.delay_reason && <div className="small muted">{l.delay_reason}</div>}</td>
                <td className="num">{fmtNum(l.received_qty)}</td>
                <td>{open && ACKED.includes(l.ack_status) && l.active && <Button size="sm" variant="ghost" icon={<CalendarClock />} onClick={() => setCommitLine(l)}>Change date</Button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <div className="tbl-cards" style={{ padding: 12 }}>
            {d.lines.map((l) => (
              <div key={l.id} className="tbl-card">
                <div className="tbl-card__top"><span className="tbl-card__title">Line {l.item} · {l.description}</span><Status value={l.ack_status} /></div>
                <div className="tbl-card__meta"><span>{fmtNum(l.qty)} {l.uom}</span><span>{fmtMoney(l.unit_price)}</span><span>Commit {l.commit_date ? fmtDate(l.commit_date) : '—'}</span><span>Received {fmtNum(l.received_qty)}</span></div>
                {open && ACKED.includes(l.ack_status) && l.active && <Button size="sm" icon={<CalendarClock />} onClick={() => setCommitLine(l)}>Change commitment date</Button>}
              </div>
            ))}
          </div>
          {d.totals && <div style={{ padding: '10px 14px' }}><KV cols items={[['Goods', fmtMoney(d.totals.goods)], ['GST', fmtMoney(d.totals.gst)], ['Freight', fmtMoney(d.totals.freight)], ['Total', <strong key="t">{fmtMoney(d.totals.total)}</strong>]]} /></div>}
        </Card>

        <div className="grid-2">
          <Card title="Order terms">
            <KV items={[['Delivery terms', d.delivery_terms], ['Freight', d.freight_terms], ['Payment terms', d.payment_terms], ['Ship to', d.plant_info?.ship_to_address], ['Buyer contact', d.buyer ? `${d.buyer.name} · ${d.buyer.email}` : '—'], ['PO version', `${d.version} (${fmtDate(d.publications[d.publications.length - 1]?.published_at)})`]]} />
            {d.asns.length > 0 && <div style={{ marginTop: 12 }}><span className="section-title">Your dispatches</span><ul className="list-plain stack-sm">{d.asns.map((a) => <li key={a.id} className="row between"><Ref to={`/vendor/asns/${a.id}`}>{a.asn_no}</Ref><Status value={a.status} /></li>)}</ul></div>}
          </Card>
          <Card title="Updates and requests">
            <FollowupTimeline items={d.followups} empty="Your acknowledgements, commitment changes and Equipcare reminders appear here." />
            {ownDeviations.length > 0 && <div className="stack" style={{ marginTop: 14 }}>{ownDeviations.map((a) => (
              <div key={a.id}><div className="row-wrap"><strong className="mono">{a.amd_no}</strong><Status value={a.status === 'Requested' ? 'Requested' : a.status} /></div><div className="small muted">{a.reason}</div><ChangeTable a={a} /></div>
            ))}</div>}
          </Card>
        </div>
        {!open && decided.length === 0 && <Empty title="This PO is closed" />}
      </div>

      <CommitDialog line={commitLine} onClose={() => setCommitLine(null)} url={(l) => `/po/vendor/lines/${l.id}/commitment`} reasons={d.config.delay_reasons} invalidate={inv} />
      <DeviationDialog d={d} open={dev} onClose={() => setDev(false)} />
    </>
  );
}

/** Vendor-raised amendment / deviation request (WF-13): the buyer decides whether to take it to approval. */
function DeviationDialog({ d, open, onClose }: { d: PoDetail; open: boolean; onClose: () => void }) {
  const [type, setType] = useState('Date');
  const [lineId, setLineId] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const line = d.lines.find((l) => String(l.id) === lineId);
  const act = useAction(() => api.post<{ amd_no: string }>(`/po/vendor/pos/${d.id}/deviation`, {
    type, reason, lines: [{ line_id: Number(lineId), ...(type === 'Quantity' ? { qty: Number(value) } : type === 'Price' ? { unit_price: Number(value) } : { delivery_date: value }) }],
  }), { success: (r) => `Request ${r.amd_no} sent to the Equipcare buyer`, invalidate: [['po']], onSuccess: () => { setValue(''); setReason(''); onClose(); }, silentError: true });
  return (
    <Modal open={open} onClose={onClose} title="Request a change to this PO" sub="Equipcare's buyer reviews it. Approved changes are made in Equipcare's system and published as a new PO version."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" icon={<Send />} loading={act.busy} disabled={!lineId || !value || reason.trim().length < 10} onClick={act.fire}>Send request</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="What needs to change" required><Select value={type} onChange={(e) => { setType(e.target.value); setValue(''); }} options={[{ value: 'Date', label: 'Delivery date' }, { value: 'Quantity', label: 'Quantity' }, { value: 'Price', label: 'Unit price' }]} /></Field>
        <Field label="Line" required><Select value={lineId} onChange={(e) => setLineId(e.target.value)} placeholder="Choose a line" options={d.lines.filter((l) => l.active).map((l) => ({ value: l.id, label: `Line ${l.item} · ${l.description.slice(0, 50)}` }))} /></Field>
        <Field label={type === 'Date' ? 'Requested delivery date' : type === 'Quantity' ? 'Requested quantity' : 'Requested unit price (INR)'} required hint={line ? `Now: ${type === 'Date' ? fmtDate(line.delivery_date) : type === 'Quantity' ? `${line.qty} ${line.uom}` : fmtMoney(line.unit_price)}` : undefined} error={fieldError(act.error, 'lines.0.qty') ?? fieldError(act.error, 'lines.0.unit_price') ?? fieldError(act.error, 'lines.0.delivery_date')}>
          <Input type={type === 'Date' ? 'date' : 'number'} step="any" min={type === 'Date' ? new Date().toISOString().slice(0, 10) : 0} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Reason" required hint="At least 10 characters." error={fieldError(act.error, 'reason')}><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}
void ApiError;
