import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { BellRing, CalendarClock, Download, FileX2, Lock, Repeat2, Scale, Send, Timer, XCircle, RotateCcw, Mail } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtLakh, fmtNum, plural } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, DecisionTag, Empty, KV, Kpi, PageHeader, Priority, Ref, SimBadge, Status, Tabs } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Checkbox, ErrorSummary, Field, Input, Textarea, fieldError } from '@/components/forms';
import { Modal, ReasonDialog } from '@/components/overlay';
import { AttachmentList } from '@/components/Attachments';
import { AuditTrail } from '@/components/AuditTrail';
import { CommentThread } from '@/components/Thread';
import { TrackChain } from '@/components/TrackChain';
import { ContractSnapshot } from './RfqBuilder';
import { Countdown, KindBadge, fromLocalInput, lineValue, money, rfqChain, toLocalInput, type BuyerQuote, type Invitation, type RfqDetail } from './shared';

const inv = [['rfq'], ['pr']];
type Tab = 'participation' | 'lines' | 'quotes' | 'approvals' | 'audit';

/** SCR-RFQ-02 — RFQ detail and participation (extend, cancel, re-float, remind, reopen). */
export default function RfqDetailView({ r }: { r: RfqDetail }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const qcInvalidate = () => { qc.invalidateQueries({ queryKey: ['rfq'] }); qc.invalidateQueries({ queryKey: ['pr'] }); };
  const manage = can('rfq.manage') && r.viewer_can_manage;
  const [tab, setTab] = useState<Tab>('participation');
  const [dialog, setDialog] = useState<'remind' | 'extend' | 'cancel' | 'refloat' | 'reopen' | 'exception' | null>(null);
  const live = r.status === 'Published';
  const closed = ['Closed', 'Under comparison'].includes(r.status);
  const close = useAction(() => api.post(`/rfq/rfqs/${r.id}/close`), { success: `RFQ ${r.rfq_no} closed; quotations locked`, invalidate: inv });
  const lockNow = useAction((rid: number) => api.post(`/rfq/rfqs/${r.id}/reopens/${rid}/lock`), { success: 'Reopen window closed; quotations locked again', invalidate: inv });
  const open = live || (r.status === 'Closed' && r.counts.responded === 0);
  const flagged = r.lines.filter((l) => l.status === 'Flagged');
  const noResponse = r.status === 'Closed' && r.counts.responded === 0 && r.counts.sent > 0;
  const pending = r.approvals.find((a) => ['Pending', 'Clarification requested'].includes(a.status));
  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/rfqs">RFQs</Link><span>/</span><span className="mono">{r.rfq_no}</span></>} screen="SCR-RFQ-02" title={r.title}
        badges={<><Status value={r.status} /><KindBadge kind={r.kind} />{r.priority !== 'Normal' && <Priority value={r.priority} />}{r.sealed_now && <Badge tone="decision"><Lock size={11} /> Sealed</Badge>}</>}
        sub={<>{r.buyer_name} · {r.plant} · {plural(r.lines.filter((l) => l.status !== 'Removed').length, 'line')} · {live ? <Countdown at={r.closing_at} /> : <>closing {fmtDateTime(r.closing_at)}</>}</>}
        actions={<>
          {r.comparison_link && can('cmp.view') && <ButtonLink to={r.comparison_link} variant="deep" icon={<Scale size={16} />}>Open comparison</ButtonLink>}
          {manage && live && <Button icon={<BellRing />} onClick={() => setDialog('remind')}>Remind vendors</Button>}
          {manage && open && <Button icon={<CalendarClock />} onClick={() => setDialog('extend')}>Extend</Button>}
          {manage && live && <Button icon={<Timer />} loading={close.busy} disabled={!r.can_close_early} title={r.can_close_early ? undefined : 'Possible once every invited vendor has responded or declined'} onClick={close.fire}>Close early</Button>}
          {manage && ['Published', 'Closed', 'Under comparison'].includes(r.status) && <Button icon={<Repeat2 />} onClick={() => setDialog('refloat')}>Re-float</Button>}
          {manage && closed && r.counts.responded > 0 && !r.reopen_open && !r.reopens.some((x) => x.status === 'Pending approval') && <Button icon={<RotateCcw />} onClick={() => setDialog('reopen')}>Request reopen</Button>}
          {manage && ['Published', 'Closed', 'Pending approval'].includes(r.status) && <Button variant="danger" icon={<XCircle />} onClick={() => setDialog('cancel')}>Cancel RFQ</Button>}
        </>}
      />
      <Card className="no-print"><TrackChain steps={rfqChain(r)} /></Card>
      <div style={{ height: 16 }} />

      {r.status === 'Pending approval' && <Callout tone="decision" title="Waiting for approval">{pending ? <>Request <Ref to={`/approvals/${pending.id}`}>{pending.req_no}</Ref> ({pending.title}) must be approved before invitations are sent. The RFQ publishes automatically on approval.</> : 'An approval is pending.'}</Callout>}
      {r.status === 'Cancelled' && <Callout tone="bad" title="RFQ cancelled">{r.cancel_reason}</Callout>}
      {r.status === 'Re-floated' && <Callout tone="warn" title="RFQ re-floated">{r.cancel_reason} {r.children.map((c) => <span key={c.id}>New RFQ <Ref to={`/rfqs/${c.id}`}>{c.rfq_no}</Ref> ({c.status}). </span>)}</Callout>}
      {r.parent && <Callout tone="info">Re-float of <Ref to={`/rfqs/${r.parent.id}`}>{r.parent.rfq_no}</Ref>.</Callout>}
      {r.counts.delivery_failed > 0 && <Callout tone="bad" title={`${plural(r.counts.delivery_failed, 'invitation')} not delivered`}>The vendor record has no contact e-mail. Update the vendor contact, then resend from the participation table.</Callout>}
      {noResponse && (
        <Callout tone="bad" title="No quotations were received">
          Extend the closing date, re-float the RFQ, or record an exception. {manage && <Button size="sm" variant="decision" onClick={() => setDialog('exception')}>Record exception</Button>}
        </Callout>
      )}
      {r.reopen_open && (
        <Callout tone="warn" title={`Quotations reopened for ${r.reopen_open.vendors.join(', ')}`}>
          Vendors can revise until {fmtDateTime(r.reopen_open.reopen_until)}; then they lock again automatically.{' '}
          {manage && <Button size="sm" loading={lockNow.busy} onClick={() => lockNow.fire(r.reopen_open!.id)}>Lock now</Button>}
        </Callout>
      )}
      {flagged.length > 0 && <Callout tone="bad" title={`${plural(flagged.length, 'line')} flagged — PR cancelled in SAP`}>{flagged.map((l) => `Line ${l.line_no}: ${l.flag_reason}`).join('; ')}. Resolve under Lines.</Callout>}
      <div style={{ height: 8 }} />

      <div className="grid-4" style={{ marginBottom: 20 }}>
        <Kpi label="Invited" value={r.counts.invited} meta={`Category minimum ${r.min_vendors}`} tone={r.counts.invited < r.min_vendors ? 'warn' : undefined} />
        <Kpi label="Viewed" value={r.counts.viewed} meta="Opened the RFQ in the portal" />
        <Kpi label="Responded" value={`${r.counts.responded}`} meta={`${r.counts.declined} declined · ${r.counts.not_responded} not responded`} tone={r.counts.responded ? 'ok' : undefined} />
        <Kpi label="Quotation prices" value={r.sealed_now ? 'Sealed' : r.counts.responded ? 'Visible' : '—'} meta={r.sealed_now ? 'Shown after closing (FR-RFQ-12)' : r.counts.responded ? 'See the Quotations tab' : 'No quotations'} />
      </div>

      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'participation', label: 'Participation', count: r.invitations.length },
        { id: 'lines', label: 'Lines & terms', count: r.lines.filter((l) => l.status !== 'Removed').length },
        { id: 'quotes', label: 'Quotations', count: r.sealed_now ? undefined : r.quotations?.length },
        { id: 'approvals', label: 'Approvals & reopens', count: r.approvals.length || undefined },
        { id: 'audit', label: 'Audit & discussion' },
      ]} />

      {tab === 'participation' && <Participation r={r} manage={manage} />}
      {tab === 'lines' && <LinesTab r={r} manage={manage} />}
      {tab === 'quotes' && <QuotesTab r={r} />}
      {tab === 'approvals' && <ApprovalsTab r={r} />}
      {tab === 'audit' && (
        <div className="split">
          <Card title="Audit history"><AuditTrail objectType="rfq" objectId={r.id} /></Card>
          <Card title="Internal notes"><CommentThread objectType="rfq" objectId={r.id} /></Card>
        </div>
      )}

      <RemindDialog r={r} open={dialog === 'remind'} onClose={() => setDialog(null)} />
      <ExtendDialog r={r} open={dialog === 'extend'} onClose={() => setDialog(null)} />
      <ReopenDialog r={r} open={dialog === 'reopen'} onClose={() => setDialog(null)} />
      <ReasonDialog open={dialog === 'cancel'} onClose={() => setDialog(null)} title={`Cancel RFQ ${r.rfq_no}`} variant="danger" confirmLabel="Cancel RFQ" sub={live || closed ? 'Invited vendors are notified. PR lines go back to Route decided.' : undefined}
        onSubmit={(reason) => api.post(`/rfq/rfqs/${r.id}/cancel`, { reason }).then(() => qcInvalidate())} />
      <ReasonDialog open={dialog === 'refloat'} onClose={() => setDialog(null)} title={`Re-float ${r.rfq_no}`} confirmLabel="Re-float RFQ" variant="deep"
        sub="Creates a linked draft copy with the same lines, PR links, vendors and attachments. This RFQ becomes Re-floated and vendors are told." onSubmit={async (reason) => { const x = await api.post<{ id: number }>(`/rfq/rfqs/${r.id}/refloat`, { reason }); qcInvalidate(); navigate(`/rfqs/${x.id}`); }} />
      <ReasonDialog open={dialog === 'exception'} onClose={() => setDialog(null)} title="Record no-response exception" confirmLabel="Record exception" variant="decision" sub="Procurement managers are told. Use only when extending or re-floating is not appropriate."
        onSubmit={(reason) => api.post(`/rfq/rfqs/${r.id}/no-response-exception`, { reason }).then(() => qcInvalidate())} />
    </>
  );
}

