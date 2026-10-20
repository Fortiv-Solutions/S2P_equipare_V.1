/**
 * Report engine (PRD Sec 13). Every report is a list of record rows; tiles, chart and table are all
 * computed from the same scoped, filtered rows so each metric reconciles with its drill-down (AC-RPT-01).
 * Rows carry `tags` (tile membership) and hidden `_` scope fields used by the standard filters.
 */
import type { Actor } from '../../core/auth.ts';
import type { Role } from '../../core/permissions.ts';
import { all, get } from '../../core/db.ts';

export type Fmt = 'count' | 'money' | 'pct' | 'days' | 'hours' | 'score' | 'num';
export type ColKind = 'ref' | 'text' | 'money' | 'num' | 'date' | 'datetime' | 'status' | 'days' | 'hours' | 'pct' | 'score';
export interface Col { key: string; header: string; kind?: ColKind; link?: string; hidden?: boolean; restricted?: boolean }
export interface TileDef {
  key: string; label: string; format: Fmt; restricted?: boolean; hint?: string;
  agg: 'count' | 'sum' | 'median' | 'p90' | 'avg' | 'ratio_count' | 'ratio_sum';
  tag?: string; field?: string; den_tag?: string; den_field?: string; num_field?: string;
}
export interface ChartDef {
  title: string; groups: { key: string; label: string }[]; value: 'count' | { sum: string } | { avg: string }; format: Fmt;
  parts?: ({ label: string; tag: string } | { label: string; field: string })[]; restricted?: boolean; limit?: number;
}
export type Row = Record<string, unknown> & { id: string | number; link?: string | null; tags: string[] };
export interface Built { rows: Row[]; columns: Col[]; tiles: TileDef[]; chart?: ChartDef; empty?: string; notes?: string[]; decisions?: string[] }
export type FilterKey = 'date' | 'plant' | 'category' | 'buyer' | 'vendor' | 'priority' | 'route';
export interface Filters { from?: string; to?: string; plant?: string; category?: string; buyer?: string; vendor?: string; priority?: string; route?: string; group?: string }
export interface ReportDef {
  id: string; no: string; title: string; screen: string; description: string; roles: Role[]; filters: FilterKey[]; dateLabel?: string;
  flows: string[]; /** Requisitioners only see their own records (PRD 6.2 "own"). */ own?: boolean; build: (actor: Actor, f: Filters) => Built;
}

// ---------------------------------------------------------------- statistics
export const median = (xs: number[]) => quantile(xs, 0.5);
export function quantile(xs: number[], q: number): number | null {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  if (q === 0.5) {
    const m = Math.floor(s.length / 2);
    return round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2, 2);
  }
  return round(s[Math.max(0, Math.ceil(q * s.length) - 1)], 2); // nearest-rank
}
export const p90 = (xs: number[]) => quantile(xs, 0.9);
export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
export const daysDiff = (a: string | null | undefined, b: string | null | undefined) => (a && b ? round((new Date(b).getTime() - new Date(a).getTime()) / 86400000, 1) : null);
export const hoursDiff = (a: string | null | undefined, b: string | null | undefined) => (a && b ? round((new Date(b).getTime() - new Date(a).getTime()) / 3600000, 1) : null);
export const today = () => new Date().toISOString().slice(0, 10);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------- scope & filters
/** Buyer "team" (PRD 6.2): the buyer, peers under the same manager and direct reports. */
export function teamOf(actor: Actor) {
  const me = get<{ manager_id: number | null }>('SELECT manager_id FROM users WHERE id = ?', actor.id);
  const ids = all<{ id: number }>('SELECT id FROM users WHERE id = ? OR manager_id = ? OR (manager_id IS NOT NULL AND manager_id = ?)', actor.id, actor.id, me?.manager_id ?? -1).map((r) => r.id);
  return new Set(ids);
}

