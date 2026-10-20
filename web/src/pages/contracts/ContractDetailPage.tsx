import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Send, FilePen, ListPlus, Boxes, Trash2, ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtLakh, fmtMoney, fmtNum, ago } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, DecisionTag, Empty, Freshness, KV, Loader, PageHeader, Ref, SimBadge, Status, Tabs } from '@/components/ui';
import { Field, Input, Select, Textarea, Checkbox, ErrorSummary } from '@/components/forms';
import { Modal, ReasonDialog } from '@/components/overlay';
import { TrackChain, chainFrom } from '@/components/TrackChain';
import { AttachmentList } from '@/components/Attachments';
import { AuditTrail } from '@/components/AuditTrail';
import { DataTable } from '@/components/DataTable';
import { RenewalActions, UtilBar } from './shared';
import { KIND_LABEL, TYPE_LABEL, type ContractDetail } from './types';

type Tab = 'overview' | 'prices' | 'vmi' | 'documents' | 'pos' | 'changes' | 'history';

export default function ContractDetailPage() {
  const id = Number(useParams().id);
  const q = useQuery<ContractDetail>({ queryKey: ['contracts', 'detail', id], queryFn: () => api.get(`/contracts/${id}`) });
  return <Loader q={q} rows={10}>{(c) => <View c={c} />}</Loader>;
}

function lifecycle(c: ContractDetail) {
  const labels = ['Draft', 'Approval', 'Pending SAP', 'Active', 'Expiring', c.status === 'Renewed' ? 'Renewed' : c.status === 'Terminated' ? 'Terminated' : 'Expired'];
  const idx: Record<string, number> = { Draft: 0, 'Pending approval': 1, 'Pending SAP': 2, Active: 3, Expiring: 4, Expired: 6, Renewed: 6, Terminated: 6 };
  const cur = idx[c.status] ?? 0;
  return chainFrom(labels, cur, {
    blockedAt: c.status === 'Terminated' ? 5 : undefined,
    skipped: !c.created_by ? [0, 1] : [],
    subs: { 0: !c.created_by ? 'From SAP' : undefined, 2: c.sap_oa_no ? <span className="mono">{c.sap_oa_no}</span> : undefined, 3: fmtDate(c.valid_from), 5: fmtDate(c.valid_to) },
  });
}