function Participation({ r, manage }: { r: RfqDetail; manage: boolean }) {
  const resend = useAction((id: number) => api.post(`/rfq/rfqs/${r.id}/invitations/${id}/resend`), { success: 'Invitation resent', invalidate: inv });
  const cols: Column<Invitation>[] = [
    { key: 'vendor_name', header: 'Vendor', render: (i) => (
      <div style={{ minWidth: 200 }}><strong>{i.vendor_name}</strong> <span className="mono small subtle">{i.sap_code ?? 'No SAP code'}</span>
        <div className="small muted">{i.city} · {i.contact_email ?? <span style={{ color: 'var(--bad)' }}>no e-mail</span>}</div>
        {!i.suggested && <div className="small"><Badge tone="warn">Not suggested</Badge> {i.added_justification}</div>}
        {i.suggested && i.suggest_reasons && <div className="small subtle">{i.suggest_reasons.reasons.slice(0, 2).map((x) => x.label).join(' · ')}</div>}
      </div>
    ), value: (i) => i.vendor_name },
    { key: 'status', header: 'Participation', render: (i) => <div><Status value={i.status} />{i.decline_reason && <div className="small muted" title={i.decline_reason}>“{i.decline_reason.slice(0, 60)}{i.decline_reason.length > 60 ? '…' : ''}”</div>}</div> },
    { key: 'sent_at', header: 'Sent / delivery', render: (i) => (i.sent_at ? <div className="small">{fmtDateTime(i.sent_at)}<div><Status value={i.delivery_status} tone={i.delivery_status === 'Delivery failed' ? 'bad' : 'info'} /></div></div> : <span className="subtle small">Not sent</span>) },
    { key: 'viewed_at', header: 'Viewed', render: (i) => <span className="small">{fmtDateTime(i.viewed_at)}</span>, nowrap: true },
    { key: 'responded_at', header: 'Responded', render: (i) => <span className="small">{i.quotation && i.quotation.version > 0 ? <>{fmtDateTime(i.responded_at)}<div className="subtle">v{i.quotation.version}{i.quotation.ref_no ? ` · ${i.quotation.ref_no}` : ''} · {i.quotation.status}</div></> : '—'}</span>, nowrap: true },
    { key: 'reminders_sent', header: 'Reminders', align: 'right', render: (i) => <span className="num small">{i.reminders_sent}{i.last_reminder_at ? <div className="subtle">{fmtDateTime(i.last_reminder_at)}</div> : null}</span> },
    { key: 'actions', header: '', sortable: false, exportable: false, render: (i) => (
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <a className="btn btn--ghost btn--sm" href={downloadUrl(`/rfq/rfqs/${r.id}/pdf`, { vendor_id: i.vendor_id })} title="RFQ PDF for this vendor"><Download size={14} /> PDF</a>
        {manage && r.status === 'Published' && i.sent_at && <Button size="sm" variant="ghost" icon={<Mail />} onClick={() => resend.fire(i.id)} title="Send the invitation again">Resend</Button>}
      </div>
    ) },
  ];
  return (
    <Card flush title={<div className="row-wrap"><h2>Invited vendors</h2><span className="small muted">FR-RFQ-08 · e-mail goes to the <SimBadge>simulated outbox</SimBadge></span></div>}
      actions={<a className="btn btn--secondary btn--sm" href={downloadUrl(`/rfq/rfqs/${r.id}/pdf`, { inline: 1 })} target="_blank" rel="noreferrer"><Download size={14} /> RFQ PDF</a>}>
      <DataTable id="rfq-participation" rows={r.invitations} rowKey={(i) => i.id} columns={cols} savedViews={false}
        empty={<Empty title="No vendors invited" />} dense
        mobile={{ title: (i) => i.vendor_name, badge: (i) => <Status value={i.status} />, meta: (i) => [i.sent_at ? `Sent ${fmtDateTime(i.sent_at)}` : 'Not sent', i.delivery_status ?? '', i.viewed_at ? `Viewed ${fmtDateTime(i.viewed_at)}` : 'Not viewed'] }} />
    </Card>
  );
}

