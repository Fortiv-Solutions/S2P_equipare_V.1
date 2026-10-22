import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, FilePenLine, FileText, MessageSquarePlus, Siren, ClipboardCheck, Send, Undo2, XCircle, CalendarClock } from 'lucide-react';
import { api, ApiError, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { ago, fmtDate, fmtDateTime, fmtMoney, fmtNum } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, DecisionTag, Empty, KV, Loader, PageHeader, Priority, Ref, SimBadge, Status, Tabs, Freshness } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Field, Input, ErrorSummary, Checkbox } from '@/components/forms';
import { Modal, ReasonDialog, useToast } from '@/components/overlay';
import { TrackChain } from '@/components/TrackChain';
import { AuditTrail } from '@/components/AuditTrail';
import { AckLineForm, type AckPayload } from './AckLineForm';
import { DeliveryRisk } from './DeliveryRisk';
import { ACKED, AckRecordNote, AckStatus, CommitCell, CommitDialog, CommitmentHistory, FollowupDialog, FollowupTimeline, SapAckCell, amendmentChain, poChain } from './shared';
import type { Amendment, PoDetail, PoLineDetail } from './types';

type Tab = 'lines' | 'docs' | 'amend' | 'audit';

/** SCR-POM-02 — PO detail & follow-up. Requisitioners see their own PR's PO without prices (FR-POM-11). */
export default function PoDetailPage() {
  const id = Number(useParams().id);
  const q = useQuery<PoDetail>({ queryKey: ['po', 'detail', id], queryFn: () => api.get(`/po/pos/${id}`) });
  return <Loader q={q} rows={10}>{(d) => <PoView d={d} />}</Loader>;
}