function View({ c }: { c: ContractDetail }) {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'overview';
  const setTab = (t: Tab) => { sp.set('tab', t); setSp(sp, { replace: true }); };
  const [dlg, setDlg] = useState<'change' | 'pricelist' | 'vmi' | 'discard' | null>(null);
  const manage = can('con.manage');
  const inForce = ['Active', 'Expiring'].includes(c.status);
  const submit = useAction(() => api.post(`/contracts/${c.id}/submit`, {}), { success: `${c.contract_no} sent for approval`, invalidate: [['contracts']] });
  const discard = useAction((reason: string) => api.post(`/contracts/${c.id}/terminate`, { reason }), { success: `Draft ${c.contract_no} discarded`, invalidate: [['contracts']] });
  const sim = can('sapsim.all', 'sapsim.po');
  const showPrices = c.type === 'FDS' || c.price_lists.length > 0;

  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/contracts">Contracts</Link><span>/</span><span className="mono">{c.contract_no}</span></>} screen="SCR-CON-02"
        title={c.title ?? c.contract_no}
        badges={<><Status value={c.status} /><Badge tone="deep">{c.type}</Badge>{c.routable ? <Badge tone="ok">Routable</Badge> : <Badge tone="warn" title={c.reason}>Not routable</Badge>}</>}
        sub={<>{TYPE_LABEL[c.type] ?? c.type} with <strong>{c.vendor.name}</strong> ({c.vendor.sap_code ?? 'no SAP code'}) · {c.sap_oa_no ? <>SAP OA <span className="mono">{c.sap_oa_no}</span></> : 'no SAP OA yet'} · valid {fmtDate(c.valid_from)} – {fmtDate(c.valid_to)}</>}
        actions={manage ? (
          <>
            {c.status === 'Draft' && <ButtonLink to={`/contracts/${c.id}/edit`} icon={<Pencil size={16} />}>Edit draft</ButtonLink>}
            {c.status === 'Draft' && <Button variant="ghost" icon={<Trash2 />} onClick={() => setDlg('discard')}>Discard draft</Button>}
            {c.status === 'Draft' && <Button variant="primary" icon={<Send />} loading={submit.busy} onClick={submit.fire}>Send for approval</Button>}
            {inForce && !c.pending_change && <Button icon={<FilePen />} onClick={() => setDlg('change')}>Change terms</Button>}
            {(inForce || c.status === 'Expired') && <RenewalActions c={c} size="md" />}
          </>
        ) : undefined}
      />

      <Card>
        <TrackChain steps={lifecycle(c)} label="Contract lifecycle" />
        <div className="stack-sm" style={{ marginTop: 12 }}>
          {c.status === 'Draft' && c.last_decision && ['Returned', 'Rejected'].includes(c.last_decision.status) && <Callout tone="warn" title={`${c.last_decision.req_no} ${c.last_decision.status.toLowerCase()}`}>{c.last_decision.outcome ?? 'No comment'} — edit the draft and send it again.</Callout>}
          {c.status === 'Pending approval' && <Callout tone="decision" title="Waiting for approval">{c.approvals[0] ? <>Request <Ref to={`/approvals/${c.approvals[0].id}`}>{c.approvals[0].req_no}</Ref> is with the approvers.</> : 'With the approvers.'}</Callout>}
          {c.status === 'Pending SAP' && (
            <div className="sim-panel row-wrap between">
              <span className="small"><SimBadge>SAP simulator</SimBadge> Approved. The SAP team creates the outline agreement with reference <span className="mono">{c.contract_no}</span>. Until it syncs back, PRs cannot route to this contract (FR-CON-09).</span>
              {sim && <ButtonLink to={`/sap-simulator?action=oa&contract=${c.id}`} size="sm" variant="deep">Create OA in SAP simulator</ButtonLink>}
            </div>
          )}
          {c.pending_change && (
            c.pending_change.status === 'Pending SAP' ? (
              <div className="sim-panel row-wrap between">
                <span className="small"><SimBadge>SAP simulator</SimBadge> Approved {KIND_LABEL[c.pending_change.kind]?.toLowerCase()} waits for SAP: update OA <span className="mono">{c.sap_oa_no}</span>{c.pending_change.after?.valid_to ? ` to valid ${fmtDate(c.pending_change.after.valid_to)}` : ''}. Routing uses the SAP values until then.</span>
                {sim && <ButtonLink to={`/sap-simulator?action=oa&contract=${c.id}`} size="sm" variant="deep">Open SAP simulator</ButtonLink>}
              </div>
            ) : <Callout tone="decision" title={`${KIND_LABEL[c.pending_change.kind]} waiting for approval`}>{c.pending_change.req_no && <Ref to={`/approvals/${c.pending_change.approval_id}`}>{c.pending_change.req_no}</Ref>} · {c.pending_change.reason}</Callout>
          )}
          {c.status === 'Expiring' && <Callout tone="warn" title={`Expires in ${c.days_to_expiry} days`}>{c.renewal_decision ? `Decision: ${KIND_LABEL[c.renewal_decision.kind]} (${c.renewal_decision.status.toLowerCase()}) by ${c.renewal_decision.by ?? '—'}.` : `Within the ${c.lead_days}-day renewal lead time. Renew, extend in SAP or let it expire.`}</Callout>}
          {c.status === 'Terminated' && c.terminated_reason && <Callout tone="bad" title="Terminated">{c.terminated_reason}</Callout>}
          {c.renewals.map((r) => <Callout key={r.id} tone="info">Renewal <Ref to={`/contracts/${r.id}`}>{r.contract_no}</Ref> · {r.status} · {fmtDate(r.valid_from)} – {fmtDate(r.valid_to)}</Callout>)}
          {c.renewed_from && <Callout tone="info">Renews <Ref to={`/contracts/${c.renewed_from.id}`}>{c.renewed_from.contract_no}</Ref> ({c.renewed_from.status.toLowerCase()}, valid to {fmtDate(c.renewed_from.valid_to)}).</Callout>}
          {c.opportunity && <Callout tone="info">Created from ARC/OA opportunity for <span className="mono">{c.opportunity.material_code}</span>. <Link to={`/rfqs/new?opportunity=${c.opportunity.id}`}>Start annual-rate RFQ</Link></Callout>}
        </div>
      </Card>

      <div style={{ height: 16 }} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'overview', label: 'Terms & items' },
        ...(showPrices ? [{ id: 'prices' as Tab, label: 'Price lists', count: c.price_lists.length }] : []),
        ...(c.type === 'VMI' || c.vmi ? [{ id: 'vmi' as Tab, label: 'VMI', count: c.vmi_status.filter((v) => v.state === 'Below minimum').length || undefined }] : []),
        { id: 'documents', label: 'Documents' }, { id: 'pos', label: 'Linked POs', count: c.pos.length },
        { id: 'changes', label: 'Changes & alerts', count: c.changes.length + c.alerts.length || undefined }, { id: 'history', label: 'History' },
      ]} />

      <div className="split">
        <div className="stack">
          {tab === 'overview' && <Overview c={c} />}
          {tab === 'prices' && <PriceLists c={c} onAdd={manage && ['Draft', 'Active', 'Expiring'].includes(c.status) && !c.pending_change ? () => setDlg('pricelist') : undefined} />}
          {tab === 'vmi' && <Vmi c={c} onEdit={manage && ['Draft', 'Pending SAP', 'Active', 'Expiring'].includes(c.status) ? () => setDlg('vmi') : undefined} />}
          {tab === 'documents' && <Card title="Documents"><AttachmentList ownerType="contract" ownerId={c.id} canUpload={manage} uploadLabel="Contract document" /></Card>}
          {tab === 'pos' && <LinkedPos c={c} />}
          {tab === 'changes' && <Changes c={c} />}
          {tab === 'history' && <Card title="Audit history"><AuditTrail objectType="contract" objectId={c.id} /></Card>}
        </div>
        <Side c={c} />
      </div>

      {dlg === 'change' && <ChangeDialog c={c} onClose={() => setDlg(null)} />}
      {dlg === 'pricelist' && <PriceListDialog c={c} onClose={() => setDlg(null)} />}
      {dlg === 'vmi' && <VmiDialog c={c} onClose={() => setDlg(null)} />}
      <ReasonDialog open={dlg === 'discard'} onClose={() => setDlg(null)} title={`Discard draft ${c.contract_no}`} variant="danger" confirmLabel="Discard draft" onSubmit={(r) => discard.run(r)} />
    </>
  );
}