function LinesTab({ r, manage }: { r: RfqDetail; manage: boolean }) {
  const [flag, setFlag] = useState<{ id: number; line_no: number; action: 'keep' | 'remove' } | null>(null);
  const resolve = useAction((reason: string) => api.post(`/rfq/rfqs/${r.id}/lines/${flag!.id}/flag`, { action: flag!.action, reason }), { success: 'Flagged line resolved', invalidate: inv });
  return (
    <div className="split">
      <div className="stack">
        <Card flush title="Lines">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Line</th><th>Material</th><th className="num">Qty</th><th>Required</th><th>Quote due</th><th>Plant / ship-to</th><th>GST</th><th>Valuation</th></tr></thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.id} style={l.status === 'Removed' ? { opacity: 0.5 } : undefined}>
                    <td className="mono">{l.line_no}</td>
                    <td style={{ minWidth: 220 }}><div style={{ fontWeight: 600 }}>{l.description}</div>
                      <div className="small subtle"><span className="mono">{l.material_code}</span>{l.pr_ref && <> · PR <Ref to={`/pr/${l.pr_line_id}`}>{l.pr_ref}</Ref></>}{l.requisitioner ? ` · ${l.requisitioner}` : ''}</div>
                      {l.status !== 'Active' && <div className="small" style={{ color: l.status === 'Removed' ? 'var(--text-3)' : 'var(--bad)', fontWeight: 600 }}>{l.status}: {l.flag_reason}</div>}
                      {l.status === 'Flagged' && manage && <div className="row" style={{ marginTop: 4 }}><Button size="sm" onClick={() => setFlag({ id: l.id, line_no: l.line_no, action: 'keep' })}>Keep with reason</Button><Button size="sm" variant="danger" onClick={() => setFlag({ id: l.id, line_no: l.line_no, action: 'remove' })}>Remove line</Button></div>}
                      {l.transport_req && <div className="small muted">Transport: {l.transport_req}</div>}</td>
                    <td className="num nowrap">{fmtNum(l.qty)} {l.uom}</td><td className="nowrap">{fmtDate(l.required_date)}</td><td className="small nowrap">{fmtDateTime(l.due_at)}</td>
                    <td className="small" style={{ minWidth: 180 }}><strong>{l.plant}</strong> · {l.ship_to}</td><td>{l.gst_rate != null ? `${l.gst_rate}%` : '—'}</td><td>{l.valuation_type ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="RFQ attachments"><AttachmentList ownerType="rfq" ownerId={r.id} canUpload={manage && r.status !== 'Cancelled'} uploadLabel="Drawing / specification" /></Card>
      </div>
      <div className="stack">
        <Card title="Terms">
          <KV items={[['Delivery terms', r.delivery_terms], ['Payment terms', r.payment_terms], ['Warranty', r.warranty], ['Packing', r.packing], ['Documents required', r.documents_required], ['Standard terms', r.standard_terms], ['Ship-to', r.ship_to]]} />
        </Card>
        <Card title="Process">
          <KV items={[
            ['Closing', fmtDateTime(r.closing_at)], ['Published', fmtDateTime(r.published_at)], ['Closed', fmtDateTime(r.closed_at)], ['Estimated value', fmtLakh(r.est_value)],
            ['Sealed quotations', <>{r.sealed ? 'Yes' : 'No'} <DecisionTag id="Q 18.1" /></>],
            ['Reminders', r.reminder_schedule ? <>{r.reminder_schedule.before_days.join(', ')} d before · {r.reminder_schedule.after_days.join(', ')} d after <DecisionTag id="Q 7.2" /></> : '—'],
            ['SAP RFQ (INT-M05)', r.sap.enabled ? <>{r.sap.outbound?.status ?? 'Not written'} {r.sap_rfq_ref && <span className="mono">{r.sap_rfq_ref}</span>} <SimBadge>SAP simulator</SimBadge></> : <>Reference only — DEC-04 <DecisionTag id="DEC-04" /></>],
            ['Limited-source reason', r.exception_reason],
          ]} />
          <ContractSnapshot r={r} />
        </Card>
        {(r.extensions?.length ?? 0) > 0 && (
          <Card title="Extensions">
            <ol className="timeline">{r.extensions!.map((e, i) => <li key={i}><span className="timeline__dot" data-tone="warn" /><div className="timeline__title">Extended to {fmtDateTime(e.to)}</div><div className="timeline__meta">from {fmtDateTime(e.from)} · {e.by_name} · {fmtDateTime(e.at)}</div><div className="timeline__body">{e.reason}</div></li>)}</ol>
          </Card>
        )}
      </div>
      <ReasonDialog open={!!flag} onClose={() => setFlag(null)} title={flag?.action === 'keep' ? `Keep line ${flag.line_no}` : `Remove line ${flag?.line_no}`} variant={flag?.action === 'remove' ? 'danger' : 'primary'} confirmLabel={flag?.action === 'keep' ? 'Keep line' : 'Remove line'} sub="The PR line was cancelled or closed in SAP while in this RFQ." onSubmit={(x) => resolve.run(x)} />
    </div>
  );
}

