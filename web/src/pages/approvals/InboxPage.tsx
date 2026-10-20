import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, ShieldAlert, UserRoundCog, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDateTime, fmtLakh, plural } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, Kpi, PageHeader, Ref, Segmented, Status, Tabs, DecisionTag } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Bars } from '@/components/charts';
import { Field, Input, Select, ErrorSummary } from '@/components/forms';
import { Modal } from '@/components/overlay';
import type { AgeingData, ApprovalItem, Delegation, Summary } from './types';

type Tab = 'mine' | 'raised' | 'all';

const band = (v: number | null) => (v == null ? 'No value' : v < 100000 ? 'Under ₹1 L' : v < 500000 ? '₹1–5 L' : v < 2500000 ? '₹5–25 L' : '₹25 L and over');
const BANDS = ['Under ₹1 L', '₹1–5 L', '₹5–25 L', '₹25 L and over', 'No value'];

export default function InboxPage() {
  const { can, me } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? (can('apr.decide') ? 'mine' : 'raised');
  const role = sp.get('role') ?? undefined;
  const bucket = sp.get('bucket') ?? undefined;
  const set = (patch: Record<string, string | null>) => { for (const [k, v] of Object.entries(patch)) v ? sp.set(k, v) : sp.delete(k); setSp(sp, { replace: true }); };
  const summary = useQuery<Summary>({ queryKey: ['approvals', 'summary'], queryFn: () => api.get('/approvals/summary') });
  const list = useQuery<ApprovalItem[]>({
    queryKey: ['approvals', 'list', tab, role, bucket],
    queryFn: () => api.get('/approvals', { tab, role, bucket, status: tab === 'all' && (role || bucket) ? 'open' : undefined }),
  });
  const [delegOpen, setDelegOpen] = useState(false);
  const [bulkRows, setBulkRows] = useState<ApprovalItem[] | null>(null);
  const s = summary.data;
  const canAgeing = can('apr.view', 'apr.decide');

  const columns: Column<ApprovalItem>[] = useMemo(() => [
    { key: 'req_no', header: 'Request', render: (r) => <Ref to={`/approvals/${r.id}`}>{r.req_no}</Ref>, nowrap: true },
    { key: 'title', header: 'What needs a decision', render: (r) => (<div style={{ minWidth: 240 }}><div style={{ fontWeight: 600 }}>{r.title}</div><div className="small muted">{r.summary ?? r.type_label}</div></div>), value: (r) => `${r.title} ${r.summary ?? ''}` },
    { key: 'type_label', header: 'Type', render: (r) => <div className="row-wrap" style={{ gap: 4 }}><span>{r.type_label}</span>{r.category === 'exception' && <Badge tone="decision">Exception</Badge>}</div>, value: (r) => r.type_label },
    { key: 'value', header: 'Value', align: 'right', render: (r) => (r.value != null ? fmtLakh(r.value) : '—') },
    { key: 'status', header: 'Status', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Status value={r.status} />{r.waiting_on_label && <span className="small muted">L{r.current_level}: {r.waiting_on_label}</span>}</div> },
    { key: 'requester_name', header: 'Raised by' },
    { key: 'age_days', header: 'Age', align: 'right', render: (r) => <span className="num" style={{ color: r.bucket && r.age_days >= 3 ? 'var(--warn)' : undefined, fontWeight: r.age_days >= 3 ? 700 : 500 }}>{r.age_days < 1 ? `${r.age_hours} h` : `${r.age_days} d`}</span>, value: (r) => r.age_hours },
    { key: 'linked', header: 'Record', render: (r) => (r.linked.link ? <Ref to={r.linked.link}>{r.linked.ref ?? r.linked.label}</Ref> : '—'), value: (r) => r.linked.ref, hidden: true },
    { key: 'created_at', header: 'Raised', render: (r) => fmtDateTime(r.created_at), hidden: true, nowrap: true },
  ], []);

  return (
    <>
      <PageHeader title="Approvals" screen="SCR-APR-01" eyebrow="Module 5"
        sub="Requests waiting for your decision, requests you raised, and — with the right role — everything in the approval workflow."
        actions={<>
          {me?.merged && <ButtonLink to="/exceptions" icon={<ShieldAlert />}>Exception register</ButtonLink>}
          {can('apr.decide') && !me?.singleUser && <Button icon={<UserRoundCog />} onClick={() => setDelegOpen(true)}>Delegate my approvals</Button>}
        </>} />
      <DelegationBanner onOpen={() => setDelegOpen(true)} />
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <Kpi label="Waiting for me" value={s?.mine ?? '—'} meta={s ? `${fmtLakh(s.mine_value)} in total` : undefined} tone={s?.mine ? 'warn' : undefined} onClick={() => set({ tab: 'mine', role: null, bucket: null })} />
        <Kpi label="Waiting beyond 3 days" value={s?.mine_overdue ?? '—'} tone={s?.mine_overdue ? 'bad' : undefined} meta="Reminders and escalation follow the approval timing setting" onClick={() => set({ tab: 'mine', role: null, bucket: null })} />
        <Kpi label="Raised by me, open" value={s?.raised_open ?? '—'} onClick={() => set({ tab: 'raised', role: null, bucket: null })} />
        <Kpi label="Questions to answer" value={s?.clarifications ?? '—'} tone={s?.clarifications ? 'warn' : undefined} meta="Clarification requested on my requests" onClick={() => set({ tab: 'raised', role: null, bucket: null })} />
      </div>

      {canAgeing && <AgeingCard buckets={s?.buckets} onDrill={(r, b) => set({ tab: 'all', role: r, bucket: b })} />}
      <div style={{ height: 16 }} />

      <Tabs<Tab> value={tab} onChange={(t) => set({ tab: t, role: null, bucket: null })} tabs={[
        ...(can('apr.decide') ? [{ id: 'mine' as Tab, label: 'Waiting for me', count: s?.mine }] : []),
        { id: 'raised', label: 'Raised by me', count: s?.raised_open || undefined },
        ...(s?.can_all ? [{ id: 'all' as Tab, label: 'All requests', count: s.all_open ?? undefined }] : []),
      ]} />

      {(role || bucket) && (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="info">Filtered from the ageing dashboard: {[role && `waiting on ${role}`, bucket && `age ${bucket}`].filter(Boolean).join(', ')}. <Button size="sm" variant="ghost" icon={<X />} onClick={() => set({ role: null, bucket: null })}>Clear</Button></Callout>
        </div>
      )}
      <Card flush>
        <DataTable
          id={`approvals-${tab}`} rows={list.data} loading={list.isLoading} error={list.error} refetch={list.refetch}
          rowKey={(r) => r.id} rowLink={(r) => `/approvals/${r.id}`} columns={columns} initialSort={tab === 'mine' ? { key: 'age_days', dir: 'desc' } : undefined}
          selectable={tab === 'mine' ? (r) => r.bulk_allowed : false}
          bulkActions={(rows) => <Button size="sm" variant="primary" icon={<CheckCheck />} onClick={() => setBulkRows(rows)}>Approve {rows.length}</Button>}
          filters={[
            { key: 'type', label: 'Type', value: (r) => r.type_label },
            { key: 'value', label: 'Value', value: (r) => band(r.value), options: BANDS },
            { key: 'age', label: 'Age', value: (r) => r.bucket ?? (r.status === 'Pending' || r.status === 'Clarification requested' ? null : 'Closed'), options: [...(s?.buckets ?? []), 'Closed'] },
            ...(tab !== 'mine' ? [{ key: 'status', label: 'Status', value: (r: ApprovalItem) => r.status }] : []),
          ]}
          searchPlaceholder="Search request, title, record…"
          empty={<div className="empty"><div className="empty__title">{tab === 'mine' ? 'Nothing is waiting for you' : 'No requests here'}</div><div>{tab === 'mine' ? 'New requests appear here and in your notifications.' : 'Requests you raise from comparisons, routes, POs and advances are listed here.'}</div></div>}
          mobile={{
            title: (r) => <><span className="mono">{r.req_no}</span> · {r.title}</>,
            badge: (r) => <Status value={r.status} />,
            meta: (r) => [r.type_label, r.value != null ? fmtLakh(r.value) : 'No value', `Raised by ${r.requester_name ?? '—'}`, r.age_days < 1 ? `${r.age_hours} h old` : `${r.age_days} d old`, r.waiting_on_label ? `Level ${r.current_level}: ${r.waiting_on_label}` : ''].filter(Boolean),
          }}
        />
        {tab === 'mine' && (s?.bulk_types.length ?? 0) === 0 && (
          <div className="card__foot small muted">Bulk approval is off: every request is opened and decided individually. Types allowed for bulk approval are set in Business rules <DecisionTag id="Q 10.3" />.</div>
        )}
      </Card>
      <DelegationDialog open={delegOpen} onClose={() => setDelegOpen(false)} />
      <BulkDialog rows={bulkRows} onClose={() => setBulkRows(null)} />
      {me && null}
    </>
  );
}

