/** SCR-ADM-01 users & roles. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { UserPlus, Pencil, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { ago } from '@/lib/format';
import { Badge, Button, Callout, Card, KV, Kpi, PageHeader, Status, Tabs } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { Checkbox, ErrorSummary, Field, Input, Select, Textarea, fieldError } from '@/components/forms';
import { Modal } from '@/components/overlay';
import { TempPasswordModal, UserActions, userState, type AdminUser } from './userParts';

interface Meta { roles: { code: string; label: string }[]; plants: { code: string; name: string }[]; categories: { code: string; name: string }[]; managers: { id: number; name: string; title: string | null }[]; vendor_roles: string[] }

/** Single-user mode: one Administrator account, so there is nothing to create or assign. */
function SingleAccountView() {
  const { me } = useAuth();
  const meta = useQuery<Meta>({ queryKey: ['admin', 'users', 'meta'], queryFn: () => api.get('/admin/users/meta') });
  if (!me) return null;
  const held = (meta.data?.roles ?? []).filter((r) => r.code !== 'VEN');
  return (
    <>
      <PageHeader title="Administrator account" screen="SCR-ADM-01" eyebrow={<Link to="/admin">Administration</Link>}
        sub="This installation runs in single-user mode: one account holds every internal module and there is no sign-in." />
      <div className="split">
        <div className="stack">
          <Card title="The account">
            <KV items={[
              ['Name', me.name], ['E-mail', me.email], ['Sign-in', 'None — the app opens straight into this account'],
              ['Plants', me.plants === '*' ? 'All plants' : me.plants.join(', ')], ['Spend categories', me.categories.length ? `${me.categories.length} categories (all)` : 'All'],
              ['Vendor portal', 'Open it as any vendor company from the user menu; vendors have no accounts of their own'],
            ]} />
          </Card>
          <Card title="Roles held together">
            <div className="row-wrap">{held.map((r) => <Badge key={r.code} tone="info" plain>{r.label}</Badge>)}</div>
            <p className="small muted" style={{ marginTop: 12 }}>The Administrator sees every module and every plant at once, so there is no role to switch between.</p>
          </Card>
        </div>
        <div className="stack">
          <Callout tone="warn" title="Segregation of duties still applies">
            A request the Administrator raised or recommended cannot be approved by the same account (FR-APR-09). With only one account, such requests wait until an additional approver account exists, so use multi-user mode for workflows that need a second person.
          </Callout>
          <Callout tone="info" title="Access is local only">
            With no sign-in, anyone who can reach the server acts as the Administrator. The server listens on this computer only and refuses other host names. Do not expose it to a network.
          </Callout>
        </div>
      </div>
    </>
  );
}

export default function UsersPage() {
  const { me } = useAuth();
  return me?.singleUser ? <SingleAccountView /> : <UsersList />;
}

