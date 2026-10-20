import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, FileText, Send, Save, PackageCheck, RefreshCw, Play, Percent, Trash2, CheckCircle2, Undo2 } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtLakh, fmtMoney, fmtNum, fmtPct } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, DecisionTag, Empty, Kpi, KV, Loader, PageHeader, Ref, Segmented, SimBadge, Status, Tabs } from '@/components/ui';
import { Checkbox, ErrorSummary, Field, Input, Select, Textarea } from '@/components/forms';
import { ConfirmDialog, ReasonDialog } from '@/components/overlay';
import { TrackChain, chainFrom } from '@/components/TrackChain';
import { AuditTrail } from '@/components/AuditTrail';
import { Ring } from '@/components/charts';
import type { Cell, Comparison, Row } from './types';
import { CMP_STAGES } from './types';
import './cmp.css';

type Tab = 'grid' | 'rec' | 'coverage' | 'discounts' | 'approvals' | 'audit';

export default function ComparisonPage() {
  const id = Number(useParams().id);
  const q = useQuery<Comparison>({ queryKey: ['cmp', 'detail', id], queryFn: () => api.get(`/cmp/${id}`) });
  return <Loader q={q} rows={12}>{(c) => <View c={c} />}</Loader>;
}

const pctTone = (v: number | null) => (v == null ? undefined : v > 0.0005 ? 'cmp-var-up' : v < -0.0005 ? 'cmp-var-down' : undefined);
const Var = ({ v }: { v: number | null }) => <span className={pctTone(v)}>{v == null ? '—' : `${v > 0 ? '+' : ''}${fmtPct(v)}`}</span>;

