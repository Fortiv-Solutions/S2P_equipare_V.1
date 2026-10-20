import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, PauseCircle, PlayCircle, XCircle, UserPlus, Route as RouteIcon, FileSignature, Boxes, PackageSearch, Warehouse, Handshake, Printer } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth, useMeta } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { ago, fmtDate, fmtDateTime, fmtLakh, fmtMoney } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, DecisionTag, Freshness, KV, Loader, PageHeader, Priority, Ref, SimBadge, Status, Tabs } from '@/components/ui';
import { Field, Select, Textarea, Checkbox, ErrorSummary } from '@/components/forms';
import { Modal, ReasonDialog } from '@/components/overlay';
import { TrackChain, prLineChain } from '@/components/TrackChain';
import { ThreadView } from '@/components/Thread';
import { AuditTrail } from '@/components/AuditTrail';
import type { Checks, PrLine } from './types';

interface Detail extends PrLine {
  buyer_email: string | null;
  material: { code: string; description: string; uom: string; gst_rate: number; hsn: string; lpp: number | null; lpp_date: string | null; brand: string | null } | null;
  decisions: { id: number; proposed: string; decided: string; override: number; reason: string | null; decided_by_name: string; decided_at: string; approval_id: number | null }[];
  approvals: { id: number; req_no: string; type: string; status: string; title: string; created_at: string }[];
  rfq: { id: number; rfq_no: string; title: string; status: string; closing_at: string } | null;
  po_lines: { po_id: number; po_no: string; item: number; qty: number; ack_status: string; commit_date: string | null; delivery_date: string; received_qty: number; status: string; vendor: string; delay_reason: string | null; po_date: string }[];
  asns: { id: number; asn_no: string; status: string; expected_date: string }[];
  comments: { id: number; body: string; created_at: string; user_id: number; user_name: string }[];
  stock: { unrestricted: number; open_po_qty: number; vmi: number; synced_at: string } | null;
  contract: { id: number; contract_no: string; type: string; sap_oa_no: string; valid_to: string; vendor: string } | null;
  freshness: Record<string, { stale: boolean; thresholdMinutes: number }>;
}

const ROUTES = ['ARC/OA', 'VMI', 'FDS', 'Fixed supplier', 'RFQ', 'Urgent/BD', 'Class 1', 'Capex', 'Service', 'Exception'];
const CONTRACT_ROUTES = ['ARC/OA', 'VMI', 'FDS', 'Fixed supplier'];

export default function PrLinePage() {
  const id = Number(useParams().id);
  const q = useQuery<Detail>({ queryKey: ['pr', 'line', id], queryFn: () => api.get(`/pr/lines/${id}`) });
  return <Loader q={q} rows={10}>{(l) => <LineView l={l} />}</Loader>;
}