function PoView({ d }: { d: PoDetail }) {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'lines';
  const setTab = (t: Tab) => { sp.set('tab', t); setSp(sp, { replace: true }); };
  const [dialog, setDialog] = useState<'followup' | 'escalate' | 'ack' | null>(null);
  const [commitLine, setCommitLine] = useState<PoLineDetail | null>(null);
  const inv = [['po']];
  const internal = d.view === 'internal';
  const canFollow = internal && can('po.followup');
  const open = ['Published', 'Partially received'].includes(d.status);
  const remind = useAction(() => api.post<{ type: string; lines: number; recipients: number }>(`/po/pos/${d.id}/remind`), {
    success: (r) => `Reminder sent to the vendor for ${r.lines} line(s)${r.recipients ? '' : ' — vendor has no portal user, so it is logged only'}`, invalidate: inv,
  });
  const escalate = useAction((reason: string) => api.post<{ level: number; to: string }>(`/po/pos/${d.id}/escalate`, { reason }), { success: (r) => `PO ${d.po_no} escalated to level ${r.level} (${r.to})`, invalidate: inv });
  const pending = d.lines.filter((l) => ['Pending', 'Pending re-acknowledgement'].includes(l.ack_status) && l.active);
  const priced = d.view !== 'requisitioner';

  const lineCols: Column<PoLineDetail>[] = [
    { key: 'item', header: 'Item', render: (l) => <span className="mono">{l.item}</span> },
    { key: 'description', header: 'Material', render: (l) => <div style={{ minWidth: 200 }}><div style={{ fontWeight: 600 }}>{l.description}</div><div className="small subtle mono">{l.material_code}{l.pr_ref ? ` · PR ${l.pr_ref}` : ''}{l.requisitioner_name ? ` · ${l.requisitioner_name}` : ''}</div></div> },
    { key: 'qty', header: 'Ordered', align: 'right', render: (l) => <span className="num">{fmtNum(l.qty)} {l.uom}</span> },
    ...(priced ? [{ key: 'unit_price', header: 'Unit price', align: 'right', render: (l: PoLineDetail) => <span className="num">{fmtMoney(l.unit_price)}</span> } as Column<PoLineDetail>] : []),
    { key: 'ack_status', header: 'Acknowledgement', render: (l) => <div className="stack-sm" style={{ gap: 2 }}><AckStatus l={l} />{l.ack_remarks && <span className="small muted" style={{ maxWidth: 220 }}>{l.ack_remarks}</span>}</div> },
    { key: 'commitment', header: 'Commitment', render: (l) => <CommitCell l={l} />, value: (l) => l.commitment },
    { key: 'received_qty', header: 'Received / invoiced', align: 'right', render: (l) => <span className="num">{fmtNum(l.received_qty)} / {fmtNum(l.invoiced_qty)}</span> },
    { key: 'delay_reason', header: 'Delay reason', render: (l) => l.delay_reason ?? <span className="subtle">—</span> },
    { key: 'next_action', header: 'Next action', render: (l) => <span style={{ fontWeight: l.needs_action ? 700 : 500, color: l.needs_action ? 'var(--bad)' : undefined }}>{l.next_action}</span> },
    ...(internal ? [{ key: 'sap_ack', header: 'SAP (INT-M08)', render: (l: PoLineDetail) => <SapAckCell ack={l.sap_ack} mode={d.config.sap_write_ack} />, value: (l: PoLineDetail) => l.sap_ack?.status ?? 'Platform', hidden: !d.config.sap_write_ack && !d.lines.some((l) => l.sap_ack) } as Column<PoLineDetail>] : []),
    ...(canFollow && open ? [{ key: 'act', header: '', sortable: false, exportable: false, render: (l: PoLineDetail) => ACKED.includes(l.ack_status) && l.active ? <Button size="sm" variant="ghost" icon={<CalendarClock />} onClick={() => setCommitLine(l)}>Commitment</Button> : null } as Column<PoLineDetail>] : []),
  ];

  return (
    <>
      <PageHeader
        eyebrow={<>{internal ? <Link to="/pos">Purchase orders</Link> : <Link to="/my-requirements">My requirements</Link>}<span>/</span><span className="mono">{d.po_no}</span></>} screen="SCR-POM-02"
        title={<>PO <span className="mono">{d.po_no}</span></>}
        badges={<><Status value={d.status} /><Priority value={d.urgency} />{d.version > 1 && <Badge tone="deep">Version {d.version}</Badge>}{d.sap_change_pending && <Badge tone="warn">Change pending in SAP</Badge>}{d.deemed_accepted && <Badge tone="warn">Deemed accepted</Badge>}{d.escalation_level > 0 && <Badge tone="bad">Escalated L{d.escalation_level}</Badge>}</>}
        sub={<>{d.vendor.name} ({d.vendor.sap_code}) · {d.plant_info?.name ?? d.plant} · PO date {fmtDate(d.po_date)}{priced && d.total_value != null ? ` · ${fmtMoney(d.total_value, true)}` : ''}</>}
        actions={internal ? (
          <>
            <a className="btn btn--secondary" href={downloadUrl(`/po/pos/${d.id}/pdf`)} target="_blank" rel="noreferrer"><FileText size={16} /> PO PDF</a>
            {canFollow && open && <Button icon={<BellRing />} loading={remind.busy} onClick={remind.fire}>Remind vendor</Button>}
            {canFollow && open && <Button icon={<MessageSquarePlus />} onClick={() => setDialog('followup')}>Log follow-up</Button>}
            {canFollow && open && <Button variant="danger" icon={<Siren />} onClick={() => setDialog('escalate')} disabled={d.escalation_level >= 3}>Escalate</Button>}
            {can('po.amend') && open && !d.open_amendment && <ButtonLink to={`/pos/${d.id}/amend`} variant="primary" icon={<FilePenLine size={16} />}>Request amendment</ButtonLink>}
          </>
        ) : undefined}
      />

      <Card className="no-print" title={<div className="row-wrap"><h2>Lifecycle</h2><Freshness flow="INT-M07" label="PO" />{d.stale && <span className="stale">PO copy older than {d.freshness_minutes} min</span>}</div>}>
        <TrackChain steps={poChain(d)} />
        <div className="stack-sm" style={{ marginTop: 12 }}>
          {d.sap_change_pending && <Callout tone="warn" title="Change pending in SAP">{d.open_amendment ? `${d.open_amendment.amd_no} (${d.open_amendment.type.toLowerCase()}) is approved.` : 'An approved change'} The vendor keeps seeing version {d.version} until SAP sends the new version.</Callout>}
          {d.status === 'Cancelled' && <Callout tone="bad" title="Cancelled in SAP">This PO was cancelled in SAP and republished to the vendor.</Callout>}
          {pending.length > 0 && open && <Callout tone={d.lines.some((l) => l.ack_overdue) ? 'bad' : 'info'} title={`${pending.length} line(s) waiting for vendor acknowledgement`}>
            Due {fmtDateTime(d.ack_due_at)}{d.viewed_at ? ` · vendor opened the PO ${ago(d.viewed_at)}` : ' · vendor has not opened the PO yet'}. {d.config.deemed_acceptance.enabled ? `Deemed accepted after ${d.config.deemed_acceptance.hours} h without response.` : 'Deemed acceptance is off.'} <DecisionTag id="DEC-16" />
            {canFollow && <> <Button size="sm" variant="ghost" icon={<ClipboardCheck />} onClick={() => setDialog('ack')}>Record acknowledgement received offline</Button></>}
          </Callout>}
          {d.view === 'requisitioner' && <Callout tone="info">You see this PO because it covers your PR lines. Prices are not shown to requisitioners.</Callout>}
        </div>
      </Card>

      <div style={{ height: 16 }} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'lines', label: 'Lines & follow-up' },
        { id: 'docs', label: 'ASN, GRN, invoices', count: d.asns.length + d.grns.length + d.invoices.length + d.disputes.length },
        ...(d.view !== 'requisitioner' || d.amendments.length ? [{ id: 'amend' as Tab, label: 'Amendments', count: d.amendments.length }] : []),
        ...(internal ? [{ id: 'audit' as Tab, label: 'Audit history' }] : []),
      ]} />

      {tab === 'lines' && (
        <div className="stack">
          <Card flush title="Lines">
            <DataTable id="po-detail-lines" rows={d.lines} columns={lineCols} rowKey={(l) => l.id} searchable={false} savedViews={false} pageSize={50} exportName={`PO-${d.po_no}-lines`}
              mobile={{ title: (l) => <>Line {l.item} · {l.description}</>, badge: (l) => <Status value={l.ack_status} />, meta: (l) => [`${fmtNum(l.qty)} ${l.uom}`, l.commit_date ? `Commit ${fmtDate(l.commit_date)}` : `PO date ${fmtDate(l.delivery_date)}`, `Received ${fmtNum(l.received_qty)}`, l.delay_reason ?? '', <span key="n" style={{ color: l.needs_action ? 'var(--bad)' : undefined }}>{l.next_action}</span>] }} />
            {internal && <div style={{ padding: '10px 14px' }}><AckRecordNote mode={d.config.sap_write_ack} /></div>}
          </Card>
          {canFollow && open && can('po.view') && <DeliveryRisk poId={d.id} />}
        <div className="split">
          <div className="stack">
            <Card title="Follow-up log" actions={canFollow && open ? <Button size="sm" icon={<MessageSquarePlus />} onClick={() => setDialog('followup')}>Log follow-up</Button> : undefined}>
              <FollowupTimeline items={d.followups} empty="No follow-up yet. Reminders, vendor updates and buyer notes appear here." />
            </Card>
          </div>
          <div className="stack">
            <Card title="Commitment history"><CommitmentHistory lines={d.lines} /></Card>
            <Card title="Purchase order">
              <KV items={[
                ['Vendor', <>{d.vendor.name}<div className="small subtle">{d.vendor.sap_code}{d.vendor.gstin ? ` · ${d.vendor.gstin}` : ''}</div></>],
                ...(internal && d.vendor.contact_name ? [['Vendor contact', <>{d.vendor.contact_name}<div className="small subtle">{d.vendor.contact_phone} · {d.vendor.contact_email}</div></>] as [string, React.ReactNode]] : []),
                ['Buyer', d.buyer ? <>{d.buyer.name}<div className="small subtle">{d.buyer.email}</div></> : '—'],
                ...(internal ? [["Buyer's manager", d.buyer_manager?.name ?? '—'] as [string, React.ReactNode]] : []),
                ['Plant', d.plant_info ? `${d.plant_info.name} (${d.plant})` : d.plant],
                ['Delivery terms', d.delivery_terms], ['Freight', d.freight_terms], ['Payment terms', d.payment_terms],
                ['RFQ', d.rfq ? <Ref to={`/rfqs/${d.rfq.id}`}>{d.rfq.rfq_no}</Ref> : d.rfq_date ? `RFQ date ${fmtDate(d.rfq_date)}` : '—'],
                ['Contract', d.contract ? <Ref to={`/contracts/${d.contract.id}`}>{`${d.contract.type} ${d.contract.sap_oa_no ?? d.contract.contract_no}`}</Ref> : '—'],
                ['Version', `${d.version}${d.publications.length ? ` · published ${fmtDate(d.publications[d.publications.length - 1].published_at)}` : ''}`],
                ['Vendor opened', d.viewed_at ? fmtDateTime(d.viewed_at) : 'Not yet'],
              ]} />
            </Card>
            {d.totals && (
              <Card title="Value">
                <KV items={[['Goods', fmtMoney(d.totals.goods)], ['GST', fmtMoney(d.totals.gst)], ['Freight', fmtMoney(d.totals.freight)], ['Total', <strong>{fmtMoney(d.totals.total)}</strong>]]} />
              </Card>
            )}
            {internal && (
              <Card title="Reminders & escalation">
                <KV items={[
                  ['Reminders this version', d.reminders], ['Escalation level', d.escalation_level ? `Level ${d.escalation_level}` : 'Not escalated'],
                  ['Ack reminder', <>After {d.config.reminders.ack_after_hours} h <DecisionTag id="Q 7.7" /></>],
                  ['Dispatch reminder', `${d.config.reminders.dispatch_days_before} d before commitment`], ['Overdue reminder', `${d.config.reminders.overdue_days_after} d after commitment`],
                  ['Escalation', <>L2 after {d.config.escalation.level2_days} d, L3 after {d.config.escalation.level3_days} d <DecisionTag id="Q 14.1" /></>],
                  ['Deemed acceptance', <>{d.config.deemed_acceptance.enabled ? `On (${d.config.deemed_acceptance.hours} h)` : 'Off'} <DecisionTag id="DEC-16" /></>],
                ]} />
              </Card>
            )}
          </div>
        </div>
        </div>
      )}
      {tab === 'docs' && <DocsTab d={d} />}
      {tab === 'amend' && <AmendmentsTab d={d} />}
      {tab === 'audit' && <Card title="Audit history"><AuditTrail objectType="po" objectId={d.id} /></Card>}

      <FollowupDialog open={dialog === 'followup'} onClose={() => setDialog(null)} invalidate={inv} po={{ id: d.id, po_no: d.po_no, lines: d.lines, reasons: d.config.delay_reasons }} />
      <ReasonDialog open={dialog === 'escalate'} onClose={() => setDialog(null)} title={`Escalate PO ${d.po_no}`} variant="danger" confirmLabel="Escalate"
        sub={`Level ${Math.max(2, d.escalation_level + 1)} goes to ${d.escalation_level + 1 <= 2 ? `${d.buyer_manager?.name ?? 'the Procurement Manager'} (buyer's manager)` : 'Management'}. The requisitioner is informed.`}
        onSubmit={(r) => escalate.run(r)} />
      <CommitDialog line={commitLine} onClose={() => setCommitLine(null)} url={(l) => `/po/lines/${l.id}/commitment`} reasons={d.config.delay_reasons} invalidate={inv} />
      {dialog === 'ack' && <OnBehalfAck d={d} lines={pending} onClose={() => setDialog(null)} />}
    </>
  );
}

