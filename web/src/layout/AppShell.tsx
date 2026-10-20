import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, ChevronDown, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Search, UserRound, Repeat2, CloudOff, MoreHorizontal, CheckCheck, Building2, DoorOpen } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth, useMeta, type RoleCode } from '@/lib/auth';
import { navFor } from '@/nav';
import { ago } from '@/lib/format';
import { Avatar, Badge, Button } from '@/components/ui';
import { useToast } from '@/components/overlay';
import { ActAsVendorDialog } from './ActAsVendor';

interface Notif { id: number; title: string; body: string | null; link: string | null; severity: string; read_at: string | null; created_at: string; event: string }

function useOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onOut();
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref, onOut]);
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [debounced, setDebounced] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  useOutside(ref, () => setOpen(false));
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 220); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName))) {
        e.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const res = useQuery<{ type: string; ref: string; title: string; subtitle?: string; link: string }[]>({
    queryKey: ['search', debounced], queryFn: () => api.get('/search', { q: debounced }), enabled: debounced.trim().length >= 2,
  });
  const items = res.data ?? [];
  const go = (link: string) => { setOpen(false); setQ(''); navigate(link); };
  return (
    <div className="topbar__search" ref={ref}>
      <Search aria-hidden />
      <input
        ref={input} type="search" placeholder="Search PR, RFQ, PO, ASN, invoice, vendor…" aria-label="Global search" value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter' && items[active]) go(items[active].link);
          if (e.key === 'Escape') setOpen(false);
        }}
        role="combobox" aria-expanded={open && q.length >= 2} aria-controls="search-results" aria-autocomplete="list"
      />
      <span className="topbar__kbd" aria-hidden>Ctrl K</span>
      {open && q.trim().length >= 2 && (
        <div className="search-pop" id="search-results" role="listbox">
          {res.isLoading ? <div className="small muted" style={{ padding: 10 }}>Searching…</div> : items.length === 0 ? (
            <div className="small muted" style={{ padding: 10 }}>No records match “{q}”. Try a document number or vendor name.</div>
          ) : items.map((r, i) => (
            <a key={`${r.type}${r.ref}${i}`} href={r.link} className="search-pop__item" data-active={i === active} role="option" aria-selected={i === active}
              onClick={(e) => { e.preventDefault(); go(r.link); }}>
              <span className="badge badge--plain" style={{ justifySelf: 'start' }}>{r.type}</span>
              <span style={{ minWidth: 0 }}>
                <span className="mono" style={{ fontWeight: 600 }}>{r.ref}</span>
                <span className="small muted" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
              </span>
              <span className="small subtle">{r.subtitle}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  useOutside(ref, () => setOpen(false));
  const q = useQuery<{ items: Notif[]; unread: number }>({ queryKey: ['notifications'], queryFn: () => api.get('/notifications'), refetchInterval: 30_000 });
  const unread = q.data?.unread ?? 0;
  const openItem = async (n: Notif) => {
    setOpen(false);
    if (!n.read_at) await api.post(`/notifications/${n.id}/read`).catch(() => undefined);
    qc.invalidateQueries({ queryKey: ['notifications'] });
    if (n.link) navigate(n.link);
  };
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <Button variant="ghost" iconOnly icon={<Bell />} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true">
        {`Notifications${unread ? `, ${unread} unread` : ''}`}
      </Button>
      {unread > 0 && <span className="rail__count" style={{ position: 'absolute', top: -2, right: -4, pointerEvents: 'none' }} aria-hidden>{unread > 99 ? '99+' : unread}</span>}
      {open && (
        <div className="menu" style={{ right: 0, top: 44, width: 380, maxWidth: 'calc(100vw - 24px)', padding: 0 }}>
          <div className="row between" style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
            <strong>Notifications</strong>
            <div className="row">
              <Button size="sm" variant="ghost" icon={<CheckCheck />} disabled={!unread} onClick={async () => { await api.post('/notifications/read-all'); qc.invalidateQueries({ queryKey: ['notifications'] }); }}>Mark all read</Button>
            </div>
          </div>
          <div style={{ maxHeight: 420, overflow: 'auto', padding: 6 }}>
            {!q.data?.items.length ? <div className="small muted" style={{ padding: 14 }}>You are all caught up.</div> : q.data.items.slice(0, 12).map((n) => (
              <button key={n.id} className="menu__item" style={{ alignItems: 'flex-start', background: n.read_at ? undefined : 'var(--amber-50)' }} onClick={() => openItem(n)}>
                <span className="dot" style={{ color: n.severity === 'danger' ? 'var(--bad)' : n.severity === 'warning' ? 'var(--amber-500)' : n.severity === 'success' ? 'var(--ok)' : 'var(--primary-600)', marginTop: 6, opacity: n.read_at ? 0.3 : 1 }} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: n.read_at ? 500 : 600 }}>{n.title}</span>
                  {n.body && <span className="small muted" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>{n.body}</span>}
                  <span className="small subtle">{n.event} · {ago(n.created_at)}</span>
                </span>
              </button>
            ))}
          </div>
          <div style={{ borderTop: '1px solid var(--line)', padding: 6 }}>
            <Link to="/notifications" className="menu__item" onClick={() => setOpen(false)} style={{ justifyContent: 'center' }}>View all notifications</Link>
          </div>
        </div>
      )}
    </div>
  );
}

function UserMenu({ onActAsVendor }: { onActAsVendor: () => void }) {
  const { me, switchRole, logout, exitVendor } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const toast = useToast();
  useOutside(ref, () => setOpen(false));
  if (!me) return null;
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="btn btn--ghost" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" style={{ height: 44, paddingLeft: 6 }}>
        <Avatar name={me.name} />
        <span className="desktop-only" style={{ textAlign: 'left', lineHeight: 1.2 }}>
          <span style={{ display: 'block', fontSize: 'var(--fs-13)', color: 'var(--text)' }}>{me.name}</span>
          <span style={{ display: 'block', fontSize: 'var(--fs-11)', color: 'var(--text-3)', fontWeight: 500 }}>{me.vendor ? me.vendor.name : me.roleLabel}</span>
        </span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="menu" role="menu" style={{ right: 0, top: 50 }}>
          <div className="menu__label">{me.singleUser ? 'Single-user mode — no sign-in' : me.email}</div>
          {me.singleUser && (
            <>
              {me.actingVendor ? (
                <button role="menuitem" className="menu__item" onClick={async () => { setOpen(false); await exitVendor(); navigate('/'); toast('Back in the administrator workspace', 'info'); }}>
                  <DoorOpen size={15} aria-hidden /> Exit vendor portal
                </button>
              ) : (
                <button role="menuitem" className="menu__item" onClick={() => { setOpen(false); onActAsVendor(); }}>
                  <Building2 size={15} aria-hidden /> Open the vendor portal as…
                </button>
              )}
              <div className="menu__sep" />
            </>
          )}
          {!me.singleUser && me.roles.length > 1 && (
            <>
              <div className="menu__label">Act as</div>
              {me.roles.map((r) => (
                <button key={r.code} role="menuitemradio" aria-checked={r.code === me.role} className="menu__item" onClick={async () => {
                  setOpen(false);
                  if (r.code === me.role) return;
                  await switchRole(r.code as RoleCode);
                  navigate('/');
                  toast(`Now acting as ${r.label}`, 'info');
                }}>
                  <Repeat2 size={15} aria-hidden /> {r.label} {r.code === me.role && <Badge tone="ok" plain>Active</Badge>}
                </button>
              ))}
              <div className="menu__sep" />
            </>
          )}
          <button role="menuitem" className="menu__item" onClick={() => { setOpen(false); navigate('/profile'); }}><UserRound size={15} aria-hidden /> Profile & preferences</button>
          {!me.singleUser && <button role="menuitem" className="menu__item" onClick={async () => { await logout(); navigate('/login'); }}><LogOut size={15} aria-hidden /> Sign out</button>}
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const { me, can, isVendor, exitVendor } = useAuth();
  const navigate = useNavigate();
  const [actAs, setActAs] = useState(false);
  const meta = useMeta();
  const loc = useLocation();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('rail') === '1'; } catch { return false; } });
  const [drawer, setDrawer] = useState(false);
  const counts = useQuery<Record<string, number>>({ queryKey: ['nav-counts'], queryFn: () => api.get('/nav-counts'), refetchInterval: 45_000, enabled: !!me });
  useEffect(() => setDrawer(false), [loc.pathname]);
  if (!me) return null;
  const groups = navFor(isVendor, can, me.vendor?.onboarding_status === 'Active', !!me.merged);
  const flat = groups.flatMap((g) => g.items);
  const mobileItems = flat.filter((i) => i.mobile).slice(0, 4);
  const isActive = (to: string) => (to === '/' || to === '/vendor' ? loc.pathname === to : loc.pathname === to || loc.pathname.startsWith(to + '/'));

  return (
    <div className="shell" data-collapsed={collapsed}>
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}
      <nav className="rail" aria-label="Main" data-open={drawer}>
        <div className="rail__brand">
          <img src="/brand/logo-white.svg" alt="Equipcare" />
          <span className="rail__brand-sub">Source<br />to Pay</span>
        </div>
        {groups.map((g) => (
          <div className="rail__group" key={g.label}>
            <div className="rail__label">{g.label}</div>
            {g.items.map((i) => {
              const n = i.count ? counts.data?.[i.count] : undefined;
              return (
                <NavLink key={i.to} to={i.to} end={i.to === '/' || i.to === '/vendor' || i.to === '/admin'} className="rail__item" title={collapsed ? i.label : undefined}
                  aria-current={isActive(i.to) && (i.to !== '/admin' || loc.pathname === '/admin' || loc.pathname.startsWith('/admin/users')) ? 'page' : undefined}>
                  <i.icon aria-hidden />
                  <span className="rail__text">{i.label}</span>
                  {!!n && <span className="rail__count" aria-label={`${n} need attention`}>{n > 99 ? '99+' : n}</span>}
                </NavLink>
              );
            })}
          </div>
        ))}
        {me.singleUser && (
          <div className="rail__group">
            <div className="rail__label">Vendor portal</div>
            {me.actingVendor ? (
              <button className="rail__item" style={{ width: '100%', background: 'none', border: 0, font: 'inherit', textAlign: 'left', cursor: 'pointer' }} title={collapsed ? 'Exit vendor portal' : undefined}
                onClick={async () => { await exitVendor(); navigate('/'); }}>
                <DoorOpen aria-hidden /><span className="rail__text">Exit vendor portal</span>
              </button>
            ) : (
              <button className="rail__item" style={{ width: '100%', background: 'none', border: 0, font: 'inherit', textAlign: 'left', cursor: 'pointer' }} title={collapsed ? 'Open the vendor portal as…' : undefined} onClick={() => setActAs(true)}>
                <Building2 aria-hidden /><span className="rail__text">Open as a vendor…</span>
              </button>
            )}
          </div>
        )}
        <div className="rail__foot">
          Knowteq Equipcare LLP<br />{me.singleUser ? 'Single-user mode · no sign-in · local access only' : 'MVP · demo data'} · SAP, OCR and messaging simulated
        </div>
      </nav>
      <div className="main">
        <header className="topbar">
          <Button variant="ghost" iconOnly icon={<Menu />} className="mobile-only" onClick={() => setDrawer(true)}>Open menu</Button>
          <Button variant="ghost" iconOnly icon={collapsed ? <PanelLeftOpen /> : <PanelLeftClose />} className="desktop-only" onClick={() => { setCollapsed(!collapsed); try { localStorage.setItem('rail', collapsed ? '0' : '1'); } catch { /* ignore */ } }}>
            {collapsed ? 'Expand navigation' : 'Collapse navigation'}
          </Button>
          <GlobalSearch />
          <div className="grow" />
          <NotificationBell />
          <UserMenu onActAsVendor={() => setActAs(true)} />
        </header>
        {me.actingVendor && (
          <div className="banner banner--warn" role="status">
            <Building2 size={16} aria-hidden />
            <span className="grow"><strong>Vendor portal view: {me.actingVendor.name}.</strong> You are acting for this vendor; you see only its records, and actions are recorded against the vendor and the Administrator.</span>
            <Button size="sm" variant="secondary" icon={<DoorOpen />} onClick={async () => { await exitVendor(); navigate('/'); }}>Exit vendor portal</Button>
          </div>
        )}
        {meta.data?.sapOffline && !isVendor && (
          <div className="banner banner--danger" role="status">
            <CloudOff size={16} aria-hidden />
            <span><strong>SAP is unavailable</strong> (simulated outage). Platform actions still work; SAP writes are queued and SAP data may be out of date.</span>
          </div>
        )}
        <main className="content" id="main">
          <Outlet />
        </main>
      </div>
      {me.singleUser && <ActAsVendorDialog open={actAs} onClose={() => setActAs(false)} />}
      <nav className="mobile-nav" aria-label="Quick">
        {mobileItems.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.to === '/' || i.to === '/vendor'} aria-current={isActive(i.to) ? 'page' : undefined}>
            <i.icon aria-hidden />
            <span>{i.label.split(' ')[0]}</span>
          </NavLink>
        ))}
        <button onClick={() => setDrawer(true)}><MoreHorizontal aria-hidden /><span>More</span></button>
      </nav>
    </div>
  );
}