function LineView({ l }: { l: Detail }) {
  const { can, me } = useAuth();
  const [tab, setTab] = useState<'work' | 'thread' | 'audit'>('work');
  const [dialog, setDialog] = useState<'hold' | 'close' | 'assign' | null>(null);
  const inv = [['pr']];
  const mine = l.buyer_id === me?.id || can('pr.assign');
  const canWork = can('pr.work') && mine;
  const checks = useAction(() => api.post(`/pr/lines/${l.id}/checks`), { success: 'Checks complete', invalidate: inv });
  const hold = useAction((reason: string) => api.post(`/pr/lines/${l.id}/hold`, { reason }), { success: 'Line put on hold', invalidate: inv });
  const release = useAction(() => api.post(`/pr/lines/${l.id}/release`), { success: 'Line released from hold', invalidate: inv });
  const close = useAction((reason: string) => api.post(`/pr/lines/${l.id}/close`, { reason }), { success: 'Line closed', invalidate: inv });
  const clarify = useAction((body: string) => api.post(`/pr/lines/${l.id}/clarify`, { body }), { success: 'Message sent', invalidate: inv });
  const open = !['PO created', 'Closed', 'Cancelled in SAP'].includes(l.status);
  const po = l.po_lines[0];

  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/pr">PR workbench</Link><span>/</span><span className="mono">{l.ref}</span></>} screen="SCR-PRW-02"
        title={l.description}
        badges={<><Status value={l.status} /><Priority value={l.priority} />{l.repeat_flag ? <Badge tone="warn">Repeat purchase</Badge> : null}</>}
        sub={<>PR <span className="mono">{l.ref}</span> · {l.qty} {l.uom} for {l.plant} by {fmtDate(l.required_date)} · raised by {l.requisitioner_name ?? '—'} ({l.department ?? '—'})</>}
        actions={canWork && open ? (
          <>
            {l.status === 'On hold' ? <Button icon={<PlayCircle />} loading={release.busy} onClick={release.fire}>Release hold</Button> : <Button icon={<PauseCircle />} onClick={() => setDialog('hold')}>Put on hold</Button>}
            <Button variant="danger" icon={<XCircle />} onClick={() => setDialog('close')}>Close line</Button>
            {can('pr.assign') && <Button icon={<UserPlus />} onClick={() => setDialog('assign')}>{l.buyer_id ? 'Reassign' : 'Assign buyer'}</Button>}
          </>
        ) : can('pr.assign') && open ? <Button icon={<UserPlus />} onClick={() => setDialog('assign')}>{l.buyer_id ? 'Reassign' : 'Assign buyer'}</Button> : undefined}
      />

      <Card className="no-print" title={<div className="row-wrap"><h2>Lifecycle</h2>{l.sla_due && <span className={`small ${l.sla_breached ? '' : 'muted'}`} style={{ color: l.sla_breached ? 'var(--bad)' : undefined, fontWeight: l.sla_breached ? 700 : 500 }}>{l.priority} SLA {l.sla_breached ? 'breached' : 'due'} {fmtDateTime(l.sla_due)}</span>}</div>}>
        <TrackChain steps={prLineChain({ ...l, ack_status: po?.ack_status, asn_status: l.asns[0]?.status, received_qty: po?.received_qty })} />
        {l.flag && <div style={{ marginTop: 12 }}><Callout tone="bad" title="Buyer action needed">{l.flag}</Callout></div>}
        {l.status === 'On hold' && l.hold_reason && <div style={{ marginTop: 12 }}><Callout tone="warn" title="On hold">{l.hold_reason.split('|')[1]}</Callout></div>}
        {l.status === 'Cancelled in SAP' && <div style={{ marginTop: 12 }}><Callout tone="bad" title="Cancelled in SAP">This line was deleted or closed in SAP. No further procurement action is possible here.</Callout></div>}
      </Card>

      <div style={{ height: 16 }} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'work', label: 'Checks & route' }, { id: 'thread', label: 'Clarifications', count: l.comments.length }, { id: 'audit', label: 'Audit history' }]} />

      {tab === 'work' && (
        <div className="split">
          <div className="stack">
            <ChecksCard l={l} canWork={canWork && open} onRun={checks.fire} running={checks.busy} />
            {canWork && ['Under review', 'Route decided', 'Assigned', 'Clarification pending'].includes(l.status) && l.checks && <RouteCard l={l} />}
            {l.route && CONTRACT_ROUTES.includes(l.route) && ['Contract/VMI PO pending', 'PO created'].includes(l.status) && <PoReferenceCard id={l.id} />}
            {l.status === 'Route decided' && can('rfq.manage') && (
              <Callout tone="ok" title={`Route ${l.route} confirmed`}>
                Add this line to an RFQ basket. <ButtonLink to={`/rfqs/new?lines=${l.id}`} size="sm" variant="primary">Create RFQ with this line</ButtonLink>{' '}
                <ButtonLink to={`/pr?view=mine&status=Route+decided`} size="sm">Pick more lines</ButtonLink>
              </Callout>
            )}
            {(l.rfq || l.po_lines.length > 0) && (
              <Card title="Downstream documents">
                <div className="stack">
                  {l.rfq && <KV items={[['RFQ', <Ref to={`/rfqs/${l.rfq.id}`}>{l.rfq.rfq_no}</Ref>], ['RFQ status', <Status value={l.rfq.status} />], ['Closing', fmtDateTime(l.rfq.closing_at)]]} />}
                  {l.po_lines.map((p) => (
                    <KV key={`${p.po_no}-${p.item}`} items={[['PO', <Ref to={`/pos/${p.po_id}`}>{`${p.po_no}/${p.item}`}</Ref>], ['Vendor', p.vendor], ['Acknowledgement', <Status value={p.ack_status} />], ['Commitment', p.commit_date ? fmtDate(p.commit_date) : `PO date ${fmtDate(p.delivery_date)}`], ['Received', `${p.received_qty} of ${p.qty}`], ['Delay reason', p.delay_reason]]} />
                  ))}
                  {l.asns.map((a) => <KV key={a.id} items={[['ASN', <Ref to={`/asns/${a.id}`}>{a.asn_no}</Ref>], ['Status', <Status value={a.status} />], ['Expected', fmtDate(a.expected_date)]]} />)}
                </div>
              </Card>
            )}
          </div>
          <div className="stack">
            <Card title="Requirement from SAP" actions={<Freshness flow="INT-M03" label="PR" />}>
              <KV items={[
                ['PR / item', <span className="mono">{l.ref}</span>], ['Material', <span className="mono">{l.material_code}</span>], ['Material group', l.material_group], ['Spend category', l.category],
                ['Quantity', `${l.qty} ${l.uom}`], ['Plant', l.plant], ['Required date', fmtDate(l.required_date)], ['Priority', <Priority value={l.priority} />],
                ['Estimated value', fmtLakh(l.est_value)], ['Capex / service', [l.is_capex ? 'Capex' : null, l.is_service ? 'Service' : null].filter(Boolean).join(', ') || 'No'],
                ['SAP status', l.sap_status], ['Arrived in platform', fmtDateTime(l.available_at)],
              ]} />
            </Card>
            <Card title="Ownership">
              <KV items={[['Buyer', l.buyer_name ?? <Status value="Unassigned" />], ['Requisitioner', l.requisitioner_name], ['Age', `${l.age_days} days`], ['Current route', l.route ?? '—']]} />
            </Card>
            {l.material && (
              <Card title="Price history">
                <KV items={[['Last purchase price', l.material.lpp ? fmtMoney(l.material.lpp) : 'No history'], ['LPP date', fmtDate(l.material.lpp_date)], ['GST / HSN', `${l.material.gst_rate}% · ${l.material.hsn}`], ['Brand', l.material.brand]]} />
                {l.repeat_info && <p className="small muted" style={{ marginTop: 10 }}>Bought {l.repeat_info.count} times in {l.repeat_info.lookback_days} days without a contract ({fmtLakh(l.repeat_info.value)}, {l.repeat_info.vendors} vendors). <DecisionTag id="DEC-09" /></p>}
              </Card>
            )}
            {(l.approvals.length > 0 || l.decisions.length > 0) && (
              <Card title="Route decisions & approvals">
                <ol className="timeline">
                  {l.approvals.map((a) => (
                    <li key={`a${a.id}`}><span className="timeline__dot" data-tone="decision" /><div className="timeline__title"><Ref to={`/approvals/${a.id}`}>{a.req_no}</Ref> <Status value={a.status} /></div><div className="timeline__meta">{a.title}</div></li>
                  ))}
                  {l.decisions.map((d) => (
                    <li key={d.id}><span className="timeline__dot" data-tone={d.override ? 'warn' : 'ok'} /><div className="timeline__title">{d.override ? `Override: ${d.proposed} → ${d.decided}` : `Confirmed ${d.decided}`}</div><div className="timeline__meta">{d.decided_by_name} · {fmtDateTime(d.decided_at)}</div>{d.reason && <div className="timeline__body">{d.reason}</div>}</li>
                  ))}
                </ol>
              </Card>
            )}
          </div>
        </div>
      )}
      {tab === 'thread' && (
        <Card title="Clarifications with the requisitioner">
          <ThreadView messages={l.comments} onSend={can('pr.clarify') ? (b) => clarify.run(b) : undefined} placeholder="Ask the requisitioner about specification, quantity or date…" note="Asking a question marks the line Clarification pending until the requisitioner replies." />
        </Card>
      )}
      {tab === 'audit' && <Card title="Audit history"><AuditTrail objectType="pr_line" objectId={l.id} /></Card>}

      <ReasonDialog open={dialog === 'hold'} onClose={() => setDialog(null)} title="Put this line on hold" confirmLabel="Put on hold" onSubmit={(r) => hold.run(r)} />
      <ReasonDialog open={dialog === 'close'} onClose={() => setDialog(null)} title="Close this PR line" variant="danger" confirmLabel="Close line" sub="Use when stock covers the need or the requirement is no longer valid. Close the PR in SAP as well." onSubmit={(r) => close.run(r)} />
      <AssignOne l={l} open={dialog === 'assign'} onClose={() => setDialog(null)} />
    </>
  );
}