function View({ c }: { c: Comparison }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>(c.status === 'Draft' || c.status === 'Returned' ? 'grid' : 'grid');
  const [confirm, setConfirm] = useState<'release' | 'submit' | null>(null);
  const manage = can('cmp.manage');
  const inv = [['cmp'], ['approvals']];
  const release = useAction(() => api.post(`/cmp/${c.id}/release`), { success: `${c.ref} released for PO`, invalidate: inv });
  const submit = useAction(() => api.post(`/cmp/${c.id}/submit`), { success: `${c.ref} sent for approval`, invalidate: inv });
  const regen = useAction(() => api.post<{ id: number; ref: string }>(`/cmp/rfq/${c.rfq_id}/generate`), { success: (r) => `Comparison ${r.ref} generated`, invalidate: inv, onSuccess: (r) => navigate(`/comparisons/${r.id}`) });
  const refresh = useAction(() => api.post(`/cmp/${c.id}/refresh-params`), { success: 'Landed cost recalculated with current settings', invalidate: inv });

  const stageIdx = c.status === 'Returned' || c.status === 'Rejected' ? 2 : Math.max(0, CMP_STAGES.indexOf(c.status));
  const steps = chainFrom(CMP_STAGES, c.status === 'Released for PO' ? 5 : stageIdx, {
    blockedAt: c.status === 'Rejected' || c.status === 'Returned' ? 2 : undefined,
    subs: { 0: fmtDate(c.created_at), 1: c.summary.recommendation ? c.summary.recommendation.by_name : undefined, 2: c.status === 'Returned' ? 'Returned' : c.status === 'Rejected' ? 'Rejected' : c.submitted_at ? fmtDate(c.submitted_at) : undefined, 3: c.decided_at && c.status !== 'Returned' && c.status !== 'Rejected' ? fmtDate(c.decided_at) : undefined, 4: c.sap_handoff_at ? fmtDate(c.sap_handoff_at) : undefined },
  });
  const rec = c.summary.recommendation;
  const pendingDiscounts = (c.late_discount ?? []).filter((d) => d.status === 'Pending approval' || d.status === 'Draft').length;

  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/comparisons">Comparisons</Link><span>/</span><span className="mono">{c.ref}</span></>} screen={tab === 'rec' ? 'SCR-CMP-02' : 'SCR-CMP-01'}
        title={c.rfq.title ?? `Comparison for ${c.rfq.rfq_no}`}
        badges={<><Status value={c.status} />{c.deviation ? <Badge tone="decision">Deviation from lowest</Badge> : null}{c.summary.superseded_by ? <Badge tone="warn">Superseded</Badge> : null}</>}
        sub={<>RFQ <Ref to={`/rfqs/${c.rfq.id}`}>{c.rfq.rfq_no}</Ref> · {c.rfq.plant ?? '—'} · buyer {c.rfq.buyer_name ?? '—'} · version {c.version} generated {fmtDateTime(c.created_at)}{c.created_by_name ? ` by ${c.created_by_name}` : ''}</>}
        actions={<>
          <a className="btn btn--secondary" href={downloadUrl(`/cmp/${c.id}/csv`)}><Download size={16} /> Export CSV</a>
          <a className="btn btn--secondary" href={downloadUrl(`/cmp/${c.id}/pdf`)} target="_blank" rel="noreferrer"><FileText size={16} /> {['Approved', 'Released for PO'].includes(c.status) ? 'Approved PDF' : 'Export PDF'}</a>
          {manage && c.status === 'Recommendation recorded' && !c.summary.superseded_by && <Button variant="decision" icon={<Send />} onClick={() => setConfirm('submit')}>Send for approval</Button>}
          {manage && c.status === 'Approved' && <Button variant="primary" icon={<PackageCheck />} onClick={() => setConfirm('release')}>Release for PO</Button>}
        </>}
      />

      <Card className="no-print">
        <TrackChain steps={steps} label="Comparison lifecycle" />
        <div className="stack" style={{ marginTop: 12 }}>
          {!!c.summary.superseded_by && <Callout tone="warn" title="Superseded">This version was replaced after the RFQ was reopened. <Link to={`/comparisons/${c.summary.superseded_by}`}>Open the latest version</Link>.</Callout>}
          {c.quotes_changed && !c.summary.superseded_by && !['Approved', 'Released for PO'].includes(c.status) && (
            <Callout tone="warn" title="Quotations changed after this version was generated">The RFQ was reopened and vendors revised their quotations. {manage && <Button size="sm" variant="primary" icon={<Play />} loading={regen.busy} onClick={regen.fire}>Generate new version</Button>}</Callout>
          )}
          {c.summary.note && c.editable && <Callout tone="warn">{c.summary.note}</Callout>}
          {c.status === 'Returned' && <Callout tone="warn" title="Returned for changes">Read the approver's comment under Approvals, revise the recommendation and send it again. Approval restarts from level 1.</Callout>}
          {c.status === 'Rejected' && <Callout tone="bad" title="Recommendation rejected">Cancel or re-float the RFQ from the RFQ screen. <ButtonLink size="sm" to={`/rfqs/${c.rfq.id}`}>Open {c.rfq.rfq_no} to cancel or re-float</ButtonLink></Callout>}
          {c.status === 'Submitted for approval' && <Callout tone="decision" title="Waiting for approval">Approved only when every linked request is approved. <button className="btn btn--ghost btn--sm" onClick={() => setTab('approvals')}>See approvals</button></Callout>}
          {c.status === 'Approved' && <Callout tone="ok" title="Approved">The locked PDF of the approved statement is stored with the comparison. Release it so the buyer can create the PO in SAP.</Callout>}
          {c.status === 'Released for PO' && (
            <div className="sim-panel stack-sm">
              <div className="row-wrap between">
                <span><SimBadge>SAP simulator</SimBadge> <strong>Create the PO in SAP</strong></span>
                {can('sapsim.po', 'sapsim.all') && <ButtonLink to={`/sap-simulator?action=po&comparison=${c.id}`} size="sm" variant="deep">Create PO in SAP simulator</ButtonLink>}
              </div>
              <span className="small">The platform never creates purchase orders. The buyer creates and releases the PO in SAP from this award; it is published to the vendor when SAP syncs it back. Whether a draft PO may be created from the award is open decision <DecisionTag id="DEC-05" />.</span>
              {c.pos.length > 0 ? (
                <div className="small">POs synced from SAP: {c.pos.map((p) => <span key={p.id} style={{ marginRight: 10 }}><Ref to={`/pos/${p.id}`}>{p.po_no}</Ref> {p.vendor} · <Status value={p.status} /></span>)}</div>
              ) : <span className="small muted">No PO from this award has synced from SAP yet.</span>}
            </div>
          )}
        </div>
      </Card>

      <div className="grid-4" style={{ margin: '16px 0' }}>
        <Kpi label="Lines compared" value={c.summary.lines} meta={`${c.summary.vendors.length} locked quotations`} onClick={() => setTab('grid')} />
        <Kpi label="Vendors responded" value={`${c.summary.coverage.responded} / ${c.summary.coverage.invited}`} meta={`${c.summary.coverage.declined} declined · ${c.summary.coverage.non_participating} non-participating`} tone={c.summary.coverage.non_participating ? 'warn' : undefined} onClick={() => setTab('coverage')} />
        <Kpi label="Lowest landed (all lines)" value={fmtLakh(c.summary.lowest_total)} meta="Sum of line-wise lowest" onClick={() => setTab('grid')} />
        <Kpi label="Recommended" value={rec ? fmtLakh(rec.total_landed) : '—'} meta={rec ? (rec.difference > 0.5 ? `+${fmtLakh(rec.difference)} vs lowest` : 'Lowest landed cost') : 'Not recorded yet'} tone={rec && rec.difference > 0.5 ? 'warn' : undefined} onClick={() => setTab('rec')} />
      </div>

      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'grid', label: 'Comparative statement' },
        { id: 'rec', label: 'Award recommendation' },
        { id: 'coverage', label: 'Coverage & vendors' },
        { id: 'discounts', label: 'Late / risk discounts', count: pendingDiscounts || undefined },
        { id: 'approvals', label: 'Approvals', count: c.approvals.length || undefined },
        { id: 'audit', label: 'Audit history' },
      ]} />

      {tab === 'grid' && <GridTab c={c} manage={manage} onRefresh={refresh.fire} refreshing={refresh.busy} />}
      {tab === 'rec' && <RecTab c={c} manage={manage} onSubmit={() => setConfirm('submit')} />}
      {tab === 'coverage' && <CoverageTab c={c} />}
      {tab === 'discounts' && <DiscountTab c={c} manage={manage} />}
      {tab === 'approvals' && <ApprovalsTab c={c} />}
      {tab === 'audit' && <Card title="Audit history"><AuditTrail objectType="comparison" objectId={c.id} /></Card>}

      <ConfirmDialog open={confirm === 'submit'} onClose={() => setConfirm(null)} onConfirm={() => submit.run()} title="Send the recommendation for approval?" confirmLabel="Send for approval" variant="decision">
        <p>Routes by value through the approval matrix ({rec ? fmtMoney(rec.total_landed, true) : '—'} landed).{c.deviation ? ' Because at least one line is not the lowest landed cost, a deviation approval is raised as well and recorded in the exception register.' : ''} You cannot approve your own recommendation.</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'release'} onClose={() => setConfirm(null)} onConfirm={() => release.run()} title="Release the award for PO creation?" confirmLabel="Release for PO" variant="primary">
        <p>The RFQ becomes Awarded and the award is handed to SAP, where the buyer creates and releases the PO (DEC-05). The approved statement stays locked.</p>
      </ConfirmDialog>
    </>
  );
}

