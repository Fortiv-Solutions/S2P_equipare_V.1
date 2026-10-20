/** Display formatting. All timestamps are stored in UTC and shown in IST (NFR-TZ-01). */
const TZ = 'Asia/Kolkata';
const dateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const shortFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: '2-digit', month: 'short' });
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2, minimumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

const toDate = (v: string | Date) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00+05:30`) : new Date(v));

export const fmtDate = (v?: string | Date | null) => (v ? dateFmt.format(toDate(v)) : '—');
export const fmtDateTime = (v?: string | Date | null) => (v ? `${dateTimeFmt.format(toDate(v))} IST` : '—');
export const fmtShort = (v?: string | Date | null) => (v ? shortFmt.format(toDate(v)) : '—');
export const fmtMoney = (v?: number | null, whole = false) => (v === null || v === undefined || Number.isNaN(v) ? '—' : whole ? inr0.format(v) : inr.format(v));
export const fmtNum = (v?: number | null) => (v === null || v === undefined ? '—' : num.format(v));
export const fmtPct = (v?: number | null, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`);

/** Compact rupee amounts: ₹4.85 L, ₹1.2 Cr. */
export function fmtLakh(v?: number | null) {
  if (v === null || v === undefined) return '—';
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return inr0.format(v);
}

export function ago(v?: string | null) {
  if (!v) return '—';
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  const fut = s < 0;
  const a = Math.abs(s);
  const out = a < 60 ? 'just now' : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
  if (out === 'just now') return out;
  return fut ? `in ${out}` : `${out} ago`;
}

export const daysFrom = (v?: string | null) => (v ? Math.floor((Date.now() - toDate(v).getTime()) / 86400000) : null);
export const daysUntil = (v?: string | null) => (v ? Math.ceil((toDate(v).getTime() - Date.now()) / 86400000) : null);
export const initials = (name?: string | null) => (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
export const todayISO = () => new Date().toISOString().slice(0, 10);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
