/**
 * SIMULATED OCR ENGINE (AI-02, FR-INV-02, FR-INV-08).
 *
 * No OCR engine is connected (DEC-01). The uploader enters the invoice header and line values next to
 * the uploaded file; this engine "reads" exactly those values and assigns each field a deterministic
 * confidence derived from a hash of the file, field and value. Photographed images read with lower
 * confidence than PDFs, and long codes (GSTIN, bank account) lower still. Thresholds come from
 * `cfg('ocr.confidence')`. Nothing here claims a real recognition result.
 */
import crypto from 'node:crypto';
import { now } from '../../core/db.ts';
import { cfg } from '../../core/config.ts';

export const OCR_ENGINE = 'Simulated OCR v1 — no OCR engine connected (DEC-01)';
export const OCR_NOTE = 'Simulated OCR — values come from the uploaded details; no OCR engine is connected';

export interface FieldDef { key: string; label: string; kind: 'text' | 'code' | 'date' | 'money' | 'number' | 'pct'; mandatory?: boolean; critical?: boolean }

/** Header fields (FR-INV-02). `mandatory` = must be found; `critical` = confidence below threshold raises an exception. */
export const HEADER_FIELDS: FieldDef[] = [
  { key: 'invoice_no', label: 'Invoice number', kind: 'code', mandatory: true, critical: true },
  { key: 'invoice_date', label: 'Invoice date', kind: 'date', mandatory: true, critical: true },
  { key: 'vendor_gstin', label: 'Vendor GSTIN', kind: 'code', mandatory: true, critical: true },
  { key: 'buyer_gstin', label: 'Buyer GSTIN', kind: 'code', mandatory: true, critical: true },
  { key: 'po_no', label: 'PO number', kind: 'code', mandatory: true, critical: true },
  { key: 'payment_terms', label: 'Payment terms', kind: 'text' },
  { key: 'eway_bill', label: 'E-way bill number', kind: 'code' },
  { key: 'bank_account', label: 'Bank account', kind: 'code', critical: true },
  { key: 'bank_ifsc', label: 'Bank IFSC', kind: 'code' },
  { key: 'taxable_value', label: 'Taxable value', kind: 'money', critical: true },
  { key: 'gst_amount', label: 'GST amount', kind: 'money', critical: true },
  { key: 'freight', label: 'Freight', kind: 'money' },
  { key: 'other_charges', label: 'Other charges', kind: 'money' },
  { key: 'total_value', label: 'Invoice total', kind: 'money', mandatory: true, critical: true },
];
export const LINE_FIELDS: FieldDef[] = [
  { key: 'po_item', label: 'PO item', kind: 'number', mandatory: true, critical: true },
  { key: 'material_code', label: 'Material / service code', kind: 'code' },
  { key: 'description', label: 'Description', kind: 'text' },
  { key: 'hsn', label: 'HSN / SAC', kind: 'code', critical: true },
  { key: 'qty', label: 'Quantity', kind: 'number', mandatory: true, critical: true },
  { key: 'rate', label: 'Rate', kind: 'money', mandatory: true, critical: true },
  { key: 'taxable_value', label: 'Taxable value', kind: 'money' },
  { key: 'gst_rate', label: 'GST rate (%)', kind: 'pct', critical: true },
  { key: 'gst_amount', label: 'GST amount', kind: 'money' },
];
const LONG_CODES = new Set(['vendor_gstin', 'buyer_gstin', 'bank_account', 'bank_ifsc', 'eway_bill']);

export type Val = string | number | null;
export interface Header { [k: string]: Val }
export interface Line { [k: string]: Val }
export interface Entered { header: Header; lines: Line[] }
export interface ReadField { value: Val; found: boolean; confidence: number }
export interface Extracted {
  engine: string;
  simulated: true;
  note: string;
  capture: 'pdf' | 'photo';
  read_at: string;
  header: Record<string, ReadField>;
  lines: Record<string, ReadField>[];
}

export function normalizeValue(def: FieldDef | undefined, v: unknown): Val {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  if (!def) return typeof v === 'number' ? v : String(v).trim();
  if (def.kind === 'money' || def.kind === 'number' || def.kind === 'pct') {
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[,₹\s]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }
  const s = String(v).trim();
  return def.kind === 'code' ? s.toUpperCase().replace(/\s+/g, def.key === 'invoice_no' ? ' ' : '') : s;
}

export const fieldDef = (path: string) => {
  const p = path.split('.');
  return p[0] === 'lines' ? LINE_FIELDS.find((f) => f.key === p[2]) : HEADER_FIELDS.find((f) => f.key === p[0]);
};

/** Deterministic value in [0,1) from the file hash, field path and value. */
function unit(seed: string, path: string, value: Val) {
  const h = crypto.createHash('sha256').update(`${seed}|${path}|${value ?? ''}`).digest();
  return h.readUInt32BE(0) / 0x100000000;
}

export function confidenceFor(seed: string, path: string, key: string, value: Val, capture: 'pdf' | 'photo') {
  const u = unit(seed, path, value) * 2 - 1;
  const c = capture === 'pdf' ? 0.975 + u * 0.02 : 0.95 - (LONG_CODES.has(key) ? 0.02 : 0) + u * 0.04;
  return Math.round(Math.min(0.999, Math.max(0, c)) * 1000) / 1000;
}

export function thresholdFor(key: string) {
  const t = cfg<Record<string, number>>('ocr.confidence');
  return t[key] ?? t.default ?? 0.85;
}

/** "Read" the uploaded details (simulation). */
export function simulateOcr(input: Entered, seed: string, mime: string): Extracted {
  const capture = mime.startsWith('image/') ? 'photo' : 'pdf';
  const read = (path: string, def: FieldDef, raw: unknown): ReadField => {
    const value = normalizeValue(def, raw);
    const found = value !== null;
    return { value, found, confidence: found ? confidenceFor(seed, path, def.key, value, capture) : 0 };
  };
  const header: Record<string, ReadField> = {};
  for (const f of HEADER_FIELDS) header[f.key] = read(f.key, f, input.header[f.key]);
  const lines = input.lines.map((l, i) => {
    const out: Record<string, ReadField> = {};
    for (const f of LINE_FIELDS) out[f.key] = read(`lines.${i}.${f.key}`, f, l[f.key]);
    return out;
  });
  return { engine: OCR_ENGINE, simulated: true, note: OCR_NOTE, capture, read_at: now(), header, lines };
}

/** Values as read, for the working copy that finance may correct. */
export function valuesFrom(x: Extracted): Entered {
  const header: Header = {};
  for (const [k, f] of Object.entries(x.header)) header[k] = f.value;
  return { header, lines: x.lines.map((l) => Object.fromEntries(Object.entries(l).map(([k, f]) => [k, f.value]))) };
}

/** KPI-10 inputs: fields extracted (found) and how many a reviewer changed. */
export function accuracy(x: Extracted | null, correctedPaths: Set<string>) {
  if (!x) return { extracted: 0, corrected: 0, not_found: 0, accuracy: null as number | null };
  let extracted = 0;
  let notFound = 0;
  let corrected = 0;
  const visit = (path: string, f: ReadField) => {
    if (f.found) { extracted++; if (correctedPaths.has(path)) corrected++; } else notFound++;
  };
  for (const [k, f] of Object.entries(x.header)) visit(k, f);
  x.lines.forEach((l, i) => { for (const [k, f] of Object.entries(l)) visit(`lines.${i}.${k}`, f); });
  return { extracted, corrected, not_found: notFound, accuracy: extracted ? Math.round(((extracted - corrected) / extracted) * 10000) / 10000 : null };
}