function Overview({ c }: { c: ContractDetail }) {
  return (
    <>
      <Card title="Commercial terms" actions={c.synced_at ? <Freshness flow="INT-M06" label="OA" /> : undefined}>
        <KV cols items={[
          ['Contract', <span className="mono">{c.contract_no}</span>], ['SAP OA', c.sap_oa_no ? <span className="mono">{c.sap_oa_no}</span> : 'Pending SAP'],
          ['Type', TYPE_LABEL[c.type] ?? c.type], ['Category', c.category_name ?? c.category], ['Plant', c.plant === '*' ? 'All plants' : c.plant],
          ['Validity', `${fmtDate(c.valid_from)} – ${fmtDate(c.valid_to)}`], ['Value cap', c.value_cap != null ? fmtMoney(c.value_cap, true) : 'No cap'],
          ['Payment terms', c.payment_terms], ['Delivery terms', c.delivery_terms], ['Discount', c.discount_pct != null ? `${c.discount_pct}%` : '—'],
          ['Invoice validation', c.invoice_validation ? 'On — Module 10 checks invoice prices' : 'Off'], ['Price revision date', fmtDate(c.price_revision_date)],
          ['Renewal lead time', <>{c.lead_days} days <DecisionTag id="Q 7.6" /></>], ['Last SAP sync', c.synced_at ? fmtDateTime(c.synced_at) : 'Not synced'],
        ]} />
        {c.terms && <p style={{ marginTop: 12, whiteSpace: 'pre-wrap' }} className="small">{c.terms}</p>}
      </Card>
      <Card title="Items" flush>
        <DataTable id="contract-items" rows={c.items} rowKey={(r) => r.id} searchable={false} savedViews={false} pageSize={50}
          columns={[
            { key: 'material_code', header: 'Material', render: (r) => <div style={{ minWidth: 200 }}><div style={{ fontWeight: 600 }}>{r.description}</div><div className="small subtle mono">{r.material_code}</div></div> },
            { key: 'unit_price', header: 'Contract price', align: 'right', render: (r) => <span className="num">{fmtMoney(r.unit_price)} / {r.uom ?? r.material_uom}</span> },
            { key: 'discount_pct', header: 'Discount', align: 'right', render: (r) => (r.discount_pct ?? c.discount_pct) != null ? `${r.discount_pct ?? c.discount_pct}%` : '—' },
            { key: 'qty_cap', header: 'Consumed / cap', align: 'right', render: (r) => r.qty_cap != null ? `${fmtNum(r.utilisation?.consumed_qty ?? r.consumed_qty)} / ${fmtNum(r.qty_cap)}` : `${fmtNum(r.utilisation?.consumed_qty ?? r.consumed_qty)} · no cap` },
            { key: 'util', header: 'Utilisation', sortable: false, render: (r) => <UtilBar pct={r.utilisation?.pct} warnPct={c.utilisation.warn_pct} /> },
          ]}
          mobile={{ title: (r) => <><span className="mono">{r.material_code}</span> · {r.description}</>, badge: (r) => <span className="num">{fmtMoney(r.unit_price)}</span>, meta: (r) => [r.qty_cap != null ? `${fmtNum(r.utilisation?.consumed_qty)} of ${fmtNum(r.qty_cap)} used` : 'No qty cap'] }}
          empty={<Empty title="No items">Edit the draft to add items and prices.</Empty>}
        />
      </Card>
    </>
  );
}