function UsersList() {
  const [tab, setTab] = useState<'internal' | 'vendor'>('internal');
  const [edit, setEdit] = useState<AdminUser | 'new' | null>(null);
  const users = useQuery<AdminUser[]>({ queryKey: ['admin', 'users'], queryFn: () => api.get('/admin/users') });
  const meta = useQuery<Meta>({ queryKey: ['admin', 'users', 'meta'], queryFn: () => api.get('/admin/users/meta') });
  const rows = users.data ?? [];
  const internal = rows.filter((u) => !u.vendor_id);
  const vendors = rows.filter((u) => u.vendor_id);
  const sod = internal.filter((u) => u.active && u.sod?.length);
  return (
    <>
      <PageHeader title="Users & roles" screen="SCR-ADM-01" eyebrow={<Link to="/admin">Administration</Link>} sub="Internal users, their roles and scope. Vendor users are created from the vendor record or by the vendor's administrator and are listed separately."
        actions={<Button variant="primary" icon={<UserPlus />} onClick={() => setEdit('new')}>Create user</Button>} />
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <Kpi label="Active internal users" value={internal.filter((u) => u.active).length} onClick={() => setTab('internal')} />
        <Kpi label="Locked accounts" value={rows.filter((u) => u.locked).length} tone={rows.some((u) => u.locked) ? 'warn' : undefined} meta="Locked after failed sign-ins" />
        <Kpi label="Segregation-of-duties warnings" value={sod.length} tone={sod.length ? 'warn' : undefined} meta="Users holding conflicting roles" />
        <Kpi label="Vendor users" value={vendors.filter((u) => u.active).length} onClick={() => setTab('vendor')} meta={`${vendors.filter((u) => !u.active).length} deactivated`} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'internal', label: 'Equipcare users', count: internal.length }, { id: 'vendor', label: 'Vendor users', count: vendors.length }]} />
      <Card flush>
        <DataTable<AdminUser>
          id={`admin-users-${tab}`} rows={tab === 'internal' ? internal : vendors} loading={users.isLoading} error={users.error} refetch={() => users.refetch()} rowKey={(r) => r.id} searchPlaceholder="Search name, e-mail, role…"
          columns={tab === 'internal' ? [
            { key: 'name', header: 'User', render: (r) => <><strong>{r.name}</strong><span className="small subtle" style={{ display: 'block' }}>{r.email}</span></> },
            { key: 'roles', header: 'Roles', render: (r) => <div className="row-wrap" style={{ gap: 4 }}>{(r.role_list ?? r.roles.split(',')).map((x) => <Badge key={x} plain tone={x === 'APR' ? 'decision' : 'info'}>{x}</Badge>)}{r.sod?.length ? <span title={r.sod.map((s) => s.risk).join(' ')} className="small" style={{ color: 'var(--warn)', display: 'inline-flex', gap: 3, alignItems: 'center' }}><ShieldAlert size={13} aria-hidden />SoD</span> : null}</div>, value: (r) => r.roles },
            { key: 'scope', header: 'Plants / categories', render: (r) => <span className="small">{r.plant_scope === '*' || !r.plant_scope ? 'All plants' : r.plant_scope}{r.categories ? <span className="subtle" style={{ display: 'block' }}>{r.categories}</span> : null}</span>, value: (r) => `${r.plant_scope} ${r.categories ?? ''}` },
            { key: 'manager_name', header: 'Manager', render: (r) => r.manager_name ?? '—' },
            { key: 'state', header: 'Status', value: (r) => userState(r), render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Status value={userState(r)} />{r.failed_attempts > 0 && <span className="small muted">{r.failed_attempts} failed attempt(s)</span>}</div> },
            { key: 'last_login', header: 'Last sign-in', render: (r) => (r.last_login ? ago(r.last_login) : 'Never'), nowrap: true },
            { key: 'act', header: '', sortable: false, exportable: false, render: (r) => <div className="row" style={{ gap: 2, flexWrap: 'nowrap' }}><Button size="sm" variant="ghost" iconOnly icon={<Pencil />} title="Edit user" onClick={() => setEdit(r)}>Edit {r.name}</Button><UserActions u={r} invalidate={[['admin']]} compact /></div> },
          ] : [
            { key: 'name', header: 'User', render: (r) => <><strong>{r.name}</strong><span className="small subtle" style={{ display: 'block' }}>{r.email}</span></> },
            { key: 'vendor_name', header: 'Vendor', render: (r) => <Link to={`/vendors/${r.vendor_id}?tab=users`}>{r.vendor_name}</Link> },
            { key: 'vendor_role', header: 'Vendor role' },
            { key: 'state', header: 'Status', value: (r) => userState(r), render: (r) => <Status value={userState(r)} /> },
            { key: 'last_login', header: 'Last sign-in', render: (r) => (r.last_login ? ago(r.last_login) : 'Never'), nowrap: true },
            { key: 'act', header: '', sortable: false, exportable: false, render: (r) => <UserActions u={r} invalidate={[['admin']]} compact /> },
          ]}
          filters={[{ key: 'state', label: 'Status', value: (r) => userState(r) }]}
          mobile={{ title: (r) => r.name, badge: (r) => <Status value={userState(r)} />, meta: (r) => [r.vendor_name ?? r.roles, r.email] }}
          empty={<div className="empty"><div className="empty__title">No users</div></div>}
        />
      </Card>
      {edit && meta.data && <UserDialog user={edit === 'new' ? null : edit} meta={meta.data} onClose={() => setEdit(null)} />}
    </>
  );
}

