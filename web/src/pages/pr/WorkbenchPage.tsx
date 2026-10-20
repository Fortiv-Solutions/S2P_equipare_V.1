import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, Send, UserPlus, UserRound, Repeat, Download } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtLakh, plural } from '@/lib/format';
import { Button, ButtonLink, Card, Freshness, Kpi, PageHeader, Priority, Ref, Status, Tabs, Segmented, Callout } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal } from '@/components/overlay';
import { Field, Select, Textarea } from '@/components/forms';
import { Bars } from '@/components/charts';
import type { PrLine } from './types';

type View = 'mine' | 'priority' | 'unassigned' | 'repeat' | 'open' | 'all' | 'ageing';

export default function WorkbenchPage() {
  const { can, me } = useAuth();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const isManager = can('pr.assign') && me?.role === 'APR';
  const view = (sp.get('view') as View) ?? (isManager ? 'open' : 'mine');
  const setView = (v: View) => { sp.set('view', v); setSp(sp, { replace: true }); };
  const filters = { plant: sp.get('plant') ?? undefined, priority: sp.get('priority') ?? undefined, status: sp.get('status') ?? undefined, route: sp.get('route') ?? undefined, material: sp.get('material') ?? undefined, buyer: sp.get('buyer') ?? undefined, material_group: sp.get('material_group') ?? undefined };

  const summary = useQuery<Record<string, number>>({ queryKey: ['pr', 'summary'], queryFn: () => api.get('/pr/summary') });
  const lines = useQuery<PrLine[]>({ queryKey: ['pr', 'lines', view, filters], queryFn: () => api.get('/pr/lines', { view: view === 'ageing' ? 'open' : view, ...filters }), enabled: view !== 'ageing' });
  const buyers = useQuery<{ id: number; name: string }[]>({ queryKey: ['pr', 'buyers'], queryFn: () => api.get('/pr/buyers') });

  const [assignFor, setAssignFor] = useState<PrLine[] | null>(null);
  const [basketProblems, setBasketProblems] = useState<{ ref: string; problem: string }[] | null>(null);

  const bulkChecks = useAction((ids: number[]) => api.post<{ succeeded: number; failed: number }>('/pr/bulk', { action: 'checks', ids }), {
    success: (r) => `Checks ran on ${plural(r.succeeded, 'line')}${r.failed ? `, ${r.failed} failed` : ''}`, invalidate: [['pr']],
  });
  const basket = useAction((ids: number[]) => api.post<{ ok: boolean; problems: { ref: string; problem: string }[] }>('/pr/basket-check', { ids }), { silentError: false });

  const addToRfq = async (rows: PrLine[]) => {
    const r = await basket.run(rows.map((x) => x.id));
    if (r.ok) navigate(`/rfqs/new?lines=${rows.map((x) => x.id).join(',')}`);
    else setBasketProblems(r.problems);
  };

  const columns: Column<PrLine>[] = useMemo(() => [
    { key: 'ref', header: 'PR / item', render: (r) => <Ref to={`/pr/${r.id}`}>{r.ref}</Ref>, nowrap: true },
    { key: 'description', header: 'Material', render: (r) => (<div style={{ minWidth: 220 }}><div style={{ fontWeight: 600 }}>{r.description}</div><div className="small subtle mono">{r.material_code}{r.repeat_flag ? ' · ' : ''}{r.repeat_flag ? <span style={{ color: 'var(--warn)', fontFamily: 'var(--font-text)', fontWeight: 600 }}>Repeat purchase</span> : null}</div></div>), value: (r) => `${r.description} ${r.material_code}` },
    { key: 'qty', header: 'Qty', align: 'right', render: (r) => <span className="num">{r.qty} {r.uom}</span>, value: (r) => r.qty },
    { key: 'plant', header: 'Plant' },
    { key: 'priority', header: 'Priority', render: (r) => <Priority value={r.priority} /> },
    { key: 'status', header: 'Status', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Status value={r.status} />{r.sla_breached && <span className="small" style={{ color: 'var(--bad)', fontWeight: 600 }}>SLA breached</span>}{r.flag && <span className="small" style={{ color: 'var(--bad)' }}>{r.flag}</span>}</div> },
    { key: 'route', header: 'Route', render: (r) => r.route ?? (r.route_proposed ? <span className="muted">Proposed: {r.route_proposed}</span> : <span className="subtle">—</span>), value: (r) => r.route ?? r.route_proposed },
    { key: 'buyer_name', header: 'Buyer', render: (r) => r.buyer_name ?? <Status value="Unassigned" /> },
    { key: 'required_date', header: 'Required', render: (r) => fmtDate(r.required_date), nowrap: true },
    { key: 'age_days', header: 'Age', align: 'right', render: (r) => <span className="num" style={{ color: r.age_days > 7 ? 'var(--warn)' : undefined, fontWeight: r.age_days > 7 ? 700 : 500 }}>{r.age_days} d</span>, value: (r) => r.age_days },
    { key: 'est_value', header: 'Est. value', align: 'right', render: (r) => fmtLakh(r.est_value), hidden: true },
    { key: 'rfq_no', header: 'RFQ', render: (r) => (r.rfq_no ? <Ref to={`/rfqs/${r.rfq_id}`}>{r.rfq_no}</Ref> : '—'), hidden: true },
    { key: 'po_no', header: 'PO', render: (r) => r.po_no ?? '—', hidden: true },
    { key: 'requisitioner_name', header: 'Requisitioner', hidden: true },
    { key: 'category', header: 'Category', hidden: true },
  ], []);

  const s = summary.data;
  return (
    <>
      <PageHeader
        title="PR workbench" screen="SCR-PRW-01" eyebrow="Module 1"
        sub="Open purchase requisitions from SAP, with buyer, stock / open PO / VMI / contract checks and the procurement route for each line."
        badges={<Freshness flow="INT-M03" label="PRs" />}
        actions={<>
          {me?.merged && <ButtonLink to="/my-requirements" icon={<UserRound />}>Requirement status cards</ButtonLink>}
          <a className="btn btn--secondary" href={downloadUrl('/pr/lines', { view, format: 'csv', ...filters })}><Download size={16} /> Export all</a>
        </>}
      />
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <Kpi label={isManager ? 'Open PR lines' : 'My open lines'} value={s?.open ?? '—'} onClick={() => setView(isManager ? 'open' : 'mine')} />
        <Kpi label="Awaiting checks or route" value={s?.to_review ?? '—'} meta="Assigned or under review" onClick={() => { sp.set('status', 'Assigned'); setView(isManager ? 'open' : 'mine'); }} />
        <Kpi label="Urgent / BD / Class 1" value={s?.priority ?? '—'} tone={s?.sla_breached ? 'bad' : s?.priority ? 'warn' : undefined} meta={s?.sla_breached ? `${s.sla_breached} past SLA` : 'Within SLA'} onClick={() => setView('priority')} />
        <Kpi label="Ready for RFQ" value={s?.ready_for_rfq ?? '—'} meta={`${s?.contract_po_pending ?? 0} contract PO references pending`} onClick={() => { sp.set('status', 'Route decided'); setView(isManager ? 'open' : 'mine'); }} />
      </div>

      <Tabs<View>
        value={view} onChange={(v) => { ['status', 'plant', 'priority', 'route', 'material', 'buyer', 'material_group'].forEach((k) => sp.delete(k)); setView(v); }}
        tabs={[
          ...(can('pr.work') ? [{ id: 'mine' as View, label: 'Assigned to me' }] : []),
          { id: 'priority', label: 'Priority', count: s?.priority },
          ...(can('pr.assign') ? [{ id: 'unassigned' as View, label: 'Unassigned', count: s?.unassigned }] : []),
          { id: 'repeat', label: 'Repeat purchases', count: s?.repeat },
          { id: 'open', label: 'All open' },
          { id: 'all', label: 'All lines' },
          { id: 'ageing', label: 'Ageing' },
        ]}
      />

      {view === 'ageing' ? <AgeingView onDrill={(k, v) => { sp.set('view', 'open'); if (k === 'buyer') { const b = buyers.data?.find((x) => x.name === v); if (b) sp.set('buyer', String(b.id)); } else if (v !== '—' && v !== 'Not routed' && v !== 'Unassigned') sp.set(k, v); setSp(sp); }} /> : (
        <Card flush>
          {Object.values(filters).some(Boolean) && (
            <div style={{ padding: '10px 14px 0' }}>
              <Callout tone="info">
                Filtered from a dashboard: {Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k} = ${k === 'buyer' ? buyers.data?.find((b) => String(b.id) === v)?.name ?? v : v}`).join(', ')}.{' '}
                <button className="btn btn--ghost btn--sm" onClick={() => { ['status', 'plant', 'priority', 'route', 'material', 'buyer', 'material_group'].forEach((k) => sp.delete(k)); setSp(sp); }}>Clear</button>
              </Callout>
            </div>
          )}
          <DataTable
            id={`pr-workbench`} rows={lines.data} loading={lines.isLoading} error={lines.error} refetch={lines.refetch}
            rowKey={(r) => r.id} rowLink={(r) => `/pr/${r.id}`} columns={columns}
            selectable={(r) => !['PO created', 'Closed', 'Cancelled in SAP'].includes(r.status)}
            filters={[
              { key: 'status', label: 'Status', value: (r) => r.status },
              { key: 'plant', label: 'Plant', value: (r) => r.plant },
              { key: 'priority', label: 'Priority', value: (r) => r.priority },
              { key: 'route', label: 'Route', value: (r) => r.route ?? r.route_proposed },
              { key: 'category', label: 'Category', value: (r) => r.category },
            ]}
            searchPlaceholder="Search PR, material, description…"
            bulkActions={(rows, clear) => (
              <>
                {can('pr.work') && <Button size="sm" variant="secondary" icon={<ClipboardCheck />} loading={bulkChecks.busy} onClick={async () => { await bulkChecks.fire(rows.map((r) => r.id)); clear(); }}>Run checks</Button>}
                {can('pr.assign') && <Button size="sm" variant="secondary" icon={<UserPlus />} onClick={() => setAssignFor(rows)}>Assign buyer</Button>}
                {can('rfq.manage') && <Button size="sm" variant="primary" icon={<Send />} loading={basket.busy} onClick={() => addToRfq(rows).catch(() => undefined)} className="desktop-only">Create RFQ from {rows.length}</Button>}
              </>
            )}
            empty={<div className="empty"><div className="empty__title">No PR lines in this view</div><div>New released PRs arrive from SAP on the next sync.</div></div>}
            mobile={{
              title: (r) => <><span className="mono">{r.ref}</span> · {r.description}</>,
              badge: (r) => <Status value={r.status} />,
              meta: (r) => [<Priority key="p" value={r.priority} />, `${r.qty} ${r.uom}`, r.plant, r.buyer_name ?? 'Unassigned', `${r.age_days} d old`],
            }}
          />
        </Card>
      )}

      <AssignDialog rows={assignFor} buyers={buyers.data ?? []} onClose={() => setAssignFor(null)} />
      <Modal open={!!basketProblems} onClose={() => setBasketProblems(null)} title="These lines cannot go into one RFQ yet" footer={<Button variant="deep" onClick={() => setBasketProblems(null)}>Back to workbench</Button>}>
        <ul className="stack-sm" style={{ paddingLeft: 18, margin: 0 }}>
          {basketProblems?.map((p, i) => <li key={i}><span className="mono">{p.ref}</span> — {p.problem}</li>)}
        </ul>
      </Modal>
    </>
  );
}

function AssignDialog({ rows, buyers, onClose }: { rows: PrLine[] | null; buyers: { id: number; name: string }[]; onClose: () => void }) {
  const [buyer, setBuyer] = useState('');
  const [reason, setReason] = useState('');
  const act = useAction(() => api.post<{ succeeded: number; failed: number; results: { ok: boolean; message?: string }[] }>('/pr/bulk', { action: 'assign', ids: rows!.map((r) => r.id), buyer_id: Number(buyer), reason }), {
    success: (r) => `${plural(r.succeeded, 'line')} assigned${r.failed ? `; ${r.failed} not changed (${r.results.find((x) => !x.ok)?.message})` : ''}`, invalidate: [['pr']], onSuccess: () => { setBuyer(''); setReason(''); onClose(); },
  });
  const reassigning = rows?.some((r) => r.buyer_id && String(r.buyer_id) !== buyer);
  return (
    <Modal open={!!rows} onClose={onClose} title={`Assign ${plural(rows?.length ?? 0, 'line')}`} sub="The buyer is notified, and the requisitioner sees who is handling the line."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={act.busy} disabled={!buyer || (reassigning && reason.trim().length < 10)} onClick={act.fire}>Assign</Button></>}>
      <div className="stack">
        <Field label="Buyer" required><Select value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="Choose a buyer" options={buyers.map((b) => ({ value: b.id, label: b.name }))} /></Field>
        {reassigning && <Field label="Reason for reassignment" required hint="At least 10 characters. Recorded in the audit trail."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} /></Field>}
      </div>
    </Modal>
  );
}

function AgeingView({ onDrill }: { onDrill: (dim: string, value: string) => void }) {
  const [by, setBy] = useState<'buyer' | 'plant' | 'material_group' | 'priority' | 'route'>('buyer');
  const q = useQuery<{ buckets: string[]; rows: { key: string; total: number; counts: number[]; maxAge: number }[]; total: number }>({ queryKey: ['pr', 'ageing', by], queryFn: () => api.get('/pr/ageing', { by }) });
  return (
    <Card title={<div className="row-wrap"><h2>PR ageing</h2><span className="muted small">{q.data?.total ?? 0} open lines · RPT-01</span></div>}
      actions={<Segmented label="Group by" value={by} onChange={setBy} options={[{ id: 'buyer', label: 'Buyer' }, { id: 'plant', label: 'Plant' }, { id: 'material_group', label: 'Material group' }, { id: 'priority', label: 'Priority' }, { id: 'route', label: 'Route' }]} />}>
      {q.data && (
        <Bars
          title="PR ageing by bucket" legend={q.data.buckets}
          data={q.data.rows.map((r) => ({ label: r.key, value: r.total, parts: r.counts.map((c, i) => ({ label: q.data!.buckets[i], value: c })), onClick: () => onDrill(by, r.key), hint: `Oldest: ${r.maxAge} days` }))}
        />
      )}
      <p className="small muted" style={{ marginTop: 12 }}><Repeat size={12} /> Select a bar to open those lines. Age counts calendar days from when the line arrived from SAP (working-day basis pending DEC-15).</p>
    </Card>
  );
}
