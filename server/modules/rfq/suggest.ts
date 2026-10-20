/**
 * Deterministic vendor suggestions per RFQ line (FR-RFQ-02, RFQ-02) and invitation eligibility.
 *
 * Criteria and points (same inputs → same order, ties broken by vendor name):
 *   approved capability for the spend category (required, 40) · sub-category (20) · OEM / brand (10) ·
 *   region / plant (10) · past participation in RFQs (up to 10) · supplied this material before (5) ·
 *   performance score (score / 10, up to 10) · holds a valid contract for the material (10).
 * Exclusions: blocked in SAP, expired mandatory KYC document, no SAP code (unless permitted), not active.
 */
import { all, get, now } from '../../core/db.ts';
import { cfg } from '../../core/config.ts';

export interface Reason { code: string; label: string; points: number }
export interface LineSuggestion { vendor_id: number; name: string; sap_code: string | null; city: string | null; score: number; reasons: Reason[] }
export interface Exclusion { vendor_id: number; name: string; sap_code: string | null; reasons: string[] }

interface VendorRow {
  id: number; name: string; sap_code: string | null; city: string | null; state: string | null; sap_blocked: number;
  onboarding_status: string | null; performance_score: number | null; contact_email: string | null;
}
interface CapRow { vendor_id: number; category: string; sub_category: string | null; brand: string | null; region: string | null; supplier_role: string | null }
export interface SuggestLine { id: number; line_no: number; material_id: number | null; category: string | null; material_group: string | null; brand: string | null; plant: string; description: string }

const words = (s: string | null | undefined) =>
  (s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['equivalent', 'assorted', 'and', 'the'].includes(w));

/** Sub-category of a material: master value when present, else the material-group mapping (config). */
export function subCategoryOf(materialGroup: string | null | undefined, master?: string | null): string[] {
  if (master) return [master];
  const map = cfg<Record<string, string[]>>('rfq.subcategory_map');
  return materialGroup ? map[materialGroup] ?? [] : [];
}

/** Why a vendor cannot be invited right now (empty = eligible). */
export function ineligibility(vendorId: number): string[] {
  const v = get<VendorRow>('SELECT * FROM vendors WHERE id = ?', vendorId);
  if (!v) return ['Vendor not found'];
  const out: string[] = [];
  if (v.sap_blocked) out.push('Blocked in SAP');
  if (!v.sap_code) {
    if (!cfg<boolean>('rfq.allow_prospective_vendors')) out.push('No SAP vendor code — prospective vendors are not permitted (Q 18.1)');
  } else if (v.onboarding_status && v.onboarding_status !== 'Active') out.push(`Onboarding status is ${v.onboarding_status}`);
  const today = now().slice(0, 10);
  const expired = all<{ doc_type: string; expiry_date: string }>(
    "SELECT doc_type, expiry_date FROM vendor_documents WHERE vendor_id = ? AND mandatory = 1 AND ((expiry_date IS NOT NULL AND expiry_date < ?) OR status = 'Expired')",
    vendorId, today,
  );
  for (const d of expired) out.push(`Mandatory KYC document expired: ${d.doc_type}${d.expiry_date ? ` (${d.expiry_date})` : ''}`);
  return out;
}

function regionsFor(plant: string) {
  const map = cfg<Record<string, string[]>>('rfq.plant_regions');
  return map[plant] ?? [];
}