function AgeingCard({ buckets, onDrill }: { buckets?: string[]; onDrill: (role: string | null, bucket: string | null) => void }) {
  const [by, setBy] = useState<'approver' | 'level' | 'type'>('approver');
  const q = useQuery<AgeingData>({ queryKey: ['approvals', 'ageing', by], queryFn: () => api.get('/approvals/ageing', { by }) });
  return (
    <Card title={<div className="row-wrap"><h2>Approval ageing</h2><span className="muted small">{q.data?.total ?? 0} open requests · APP-05</span></div>}
      actions={<Segmented label="Group by" value={by} onChange={setBy} options={[{ id: 'approver', label: 'Approver' }, { id: 'level', label: 'Level' }, { id: 'type', label: 'Type' }]} />}>
      {q.data && (
        <Bars title="Open approvals by age" legend={q.data.buckets}
          data={q.data.rows.map((r) => ({
            label: r.label, value: r.total, parts: r.counts.map((c, i) => ({ label: q.data!.buckets[i], value: c })), hint: `Oldest ${r.oldest} days${r.names ? ` · ${r.names}` : ''}`,
            onClick: by === 'approver' && r.key !== 'requester' ? () => onDrill(r.key, null) : () => onDrill(null, null),
          }))} />
      )}
      {q.data && q.data.rows.length > 0 && (
        <div className="row-wrap" style={{ marginTop: 10, gap: 6 }}>
          <span className="small muted">Open the requests in a bucket:</span>
          {(buckets ?? q.data.buckets).map((b, i) => {
            const n = q.data!.rows.reduce((t, r) => t + r.counts[i], 0);
            return <Button key={b} size="sm" variant="secondary" disabled={!n} onClick={() => onDrill(null, b)}>{b} · {n}</Button>;
          })}
        </div>
      )}
      <p className="small muted" style={{ marginTop: 10 }}>Select a bar to open that approver's requests. Age counts calendar days since the request was raised.</p>
    </Card>
  );
}