export function scopeAndFilter(actor: Actor, def: ReportDef, rows: Row[], f: Filters) {
  const team = actor.role === 'BUY' ? teamOf(actor) : null;
  const plants = actor.plants;
  return rows.filter((r) => {
    if (actor.role === 'REQ' && r._req_id !== actor.id) return false;
    if (team && r._buyer_id != null && !team.has(Number(r._buyer_id))) return false;
    if (plants !== '*' && r._plant && !plants.includes(String(r._plant))) return false;
    const d = r._date ? String(r._date).slice(0, 10) : null;
    if (def.filters.includes('date')) {
      if (f.from && (!d || d < f.from)) return false;
      if (f.to && (!d || d > f.to)) return false;
    }
    if (f.plant && def.filters.includes('plant') && r._plant !== f.plant) return false;
    if (f.category && def.filters.includes('category') && r._category !== f.category) return false;
    if (f.buyer && def.filters.includes('buyer') && String(r._buyer_id ?? '') !== f.buyer) return false;
    if (f.vendor && def.filters.includes('vendor') && String(r._vendor_id ?? '') !== f.vendor) return false;
    if (f.priority && def.filters.includes('priority') && r._priority !== f.priority) return false;
    if (f.route && def.filters.includes('route') && r._route !== f.route) return false;
    return true;
  });
}

// ---------------------------------------------------------------- aggregation
export function tileValue(rows: Row[], t: TileDef) {
  const inTag = (tag?: string) => (tag ? rows.filter((r) => r.tags.includes(tag)) : rows);
  const sel = inTag(t.tag);
  const vals = (rs: Row[], field?: string) => rs.map((r) => num(r[field ?? ''])).filter((x): x is number => x !== null);
  const sum = (rs: Row[], field?: string) => round(vals(rs, field).reduce((s, x) => s + x, 0), 2);
  switch (t.agg) {
    case 'count': return { value: sel.length, n: sel.length };
    case 'sum': return { value: sum(sel, t.field), n: sel.length };
    case 'median': { const v = vals(sel, t.field); return { value: median(v), n: v.length }; }
    case 'p90': { const v = vals(sel, t.field); return { value: p90(v), n: v.length }; }
    case 'avg': { const v = vals(sel, t.field); return { value: v.length ? round(v.reduce((s, x) => s + x, 0) / v.length, 2) : null, n: v.length }; }
    case 'ratio_count': { const den = inTag(t.den_tag).length; return { value: den ? round(sel.length / den, 4) : null, n: sel.length, numerator: sel.length, denominator: den }; }
    case 'ratio_sum': {
      const n = sum(sel, t.num_field ?? t.field); const d = sum(inTag(t.den_tag), t.den_field ?? t.field);
      return { value: d ? round(n / d, 4) : null, n: sel.length, numerator: n, denominator: d };
    }
  }
}

export function chartData(rows: Row[], c: ChartDef, groupKey?: string) {
  const g = c.groups.find((x) => x.key === groupKey) ?? c.groups[0];
  const buckets = new Map<string, Row[]>();
  for (const r of rows) {
    const raw = r[g.key];
    const keys = Array.isArray(raw) ? (raw.length ? raw.map(String) : []) : [raw == null || raw === '' ? '—' : String(raw)];
    for (const k of keys) buckets.set(k, [...(buckets.get(k) ?? []), r]);
  }
  const agg = (rs: Row[]) => {
    if (c.value === 'count') return rs.length;
    if ('sum' in c.value) { const f = c.value.sum; return round(rs.reduce((s, r) => s + (num(r[f]) ?? 0), 0), 2); }
    const f = c.value.avg; const v = rs.map((r) => num(r[f])).filter((x): x is number => x !== null);
    return v.length ? round(v.reduce((s, x) => s + x, 0) / v.length, 1) : 0;
  };
  const data = [...buckets.entries()].map(([label, rs]) => ({
    label, value: agg(rs), count: rs.length,
    parts: c.parts?.map((p) => ('tag' in p ? { label: p.label, value: rs.filter((r) => r.tags.includes(p.tag)).length } : { label: p.label, value: round(rs.reduce((s, r) => s + (num(r[p.field]) ?? 0), 0), 2) })),
  })).sort((a, b) => b.value - a.value).slice(0, c.limit ?? 25);
  return { title: c.title, group: g.key, group_label: g.label, groups: c.groups, format: c.format, legend: c.parts?.map((p) => p.label), data };
}
