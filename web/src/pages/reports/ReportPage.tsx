import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Printer, X } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, fmtNum } from '@/lib/format';
import { Button, Callout, Card, DecisionTag, ErrorState, Freshness, Kpi, LoadingBlock, PageHeader, Segmented } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { Bars } from '@/components/charts';
import { Field, Input, Select } from '@/components/forms';
import { fmtValue, mobileFor, toColumns, type Col } from './common';

interface Tile { key: string; label: string; format: string; tag?: string; value: number | null; n: number; numerator?: number; denominator?: number; agg: string; hint?: string }
interface Report {
  id: string; no: string; title: string; screen: string; description: string; filters: string[]; date_label: string | null; scope: string; as_of: string;
  freshness: { id: string; name: string; lastSuccess: string | null; stale: boolean; thresholdMinutes: number; ageMinutes: number | null }[];
  columns: Col[]; tiles: Tile[]; rows: (Record<string, any> & { tags: string[] })[]; total_rows: number; empty: string; notes: string[]; decisions: string[]; can_export: boolean;
  chart: { title: string; group: string; groups: { key: string; label: string }[]; format: string; group_label?: string; legend?: string[]; data: { label: string; value: number; count: number; parts?: { label: string; value: number }[] }[] } | null;
}
interface FilterLists { plants: { code: string; name: string }[]; categories: { code: string; name: string }[]; buyers: { id: number; name: string }[]; vendors: { id: number; name: string }[]; priorities: string[]; routes: string[] }

const FILTER_KEYS = ['from', 'to', 'plant', 'category', 'buyer', 'vendor', 'priority', 'route', 'group'] as const;

