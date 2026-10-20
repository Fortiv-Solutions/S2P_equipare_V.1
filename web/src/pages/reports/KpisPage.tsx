import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Badge, Button, Card, DecisionTag, ErrorState, LoadingBlock, PageHeader, Segmented } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { Field, Input } from '@/components/forms';
import { BASELINE, fmtValue, mobileFor, toColumns, type Col } from './common';

interface Kpi {
  id: string; name: string; formula: string; unit: string; value: number | null; median?: number | null; p90?: number | null; numerator?: number; denominator?: number; n: number;
  columns: Col[]; rows: Record<string, any>[]; empty: string; note?: string; decision?: string; period_applies: boolean;
}
interface Data { from: string; to: string; as_of: string; kpis: Kpi[] }

const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

export default function KpisPage() {
  const [sp, setSp] = useSearchParams();
  const from = sp.get('from') ?? day(90);
  const to = sp.get('to') ?? day(0);
  const q = useQuery<Data>({ queryKey: ['reports', 'kpis', from, to], queryFn: () => api.get('/reports/kpis', { from, to }), retry: false });
  const [preset, setPreset] = useState('90');
  const set = (f: string, t: string) => { sp.set('from', f); sp.set('to', t); setSp(sp, { replace: true }); };
  const hash = useLocation().hash.slice(1);
  useEffect(() => { if (hash && q.data) document.getElementById(hash)?.scrollIntoView({ block: 'start' }); }, [hash, q.data]);
  return (
    <>
      <PageHeader eyebrow={<><Link to="/reports">Reports</Link><span>/</span><span>KPIs</span></>} screen="SCR-RPT-KPI" title="KPI-01 … KPI-15"
        sub="Exact PRD formulas with median and P90 where stated. Open “Show records” to see every record behind a value."
        actions={<Button icon={<Printer />} onClick={() => window.print()}>Print / save as PDF</Button>} />
      <Card className="no-print">
        <div className="row-wrap" style={{ alignItems: 'flex-end' }}>
          <Segmented label="Period" value={preset} onChange={(v) => { setPreset(v); if (v !== 'custom') set(day(Number(v)), day(0)); }} options={[{ id: '30', label: 'Last 30 days' }, { id: '90', label: 'Last 90 days' }, { id: '365', label: 'Last 12 months' }, { id: 'custom', label: 'Custom' }]} />
          <Field label="From"><Input type="date" value={from} max={to} onChange={(e) => { setPreset('custom'); set(e.target.value, to); }} /></Field>
          <Field label="To"><Input type="date" value={to} min={from} max={day(0)} onChange={(e) => { setPreset('custom'); set(from, e.target.value); }} /></Field>
        </div>
        <p className="small muted" style={{ margin: '10px 0 0' }}>{BASELINE}. KPIs marked “current” (approval ageing, vendor score, advance outstanding) are point-in-time and ignore the period.</p>
      </Card>
      <div className="stack" style={{ marginTop: 16 }}>
        {q.isLoading ? <LoadingBlock rows={8} /> : q.error || !q.data ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
          <>
            <p className="small muted" style={{ margin: 0 }}>As of {fmtDateTime(q.data.as_of)} · {q.data.from} to {q.data.to}</p>
            {q.data.kpis.map((k) => <KpiCard key={k.id} k={k} />)}
          </>
        )}
      </div>
    </>
  );
}

function KpiCard({ k }: { k: Kpi }) {
  const [open, setOpen] = useState(false);
  const f = k.unit === 'lines' ? 'count' : k.unit;
  const columns = useMemo(() => toColumns(k.columns), [k.columns]);
  const med = k.median !== undefined && k.unit !== 'pct' && k.unit !== 'money';
  return (
    <Card id={k.id} title={<div className="row-wrap"><span className="mono">{k.id}</span><h2>{k.name}</h2>{!k.period_applies && <Badge tone="neutral">Current</Badge>}<DecisionTag id={k.decision} /></div>}
      actions={<Button size="sm" variant="ghost" icon={open ? <ChevronUp /> : <ChevronDown />} onClick={() => setOpen(!open)}>{open ? 'Hide records' : `Show records (${k.rows.length})`}</Button>}>
      <div className="stack-sm">
        <div className="row-wrap" style={{ gap: 28, alignItems: 'flex-end' }}>
          <div><div className="small muted">{med ? 'Median' : k.unit === 'money' ? 'Outstanding' : 'Value'}</div><div style={{ font: '600 28px var(--font-display)', color: 'var(--primary-900)' }}>{fmtValue(k.value, f)}</div></div>
          {k.p90 !== undefined && k.p90 !== null && <div><div className="small muted">P90</div><div style={{ font: '600 22px var(--font-display)' }}>{fmtValue(k.p90, f)}</div></div>}
          {k.unit === 'money' && k.median != null && <div><div className="small muted">Median age</div><div style={{ font: '600 22px var(--font-display)' }}>{fmtValue(k.median, 'days')}</div></div>}
          {k.denominator != null && <div><div className="small muted">Numerator / denominator</div><div style={{ font: '600 18px var(--font-display)' }}>{k.numerator?.toLocaleString('en-IN')} / {k.denominator.toLocaleString('en-IN')}</div></div>}
          <div><div className="small muted">Records</div><div style={{ font: '600 18px var(--font-display)' }}>{k.rows.length}</div></div>
        </div>
        <div className="small"><strong>Formula:</strong> {k.formula}</div>
        {k.note && <div className="small muted">{k.note}</div>}
        {k.value === null && <div className="small muted">{k.empty}</div>}
        <div className="small muted">{BASELINE}</div>
      </div>
      {open && (
        <div style={{ margin: '14px -16px -16px', borderTop: '1px solid var(--line)' }}>
          <DataTable id={`kpi-${k.id}`} rows={k.rows} columns={columns} rowKey={(r) => r.id} rowLink={(r) => r.link ?? undefined} dense savedViews={false} exportName={k.id} pageSize={10} mobile={mobileFor(k.columns, columns)}
            empty={<div className="empty"><div className="empty__title">No records</div><div>{k.empty}</div></div>} />
        </div>
      )}
    </Card>
  );
}
