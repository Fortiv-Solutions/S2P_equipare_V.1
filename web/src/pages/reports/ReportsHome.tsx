import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Gauge, Cable } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDateTime, fmtNum } from '@/lib/format';
import { Badge, Callout, Card, Loader, PageHeader } from '@/components/ui';
import { BASELINE, fmtValue } from './common';

interface Catalogue { scope: string; reports: { id: string; no: string; title: string; description: string; screen: string }[]; kpis: boolean; integration: boolean }
interface KpiSummary { from: string; to: string; as_of: string; kpis: { id: string; name: string; unit: string; value: number | null; n: number; numerator?: number; denominator?: number }[] }

export default function ReportsHome() {
  const q = useQuery<Catalogue>({ queryKey: ['reports', 'catalogue'], queryFn: () => api.get('/reports/catalogue') });
  return (
    <>
      <PageHeader title="Reports & KPIs" screen="SCR-RPT-01…12" eyebrow="Insight"
        sub="Twelve standard reports and fifteen KPIs. Every number drills down to the records behind it and shows the data time and SAP freshness." />
      <Loader q={q} rows={8}>{(d) => (
        <div className="stack">
          <div className="row-wrap small muted"><Badge tone="deep">Scope</Badge> {d.scope}</div>
          {d.kpis && <KpiStrip />}
          {d.reports.length === 0 ? (
            <Callout tone="info" title="Your role has no standard reports">{d.integration ? <>Integration health is on the <Link to="/integration">SAP integration monitor</Link>.</> : 'Ask your administrator if you need access.'}</Callout>
          ) : (
            <div className="grid-3">
              {d.reports.map((r) => (
                <Link key={r.id} to={`/reports/${r.id}`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="card__body stack-sm">
                    <div className="row between"><span className="mono small subtle">{r.no}</span><BarChart3 size={18} color="var(--primary-600)" aria-hidden /></div>
                    <h2 style={{ fontSize: 16 }}>{r.title}</h2>
                    <p className="small muted" style={{ margin: 0 }}>{r.description}</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
          {d.integration && d.reports.length > 0 && <Callout tone="info" icon={<Cable />} title="Integration health">See the <Link to="/integration">SAP integration monitor</Link> for flow status, queue depth and reconciliation.</Callout>}
        </div>
      )}</Loader>
    </>
  );
}

function KpiStrip() {
  const q = useQuery<KpiSummary>({ queryKey: ['reports', 'kpi-summary'], queryFn: () => api.get('/reports/kpis/summary') });
  return (
    <Card title={<div className="row-wrap"><h2>KPIs</h2><span className="small muted">Last 90 days unless the KPI is a point-in-time measure</span></div>}
      actions={<Link className="btn btn--secondary btn--sm" to="/reports/kpis"><Gauge size={14} /> All KPI details</Link>}>
      <Loader q={q} rows={3}>{(d) => (
        <>
          <div className="grid-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }}>
            {d.kpis.map((k) => (
              <Link key={k.id} to={`/reports/kpis#${k.id}`} className="kpi">
                <span className="kpi__label"><span className="mono" style={{ whiteSpace: 'nowrap' }}>{k.id}</span> {k.name}</span>
                <span className="kpi__value">{fmtValue(k.value, k.unit === 'lines' ? 'count' : k.unit)}</span>
                <span className="kpi__meta">{k.value === null ? 'No data in this period' : k.denominator != null ? `${fmtNum(k.numerator)} of ${fmtNum(k.denominator)}` : `${k.n} record${k.n === 1 ? '' : 's'}`}</span>
                <span className="kpi__meta" style={{ fontSize: 11 }}>{BASELINE}</span>
              </Link>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>As of {fmtDateTime(d.as_of)}. No baselines or targets are set yet.</p>
        </>
      )}</Loader>
    </Card>
  );
}
