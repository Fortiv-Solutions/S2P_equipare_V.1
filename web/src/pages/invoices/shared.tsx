import type { ReactNode } from 'react';
import { FlaskConical } from 'lucide-react';
import { SimBadge } from '@/components/ui';
import { fmtMoney } from '@/lib/format';

export const OCR_NOTE = 'Simulated OCR — values come from the uploaded details; no OCR engine is connected';

export interface FieldDef { key: string; label: string; kind: 'text' | 'code' | 'date' | 'money' | 'number' | 'pct'; mandatory?: boolean; critical?: boolean }
export interface ReadField { value: string | number | null; found: boolean; confidence: number }
export interface Extracted { engine: string; capture: 'pdf' | 'photo'; header: Record<string, ReadField>; lines: Record<string, ReadField>[]; note: string }
export interface Check { item?: number | null; check: string; expected: string; actual: string; tolerance?: string; ok: boolean; note?: string }
export interface RuleResult { rule: string; label: string; status: 'pass' | 'fail' | 'info' | 'waiting' | 'skipped'; summary: string; checks: Check[] }
export interface AdvanceInfo { advances: { id: number; adv_no: string; amount: number; adjusted: number; outstanding: number; status: string; basis: string }[]; outstanding: number; proposed_adjustment: number; balance_payable: number }
export interface Exc {
  id: number; invoice_id: number; rule: string; rule_label: string; severity: string; message: string; expected: string | null; actual: string | null; tolerance: string | null;
  owner_role: string; owner_user_id: number | null; owner_name: string | null; status: string; resolution: string | null; reason: string; line_item: number | null; age_days: number;
  created_at: string; resolved_at: string | null; resolved_by_name: string | null; auto_clear: number;
}

/** Banner text and badge shown on every screen that displays OCR-extracted data (DEC-01). */
export function OcrNote({ compact }: { compact?: boolean }) {
  return (
    <span className="row-wrap small" style={{ gap: 8 }}>
      <SimBadge title="No OCR engine is connected (DEC-01). The simulated engine reads the values typed in next to the uploaded file.">Simulated OCR</SimBadge>
      {!compact && <span className="muted">{OCR_NOTE}</span>}
    </span>
  );
}

export const OcrIcon = FlaskConical;

/** Confidence bar: red below the field's threshold, purple at or above (never colour only — the number is printed). */
export function ConfBar({ value, threshold, found }: { value: number; threshold: number; found: boolean }) {
  if (!found) return <span className="small subtle">Not found</span>;
  const pct = Math.round(value * 1000) / 10;
  const low = value < threshold;
  return (
    <div className="row" style={{ gap: 8, minWidth: 110 }} title={`Confidence ${pct}% · threshold ${Math.round(threshold * 100)}%`}>
      <div className="progress grow" data-tone={low ? 'bad' : undefined} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="OCR confidence"><span style={{ width: `${pct}%` }} /></div>
      <span className="small num" style={{ color: low ? 'var(--bad)' : 'var(--text-3)', fontWeight: low ? 700 : 500, width: 42, textAlign: 'right' }}>{pct.toFixed(1)}%</span>
    </div>
  );
}

export const showVal = (def: FieldDef | undefined, v: string | number | null | undefined): ReactNode => {
  if (v === null || v === undefined || v === '') return <span className="subtle">Not found</span>;
  if (def?.kind === 'money') return fmtMoney(Number(v));
  if (def?.kind === 'pct') return `${v}%`;
  return <span className={def?.kind === 'code' ? 'mono' : undefined}>{String(v)}</span>;
};

export const RULE_TONE: Record<RuleResult['status'], 'ok' | 'bad' | 'info' | 'warn' | 'neutral'> = { pass: 'ok', fail: 'bad', info: 'info', waiting: 'warn', skipped: 'neutral' };
export const RULE_WORD: Record<RuleResult['status'], string> = { pass: 'Pass', fail: 'Fail', info: 'For information', waiting: 'Waiting', skipped: 'Not run' };

export const OWNER_LABEL: Record<string, string> = { FIN: 'Finance', BUY: 'Buyer', STO: 'Stores', APR: 'Procurement manager' };

export const TABS = [
  { id: 'exception', label: 'Exceptions' },
  { id: 'pending', label: 'Waiting' },
  { id: 'matched', label: 'To approve' },
  { id: 'approved', label: 'To park / post' },
  { id: 'parked', label: 'Parked' },
  { id: 'posted', label: 'Posted' },
  { id: 'paid', label: 'Paid' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'rejected', label: 'Rejected' },
] as const;