function CheckRow({ icon, label, result, tone, detail }: { icon: React.ReactNode; label: string; result: React.ReactNode; tone: 'ok' | 'warn' | 'neutral' | 'info'; detail?: React.ReactNode }) {
  return (
    <div className="row" style={{ alignItems: 'flex-start', padding: '12px 0', borderBottom: '1px solid var(--steel-100)' }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: tone === 'ok' ? 'var(--ok-bg)' : tone === 'warn' ? 'var(--warn-bg)' : tone === 'info' ? 'var(--info-bg)' : 'var(--steel-100)', color: tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'info' ? 'var(--info)' : 'var(--steel-600)', flex: 'none' }}>{icon}</span>
      <div className="grow">
        <div className="row between"><strong>{label}</strong><span>{result}</span></div>
        {detail && <div className="small muted" style={{ marginTop: 2 }}>{detail}</div>}
      </div>
    </div>
  );
}

function ChecksCard({ l, canWork, onRun, running }: { l: Detail; canWork: boolean; onRun: () => void; running: boolean }) {
  const c: Checks | null = l.checks;
  return (
    <Card
      title={<div className="row-wrap"><h2>Pre-RFQ checks</h2>{c && <span className="small muted">Ran {ago(c.ran_at)}</span>}<Freshness flow="INT-M04" label="Stock" /></div>}
      actions={canWork && <Button size="sm" variant={c ? 'secondary' : 'primary'} icon={<ClipboardCheck />} loading={running} onClick={onRun}>{c ? 'Run checks again' : 'Run checks'}</Button>}
    >
      {!c ? (
        <Callout tone="info" title="Checks have not run">Stock, open PO, VMI and contract checks must run before the line can be routed or added to an RFQ (PR-04).</Callout>
      ) : (
        <>
          {c.sap_unavailable && <Callout tone="bad" title="SAP was unavailable when checks ran">Results use the last synchronised data. Routing now needs Procurement Manager approval.</Callout>}
          {c.stale && !c.sap_unavailable && <Callout tone="warn" title="SAP data is older than its freshness threshold">You will be asked to confirm you reviewed it before routing.</Callout>}
          <CheckRow icon={<Warehouse size={18} />} label="Available stock" tone={c.stock.covers ? 'warn' : 'neutral'} result={<span className="num">{c.stock.unrestricted} {l.uom}</span>} detail={c.stock.covers ? 'Stock covers the requirement — consider closing the line.' : `Required ${l.qty} ${l.uom} at ${l.plant}.`} />
          <CheckRow icon={<PackageSearch size={18} />} label="Open PO quantity" tone={c.open_po.qty > 0 ? 'warn' : 'neutral'} result={<span className="num">{c.open_po.qty} {l.uom}</span>} detail={c.open_po.lines.length ? c.open_po.lines.map((x) => `${x.po_no}/${x.item}: ${x.open} open`).join(' · ') : 'No other open PO lines for this material at this plant.'} />
          <CheckRow icon={<Boxes size={18} />} label="VMI arrangement" tone={c.vmi.active ? 'ok' : 'neutral'} result={c.vmi.active ? <Badge tone="ok">Active</Badge> : <Badge>None</Badge>} detail={c.vmi.contract_no ? `Covered by ${c.vmi.contract_no}` : undefined} />
          <CheckRow icon={<FileSignature size={18} />} label="Valid ARC / OA / FDS / fixed supplier" tone={c.contract?.valid ? 'ok' : 'neutral'}
            result={c.contract?.valid ? <Badge tone="ok">{c.contract.type} found</Badge> : <Badge>None</Badge>}
            detail={c.contract?.valid ? <>{c.contract.contract_no} · SAP OA <span className="mono">{c.contract.sap_oa_no}</span> · {c.contract.vendor} · {c.contract.unit_price ? fmtMoney(c.contract.unit_price) : ''}{c.contract.discount_pct ? ` (${c.contract.discount_pct}% off list)` : ''} · valid to {fmtDate(c.contract.valid_to)}</> : 'No valid contract covers this material for this plant.'} />
          <div className="row" style={{ marginTop: 14, gap: 10, alignItems: 'flex-start' }}>
            <RouteIcon size={18} color="var(--berry-600)" aria-hidden style={{ marginTop: 2 }} />
            <div><strong>Proposed route: {c.proposed}</strong><div className="small muted">{c.proposal_note}</div></div>
          </div>
        </>
      )}
    </Card>
  );
}