function UserDialog({ user, meta, onClose }: { user: AdminUser | null; meta: Meta; onClose: () => void }) {
  const [f, setF] = useState({
    name: user?.name ?? '', email: user?.email ?? '', phone: user?.phone ?? '', title: user?.title ?? '', department: user?.department ?? '',
    roles: user?.roles.split(',') ?? [] as string[], allPlants: !user || user.plant_scope === '*' || !user.plant_scope, plants: user?.plant_scope && user.plant_scope !== '*' ? user.plant_scope.split(',') : [] as string[],
    categories: user?.categories?.split(',') ?? [] as string[], manager_id: user?.manager_id ? String(user.manager_id) : '', reason: '',
  });
  const [warn, setWarn] = useState<{ roles: string[]; risk: string }[]>([]);
  const [pw, setPw] = useState<{ temporary_password: string; delivery?: string } | null>(null);
  useEffect(() => {
    if (!f.roles.length) { setWarn([]); return; }
    api.post<{ warnings: { roles: string[]; risk: string }[] }>('/admin/sod-check', { roles: f.roles }).then((r) => setWarn(r.warnings)).catch(() => setWarn([]));
  }, [f.roles.join(',')]);
  const toggle = (k: 'roles' | 'plants' | 'categories', v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  const body = () => ({
    name: f.name, email: f.email, phone: f.phone || null, title: f.title || null, department: f.department || null, roles: f.roles, plant_scope: f.allPlants ? '*' : f.plants,
    categories: f.roles.includes('BUY') ? f.categories : [], manager_id: f.manager_id ? Number(f.manager_id) : null,
  });
  const rolesChanged = !!user && f.roles.slice().sort().join(',') !== user.roles.split(',').sort().join(',');
  const save = useAction(() => (user ? api.put<{ ok: boolean }>(`/admin/users/${user.id}`, { ...body(), reason: f.reason || undefined }) : api.post<{ temporary_password: string; delivery: string }>('/admin/users', body())), {
    success: user ? `${f.name} updated` : `${f.name} created`, invalidate: [['admin']], silentError: true,
    onSuccess: (r: any) => { if (!user) setPw(r); else onClose(); },
  });
  if (pw) return <TempPasswordModal value={pw} onClose={onClose} who={f.name} />;
  return (
    <Modal open onClose={onClose} wide title={user ? `Edit ${user.name}` : 'Create user'} sub={user ? undefined : 'A temporary password is generated and shown once. The welcome e-mail goes to the simulated outbox.'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={save.busy} disabled={!f.name || !f.email || !f.roles.length || (rolesChanged && f.reason.trim().length < 10)} onClick={save.fire}>{user ? 'Save changes' : 'Create user'}</Button></>}>
      <div className="stack">
        <ErrorSummary error={save.error} />
        <div className="form-grid">
          <Field label="Full name" required error={fieldError(save.error, 'name')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="E-mail" required error={fieldError(save.error, 'email')}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Mobile"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Title"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Department"><Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
          <Field label="Manager"><Select value={f.manager_id} onChange={(e) => setF({ ...f, manager_id: e.target.value })} placeholder="No manager" options={meta.managers.filter((m) => m.id !== user?.id).map((m) => ({ value: m.id, label: `${m.name}${m.title ? ` — ${m.title}` : ''}` }))} /></Field>
        </div>
        <Field label="Roles" required hint="A user can hold several roles and switch between them." error={fieldError(save.error, 'roles')}>
          <div className="grid-2" style={{ gap: 6 }}>{meta.roles.map((r) => <Checkbox key={r.code} label={<><strong>{r.code}</strong> {r.label}</>} checked={f.roles.includes(r.code)} onChange={() => toggle('roles', r.code)} />)}</div>
        </Field>
        {warn.map((w) => <Callout key={w.roles.join('+')} tone="warn" title={`Segregation of duties: ${w.roles.join(' + ')}`}>{w.risk} You can still save; the conflict stays flagged in the user list.</Callout>)}
        <Field label="Plant scope">
          <div className="stack-sm">
            <Checkbox label="All plants" checked={f.allPlants} onChange={(e) => setF({ ...f, allPlants: e.target.checked })} />
            {!f.allPlants && <div className="row-wrap">{meta.plants.map((p) => <Checkbox key={p.code} label={`${p.code} ${p.name}`} checked={f.plants.includes(p.code)} onChange={() => toggle('plants', p.code)} />)}</div>}
          </div>
        </Field>
        {f.roles.includes('BUY') && (
          <Field label="Buyer categories" hint="Categories this buyer owns (the assignment matrix in Master mappings drives PR routing)." error={fieldError(save.error, 'categories')}>
            <div className="row-wrap">{meta.categories.map((c) => <Checkbox key={c.code} label={c.code} title={c.name} checked={f.categories.includes(c.code)} onChange={() => toggle('categories', c.code)} />)}</div>
          </Field>
        )}
        {rolesChanged && <Field label="Reason for the role change" required hint="At least 10 characters. Recorded in the audit trail."><Textarea rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>}
      </div>
    </Modal>
  );
}