function QuotesTab({ r }: { r: RfqDetail }) {
  if (r.sealed_now || !r.quotations) {
    return (
      <Card>
        <Empty title="Quotations are sealed until the RFQ closes" icon={<Lock size={24} />}>
          {r.counts.responded} of {r.counts.sent} invited vendors have responded. Prices, quotation documents and version history appear for buyers and approvers after {fmtDateTime(r.closing_at)} (FR-RFQ-12 <DecisionTag id="Q 18.1" />).
        </Empty>
      </Card>
    );
  }
  if (!r.quotations.length) return <Card><Empty title="No quotations received" icon={<FileX2 size={24} />}>Extend the closing date, re-float the RFQ, or record an exception.</Empty></Card>;
  const lines = r.lines.filter((l) => l.status !== 'Removed');
  return (
    <div className="stack">
      {r.comparison_link && <Callout tone="ok" title="Quotations are locked">Landed cost, LPP variance and the award recommendation are in the comparative statement. <ButtonLink size="sm" variant="deep" to={r.comparison_link} icon={<Scale size={14} />}>Open comparison</ButtonLink></Callout>}
      {r.quotations.map((q) => <QuoteCard key={q.id} q={q} lines={lines} />)}
    </div>
  );
}

function QuoteCard({ q, lines }: { q: BuyerQuote; lines: RfqDetail['lines'] }) {
  const [hist, setHist] = useState(false);
  const total = q.lines.reduce((s, l) => s + (lineValue(l, lines.find((x) => x.id === l.rfq_line_id)?.qty ?? 0)?.withGst ?? 0), 0);
  return (
    <Card title={<div className="row-wrap"><h2>{q.vendor_name}</h2><span className="mono small subtle">{q.sap_code}</span><Status value={q.status} /><span className="small muted">v{q.version} · {q.ref_no} · {fmtDateTime(q.submitted_at)}</span></div>}
      actions={q.version > 1 || q.versions.length ? <Button size="sm" onClick={() => setHist(!hist)}>{hist ? 'Hide' : 'Show'} version history ({q.versions.length})</Button> : undefined} flush>
      {q.status === 'Declined' ? <div style={{ padding: 16 }}><Callout tone="warn">This vendor declined the RFQ.</Callout></div> : (
        <>
          <div className="tbl-wrap">
            <table className="tbl tbl--dense">
              <thead><tr><th>Line</th><th className="num">Qty</th><th className="num">Basic</th><th className="num">Disc %</th><th className="num">GST</th><th className="num">Freight</th><th className="num">Packing</th><th className="num">Days</th><th>Make / brand</th><th>Warranty</th><th>Flags</th><th className="num">Line total</th></tr></thead>
              <tbody>
                {q.lines.map((l) => {
                  const rl = lines.find((x) => x.id === l.rfq_line_id);
                  const v = rl ? lineValue(l, rl.qty) : null;
                  return (
                    <tr key={l.rfq_line_id}>
                      <td className="mono">{rl?.line_no}</td>
                      <td className="num nowrap">{l.no_quote ? '—' : `${fmtNum(l.quoted_qty)}${l.partial && rl ? ` of ${fmtNum(rl.qty)}` : ''}`}</td>
                      {l.no_quote ? <td colSpan={9} className="muted">Not quoted</td> : (
                        <>
                          <td className="num">{money(l.basic_price)}</td><td className="num">{l.discount_pct ?? 0}</td><td className="num">{l.gst_rate}%</td><td className="num">{money(l.freight)}</td><td className="num">{money(l.packing)}</td>
                          <td className="num">{l.delivery_days}</td><td>{l.make_brand ?? '—'}</td><td>{l.warranty ?? '—'}</td>
                          <td className="nowrap">{l.alternate && <Badge tone="warn">Alternate</Badge>} {l.partial && <Badge tone="warn">Partial {fmtNum(l.quoted_qty)}/{rl ? fmtNum(rl.qty) : ''}</Badge>}</td>
                        </>
                      )}
                      <td className="num nowrap">{v ? money(v.withGst) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr><td colSpan={11} className="right small muted">Total including GST (indicative; landed cost is in the comparison)</td><td className="num"><strong>{money(total)}</strong></td></tr></tfoot>
            </table>
          </div>
          <div style={{ padding: 16 }} className="stack-sm">
            <KV cols items={[['Delivery terms', q.header?.delivery_terms], ['Payment terms', `${q.header?.payment_terms ?? '—'}${q.header?.credit_days != null ? ` (${q.header.credit_days} days)` : ''}`], ['Valid until', fmtDate(q.header?.validity_date)], ['Remarks', q.header?.remarks]]} />
            {q.lines.some((l) => l.remarks) && <div className="small muted">Line remarks: {q.lines.filter((l) => l.remarks).map((l) => `${lines.find((x) => x.id === l.rfq_line_id)?.line_no}: ${l.remarks}`).join(' · ')}</div>}
            <h3>Documents</h3>
            {q.documents.length ? <ul className="list-plain small">{q.documents.map((d) => <li key={d.id} className="row"><span className="grow">{d.label ? `${d.label} — ` : ''}{d.filename}</span>{d.scan_status === 'Available' && <a className="btn btn--ghost btn--sm" href={`/api/files/${d.id}/download`}><Download size={14} /> Download</a>}</li>)}</ul> : <p className="small muted">No documents uploaded.</p>}
            {hist && (
              <>
                <h3>Version history</h3>
                <ol className="timeline">
                  {q.versions.map((v) => (
                    <li key={v.version}><span className="timeline__dot" data-tone={v.version > 1 ? 'warn' : 'ok'} /><div className="timeline__title">Version {v.version} · {v.ref_no}</div><div className="timeline__meta">{fmtDateTime(v.created_at)} · {v.note}</div>
                      {v.changes.length > 0 && <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 16 }}>{(v.changes as { line: number | null; label: string; from: unknown; to: unknown }[]).map((c, i) => <li key={i}>{c.line ? `Line ${c.line} ` : 'Header '}{c.label}: <s className="subtle">{String(c.from ?? '—')}</s> → {String(c.to ?? '—')}</li>)}</ul>}</li>
                  ))}
                </ol>
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function ApprovalsTab({ r }: { r: RfqDetail }) {
  return (
    <div className="split">
      <Card title="Approval requests" flush>
        {r.approvals.length === 0 ? <Empty title="No approvals on this RFQ">Limited-source RFQs, non-suggested vendors (when configured) and reopen requests appear here.</Empty> : (
          <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Request</th><th>Type</th><th>Status</th><th>Raised</th></tr></thead><tbody>
            {r.approvals.map((a) => <tr key={a.id}><td><Ref to={`/approvals/${a.id}`}>{a.req_no}</Ref><div className="small muted">{a.title}</div></td><td className="small">{a.type}</td><td><Status value={a.status} />{a.outcome && <div className="small muted">{a.outcome}</div>}</td><td className="small nowrap">{fmtDateTime(a.created_at)}</td></tr>)}
          </tbody></table></div>
        )}
      </Card>
      <Card title="Reopen requests">
        {r.reopens.length === 0 ? <p className="small muted">No reopen requested. After closing, locked quotations change only through an approved reopen (FR-QTN-05).</p> : (
          <ol className="timeline">{r.reopens.map((x) => <li key={x.id}><span className="timeline__dot" data-tone="decision" /><div className="timeline__title">{x.vendors.join(', ')} <Status value={x.status} /></div><div className="timeline__meta">{x.requested_by_name} · until {fmtDateTime(x.reopen_until)}</div><div className="timeline__body">{x.reason}</div></li>)}</ol>
        )}
      </Card>
    </div>
  );
}

function RemindDialog({ r, open, onClose }: { r: RfqDetail; open: boolean; onClose: () => void }) {
  const [msg, setMsg] = useState('');
  const waiting = r.invitations.filter((i) => i.sent_at && ['Invited', 'Viewed'].includes(i.status));
  const act = useAction(() => api.post<{ reminded: number }>(`/rfq/rfqs/${r.id}/remind`, { message: msg || null }), { success: (x) => `Reminder sent to ${plural(x.reminded, 'vendor')}`, invalidate: inv, onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title="Remind vendors" sub="Only vendors who have not responded or declined are reminded (NTF-05)."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" icon={<Send />} loading={act.busy} disabled={!waiting.length} onClick={act.fire}>Send reminder</Button></>}>
      <div className="stack">
        {waiting.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{waiting.map((i) => <li key={i.id}>{i.vendor_name} — {i.status}{i.reminders_sent ? `, ${i.reminders_sent} earlier` : ''}</li>)}</ul> : <Callout tone="info">Every invited vendor has responded or declined.</Callout>}
        <Field label="Message (optional)"><Textarea rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

function ExtendDialog({ r, open, onClose }: { r: RfqDetail; open: boolean; onClose: () => void }) {
  const [at, setAt] = useState('');
  const [reason, setReason] = useState('');
  const act = useAction(() => api.post(`/rfq/rfqs/${r.id}/extend`, { closing_at: fromLocalInput(at), reason }), { success: `RFQ ${r.rfq_no} extended; vendors notified`, invalidate: inv, onSuccess: () => { onClose(); setReason(''); }, silentError: true });
  const suggested = toLocalInput(new Date(Math.max(Date.now(), new Date(r.closing_at).getTime()) + 2 * 86400000).toISOString());
  return (
    <Modal open={open} onClose={onClose} title="Extend closing date" sub={`Currently ${fmtDateTime(r.closing_at)}. Vendors are notified (NTF-06) and reminders restart.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={act.busy} disabled={!at || reason.trim().length < 10} onClick={act.fire}>Extend RFQ</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="New closing date and time" required error={fieldError(act.error, 'closing_at')}><Input type="datetime-local" value={at || suggested} onFocus={() => !at && setAt(suggested)} onChange={(e) => setAt(e.target.value)} /></Field>
        <Field label="Reason for extension" required hint="At least 10 characters. Recorded in the audit trail and visible in the extension history." error={fieldError(act.error, 'reason')}><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

function ReopenDialog({ r, open, onClose }: { r: RfqDetail; open: boolean; onClose: () => void }) {
  const [sel, setSel] = useState<number[]>([]);
  const [until, setUntil] = useState(toLocalInput(new Date(Date.now() + 2 * 86400000).toISOString()));
  const [reason, setReason] = useState('');
  const act = useAction(() => api.post(`/rfq/rfqs/${r.id}/reopen`, { vendor_ids: sel, reason, reopen_until: fromLocalInput(until) }), { success: 'Reopen requested; waiting for approval', invalidate: inv, onSuccess: () => { onClose(); setReason(''); setSel([]); }, silentError: true });
  const eligible = r.invitations.filter((i) => i.sent_at && i.status !== 'Declined');
  return (
    <Modal open={open} onClose={onClose} title="Request reopen of locked quotations" sub="Needs a reason and approval (QTN-05, GOV-C03). Chosen vendors can revise until the window ends; then quotations lock again."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="decision" loading={act.busy} disabled={!sel.length || reason.trim().length < 10 || !until} onClick={act.fire}>Send for approval</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="Vendors" required error={fieldError(act.error, 'vendor_ids')}>
          <div className="stack-sm">{eligible.map((i) => <Checkbox key={i.id} checked={sel.includes(i.vendor_id)} onChange={() => setSel((s) => (s.includes(i.vendor_id) ? s.filter((x) => x !== i.vendor_id) : [...s, i.vendor_id]))} label={`${i.vendor_name} — ${i.status}`} />)}</div>
        </Field>
        <Field label="Revisions allowed until" required error={fieldError(act.error, 'reopen_until')}><Input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
        <Field label="Reason" required hint="At least 10 characters." error={fieldError(act.error, 'reason')}><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}