/** Suggestions for one line, plus vendors that match the category but are excluded. */
export function suggestForLine(line: SuggestLine): { suggestions: LineSuggestion[]; excluded: Exclusion[] } {
  if (!line.category) return { suggestions: [], excluded: [] };
  const caps = all<CapRow>("SELECT vendor_id, category, sub_category, brand, region, supplier_role FROM vendor_capabilities WHERE status = 'Approved' AND category = ?", line.category);
  const byVendor = new Map<number, CapRow[]>();
  for (const c of caps) byVendor.set(c.vendor_id, [...(byVendor.get(c.vendor_id) ?? []), c]);
  const material = line.material_id ? get<{ sub_category: string | null; material_group: string | null; brand: string | null }>('SELECT sub_category, material_group, brand FROM materials WHERE id = ?', line.material_id) : undefined;
  const subs = subCategoryOf(material?.material_group ?? line.material_group, material?.sub_category).map((x) => x.toLowerCase());
  const brandWords = words(material?.brand ?? line.brand);
  const regions = regionsFor(line.plant).map((r) => r.toLowerCase());
  const since = new Date(Date.now() - 365 * 86400000).toISOString();
  const suggestions: LineSuggestion[] = [];
  const excluded: Exclusion[] = [];

  for (const [vendorId, rows] of byVendor) {
    const v = get<VendorRow>('SELECT * FROM vendors WHERE id = ?', vendorId)!;
    const bad = ineligibility(vendorId);
    if (bad.length) {
      excluded.push({ vendor_id: v.id, name: v.name, sap_code: v.sap_code, reasons: bad });
      continue;
    }
    const reasons: Reason[] = [{ code: 'category', label: `Approved capability for ${line.category}`, points: 40 }];
    const subHit = rows.find((r) => r.sub_category && subs.includes(r.sub_category.toLowerCase()));
    if (subHit) reasons.push({ code: 'sub_category', label: `Sub-category match: ${subHit.sub_category}`, points: 20 });
    const brandHit = brandWords.length ? rows.find((r) => words(r.brand).some((w) => brandWords.includes(w))) : undefined;
    if (brandHit) reasons.push({ code: 'brand', label: `OEM / brand match: ${brandHit.brand}`, points: 10 });
    const regionHit = rows.find((r) => r.region && (r.region.toLowerCase() === 'all india' || regions.includes(r.region.toLowerCase())));
    if (regionHit) reasons.push({ code: 'region', label: `Serves ${line.plant} (${regionHit.region})`, points: 10 });
    const responded = get<{ n: number; invited: number }>(
      "SELECT SUM(CASE WHEN status = 'Responded' THEN 1 ELSE 0 END) AS n, COUNT(*) AS invited FROM rfq_invitations WHERE vendor_id = ? AND sent_at >= ?",
      vendorId, since,
    )!;
    if (responded.invited > 0) reasons.push({ code: 'participation', label: `Responded to ${responded.n ?? 0} of ${responded.invited} RFQs in 12 months`, points: Math.min(10, 2 * (responded.n ?? 0)) });
    if (line.material_id) {
      const pos = get<{ n: number }>('SELECT COUNT(DISTINCT p.id) AS n FROM po_lines pl JOIN pos p ON p.id = pl.po_id WHERE p.vendor_id = ? AND pl.material_id = ? AND p.po_date >= ?', vendorId, line.material_id, since.slice(0, 10))!;
      if (pos.n > 0) reasons.push({ code: 'history', label: `Supplied this material on ${pos.n} PO${pos.n === 1 ? '' : 's'} in 12 months`, points: 5 });
      const today = now().slice(0, 10);
      const contract = get<{ contract_no: string; type: string }>(
        `SELECT c.contract_no, c.type FROM contracts c JOIN contract_items ci ON ci.contract_id = c.id
         WHERE c.vendor_id = ? AND ci.material_id = ? AND c.status IN ('Active','Expiring') AND c.valid_from <= ? AND c.valid_to >= ? LIMIT 1`,
        vendorId, line.material_id, today, today,
      );
      if (contract) reasons.push({ code: 'contract', label: `Holds valid ${contract.type} ${contract.contract_no}`, points: 10 });
    }
    if (v.performance_score != null) reasons.push({ code: 'performance', label: `Performance score ${Math.round(v.performance_score)}`, points: Math.round(Math.min(100, v.performance_score) / 10) });
    suggestions.push({ vendor_id: v.id, name: v.name, sap_code: v.sap_code, city: v.city, score: reasons.reduce((s, r) => s + r.points, 0), reasons });
  }
  suggestions.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  excluded.sort((a, b) => a.name.localeCompare(b.name));
  return { suggestions, excluded };
}

/** RFQ-level view: union across lines with lines covered and best score. */
export function suggestForLines(lines: SuggestLine[]) {
  const perLine = lines.map((l) => ({ line_id: l.id, line_no: l.line_no, description: l.description, ...suggestForLine(l) }));
  const agg = new Map<number, { vendor_id: number; name: string; sap_code: string | null; city: string | null; score: number; lines: number[]; reasons: Reason[] }>();
  for (const pl of perLine) {
    for (const s of pl.suggestions) {
      const a = agg.get(s.vendor_id) ?? { vendor_id: s.vendor_id, name: s.name, sap_code: s.sap_code, city: s.city, score: 0, lines: [], reasons: [] };
      a.lines.push(pl.line_no);
      if (s.score > a.score) { a.score = s.score; a.reasons = s.reasons; }
      agg.set(s.vendor_id, a);
    }
  }
  const vendors = [...agg.values()].sort((a, b) => b.lines.length - a.lines.length || b.score - a.score || a.name.localeCompare(b.name));
  const exMap = new Map<number, Exclusion>();
  for (const pl of perLine) for (const e of pl.excluded) exMap.set(e.vendor_id, e);
  return { per_line: perLine, vendors, excluded: [...exMap.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
