/**
 * Lightweight SVG/CSS charts. Every chart has a table view (PRD 10.1: charts are accessible and
 * exportable). Palette: purple series, amber for attention.
 */
import { useState, type ReactNode } from 'react';
import { BarChart3, Table2 } from 'lucide-react';
import { Button } from './ui';

export const SERIES = ['#7a3d97', '#f4b719', '#3d1a5e', '#bd8fd3', '#b8792a', '#9d97ab'];

export interface BarDatum { label: string; value: number; parts?: { label: string; value: number }[]; onClick?: () => void; hint?: string }

export function Bars({ data, format = (n) => String(n), title, max, legend }: { data: BarDatum[]; format?: (n: number) => string; title: string; max?: number; legend?: string[] }) {
  const [table, setTable] = useState(false);
  const top = max ?? Math.max(1, ...data.map((d) => d.value));
  return (
    <figure style={{ margin: 0 }} aria-label={title}>
      <div className="row between" style={{ marginBottom: 10 }}>
        {legend ? <div className="legend">{legend.map((l, i) => <span key={l}><i style={{ background: SERIES[i] }} />{l}</span>)}</div> : <span />}
        <Button size="sm" variant="ghost" iconOnly icon={table ? <BarChart3 /> : <Table2 />} onClick={() => setTable(!table)}>{table ? 'Show chart' : 'Show table'}</Button>
      </div>
      {table ? (
        <div className="tbl-wrap">
          <table className="tbl tbl--dense">
            <thead><tr><th>Item</th>{legend?.map((l) => <th key={l} className="num">{l}</th>)}<th className="num">Total</th></tr></thead>
            <tbody>{data.map((d) => <tr key={d.label}><td>{d.label}</td>{legend?.map((l, i) => <td key={l} className="num">{format(d.parts?.[i]?.value ?? 0)}</td>)}<td className="num">{format(d.value)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : data.length === 0 ? (
        <p className="muted small">No data for the current filters.</p>
      ) : (
        <div className="bars">
          {data.map((d) => {
            const row = (
              <>
                <span className="bars__label" title={d.label}>{d.label}</span>
                <span className="bars__track" title={d.hint}>
                  {d.parts ? d.parts.map((p, i) => <span key={p.label} className="bars__fill" style={{ width: `${(p.value / top) * 100}%`, background: SERIES[i] }} title={`${p.label}: ${format(p.value)}`} />)
                    : <span className="bars__fill" style={{ width: `${(d.value / top) * 100}%` }} />}
                </span>
                <span className="bars__val">{format(d.value)}</span>
              </>
            );
            return d.onClick ? (
              <div key={d.label} className="bars__row" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={d.onClick} onKeyDown={(e) => e.key === 'Enter' && d.onClick!()} aria-label={`${d.label}: ${format(d.value)} — open records`}>{row}</div>
            ) : <div key={d.label} className="bars__row">{row}</div>;
          })}
        </div>
      )}
    </figure>
  );
}

/** Share ring (e.g. contract coverage, response rate). */
export function Ring({ value, label, size = 96, tone = '#7a3d97' }: { value: number; label: ReactNode; size?: number; tone?: string }) {
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div className="row" style={{ gap: 14 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${Math.round(v * 100)} percent`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--steel-100)" strokeWidth="10" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth="10" strokeDasharray={`${c * v} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" style={{ font: '600 18px var(--font-display)', fill: 'var(--primary-900)' }}>{Math.round(v * 100)}%</text>
      </svg>
      <div className="small muted">{label}</div>
    </div>
  );
}

/** Tiny trend line. */
export function Spark({ points, width = 120, height = 32 }: { points: number[]; width?: number; height?: number }) {
  if (points.length < 2) return null;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const xy = points.map((p, i) => `${(i / (points.length - 1)) * width},${height - ((p - min) / (max - min || 1)) * (height - 4) - 2}`).join(' ');
  return <svg width={width} height={height} aria-hidden><polyline points={xy} fill="none" stroke="var(--primary-600)" strokeWidth="2" strokeLinejoin="round" /></svg>;
}