function Side({ c }: { c: ContractDetail }) {
  const u = c.utilisation;
  return (
    <div className="stack">
      <Card title="Utilisation">
        <UtilBar pct={u.pct} warnPct={u.warn_pct} label="Value utilisation" />
        {u.warn && <div style={{ marginTop: 10 }}><Callout tone={u.pct != null && u.pct >= 1 ? 'bad' : 'warn'}>{u.pct != null && u.pct >= 1 ? 'Value cap reached — the contract no longer routes PRs.' : `Above ${u.warn_pct}% of the value cap. Plan the renewal or a cap increase.`} <DecisionTag id="DEC-09" /></Callout></div>}
        <div style={{ marginTop: 12 }}>
          <KV items={[['Consumed', fmtMoney(u.consumed, true)], ['Value cap', u.cap != null ? fmtMoney(u.cap, true) : 'No cap'], ['Remaining', u.remaining != null ? fmtMoney(u.remaining, true) : '—'], ['Linked POs', `${u.linked_pos} · ${fmtLakh(u.linked_po_value)}`], ['Basis', <span className="small">{u.basis}</span>]]} />
        </div>
      </Card>
      <Card title="Routing">
        <Callout tone={c.routable ? 'ok' : 'warn'}>{c.reason}</Callout>
      </Card>
      <Card title="People">
        <KV items={[['Owner', c.owner?.name ?? '—'], ['Owner\'s manager', c.owner_manager?.name ?? '—'], ['Vendor contact', c.vendor.contact_name], ['E-mail', c.vendor.contact_email], ['Phone', c.vendor.contact_phone]]} />
      </Card>
      {c.approvals.length > 0 && (
        <Card title="Approvals">
          <ol className="timeline">
            {c.approvals.map((a) => <li key={a.id}><span className="timeline__dot" data-tone="decision" /><div className="timeline__title"><Ref to={`/approvals/${a.id}`}>{a.req_no}</Ref> <Status value={a.status} /></div><div className="timeline__meta">{a.title} · {ago(a.created_at)}</div>{a.outcome && <div className="timeline__body">{a.outcome}</div>}</li>)}
          </ol>
        </Card>
      )}
    </div>
  );
}

