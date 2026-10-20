import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { fmtDate, fmtDateTime, fmtLakh, fmtMoney, fmtNum, fmtPct } from '@/lib/format';
import { Ref, Status } from '@/components/ui';
import type { Column } from '@/components/DataTable';

export interface Col { key: string; header: string; kind?: string; link?: string; hidden?: boolean; restricted?: boolean }

export const BASELINE = 'Baseline: to be measured · Target: pending approval';

export function fmtValue(v: number | null | undefined, f: string): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  switch (f) {
    case 'money': return fmtLakh(v);
    case 'pct': return fmtPct(v);
    case 'days': return `${fmtNum(v)} d`;
    case 'hours': return `${fmtNum(v)} h`;
    case 'score': return v.toFixed(1);
    default: return fmtNum(v);
  }
}

/** DataTable columns for report / KPI record sets, with links to the record pages. */
export function toColumns(cols: Col[]): Column<Record<string, any>>[] {
  return cols.map((c) => ({
    key: c.key, header: c.header, hidden: c.hidden, align: ['money', 'num', 'days', 'hours', 'pct', 'score'].includes(c.kind ?? '') ? 'right' : undefined,
    nowrap: ['date', 'datetime', 'ref'].includes(c.kind ?? ''),
    value: (r) => (r[c.key] as string | number | null | undefined) ?? null,
    render: (r): ReactNode => {
      const v = r[c.key];
      if (v === null || v === undefined || v === '') return <span className="subtle">—</span>;
      const to = c.link ? (r[c.link] as string | null) : c.kind === 'ref' ? (r.link as string | null) : null;
      let out: ReactNode;
      switch (c.kind) {
        case 'money': out = fmtMoney(v as number, true); break;
        case 'date': out = fmtDate(v as string); break;
        case 'datetime': out = fmtDateTime(v as string); break;
        case 'status': out = <Status value={String(v)} />; break;
        case 'days': out = `${fmtNum(v as number)} d`; break;
        case 'hours': out = `${fmtNum(v as number)} h`; break;
        case 'pct': out = fmtPct(v as number); break;
        case 'score': out = (v as number).toFixed(1); break;
        case 'num': out = fmtNum(v as number); break;
        default: out = String(v);
      }
      if (c.kind === 'ref') return to ? <Ref to={to}>{out}</Ref> : <span className="mono">{out}</span>;
      return to ? <Link to={to}>{out}</Link> : out;
    },
  }));
}

/** Phone card layout for a record table: first column as title, first status as badge, next columns as meta. */
export function mobileFor(cols: Col[], cells: Column<Record<string, any>>[]) {
  const visible = cols.map((c, i) => ({ c, cell: cells[i] })).filter((x) => !x.c.hidden);
  const status = visible.find((x) => x.c.kind === 'status');
  const rest = visible.slice(1).filter((x) => x !== status).slice(0, 4);
  return {
    title: (r: Record<string, any>) => visible[0]?.cell.render?.(r) ?? '',
    badge: status ? (r: Record<string, any>) => status.cell.render?.(r) : undefined,
    meta: (r: Record<string, any>) => rest.map((x) => <span key={x.c.key}>{x.c.header}: {x.cell.render?.(r)}</span>),
  };
}