function DelegationBanner({ onOpen }: { onOpen: () => void }) {
  const q = useQuery<Delegation>({ queryKey: ['approvals', 'delegation'], queryFn: () => api.get('/approvals/delegation') });
  const d = q.data;
  if (!d || (!d.active && !d.incoming.length)) return null;
  return (
    <div style={{ marginBottom: 16 }} className="stack-sm">
      {d.active && <Callout tone="info" title="Your approvals are delegated">{d.delegate?.name} can approve on your behalf until {new Date(d.until!).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' })}. <Button size="sm" variant="ghost" onClick={onOpen}>Change or end</Button></Callout>}
      {d.incoming.map((i) => <Callout key={i.id} tone="decision" title={`Acting for ${i.name}`}>{i.name} delegated {i.roles.join(', ')} approvals to you until {new Date(i.delegate_until).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' })}. Their requests appear under Waiting for me and are recorded as delegated.</Callout>)}
    </div>
  );
}

function DelegationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useQuery<Delegation>({ queryKey: ['approvals', 'delegation'], queryFn: () => api.get('/approvals/delegation'), enabled: open });
  const [who, setWho] = useState('');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const save = useAction(() => api.put('/approvals/delegation', { delegate_id: Number(who), until, reason: reason || null }), {
    success: 'Delegation saved and audited', invalidate: [['approvals']], onSuccess: onClose, silentError: true,
  });
  const end = useAction(() => api.del('/approvals/delegation'), { success: 'Delegation ended', invalidate: [['approvals']], onSuccess: onClose });
  const d = q.data;
  return (
    <Modal open={open} onClose={onClose} title="Delegate my approvals" sub="While you are away, the person you choose can decide requests waiting for your role. Every decision they take is marked as delegated and audited. They still cannot approve their own requests."
      footer={<>{d?.active && <Button variant="danger" loading={end.busy} onClick={end.fire}>End delegation</Button>}<Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={save.busy} disabled={!who || !until} onClick={save.fire}>Save delegation</Button></>}>
      <div className="stack">
        <ErrorSummary error={save.error} />
        {d?.active && <Callout tone="info">Currently delegated to {d.delegate?.name} until {d.until ? new Date(d.until).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' }) : '—'}. Saving replaces it.</Callout>}
        {d && !d.can_delegate && <Callout tone="warn">Only approvers can delegate.</Callout>}
        <Field label="Delegate to" required><Select value={who} onChange={(e) => setWho(e.target.value)} placeholder="Choose a colleague" options={(d?.candidates ?? []).map((c) => ({ value: c.id, label: `${c.name} — ${c.roles}` }))} /></Field>
        <Field label="Until (last day)" required hint="Up to 90 days."><Input type="date" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} /></Field>
        <Field label="Reason" hint="Optional, e.g. annual leave. Recorded in the audit trail."><Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function BulkDialog({ rows, onClose }: { rows: ApprovalItem[] | null; onClose: () => void }) {
  const run = useAction(() => api.post<{ succeeded: number; failed: number; results: { ok: boolean; req_no?: string; message?: string }[] }>('/approvals/bulk-approve', { ids: rows!.map((r) => r.id) }), {
    success: (r) => `${plural(r.succeeded, 'request')} approved${r.failed ? `; ${r.failed} not approved (${r.results.find((x) => !x.ok)?.message})` : ''}`, invalidate: [['approvals'], ['nav-counts']], onSuccess: onClose,
  });
  return (
    <Modal open={!!rows} onClose={onClose} title={`Approve ${plural(rows?.length ?? 0, 'request')}?`} sub="Only request types that policy allows for bulk approval can be selected."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={run.busy} onClick={run.fire}>Approve all</Button></>}>
      <ul className="stack-sm" style={{ paddingLeft: 18, margin: 0 }}>{rows?.map((r) => <li key={r.id}><span className="mono">{r.req_no}</span> — {r.title} ({fmtLakh(r.value)})</li>)}</ul>
    </Modal>
  );
}
