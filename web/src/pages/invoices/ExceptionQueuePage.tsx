import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, ExternalLink, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtMoney, plural } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, DecisionTag, KV, PageHeader, Ref, Segmented, Status } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Drawer, ReasonDialog, Modal } from '@/components/overlay';
import { Field, Select, Textarea, ErrorSummary } from '@/components/forms';
import { Bars } from '@/components/charts';
import { OcrNote, OWNER_LABEL, type Exc } from './shared';

interface QRow extends Exc { inv_ref: string; vendor_invoice_no: string | null; vendor_name: string; po_no: string; po_id: number; plant: string; total_value: number | null; inv_status: string; owner: string; age_bucket: string }
type By = 'reason' | 'owner' | 'age';
const BUCKETS = ['0–2 days', '3–7 days', '8–15 days', '> 15 days'];

/** SCR-INV-02 — exception queue by reason, owner and age; assign; simple resolutions that work on a phone. */
export default function ExceptionQueuePage() {
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? 'Open';
  const [by, setBy] = useState<By>('reason');
  const [open, setOpen] = useState<QRow | null>(null);
  const q = useQuery<QRow[]>({ queryKey: ['invoices', 'exceptions', status], queryFn: () => api.get('/invoices/exceptions', { status }) });
  const rows = q.data ?? [];
  const reasonFilter = sp.get('reason');
  const shown = reasonFilter ? rows.filter((r) => r.reason === reasonFilter) : rows;

  const groups = useMemo(() => {
    const key = (r: QRow) => (by === 'reason' ? r.reason : by === 'owner' ? r.owner : r.age_bucket);
    const m = new Map<string, QRow[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    const arr = [...m.entries()].map(([k, v]) => ({ k, v }));
    return by === 'age' ? arr.sort((a, b) => BUCKETS.indexOf(a.k) - BUCKETS.indexOf(b.k)) : arr.sort((a, b) => b.v.length - a.v.length);
  }, [rows, by]);

  const columns: Column<QRow>[] = [
    { key: 'inv_ref', header: 'Invoice', render: (r) => <div><Ref to={`/invoices/${r.invoice_id}`}>{r.inv_ref}</Ref><div className="small subtle">{r.vendor_invoice_no ?? '—'}</div></div>, value: (r) => `${r.inv_ref} ${r.vendor_invoice_no ?? ''}`, nowrap: true },
    { key: 'vendor_name', header: 'Vendor', render: (r) => <span style={{ minWidth: 150, display: 'inline-block' }}>{r.vendor_name}</span> },
    { key: 'reason', header: 'Reason', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><strong>{r.reason}</strong><span className="small subtle">{r.rule_label}</span></div>, value: (r) => r.reason },
    { key: 'severity', header: 'Severity', render: (r) => <Badge tone={r.severity === 'high' ? 'bad' : r.severity === 'medium' ? 'warn' : 'neutral'}>{r.severity}</Badge> },
    { key: 'difference', header: 'Expected → actual', render: (r) => (r.expected || r.actual ? <span className="small">{r.expected ?? '—'} <ArrowRight size={11} aria-hidden /> <strong>{r.actual ?? '—'}</strong></span> : <span className="subtle">—</span>), value: (r) => `${r.expected ?? ''} ${r.actual ?? ''}` },
    { key: 'owner', header: 'Owner', render: (r) => <div><div>{r.owner}</div><div className="small subtle">{OWNER_LABEL[r.owner_role] ?? r.owner_role}</div></div>, value: (r) => r.owner },
    { key: 'age_days', header: 'Age', align: 'right', render: (r) => <span className="num" style={{ color: r.age_days >= 7 ? 'var(--warn)' : undefined, fontWeight: r.age_days >= 7 ? 700 : 500 }}>{r.age_days} d</span>, value: (r) => r.age_days },
    { key: 'status', header: 'State', render: (r) => <Status value={r.status} /> },
    { key: 'total_value', header: 'Invoice total', align: 'right', render: (r) => fmtMoney(r.total_value, true), value: (r) => r.total_value, hidden: true },
  ];

  const bars = groups.map((g) => ({
    label: g.k, value: g.v.length,
    parts: by === 'age' ? undefined : BUCKETS.map((b) => ({ label: b, value: g.v.filter((x) => x.age_bucket === b).length })),
    onClick: () => { if (by === 'reason') { sp.set('reason', g.k); setSp(sp, { replace: true }); } },
    hint: plural(g.v.length, 'exception'),
  }));

  return (
    <>
      <PageHeader
        title="Invoice exception queue" screen="SCR-INV-02"
        eyebrow={<><Link to="/invoices">Invoices</Link><span>/</span><span>Exceptions</span></>}
        sub="Every match or validation exception, with its owner and age. Open one to approve it, assign it, or go to the invoice."
        badges={<OcrNote compact />}
        actions={<Segmented label="State" value={status} onChange={(v) => { sp.set('status', v); sp.delete('reason'); setSp(sp, { replace: true }); }} options={[{ id: 'Open', label: 'Open' }, { id: 'all', label: 'All' }]} />}
      />
      <Card title={<div className="row-wrap"><h2>{plural(rows.length, status === 'Open' ? 'open exception' : 'exception')}</h2><span className="small muted">RPT-09 exception reasons</span></div>}
        actions={<Segmented label="Group by" value={by} onChange={setBy} options={[{ id: 'reason', label: 'Reason' }, { id: 'owner', label: 'Owner' }, { id: 'age', label: 'Age' }]} />}>
        <Bars title={`Exceptions by ${by}`} data={bars} legend={by === 'age' ? undefined : BUCKETS} />
        <p className="small muted" style={{ marginTop: 10 }}>{by === 'reason' ? 'Select a bar to filter the list by that reason. ' : ''}Age counts calendar days since the exception was raised (working-day basis pending DEC-15).</p>
      </Card>
      <div style={{ height: 16 }} />
      {reasonFilter && <div style={{ marginBottom: 12 }}><Callout tone="info">Showing “{reasonFilter}” only. <button className="btn btn--ghost btn--sm" onClick={() => { sp.delete('reason'); setSp(sp, { replace: true }); }}>Show all reasons</button></Callout></div>}
      <Card flush>
        <DataTable
          id="invoice-exceptions" rows={shown} loading={q.isLoading} error={q.error} refetch={q.refetch} rowKey={(r) => r.id} onRowClick={setOpen} columns={columns}
          initialSort={{ key: 'age_days', dir: 'desc' }} searchPlaceholder="Search invoice, vendor, reason…"
          filters={[{ key: 'reason', label: 'Reason', value: (r) => r.reason }, { key: 'owner', label: 'Owner', value: (r) => r.owner }, { key: 'bucket', label: 'Age', value: (r) => r.age_bucket, options: BUCKETS }, { key: 'vendor', label: 'Vendor', value: (r) => r.vendor_name }]}
          empty={<div className="empty"><div className="empty__icon"><CheckCircle2 size={24} /></div><div className="empty__title">No open exceptions</div><div>Invoices that fail validation or matching appear here with an owner.</div></div>}
          mobile={{ title: (r) => <><span className="mono">{r.inv_ref}</span> · {r.reason}</>, badge: (r) => <Badge tone={r.severity === 'high' ? 'bad' : 'warn'}>{r.severity}</Badge>, meta: (r) => [r.vendor_name, r.owner, `${r.age_days} d old`, r.actual ? `${r.expected ?? '—'} → ${r.actual}` : ''].filter(Boolean) }}
        />
      </Card>
      {open && <ExceptionDrawer ex={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ExceptionDrawer({ ex, onClose }: { ex: QRow; onClose: () => void }) {
  const { can } = useAuth();
  const [dlg, setDlg] = useState<'approve' | 'assign' | null>(null);
  const approve = useAction((reason: string) => api.post(`/invoices/exceptions/${ex.id}/approve`, { reason }), { success: `Exception approved on ${ex.inv_ref}`, invalidate: [['invoices']], onSuccess: onClose });
  const canResolve = can('inv.review') && ex.status === 'Open';
  const blocked = ex.rule === 'DUP' ? 'A duplicate cannot be approved. Open the invoice to reject it to the vendor.' : ex.rule === 'FIELD_MISSING' ? 'Correct the missing field from the document in the invoice review.' : ex.reason.startsWith('Pending') ? 'This clears itself when SAP posts the receipt.' : null;
  return (
    <Drawer open onClose={onClose} title={`${ex.reason} — ${ex.inv_ref}`}
      footer={<>
        <ButtonLink to={`/invoices/${ex.invoice_id}`} icon={<ExternalLink size={16} />}>Open invoice</ButtonLink>
        {canResolve && <Button icon={<UserPlus />} onClick={() => setDlg('assign')}>Assign</Button>}
        {canResolve && !blocked && <Button variant="decision" icon={<CheckCircle2 />} onClick={() => setDlg('approve')}>Approve exception</Button>}
      </>}>
      <div className="stack">
        <div className="row-wrap"><Badge tone={ex.severity === 'high' ? 'bad' : 'warn'}>{ex.severity} severity</Badge><Status value={ex.status} /><span className="small muted">{ex.rule_label}</span></div>
        <p style={{ margin: 0 }}>{ex.message}</p>
        <KV items={[['Vendor', ex.vendor_name], ['Vendor invoice no.', ex.vendor_invoice_no], ['PO', <span className="mono">{ex.po_no}</span>], ['Invoice total', fmtMoney(ex.total_value)], ['Expected', ex.expected], ['Actual', ex.actual], ['Tolerance', <>{ex.tolerance ?? '—'} {ex.rule.startsWith('3WM-0') || ex.rule === 'FDS' ? <DecisionTag id="DEC-07" /> : null}</>], ['Owner', `${ex.owner} (${OWNER_LABEL[ex.owner_role] ?? ex.owner_role})`], ['Raised', `${ex.age_days} days ago`], ['Resolution', ex.resolution]]} />
        {ex.auto_clear === 0 && ex.status === 'Open' && <Callout tone="bad" title="Never cleared automatically">Bank-detail mismatches stay open until finance decides (FR-INV-09).</Callout>}
        {blocked && ex.status === 'Open' && <Callout tone="info">{blocked}</Callout>}
        {!can('inv.review') && <Callout tone="info">Finance resolves exceptions. You can follow the invoice and comment on it.</Callout>}
      </div>
      <ReasonDialog open={dlg === 'approve'} onClose={() => setDlg(null)} title="Approve this exception" confirmLabel="Approve exception" variant="decision" sub={`${ex.reason} on ${ex.inv_ref}. The invoice still needs every other exception cleared and finance approval before it can be parked.`} onSubmit={(r) => approve.run(r)} />
      <AssignDialog ex={dlg === 'assign' ? ex : null} onClose={() => setDlg(null)} onDone={onClose} />
    </Drawer>
  );
}

function AssignDialog({ ex, onClose, onDone }: { ex: QRow | null; onClose: () => void; onDone: () => void }) {
  const users = useQuery<{ id: number; name: string; roles: string; title: string | null }[]>({ queryKey: ['invoices', 'assignees'], queryFn: () => api.get('/invoices/assignees'), enabled: !!ex });
  const [user, setUser] = useState('');
  const [note, setNote] = useState('');
  const act = useAction(() => api.post(`/invoices/exceptions/${ex!.id}/assign`, { user_id: Number(user), note: note || undefined }), { success: 'Exception assigned', invalidate: [['invoices']], onSuccess: () => { setUser(''); setNote(''); onClose(); onDone(); } });
  return (
    <Modal open={!!ex} onClose={onClose} title="Assign exception" sub={ex ? `${ex.reason} on ${ex.inv_ref}. The new owner is notified.` : undefined}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={act.busy} disabled={!user} onClick={act.fire}>Assign</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="Owner" required><Select value={user} onChange={(e) => setUser(e.target.value)} placeholder="Choose a person" options={(users.data ?? []).map((u) => ({ value: u.id, label: `${u.name} — ${u.title ?? u.roles}` }))} /></Field>
        <Field label="Note for the owner" hint="Optional."><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}
