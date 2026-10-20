import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Users, SlidersHorizontal, Network, Timer, MailX, History, Stamp, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge, Card, Loader, PageHeader } from '@/components/ui';

export default function AdminHubPage() {
  const { can, me } = useAuth();
  const single = !!me?.singleUser;
  const q = useQuery<Record<string, number>>({ queryKey: ['admin', 'summary'], queryFn: () => api.get('/admin/summary') });
  const cards = [
    { to: '/admin/users', icon: Users, title: single ? 'Administrator account' : 'Users & roles', screen: 'SCR-ADM-01', perm: ['adm.users'], text: single ? 'The one account that holds every module, and how the vendor portal view works. No sign-in in single-user mode.' : 'Create users, assign roles and plant scope, lock, unlock, deactivate, reset passwords. Segregation-of-duties conflicts are warned.', meta: (s: any) => (single ? 'Single-user mode' : `${s.users} internal · ${s.vendor_users} vendor users${s.locked ? ` · ${s.locked} locked` : ''}${s.sod ? ` · ${s.sod} SoD warning(s)` : ''}`), tone: (s: any) => (!single && (s.locked || s.sod) ? 'warn' : undefined) },
    { to: '/admin/config', icon: SlidersHorizontal, title: 'Business configuration', screen: 'SCR-ADM-02', perm: ['adm.config', 'audit.view'], text: 'Routes, reminders, tolerances, SLAs and notification channels with versions and reasons. Tolerance changes need approval.', meta: (s: any) => `${s.config} settings · ${s.decisions_open} tied to open decisions${s.config_pending ? ` · ${s.config_pending} pending approval` : ''}`, tone: (s: any) => (s.config_pending ? 'warn' : undefined) },
    { to: '/admin/approval-matrix', icon: Stamp, title: 'Approval matrix', screen: 'SCR-ADM-02', perm: ['adm.config', 'apr.view'], text: 'Approval levels by type, value and category, with effective dates and versions (DEC-13).', meta: (s: any) => `${s.approval_matrix} active rule(s)` },
    { to: '/admin/masters', icon: Network, title: 'Master mappings', screen: 'SCR-ADM-03', perm: ['adm.masters'], text: 'Buyer assignment matrix, spend categories (minimum vendors, ITC) and material-group to category map.', meta: (s: any) => `${s.matrix_rows} buyer rows · ${s.categories} categories · ${s.groups} material groups` },
    { to: '/admin/jobs', icon: Timer, title: 'Scheduled jobs', screen: 'Jobs', perm: ['adm.config', 'sap.monitor'], text: 'Reminders, escalations, expiry checks and SAP syncs. Run any job now and read the run history.', meta: (s: any) => `${s.job_runs_24h} runs in 24 h${s.jobs_failed_24h ? ` · ${s.jobs_failed_24h} failed` : ''}`, tone: (s: any) => (s.jobs_failed_24h ? 'bad' : undefined) },
    { to: '/admin/outbox', icon: MailX, title: 'Simulated outbox', screen: 'Outbox', perm: ['adm.config', 'sap.monitor'], text: 'E-mail and SMS the platform would send. No provider is connected, so nothing is delivered.', meta: (s: any) => `${s.outbox} messages, none delivered` },
    { to: '/audit', icon: History, title: 'Audit log', screen: 'SCR-ADM-04', perm: ['audit.view'], text: 'Hash-chained audit trail with filters, CSV export and chain verification.', meta: (s: any) => `${s.audit_24h} events in 24 h` },
  ].filter((c) => can(...c.perm) && !(me?.merged && c.to === '/audit'));
  return (
    <>
      <PageHeader title="Administration" screen="SCR-ADM" sub={single ? 'Accounts, business rules, approval matrix, master mappings and system jobs. Every action here is audited.' : 'Platform administration. Administrators never approve commercial or financial decisions, and every action here is audited.'} />
      <Loader q={q} rows={6}>{(s) => (
        <div className="grid-3">
          {cards.map((c) => (
            <Link key={c.to} to={c.to} className="card" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
              <div className="card__body stack-sm">
                <div className="row between"><span style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--primary-50)', color: 'var(--primary-700)' }}><c.icon size={20} aria-hidden /></span><span className="page-head__screen">{c.screen}</span></div>
                <h2 style={{ fontSize: 'var(--fs-16)' }}>{c.title}</h2>
                <p className="small muted" style={{ margin: 0 }}>{c.text}</p>
                <div className="row between"><Badge tone={(c.tone?.(s) as any) ?? 'neutral'} plain>{c.meta(s)}</Badge><ChevronRight size={16} aria-hidden /></div>
              </div>
            </Link>
          ))}
          {cards.length === 0 && <Card><p>Your role has no administration screens.</p></Card>}
        </div>
      )}</Loader>
    </>
  );
}