function OnBehalfAck({ d, lines, onClose }: { d: PoDetail; lines: PoLineDetail[]; onClose: () => void }) {
  const [source, setSource] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const submit = async (p: AckPayload) => {
    await api.post(`/po/pos/${d.id}/acknowledge`, { lines: [p], source });
    toast(`Acknowledgement for line ${lines.find((l) => l.id === p.line_id)?.item} recorded`);
    await qc.invalidateQueries({ queryKey: ['po'] });
  };
  return (
    <Modal open onClose={onClose} wide title={`Record acknowledgement · PO ${d.po_no}`} sub="Use when the vendor acknowledged by e-mail or phone (for example a vendor without a portal user). Recorded as entered by you, with the source."
      footer={<Button onClick={onClose}>Done</Button>}>
      <div className="stack">
        <Field label="How the vendor acknowledged" required hint="At least 10 characters, e.g. “E-mail from Arindam Bose, 14 Oct 2026”."><Input value={source} onChange={(e) => setSource(e.target.value)} maxLength={300} /></Field>
        {lines.length === 0 ? <Empty title="All lines are acknowledged" /> : lines.map((l) => <AckLineForm key={l.id} line={l} onSubmit={(p) => { if (source.trim().length < 10) throw new ApiError(400, 'validation_failed', 'Enter how the vendor acknowledged (at least 10 characters) first.'); return submit(p); }} />)}
      </div>
    </Modal>
  );
}

