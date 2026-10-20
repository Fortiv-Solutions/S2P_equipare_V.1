/** Indian tax identifier validation (OCR-04, FR-INV-04). */
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function gstinCheckChar(first14: string) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

export function makeGstin(stateCode: string, pan: string, entity = '1') {
  const base = `${stateCode}${pan}${entity}Z`;
  return base + gstinCheckChar(base);
}

export function validateGstin(g: string | null | undefined): { ok: boolean; reason?: string } {
  if (!g) return { ok: false, reason: 'GSTIN missing' };
  const v = g.trim().toUpperCase();
  if (!GSTIN_RE.test(v)) return { ok: false, reason: 'GSTIN format invalid' };
  if (gstinCheckChar(v.slice(0, 14)) !== v[14]) return { ok: false, reason: 'GSTIN check digit invalid' };
  return { ok: true };
}

export const panFromGstin = (g: string) => g.trim().toUpperCase().slice(2, 12);
export const validPan = (p: string | null | undefined) => !!p && PAN_RE.test(p.trim().toUpperCase());

export const STATE_CODES: Record<string, string> = {
  Maharashtra: '27', Jharkhand: '20', 'Tamil Nadu': '33', 'West Bengal': '19', Haryana: '06', Telangana: '36',
  Gujarat: '24', Karnataka: '29', Odisha: '21', Chhattisgarh: '22', 'Madhya Pradesh': '23',
};

/** Normalise an invoice number for duplicate detection: case, spaces, separators, leading zeros (FR-INV-03). */
export function normalizeInvoiceNo(n: string) {
  return n
    .toUpperCase()
    .replace(/[\s\-_/\\.]/g, '')
    .replace(/(^|[A-Z])0+(\d)/g, '$1$2');
}
