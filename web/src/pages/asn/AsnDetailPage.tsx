import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, ClipboardX, Pencil, Send, Truck, XCircle, PackageCheck, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, DecisionTag, Empty, KV, Loader, PageHeader, Ref, SimBadge, Status, Tabs } from '@/components/ui';
import { Field, Input, Textarea, ErrorSummary, fieldError } from '@/components/forms';
import { Modal, ReasonDialog } from '@/components/overlay';
import { AttachmentList } from '@/components/Attachments';
import { AuditTrail } from '@/components/AuditTrail';
import { TrackChain } from '@/components/TrackChain';
import { asnChain, TermBadge, todayIso, addDaysIso } from './shared';
import type { AsnDetail } from './types';

/** SCR-ASN-02 ASN detail (internal) and the vendor's ASN view. */
export default function AsnDetailPage({ vendor = false }: { vendor?: boolean }) {
  const id = Number(useParams().id);
  const q = useQuery<AsnDetail>({ queryKey: ['asn', 'detail', id], queryFn: () => api.get(`/asn/asns/${id}`) });
  return <Loader q={q} rows={10}>{(a) => <View a={a} vendor={vendor} />}</Loader>;
}

function View({ a, vendor }: { a: AsnDetail; vendor: boolean }) {
  const { can } = useAuth();
  const [tab, setTab] = useState<'details' | 'history' | 'audit'>('details');
  const [dialog, setDialog] = useState<'cancel' | 'dispatch' | 'schedule' | 'picked' | 'failed' | null>(null);
  const inv = [['asn']];
  const submit = useAction(() => api.post(`/asn/asns/${a.id}/submit`), { success: `ASN ${a.asn_no} submitted to Equipcare`, invalidate: inv });
  const cancel = useAction((reason: string) => api.post(`/asn/asns/${a.id}/cancel`, { reason }), { success: `ASN ${a.asn_no} cancelled`, invalidate: inv });
  const base = vendor ? '/vendor/asns' : '/asns';
  const eq = a.pickup_by === 'Equipcare';

  return (
    <>
      <PageHeader
        eyebrow={<><Link to={base}>{vendor ? 'Dispatch' : 'ASN & dispatch'}</Link><span>/</span><span className="mono">{a.asn_no}</span></>} screen={vendor ? 'SCR-VPT-06' : 'SCR-ASN-02'}
        title={<>ASN <span className="mono">{a.asn_no}</span></>}
        badges={<><Status value={a.status} />{a.version > 1 && <Badge tone="info" plain>Version {a.version}</Badge>}{a.pickup_overdue && <Badge tone="bad">Pickup overdue</Badge>}{a.delivery_overdue && <Badge tone="bad">Past expected date</Badge>}</>}
        sub={<>PO <span className="mono">{a.po_no}</span> · {vendor ? `to ${a.plant_name}` : a.vendor_name} · {a.plant} · expected {fmtDate(a.expected_date)}</>}
        actions={
          <>
            {a.actions.submit && <Button variant="primary" icon={<Send />} loading={submit.busy} onClick={submit.fire}>Submit ASN</Button>}
            {a.actions.dispatch && <Button variant="primary" icon={<Truck />} onClick={() => setDialog('dispatch')}>Mark dispatched</Button>}
            {a.actions.edit && <ButtonLink to={`/vendor/asns/${a.id}/edit`} icon={<Pencil size={16} />}>{a.status === 'Draft' ? 'Edit draft' : 'Revise ASN'}</ButtonLink>}
            {a.actions.raise_dispute && <ButtonLink to={`/disputes/new?asn=${a.id}`} icon={<ClipboardX size={16} />} variant="secondary">Record receipt issue</ButtonLink>}
            {a.actions.cancel && <Button variant="danger" icon={<XCircle />} onClick={() => setDialog('cancel')}>Cancel ASN</Button>}
          </>
        }
      />

      <Card title="Lifecycle">
        <TrackChain steps={asnChain(a)} />
        {a.status === 'Cancelled' && a.cancel_reason && <div style={{ marginTop: 12 }}><Callout tone="bad" title="Cancelled">{a.cancel_reason}</Callout></div>}
        {a.pickup_overdue && <div style={{ marginTop: 12 }}><Callout tone="bad" title="Equipcare pickup overdue">Pickup was {a.pickup_status === 'Scheduled' ? 'scheduled' : 'requested'} for {fmtDate(a.pickup_date ?? a.dispatch_date)} and is not recorded as collected. The buyer and plant stores have been alerted (AC-ASN-03).</Callout></div>}
      </Card>
      <div style={{ height: 16 }} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'details', label: 'Dispatch & lines' }, { id: 'history', label: 'Versions', count: a.versions.length }, ...(vendor ? [] : [{ id: 'audit' as const, label: 'Audit history' }])]} />

      {tab === 'details' && (
        <div className="split">
          <div className="stack">
            <Card title="Lines" flush>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Item</th><th>Material</th><th className="num">Ordered</th><th className="num">On this ASN</th><th className="num">Received (GRN)</th><th>PO line</th></tr></thead>
                  <tbody>
                    {a.lines.map((l) => (
                      <tr key={l.po_line_id}>
                        <td className="mono">{l.item}</td>
                        <td><div style={{ fontWeight: 600, minWidth: 180 }}>{l.description}</div><div className="small subtle mono">{l.material_code}</div></td>
                        <td className="num">{fmtNum(l.ordered)} {l.uom}</td>
                        <td className="num"><strong>{fmtNum(l.qty)}</strong> {l.uom}</td>
                        <td className="num">{l.received_on_asn == null ? <span className="subtle">—</span> : <span style={{ color: l.received_on_asn < l.qty ? 'var(--bad)' : 'var(--ok)', fontWeight: 600 }}>{fmtNum(l.received_on_asn)}</span>}</td>
                        <td><Status value={l.line_status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card title="Dispatch data">
              <KV cols items={[
                [eq ? 'Ready for pickup' : 'Dispatch date', fmtDate(a.dispatch_date)], ['Expected delivery', fmtDate(a.expected_date)],
                ['Transporter', a.transporter], ['LR / AWB', a.lr_no ? <span className="mono">{a.lr_no}</span> : a.lr_mandatory && !eq ? <span style={{ color: 'var(--bad)' }}>Missing</span> : '—'],
                ['Vehicle', a.vehicle_no ? <span className="mono">{a.vehicle_no}</span> : '—'], ['E-way bill', a.eway_bill ? <span className="mono">{a.eway_bill}</span> : '—'],
                ['Invoice / challan', a.invoice_ref], ['Packing', a.packing_details], ['Submitted', fmtDateTime(a.submitted_at)], ['Delivered', fmtDateTime(a.delivered_at)],
              ]} />
            </Card>
            <Card title="Documents">
              <AttachmentList ownerType="asn" ownerId={a.id} canUpload={vendor ? a.actions.edit : can('asn.receive', 'po.followup')} camera uploadLabel={vendor ? 'Dispatch document' : 'Receipt document'} />
            </Card>
            {!vendor && (
              <Card title="Receipt discrepancies" actions={a.actions.raise_dispute && <ButtonLink to={`/disputes/new?asn=${a.id}`} size="sm" icon={<ClipboardX size={14} />}>Record receipt issue</ButtonLink>}>
                {a.disputes.length ? (
                  <ul className="list-plain stack-sm">
                    {a.disputes.map((d) => <li key={d.id} className="row between"><span><Ref to={`/disputes/${d.id}`}>{d.dsp_no}</Ref> · {d.type} · {d.qty} · owner {d.owner_party}</span><Status value={d.status} /></li>)}
                  </ul>
                ) : <p className="muted small">No discrepancies recorded against this ASN.</p>}
              </Card>
            )}
          </div>
          <div className="stack">
            <Card title="Delivery terms">
              <KV items={[
                ['Terms', <><TermBadge term={a.delivery_terms} /> <span className="small subtle">{a.po.delivery_terms_text}</span></>], ['Freight', a.freight_mode], ['Transit risk', a.transit_risk],
                ['Pickup by', a.pickup_by], ...(eq ? [['Pickup status', <Status value={a.pickup_status ?? 'Requested'} />], ['Pickup date', fmtDate(a.pickup_date)]] as [string, React.ReactNode][] : []),
                ['Deliver to', `${a.plant_name} (${a.plant})`],
              ]} />
              <p className="small muted" style={{ marginTop: 10 }}>Defaulted from the PO <DecisionTag id="DEC-24" /></p>
              {a.actions.pickup && (
                <div className="row-wrap" style={{ marginTop: 12 }}>
                  <Button size="sm" icon={<CalendarClock />} onClick={() => setDialog('schedule')}>{a.pickup_status === 'Scheduled' ? 'Reschedule pickup' : 'Schedule pickup'}</Button>
                  <Button size="sm" variant="primary" icon={<Truck />} onClick={() => setDialog('picked')}>Record pickup</Button>
                  <Button size="sm" variant="ghost" icon={<TriangleAlert />} onClick={() => setDialog('failed')}>Pickup failed</Button>
                </div>
              )}
            </Card>
            <Card title="Purchase order">
              <KV items={[['PO', vendor ? <Ref to={`/vendor/pos/${a.po.id}`}>{a.po.po_no}</Ref> : <Ref to={`/pos/${a.po.id}`}>{a.po.po_no}</Ref>], ['PO date', fmtDate(a.po.po_date)], ['Urgency', a.po.urgency], ['Buyer', a.po.buyer_name], ...(vendor ? [] : [['Vendor', a.vendor_name] as [string, React.ReactNode]]), ['Payment terms', a.po.payment_terms]]} />
            </Card>
            <Card title="Linked GRNs" actions={<span className="small muted">From SAP (INT-M10)</span>}>
              {a.grns.length ? (
                <ul className="list-plain stack-sm">
                  {a.grns.map((g) => <li key={g.id} className="row between small"><span><span className="mono">{g.grn_no}</span> · item {g.item}</span><span>{fmtNum(g.qty)} · {fmtDate(g.posting_date)}{!vendor && g.value != null ? ` · ${fmtMoney(g.value, true)}` : ''}</span></li>)}
                </ul>
              ) : <p className="small muted">No GRN yet. The ASN becomes Delivered when stores post the GRN in SAP and it synchronises.</p>}
              {a.actions.post_grn && (
                <div className="sim-panel stack-sm" style={{ marginTop: 12 }}>
                  <span className="small"><SimBadge>SAP simulator</SimBadge> Stores post the GRN in SAP. In this MVP the SAP simulator stands in for that step.</span>
                  <ButtonLink to={`/sap-simulator?action=grn&po=${a.po_no}&asn=${a.id}`} size="sm" variant="deep" icon={<PackageCheck size={14} />}>Post GRN in SAP simulator</ButtonLink>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
      {tab === 'history' && (
        <Card title="Versions">
          {!a.versions.length ? <Empty title="No revisions">This ASN has not been changed since it was submitted.</Empty> : (
            <ol className="timeline">
              <li><span className="timeline__dot" data-tone="ok" /><div className="timeline__title">Version {a.version} (current)</div><div className="timeline__meta">Expected {fmtDate(a.expected_date)} · vehicle {a.vehicle_no ?? '—'} · LR {a.lr_no ?? '—'}</div></li>
              {a.versions.map((v) => (
                <li key={v.id}>
                  <span className="timeline__dot" />
                  <div className="timeline__title">Version {v.version} replaced</div>
                  <div className="timeline__meta">{v.created_by_name ?? '—'} · {fmtDateTime(v.created_at)}</div>
                  <div className="timeline__body">Reason: {v.reason}</div>
                  <div className="small subtle">Was: expected {fmtDate(v.snapshot.expected_date)} · vehicle {v.snapshot.vehicle_no ?? '—'} · LR {v.snapshot.lr_no ?? '—'} · {(v.snapshot.lines ?? []).map((l: any) => `item ${l.item}: ${l.qty}`).join(', ')}</div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}
      {tab === 'audit' && <Card title="Audit history"><AuditTrail objectType="asn" objectId={a.id} /></Card>}

      <ReasonDialog open={dialog === 'cancel'} onClose={() => setDialog(null)} title={`Cancel ASN ${a.asn_no}`} variant="danger" confirmLabel="Cancel ASN" sub="Stores and the buyer are notified. The quantity becomes available for a new ASN." onSubmit={(r) => cancel.run(r)} />
      <DispatchDialog a={a} open={dialog === 'dispatch'} onClose={() => setDialog(null)} />
      <PickupDialog a={a} mode={dialog === 'schedule' || dialog === 'picked' || dialog === 'failed' ? dialog : null} onClose={() => setDialog(null)} />
    </>
  );
}

function DispatchDialog({ a, open, onClose }: { a: AsnDetail; open: boolean; onClose: () => void }) {
  const [f, setF] = useState({ transporter: a.transporter ?? '', lr_no: a.lr_no ?? '', vehicle_no: a.vehicle_no ?? '' });
  const act = useAction(() => api.post(`/asn/asns/${a.id}/dispatch`, f), { success: `ASN ${a.asn_no} marked dispatched`, invalidate: [['asn']], onSuccess: onClose, silentError: true });
  return (
    <Modal open={open} onClose={onClose} title="Mark dispatched" sub="Confirms the consignment has left your works. Equipcare sees it as in transit."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={act.busy} onClick={act.fire}>Mark dispatched</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="Transporter"><Input value={f.transporter} onChange={(e) => setF({ ...f, transporter: e.target.value })} /></Field>
        <Field label="LR / AWB number" required={a.lr_mandatory} error={fieldError(act.error, 'lr_no')}><Input value={f.lr_no} onChange={(e) => setF({ ...f, lr_no: e.target.value })} className="mono" /></Field>
        <Field label="Vehicle number"><Input value={f.vehicle_no} onChange={(e) => setF({ ...f, vehicle_no: e.target.value })} className="mono" /></Field>
      </div>
    </Modal>
  );
}

function PickupDialog({ a, mode, onClose }: { a: AsnDetail; mode: 'schedule' | 'picked' | 'failed' | null; onClose: () => void }) {
  const [f, setF] = useState({ pickup_date: a.pickup_date && a.pickup_date >= todayIso() ? a.pickup_date : addDaysIso(1), transporter: a.transporter ?? '', lr_no: a.lr_no ?? '', vehicle_no: a.vehicle_no ?? '', note: '' });
  const action = mode === 'picked' ? 'picked_up' : mode;
  const label = mode === 'schedule' ? 'Schedule pickup' : mode === 'picked' ? 'Record pickup' : 'Record failed pickup';
  const act = useAction(() => api.post(`/asn/asns/${a.id}/pickup`, { action, ...f, pickup_date: mode === 'picked' ? todayIso() : f.pickup_date }), {
    success: mode === 'schedule' ? `Pickup scheduled for ${fmtDate(f.pickup_date)}` : mode === 'picked' ? `Pickup recorded — ${a.asn_no} is in transit` : 'Failed pickup recorded', invalidate: [['asn']], onSuccess: onClose, silentError: true,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open={!!mode} onClose={onClose} title={label} sub="Equipcare-arranged pickup for an Ex-Works order (FR-ASN-03)."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={mode === 'failed' ? 'danger' : 'primary'} loading={act.busy} disabled={mode === 'failed' && f.note.trim().length < 10} onClick={act.fire}>{label}</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        {mode === 'schedule' && <Field label="Pickup date" required error={fieldError(act.error, 'pickup_date')}><Input type="date" min={todayIso()} value={f.pickup_date} onChange={set('pickup_date')} /></Field>}
        {mode !== 'failed' && <Field label="Transporter"><Input value={f.transporter} onChange={set('transporter')} /></Field>}
        {mode === 'picked' && <Field label="LR / AWB number" required error={fieldError(act.error, 'lr_no')}><Input value={f.lr_no} onChange={set('lr_no')} className="mono" /></Field>}
        {mode === 'picked' && <Field label="Vehicle number"><Input value={f.vehicle_no} onChange={set('vehicle_no')} className="mono" /></Field>}
        {mode === 'failed' && <Field label="What happened?" required hint="At least 10 characters. The buyer and stores are alerted." error={fieldError(act.error, 'note')}><Textarea rows={3} value={f.note} onChange={set('note')} /></Field>}
      </div>
    </Modal>
  );
}