function RouteCard({ l }: { l: Detail }) {
  const [route, setRoute] = useState(l.route ?? l.checks?.proposed ?? 'RFQ');
  const [reason, setReason] = useState('');
  const [ackStale, setAckStale] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const act = useAction(() => api.post(`/pr/lines/${l.id}/route`, { route, reason: reason || undefined, acknowledge_stale: ackStale || undefined }), {
    success: (r: any) => (r.status === 'Exception pending approval' ? 'Route sent for exception approval' : `Route ${route} confirmed`), invalidate: [['pr']], silentError: true,
  });
  const override = route !== l.route_proposed;
  const c = l.checks!;
  const offContract = !!c.contract?.valid && !CONTRACT_ROUTES.includes(route);
  const eligible = (r: string) => !CONTRACT_ROUTES.includes(r) || (c.contract?.valid && ((c.contract.type === 'ARC' || c.contract.type === 'OA') ? 'ARC/OA' : c.contract.type) === r);
  const needsReason = override || route === 'Exception';
  const staleNeeded = c.stale && !c.sap_unavailable;
  const submit = () => (offContract && !confirmOff ? setConfirmOff(true) : act.fire());
  const err = act.error instanceof ApiError ? act.error : null;
  return (
    <Card title="Route decision" actions={<span className="small muted">Proposed by rules · <DecisionTag id="RSK-14" /></span>}>
      <div className="stack">
        {err && <ErrorSummary error={err} />}
        <Field label="Procurement route" required hint={override ? `Overrides the proposed route (${l.route_proposed}). A reason is required.` : 'Matches the proposal.'}>
          <Select value={route} onChange={(e) => setRoute(e.target.value)} options={ROUTES.map((r) => ({ value: r, label: `${r}${r === l.route_proposed ? ' — proposed' : ''}${eligible(r) ? '' : ' (no valid arrangement)'}` }))} />
        </Field>
        {offContract && <Callout tone="warn" title="Off-contract purchase">{c.contract!.contract_no} with {c.contract!.vendor} covers this material. Routing away from it needs a reason and Procurement Manager approval (APP-04, CON-03).</Callout>}
        {needsReason && <Field label="Reason" required hint="At least 10 characters. Recorded in the audit trail."><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>}
        {staleNeeded && <Checkbox label="I have reviewed the stale SAP stock / contract data shown above" checked={ackStale} onChange={(e) => setAckStale(e.target.checked)} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="primary" icon={<Handshake />} loading={act.busy} disabled={!eligible(route) || (needsReason && reason.trim().length < 10) || (staleNeeded && !ackStale)} onClick={submit}>
            {offContract || route === 'Exception' || c.sap_unavailable ? 'Submit for approval' : `Confirm ${route}`}
          </Button>
        </div>
      </div>
      <Modal open={confirmOff} onClose={() => setConfirmOff(false)} title="Send off-contract route for approval?" footer={<><Button onClick={() => setConfirmOff(false)}>Cancel</Button><Button variant="decision" loading={act.busy} onClick={async () => { await act.fire(); setConfirmOff(false); }}>Submit for approval</Button></>}>
        <p>The line waits in <strong>Exception pending approval</strong> until the Procurement Manager decides. The exception is logged in the exception register.</p>
      </Modal>
    </Card>
  );
}

function PoReferenceCard({ id }: { id: number }) {
  const q = useQuery<any>({ queryKey: ['pr', 'po-ref', id], queryFn: () => api.get(`/pr/lines/${id}/po-reference`) });
  const { can } = useAuth();
  return (
    <Card title="PO creation reference" actions={<Button size="sm" variant="ghost" icon={<Printer />} onClick={() => window.print()}>Print</Button>}>
      <Loader q={q}>{(r) => (
        <div className="stack">
          <Callout tone={r.valid ? 'ok' : 'bad'}>{r.message}</Callout>
          <KV cols items={[['Contract', r.contract_no], ['Type', r.contract_type], ['SAP OA', <span className="mono">{r.sap_oa_no}</span>], ['Vendor', `${r.vendor} (${r.vendor_sap_code})`], ['Material', <span className="mono">{r.material_code}</span>], ['Quantity', `${r.qty} ${r.uom}`], ['Unit price', fmtMoney(r.unit_price)], ['Discount', r.discount_pct ? `${r.discount_pct}%` : '—'], ['Validity', `${fmtDate(r.valid_from)} – ${fmtDate(r.valid_to)}`], ['Payment terms', r.payment_terms], ['Delivery terms', r.delivery_terms], ['Plant / required', `${r.plant} · ${fmtDate(r.required_date)}`]]} />
          {can('sapsim.po') && r.valid && (
            <div className="sim-panel row-wrap between">
              <span className="small"><SimBadge>SAP simulator</SimBadge> The buyer creates this PO in SAP. In this MVP the SAP simulator stands in for that step.</span>
              <ButtonLink to={`/sap-simulator?action=po&pr_line=${id}`} size="sm" variant="deep">Create PO in SAP simulator</ButtonLink>
            </div>
          )}
        </div>
      )}</Loader>
    </Card>
  );
}

function AssignOne({ l, open, onClose }: { l: Detail; open: boolean; onClose: () => void }) {
  const buyers = useQuery<{ id: number; name: string; categories: string | null }[]>({ queryKey: ['pr', 'buyers'], queryFn: () => api.get('/pr/buyers'), enabled: open });
  const [buyer, setBuyer] = useState('');
  const [reason, setReason] = useState('');
  const act = useAction(() => api.post(`/pr/lines/${l.id}/assign`, { buyer_id: Number(buyer), reason: reason || undefined }), { success: 'Buyer assigned', invalidate: [['pr']], onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title={l.buyer_id ? 'Reassign buyer' : 'Assign buyer'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={act.busy} disabled={!buyer || (!!l.buyer_id && reason.trim().length < 10)} onClick={act.fire}>Assign</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="Buyer" required><Select value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="Choose a buyer" options={(buyers.data ?? []).filter((b) => b.id !== l.buyer_id).map((b) => ({ value: b.id, label: `${b.name}${b.categories?.split(',').includes(l.category ?? '') ? ' — covers this category' : ''}` }))} /></Field>
        {l.buyer_id && <Field label="Reason" required hint="At least 10 characters."><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      </div>
    </Modal>
  );
}