function DocsTab({ d }: { d: PoDetail }) {
  return (
    <div className="grid-2">
      <Card title="ASNs & dispatch">
        {d.asns.length ? <ul className="list-plain stack-sm">{d.asns.map((a) => <li key={a.id} className="row between"><span><Ref to={`/asns/${a.id}`}>{a.asn_no}</Ref> <span className="small muted">dispatched {fmtDate(a.dispatch_date)} · ETA {fmtDate(a.expected_date)}{a.lr_no ? ` · LR ${a.lr_no}` : ''}</span></span><Status value={a.status} /></li>)}</ul>
          : <Empty title="No ASN yet">The vendor submits an ASN when the goods are dispatched.</Empty>}
      </Card>
      <Card title="Goods receipts (SAP)" actions={<Freshness flow="INT-M10" label="GRN" />}>
        {d.grns.length ? <table className="tbl tbl--dense"><thead><tr><th>GRN / SES</th><th>Item</th><th className="num">Qty</th><th>Posted</th>{d.view !== 'requisitioner' && <th className="num">Value</th>}</tr></thead>
          <tbody>{d.grns.map((g, i) => <tr key={i}><td className="mono">{g.grn_no}</td><td>{g.item}</td><td className="num">{fmtNum(g.qty)}</td><td>{fmtDate(g.posting_date)}</td>{d.view !== 'requisitioner' && <td className="num">{fmtMoney(g.value)}</td>}</tr>)}</tbody></table>
          : <Empty title="Nothing received yet">GRNs are posted in SAP and appear here after sync.</Empty>}
      </Card>
      {d.view !== 'requisitioner' && (
        <Card title="Invoices">
          {d.invoices.length ? <ul className="list-plain stack-sm">{d.invoices.map((x) => <li key={x.id} className="row between"><span><Ref to={`/invoices/${x.id}`}>{x.inv_ref}</Ref> <span className="small muted">{x.vendor_invoice_no ?? ''} · {fmtDate(x.invoice_date)} · {fmtMoney(x.total_value)}</span></span><Status value={x.status} /></li>)}</ul>
            : <Empty title="No invoice yet">The vendor uploads invoices against this PO in the portal.</Empty>}
        </Card>
      )}
      <Card title="Disputes">
        {d.disputes.length ? <ul className="list-plain stack-sm">{d.disputes.map((x) => <li key={x.id} className="row between"><span><Ref to={`/disputes/${x.id}`}>{x.dsp_no}</Ref> <span className="small muted">{x.type}{x.item ? ` · line ${x.item}` : ''} · owner {x.owner_party ?? '—'}</span></span><Status value={x.status} /></li>)}</ul>
          : <Empty title="No disputes">Receipt discrepancies raised by stores appear here.</Empty>}
      </Card>
    </div>
  );
}