function PriceLists({ c, onAdd }: { c: ContractDetail; onAdd?: () => void }) {
  return (
    <Card title={<div className="row-wrap"><h2>Price-list versions</h2><span className="small muted">Invoices are checked against the version effective on the PO date <DecisionTag id="ASM" /></span></div>}
      actions={onAdd && <Button size="sm" variant="primary" icon={<ListPlus />} onClick={onAdd}>Add price-list version</Button>}>
      {!c.price_lists.length ? <Empty title="No price lists yet">{onAdd ? 'Add the vendor price list and its effective date.' : 'Price lists appear here when added.'}</Empty> : (
        <div className="stack">
          {c.price_lists.map((p) => (
            <div key={p.id} style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: 12, background: p.state === 'Current' ? 'var(--surface-sunk)' : undefined }}>
              <div className="row between" style={{ marginBottom: 8 }}>
                <div className="row-wrap"><strong>Version {p.version}</strong><Badge tone={p.state === 'Current' ? 'ok' : p.state === 'Scheduled' ? 'info' : 'neutral'}>{p.state}</Badge><span className="small muted">effective {fmtDate(p.effective_from)}</span></div>
                <span className="small subtle">{p.note}</span>
              </div>
              <div className="tbl-wrap">
                <table className="tbl tbl--dense">
                  <thead><tr><th>Material</th><th className="num">List price</th><th className="num">Discount</th><th className="num">Expected invoice price</th></tr></thead>
                  <tbody>{p.items.map((i) => {
                    const d = c.items.find((x) => x.material_id === i.material_id)?.discount_pct ?? c.discount_pct ?? 0;
                    return <tr key={i.material_id}><td><span className="mono">{i.material_code}</span> <span className="small muted">{i.description}</span></td><td className="num">{fmtMoney(i.list_price)}</td><td className="num">{d}%</td><td className="num" style={{ fontWeight: 600 }}>{fmtMoney(Math.round(i.list_price * (1 - d / 100) * 100) / 100)}</td></tr>;
                  })}</tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Vmi({ c, onEdit }: { c: ContractDetail; onEdit?: () => void }) {
  return (
    <>
      <Card title={<div className="row-wrap"><h2>Live min-max status</h2><Freshness flow="INT-M04" label="Stock" /></div>} actions={onEdit && <Button size="sm" icon={<Boxes />} onClick={onEdit}>Edit VMI terms</Button>} flush>
        <DataTable id="contract-vmi" rows={c.vmi_status} rowKey={(r) => r.material_id} searchable={false} savedViews={false}
          columns={[
            { key: 'material_code', header: 'Material', render: (r) => <div><div style={{ fontWeight: 600 }}>{r.description}</div><div className="small subtle mono">{r.material_code} · {r.plant ?? 'all plants'}</div></div> },
            { key: 'unrestricted', header: 'Unrestricted', align: 'right', render: (r) => <span className="num" style={{ fontWeight: 700, color: r.state === 'Below minimum' ? 'var(--bad)' : undefined }}>{fmtNum(r.unrestricted)} {r.uom}</span> },
            { key: 'min', header: 'Min', align: 'right' }, { key: 'max', header: 'Max', align: 'right' },
            { key: 'open_po_qty', header: 'Open PO', align: 'right' },
            { key: 'state', header: 'Status', render: (r) => <Badge tone={r.state === 'Below minimum' ? 'bad' : r.state === 'Above maximum' ? 'warn' : 'ok'}>{r.state}</Badge> },
            { key: 'replenish_qty', header: 'Replenish', align: 'right', render: (r) => (r.replenish_qty ? `${fmtNum(r.replenish_qty)} ${r.uom}` : '—') },
          ]}
          mobile={{ title: (r) => <><span className="mono">{r.material_code}</span> · {r.description}</>, badge: (r) => <Badge tone={r.state === 'Below minimum' ? 'bad' : r.state === 'Above maximum' ? 'warn' : 'ok'}>{r.state}</Badge>, meta: (r) => [`Stock ${r.unrestricted} ${r.uom}`, `Min ${r.min} · Max ${r.max}`, r.replenish_qty ? `Replenish ${r.replenish_qty}` : ''] }}
          empty={<Empty title="No VMI levels set">{onEdit ? 'Set minimum and maximum levels per material.' : 'VMI levels appear here once set.'}</Empty>}
        />
        <p className="small muted" style={{ padding: '0 14px 12px' }}>When stock is below the minimum the vendor and buyer get an NTF-15 alert, once per material per day.</p>
      </Card>
      {c.vmi && (
        <Card title="VMI terms">
          <KV items={[['Replenishment frequency', c.vmi.replenishment_frequency], ['Billing cycle', c.vmi.billing_cycle], ['Reconciliation', c.vmi.reconciliation], ['Plant', c.vmi.plant ?? 'All plants']]} />
        </Card>
      )}
    </>
  );
}

function LinkedPos({ c }: { c: ContractDetail }) {
  return (
    <Card title="POs created against this contract" flush>
      <DataTable id="contract-pos" rows={c.pos} rowKey={(r) => r.id} rowLink={(r) => `/pos/${r.id}`} savedViews={false}
        columns={[
          { key: 'po_no', header: 'PO', render: (r) => <Ref to={`/pos/${r.id}`}>{r.po_no}</Ref> }, { key: 'po_date', header: 'Date', render: (r) => fmtDate(r.po_date) },
          { key: 'plant', header: 'Plant' }, { key: 'buyer_name', header: 'Buyer' },
          { key: 'basic_value', header: 'Basic value', align: 'right', render: (r) => fmtMoney(r.basic_value, true) }, { key: 'status', header: 'Status', render: (r) => <Status value={r.status} /> },
        ]}
        mobile={{ title: (r) => <span className="mono">{r.po_no}</span>, badge: (r) => <Status value={r.status} />, meta: (r) => [fmtDate(r.po_date), fmtMoney(r.basic_value, true)] }}
        empty={<Empty title="No POs reference this contract yet">POs created in SAP with this outline agreement appear here after sync.</Empty>}
      />
    </Card>
  );
}

const show = (v: unknown) => (v == null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
function Changes({ c }: { c: ContractDetail }) {
  return (
    <>
      <Card title="Change requests and decisions">
        {!c.changes.length ? <Empty title="No changes yet">Term changes, price lists, extensions and renewal decisions are listed here.</Empty> : (
          <ol className="timeline">
            {c.changes.map((ch) => (
              <li key={ch.id}>
                <span className="timeline__dot" data-tone={ch.status === 'Applied' || ch.status === 'Recorded' ? 'ok' : ch.status === 'Rejected' ? 'bad' : 'decision'} />
                <div className="timeline__title">{KIND_LABEL[ch.kind] ?? ch.kind} <Status value={ch.status} /> {ch.req_no && <Ref to={`/approvals/${ch.approval_id}`}>{ch.req_no}</Ref>}</div>
                <div className="timeline__meta">{ch.requested_by_name} · {fmtDateTime(ch.created_at)}{ch.applied_at ? ` · applied ${fmtDateTime(ch.applied_at)}` : ''}</div>
                {ch.reason && <div className="timeline__body">Reason: {ch.reason}</div>}
                {ch.kind === 'terms' && ch.after && (
                  <div className="small" style={{ marginTop: 4, display: 'grid', gap: 2 }}>
                    {Object.keys(ch.after).filter((k) => k !== 'items').map((k) => <div key={k}><span className="subtle">{k.replace(/_/g, ' ')}:</span> <s className="subtle">{show(ch.before?.[k])}</s> → {show(ch.after[k])}</div>)}
                    {(ch.after.items ?? []).map((it: any) => <div key={it.material_id}><span className="mono">{it.material_code}</span>: <s className="subtle">{it.before ? fmtMoney(it.before.unit_price) : 'new'}</s> → {it.after ? fmtMoney(it.after.unit_price) : 'removed'}</div>)}
                  </div>
                )}
                {ch.kind === 'extension' && <div className="small">Valid to {fmtDate(ch.before?.valid_to)} → {fmtDate(ch.after?.valid_to)}</div>}
                {ch.kind === 'price_list' && <div className="small">Effective {fmtDate(ch.after?.effective_from)} · {ch.after?.items?.length} list price(s)</div>}
                {ch.kind === 'renewal' && ch.after?.renewal_contract_id && <div className="small">Renewal <Ref to={`/contracts/${ch.after.renewal_contract_id}`}>{ch.after.renewal_contract_no}</Ref></div>}
                {ch.note && <div className="small muted">{ch.note}</div>}
              </li>
            ))}
          </ol>
        )}
      </Card>
      <Card title="Off-contract alerts for this contract">
        {!c.alerts.length ? <Empty title="No off-contract purchases detected" /> : (
          <ul className="list-plain stack-sm">
            {c.alerts.map((a) => <li key={a.id} className="row between" style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)' }}><span><span className="mono">{a.po_no}/{a.item}</span> · {a.material_code} from {a.po_vendor} at {fmtMoney(a.unit_price)}</span><span className="row"><Status value={a.status} /><Link to={`/contracts?tab=alerts&alert=${a.id}`}><ExternalLink size={14} /> Open</Link></span></li>)}
          </ul>
        )}
      </Card>
    </>
  );
}

function ChangeDialog({ c, onClose }: { c: ContractDetail; onClose: () => void }) {
  const opts = useQuery<{ buyers: { id: number; name: string }[] }>({ queryKey: ['contracts', 'options'], queryFn: () => api.get('/contracts/options') });
  const [f, setF] = useState({
    payment_terms: c.payment_terms ?? '', delivery_terms: c.delivery_terms ?? '', value_cap: c.value_cap != null ? String(c.value_cap) : '', discount_pct: c.discount_pct != null ? String(c.discount_pct) : '',
    invoice_validation: !!c.invoice_validation, price_revision_date: c.price_revision_date ?? '', renewal_lead_days: String(c.lead_days), terms: c.terms ?? '', owner_id: c.owner_id ? String(c.owner_id) : '',
  });
  const [prices, setPrices] = useState<Record<number, string>>(Object.fromEntries(c.items.map((i) => [i.material_id, String(i.unit_price)])));
  const [reason, setReason] = useState('');
  const act = useAction(() => {
    const fields: Record<string, unknown> = {
      payment_terms: f.payment_terms, delivery_terms: f.delivery_terms, value_cap: f.value_cap === '' ? null : Number(f.value_cap), discount_pct: f.discount_pct === '' ? null : Number(f.discount_pct),
      invoice_validation: f.invoice_validation, price_revision_date: f.price_revision_date || null, renewal_lead_days: Number(f.renewal_lead_days), terms: f.terms || null,
      ...(f.owner_id ? { owner_id: Number(f.owner_id) } : {}),
    };
    const items = c.items.filter((i) => Number(prices[i.material_id]) !== i.unit_price).map((i) => ({ material_id: i.material_id, unit_price: Number(prices[i.material_id]) }));
    return api.post(`/contracts/${c.id}/changes`, { fields, items, reason });
  }, { success: 'Change sent for approval', invalidate: [['contracts']], onSuccess: onClose, silentError: true });
  const s = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal open onClose={onClose} wide title={`Change terms of ${c.contract_no}`} sub={<>Goes to approval. Platform terms apply on approval; SAP-held terms (value cap, payment/delivery terms, prices) apply when the SAP OA is updated <SimBadge>SAP simulator</SimBadge></>}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="decision" loading={act.busy} disabled={reason.trim().length < 10} onClick={act.fire}>Send for approval</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <div className="form-grid">
          <Field label="Payment terms"><Input value={f.payment_terms} onChange={(e) => s('payment_terms', e.target.value)} /></Field>
          <Field label="Delivery terms"><Input value={f.delivery_terms} onChange={(e) => s('delivery_terms', e.target.value)} /></Field>
          <Field label="Value cap (₹)"><Input type="number" value={f.value_cap} onChange={(e) => s('value_cap', e.target.value)} /></Field>
          <Field label="Discount (%)"><Input type="number" value={f.discount_pct} onChange={(e) => s('discount_pct', e.target.value)} /></Field>
          <Field label="Price revision date"><Input type="date" value={f.price_revision_date} onChange={(e) => s('price_revision_date', e.target.value)} /></Field>
          <Field label="Renewal lead time (days)"><Input type="number" value={f.renewal_lead_days} onChange={(e) => s('renewal_lead_days', e.target.value)} /></Field>
          <Field label="Owner"><Select value={f.owner_id} onChange={(e) => s('owner_id', e.target.value)} options={(opts.data?.buyers ?? []).map((b) => ({ value: b.id, label: b.name }))} /></Field>
          <div className="field" style={{ alignSelf: 'end' }}><Checkbox label="Validate invoices against price list" checked={f.invoice_validation} onChange={(e) => s('invoice_validation', e.target.checked)} /></div>
          <Field label="Terms and conditions" className="span-2"><Textarea rows={2} value={f.terms} onChange={(e) => s('terms', e.target.value)} /></Field>
        </div>
        <div className="stack-sm">
          <strong className="small">Item prices</strong>
          {c.items.map((i) => (
            <div key={i.material_id} className="row" style={{ gap: 10 }}>
              <span className="grow small"><span className="mono">{i.material_code}</span> {i.description}</span>
              <Input type="number" aria-label={`Price for ${i.material_code}`} style={{ maxWidth: 160 }} value={prices[i.material_id]} onChange={(e) => setPrices((p) => ({ ...p, [i.material_id]: e.target.value }))} />
            </div>
          ))}
        </div>
        <Field label="Reason" required hint="At least 10 characters. Shown to the approver and kept in the audit trail."><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

function PriceListDialog({ c, onClose }: { c: ContractDetail; onClose: () => void }) {
  const cur = c.price_lists.find((p) => p.state === 'Current') ?? c.price_lists[0];
  const [eff, setEff] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [prices, setPrices] = useState<Record<number, string>>(Object.fromEntries(c.items.map((i) => [i.material_id, String(cur?.items.find((x) => x.material_id === i.material_id)?.list_price ?? '')])));
  const draft = c.status === 'Draft';
  const act = useAction(() => api.post(`/contracts/${c.id}/price-lists`, { effective_from: eff, note: note || undefined, reason: reason || undefined, items: c.items.filter((i) => Number(prices[i.material_id]) > 0).map((i) => ({ material_id: i.material_id, list_price: Number(prices[i.material_id]) })) }), {
    success: (r: any) => (r.status === 'Applied' ? 'Price-list version added' : 'Price-list version sent for approval'), invalidate: [['contracts']], onSuccess: onClose, silentError: true,
  });
  return (
    <Modal open onClose={onClose} title={`New price-list version for ${c.contract_no}`} sub={`Discount ${c.discount_pct ?? 0}% applies to these list prices. ${draft ? '' : 'Needs approval because the contract is in force.'}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={draft ? 'primary' : 'decision'} loading={act.busy} disabled={!eff || (!draft && reason.trim().length < 10)} onClick={act.fire}>{draft ? 'Add version' : 'Send for approval'}</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="Effective from" required hint="Invoices for POs dated on or after this date use these prices."><Input type="date" value={eff} onChange={(e) => setEff(e.target.value)} /></Field>
        {c.items.map((i) => (
          <Field key={i.material_id} label={<><span className="mono">{i.material_code}</span> list price (₹)</>}><Input type="number" min={0} value={prices[i.material_id]} onChange={(e) => setPrices((p) => ({ ...p, [i.material_id]: e.target.value }))} /></Field>
        ))}
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Vendor catalogue April 2027" /></Field>
        {!draft && <Field label="Reason" required hint="At least 10 characters."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      </div>
    </Modal>
  );
}

function VmiDialog({ c, onClose }: { c: ContractDetail; onClose: () => void }) {
  const [lv, setLv] = useState<Record<number, { min: string; max: string }>>(Object.fromEntries(c.items.map((i) => {
    const v = c.vmi?.items.find((x) => x.material_id === i.material_id);
    return [i.material_id, { min: v ? String(v.min) : '', max: v ? String(v.max) : '' }];
  })));
  const [t, setT] = useState({ replenishment_frequency: c.vmi?.replenishment_frequency ?? 'Weekly', billing_cycle: c.vmi?.billing_cycle ?? 'Monthly on consumption', reconciliation: c.vmi?.reconciliation ?? '' });
  const [reason, setReason] = useState('');
  const act = useAction(() => api.put(`/contracts/${c.id}/vmi`, { ...t, plant: c.vmi?.plant ?? null, reason, items: c.items.filter((i) => lv[i.material_id].min !== '' && lv[i.material_id].max !== '').map((i) => ({ material_id: i.material_id, min: Number(lv[i.material_id].min), max: Number(lv[i.material_id].max) })) }), {
    success: 'VMI terms saved', invalidate: [['contracts']], onSuccess: onClose, silentError: true,
  });
  return (
    <Modal open onClose={onClose} wide title={`VMI terms for ${c.contract_no}`} sub="Operational VMI terms; every change is audited with before/after and reason."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={act.busy} disabled={reason.trim().length < 10} onClick={act.fire}>Save VMI terms</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        {c.items.map((i) => (
          <div key={i.material_id} className="row-wrap" style={{ gap: 10 }}>
            <span className="grow small" style={{ minWidth: 200 }}><span className="mono">{i.material_code}</span> {i.description}</span>
            <Input type="number" aria-label={`Minimum for ${i.material_code}`} placeholder="Min" style={{ maxWidth: 110 }} value={lv[i.material_id].min} onChange={(e) => setLv((x) => ({ ...x, [i.material_id]: { ...x[i.material_id], min: e.target.value } }))} />
            <Input type="number" aria-label={`Maximum for ${i.material_code}`} placeholder="Max" style={{ maxWidth: 110 }} value={lv[i.material_id].max} onChange={(e) => setLv((x) => ({ ...x, [i.material_id]: { ...x[i.material_id], max: e.target.value } }))} />
          </div>
        ))}
        <div className="form-grid">
          <Field label="Replenishment frequency" required><Input value={t.replenishment_frequency} onChange={(e) => setT({ ...t, replenishment_frequency: e.target.value })} /></Field>
          <Field label="Billing cycle" required><Input value={t.billing_cycle} onChange={(e) => setT({ ...t, billing_cycle: e.target.value })} /></Field>
          <Field label="Reconciliation" required className="span-2"><Textarea rows={2} value={t.reconciliation} onChange={(e) => setT({ ...t, reconciliation: e.target.value })} /></Field>
        </div>
        <Field label="Reason" required hint="At least 10 characters."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