// ------------------------------------------------------------------ grid (SCR-CMP-01)
type Metric = { label: string; key: string; render: (c: Cell, r: Row) => ReactNode; key_fig?: boolean; strong?: boolean };
const METRICS: Metric[] = [
  { label: 'Basic price', key: 'basic', render: (c) => fmtMoney(c.basic_price), key_fig: true },
  { label: 'Discount %', key: 'disc', render: (c) => `${fmtNum(c.discount_pct)}%`, key_fig: true },
  { label: 'Net unit price', key: 'net', render: (c) => fmtMoney(c.net_unit) },
  { label: 'Quoted qty', key: 'qty', render: (c, r) => `${fmtNum(c.quoted_qty)} ${r.uom ?? ''}` },
  { label: 'GST % (γ)', key: 'gst', render: (c) => `${fmtNum(c.gst_rate)}% (γ ${c.gamma})`, key_fig: true },
  { label: 'Freight', key: 'freight', render: (c) => <span title={c.freight_estimate ? `Quoted ${fmtMoney(c.freight_quoted)} + Ex-Works estimate ${fmtMoney(c.freight_estimate)}` : undefined}>{fmtMoney(c.freight)}{c.freight_estimate ? ' *' : ''}</span>, key_fig: true },
  { label: 'Packing / forwarding', key: 'pack', render: (c) => fmtMoney(c.packing), key_fig: true },
  { label: 'Taxable value', key: 'taxable', render: (c) => fmtMoney(c.taxable) },
  { label: 'GST impact (γ·G)', key: 'gstimp', render: (c) => fmtMoney(c.gst_impact) },
  { label: 'Payment-term adj. (PTA)', key: 'pta', render: (c) => fmtMoney(c.pta) },
  { label: 'Late discount (LD)', key: 'ld', render: (c) => <>{fmtMoney(c.ld)}{c.ld_pending ? <div className="small" style={{ color: 'var(--warn)' }}>{fmtMoney(c.ld_pending)} pending</div> : null}</> },
  { label: 'Risk discount (RD)', key: 'rd', render: (c) => <>{fmtMoney(c.rd)}{c.rd_pending ? <div className="small" style={{ color: 'var(--warn)' }}>{fmtMoney(c.rd_pending)} pending</div> : null}</> },
  { label: 'Landed cost', key: 'landed', render: (c) => fmtMoney(c.landed), key_fig: true, strong: true },
  { label: 'Unit landed', key: 'unit', render: (c) => fmtMoney(c.unit_landed), key_fig: true, strong: true },
  { label: 'Variance vs LPP', key: 'vlpp', render: (c) => <Var v={c.var_lpp_pct} />, key_fig: true },
  { label: 'Variance vs contract', key: 'vctr', render: (c) => <Var v={c.var_contract_pct} />, key_fig: true },
  { label: 'Variance vs budget', key: 'vbud', render: (c) => <Var v={c.var_budget_pct} /> },
  { label: 'Above lowest (unit landed)', key: 'vlow', render: (c) => <Var v={c.var_lowest_pct} /> },
  { label: 'Delivery days', key: 'days', render: (c) => (c.delivery_days != null ? `${c.delivery_days} d` : '—'), key_fig: true },
  { label: 'Make / brand', key: 'make', render: (c) => c.make_brand ?? '—' },
  { label: 'Warranty', key: 'warranty', render: (c) => c.warranty ?? '—' },
  { label: 'Rank', key: 'rank', render: (c) => (c.rank ? `L${c.rank}` : c.alt_rank ? `Alt ${c.alt_rank}` : '—'), key_fig: true, strong: true },
];

function CellTags({ c, r, awarded }: { c: Cell; r: Row; awarded: boolean }) {
  if (c.no_quote) return <span className="small subtle">Not quoted</span>;
  return (
    <span className="cmp-tags">
      {c.lowest && <Badge tone="amber">Lowest</Badge>}
      {r.fastest_vendor_id === c.vendor_id && <Badge tone="info">Fastest</Badge>}
      {c.alternate && <Badge tone={c.acceptable ? 'ok' : 'warn'}>Alternate{c.acceptable ? ' · accepted' : ''}</Badge>}
      {c.partial && <Badge tone={c.acceptable ? 'ok' : 'warn'}>Partial {fmtNum(c.quoted_qty)}/{fmtNum(r.qty)}{c.acceptable ? ' · accepted' : ''}</Badge>}
      {awarded && <Badge tone="decision">Awarded</Badge>}
    </span>
  );
}

