/** Jobs, simulated outbox and audit log viewer (SCR-ADM-04). */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Play, ShieldCheck, ShieldAlert, Download } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { ago, fmtDateTime } from '@/lib/format';
import { Badge, Button, Callout, Card, PageHeader, SimBadge, Status } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { Field, Input } from '@/components/forms';

// ------------------------------------------------------------------ jobs
export function JobsPage() {
  const { can } = useAuth();
  const q = useQuery<{ jobs: { name: string; label: string; everyMinutes: number; lastRun: string | null }[]; runs: { id: number; job: string; started_at: string; finished_at: string | null; status: string; message: string | null }[] }>({ queryKey: ['admin', 'jobs'], queryFn: () => api.get('/jobs'), refetchInterval: 15_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const run = useAction((name: string) => api.post<{ status: string; message: string }>(`/jobs/${name}/run`), { invalidate: [['admin', 'jobs'], ['notifications']], success: (r) => `Job ${r.status.toLowerCase()}: ${r.message}` });
  const label = (name: string) => q.data?.jobs.find((j) => j.name === name)?.label ?? name;
  return (
    <>
      <PageHeader title="Scheduled jobs" screen="Jobs" eyebrow={<Link to="/admin">Administration</Link>} sub="Reminders, escalations, expiry checks and SAP syncs run on a schedule. Run any job now; every run is logged and manual runs are audited." />
      <Card flush title="Jobs">
        <DataTable<any>
          id="admin-jobs" rows={q.data?.jobs} loading={q.isLoading} error={q.error} refetch={() => q.refetch()} rowKey={(r) => r.name} savedViews={false} searchPlaceholder="Search jobs…"
          columns={[
            { key: 'label', header: 'Job', render: (r) => <><strong>{r.label}</strong><span className="small subtle mono" style={{ display: 'block' }}>{r.name}</span></> },
            { key: 'everyMinutes', header: 'Runs every', render: (r) => (r.everyMinutes >= 1440 ? `${r.everyMinutes / 1440} day(s)` : r.everyMinutes >= 60 ? `${r.everyMinutes / 60} h` : `${r.everyMinutes} min`), value: (r) => r.everyMinutes },
            { key: 'lastRun', header: 'Last run', render: (r) => (r.lastRun ? <span title={fmtDateTime(r.lastRun)}>{ago(r.lastRun)}</span> : <span className="subtle">Not since start</span>), value: (r) => r.lastRun },
            { key: 'last', header: 'Last result', sortable: false, render: (r) => { const x = q.data?.runs.find((y) => y.job === r.name); return x ? <div className="stack-sm" style={{ gap: 2 }}><Status value={x.status} /><span className="small muted">{x.message}</span></div> : '—'; } },
            { key: 'act', header: '', sortable: false, exportable: false, render: (r) => (can('adm.config', 'sap.monitor') ? <Button size="sm" icon={<Play />} loading={busy === r.name && run.busy} onClick={async () => { setBusy(r.name); await run.fire(r.name); setBusy(null); }}>Run now</Button> : null) },
          ]}
          mobile={{ title: (r) => r.label, meta: (r) => [`every ${r.everyMinutes} min`, r.lastRun ? ago(r.lastRun) : 'not run'] }}
        />
      </Card>
      <div style={{ height: 16 }} />
      <Card flush title="Run history" actions={<span className="small muted">Latest 100 runs</span>}>
        <DataTable<any>
          id="admin-job-runs" rows={q.data?.runs} loading={q.isLoading} rowKey={(r) => r.id} initialSort={{ key: 'started_at', dir: 'desc' }}
          columns={[
            { key: 'started_at', header: 'Started', render: (r) => fmtDateTime(r.started_at), nowrap: true },
            { key: 'job', header: 'Job', render: (r) => <><strong>{label(r.job)}</strong><span className="small subtle mono" style={{ display: 'block' }}>{r.job}</span></>, value: (r) => r.job },
            { key: 'status', header: 'Result', render: (r) => <Status value={r.status} /> },
            { key: 'message', header: 'Summary', render: (r) => r.message ?? '—' },
            { key: 'duration', header: 'Duration', align: 'right', value: (r) => (r.finished_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : null), render: (r) => (r.finished_at ? `${new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()} ms` : '—') },
          ]}
          filters={[{ key: 'job', label: 'Job', value: (r) => r.job }, { key: 'status', label: 'Result', value: (r) => r.status }]}
          mobile={{ title: (r) => label(r.job), badge: (r) => <Status value={r.status} />, meta: (r) => [fmtDateTime(r.started_at), r.message ?? ''] }}
          empty={<div className="empty"><div className="empty__title">No runs yet</div><div>Run a job above or wait for its schedule.</div></div>}
        />
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ outbox
export function OutboxPage() {
  const q = useQuery<{ id: number; channel: string; recipient: string; subject: string | null; body: string | null; template: string | null; status: string; created_at: string }[]>({ queryKey: ['admin', 'outbox'], queryFn: () => api.get('/outbox') });
  return (
    <>
      <PageHeader title="Simulated outbox" screen="Outbox" eyebrow={<Link to="/admin">Administration</Link>} badges={<SimBadge>Not delivered</SimBadge>}
        sub="E-mail, SMS and WhatsApp messages the platform would send. No provider is connected, so none of these were delivered — they are a record of what the notification policy produced." />
      <Callout tone="warn" title="Nothing here was sent">Notification channels follow the policy in Business configuration (DEC-14): e-mail and in-app are on; SMS and WhatsApp stay off until Equipcare decides.</Callout>
      <div style={{ height: 16 }} />
      <Card flush>
        <DataTable<any>
          id="admin-outbox" rows={q.data} loading={q.isLoading} error={q.error} refetch={() => q.refetch()} rowKey={(r) => r.id} initialSort={{ key: 'created_at', dir: 'desc' }} searchPlaceholder="Search recipient, subject…"
          columns={[
            { key: 'created_at', header: 'Recorded', render: (r) => fmtDateTime(r.created_at), nowrap: true },
            { key: 'channel', header: 'Channel', render: (r) => <Badge plain tone={r.channel === 'email' ? 'info' : 'warn'}>{r.channel}</Badge> },
            { key: 'recipient', header: 'To', render: (r) => <span className="small">{r.recipient}</span> },
            { key: 'subject', header: 'Subject', render: (r) => <div style={{ minWidth: 220 }}><strong>{r.subject}</strong>{r.body && <div className="small muted" style={{ maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.body}</div>}</div>, value: (r) => `${r.subject} ${r.body}` },
            { key: 'template', header: 'Template', render: (r) => <span className="mono small">{r.template}</span> },
            { key: 'status', header: 'Delivery', render: (r) => <span className="small" style={{ color: 'var(--warn)', fontWeight: 600 }}>{r.status}</span> },
          ]}
          filters={[{ key: 'channel', label: 'Channel', value: (r) => r.channel }, { key: 'template', label: 'Template', value: (r) => r.template?.split('.')[0] }]}
          mobile={{ title: (r) => r.subject ?? '(no subject)', badge: (r) => <Badge plain>{r.channel}</Badge>, meta: (r) => [r.recipient, 'Not delivered', ago(r.created_at)] }}
          empty={<div className="empty"><div className="empty__title">The outbox is empty</div><div>Notifications create entries here as they are raised.</div></div>}
        />
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ audit log
interface Ev { id: number; ts: string; actor_name: string; role: string; action: string; object_type: string | null; object_id: string | null; object_ref: string | null; before: any; after: any; reason: string | null; channel: string | null; ip: string | null; hash: string }

export function AuditPage() {
  const { can } = useAuth();
  const [f, setF] = useState({ action: '', actor: '', object: '', from: '', to: '' });
  const [applied, setApplied] = useState(f);
  const q = useQuery<Ev[]>({ queryKey: ['audit-log', applied], queryFn: () => api.get('/audit', { ...applied, limit: 1000 }) });
  const chain = useQuery<{ ok: boolean; checked: number; brokenAt?: number }>({ queryKey: ['audit-chain'], queryFn: () => api.get('/audit/verify'), enabled: false });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const [open, setOpen] = useState<Ev | null>(null);
  return (
    <>
      <PageHeader title="Audit log" screen="SCR-ADM-04" sub="Immutable, hash-chained record of who did what, when, with before and after values and the reason. What you see depends on your role."
        actions={<>
          {can('audit.view_all') && <Button icon={chain.data?.ok === false ? <ShieldAlert /> : <ShieldCheck />} loading={chain.isFetching} onClick={() => chain.refetch()}>Verify chain</Button>}
          <a className="btn btn--secondary" href={downloadUrl('/audit', { ...applied, format: 'csv', limit: 2000 })}><Download size={16} /> Export CSV</a>
        </>} />
      {chain.data && (
        <div style={{ marginBottom: 16 }}>
          <Callout tone={chain.data.ok ? 'ok' : 'bad'} title={chain.data.ok ? 'Hash chain verified' : `Chain broken at event ${chain.data.brokenAt}`}>
            {chain.data.ok ? `${chain.data.checked} events checked — every event links to the one before it and no content has changed.` : 'An event no longer matches its hash. Escalate to the platform owner.'}
          </Callout>
        </div>
      )}
      <Card>
        <form className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }} onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
          <Field label="Action contains"><Input value={f.action} onChange={set('action')} placeholder="e.g. user.locked" /></Field>
          <Field label="User"><Input value={f.actor} onChange={set('actor')} /></Field>
          <Field label="Object / reference"><Input value={f.object} onChange={set('object')} placeholder="vendor, PO number…" /></Field>
          <Field label="From"><Input type="date" value={f.from} onChange={set('from')} /></Field>
          <Field label="To"><Input type="date" value={f.to} onChange={set('to')} /></Field>
          <div className="row" style={{ alignItems: 'flex-end' }}><Button type="submit" variant="deep">Apply filters</Button><Button onClick={() => { const e = { action: '', actor: '', object: '', from: '', to: '' }; setF(e); setApplied(e); }}>Clear</Button></div>
        </form>
      </Card>
      <div style={{ height: 16 }} />
      <Card flush>
        <DataTable<Ev>
          id="audit-log" rows={q.data} loading={q.isLoading} error={q.error} refetch={() => q.refetch()} rowKey={(r) => r.id} onRowClick={setOpen} initialSort={{ key: 'id', dir: 'desc' }} searchPlaceholder="Search the loaded events…"
          columns={[
            { key: 'id', header: 'Event', render: (r) => <span className="mono small">#{r.id}</span> },
            { key: 'ts', header: 'Time', render: (r) => fmtDateTime(r.ts), nowrap: true },
            { key: 'actor_name', header: 'User', render: (r) => <>{r.actor_name}<span className="small subtle" style={{ display: 'block' }}>{r.role}</span></>, value: (r) => r.actor_name },
            { key: 'action', header: 'Action', render: (r) => <span className="mono small">{r.action}</span> },
            { key: 'object_ref', header: 'Object', render: (r) => <>{r.object_ref ?? r.object_id ?? '—'}<span className="small subtle" style={{ display: 'block' }}>{r.object_type}</span></>, value: (r) => `${r.object_ref ?? r.object_id ?? ''} ${r.object_type ?? ''}` },
            { key: 'reason', header: 'Reason', render: (r) => <span className="small">{r.reason ?? '—'}</span> },
            { key: 'channel', header: 'Channel', hidden: true }, { key: 'ip', header: 'IP', hidden: true },
          ]}
          filters={[{ key: 'role', label: 'Role', value: (r) => r.role }, { key: 'type', label: 'Object type', value: (r) => r.object_type }, { key: 'channel', label: 'Channel', value: (r) => r.channel }]}
          mobile={{ title: (r) => r.action, meta: (r) => [r.actor_name, fmtDateTime(r.ts), r.object_ref ?? ''] }}
          empty={<div className="empty"><div className="empty__title">No audit events match</div><div>Widen the dates or clear the filters.</div></div>}
        />
      </Card>
      {open && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(null)}>
          <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label="Audit event">
            <div className="modal__head"><div><h2>Event #{open.id}: {open.action}</h2><p className="muted small" style={{ marginTop: 4 }}>{open.actor_name} ({open.role}) · {fmtDateTime(open.ts)} · {open.channel ?? 'system'}{open.ip ? ` · ${open.ip}` : ''}</p></div><Button variant="ghost" size="sm" onClick={() => setOpen(null)}>Close</Button></div>
            <div className="modal__body stack">
              {open.reason && <Callout tone="info" title="Reason">{open.reason}</Callout>}
              <div className="grid-2"><div><h3 className="section-title">Before</h3><pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{open.before ? JSON.stringify(open.before, null, 2) : '—'}</pre></div><div><h3 className="section-title">After</h3><pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{open.after ? JSON.stringify(open.after, null, 2) : '—'}</pre></div></div>
              <div className="small subtle mono" style={{ overflowWrap: 'anywhere' }}>hash {open.hash}</div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
