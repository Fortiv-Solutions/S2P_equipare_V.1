/**
 * Design-system primitives. Every module composes screens from these so the platform reads as one
 * product. Prefer adding a variant here over writing one-off styles in a page.
 */
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, CircleAlert, Info, Loader2, RefreshCw, FlaskConical, Inbox, Clock3, Scale } from 'lucide-react';
import { toneOf, type Tone } from '@/lib/status';
import { ago, fmtDateTime, initials } from '@/lib/format';
import { useMeta } from '@/lib/auth';

// ---------------------------------------------------------------- Button
type BtnVariant = 'primary' | 'secondary' | 'accent' | 'deep' | 'ghost' | 'danger' | 'decision' | 'ok';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  loading?: boolean;
  iconOnly?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, iconOnly, className = '', children, disabled, type = 'button', ...rest },
  ref,
) {
  const cls = ['btn', `btn--${variant}`, size !== 'md' ? `btn--${size}` : '', iconOnly ? 'btn--icon' : '', className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Loader2 className="spin" aria-hidden /> : icon}
      {iconOnly ? <span className="sr-only">{children}</span> : children}
    </button>
  );
});

export function ButtonLink({ to, variant = 'secondary', size = 'md', icon, children, className = '' }: { to: string; variant?: BtnVariant; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={['btn', `btn--${variant}`, size !== 'md' ? `btn--${size}` : '', className].join(' ')}>
      {icon}
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------- Badges
export function Badge({ tone = 'neutral', children, plain, title }: { tone?: Tone; children: ReactNode; plain?: boolean; title?: string }) {
  return (
    <span className={`badge badge--${tone}${plain ? ' badge--plain' : ''}`} title={title}>
      {children}
    </span>
  );
}

/** Status badge with the shared tone vocabulary. Colour is never the only signal — the text is the status. */
export function Status({ value, tone }: { value?: string | null; tone?: Tone }) {
  if (!value) return <span className="subtle">—</span>;
  return <Badge tone={tone ?? toneOf(value)}>{value}</Badge>;
}

export function Priority({ value }: { value?: string | null }) {
  if (!value || value === 'Normal' || value === 'General stock') return <span className="chip">{value ?? 'Normal'}</span>;
  const k = value.replace(/\s/g, '');
  return <span className={`chip chip--priority chip--${k}`}>{value}</span>;
}

/** Marks simulated external operations (SAP, OCR, e-mail/SMS, AI) — never presented as live. */
export function SimBadge({ children = 'Simulated', title }: { children?: ReactNode; title?: string }) {
  return (
    <span className="sim" title={title ?? 'Simulated in this MVP — no live external system is connected.'}>
      <FlaskConical aria-hidden />
      {children}
    </span>
  );
}

/** A value that is a proposed default awaiting an Equipcare decision (PRD Sec 18). */
export function DecisionTag({ id }: { id?: string | null }) {
  if (!id) return null;
  return (
    <span className="decision-tag" title={`Pending Equipcare decision ${id} — proposed default shown`}>
      <Scale size={11} aria-hidden />
      {id}
    </span>
  );
}

/** SAP freshness indicator for SAP-sourced data (FR-PLT-04). */
export function Freshness({ flow, label }: { flow: string; label?: string }) {
  const meta = useMeta();
  const f = meta.data?.freshness.find((x) => x.id === flow);
  if (!f) return null;
  if (f.stale)
    return (
      <span className="stale" title={`Older than the ${f.thresholdMinutes}-minute freshness threshold`}>
        <Clock3 size={12} aria-hidden /> Stale · {label ?? 'SAP'} synced {ago(f.lastSuccess)}
      </span>
    );
  return (
    <span className="fresh" title={`Last successful sync ${fmtDateTime(f.lastSuccess)}`}>
      <RefreshCw size={12} aria-hidden /> {label ?? 'SAP'} synced {ago(f.lastSuccess)}
    </span>
  );
}

// ---------------------------------------------------------------- Layout
export function PageHeader({ title, sub, eyebrow, screen, actions, badges }: { title: ReactNode; sub?: ReactNode; eyebrow?: ReactNode; screen?: string; actions?: ReactNode; badges?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="grow">
        {(eyebrow || screen) && (
          <div className="page-head__eyebrow">
            {eyebrow}
            {screen && <span className="page-head__screen" title="PRD screen reference">{screen}</span>}
          </div>
        )}
        <div className="page-head__title">
          <h1>{title}</h1>
          {badges}
        </div>
        {sub && <p className="page-head__sub">{sub}</p>}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, actions, children, flush, foot, className = '', id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; foot?: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`card ${className}`} id={id}>
      {(title || actions) && (
        <div className="card__head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions && <div className="row-wrap">{actions}</div>}
        </div>
      )}
      <div className={flush ? 'card__body card__body--flush' : 'card__body'}>{children}</div>
      {foot && <div className="card__foot">{foot}</div>}
    </section>
  );
}

export function Kpi({ label, value, meta, tone, to, onClick, icon }: { label: ReactNode; value: ReactNode; meta?: ReactNode; tone?: 'ok' | 'warn' | 'bad'; to?: string; onClick?: () => void; icon?: ReactNode }) {
  const inner = (
    <>
      <span className="kpi__label">{icon}{label}</span>
      <span className="kpi__value">{value}</span>
      {meta && <span className="kpi__meta">{meta}</span>}
    </>
  );
  if (to) return <Link className="kpi" to={to} data-tone={tone}>{inner}</Link>;
  if (onClick) return <button className="kpi" onClick={onClick} data-tone={tone}>{inner}</button>;
  return <div className="kpi" data-tone={tone}>{inner}</div>;
}

export function KV({ items, cols }: { items: [ReactNode, ReactNode][]; cols?: boolean }) {
  if (cols)
    return (
      <dl className="kv kv--cols">
        {items.map(([k, v], i) => (
          <div key={i}>
            <dt>{k}</dt>
            <dd>{v ?? '—'}</dd>
          </div>
        ))}
      </dl>
    );
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Callout({ tone = 'info', title, children, icon }: { tone?: 'info' | 'warn' | 'bad' | 'ok' | 'decision'; title?: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  const I = tone === 'ok' ? CheckCircle2 : tone === 'bad' ? CircleAlert : tone === 'warn' ? AlertTriangle : Info;
  return (
    <div className={`callout callout--${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      {icon ?? <I aria-hidden />}
      <div className="stack-sm" style={{ gap: 2 }}>
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- States
export function Empty({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__icon">{icon ?? <Inbox size={24} />}</div>
      <div className="empty__title">{title}</div>
      {children && <div style={{ maxWidth: 420 }}>{children}</div>}
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div className="empty" role="alert">
      <div className="empty__icon" style={{ background: 'var(--bad-bg)', color: 'var(--bad)' }}><CircleAlert size={24} /></div>
      <div className="empty__title">This could not load</div>
      <div>{msg}</div>
      {retry && <Button size="sm" icon={<RefreshCw />} onClick={retry}>Try again</Button>}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', r }: { h?: number; w?: number | string; r?: number }) {
  return <div className="skeleton" style={{ height: h, width: w, borderRadius: r }} aria-hidden />;
}

export function LoadingBlock({ rows = 5 }: { rows?: number }) {
  return (
    <div className="stack-sm" aria-busy="true" aria-label="Loading" style={{ padding: 18 }}>
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} h={i === 0 ? 22 : 14} w={i === 0 ? '40%' : `${90 - i * 7}%`} />)}
    </div>
  );
}

/** Wraps a react-query result with standard loading / error states. */
export function Loader<T>({ q, children, rows }: { q: { isLoading: boolean; error: unknown; data: T | undefined; refetch: () => unknown }; children: (data: T) => ReactNode; rows?: number }) {
  if (q.isLoading) return <LoadingBlock rows={rows} />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (q.data === undefined) return null;
  return <>{children(q.data)}</>;
}

// ---------------------------------------------------------------- Misc
export function Avatar({ name, size }: { name?: string | null; size?: 'sm' }) {
  return <span className={`avatar${size === 'sm' ? ' avatar--sm' : ''}`} aria-hidden>{initials(name)}</span>;
}

export function Ref({ children, to }: { children: ReactNode; to?: string }) {
  if (to) return <Link to={to} className="mono">{children}</Link>;
  return <span className="mono">{children}</span>;
}

export function Progress({ value, max = 100, tone, label }: { value: number; max?: number; tone?: 'warn' | 'bad'; label?: string }) {
  const pct = Math.max(0, Math.min(100, max ? (value / max) * 100 : 0));
  return (
    <div className="progress" data-tone={tone} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <span className="tabs__count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode }[]; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export function useUid(prefix = 'id') {
  return `${prefix}-${useId().replace(/:/g, '')}`;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="section-title">{children}</h3>;
}