function GridTab({ c, manage, onRefresh, refreshing }: { c: Comparison; manage: boolean; onRefresh: () => void; refreshing: boolean }) {
  const [mode, setMode] = useState<'key' | 'full'>('key');
  const [acc, setAcc] = useState<{ row: Row; cell: Cell } | null>(null);
  const setAcceptable = useAction((b: { rfq_line_id: number; vendor_id: number; acceptable: boolean; reason?: string }) => api.post(`/cmp/${c.id}/acceptable`, b), {
    success: (_r) => 'Ranking updated', invalidate: [['cmp']],
  });
  const vendors = c.summary.vendors;
  const anyDisc = c.rows.some((r) => r.cells.some((x) => x.ld || x.rd || x.ld_pending || x.rd_pending));
  const anyPta = c.params.landed_cost.payment_term_adjustment.enabled;
  const metrics = METRICS.filter((m) => mode === 'full' || m.key_fig || ((m.key === 'ld' || m.key === 'rd') && anyDisc) || (m.key === 'pta' && anyPta));
  const awarded = (r: Row, v: number) => (c.awards ?? []).some((a) => a.rfq_line_id === r.rfq_line_id && a.vendor_id === v);
  const lc = c.params.landed_cost;
  if (!vendors.length) return <Card><Empty title="No locked quotations in this version">Every invited vendor declined or did not respond. Re-float or cancel the RFQ.</Empty></Card>;
  return (
    <Card flush title={<div className="row-wrap"><h2>Line × vendor comparison</h2><span className="small muted">Landed = Taxable × (1 + γG) − PTA − LD − RD · Taxable = P(1−d)q + F + K</span></div>}
      actions={<><Segmented label="Detail" value={mode} onChange={setMode} options={[{ id: 'key', label: 'Key figures' }, { id: 'full', label: 'All components' }]} />{manage && c.editable && <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={refreshing} onClick={onRefresh} title="Re-read landed-cost settings and recalculate">Recalculate</Button>}</>}>
      <div className="cmp-grid-wrap">
        <table className="cmp-grid">
          <thead>
            <tr>
              <th className="cmp-first">Line / metric</th>
              {vendors.map((v) => (
                <th key={v.vendor_id}>
                  <div className="cmp-vhead">
                    <strong>{v.name}</strong>
                    <span className="mono small">{v.sap_code ?? 'No SAP code'} · {v.quotation_ref ?? `Q${v.quotation_id}`} v{v.version}</span>
                    <span className="small">{v.delivery_terms ?? '—'} · {v.credit_days != null ? `${v.credit_days} d credit` : v.payment_terms ?? '—'}</span>
                    <span className="small">Performance {v.performance_score != null ? fmtNum(v.performance_score) : '—'}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.rows.map((r) => (
              <LineRows key={r.rfq_line_id} r={r} metrics={metrics} vendors={vendors.map((v) => v.vendor_id)} awarded={awarded}
                onAccept={manage && c.editable ? (cell) => setAcc({ row: r, cell }) : undefined}
                onUnaccept={manage && c.editable ? (cell) => setAcceptable.fire({ rfq_line_id: r.rfq_line_id, vendor_id: cell.vendor_id, acceptable: false }) : undefined} />
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="cmp-first">RFQ total landed per vendor</td>
              {vendors.map((v) => <td key={v.vendor_id}>{fmtMoney(v.total_landed)}<div className="small muted" style={{ fontWeight: 500 }}>{v.lines_quoted}/{v.lines_total} lines{v.lowest_lines ? ` · lowest on ${v.lowest_lines}` : ''}</div></td>)}
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="cmp-cards">
        {c.rows.map((r) => <LineCard key={r.rfq_line_id} r={r} awarded={awarded} />)}
        <div className="small muted">RFQ totals: {vendors.map((v) => `${v.name} ${fmtLakh(v.total_landed)} (${v.lines_quoted}/${v.lines_total})`).join(' · ')}</div>
      </div>
      <div className="cmp-legend">
        <span><i style={{ background: 'var(--amber-50)', border: '1px solid var(--amber-500)' }} />Lowest unit landed cost (ties show both)</span>
        <span><i style={{ border: '2px solid var(--berry-600)' }} />Awarded in the recommendation</span>
        <span>Alternate / partial quotes rank separately (Alt n) until marked acceptable</span>
        <span>GST impact: {lc.gst_impact === 'category_itc' ? 'γ by spend-category ITC flag' : lc.gst_impact} · PTA {lc.payment_term_adjustment.enabled ? `on (${lc.payment_term_adjustment.rate_pct}% p.a., reference ${lc.payment_term_adjustment.reference_days} d)` : 'off'} · Ex-Works freight estimate {lc.exw_freight_estimate_pct ? `${lc.exw_freight_estimate_pct}% (* in freight)` : 'off'} <DecisionTag id="DEC-21" /></span>
        <span>Variance on net unit price (basic after discount). Parameters snapshot {fmtDateTime(c.params.snapshot_at)}.</span>
      </div>
      <ReasonDialog open={!!acc} onClose={() => setAcc(null)} title="Mark this quote acceptable" confirmLabel="Mark acceptable" sub={acc ? `${acc.cell.vendor_name} — ${acc.cell.alternate ? `alternate make ${acc.cell.make_brand ?? ''}` : `partial quantity ${acc.cell.quoted_qty} of ${acc.row.qty}`} on line ${acc.row.line_no}. It will be ranked with the other quotes.` : undefined}
        onSubmit={(reason) => setAcceptable.run({ rfq_line_id: acc!.row.rfq_line_id, vendor_id: acc!.cell.vendor_id, acceptable: true, reason })} />
    </Card>
  );
}

function LineRows({ r, metrics, vendors, awarded, onAccept, onUnaccept }: { r: Row; metrics: Metric[]; vendors: number[]; awarded: (r: Row, v: number) => boolean; onAccept?: (c: Cell) => void; onUnaccept?: (c: Cell) => void }) {
  const cells = vendors.map((v) => r.cells.find((x) => x.vendor_id === v)!);
  return (
    <>
      <tr className="cmp-line">
        <th className="cmp-first" scope="rowgroup">
          <div style={{ fontWeight: 700, color: 'var(--primary-900)' }}>{r.line_no} · {r.description}</div>
          <div className="small muted">{fmtNum(r.qty)} {r.uom} · {r.plant ?? '—'}{r.pr_ref ? <> · PR <Ref to={`/pr/${r.pr_line_id}`}>{r.pr_ref}</Ref></> : null}{r.pr_priority && r.pr_priority !== 'Normal' ? ` · ${r.pr_priority}` : ''}</div>
          <div className="small" style={{ marginTop: 2 }}>LPP {fmtMoney(r.lpp)}{r.lpp_date ? ` (${fmtDate(r.lpp_date)}${r.lpp_vendor ? `, ${r.lpp_vendor}` : ''})` : ''}</div>
          <div className="small">Contract {r.contract ? <>{fmtMoney(r.contract.unit_price)} · <Ref to={`/contracts/${r.contract.id}`}>{r.contract.contract_no}</Ref></> : 'none valid'} · Budget {fmtMoney(r.budget_price)}</div>
          <div className="small subtle" title={r.gamma_basis}>{r.gamma_basis}</div>
        </th>
        {cells.map((c) => (
          <td key={c.vendor_id} className={[c.lowest ? 'is-lowest' : '', awarded(r, c.vendor_id) ? 'is-awarded' : ''].join(' ')}>
            <CellTags c={c} r={r} awarded={awarded(r, c.vendor_id)} />
            {!c.no_quote && (c.alternate || c.partial) && (onAccept || onUnaccept) && (
              <div style={{ marginTop: 4 }}>{c.acceptable ? <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={() => onUnaccept?.(c)}>Rank separately</Button> : <Button size="sm" variant="ghost" icon={<CheckCircle2 />} onClick={() => onAccept?.(c)}>Mark acceptable</Button>}</div>
            )}
          </td>
        ))}
      </tr>
      {metrics.map((m) => (
        <tr key={m.key} className={m.strong ? 'cmp-key' : undefined}>
          <td className="cmp-first cmp-metric">{m.label}</td>
          {cells.map((c) => (
            <td key={c.vendor_id} className={[c.lowest ? 'is-lowest' : '', c.no_quote ? 'is-noquote' : ''].join(' ')}>{c.no_quote ? (m.key === 'basic' ? 'No quote' : '') : m.render(c, r)}</td>
          ))}
        </tr>
      ))}
    </>
  );
}

function LineCard({ r, awarded }: { r: Row; awarded: (r: Row, v: number) => boolean }) {
  const ranked = [...r.cells.filter((c) => c.eligible).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)), ...r.cells.filter((c) => !c.eligible && !c.no_quote).sort((a, b) => (a.alt_rank ?? 99) - (b.alt_rank ?? 99)), ...r.cells.filter((c) => c.no_quote)];
  return (
    <div className="cmp-card">
      <div className="cmp-card__head">
        <strong>{r.line_no} · {r.description}</strong>
        <div className="small muted">{fmtNum(r.qty)} {r.uom} · LPP {fmtMoney(r.lpp)} · Contract {r.contract ? fmtMoney(r.contract.unit_price) : 'none'}</div>
      </div>
      {ranked.map((c) => (
        <div key={c.vendor_id} className="cmp-card__vendor" data-lowest={c.lowest}>
          <span className="cmp-rank">{c.no_quote ? '–' : c.rank ? c.rank : `A${c.alt_rank}`}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{c.vendor_name}</div>
            {c.no_quote ? <div className="small subtle">Not quoted</div> : (
              <div className="small muted">Landed {fmtMoney(c.landed)} · {c.delivery_days ?? '—'} d · vs LPP <Var v={c.var_lpp_pct} /></div>
            )}
            <CellTags c={c} r={r} awarded={awarded(r, c.vendor_id)} />
          </div>
          <strong className="num">{c.no_quote ? '' : fmtMoney(c.unit_landed)}</strong>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ recommendation (SCR-CMP-02)
interface Pick { vendor_id: number; qty: string }
interface LineState { picks: Pick[]; reason: string; skip: boolean; skipReason: string }

function initialState(c: Comparison): Record<number, LineState> {
  const out: Record<number, LineState> = {};
  for (const r of c.rows) {
    const aw = (c.awards ?? []).filter((a) => a.rfq_line_id === r.rfq_line_id);
    const skipped = c.summary.recommendation?.skipped.find((s) => s.rfq_line_id === r.rfq_line_id);
    const low = r.cells.find((x) => x.lowest);
    out[r.rfq_line_id] = {
      picks: aw.length ? aw.map((a) => ({ vendor_id: a.vendor_id, qty: String(a.qty) })) : skipped ? [] : low ? [{ vendor_id: low.vendor_id, qty: String(Math.min(r.qty, low.quoted_qty ?? r.qty)) }] : [],
      reason: aw.find((a) => a.reason)?.reason ?? '', skip: !!skipped || (!aw.length && !low), skipReason: skipped?.reason ?? (!low ? 'No eligible quotation received for this line' : ''),
    };
  }
  return out;
}

function RecTab({ c, manage, onSubmit }: { c: Comparison; manage: boolean; onSubmit: () => void }) {
  const editable = manage && c.editable;
  const [state, setState] = useState(() => initialState(c));
  const [just, setJust] = useState(c.justification ?? '');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setState(initialState(c)); setJust(c.justification ?? ''); setDirty(false); }, [c.id, c.status, JSON.stringify(c.awards)]);
  const save = useAction(() => api.put(`/cmp/${c.id}/recommendation`, {
    justification: just,
    awards: c.rows.flatMap((r): { rfq_line_id: number; vendor_id: number | null; qty?: number; reason: string | null }[] => {
      const s = state[r.rfq_line_id];
      if (s.skip) return [{ rfq_line_id: r.rfq_line_id, vendor_id: null, reason: s.skipReason }];
      return s.picks.map((p) => ({ rfq_line_id: r.rfq_line_id, vendor_id: p.vendor_id, qty: Number(p.qty), reason: s.reason || null }));
    }),
  }), { success: 'Recommendation recorded', invalidate: [['cmp']], silentError: true, onSuccess: () => setDirty(false) });
  const upd = (lineId: number, patch: Partial<LineState>) => { setState((s) => ({ ...s, [lineId]: { ...s[lineId], ...patch } })); setDirty(true); };
  const split = c.params.split_by_qty;
  const totals = useMemo(() => {
    let total = 0; let lowest = 0;
    for (const r of c.rows) for (const p of state[r.rfq_line_id]?.picks ?? []) {
      if (state[r.rfq_line_id].skip) continue;
      const cell = r.cells.find((x) => x.vendor_id === p.vendor_id);
      total += (cell?.unit_landed ?? 0) * Number(p.qty || 0);
      lowest += (r.lowest_unit_landed ?? 0) * Number(p.qty || 0);
    }
    return { total, lowest };
  }, [state, c.rows]);
  const pendingDisc = (c.late_discount ?? []).some((d) => d.status === 'Pending approval');

  if (!editable) {
    if (!c.awards?.length) return <Card><Empty title="No recommendation recorded yet">{manage ? 'This version cannot be edited.' : 'The buyer records the award recommendation here.'}</Empty></Card>;
    return (
      <div className="split">
        <Card title="Award recommendation" flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Line</th><th>Vendor</th><th className="num">Qty</th><th className="num">Unit landed</th><th className="num">Landed</th><th>Lowest?</th><th>Reason</th></tr></thead>
              <tbody>
                {c.awards.map((a) => { const r = c.rows.find((x) => x.rfq_line_id === a.rfq_line_id)!; return (
                  <tr key={`${a.rfq_line_id}-${a.vendor_id}`}><td>{r.line_no} · {r.description}</td><td>{a.vendor_name}</td><td className="num">{fmtNum(a.qty)} {r.uom}</td><td className="num">{fmtMoney(a.landed_unit)}</td><td className="num">{fmtMoney(a.landed_total ?? a.landed_unit * a.qty)}</td><td>{a.lowest ? <Badge tone="ok">Lowest</Badge> : <Badge tone="decision">Deviation</Badge>}</td><td className="small">{a.reason ?? '—'}</td></tr>
                ); })}
                {c.summary.recommendation?.skipped.map((s) => { const r = c.rows.find((x) => x.rfq_line_id === s.rfq_line_id)!; return <tr key={`s${s.rfq_line_id}`}><td>{r.line_no} · {r.description}</td><td colSpan={5}><Badge>Not awarded</Badge></td><td className="small">{s.reason}</td></tr>; })}
              </tbody>
            </table>
          </div>
        </Card>
        <RecSummary c={c} />
      </div>
    );
  }

  return (
    <div className="split">
      <div className="stack">
        {pendingDisc && <Callout tone="warn" title="Discounts waiting for approval">Record the recommendation after the late / risk discount approval is decided — it changes landed costs.</Callout>}
        <ErrorSummary error={save.error} />
        {c.rows.map((r) => {
          const s = state[r.rfq_line_id];
          const options = [...r.cells.filter((x) => !x.no_quote)].sort((a, b) => (a.eligible === b.eligible ? (a.unit_landed ?? 0) - (b.unit_landed ?? 0) : a.eligible ? -1 : 1));
          const notLowest = s.picks.some((p) => !r.cells.find((x) => x.vendor_id === p.vendor_id)?.lowest);
          const toggle = (cell: Cell) => {
            if (!cell.eligible) return;
            const on = s.picks.some((p) => p.vendor_id === cell.vendor_id);
            const qty = String(Math.min(r.qty, cell.quoted_qty ?? r.qty));
            if (split) upd(r.rfq_line_id, { skip: false, picks: on ? s.picks.filter((p) => p.vendor_id !== cell.vendor_id) : [...s.picks, { vendor_id: cell.vendor_id, qty }] });
            else upd(r.rfq_line_id, { skip: false, picks: [{ vendor_id: cell.vendor_id, qty }] });
          };
          return (
            <div key={r.rfq_line_id} className="rec-line card" style={{ padding: 14 }}>
              <div className="row between" style={{ alignItems: 'flex-start' }}>
                <div><strong>{r.line_no} · {r.description}</strong><div className="small muted">Required {fmtNum(r.qty)} {r.uom} by {fmtDate(r.required_date)} · LPP {fmtMoney(r.lpp)}{r.contract ? ` · contract ${fmtMoney(r.contract.unit_price)}` : ''}</div></div>
                <Checkbox label="Do not award" checked={s.skip} onChange={(e) => upd(r.rfq_line_id, { skip: e.target.checked })} />
              </div>
              {s.skip ? (
                <Field label="Why is this line not awarded?" required hint="At least 10 characters, e.g. re-float or stock found."><Textarea rows={2} value={s.skipReason} onChange={(e) => upd(r.rfq_line_id, { skipReason: e.target.value })} /></Field>
              ) : (
                <>
                  <div className="stack-sm" role={split ? 'group' : 'radiogroup'} aria-label={`Vendor for line ${r.line_no}`}>
                    {options.map((cell) => {
                      const pick = s.picks.find((p) => p.vendor_id === cell.vendor_id);
                      return (
                        <label key={cell.vendor_id} className="rec-option" data-on={!!pick} data-disabled={!cell.eligible}>
                          <input type={split ? 'checkbox' : 'radio'} name={`line-${r.rfq_line_id}`} checked={!!pick} disabled={!cell.eligible} onChange={() => toggle(cell)} />
                          <span style={{ minWidth: 0 }}>
                            <strong>{cell.vendor_name}</strong> <CellTags c={cell} r={r} awarded={false} />
                            <span className="small muted" style={{ display: 'block' }}>{fmtMoney(cell.unit_landed)} / {r.uom} landed · {cell.delivery_days ?? '—'} days · {cell.make_brand ?? '—'}{!cell.eligible ? ' · mark acceptable on the statement to award' : ''}</span>
                          </span>
                          {pick ? <Input aria-label={`Quantity from ${cell.vendor_name}`} type="number" min={0} step="any" value={pick.qty} style={{ width: 96 }} className="input--sm"
                            onChange={(e) => upd(r.rfq_line_id, { picks: s.picks.map((p) => (p.vendor_id === cell.vendor_id ? { ...p, qty: e.target.value } : p)) })} onClick={(e) => e.preventDefault()} /> : <span />}
                        </label>
                      );
                    })}
                  </div>
                  {notLowest && <Field label="Reason for not choosing the lowest landed cost" required hint="At least 10 characters. Raises a deviation approval and an exception-register entry (CMP-05)."><Textarea rows={2} value={s.reason} onChange={(e) => upd(r.rfq_line_id, { reason: e.target.value })} /></Field>}
                </>
              )}
            </div>
          );
        })}
        <Card title="Justification">
          <Field label="Why this award" required hint="Shown to approvers with the comparison. At least 10 characters."><Textarea rows={3} value={just} onChange={(e) => { setJust(e.target.value); setDirty(true); }} /></Field>
          <div className="row-wrap" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <Button variant="deep" icon={<Save />} loading={save.busy} disabled={pendingDisc} onClick={save.fire}>Record recommendation</Button>
            <Button variant="decision" icon={<Send />} disabled={dirty || c.status !== 'Recommendation recorded'} title={dirty ? 'Record the changes first' : undefined} onClick={onSubmit}>Send for approval</Button>
          </div>
          {split ? <p className="small muted" style={{ marginTop: 8 }}>Split award by quantity is enabled <DecisionTag id="Q FR-CMP-07" />.</p> : <p className="small muted" style={{ marginTop: 8 }}>One vendor per line; split by quantity is off until policy allows it <DecisionTag id="Q FR-CMP-07" />.</p>}
        </Card>
      </div>
      <div className="stack">
        <Card title="Running total">
          <KV items={[['Recommended landed', fmtMoney(totals.total)], ['Lowest landed, same quantities', fmtMoney(totals.lowest)], ['Difference', <span style={{ color: totals.total - totals.lowest > 0.5 ? 'var(--bad)' : undefined }}>{fmtMoney(totals.total - totals.lowest)}</span>]]} />
          {dirty && <p className="small" style={{ color: 'var(--warn)', marginTop: 8 }}>Unsaved changes.</p>}
        </Card>
        <RecSummary c={c} />
      </div>
    </div>
  );
}

function RecSummary({ c }: { c: Comparison }) {
  const rec = c.summary.recommendation;
  return (
    <Card title="Recorded recommendation">
      {rec ? (
        <div className="stack-sm">
          <KV items={[['Recommended by', rec.by_name], ['Recorded', fmtDateTime(rec.at)], ['Landed total', fmtMoney(rec.total_landed)], ['Lowest total', fmtMoney(rec.lowest_total)], ['Deviation lines', rec.deviation_lines]]} />
          {c.justification && <p className="small"><strong>Justification:</strong> {c.justification}</p>}
          {c.deviation_reason && <Callout tone="decision" title="Deviation from lowest landed cost">{c.deviation_reason}</Callout>}
        </div>
      ) : <p className="muted small">Nothing recorded yet.</p>}
    </Card>
  );
}

// ------------------------------------------------------------------ coverage (CMP-06)
function CoverageTab({ c }: { c: Comparison }) {
  const cov = c.summary.coverage;
  return (
    <div className="split">
      <Card title="Enquiry coverage" flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Vendor</th><th>Participation</th><th>Detail</th></tr></thead>
            <tbody>{cov.vendors.map((v) => (
              <tr key={v.vendor_id}><td><Link to={`/vendors/${v.vendor_id}`}>{v.name}</Link><div className="small mono subtle">{v.sap_code ?? 'No SAP code'}</div></td>
                <td><Badge tone={v.status === 'Responded' ? 'ok' : v.status === 'Declined' ? 'warn' : 'bad'}>{v.status}</Badge></td><td className="small">{v.detail ?? '—'}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </Card>
      <div className="stack">
        <Card title="Response">
          <Ring value={cov.coverage_pct ?? 0} label={<><strong>{cov.responded} of {cov.invited}</strong><div className="small muted">invited vendors responded</div></>} />
          <div style={{ marginTop: 12 }}><KV items={[['Invited', cov.invited], ['Responded', cov.responded], ['Declined', cov.declined], ['Non-participating', cov.non_participating]]} /></div>
        </Card>
        <Card title="Quotation terms">
          <div className="stack-sm">
            {c.summary.vendors.map((v) => (
              <div key={v.vendor_id} className="small" style={{ borderBottom: '1px solid var(--steel-100)', paddingBottom: 8 }}>
                <strong>{v.name}</strong> <Status value={v.quotation_status} />
                <div className="muted">{v.delivery_terms ?? '—'} · {v.payment_terms ?? '—'}{v.credit_days != null ? ` (${v.credit_days} d)` : ''} · valid to {fmtDate(v.validity_date)} · {v.lines_quoted}/{v.lines_total} lines</div>
                {v.remarks && <div>{v.remarks}</div>}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ discounts (CMP-03, DEC-18)
function DiscountTab({ c, manage }: { c: Comparison; manage: boolean }) {
  const editable = manage && c.editable;
  const [lineId, setLineId] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [late, setLate] = useState('');
  const [risk, setRisk] = useState('');
  const [reason, setReason] = useState('');
  const inv = [['cmp'], ['approvals']];
  const add = useAction(() => api.post(`/cmp/${c.id}/discounts`, { rfq_line_id: Number(lineId), vendor_id: Number(vendorId), late: Number(late || 0), risk: Number(risk || 0), reason }), {
    success: 'Discount saved as draft', invalidate: inv, silentError: true, onSuccess: () => { setLate(''); setRisk(''); setReason(''); },
  });
  const remove = useAction((b: { rfq_line_id: number; vendor_id: number }) => api.post(`/cmp/${c.id}/discounts/remove`, b), { success: 'Draft discount removed', invalidate: inv });
  const send = useAction(() => api.post(`/cmp/${c.id}/discounts/submit`), { success: 'Discounts sent for approval', invalidate: inv });
  const list = c.late_discount ?? [];
  const row = c.rows.find((r) => String(r.rfq_line_id) === lineId);
  const def = c.params.discounts;
  return (
    <div className="split">
      <Card title="Late and risk discounts" flush>
        {list.length === 0 ? <Empty title="No late or risk discounts" icon={<Percent size={24} />}>Late and risk discounts are separate from the quoted discount and change landed cost only after approval.</Empty> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Line</th><th>Vendor</th><th className="num">Late (LD)</th><th className="num">Risk (RD)</th><th>Reason</th><th>Status</th><th /></tr></thead>
              <tbody>{list.map((d) => {
                const r = c.rows.find((x) => x.rfq_line_id === d.rfq_line_id);
                const v = r?.cells.find((x) => x.vendor_id === d.vendor_id);
                return (
                  <tr key={`${d.rfq_line_id}-${d.vendor_id}-${d.requested_at}`}>
                    <td>{r?.line_no} · {r?.description}</td><td>{v?.vendor_name}</td><td className="num">{fmtMoney(d.late)}</td><td className="num">{fmtMoney(d.risk)}</td><td className="small">{d.reason}</td>
                    <td><Status value={d.status} />{d.approval_id && <div><Ref to={`/approvals/${d.approval_id}`}>approval</Ref></div>}</td>
                    <td>{editable && d.status === 'Draft' && <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => remove.fire({ rfq_line_id: d.rfq_line_id, vendor_id: d.vendor_id })}>Remove draft</Button>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        {editable && list.some((d) => d.status === 'Draft') && (
          <div className="card__foot row between"><span className="small muted">Drafts are not applied. Send them for approval ({def.approval_required ? 'required' : 'not required by configuration'}).</span><Button variant="decision" icon={<Send />} loading={send.busy} onClick={send.fire}>Send discounts for approval</Button></div>
        )}
      </Card>
      <div className="stack">
        {editable && (
          <Card title="Add a discount">
            <div className="stack">
              <ErrorSummary error={add.error} />
              <Field label="Line" required><Select value={lineId} onChange={(e) => { setLineId(e.target.value); setVendorId(''); }} placeholder="Choose a line" options={c.rows.map((r) => ({ value: r.rfq_line_id, label: `${r.line_no} · ${r.description}` }))} /></Field>
              <Field label="Vendor" required><Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} placeholder="Choose a vendor" options={(row?.cells ?? []).filter((x) => !x.no_quote).map((x) => ({ value: x.vendor_id, label: `${x.vendor_name} — landed ${fmtMoney(x.landed_before_discounts)}` }))} /></Field>
              <div className="grid-2">
                <Field label="Late discount (₹)" hint={def.late_discount}><Input type="number" min={0} value={late} onChange={(e) => setLate(e.target.value)} /></Field>
                <Field label="Risk discount (₹)" hint={def.risk_discount}><Input type="number" min={0} value={risk} onChange={(e) => setRisk(e.target.value)} /></Field>
              </div>
              <Field label="Reason" required hint="At least 10 characters."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <Button variant="deep" loading={add.busy} disabled={!lineId || !vendorId || (!Number(late) && !Number(risk)) || reason.trim().length < 10} onClick={add.fire}>Save draft discount</Button>
            </div>
          </Card>
        )}
        <Card title="Definitions"><p className="small">{def.late_discount}. {def.risk_discount}. Both reduce landed cost as separate amounts (LD, RD) and need approval before use. <DecisionTag id="DEC-18" /></p></Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ approvals
function ApprovalsTab({ c }: { c: Comparison }) {
  return (
    <div className="split">
      <Card title="Approval requests" flush>
        {c.approvals.length === 0 ? <Empty title="Nothing sent for approval yet">Record the recommendation, then send it for approval.</Empty> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Request</th><th>Type</th><th>Status</th><th className="num">Value</th><th>Level</th><th>Raised</th><th>Decided</th></tr></thead>
              <tbody>{c.approvals.map((a) => (
                <tr key={a.id}><td><Ref to={`/approvals/${a.id}`}>{a.req_no}</Ref></td><td className="small">{a.title}</td><td><Status value={a.status} /></td><td className="num">{fmtLakh(a.value)}</td><td>{a.current_level}{a.matrix_version ? <span className="small subtle"> · matrix v{a.matrix_version}</span> : null}</td><td className="nowrap">{fmtDateTime(a.created_at)}</td><td className="nowrap">{fmtDateTime(a.decided_at)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="stack">
        <Card title="Versions">
          <ol className="timeline">
            {c.versions.map((v) => (
              <li key={v.id}><span className="timeline__dot" data-tone={v.id === c.id ? 'decision' : undefined} /><div className="timeline__title">{v.id === c.id ? `Version ${v.version} (this)` : <Link to={`/comparisons/${v.id}`}>Version {v.version}</Link>} <Status value={v.status} /></div><div className="timeline__meta">{fmtDateTime(v.created_at)}</div></li>
            ))}
          </ol>
        </Card>
        {c.pdf && (
          <Card title="Locked PDF">
            <p className="small">Approved statement locked {fmtDateTime(c.pdf.created_at)}.</p>
            <a className="btn btn--secondary btn--sm" href={downloadUrl(`/files/${c.pdf.id}/download`)}><FileText size={14} /> {c.pdf.filename}</a>
          </Card>
        )}
      </div>
    </div>
  );
}