export default function ReportPage() {
  const id = useParams().id!;
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [tag, setTag] = useState<{ tag: string; label: string } | null>(null);
  const [drill, setDrill] = useState<{ key: string; label: string } | null>(null);
  const applied = Object.fromEntries(FILTER_KEYS.map((k) => [k, sp.get(k) ?? undefined]));
  const q = useQuery<Report>({ queryKey: ['reports', id, applied], queryFn: () => api.get(`/reports/${id}`, applied), retry: false });
  const lists = useQuery<FilterLists>({ queryKey: ['reports', 'filters'], queryFn: () => api.get('/reports/filters'), staleTime: 300_000 });

  const set = (k: string, v: string) => { if (v) sp.set(k, v); else sp.delete(k); setSp(sp, { replace: true }); setTag(null); setDrill(null); };
  const r = q.data;
  const shown = useMemo(() => {
    if (!r) return [];
    let rows = r.rows;
    if (tag) rows = rows.filter((x) => x.tags.includes(tag.tag));
    if (drill) rows = rows.filter((x) => { const v = x[drill.key]; return Array.isArray(v) ? v.map(String).includes(drill.label) : String(v ?? '—') === drill.label; });
    return rows;
  }, [r, tag, drill]);

  const columns = useMemo(() => toColumns(r?.columns ?? []), [r]);

  if (q.isLoading) return <LoadingBlock rows={10} />;
  if (q.error || !r) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const fl = lists.data;
  const has = (k: string) => r.filters.includes(k);
  const exportQuery = { ...applied, tag: tag?.tag };

  return (
    <>
      <PageHeader eyebrow={<><Link to="/reports">Reports</Link><span>/</span><span className="mono">{r.no}</span></>} screen={r.screen} title={r.title} sub={r.description}
        actions={
          <>
            {r.can_export && <a className="btn btn--secondary no-print" href={downloadUrl(`/reports/${r.id}/export.csv`, exportQuery)}><Download size={16} /> Export CSV</a>}
            <Button icon={<Printer />} onClick={() => { api.post(`/reports/${r.id}/print`, applied).catch(() => undefined); window.print(); }}>Print / save as PDF</Button>
          </>
        } />

      <Card className="no-print">
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          {has('date') && <><Field label={`${r.date_label ?? 'Date'} from`}><Input type="date" value={sp.get('from') ?? ''} onChange={(e) => set('from', e.target.value)} /></Field><Field label="to"><Input type="date" value={sp.get('to') ?? ''} onChange={(e) => set('to', e.target.value)} /></Field></>}
          {has('plant') && <Field label="Plant"><Select value={sp.get('plant') ?? ''} onChange={(e) => set('plant', e.target.value)} placeholder="All plants" options={(fl?.plants ?? []).map((p) => ({ value: p.code, label: p.code }))} /></Field>}
          {has('category') && <Field label="Category"><Select value={sp.get('category') ?? ''} onChange={(e) => set('category', e.target.value)} placeholder="All categories" options={(fl?.categories ?? []).map((p) => ({ value: p.code, label: `${p.code} — ${p.name}` }))} /></Field>}
          {has('buyer') && <Field label="Buyer"><Select value={sp.get('buyer') ?? ''} onChange={(e) => set('buyer', e.target.value)} placeholder="All buyers" options={(fl?.buyers ?? []).map((p) => ({ value: p.id, label: p.name }))} /></Field>}
          {has('vendor') && <Field label="Vendor"><Select value={sp.get('vendor') ?? ''} onChange={(e) => set('vendor', e.target.value)} placeholder="All vendors" options={(fl?.vendors ?? []).map((p) => ({ value: p.id, label: p.name }))} /></Field>}
          {has('priority') && <Field label="Priority"><Select value={sp.get('priority') ?? ''} onChange={(e) => set('priority', e.target.value)} placeholder="All priorities" options={fl?.priorities ?? []} /></Field>}
          {has('route') && <Field label="Route"><Select value={sp.get('route') ?? ''} onChange={(e) => set('route', e.target.value)} placeholder="All routes" options={fl?.routes ?? []} /></Field>}
        </div>
        {FILTER_KEYS.some((k) => k !== 'group' && sp.get(k)) && <div style={{ marginTop: 10 }}><Button size="sm" variant="ghost" icon={<X />} onClick={() => { for (const k of FILTER_KEYS) sp.delete(k); setSp(sp, { replace: true }); setTag(null); setDrill(null); }}>Clear filters</Button></div>}
      </Card>

      <div className="row-wrap small muted" style={{ margin: '12px 0' }}>
        <span><strong>As of</strong> {fmtDateTime(r.as_of)}</span><span>·</span><span>Scope: {r.scope}</span>
        {r.freshness.map((f) => <Freshness key={f.id} flow={f.id} label={f.id} />)}
        {r.decisions.map((d) => <DecisionTag key={d} id={d} />)}
      </div>

      <div className="grid-4" style={{ marginBottom: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        {r.tiles.map((t) => (
          <Kpi key={t.key} label={t.label} value={fmtValue(t.value, t.format)}
            meta={t.denominator != null ? `${fmtNum(t.numerator)} of ${fmtNum(t.denominator)}` : t.agg === 'median' || t.agg === 'p90' ? `Median of ${t.n} record${t.n === 1 ? '' : 's'}` : t.n ? `${t.n} record${t.n === 1 ? '' : 's'}` : 'No records'}
            tone={tag?.tag === t.tag && t.tag ? 'warn' : undefined}
            onClick={t.tag ? () => { setDrill(null); setTag(tag?.tag === t.tag ? null : { tag: t.tag!, label: t.label }); } : undefined} />
        ))}
      </div>

      {r.chart && r.rows.length > 0 && (
        <Card title={r.chart.title} actions={r.chart.groups.length > 1 ? <Segmented label="Group by" value={r.chart.group} onChange={(g) => { sp.set('group', g); setSp(sp, { replace: true }); setDrill(null); }} options={r.chart.groups.map((g) => ({ id: g.key, label: g.label }))} /> : undefined}>
          <Bars title={r.chart.title} legend={r.chart.legend} format={(n) => fmtValue(n, r.chart!.format)} data={r.chart.data.map((d) => ({ label: d.label, value: d.value, parts: d.parts, hint: `${d.count} record${d.count === 1 ? '' : 's'}`, onClick: () => { setTag(null); setDrill({ key: r.chart!.group, label: d.label }); } }))} />
          <p className="small muted" style={{ marginTop: 10 }}>Select a bar to list its records. Use “Show table” for the numbers.</p>
        </Card>
      )}
      <div style={{ height: 16 }} />

      <Card title={<div className="row-wrap"><h2>Records</h2><span className="small muted">{shown.length} of {r.total_rows}</span></div>} flush
        actions={(tag || drill) ? <Button size="sm" variant="ghost" icon={<X />} onClick={() => { setTag(null); setDrill(null); }}>Showing {tag ? tag.label : `${r.chart?.group_label ?? drill!.key}: ${drill!.label}`} — show all</Button> : undefined}>
        <DataTable id={`report-${r.id}`} rows={shown} columns={columns} rowKey={(x) => x.id} rowLink={(x) => x.link ?? undefined} dense pageSize={25} exportName={r.no} mobile={mobileFor(r.columns, columns)}
          empty={<div className="empty"><div className="empty__title">No records</div><div>{r.empty}</div></div>} />
      </Card>
      {r.notes.length > 0 && <div className="stack-sm small muted" style={{ marginTop: 12 }}>{r.notes.map((n) => <p key={n} style={{ margin: 0 }}>{n}</p>)}</div>}
      {r.id === 'rpt-11' && <div style={{ marginTop: 12 }}><Callout tone="info" title="Vendor visibility">Vendors do not see this scorecard yet; their own scorecard and approved metrics are pending DEC-22.</Callout></div>}
    </>
  );
}