function AmendmentsTab({ d }: { d: PoDetail }) {
  const { can } = useAuth();
  if (!d.amendments.length) {
    return <Card><Empty title="No amendments" action={can('po.amend') && ['Published', 'Partially received'].includes(d.status) ? <ButtonLink to={`/pos/${d.id}/amend`} variant="primary">Request amendment</ButtonLink> : undefined}>Quantity, price, date, terms changes and cancellations go through approval, then SAP, then the vendor re-acknowledges.</Empty></Card>;
  }
  return <div className="stack">{d.amendments.map((a) => <AmendmentCard key={a.id} d={d} a={a} />)}</div>;
}

const money = (v: number | null | undefined) => (v == null ? '—' : fmtMoney(v));

export function ChangeTable({ a }: { a: Amendment }) {
  if (a.type === 'Terms') {
    return <KV items={Object.keys(a.changes.terms?.new ?? {}).map((k) => [k.replace('_', ' '), <><s className="subtle">{a.changes.terms!.old[k] ?? '—'}</s> → <strong>{a.changes.terms!.new[k]}</strong></>])} />;
  }
  return (
    <div className="tbl-wrap"><table className="tbl tbl--dense">
      <thead><tr><th>Line</th><th>Description</th><th>Field</th><th>Old</th><th>New</th></tr></thead>
      <tbody>{a.changes.lines.map((c) => {
        const [field, o, n] = c.new.deleted ? ['Line', `${c.old.qty} ${c.uom}`, 'Cancelled'] : c.new.qty != null ? ['Quantity', `${c.old.qty} ${c.uom}`, `${c.new.qty} ${c.uom}`] : c.new.delivery_date ? ['Delivery date', fmtDate(c.old.delivery_date), fmtDate(c.new.delivery_date)] : ['Unit price', money(c.old.unit_price), money(c.new.unit_price)];
        return <tr key={c.line_id}><td className="mono">{c.item}</td><td>{c.description}</td><td>{field}</td><td><s className="subtle">{o}</s></td><td><strong>{n}</strong></td></tr>;
      })}</tbody>
    </table></div>
  );
}

