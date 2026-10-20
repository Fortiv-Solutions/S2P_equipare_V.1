import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BellRing, Download, MessageSquarePlus, Siren, X } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { useAuth, useMeta } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtNum, plural } from '@/lib/format';
import { Badge, Button, Card, Freshness, Kpi, PageHeader, Priority, Ref, Status, Tabs } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { ReasonDialog } from '@/components/overlay';
import { Input } from '@/components/forms';
import { AckStatus, CommitCell, FollowupDialog } from './shared';
import type { PoListRow, PoSummary } from './types';

type Tab = 'needs' | 'open' | 'closed' | 'all';
const DATE_KEYS = ['po_from', 'po_to', 'rfq_from', 'rfq_to'] as const;

/** SCR-POM-01 — open PO dashboard (FR-POM-04/05/06/07/08, RPT-04/05). */
export default function PoDashboardPage() {
  const { can } = useAuth();
  const meta = useMeta();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'needs';
  const setTab = (t: Tab) => { sp.set('tab', t); setSp(sp, { replace: true }); };
  const dates = Object.fromEntries(DATE_KEYS.map((k) => [k, sp.get(k) ?? ''])) as Record<(typeof DATE_KEYS)[number], string>;
  const setDate = (k: string, v: string) => { if (v) sp.set(k, v); else sp.delete(k); setSp(sp, { replace: true }); };
  const initialFilters = useMemo(() => {
    const f: Record<string, string> = {};
    for (const k of ['ack', 'overdue', 'urgency', 'vendor', 'buyer', 'plant', 'material_group']) { const v = sp.get(k); if (v) f[k] = v; }
    return f;
  }, [sp]);

  const summary = useQuery<PoSummary>({ queryKey: ['po', 'summary'], queryFn: () => api.get('/po/summary') });
  const lines = useQuery<PoListRow[]>({ queryKey: ['po', 'lines', tab, dates], queryFn: () => api.get('/po/lines', { tab, ...dates }) });

  const [fuFor, setFuFor] = useState<PoListRow | null>(null);
  const [escFor, setEscFor] = useState<PoListRow | null>(null);
  const inv = [['po']];
  const remind = useAction((poIds: number[]) => api.post<{ succeeded: number; failed: number; results: { ok: boolean; message?: string; po_no?: string }[] }>('/po/remind', { po_ids: poIds }), {
    success: (r) => `Reminders sent for ${plural(r.succeeded, 'PO')}${r.failed ? `; ${r.failed} not sent (${r.results.find((x) => !x.ok)?.message})` : ''}`, invalidate: inv,
  });
  const escalate = useAction((id: number, reason: string) => api.post<{ level: number; to: string; po_no: string }>(`/po/pos/${id}/escalate`, { reason }), { success: (r) => `PO ${r.po_no} escalated to level ${r.level} (${r.to})`, invalidate: inv });
  const canFollow = can('po.followup');

  const columns: Column<PoListRow>[] = useMemo(() => [
    { key: 'ref', header: 'PO / item', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Ref to={`/pos/${r.po_id}`}>{r.ref}</Ref>{r.version > 1 && <span className="small subtle">Version {r.version}</span>}</div>, nowrap: true },
    { key: 'po_date', header: 'PO date', render: (r) => fmtDate(r.po_date), nowrap: true },
    { key: 'vendor_name', header: 'Vendor', render: (r) => <div style={{ minWidth: 150 }}><div style={{ fontWeight: 600 }}>{r.vendor_name}</div><div className="small subtle mono">{r.vendor_code}</div></div> },
    { key: 'description', header: 'Material', render: (r) => <div style={{ minWidth: 200 }}><div>{r.description}</div><div className="small subtle mono">{r.material_code}{r.material_group ? ` · ${r.material_group}` : ''}</div></div>, value: (r) => `${r.description} ${r.material_code ?? ''}` },
    { key: 'urgency', header: 'Urgency', render: (r) => <Priority value={r.urgency} /> },
    { key: 'open_qty', header: 'Open / ordered', align: 'right', render: (r) => <span className="num">{fmtNum(r.open_qty)} / {fmtNum(r.qty)} {r.uom}</span>, value: (r) => r.open_qty },
    { key: 'ack_status', header: 'Acknowledgement', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><AckStatus l={r} />{r.ack_overdue && <span className="small" style={{ color: 'var(--bad)', fontWeight: 600 }}>Past due {fmtDate(r.ack_due_at)}</span>}{!r.viewed_at && r.ack_status === 'Pending' && <span className="small subtle">Not opened</span>}</div> },
    { key: 'commitment', header: 'Commitment', render: (r) => <CommitCell l={r} />, value: (r) => r.commitment },
    { key: 'delay_reason', header: 'Delay reason', render: (r) => r.delay_reason ? <span style={{ color: 'var(--warn)', fontWeight: 600 }}>{r.delay_reason}</span> : <span className="subtle">—</span> },
    { key: 'next_action', header: 'Next action', render: (r) => <div style={{ minWidth: 170 }}><span style={{ fontWeight: r.needs_action ? 700 : 500, color: r.needs_action ? 'var(--bad)' : undefined }}>{r.next_action}</span>{r.escalation_level > 0 && <div><Badge tone="bad">Escalated L{r.escalation_level}</Badge></div>}{r.amendment && <div className="small muted">{r.amendment.amd_no}: {r.amendment.status}</div>}</div> },
    { key: 'buyer_name', header: 'Buyer' },
    { key: 'plant', header: 'Plant' },
    { key: 'reminders', header: 'Reminders', align: 'right', hidden: true },
    { key: 'last_followup', header: 'Latest follow-up', hidden: true, render: (r) => r.last_followup ? <span className="small">{r.last_followup.kind} · {fmtDate(r.last_followup.at)}</span> : '—', value: (r) => r.last_followup ? `${r.last_followup.kind} ${r.last_followup.at.slice(0, 10)}` : '' },
    { key: 'material_group', header: 'Material group', hidden: true },
    { key: 'rfq_date', header: 'RFQ date', hidden: true, render: (r) => fmtDate(r.rfq_date) },
    { key: 'delivery_date', header: 'PO delivery date', hidden: true, render: (r) => fmtDate(r.delivery_date) },
    { key: 'pr_ref', header: 'PR / item', hidden: true },
    ...(canFollow ? [{
      key: 'actions', header: '', sortable: false, exportable: false,
      render: (r: PoListRow) => r.closed ? null : (
        <div className="row" style={{ gap: 2 }}>
          <Button size="sm" variant="ghost" iconOnly icon={<BellRing />} title="Remind vendor" loading={remind.busy} onClick={() => remind.fire([r.po_id])}>Remind vendor about PO {r.po_no}</Button>
          <Button size="sm" variant="ghost" iconOnly icon={<MessageSquarePlus />} title="Log follow-up" onClick={() => setFuFor(r)}>Log follow-up on {r.ref}</Button>
          <Button size="sm" variant="ghost" iconOnly icon={<Siren />} title="Escalate" onClick={() => setEscFor(r)}>Escalate PO {r.po_no}</Button>
        </div>
      ),
    } as Column<PoListRow>] : []),
  ], [canFollow, remind.busy]);

  const s = summary.data;
  const poLines = fuFor ? (lines.data ?? []).filter((x) => x.po_id === fuFor.po_id).map((x) => ({ id: x.id, item: x.item, description: x.description, ack_status: x.ack_status, active: x.active })) : [];
  const drill = (t: Tab, f: Record<string, string>) => { for (const k of ['ack', 'overdue']) sp.delete(k); for (const [k, v] of Object.entries(f)) sp.set(k, v); sp.set('tab', t); setSp(sp, { replace: true }); };
  const hasDates = DATE_KEYS.some((k) => dates[k]);

  return (
    <>
      <PageHeader
        title="Purchase orders" screen="SCR-POM-01" eyebrow="Module 7"
        sub="Released SAP POs published to vendors: acknowledgement, commitments, delays and follow-up for every open line. Newest PO first."
        badges={<Freshness flow="INT-M07" label="POs" />}
        actions={<a className="btn btn--secondary" href={downloadUrl('/po/lines', { tab, ...dates, format: 'csv' })}><Download size={16} /> Export (RPT-04)</a>}
      />
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <Kpi label="Needs action" value={s?.needs_action ?? '—'} tone={s?.needs_action ? 'bad' : undefined} meta={`${s?.open_pos ?? 0} open POs · ${s?.escalated ?? 0} escalated`} onClick={() => drill('needs', {})} />
        <Kpi label="Waiting for acknowledgement" value={s?.pending_ack ?? '—'} tone={s?.ack_overdue ? 'warn' : undefined} meta={`${s?.ack_overdue ?? 0} past the due time`} onClick={() => drill('open', { ack: 'Pending' })} />
        <Kpi label="Delivery overdue" value={s?.overdue ?? '—'} tone={s?.overdue ? 'bad' : undefined} meta="Past the latest commitment" onClick={() => drill('open', { overdue: 'Overdue' })} />
        <Kpi label="Rejected or partial" value={s ? s.rejected + s.partial : '—'} tone={s && s.rejected ? 'warn' : undefined} meta={`${s?.rejected ?? 0} rejected · ${s?.partial ?? 0} partial · ${s?.amendments ?? 0} amendments open`} onClick={() => drill('needs', {})} />
      </div>

      <Tabs<Tab> value={tab} onChange={(t) => { for (const k of ['ack', 'overdue']) sp.delete(k); setTab(t); }} tabs={[
        { id: 'needs', label: 'Needs action', count: s?.counts.needs },
        { id: 'open', label: 'Open', count: s?.counts.open },
        { id: 'closed', label: 'Closed & cancelled', count: s?.counts.closed },
        { id: 'all', label: 'All', count: s?.counts.all },
      ]} />

      <Card flush>
        <div className="row-wrap" style={{ padding: '12px 14px 0', gap: 10 }}>
          <span className="small muted">PO date</span>
          <Input type="date" aria-label="PO date from" value={dates.po_from} onChange={(e) => setDate('po_from', e.target.value)} style={{ width: 150 }} />
          <span className="small subtle">to</span>
          <Input type="date" aria-label="PO date to" value={dates.po_to} onChange={(e) => setDate('po_to', e.target.value)} style={{ width: 150 }} />
          <span className="small muted" style={{ marginLeft: 8 }}>RFQ date</span>
          <Input type="date" aria-label="RFQ date from" value={dates.rfq_from} onChange={(e) => setDate('rfq_from', e.target.value)} style={{ width: 150 }} />
          <span className="small subtle">to</span>
          <Input type="date" aria-label="RFQ date to" value={dates.rfq_to} onChange={(e) => setDate('rfq_to', e.target.value)} style={{ width: 150 }} />
          {hasDates && <Button size="sm" variant="ghost" icon={<X />} onClick={() => { DATE_KEYS.forEach((k) => sp.delete(k)); setSp(sp, { replace: true }); }}>Clear dates</Button>}
        </div>
        <DataTable
          id="po-dashboard" rows={lines.data} loading={lines.isLoading} error={lines.error} refetch={lines.refetch}
          rowKey={(r) => r.id} rowLink={(r) => `/pos/${r.po_id}`} columns={columns} initialSort={{ key: 'po_date', dir: 'desc' }}
          initialFilters={initialFilters}
          selectable={canFollow ? (r) => !r.closed : false}
          filters={[
            { key: 'buyer', label: 'Buyer', value: (r) => r.buyer_name },
            { key: 'vendor', label: 'Vendor', value: (r) => r.vendor_name },
            { key: 'plant', label: 'Plant', value: (r) => r.plant },
            { key: 'material_group', label: 'Material group', value: (r) => r.material_group },
            { key: 'urgency', label: 'Urgency', value: (r) => r.urgency, options: ['BD', 'Urgent', 'General stock', 'Class 1'] },
            { key: 'ack', label: 'Acknowledgement', value: (r) => r.ack_status, options: ['Pending', 'Pending re-acknowledgement', 'Accepted', 'Partially accepted', 'Rejected', 'Deemed accepted', 'Cancelled'] },
            { key: 'overdue', label: 'Delivery', value: (r) => (r.overdue ? 'Overdue' : r.dispatch_due ? 'Dispatch due' : 'On time'), options: ['Overdue', 'Dispatch due', 'On time'] },
          ]}
          searchPlaceholder="Search PO, vendor, material…"
          bulkActions={(rows, clear) => (
            <Button size="sm" variant="primary" icon={<BellRing />} loading={remind.busy} onClick={async () => { await remind.fire([...new Set(rows.map((r) => r.po_id))]); clear(); }}>
              Remind vendors ({plural(new Set(rows.map((r) => r.po_id)).size, 'PO')})
            </Button>
          )}
          empty={<div className="empty"><div className="empty__title">{tab === 'needs' ? 'Nothing needs action' : 'No PO lines in this view'}</div><div>{tab === 'needs' ? 'Every open line is acknowledged, on time and followed up.' : 'Released POs arrive from SAP on the next sync.'}</div></div>}
          mobile={{
            title: (r) => <><span className="mono">{r.ref}</span> · {r.vendor_name}</>,
            badge: (r) => <Status value={r.ack_status} />,
            meta: (r) => [<Priority key="u" value={r.urgency} />, r.description, `${fmtNum(r.open_qty)} ${r.uom} open`, r.commit_date ? `Commit ${fmtDate(r.commit_date)}` : `Due ${fmtDate(r.delivery_date)}`, <span key="n" style={{ color: r.needs_action ? 'var(--bad)' : undefined, fontWeight: r.needs_action ? 700 : 500 }}>{r.next_action}</span>],
          }}
        />
      </Card>

      <FollowupDialog open={!!fuFor} onClose={() => setFuFor(null)} invalidate={inv} lineId={fuFor?.id}
        po={fuFor ? { id: fuFor.po_id, po_no: fuFor.po_no, lines: poLines, reasons: meta.data?.lists.delayReasons ?? [] } : null} />
      <ReasonDialog open={!!escFor} onClose={() => setEscFor(null)} title={`Escalate PO ${escFor?.po_no ?? ''}`} variant="danger" confirmLabel="Escalate"
        sub={`Goes to the next level of the escalation matrix (level 2: buyer's manager, level 3: Management). The requisitioner is informed.${escFor?.escalation_level ? ` Currently at level ${escFor.escalation_level}.` : ''}`}
        onSubmit={(reason) => escalate.run(escFor!.po_id, reason)} />
    </>
  );
}
