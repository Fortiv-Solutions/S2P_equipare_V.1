import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Clock3 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ago, fmtDate } from '@/lib/format';
import { Badge, Card, Empty, Freshness, Kpi, LoadingBlock, ErrorState, PageHeader } from '@/components/ui';
import { Bars } from '@/components/charts';
import { navFor } from '@/nav';
import AdminHome from './AdminHome';

interface Tile { key: string; label: string; value: number | string; meta?: string; tone?: 'ok' | 'warn' | 'bad'; link?: string }
interface Task { title: string; subtitle?: string; link: string; tone?: 'ok' | 'warn' | 'bad' | 'info' | 'decision'; tag?: string; due?: string | null }
interface Home { role: string; tiles: Tile[]; tasks: Task[]; chart?: string }

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const ROLE_SUB: Record<string, string> = {
  REQ: 'Where each of your requirements stands, and who is buying it.',
  BUY: 'Your PR lines, RFQs and purchase orders that need a decision today.',
  APR: 'Approvals, exceptions and workload across procurement.',
  STO: 'What is arriving at your plants, and receipts with problems.',
  FIN: 'Invoices to validate, exceptions to resolve, payments and advances.',
  SAP: 'Health of the SAP interfaces and anything waiting for recovery.',
  MGT: 'Procurement performance and risk at a glance.',
  ADM: 'Accounts, business rules and platform housekeeping.',
};

/** Role home (SCR-PLT-01). The merged Administrator gets the ask / act now / at risk home; role accounts keep their dashboards. */
export default function HomePage() {
  const { me } = useAuth();
  if (me?.merged && me.role !== 'VEN') return <AdminHome />;
  return <RoleHome />;
}

function RoleHome() {
  const { me, can } = useAuth();
  const navigate = useNavigate();
  const q = useQuery<Home>({ queryKey: ['home', me?.role], queryFn: () => api.get('/home'), enabled: !!me && me.role !== 'VEN', refetchInterval: 60_000 });
  const notes = useQuery<{ items: { id: number; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null; severity: string }[] }>({ queryKey: ['notifications'], queryFn: () => api.get('/notifications'), enabled: !!me });
  const showChart = q.data?.chart === 'pr-ageing';
  const ageing = useQuery<{ buckets: string[]; rows: { key: string; total: number; counts: number[] }[] }>({ queryKey: ['pr', 'ageing', 'buyer'], queryFn: () => api.get('/pr/ageing', { by: 'buyer' }), enabled: showChart });
  if (!me) return null;
  if (me.role === 'VEN') return <Navigate to="/vendor" replace />;
  const links = navFor(false, can, true, !!me.merged).flatMap((g) => g.items).filter((i) => i.to !== '/').slice(0, 8);

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${me.name.split(' ')[0]}`} screen="SCR-PLT-01"
        eyebrow={<span>{new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())} · {me.roleLabel}</span>}
        sub={me.merged ? 'Every module in one workspace: PRs, RFQs, approvals, orders, receipts, invoices, integration and administration.' : ROLE_SUB[me.role]}
      />
      {q.isLoading ? <LoadingBlock rows={8} /> : q.error ? <ErrorState error={q.error} retry={q.refetch} /> : q.data && (
        <>
          <div className="grid-4" style={{ marginBottom: 20 }}>
            {q.data.tiles.map((t) => <Kpi key={t.key} label={t.label} value={t.value} meta={t.meta} tone={t.tone} to={t.link} />)}
          </div>
          <div className="split">
            <Card title={<div className="row-wrap"><h2>Next actions</h2><span className="small muted">{q.data.tasks.length ? `${q.data.tasks.length} item${q.data.tasks.length === 1 ? '' : 's'}` : ''}</span></div>} flush>
              {q.data.tasks.length === 0 ? (
                <Empty title="You are clear for now" icon={<CheckCircle2 size={24} />}>New work appears here as soon as it is assigned to you.</Empty>
              ) : (
                <ul className="list-plain">
                  {q.data.tasks.map((t, i) => (
                    <li key={i} style={{ borderBottom: i < q.data!.tasks.length - 1 ? '1px solid var(--steel-100)' : undefined }}>
                      <Link to={t.link} className="row" style={{ padding: '13px 18px', color: 'inherit', textDecoration: 'none', gap: 14 }}>
                        <span style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, background: t.tone === 'bad' ? 'var(--bad)' : t.tone === 'warn' ? 'var(--amber-500)' : t.tone === 'decision' ? 'var(--berry-600)' : t.tone === 'ok' ? 'var(--ok)' : 'var(--primary-600)' }} aria-hidden />
                        <span className="grow">
                          <span style={{ display: 'block', fontWeight: 600 }}>{t.title}</span>
                          {t.subtitle && <span className="small muted">{t.subtitle}</span>}
                        </span>
                        {t.due && <span className="small subtle nowrap desktop-only"><Clock3 size={12} /> {fmtDate(t.due)}</span>}
                        {t.tag && <Badge tone={t.tone === 'bad' ? 'bad' : t.tone === 'warn' ? 'warn' : t.tone === 'decision' ? 'decision' : 'info'} plain>{t.tag}</Badge>}
                        <ArrowRight size={16} color="var(--text-3)" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <div className="stack">
              {showChart && ageing.data && (
                <Card title="PR ageing by buyer" actions={<Link to="/pr?view=ageing" className="small">Open</Link>}>
                  <Bars title="Open PR lines by age and buyer" legend={ageing.data.buckets} data={ageing.data.rows.map((r) => ({ label: r.key, value: r.total, parts: r.counts.map((c, i) => ({ label: ageing.data!.buckets[i], value: c })), onClick: () => navigate('/pr?view=ageing') }))} />
                </Card>
              )}
              <Card title="Recent notifications" actions={<Link to="/notifications" className="small">View all</Link>}>
                {!notes.data?.items.length ? <p className="muted small">No notifications yet.</p> : (
                  <ul className="list-plain stack-sm">
                    {notes.data.items.slice(0, 6).map((n) => (
                      <li key={n.id}>
                        <Link to={n.link ?? '/notifications'} style={{ color: 'inherit' }}>
                          <span style={{ display: 'block', fontWeight: n.read_at ? 500 : 650 }}>{n.title}</span>
                          <span className="small subtle">{ago(n.created_at)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="Go to">
                <div className="grid-2" style={{ gap: 8 }}>
                  {links.map((l) => (
                    <Link key={l.to} to={l.to} className="btn btn--secondary btn--sm" style={{ justifyContent: 'flex-start' }}><l.icon size={15} />{l.label}</Link>
                  ))}
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}