function AmendmentCard({ d, a }: { d: PoDetail; a: Amendment }) {
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const inv = [['po']];
  const [dlg, setDlg] = useState<'decline' | 'withdraw' | 'vendorconf' | null>(null);
  const [sapMsg, setSapMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const forward = useAction(() => api.post(`/po/amendments/${a.id}/forward`), { success: `${a.amd_no} sent for approval`, invalidate: inv });
  const decline = useAction((reason: string) => api.post(`/po/amendments/${a.id}/decline`, { reason }), { success: `${a.amd_no} declined; the vendor is informed`, invalidate: inv });
  const withdraw = useAction((reason: string) => api.post(`/po/amendments/${a.id}/withdraw`, { reason }), { success: `${a.amd_no} withdrawn`, invalidate: inv });
  const confirm = useAction((party: 'stores' | 'vendor', note?: string) => api.post(`/po/amendments/${a.id}/confirm`, { party, note: note ?? null }), { success: (r: Amendment) => `Confirmation recorded on ${r.amd_no}`, invalidate: inv });
  const conf = a.changes.confirmations;
  const needsConf = a.type === 'Cancel' && a.changes.requires_confirmation;
  const confOk = !needsConf || (conf.stores && conf.vendor);
  const applyInSap = async () => {
    setBusy(true);
    setSapMsg(null);
    try {
      const prep = await api.post<{ po_no: string; endpoint: string; body: unknown }>(`/po/amendments/${a.id}/sap-request`);
      try {
        const r = await api.post<{ version?: number }>(prep.endpoint, prep.body);
        toast(`SAP simulator changed PO ${prep.po_no}${r?.version ? ` to version ${r.version}` : ''}`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404 && /Unknown API endpoint/i.test(e.message)) setSapMsg('The SAP simulator change action is not available in this build. Apply the change in SAP; this amendment moves to "Changed in SAP" when the new PO version syncs.');
        else setSapMsg(`SAP simulator did not apply the change: ${(e as Error).message}`);
      }
    } catch (e) {
      setSapMsg((e as Error).message);
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: ['po'] });
    }
  };
  const mine = a.requested_by === me?.id;
  return (
    <Card title={<div className="row-wrap"><h2 className="mono">{a.amd_no}</h2><Badge tone="decision">{a.type === 'Cancel' ? 'Cancellation' : `${a.type} change`}</Badge><Status value={a.status} />{a.raised_by_vendor && <Badge tone="info">Raised by vendor</Badge>}</div>}
      actions={<span className="small muted">{a.requested_by_name} · {fmtDateTime(a.created_at)}</span>}>
      <div className="stack">
        <TrackChain compact steps={amendmentChain(a)} label={`${a.amd_no} progress`} />
        <div><strong>{a.summary}</strong><div className="small muted">Reason: {a.reason}</div>{a.changes.value_delta != null && a.changes.value_delta !== 0 && <div className="small muted">Value change {fmtMoney(a.changes.value_delta)}</div>}</div>
        <ChangeTable a={a} />
        {a.approvals.length > 0 && (
          <div className="row-wrap">{a.approvals.map((p) => <span key={p.id} className="row" style={{ gap: 6 }}><Ref to={`/approvals/${p.id}`}>{p.req_no}</Ref><span className="small muted">{p.type === 'exc.price_amendment' ? 'Price amendment exception' : p.type === 'po.cancellation' ? 'PO cancellation' : 'PO amendment'}</span><Status value={p.status} /></span>)}</div>
        )}
        {a.type === 'Price' && a.status === 'Requested' && <p className="small muted">Price changes need the PO amendment approval and a price-amendment exception approval (logged in the exception register, FR-APR-04).</p>}
        {needsConf && (
          <div className="stack-sm">
            <span className="section-title">Confirmations before SAP ({a.changes.confirmation_reason})</span>
            <Checkbox label={conf.stores ? `Stores confirmed — ${conf.stores.name}, ${fmtDateTime(conf.stores.at)}` : 'Stores confirms the cancelled quantity will not be received (stores in-charge for the plant)'}
              checked={!!conf.stores} disabled={!!conf.stores || !can('asn.receive') || !['Requested', 'Approved'].includes(a.status)} onChange={() => confirm.fire('stores')} />
            <Checkbox label={conf.vendor ? `Vendor confirmed — ${conf.vendor.name}${conf.vendor.on_behalf ? ` (recorded on behalf: ${conf.vendor.note})` : ''}, ${fmtDateTime(conf.vendor.at)}` : 'Vendor confirms the cancellation (in the portal, or recorded by the buyer with the source)'}
              checked={!!conf.vendor} disabled={!!conf.vendor || !can('po.amend') || !['Requested', 'Approved'].includes(a.status)} onChange={() => setDlg('vendorconf')} />
          </div>
        )}
        {a.status === 'Approved' && can('po.amend') && (
          <div className="sim-panel stack-sm">
            <div className="row-wrap between">
              <span className="small"><SimBadge>SAP simulator</SimBadge> The buyer applies the approved change in SAP. In this MVP the SAP simulator stands in; the PO here changes only when SAP sends the new version.</span>
              {can('sapsim.po') && <Button variant="deep" size="sm" icon={<Send />} loading={busy} disabled={!confOk} onClick={applyInSap}>Apply in SAP simulator</Button>}
            </div>
            {!confOk && <span className="small" style={{ color: 'var(--bad)' }}>Stores and vendor confirmations are required before this cancellation can go to SAP.</span>}
            {a.changes.sap_request && <span className="small muted">Sent to SAP by {a.changes.sap_request.by_name} {ago(a.changes.sap_request.at)} — waiting for the new PO version.</span>}
            {sapMsg && <Callout tone="warn">{sapMsg}</Callout>}
          </div>
        )}
        {a.status === 'Republished' && <Callout tone="info" title="Waiting for the vendor">{a.type === 'Cancel' ? 'The vendor confirms receipt of the cancellation in the portal.' : 'The vendor re-acknowledges the changed lines in the portal.'}</Callout>}
        <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
          {a.raised_by_vendor && a.status === 'Requested' && !a.approvals.length && can('po.amend') && (
            <><Button variant="danger" icon={<XCircle />} onClick={() => setDlg('decline')}>Decline</Button><Button variant="decision" icon={<Send />} loading={forward.busy} onClick={forward.fire}>Send for approval</Button></>
          )}
          {a.status === 'Requested' && mine && a.approvals.length > 0 && <Button icon={<Undo2 />} onClick={() => setDlg('withdraw')}>Withdraw</Button>}
        </div>
      </div>
      <ReasonDialog open={dlg === 'decline'} onClose={() => setDlg(null)} title={`Decline ${a.amd_no}`} variant="danger" confirmLabel="Decline request" sub="The vendor sees this reason." onSubmit={(r) => decline.run(r)} />
      <ReasonDialog open={dlg === 'withdraw'} onClose={() => setDlg(null)} title={`Withdraw ${a.amd_no}`} confirmLabel="Withdraw request" onSubmit={(r) => withdraw.run(r)} />
      <ReasonDialog open={dlg === 'vendorconf'} onClose={() => setDlg(null)} title="Record vendor confirmation" label="How the vendor confirmed" confirmLabel="Record vendor confirmation" sub={`For ${d.vendor.name}. The vendor can also confirm in the portal.`} onSubmit={(r) => confirm.run('vendor', r)} />
      <ErrorSummary error={confirm.error} />
    </Card>
  );
}
