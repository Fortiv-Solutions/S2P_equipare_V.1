/**
 * Module 6 — Contract / ARC / OA / VMI / FDS management (PRD 7.6: FR-CON-01..09, WF-02, WF-12,
 * NTF-13/14/15, RPT-06/07, SCR-CON-01..04).
 *
 *  - SAP is the record for outline agreements (FR-CON-09). Platform contracts move
 *    Draft → Pending approval → Pending SAP and only become Active (routable) when the SAP OA syncs
 *    back with `platform_ref` = contract_no. SAP-owned contract fields (validity, value cap, payment
 *    and delivery terms, item prices/caps, consumption) are only written here while the contract is a
 *    platform draft; afterwards changes are approved here and applied in SAP, then synced.
 *  - Platform-owned terms (discount structure, price lists, invoice validation flag, VMI terms,
 *    renewal lead time, owner, terms text) are versioned/audited here.
 */
import { all, get, insert, update, run, J, now, tx, scalar, round2 } from '../../core/db.ts';
import { audit } from '../../core/audit.ts';
import { notify } from '../../core/notify.ts';
import { cfg } from '../../core/config.ts';
import { badRequest, conflict, forbidden, notFound } from '../../core/http.ts';
import { createApproval, type ApprovalRow } from '../../core/approvals.ts';
import { nextNo } from '../../core/numbering.ts';
import { staleInfo } from '../../core/sap.ts';
import { linkAttachments } from '../../core/files.ts';
import { assertVendorScope, type Actor } from '../../core/auth.ts';

export const CONTRACT_TYPES = ['ARC', 'OA', 'FDS', 'VMI', 'Fixed supplier'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];
/** Contracts in force (valid for routing when they also carry an SAP OA, FR-CON-09). */
export const IN_FORCE = ['Active', 'Expiring'];
/** Fields SAP owns once an OA exists (INT-M06 mapper writes them). */
export const SAP_FIELDS = ['valid_from', 'valid_to', 'value_cap', 'payment_terms', 'delivery_terms'] as const;
/** Fields the platform owns for every contract. */
export const PLATFORM_FIELDS = ['title', 'discount_pct', 'invoice_validation', 'renewal_lead_days', 'price_revision_date', 'terms', 'owner_id'] as const;

export interface VmiItem { material_id: number; material_code?: string; min: number; max: number }
export interface VmiTerms { items: VmiItem[]; replenishment_frequency: string; billing_cycle: string; reconciliation: string; plant?: string | null }

export interface Contract {
  id: number;
  contract_no: string;
  type: string;
  vendor_id: number;
  title: string | null;
  category: string | null;
  plant: string | null;
  sap_oa_no: string | null;
  valid_from: string;
  valid_to: string;
  status: string;
  value_cap: number | null;
  consumed_value: number;
  currency: string;
  payment_terms: string | null;
  delivery_terms: string | null;
  discount_pct: number | null;
  price_list_version: number | null;
  invoice_validation: number;
  vmi: VmiTerms | null;
  renewal_lead_days: number | null;
  price_revision_date: string | null;
  owner_id: number | null;
  approval_id: number | null;
  terms: string | null;
  created_by: number | null;
  created_at: string;
  synced_at: string | null;
  terminated_reason: string | null;
  renewed_from_id: number | null;
}
export interface ContractItem { id: number; contract_id: number; material_id: number; unit_price: number; qty_cap: number | null; consumed_qty: number; uom: string | null; discount_pct: number | null }
export interface PriceListRow { id: number; contract_id: number; version: number; effective_from: string; items: { material_id: number; material_code?: string; list_price: number }[]; created_by: number | null; created_at: string; note: string | null }
interface ChangeRow { id: number; contract_id: number; kind: string; before: any; after: any; status: string; approval_id: number | null; requested_by: number | null; reason: string | null; created_at: string; decided_at: string | null; applied_at: string | null; note: string | null }
interface AlertRow { id: number; po_id: number; po_line_id: number; po_no: string; item: number; material_id: number; contract_id: number; po_vendor_id: number; po_date: string; plant: string; qty: number; unit_price: number; contract_price: number | null; value: number; buyer_id: number | null; status: string; reason: string | null; approval_id: number | null; decided_by: number | null; decided_at: string | null; created_at: string }

const today = () => now().slice(0, 10);
const addDaysDate = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const daysTo = (d: string) => Math.round((new Date(`${d}T00:00:00Z`).getTime() - new Date(`${today()}T00:00:00Z`).getTime()) / 86400000);

// ------------------------------------------------------------------ tables owned by this module
/** Module tables not in the lead's schema (reported to the lead). Idempotent. */
export function ensureTables() {
  run(`CREATE TABLE IF NOT EXISTS contract_alerts (
    id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL, po_line_id INTEGER NOT NULL, po_no TEXT, item INTEGER, material_id INTEGER,
    contract_id INTEGER NOT NULL, po_vendor_id INTEGER, po_date TEXT, plant TEXT, qty REAL, unit_price REAL, contract_price REAL, value REAL,
    buyer_id INTEGER, status TEXT DEFAULT 'Open', reason TEXT, approval_id INTEGER, decided_by INTEGER, decided_at TEXT, created_at TEXT,
    UNIQUE (po_line_id, contract_id))`);
  run(`CREATE TABLE IF NOT EXISTS contract_changes (
    id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL, kind TEXT NOT NULL, before_json TEXT, after_json TEXT,
    status TEXT DEFAULT 'Pending approval', approval_id INTEGER, requested_by INTEGER, reason TEXT, created_at TEXT,
    decided_at TEXT, applied_at TEXT, note TEXT)`);
  run('CREATE INDEX IF NOT EXISTS ix_contract_changes_c ON contract_changes(contract_id)');
  run('CREATE INDEX IF NOT EXISTS ix_contract_alerts_s ON contract_alerts(status)');
  const cols = all<{ name: string }>('PRAGMA table_info(opportunities)').map((c) => c.name);
  if (!cols.includes('contract_id')) run('ALTER TABLE opportunities ADD COLUMN contract_id INTEGER');
}

// ------------------------------------------------------------------ lookups
export function getContract(id: number) {
  return get<Contract>('SELECT * FROM contracts WHERE id = ?', id);
}
function mustContract(id: number) {
  const c = getContract(id);
  if (!c) throw notFound('Contract');
  return c;
}
export function itemsOf(contractId: number) {
  return all<ContractItem & { material_code: string; description: string; material_uom: string; category: string | null }>(
    `SELECT ci.*, m.code AS material_code, m.description, m.uom AS material_uom, m.category FROM contract_items ci
     JOIN materials m ON m.id = ci.material_id WHERE ci.contract_id = ? ORDER BY m.code`, contractId,
  );
}
const leadDays = (c: Pick<Contract, 'renewal_lead_days'>) => c.renewal_lead_days ?? cfg<number>('contract.renewal_lead_days');
const warnPct = () => cfg<number>('contract.utilisation_warn_pct');

function ownerFor(category: string | null) {
  return get<{ buyer_id: number }>("SELECT buyer_id FROM buyer_matrix WHERE active = 1 AND category = ? ORDER BY (plant = '*') DESC LIMIT 1", category ?? '')?.buyer_id ?? null;
}
function managerOf(userId: number | null) {
  return userId ? get<{ manager_id: number | null }>('SELECT manager_id FROM users WHERE id = ?', userId)?.manager_id ?? null : null;
}

/** Valid contract for a material on a date (FR-CON-03, routing rule PRD 7.6): in validity, in force, SAP OA, remaining > 0. */
export function coveringContract(materialId: number, plant: string | null, date: string = today()) {
  return get<{ id: number; contract_no: string; type: string; sap_oa_no: string; vendor_id: number; vendor: string; unit_price: number; discount_pct: number | null; valid_to: string }>(
    `SELECT c.id, c.contract_no, c.type, c.sap_oa_no, c.vendor_id, v.name AS vendor, ci.unit_price, COALESCE(ci.discount_pct, c.discount_pct) AS discount_pct, c.valid_to
     FROM contracts c JOIN contract_items ci ON ci.contract_id = c.id JOIN vendors v ON v.id = c.vendor_id
     WHERE ci.material_id = ? AND c.status IN ('Active','Expiring') AND c.sap_oa_no IS NOT NULL
       AND c.valid_from <= ? AND c.valid_to >= ? AND (c.plant = '*' OR c.plant IS NULL OR c.plant = ?)
       AND (c.value_cap IS NULL OR c.consumed_value < c.value_cap) AND (ci.qty_cap IS NULL OR ci.consumed_qty < ci.qty_cap)
     ORDER BY CASE c.type WHEN 'ARC' THEN 1 WHEN 'OA' THEN 1 WHEN 'FDS' THEN 2 WHEN 'VMI' THEN 3 ELSE 4 END LIMIT 1`,
    materialId, date, date, plant ?? '',
  );
}

/** Why a contract is or is not usable for PR routing (FR-CON-09). */
export function routability(c: Contract) {
  const t = today();
  if (!c.sap_oa_no) return { routable: false, reason: c.status === 'Pending SAP' ? 'Pending SAP — no SAP outline agreement yet, so PRs cannot route to it.' : 'No SAP outline agreement.' };
  if (!IN_FORCE.includes(c.status)) return { routable: false, reason: `Contract is ${c.status.toLowerCase()}.` };
  if (c.valid_from > t) return { routable: false, reason: `Validity starts ${c.valid_from}.` };
  if (c.valid_to < t) return { routable: false, reason: 'Validity has ended.' };
  if (c.value_cap != null && c.consumed_value >= c.value_cap) return { routable: false, reason: 'Value cap fully consumed.' };
  return { routable: true, reason: 'Valid for routing: in validity, active in SAP, value remaining.' };
}

function linkedPoStats(contractId: number) {
  return get<{ value: number; pos: number }>(
    `SELECT COALESCE(SUM(pl.qty * pl.unit_price), 0) AS value, COUNT(DISTINCT p.id) AS pos FROM po_lines pl JOIN pos p ON p.id = pl.po_id
     WHERE p.contract_id = ? AND pl.status != 'Cancelled' AND p.status != 'Cancelled'`, contractId,
  )!;
}

/** Utilisation = consumed ÷ cap, value and per item (FR-CON-04). SAP consumption is the basis once reported. */
export function utilisation(c: Contract, items: ReturnType<typeof itemsOf>) {
  const linked = linkedPoStats(c.id);
  const sapReported = !!c.synced_at && c.consumed_value > 0;
  const consumed = sapReported ? c.consumed_value : linked.value;
  const pct = c.value_cap ? consumed / c.value_cap : null;
  const warn = warnPct();
  const perItem = items.map((i) => {
    const linkedQty = scalar<number>(
      `SELECT COALESCE(SUM(pl.qty), 0) FROM po_lines pl JOIN pos p ON p.id = pl.po_id WHERE p.contract_id = ? AND pl.material_id = ? AND pl.status != 'Cancelled'`, c.id, i.material_id,
    ) ?? 0;
    const q = i.consumed_qty > 0 ? i.consumed_qty : linkedQty;
    const ip = i.qty_cap ? q / i.qty_cap : null;
    return { item_id: i.id, material_id: i.material_id, consumed_qty: q, qty_cap: i.qty_cap, pct: ip, warn: ip != null && ip * 100 >= warn };
  });
  return {
    consumed, cap: c.value_cap, pct, warn: pct != null && pct * 100 >= warn, warn_pct: warn,
    basis: sapReported ? 'SAP consumption (INT-M06)' : 'Value of linked POs (SAP consumption not reported yet)',
    linked_po_value: round2(linked.value), linked_pos: linked.pos, remaining: c.value_cap != null ? round2(c.value_cap - consumed) : null, items: perItem,
  };
}

// ------------------------------------------------------------------ list & detail (SCR-CON-01/02)
export function listContracts(actor: Actor, q: Record<string, string | undefined>) {
  const where: string[] = [];
  const p: unknown[] = [];
  const tab = q.tab ?? 'all';
  if (tab === 'active') where.push("c.status = 'Active'");
  if (tab === 'expiring') where.push("c.status = 'Expiring'");
  if (tab === 'pending_sap') where.push("c.status = 'Pending SAP'");
  if (tab === 'draft') where.push("c.status IN ('Draft','Pending approval')");
  for (const [k, col] of [['status', 'c.status'], ['type', 'c.type'], ['category', 'c.category']] as const) if (q[k]) { where.push(`${col} = ?`); p.push(q[k]); }
  if (q.vendor) { where.push('c.vendor_id = ?'); p.push(Number(q.vendor)); }
  if (q.material) { where.push('c.id IN (SELECT ci.contract_id FROM contract_items ci JOIN materials m ON m.id = ci.material_id WHERE m.code = ?)'); p.push(q.material); }
  if (q.q) { where.push('(c.contract_no LIKE ? OR c.title LIKE ? OR c.sap_oa_no LIKE ? OR v.name LIKE ?)'); p.push(...Array(4).fill(`%${q.q}%`)); }
  const rows = all<Contract & { vendor_name: string; vendor_sap_code: string | null; owner_name: string | null; category_name: string | null }>(
    `SELECT c.*, v.name AS vendor_name, v.sap_code AS vendor_sap_code, u.name AS owner_name, sc.name AS category_name
     FROM contracts c JOIN vendors v ON v.id = c.vendor_id LEFT JOIN users u ON u.id = c.owner_id LEFT JOIN spend_categories sc ON sc.code = c.category
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE c.status WHEN 'Expiring' THEN 0 WHEN 'Pending SAP' THEN 1 WHEN 'Pending approval' THEN 2 WHEN 'Draft' THEN 3 WHEN 'Active' THEN 4 ELSE 5 END, c.valid_to`,
    ...p,
  );
  void actor;
  return rows.map((c) => {
    const items = itemsOf(c.id);
    const u = utilisation(c, items);
    return {
      ...c, vmi: undefined, has_vmi: !!c.vmi?.items?.length,
      scope: items.map((i) => i.material_code).join(', '), items_count: items.length,
      days_to_expiry: daysTo(c.valid_to), utilisation_pct: u.pct, utilisation_warn: u.warn || u.items.some((i) => i.warn), consumed: u.consumed,
      routable: routability(c).routable,
    };
  });
}

export function summary() {
  const n = (sql: string) => scalar<number>(sql) ?? 0;
  return {
    all: n('SELECT COUNT(*) FROM contracts'),
    active: n("SELECT COUNT(*) FROM contracts WHERE status = 'Active'"),
    expiring: n("SELECT COUNT(*) FROM contracts WHERE status = 'Expiring'"),
    pending_sap: n("SELECT COUNT(*) FROM contracts WHERE status = 'Pending SAP'"),
    draft: n("SELECT COUNT(*) FROM contracts WHERE status IN ('Draft','Pending approval')"),
    alerts: n("SELECT COUNT(*) FROM contract_alerts WHERE status IN ('Open','Justification pending approval')"),
    opportunities: n("SELECT COUNT(*) FROM opportunities WHERE status IN ('Identified','Under review')"),
    value_in_force: scalar<number>("SELECT COALESCE(SUM(value_cap), 0) FROM contracts WHERE status IN ('Active','Expiring')") ?? 0,
  };
}

export function priceLists(contractId: number) {
  const rows = all<PriceListRow & { created_by_name: string | null }>(
    'SELECT pl.*, u.name AS created_by_name FROM price_lists pl LEFT JOIN users u ON u.id = pl.created_by WHERE pl.contract_id = ? ORDER BY pl.effective_from DESC, pl.version DESC', contractId,
  );
  const t = today();
  const current = rows.find((r) => r.effective_from <= t);
  const codes = new Map(all<{ id: number; code: string; description: string }>('SELECT id, code, description FROM materials').map((m) => [m.id, m]));
  return rows.map((r) => ({
    ...r, items: (r.items ?? []).map((i) => ({ ...i, material_code: codes.get(i.material_id)?.code ?? i.material_code, description: codes.get(i.material_id)?.description ?? '' })),
    state: r.id === current?.id ? 'Current' : r.effective_from > t ? 'Scheduled' : 'Superseded',
  }));
}

/** Price list version effective on a date (FR-CON-05; invoices validated against the version effective on PO date [ASM]). */
export function priceListOn(contractId: number, date: string) {
  return get<PriceListRow>('SELECT * FROM price_lists WHERE contract_id = ? AND effective_from <= ? ORDER BY effective_from DESC, version DESC LIMIT 1', contractId, date);
}

/**
 * Expected FDS invoice price for Module 10 (FR-INV-18, AC-CON-05): list price of the price-list
 * version effective on the PO date × (1 − discount). Discount = item discount, else contract discount.
 * Returns null when the contract has no price list covering the material on that date.
 */
export function expectedFdsPrice(contractId: number, materialId: number, poDate: string) {
  const c = getContract(contractId);
  if (!c) return null;
  const pl = priceListOn(contractId, poDate.slice(0, 10));
  const item = pl?.items?.find((i) => i.material_id === materialId);
  if (!pl || !item) return null;
  const ci = get<{ discount_pct: number | null }>('SELECT discount_pct FROM contract_items WHERE contract_id = ? AND material_id = ?', contractId, materialId);
  const discount = ci?.discount_pct ?? c.discount_pct ?? 0;
  return {
    contract_id: contractId, contract_no: c.contract_no, material_id: materialId, po_date: poDate.slice(0, 10),
    price_list_id: pl.id, version: pl.version, effective_from: pl.effective_from, list_price: item.list_price,
    discount_pct: discount, expected_price: round2(item.list_price * (1 - discount / 100)), invoice_validation: !!c.invoice_validation,
  };
}

/** Live VMI min-max status from synced SAP stock (FR-CON-07). */
export function vmiStatus(c: Contract) {
  if (!c.vmi?.items?.length) return [];
  const plant = c.vmi.plant ?? (c.plant && c.plant !== '*' ? c.plant : null);
  return c.vmi.items.map((it) => {
    const m = get<{ code: string; description: string; uom: string }>('SELECT code, description, uom FROM materials WHERE id = ?', it.material_id);
    const st = plant
      ? get<{ unrestricted: number; open_po_qty: number; synced_at: string | null }>('SELECT unrestricted, open_po_qty, synced_at FROM stock WHERE material_id = ? AND plant = ?', it.material_id, plant)
      : get<{ unrestricted: number; open_po_qty: number; synced_at: string | null }>('SELECT SUM(unrestricted) AS unrestricted, SUM(open_po_qty) AS open_po_qty, MAX(synced_at) AS synced_at FROM stock WHERE material_id = ?', it.material_id);
    const unrestricted = st?.unrestricted ?? 0;
    const openPo = st?.open_po_qty ?? 0;
    const state = unrestricted < it.min ? 'Below minimum' : unrestricted > it.max ? 'Above maximum' : 'Within range';
    return {
      material_id: it.material_id, material_code: m?.code ?? it.material_code, description: m?.description ?? '', uom: m?.uom ?? '', plant,
      min: it.min, max: it.max, unrestricted, open_po_qty: openPo, synced_at: st?.synced_at ?? null, state,
      replenish_qty: state === 'Below minimum' ? Math.max(0, it.max - unrestricted - openPo) : 0,
    };
  });
}

function changesOf(contractId: number) {
  return all<ChangeRow & { requested_by_name: string | null; req_no: string | null }>(
    'SELECT ch.*, u.name AS requested_by_name, a.req_no FROM contract_changes ch LEFT JOIN users u ON u.id = ch.requested_by LEFT JOIN approvals a ON a.id = ch.approval_id WHERE ch.contract_id = ? ORDER BY ch.id DESC', contractId,
  );
}
function lastStatusNote(c: Contract) {
  return get<{ status: string; outcome: string | null; decided_at: string | null; req_no: string }>('SELECT status, outcome, decided_at, req_no FROM approvals WHERE id = ?', c.approval_id ?? 0) ?? null;
}

export function contractDetail(actor: Actor, id: number) {
  const c = mustContract(id);
  if (actor.role === 'VEN') return vendorDetail(actor, id);
  const vendor = get('SELECT id, name, sap_code, city, state, contact_name, contact_email, contact_phone, sap_blocked FROM vendors WHERE id = ?', c.vendor_id);
  const items = itemsOf(id);
  const u = utilisation(c, items);
  const pos = all(
    `SELECT p.id, p.po_no, p.po_date, p.status, p.total_value, p.plant, b.name AS buyer_name,
            (SELECT COALESCE(SUM(pl.qty * pl.unit_price), 0) FROM po_lines pl WHERE pl.po_id = p.id AND pl.status != 'Cancelled') AS basic_value
     FROM pos p LEFT JOIN users b ON b.id = p.buyer_id WHERE p.contract_id = ? ORDER BY p.po_date DESC`, id,
  );
  const approvals = all(
    `SELECT a.id, a.req_no, a.type, a.status, a.title, a.created_at, a.decided_at, a.outcome FROM approvals a
     WHERE (a.object_type = 'contract' AND a.object_id = ?) OR (a.object_type = 'contract_change' AND a.object_id IN (SELECT id FROM contract_changes WHERE contract_id = ?))
     ORDER BY a.id DESC`, id, id,
  );
  const alerts = listAlerts({ contract: String(id) });
  const renewals = all('SELECT id, contract_no, status, valid_from, valid_to FROM contracts WHERE renewed_from_id = ? ORDER BY id DESC', id);
  const renewedFrom = c.renewed_from_id ? get('SELECT id, contract_no, status, valid_to FROM contracts WHERE id = ?', c.renewed_from_id) : null;
  const opportunity = get('SELECT o.id, o.status, m.code AS material_code FROM opportunities o LEFT JOIN materials m ON m.id = o.material_id WHERE o.contract_id = ?', id) ?? null;
  const changes = changesOf(id);
  const decision = changes.find((ch) => ['renewal', 'extension', 'let_expire'].includes(ch.kind) && !['Rejected', 'Returned', 'Withdrawn'].includes(ch.status)) ?? null;
  return {
    ...c,
    vendor, owner: c.owner_id ? get('SELECT id, name, email FROM users WHERE id = ?', c.owner_id) : null,
    owner_manager: c.owner_id ? get('SELECT u.id, u.name FROM users u WHERE u.id = (SELECT manager_id FROM users WHERE id = ?)', c.owner_id) ?? null : null,
    category_name: c.category ? scalar<string>('SELECT name FROM spend_categories WHERE code = ?', c.category) ?? null : null,
    items: items.map((i) => ({ ...i, utilisation: u.items.find((x) => x.item_id === i.id) })),
    utilisation: u, ...routability(c), days_to_expiry: daysTo(c.valid_to), lead_days: leadDays(c),
    price_lists: priceLists(id), vmi_status: vmiStatus(c), pos, approvals, alerts, changes, renewals, renewed_from: renewedFrom, opportunity,
    renewal_decision: decision ? { kind: decision.kind, status: decision.status, reason: decision.reason, at: decision.created_at, by: decision.requested_by_name, after: decision.after } : null,
    pending_change: changes.find((ch) => ['Pending approval', 'Pending SAP'].includes(ch.status)) ?? null,
    last_decision: lastStatusNote(c),
    freshness: staleInfo('INT-M06', c.synced_at),
    sap_payload_ready: c.status === 'Pending SAP' || changes.some((ch) => ch.status === 'Pending SAP'),
  };
}

// ------------------------------------------------------------------ create / edit draft
export interface ItemInput { material_id: number; unit_price: number; qty_cap?: number | null; discount_pct?: number | null; list_price?: number | null }
export interface ContractInput {
  type: ContractType;
  vendor_id: number;
  title: string;
  category: string;
  plant?: string;
  valid_from: string;
  valid_to: string;
  value_cap?: number | null;
  payment_terms: string;
  delivery_terms: string;
  discount_pct?: number | null;
  invoice_validation?: boolean;
  renewal_lead_days?: number;
  price_revision_date?: string | null;
  terms?: string | null;
  owner_id?: number | null;
  items: ItemInput[];
  vmi?: Omit<VmiTerms, 'items'> & { items: { material_id: number; min: number; max: number }[] } | null;
  price_list?: { effective_from: string; items: { material_id: number; list_price: number }[]; note?: string } | null;
  attachment_ids?: number[];
}

function validateInput(i: ContractInput, opts: { allowPastStart?: boolean } = {}) {
  const fields: Record<string, string> = {};
  if (i.valid_to <= i.valid_from) fields.valid_to = 'Validity end must be after the start date';
  if (i.valid_to < today()) fields.valid_to = 'Validity end date is in the past — choose a future date';
  const vendor = get<{ id: number; name: string; sap_code: string | null; sap_blocked: number }>('SELECT id, name, sap_code, sap_blocked FROM vendors WHERE id = ?', i.vendor_id);
  if (!vendor) fields.vendor_id = 'Vendor not found — choose a vendor from the list';
  else if (vendor.sap_blocked) fields.vendor_id = `${vendor.name} is blocked in SAP and cannot be given a contract`;
  if (!get('SELECT code FROM spend_categories WHERE code = ?', i.category)) fields.category = 'Choose a spend category';
  if (i.plant && i.plant !== '*' && !get('SELECT code FROM plants WHERE code = ?', i.plant)) fields.plant = 'Choose a plant or "All plants"';
  const seen = new Set<number>();
  i.items.forEach((it, idx) => {
    if (!get('SELECT id FROM materials WHERE id = ?', it.material_id)) fields[`items.${idx}.material_id`] = 'Material not in the material master';
    if (seen.has(it.material_id)) fields[`items.${idx}.material_id`] = 'This material is listed twice — keep one line per material';
    seen.add(it.material_id);
  });
  if (i.type === 'FDS' && i.discount_pct == null && i.items.some((it) => it.discount_pct == null)) fields.discount_pct = 'A fixed discount structure needs a discount % (header or per item)';
  if (i.type === 'VMI') {
    if (!i.vmi?.items?.length) fields.vmi = 'Add VMI minimum and maximum for at least one item';
    i.vmi?.items.forEach((v, idx) => {
      if (!seen.has(v.material_id)) fields[`vmi.items.${idx}.material_id`] = 'VMI material must also be a contract item';
      if (v.min < 0 || v.max <= v.min) fields[`vmi.items.${idx}.max`] = 'Maximum must be greater than minimum';
    });
  }
  if (i.price_list) {
    i.price_list.items.forEach((p, idx) => { if (!seen.has(p.material_id)) fields[`price_list.items.${idx}.material_id`] = 'Price-list material must also be a contract item'; });
  }
  void opts;
  const first = Object.entries(fields)[0];
  if (first) throw badRequest(`${first[0].replace(/_/g, ' ').replace(/\./g, ' › ')}: ${first[1]}`, fields);
  return vendor!;
}

function vmiFromInput(i: ContractInput): VmiTerms | null {
  if (!i.vmi) return null;
  const codes = new Map(all<{ id: number; code: string }>('SELECT id, code FROM materials').map((m) => [m.id, m.code]));
  return { ...i.vmi, plant: i.vmi.plant ?? (i.plant && i.plant !== '*' ? i.plant : null), items: i.vmi.items.map((v) => ({ ...v, material_code: codes.get(v.material_id) })) };
}

function writeItems(contractId: number, items: ItemInput[], type: string, headerDiscount: number | null | undefined) {
  run('DELETE FROM contract_items WHERE contract_id = ?', contractId);
  for (const it of items) {
    const uom = scalar<string>('SELECT uom FROM materials WHERE id = ?', it.material_id) ?? null;
    let price = it.unit_price;
    // FDS: contract price = list price × (1 − discount) when the list price is given.
    if (type === 'FDS' && it.list_price != null) price = round2(it.list_price * (1 - (it.discount_pct ?? headerDiscount ?? 0) / 100));
    insert('contract_items', { contract_id: contractId, material_id: it.material_id, unit_price: price, qty_cap: it.qty_cap ?? null, consumed_qty: 0, uom, discount_pct: it.discount_pct ?? null });
  }
}

function initialPriceList(actor: Actor | null, contractId: number, i: ContractInput) {
  if (i.type !== 'FDS') return;
  const items = i.price_list?.items ?? i.items.map((it) => ({ material_id: it.material_id, list_price: it.list_price ?? round2(it.unit_price / (1 - (it.discount_pct ?? i.discount_pct ?? 0) / 100)) }));
  run('DELETE FROM price_lists WHERE contract_id = ?', contractId);
  insert('price_lists', { contract_id: contractId, version: 1, effective_from: i.price_list?.effective_from ?? i.valid_from, items_json: J(items), created_by: actor?.id ?? null, created_at: now(), note: i.price_list?.note ?? 'Initial price list' });
  update('contracts', contractId, { price_list_version: 1 });
}

const headerFields = (i: ContractInput) => ({
  type: i.type, vendor_id: i.vendor_id, title: i.title.trim(), category: i.category, plant: i.plant || '*', valid_from: i.valid_from, valid_to: i.valid_to,
  value_cap: i.value_cap ?? null, payment_terms: i.payment_terms.trim(), delivery_terms: i.delivery_terms.trim(), discount_pct: i.discount_pct ?? null,
  invoice_validation: i.invoice_validation ? 1 : 0, renewal_lead_days: i.renewal_lead_days ?? cfg<number>('contract.renewal_lead_days'),
  price_revision_date: i.price_revision_date || null, terms: i.terms?.trim() || null,
});

export function createContract(actor: Actor, i: ContractInput, extra: { renewedFromId?: number; terms?: string } = {}) {
  validateInput(i);
  return tx(() => {
    const no = nextNo('CON');
    const id = insert('contracts', {
      contract_no: no, ...headerFields(i), status: 'Draft', consumed_value: 0, currency: 'INR', vmi_json: J(vmiFromInput(i)),
      owner_id: i.owner_id ?? actor.id, created_by: actor.id, created_at: now(), renewed_from_id: extra.renewedFromId ?? null,
    });
    writeItems(id, i.items, i.type, i.discount_pct);
    initialPriceList(actor, id, i);
    if (i.attachment_ids?.length) linkAttachments(i.attachment_ids, 'contract', id);
    const c = getContract(id)!;
    audit(actor, { action: 'contract.created', objectType: 'contract', objectId: id, objectRef: no, after: { ...headerFields(i), items: i.items.length, renewed_from_id: extra.renewedFromId ?? null } });
    return { ...c, warnings: overlapWarnings(id) };
  });
}

/** Materials already covered by another contract in force (shown as a warning, not a block). */
function overlapWarnings(contractId: number) {
  return all<{ code: string; contract_no: string; vendor: string }>(
    `SELECT m.code, c.contract_no, v.name AS vendor FROM contract_items mine JOIN materials m ON m.id = mine.material_id
     JOIN contract_items o ON o.material_id = mine.material_id AND o.contract_id != mine.contract_id
     JOIN contracts c ON c.id = o.contract_id JOIN vendors v ON v.id = c.vendor_id
     WHERE mine.contract_id = ? AND c.status IN ('Active','Expiring','Pending SAP')`, contractId,
  ).map((r) => `${r.code} is already covered by ${r.contract_no} (${r.vendor}).`);
}

export function updateDraft(actor: Actor, id: number, i: ContractInput) {
  const c = mustContract(id);
  if (c.status !== 'Draft') throw conflict(`Only draft contracts can be edited directly. This contract is ${c.status.toLowerCase()} — use "Change terms", which goes through approval.`);
  validateInput(i);
  return tx(() => {
    const before = { ...pick(c, Object.keys(headerFields(i))), items: itemsOf(id).map((x) => ({ material_id: x.material_id, unit_price: x.unit_price, qty_cap: x.qty_cap })) };
    update('contracts', id, { ...headerFields(i), vmi_json: J(vmiFromInput(i)), owner_id: i.owner_id ?? c.owner_id ?? actor.id });
    writeItems(id, i.items, i.type, i.discount_pct);
    if (i.type === 'FDS' && (i.price_list || !scalar('SELECT COUNT(*) FROM price_lists WHERE contract_id = ?', id))) initialPriceList(actor, id, i);
    if (i.attachment_ids?.length) linkAttachments(i.attachment_ids, 'contract', id);
    const after = { ...headerFields(i), items: i.items.map((x) => ({ material_id: x.material_id, unit_price: x.unit_price, qty_cap: x.qty_cap ?? null })) };
    audit(actor, { action: 'contract.draft_updated', objectType: 'contract', objectId: id, objectRef: c.contract_no, before, after });
    return { ...getContract(id)!, warnings: overlapWarnings(id) };
  });
}

function pick(o: any, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = o[k];
  return out;
}

/** Draft → Pending approval (contract.approval; FR-CON-08). */
export function submitContract(actor: Actor, id: number, note?: string) {
  const c = mustContract(id);
  if (c.status !== 'Draft') throw conflict(`Contract is ${c.status.toLowerCase()}; only drafts can be sent for approval.`);
  const items = itemsOf(id);
  if (!items.length) throw badRequest('Add at least one item with its price before sending for approval.');
  const vendor = get<{ name: string; sap_code: string | null }>('SELECT name, sap_code FROM vendors WHERE id = ?', c.vendor_id)!;
  if (!vendor.sap_code) throw badRequest(`${vendor.name} has no SAP vendor code yet. The SAP outline agreement needs one — complete vendor onboarding first.`);
  if (c.valid_to < today()) throw badRequest('Validity end date is in the past. Edit the draft and choose a future end date.');
  if (c.type === 'VMI' && !c.vmi?.items?.length) throw badRequest('Add VMI minimum/maximum levels before sending a VMI contract for approval.');
  return tx(() => {
    const ap = createApproval(actor, {
      type: 'contract.approval', objectType: 'contract', objectId: id,
      title: `${c.renewed_from_id ? 'Renewal' : c.type} ${c.contract_no} — ${vendor.name}`,
      summary: `${c.title ?? ''} · ${items.length} item(s) · valid ${c.valid_from} to ${c.valid_to}`,
      value: c.value_cap ?? 0, reason: note, categoryCode: c.category, plant: c.plant === '*' ? null : c.plant,
      context: {
        link: `/contracts/${id}`, contract_no: c.contract_no, contract_type: c.type, vendor: vendor.name, vendor_sap_code: vendor.sap_code,
        valid_from: c.valid_from, valid_to: c.valid_to, value_cap: c.value_cap, payment_terms: c.payment_terms, delivery_terms: c.delivery_terms,
        discount_pct: c.discount_pct, renewal_of: c.renewed_from_id ? getContract(c.renewed_from_id)?.contract_no ?? null : null,
        items: items.map((i) => ({ material: i.material_code, description: i.description, unit_price: i.unit_price, qty_cap: i.qty_cap, discount_pct: i.discount_pct })),
      },
    });
    update('contracts', id, { status: 'Pending approval', approval_id: ap.id });
    audit(actor, { action: 'contract.submitted', objectType: 'contract', objectId: id, objectRef: c.contract_no, before: { status: c.status }, after: { status: 'Pending approval', approval: ap.req_no }, reason: note ?? null });
    return getContract(id)!;
  });
}

/** Approval outcome for a contract (new or renewal). */
export function onContractDecision(ap: ApprovalRow, outcome: string, actor: Actor | null, comment: string | null) {
  const c = getContract(ap.object_id);
  if (!c || c.status !== 'Pending approval') return;
  if (outcome === 'Approved') {
    update('contracts', c.id, { status: 'Pending SAP' });
    audit(actor, { action: 'contract.approved', objectType: 'contract', objectId: c.id, objectRef: c.contract_no, before: { status: c.status }, after: { status: 'Pending SAP', approval: ap.req_no }, reason: comment });
    notify({ event: 'NTF-12', title: `${c.contract_no} approved — waiting for SAP OA`, body: 'The SAP team creates the outline agreement. PRs cannot route to this contract until the OA syncs back (FR-CON-09).', link: `/contracts/${c.id}`, users: [c.owner_id, c.created_by], objectType: 'contract', objectId: c.id, severity: 'success', dedupeKey: `con-approved:${c.id}:${ap.id}` });
    notify({ event: 'NTF-12', title: `Create SAP outline agreement for ${c.contract_no}`, body: `${c.type} approved in the platform. Create the OA in SAP with reference ${c.contract_no}.`, link: `/sap-simulator?action=oa&contract=${c.id}`, roles: ['SAP'], objectType: 'contract', objectId: c.id, dedupeKey: `con-sap:${c.id}:${ap.id}` });
  } else {
    update('contracts', c.id, { status: 'Draft' });
    audit(actor, { action: `contract.${outcome.toLowerCase()}`, objectType: 'contract', objectId: c.id, objectRef: c.contract_no, before: { status: c.status }, after: { status: 'Draft', approval: ap.req_no }, reason: comment });
  }
}

// ------------------------------------------------------------------ change requests on contracts in force
export interface ChangeInput {
  fields?: Partial<Record<(typeof SAP_FIELDS)[number] | (typeof PLATFORM_FIELDS)[number], unknown>>;
  items?: { material_id: number; unit_price?: number; qty_cap?: number | null; discount_pct?: number | null; remove?: boolean }[];
  reason: string;
}

function openChange(contractId: number) {
  return get<ChangeRow>("SELECT * FROM contract_changes WHERE contract_id = ? AND status IN ('Pending approval','Pending SAP') ORDER BY id DESC LIMIT 1", contractId);
}

/** Edit commercial terms of a contract in force: approval first, every change audited before/after (SCR-CON-02). */
export function requestChange(actor: Actor, id: number, input: ChangeInput) {
  const c = mustContract(id);
  if (!IN_FORCE.includes(c.status)) throw conflict(`Terms can be changed only while the contract is active or expiring (it is ${c.status.toLowerCase()}).${c.status === 'Draft' ? ' Edit the draft instead.' : ''}`);
  const pending = openChange(id);
  if (pending) throw conflict(`A change (${pending.kind}) is already ${pending.status.toLowerCase()} for this contract. Wait for it to finish first.`);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.fields ?? {})) {
    if (![...SAP_FIELDS, ...PLATFORM_FIELDS].includes(k as never)) throw badRequest(`${k} cannot be changed here.`);
    const cur = (c as any)[k];
    const val = k === 'invoice_validation' ? (v ? 1 : 0) : v === '' ? null : v;
    if (JSON.stringify(cur ?? null) !== JSON.stringify(val ?? null)) { before[k] = cur ?? null; after[k] = val ?? null; }
  }
  if (after.valid_to && typeof after.valid_to === 'string' && after.valid_to < today()) throw badRequest('New validity end is in the past.', { valid_to: 'Choose a future date' });
  if (after.owner_id && !get("SELECT id FROM users WHERE id = ? AND active = 1 AND (',' || roles || ',') LIKE '%,BUY,%'", after.owner_id)) throw badRequest('Owner must be an active buyer.', { owner_id: 'Choose a buyer' });
  const items = itemsOf(id);
  const itemChanges: { material_id: number; material_code: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[] = [];
  for (const it of input.items ?? []) {
    const cur = items.find((x) => x.material_id === it.material_id);
    const code = scalar<string>('SELECT code FROM materials WHERE id = ?', it.material_id);
    if (!code) throw badRequest('Material not in the material master.');
    if (it.remove) { if (cur) itemChanges.push({ material_id: it.material_id, material_code: code, before: { unit_price: cur.unit_price, qty_cap: cur.qty_cap, discount_pct: cur.discount_pct }, after: null }); continue; }
    const next = { unit_price: it.unit_price ?? cur?.unit_price ?? null, qty_cap: it.qty_cap === undefined ? cur?.qty_cap ?? null : it.qty_cap, discount_pct: it.discount_pct === undefined ? cur?.discount_pct ?? null : it.discount_pct };
    if (next.unit_price == null) throw badRequest(`Enter a contract price for ${code}.`);
    const prev = cur ? { unit_price: cur.unit_price, qty_cap: cur.qty_cap, discount_pct: cur.discount_pct } : null;
    if (JSON.stringify(prev) !== JSON.stringify(next)) itemChanges.push({ material_id: it.material_id, material_code: code, before: prev, after: next });
  }
  if (!Object.keys(after).length && !itemChanges.length) throw badRequest('Nothing changed. Edit at least one term or item price before sending for approval.');
  if (itemChanges.length) { before.items = itemChanges.map((x) => ({ material: x.material_code, ...x.before })); after.items = itemChanges; }
  return tx(() => {
    const chId = insert('contract_changes', { contract_id: id, kind: 'terms', before_json: J(before), after_json: J(after), status: 'Pending approval', requested_by: actor.id, reason: input.reason, created_at: now() });
    const ap = createApproval(actor, {
      type: 'contract.approval', objectType: 'contract_change', objectId: chId, title: `Change terms of ${c.contract_no}`,
      summary: Object.keys(after).filter((k) => k !== 'items').map((k) => `${k.replace(/_/g, ' ')}: ${fmtVal(before[k])} → ${fmtVal(after[k])}`).concat(itemChanges.map((x) => `${x.material_code}: ${x.after ? `₹${x.before?.unit_price ?? '—'} → ₹${x.after.unit_price}` : 'removed'}`)).join('; '),
      value: Number(after.value_cap ?? c.value_cap ?? 0), reason: input.reason, categoryCode: c.category,
      context: { link: `/contracts/${id}`, contract_no: c.contract_no, kind: 'terms', before, after, sap_update_needed: needsSap(after) },
    });
    update('contract_changes', chId, { approval_id: ap.id });
    audit(actor, { action: 'contract.change_requested', objectType: 'contract', objectId: id, objectRef: c.contract_no, before, after, reason: input.reason });
    return get<ChangeRow>('SELECT * FROM contract_changes WHERE id = ?', chId)!;
  });
}
const fmtVal = (v: unknown) => (v == null || v === '' ? '—' : String(v));
const needsSap = (after: Record<string, unknown>) => SAP_FIELDS.some((k) => k in after) || Array.isArray(after.items);

/** Approval outcome for contract changes (terms, price list, extension). */
export function onChangeDecision(ap: ApprovalRow, outcome: string, actor: Actor | null, comment: string | null) {
  const ch = get<ChangeRow>('SELECT * FROM contract_changes WHERE id = ?', ap.object_id);
  if (!ch || ch.status !== 'Pending approval') return;
  const c = getContract(ch.contract_id)!;
  if (outcome !== 'Approved') {
    update('contract_changes', ch.id, { status: outcome, decided_at: now(), note: comment });
    audit(actor, { action: `contract.change_${outcome.toLowerCase()}`, objectType: 'contract', objectId: c.id, objectRef: c.contract_no, after: { change: ch.id, kind: ch.kind }, reason: comment });
    return;
  }
  tx(() => {
    const after = ch.after ?? {};
    // Platform-owned terms apply now.
    const platform: Record<string, unknown> = {};
    for (const k of PLATFORM_FIELDS) if (k in after) platform[k] = after[k];
    if (Object.keys(platform).length) {
      update('contracts', c.id, platform);
      audit(actor, { action: 'contract.terms_changed', objectType: 'contract', objectId: c.id, objectRef: c.contract_no, before: pick(c, Object.keys(platform)), after: platform, reason: ch.reason });
    }
    if (ch.kind === 'price_list') {
      insertPriceList(actor, c, after);
    }
    const sap = ch.kind === 'extension' || needsSap(after);
    if (sap && c.sap_oa_no) {
      update('contract_changes', ch.id, { status: 'Pending SAP', decided_at: now() });
      audit(actor, { action: 'contract.change_approved', objectType: 'contract', objectId: c.id, objectRef: c.contract_no, after: { change: ch.id, kind: ch.kind, next: 'Update the outline agreement in SAP' }, reason: comment });
      notify({ event: 'NTF-12', title: `Update SAP OA ${c.sap_oa_no} for ${c.contract_no}`, body: ch.kind === 'extension' ? `Extend validity to ${after.valid_to}.` : 'Approved commercial terms change — apply it to the outline agreement in SAP.', link: `/sap-simulator?action=oa&contract=${c.id}`, roles: ['SAP'], objectType: 'contract', objectId: c.id, dedupeKey: `con-change-sap:${ch.id}` });
      notify({ event: 'NTF-12', title: `${c.contract_no}: change approved, waiting for SAP`, body: 'The new terms take effect for routing once SAP shows them.', link: `/contracts/${c.id}`, users: [c.owner_id], objectType: 'contract', objectId: c.id, dedupeKey: `con-change-ok:${ch.id}` });
    } else {
      if (sap) applySapFields(actor, c, after); // no OA yet: platform record is the source for SAP creation
      update('contract_changes', ch.id, { status: 'Applied', decided_at: now(), applied_at: now() });
      audit(actor, { action: 'contract.change_applied', objectType: 'contract', objectId: c.id, objectRef: c.contract_no, before: ch.before, after, reason: ch.reason });
    }
  });
}

function applySapFields(actor: Actor | null, c: Contract, after: Record<string, any>) {
  const f: Record<string, unknown> = {};
  for (const k of SAP_FIELDS) if (k in after) f[k] = after[k];
  if (Object.keys(f).length) update('contracts', c.id, f);
  for (const it of (after.items ?? []) as { material_id: number; after: Record<string, unknown> | null }[]) {
    const ex = get<{ id: number }>('SELECT id FROM contract_items WHERE contract_id = ? AND material_id = ?', c.id, it.material_id);
    if (!it.after) { if (ex) run('DELETE FROM contract_items WHERE id = ?', ex.id); continue; }
    if (ex) update('contract_items', ex.id, it.after);
    else insert('contract_items', { contract_id: c.id, material_id: it.material_id, ...it.after, consumed_qty: 0, uom: scalar('SELECT uom FROM materials WHERE id = ?', it.material_id) });
  }
  void actor;
}

// ------------------------------------------------------------------ price lists (FDS, FR-CON-05)
function insertPriceList(actor: Actor | null, c: Contract, pl: { effective_from: string; items: { material_id: number; list_price: number }[]; note?: string }) {
  const version = (scalar<number>('SELECT MAX(version) FROM price_lists WHERE contract_id = ?', c.id) ?? 0) + 1;
  const id = insert('price_lists', { contract_id: c.id, version, effective_from: pl.effective_from, items_json: J(pl.items), created_by: actor?.id ?? null, created_at: now(), note: pl.note ?? null });
  refreshPriceListVersion(c.id);
  audit(actor, { action: 'contract.price_list_added', objectType: 'contract', objectId: c.id, objectRef: c.contract_no, after: { version, effective_from: pl.effective_from, items: pl.items.length } });
  return id;
}
function refreshPriceListVersion(contractId: number) {
  const cur = priceListOn(contractId, today());
  if (cur) run('UPDATE contracts SET price_list_version = ? WHERE id = ? AND COALESCE(price_list_version, 0) != ?', cur.version, contractId, cur.version);
}

export function addPriceList(actor: Actor, id: number, input: { effective_from: string; items: { material_id: number; list_price: number }[]; note?: string; reason?: string }) {
  const c = mustContract(id);
  if (c.type !== 'FDS' && c.type !== 'ARC' && c.type !== 'OA') throw badRequest('Price lists apply to FDS, ARC and OA contracts.');
  const items = itemsOf(id);
  const fields: Record<string, string> = {};
  input.items.forEach((it, idx) => { if (!items.some((x) => x.material_id === it.material_id)) fields[`items.${idx}.material_id`] = 'Material is not on this contract'; if (!(it.list_price > 0)) fields[`items.${idx}.list_price`] = 'Enter a list price above zero'; });
  if (!input.items.length) fields.items = 'Add list prices for at least one item';
  if (Object.keys(fields).length) throw badRequest(Object.values(fields)[0], fields);
  if (get('SELECT id FROM price_lists WHERE contract_id = ? AND effective_from = ?', id, input.effective_from)) throw conflict(`A price list already takes effect on ${input.effective_from}. Choose another effective date.`);
  if (c.status === 'Draft') return tx(() => ({ id: insertPriceList(actor, c, input), status: 'Applied' }));
  if (!IN_FORCE.includes(c.status)) throw conflict(`Price lists can be added to drafts or contracts in force (this one is ${c.status.toLowerCase()}).`);
  if (!input.reason || input.reason.trim().length < 10) throw badRequest('A new price-list version on a contract in force needs a reason of at least 10 characters.', { reason: 'Reason is required' });
  const pending = openChange(id);
  if (pending) throw conflict(`A change (${pending.kind}) is already ${pending.status.toLowerCase()} for this contract.`);
  return tx(() => {
    const cur = priceListOn(id, input.effective_from);
    const chId = insert('contract_changes', { contract_id: id, kind: 'price_list', before_json: J(cur ? { version: cur.version, effective_from: cur.effective_from, items: cur.items } : null), after_json: J(input), status: 'Pending approval', requested_by: actor.id, reason: input.reason, created_at: now() });
    const ap = createApproval(actor, {
      type: 'contract.approval', objectType: 'contract_change', objectId: chId, title: `New price list for ${c.contract_no} from ${input.effective_from}`,
      summary: `${input.items.length} list price(s); discount ${c.discount_pct ?? '—'}% applies`, value: c.value_cap ?? 0, reason: input.reason, categoryCode: c.category,
      context: { link: `/contracts/${id}`, contract_no: c.contract_no, kind: 'price_list', before: cur ? { version: cur.version, items: cur.items } : null, after: input },
    });
    update('contract_changes', chId, { approval_id: ap.id });
    audit(actor, { action: 'contract.price_list_requested', objectType: 'contract', objectId: id, objectRef: c.contract_no, after: { effective_from: input.effective_from, items: input.items.length, approval: ap.req_no }, reason: input.reason });
    return { id: chId, status: 'Pending approval' };
  });
}

// ------------------------------------------------------------------ VMI terms (FR-CON-06)
export function setVmiTerms(actor: Actor, id: number, vmi: VmiTerms, reason: string) {
  const c = mustContract(id);
  if (!['Draft', 'Pending SAP', 'Active', 'Expiring'].includes(c.status)) throw conflict(`VMI terms cannot change while the contract is ${c.status.toLowerCase()}.`);
  const items = itemsOf(id);
  const fields: Record<string, string> = {};
  vmi.items.forEach((v, idx) => {
    if (!items.some((x) => x.material_id === v.material_id)) fields[`items.${idx}.material_id`] = 'Material is not on this contract';
    if (v.min < 0 || v.max <= v.min) fields[`items.${idx}.max`] = 'Maximum must be greater than minimum';
  });
  if (!vmi.items.length) fields.items = 'Add minimum and maximum for at least one material';
  if (Object.keys(fields).length) throw badRequest(Object.values(fields)[0], fields);
  const codes = new Map(items.map((i) => [i.material_id, i.material_code]));
  const next: VmiTerms = { ...vmi, plant: vmi.plant ?? c.vmi?.plant ?? (c.plant && c.plant !== '*' ? c.plant : null), items: vmi.items.map((v) => ({ ...v, material_code: codes.get(v.material_id) })) };
  update('contracts', id, { vmi_json: J(next) });
  audit(actor, { action: 'contract.vmi_terms_updated', objectType: 'contract', objectId: id, objectRef: c.contract_no, before: c.vmi, after: next, reason });
  vmiCheckContract(getContract(id)!);
  return getContract(id)!;
}

/** NTF-15 when unrestricted stock is below the VMI minimum — vendor and buyer, once per item per day (AC-CON-06). */
export function vmiCheckContract(c: Contract) {
  if (!IN_FORCE.includes(c.status) || !c.vmi?.items?.length) return 0;
  let n = 0;
  const day = today();
  const buyer = c.owner_id ?? ownerFor(c.category);
  const plantName = (code: string | null) => (code ? scalar<string>('SELECT name FROM plants WHERE code = ?', code) ?? code : 'all plants');
  for (const s of vmiStatus(c)) {
    if (s.state !== 'Below minimum') continue;
    const key = `NTF-15:${c.id}:${s.material_id}:${day}`;
    if (get('SELECT id FROM notifications WHERE dedupe_key IN (?, ?) LIMIT 1', `${key}:v`, `${key}:i`)) continue;
    const body = `${s.material_code} ${s.description}: stock at ${plantName(s.plant)} is ${s.unrestricted} ${s.uom}, below the agreed minimum of ${s.min}. Replenish towards the maximum of ${s.max} ${s.uom}${s.replenish_qty ? ` (about ${s.replenish_qty} ${s.uom})` : ''} per ${c.vmi.replenishment_frequency.toLowerCase()} terms.`;
    n += notify({ event: 'NTF-15', title: `VMI below minimum: ${s.material_code} (${c.sap_oa_no ?? c.contract_no})`, body, link: `/vendor/contracts/${c.id}`, vendorId: c.vendor_id, objectType: 'contract', objectId: c.id, severity: 'warning', dedupeKey: `${key}:v`, mandatory: true }).length;
    n += notify({ event: 'NTF-15', title: `VMI below minimum: ${s.material_code} at ${s.plant ?? 'plant'}`, body: `${body} Vendor notified.`, link: `/contracts/${c.id}?tab=vmi`, users: [buyer], objectType: 'contract', objectId: c.id, severity: 'warning', dedupeKey: `${key}:i` }).length;
    audit(null, { action: 'contract.vmi_below_minimum', objectType: 'contract', objectId: c.id, objectRef: c.contract_no, after: { material: s.material_code, plant: s.plant, unrestricted: s.unrestricted, min: s.min, max: s.max } });
  }
  return n;
}

export function vmiJob() {
  const list = all<Contract>("SELECT * FROM contracts WHERE status IN ('Active','Expiring') AND vmi_json IS NOT NULL");
  let n = 0;
  for (const c of list) n += vmiCheckContract(c);
  return `${list.length} VMI contracts checked, ${n} notifications`;
}

// ------------------------------------------------------------------ expiry & renewal (FR-CON-04, WF-12, AC-CON-04)
function onceNotify(key: string, fn: () => number) {
  if (get('SELECT id FROM notifications WHERE dedupe_key = ? LIMIT 1', key)) return 0;
  return fn();
}

export function evaluateExpiry(c: Contract) {
  if (!IN_FORCE.includes(c.status)) return 0;
  const days = daysTo(c.valid_to);
  const lead = leadDays(c);
  const recipients = [c.owner_id ?? ownerFor(c.category), managerOf(c.owner_id ?? ownerFor(c.category))];
  const label = c.title ?? c.contract_no;
  let n = 0;
  if (days < 0) {
    update('contracts', c.id, { status: 'Expired' });
    audit(null, { action: 'contract.expired', objectType: 'contract', objectId: c.id, objectRef: c.contract_no, before: { status: c.status }, after: { status: 'Expired', valid_to: c.valid_to } });
    const key = `NTF-13:${c.id}:expired:${c.valid_to}`;
    n += onceNotify(key, () => notify({ event: 'NTF-13', title: `Contract expired: ${label}`, body: `${c.contract_no}${c.sap_oa_no ? ` (SAP OA ${c.sap_oa_no})` : ''} ended on ${c.valid_to}. PRs no longer route to it.`, link: `/contracts/${c.id}`, users: recipients, roles: recipients.some(Boolean) ? undefined : ['APR'], objectType: 'contract', objectId: c.id, severity: 'danger', dedupeKey: key }).length);
    return n;
  }
  if (c.status === 'Active' && days <= lead) {
    update('contracts', c.id, { status: 'Expiring' });
    audit(null, { action: 'contract.expiring', objectType: 'contract', objectId: c.id, objectRef: c.contract_no, before: { status: 'Active' }, after: { status: 'Expiring', days_to_expiry: days, lead_days: lead } });
  } else if (c.status === 'Expiring' && days > lead) {
    update('contracts', c.id, { status: 'Active' });
    audit(null, { action: 'contract.back_to_active', objectType: 'contract', objectId: c.id, objectRef: c.contract_no, before: { status: 'Expiring' }, after: { status: 'Active', valid_to: c.valid_to } });
    return 0;
  }
  if (days > lead) return 0;
  const decided = get("SELECT id FROM contract_changes WHERE contract_id = ? AND kind IN ('let_expire','renewal') AND status NOT IN ('Rejected','Returned','Withdrawn') LIMIT 1", c.id);
  const key = `NTF-13:${c.id}:expiring:${c.valid_to}`;
  n += onceNotify(key, () => notify({ event: 'NTF-13', title: `Renewal due: ${label} expires in ${days} days`, body: `${c.contract_no}${c.sap_oa_no ? ` (SAP OA ${c.sap_oa_no})` : ''} is valid until ${c.valid_to}. Choose renew, extend in SAP or let expire.`, link: `/contracts/renewals`, users: recipients, roles: recipients.some(Boolean) ? undefined : ['APR'], objectType: 'contract', objectId: c.id, severity: 'warning', dedupeKey: key }).length);
  if (!decided) {
    for (const r of cfg<number[]>('contract.renewal_reminder_days')) {
      if (days > r || r >= lead) continue;
      const rk = `NTF-13:${c.id}:r${r}:${c.valid_to}`;
      n += onceNotify(rk, () => notify({ event: 'NTF-13', title: `Reminder: ${label} expires in ${days} days — no renewal decision yet`, body: `${c.contract_no} valid until ${c.valid_to}.`, link: `/contracts/${c.id}`, users: recipients, objectType: 'contract', objectId: c.id, severity: 'danger', dedupeKey: rk }).length);
    }
  }
  return n;
}

export function expiryJob() {
  const list = all<Contract>("SELECT * FROM contracts WHERE status IN ('Active','Expiring')");
  let n = 0;
  for (const c of list) n += evaluateExpiry(c);
  for (const c of all<{ id: number }>("SELECT id FROM contracts WHERE type = 'FDS' OR id IN (SELECT contract_id FROM price_lists)")) refreshPriceListVersion(c.id);
  const exp = scalar<number>("SELECT COUNT(*) FROM contracts WHERE status = 'Expiring'") ?? 0;
  return `${list.length} contracts checked, ${exp} expiring, ${n} notifications`;
}

export function renewalDashboard() {
  const rows = all<Contract & { vendor_name: string; owner_name: string | null }>(
    `SELECT c.*, v.name AS vendor_name, u.name AS owner_name FROM contracts c JOIN vendors v ON v.id = c.vendor_id LEFT JOIN users u ON u.id = c.owner_id
     WHERE c.status IN ('Active','Expiring') OR (c.status = 'Expired' AND c.valid_to >= ?) ORDER BY c.valid_to`, addDaysDate(today(), -90),
  );
  const out = rows.map((c) => {
    const days = daysTo(c.valid_to);
    const lead = leadDays(c);
    const decision = get<{ kind: string; status: string; reason: string | null; after: any; created_at: string }>(
      "SELECT kind, status, reason, after_json, created_at FROM contract_changes WHERE contract_id = ? AND kind IN ('renewal','extension','let_expire') AND status NOT IN ('Rejected','Returned','Withdrawn') ORDER BY id DESC LIMIT 1", c.id,
    );
    const renewal = get<{ id: number; contract_no: string; status: string }>('SELECT id, contract_no, status FROM contracts WHERE renewed_from_id = ? ORDER BY id DESC LIMIT 1', c.id);
    const u = utilisation(c, itemsOf(c.id));
    return {
      id: c.id, contract_no: c.contract_no, sap_oa_no: c.sap_oa_no, type: c.type, title: c.title, vendor_name: c.vendor_name, owner_name: c.owner_name, category: c.category,
      valid_to: c.valid_to, status: c.status, days_to_expiry: days, lead_days: lead, utilisation_pct: u.pct, value_cap: c.value_cap,
      bucket: days < 0 ? 'Expired' : days <= 15 ? '0–15 days' : days <= 30 ? '16–30 days' : days <= lead ? `31–${lead} days` : days <= 90 ? `Up to 90 days` : 'Later',
      decision: decision ? { kind: decision.kind, status: decision.status, reason: decision.reason, at: decision.created_at, after: decision.after } : null,
      renewal: renewal ?? null,
    };
  });
  return { rows: out.filter((r) => r.days_to_expiry <= 90), lead_days: cfg<number>('contract.renewal_lead_days'), later: out.filter((r) => r.days_to_expiry > 90).length };
}

/** Renew: Draft copy with renewed_from_id → approval → SAP (WF-12). */
export function renewContract(actor: Actor, id: number, input: { valid_from?: string; valid_to?: string; reason?: string }) {
  const c = mustContract(id);
  if (!['Active', 'Expiring', 'Expired'].includes(c.status)) throw conflict(`Only active, expiring or recently expired contracts can be renewed (this one is ${c.status.toLowerCase()}).`);
  const open = get<{ contract_no: string; status: string; id: number }>("SELECT id, contract_no, status FROM contracts WHERE renewed_from_id = ? AND status NOT IN ('Terminated','Expired')", id);
  if (open) throw conflict(`Renewal ${open.contract_no} already exists (${open.status.toLowerCase()}). Open it to continue.`);
  const from = input.valid_from ?? (c.valid_to >= today() ? addDaysDate(c.valid_to, 1) : today());
  const to = input.valid_to ?? addDaysDate(addDaysDate(from, 365), -1);
  const items = itemsOf(id);
  const pl = priceListOn(id, today()) ?? null;
  return tx(() => {
    const created = createContract(actor, {
      type: c.type as ContractType, vendor_id: c.vendor_id, title: (c.title ?? c.contract_no).replace(/\s*\(renewal\)$/i, '') + ' (renewal)', category: c.category ?? '', plant: c.plant ?? '*',
      valid_from: from, valid_to: to, value_cap: c.value_cap, payment_terms: c.payment_terms ?? 'As per previous contract', delivery_terms: c.delivery_terms ?? 'As per previous contract',
      discount_pct: c.discount_pct, invoice_validation: !!c.invoice_validation, renewal_lead_days: c.renewal_lead_days ?? undefined, terms: c.terms,
      owner_id: c.owner_id ?? actor.id,
      items: items.map((i) => ({ material_id: i.material_id, unit_price: i.unit_price, qty_cap: i.qty_cap, discount_pct: i.discount_pct })),
      vmi: c.vmi ? { ...c.vmi, items: c.vmi.items.map((v) => ({ material_id: v.material_id, min: v.min, max: v.max })) } : null,
      price_list: c.type === 'FDS' && pl ? { effective_from: from, items: pl.items.map((x) => ({ material_id: x.material_id, list_price: x.list_price })), note: `Carried over from ${c.contract_no} v${pl.version}` } : null,
    }, { renewedFromId: id });
    insert('contract_changes', { contract_id: id, kind: 'renewal', before_json: J({ valid_to: c.valid_to }), after_json: J({ renewal_contract_id: created.id, renewal_contract_no: created.contract_no, valid_from: from, valid_to: to }), status: 'Recorded', requested_by: actor.id, reason: input.reason ?? null, created_at: now() });
    audit(actor, { action: 'contract.renewal_started', objectType: 'contract', objectId: id, objectRef: c.contract_no, after: { renewal: created.contract_no, valid_from: from, valid_to: to }, reason: input.reason ?? null });
    return created;
  });
}

/** Extend validity: approval contract.renewal, then SAP updates the OA (WF-12). */
export function extendContract(actor: Actor, id: number, input: { valid_to: string; reason: string }) {
  const c = mustContract(id);
  if (!['Active', 'Expiring', 'Expired'].includes(c.status)) throw conflict(`Validity can be extended only for active, expiring or recently expired contracts (this one is ${c.status.toLowerCase()}).`);
  if (!c.sap_oa_no) throw conflict('This contract has no SAP outline agreement to extend.');
  if (input.valid_to <= c.valid_to) throw badRequest(`New end date must be after the current end date ${c.valid_to}.`, { valid_to: 'Choose a later date' });
  if (input.valid_to < today()) throw badRequest('New end date is in the past.', { valid_to: 'Choose a future date' });
  const pending = openChange(id);
  if (pending) throw conflict(`A change (${pending.kind}) is already ${pending.status.toLowerCase()} for this contract.`);
  return tx(() => {
    const chId = insert('contract_changes', { contract_id: id, kind: 'extension', before_json: J({ valid_to: c.valid_to }), after_json: J({ valid_to: input.valid_to }), status: 'Pending approval', requested_by: actor.id, reason: input.reason, created_at: now() });
    const ap = createApproval(actor, {
      type: 'contract.renewal', objectType: 'contract_change', objectId: chId, title: `Extend ${c.contract_no} to ${input.valid_to}`,
      summary: `${c.title ?? ''} · SAP OA ${c.sap_oa_no} · valid to ${c.valid_to} → ${input.valid_to}`, value: c.value_cap ?? 0, reason: input.reason, categoryCode: c.category,
      context: { link: `/contracts/${id}`, contract_no: c.contract_no, sap_oa_no: c.sap_oa_no, kind: 'extension', before: { valid_to: c.valid_to }, after: { valid_to: input.valid_to }, utilisation: utilisation(c, itemsOf(id)).pct },
    });
    update('contract_changes', chId, { approval_id: ap.id });
    audit(actor, { action: 'contract.extension_requested', objectType: 'contract', objectId: id, objectRef: c.contract_no, before: { valid_to: c.valid_to }, after: { valid_to: input.valid_to, approval: ap.req_no }, reason: input.reason });
    return get<ChangeRow>('SELECT * FROM contract_changes WHERE id = ?', chId)!;
  });
}

export function letExpire(actor: Actor, id: number, reason: string) {
  const c = mustContract(id);
  if (!IN_FORCE.includes(c.status)) throw conflict(`Contract is ${c.status.toLowerCase()}.`);
  if (get("SELECT id FROM contract_changes WHERE contract_id = ? AND kind = 'let_expire' AND status = 'Recorded'", id)) throw conflict('A let-expire decision is already recorded for this contract.');
  insert('contract_changes', { contract_id: id, kind: 'let_expire', before_json: J({ valid_to: c.valid_to }), after_json: J({ decision: 'Let expire' }), status: 'Recorded', requested_by: actor.id, reason, created_at: now() });
  audit(actor, { action: 'contract.let_expire', objectType: 'contract', objectId: id, objectRef: c.contract_no, after: { valid_to: c.valid_to, decision: 'Let expire' }, reason });
  return getContract(id)!;
}

export function terminateContract(actor: Actor, id: number, reason: string) {
  const c = mustContract(id);
  if (['Terminated', 'Expired', 'Renewed'].includes(c.status)) throw conflict(`Contract is already ${c.status.toLowerCase()}.`);
  if (c.status === 'Pending approval') throw conflict('Withdraw the approval request first, then discard the draft.');
  return tx(() => {
    update('contracts', id, { status: 'Terminated', terminated_reason: reason });
    run("UPDATE contract_changes SET status = 'Withdrawn', note = 'Contract terminated' WHERE contract_id = ? AND status IN ('Pending SAP')", id);
    audit(actor, { action: c.status === 'Draft' ? 'contract.draft_discarded' : 'contract.terminated', objectType: 'contract', objectId: id, objectRef: c.contract_no, before: { status: c.status }, after: { status: 'Terminated' }, reason });
    if (c.sap_oa_no) notify({ event: 'NTF-13', title: `${c.contract_no} terminated — block SAP OA ${c.sap_oa_no}`, body: reason, link: `/contracts/${id}`, roles: ['SAP'], users: [c.owner_id], objectType: 'contract', objectId: id, severity: 'warning', dedupeKey: `con-term:${id}` });
    return getContract(id)!;
  });
}

// ------------------------------------------------------------------ SAP OA sync reaction (INT-M06)
/** Payload the SAP simulator writes for a platform contract (new OA or approved change). */
export function sapOaPayload(contractId: number) {
  const c = mustContract(contractId);
  const vendor = get<{ sap_code: string | null }>('SELECT sap_code FROM vendors WHERE id = ?', c.vendor_id)!;
  const pending = get<ChangeRow>("SELECT * FROM contract_changes WHERE contract_id = ? AND status = 'Pending SAP' ORDER BY id DESC LIMIT 1", contractId);
  const after: Record<string, any> = pending?.after ?? {};
  let items = itemsOf(contractId).map((i) => ({ material_code: i.material_code, unit_price: i.unit_price, qty_cap: i.qty_cap, consumed_qty: i.consumed_qty, uom: i.uom ?? i.material_uom, discount_pct: i.discount_pct }));
  for (const it of (after.items ?? []) as { material_code: string; after: any }[]) {
    items = items.filter((x) => x.material_code !== it.material_code);
    if (it.after) items.push({ material_code: it.material_code, unit_price: it.after.unit_price, qty_cap: it.after.qty_cap, consumed_qty: 0, uom: null as any, discount_pct: it.after.discount_pct });
  }
  return {
    key: c.sap_oa_no, contract_id: c.id, status: c.status, change_id: pending?.id ?? null,
    payload: {
      type: c.type, title: c.title, category: c.category, plant: c.plant ?? '*', vendor_sap_code: vendor.sap_code, platform_ref: c.contract_no,
      valid_from: after.valid_from ?? c.valid_from, valid_to: after.valid_to ?? c.valid_to, value_cap: after.value_cap ?? c.value_cap,
      consumed_value: c.consumed_value ?? 0, payment_terms: after.payment_terms ?? c.payment_terms, delivery_terms: after.delivery_terms ?? c.delivery_terms, items,
    },
  };
}

export function onOaSynced(rows: { id: number; isNew: boolean; payload: any }[]) {
  for (const r of rows) {
    const c = getContract(r.id);
    if (!c) continue;
    const ts = now();
    // SAP-originated OA: give it a platform owner and lead time (platform-owned fields).
    if (!c.created_by && (c.owner_id == null || c.renewal_lead_days == null || r.isNew)) {
      update('contracts', c.id, { owner_id: c.owner_id ?? ownerFor(c.category), renewal_lead_days: r.isNew ? cfg<number>('contract.renewal_lead_days') : c.renewal_lead_days ?? cfg<number>('contract.renewal_lead_days') });
    }
    // Platform contract linked to its SAP OA for the first time → Active (FR-CON-08 repository link).
    if (c.created_by && c.sap_oa_no && !get("SELECT id FROM audit_events WHERE object_type = 'contract' AND object_id = ? AND action = 'contract.sap_linked'", String(c.id))) {
      audit(null, { action: 'contract.sap_linked', objectType: 'contract', objectId: c.id, objectRef: c.contract_no, before: { status: 'Pending SAP' }, after: { status: c.status, sap_oa_no: c.sap_oa_no } });
      notify({ event: 'NTF-12', title: `${c.contract_no} is active — SAP OA ${c.sap_oa_no}`, body: `${c.title ?? ''} can now be used for PR routing (valid ${c.valid_from} to ${c.valid_to}).`, link: `/contracts/${c.id}`, users: [c.owner_id, c.created_by], objectType: 'contract', objectId: c.id, severity: 'success', dedupeKey: `con-active:${c.id}` });
      if (c.renewed_from_id) {
        const old = getContract(c.renewed_from_id);
        if (old && ['Active', 'Expiring', 'Expired'].includes(old.status)) {
          update('contracts', old.id, { status: 'Renewed' });
          audit(null, { action: 'contract.renewed', objectType: 'contract', objectId: old.id, objectRef: old.contract_no, before: { status: old.status }, after: { status: 'Renewed', replaced_by: c.contract_no } });
        }
      }
    }
    const fresh = getContract(c.id)!;
    // The OA mapper resets status from SAP; keep platform terminal decisions.
    if (fresh.terminated_reason && fresh.status !== 'Terminated') update('contracts', c.id, { status: 'Terminated' });
    else if (['Active', 'Expiring', 'Expired'].includes(fresh.status) && get("SELECT id FROM contracts WHERE renewed_from_id = ? AND status IN ('Active','Expiring')", c.id)) update('contracts', c.id, { status: 'Renewed' });
    // Approved changes waiting for SAP: applied when SAP shows them.
    for (const ch of all<ChangeRow>("SELECT * FROM contract_changes WHERE contract_id = ? AND status = 'Pending SAP'", c.id)) {
      const cur = getContract(c.id)!;
      const after = ch.after ?? {};
      const items = itemsOf(c.id);
      const okFields = SAP_FIELDS.every((k) => !(k in after) || JSON.stringify(after[k] ?? null) === JSON.stringify((cur as any)[k] ?? null));
      const okItems = ((after.items ?? []) as { material_id: number; after: any }[]).every((it) => {
        const ex = items.find((x) => x.material_id === it.material_id);
        return it.after ? !!ex && ex.unit_price === it.after.unit_price && (ex.qty_cap ?? null) === (it.after.qty_cap ?? null) : !ex;
      });
      if (okFields && okItems) {
        update('contract_changes', ch.id, { status: 'Applied', applied_at: ts });
        audit(null, { action: 'contract.change_applied', objectType: 'contract', objectId: c.id, objectRef: c.contract_no, before: ch.before, after, reason: `Confirmed by SAP OA sync (${ch.kind})` });
        notify({ event: 'NTF-12', title: `${c.contract_no}: ${ch.kind === 'extension' ? `validity extended to ${after.valid_to}` : 'new terms now in SAP'}`, link: `/contracts/${c.id}`, users: [c.owner_id, ch.requested_by], objectType: 'contract', objectId: c.id, severity: 'success', dedupeKey: `con-change-applied:${ch.id}` });
      }
    }
    evaluateExpiry(getContract(c.id)!);
    vmiCheckContract(getContract(c.id)!);
  }
}

// ------------------------------------------------------------------ off-contract detection (CON-03, AC-CON-03)
export function onPoSynced(rows: { id: number; isNew: boolean }[]) {
  let created = 0;
  for (const r of rows) {
    if (!r.isNew) continue;
    const po = get<{ id: number; po_no: string; vendor_id: number; buyer_id: number | null; plant: string; po_date: string; contract_id: number | null; status: string }>('SELECT * FROM pos WHERE id = ?', r.id);
    if (!po || po.contract_id || po.status === 'Cancelled') continue;
    for (const l of all<{ id: number; item: number; material_id: number | null; qty: number; unit_price: number; status: string }>('SELECT id, item, material_id, qty, unit_price, status FROM po_lines WHERE po_id = ?', po.id)) {
      if (!l.material_id || l.status === 'Cancelled') continue;
      const cov = coveringContract(l.material_id, po.plant, po.po_date);
      if (!cov) continue;
      const res = run(
        `INSERT OR IGNORE INTO contract_alerts (po_id, po_line_id, po_no, item, material_id, contract_id, po_vendor_id, po_date, plant, qty, unit_price, contract_price, value, buyer_id, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Open',?)`,
        po.id, l.id, po.po_no, l.item, l.material_id, cov.id, po.vendor_id, po.po_date, po.plant, l.qty, l.unit_price, cov.unit_price, round2(l.qty * l.unit_price), po.buyer_id, now(),
      );
      if (!res.changes) continue;
      created++;
      const code = scalar<string>('SELECT code FROM materials WHERE id = ?', l.material_id);
      const vendor = scalar<string>('SELECT name FROM vendors WHERE id = ?', po.vendor_id);
      audit(null, { action: 'contract.off_contract_detected', objectType: 'contract_alert', objectId: res.lastId, objectRef: `${po.po_no}/${l.item}`, after: { material: code, contract: cov.contract_no, sap_oa_no: cov.sap_oa_no, po_vendor: vendor, unit_price: l.unit_price, contract_price: cov.unit_price } });
      notify({
        event: 'NTF-14', title: `Off-contract purchase: PO ${po.po_no}/${l.item} (${code})`,
        body: `${code} was bought from ${vendor} at ₹${l.unit_price} without a contract reference while ${cov.type} ${cov.contract_no} (SAP OA ${cov.sap_oa_no}, ${cov.vendor}, ₹${cov.unit_price}) was valid. Record a justification or dismiss with reason.`,
        link: `/contracts?tab=alerts&alert=${res.lastId}`, users: [po.buyer_id], roles: ['APR'], objectType: 'contract_alert', objectId: res.lastId, severity: 'warning', dedupeKey: `NTF-14:alert:${res.lastId}`,
      });
    }
  }
  return created;
}

export function listAlerts(q: Record<string, string | undefined> = {}) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (q.status === 'open') where.push("a.status IN ('Open','Justification pending approval')");
  else if (q.status) { where.push('a.status = ?'); p.push(q.status); }
  if (q.contract) { where.push('a.contract_id = ?'); p.push(Number(q.contract)); }
  return all<AlertRow & Record<string, unknown>>(
    `SELECT a.*, m.code AS material_code, m.description, m.uom, c.contract_no, c.sap_oa_no, c.type AS contract_type, cv.name AS contract_vendor,
            pv.name AS po_vendor, b.name AS buyer_name, d.name AS decided_by_name, ap.req_no, ap.status AS approval_status
     FROM contract_alerts a JOIN materials m ON m.id = a.material_id JOIN contracts c ON c.id = a.contract_id JOIN vendors cv ON cv.id = c.vendor_id
     JOIN vendors pv ON pv.id = a.po_vendor_id LEFT JOIN users b ON b.id = a.buyer_id LEFT JOIN users d ON d.id = a.decided_by LEFT JOIN approvals ap ON ap.id = a.approval_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE a.status WHEN 'Open' THEN 0 WHEN 'Justification pending approval' THEN 1 ELSE 2 END, a.id DESC`,
    ...p,
  ).map((a) => ({ ...a, price_variance: a.contract_price ? round2((a.unit_price - a.contract_price) * a.qty) : null, age_days: Math.max(0, -daysTo(a.created_at.slice(0, 10))) }));
}

function mustAlert(id: number) {
  const a = get<AlertRow>('SELECT * FROM contract_alerts WHERE id = ?', id);
  if (!a) throw notFound('Off-contract alert');
  return a;
}

/** Record a justification: reason + off-contract exception approval (WF-12, APP-04, AC-APR-04). */
export function justifyAlert(actor: Actor, id: number, reason: string) {
  const a = mustAlert(id);
  if (a.status !== 'Open') throw conflict(`Alert is already ${a.status.toLowerCase()}.`);
  const c = getContract(a.contract_id)!;
  const code = scalar<string>('SELECT code FROM materials WHERE id = ?', a.material_id);
  return tx(() => {
    const ap = createApproval(actor, {
      type: 'exc.off_contract', objectType: 'contract_alert', objectId: id, title: `Off-contract PO ${a.po_no}/${a.item} — ${code}`,
      summary: `Bought outside ${c.contract_no} (SAP OA ${c.sap_oa_no}). PO ₹${a.unit_price} vs contract ₹${a.contract_price ?? '—'} × ${a.qty}`,
      value: a.value, reason, plant: a.plant, categoryCode: c.category,
      context: { link: `/contracts?tab=alerts&alert=${id}`, po_no: a.po_no, item: a.item, material: code, contract_no: c.contract_no, sap_oa_no: c.sap_oa_no, po_price: a.unit_price, contract_price: a.contract_price, qty: a.qty },
    });
    update('contract_alerts', id, { status: 'Justification pending approval', reason, approval_id: ap.id });
    audit(actor, { action: 'contract.off_contract_justified', objectType: 'contract_alert', objectId: id, objectRef: `${a.po_no}/${a.item}`, before: { status: a.status }, after: { status: 'Justification pending approval', approval: ap.req_no }, reason });
    return mustAlert(id);
  });
}

export function onAlertDecision(ap: ApprovalRow, outcome: string, actor: Actor | null, comment: string | null) {
  const a = get<AlertRow>('SELECT * FROM contract_alerts WHERE id = ?', ap.object_id);
  if (!a || a.status !== 'Justification pending approval') return;
  const status = outcome === 'Approved' ? 'Justified' : 'Open';
  update('contract_alerts', a.id, outcome === 'Approved' ? { status, decided_by: actor?.id ?? null, decided_at: now() } : { status, approval_id: null });
  audit(actor, { action: `contract.off_contract_${outcome.toLowerCase()}`, objectType: 'contract_alert', objectId: a.id, objectRef: `${a.po_no}/${a.item}`, before: { status: a.status }, after: { status }, reason: comment });
}

export function dismissAlert(actor: Actor, id: number, reason: string) {
  const a = mustAlert(id);
  if (a.status !== 'Open') throw conflict(`Alert is already ${a.status.toLowerCase()}.`);
  update('contract_alerts', id, { status: 'Dismissed', reason, decided_by: actor.id, decided_at: now() });
  audit(actor, { action: 'contract.off_contract_dismissed', objectType: 'contract_alert', objectId: id, objectRef: `${a.po_no}/${a.item}`, before: { status: a.status }, after: { status: 'Dismissed' }, reason });
  return mustAlert(id);
}

// ------------------------------------------------------------------ ARC/OA opportunities (FR-CON-02, AC-CON-02, DEC-09)
export function opportunityJob() {
  const th = cfg<{ lookback_days: number; min_frequency: number; min_annual_value: number }>('contract.opportunity');
  const since = addDaysDate(today(), -th.lookback_days);
  const rows = all<{ material_id: number; category: string | null; freq: number; value: number; vendors: number }>(
    `SELECT pl.material_id, m.category, COUNT(DISTINCT p.id) AS freq, SUM(pl.qty * pl.unit_price) AS value, COUNT(DISTINCT p.vendor_id) AS vendors
     FROM po_lines pl JOIN pos p ON p.id = pl.po_id JOIN materials m ON m.id = pl.material_id
     WHERE p.po_date >= ? AND pl.status != 'Cancelled' AND p.status != 'Cancelled' AND m.is_service = 0
       AND (p.contract_id IS NULL OR NOT EXISTS (SELECT 1 FROM contract_items ci WHERE ci.contract_id = p.contract_id AND ci.material_id = pl.material_id))
     GROUP BY pl.material_id`, since,
  );
  let total = 0;
  let fresh = 0;
  for (const r of rows) {
    const annual = round2((r.value * 365) / th.lookback_days);
    if (r.freq < th.min_frequency || annual < th.min_annual_value) continue;
    if (coveringContract(r.material_id, null)) continue; // already covered for routing
    const pending = get<{ contract_no: string; status: string }>(
      `SELECT c.contract_no, c.status FROM contracts c JOIN contract_items ci ON ci.contract_id = c.id WHERE ci.material_id = ? AND c.status IN ('Draft','Pending approval','Pending SAP') ORDER BY c.id DESC LIMIT 1`, r.material_id,
    );
    const lapsed = get<{ contract_no: string; sap_oa_no: string | null; valid_to: string; status: string }>(
      `SELECT c.contract_no, c.sap_oa_no, c.valid_to, c.status FROM contracts c JOIN contract_items ci ON ci.contract_id = c.id WHERE ci.material_id = ? AND c.status IN ('Expired','Terminated','Active','Expiring') ORDER BY c.valid_to DESC LIMIT 1`, r.material_id,
    );
    const coverage = pending ? `Platform contract ${pending.contract_no} (${pending.status.toLowerCase()})`
      : lapsed ? `${lapsed.status === 'Expired' ? 'Expired' : lapsed.status} ${lapsed.sap_oa_no ? `OA ${lapsed.sap_oa_no}` : lapsed.contract_no} (to ${lapsed.valid_to}) — not usable`
      : 'None — spot purchases';
    const action = pending ? `Complete ${pending.contract_no} through approval and SAP OA creation`
      : r.vendors === 1 ? `Negotiate an ARC with the single incumbent vendor (${r.freq} POs in ${th.lookback_days} days)`
      : `Run an annual-rate RFQ to consolidate ${r.vendors} vendors into one ARC/OA`;
    total++;
    const ex = get<{ id: number; status: string }>('SELECT id, status FROM opportunities WHERE material_id = ?', r.material_id);
    if (ex) update('opportunities', ex.id, { category: r.category, frequency: r.freq, annual_value: annual, vendor_count: r.vendors, current_coverage: coverage, suggested_action: action });
    else {
      fresh++;
      const id = insert('opportunities', { material_id: r.material_id, category: r.category, frequency: r.freq, annual_value: annual, vendor_count: r.vendors, current_coverage: coverage, suggested_action: action, status: 'Identified', identified_at: now() });
      audit(null, { action: 'contract.opportunity_identified', objectType: 'opportunity', objectId: id, after: { material_id: r.material_id, frequency: r.freq, annual_value: annual, vendors: r.vendors } });
    }
  }
  return `${total} opportunities above thresholds (${fresh} new)`;
}

export function listOpportunities() {
  const th = cfg<{ lookback_days: number }>('contract.opportunity');
  return all<Record<string, any>>(
    `SELECT o.*, m.code AS material_code, m.description, m.uom, sc.name AS category_name, u.name AS decided_by_name, c.contract_no, c.status AS contract_status
     FROM opportunities o LEFT JOIN materials m ON m.id = o.material_id LEFT JOIN spend_categories sc ON sc.code = o.category
     LEFT JOIN users u ON u.id = o.decided_by LEFT JOIN contracts c ON c.id = o.contract_id
     ORDER BY CASE o.status WHEN 'Identified' THEN 0 WHEN 'Under review' THEN 1 WHEN 'Accepted' THEN 2 ELSE 3 END, o.annual_value DESC`,
  ).map((o): Record<string, any> => ({ ...o, lookback_days: th.lookback_days }));
}

function mustOpp(id: number) {
  const o = get<{ id: number; material_id: number; category: string | null; status: string; contract_id: number | null; frequency: number; annual_value: number }>('SELECT * FROM opportunities WHERE id = ?', id);
  if (!o) throw notFound('Opportunity');
  return o;
}

export function opportunityDetail(id: number) {
  const o = listOpportunities().find((x) => x.id === id);
  if (!o) throw notFound('Opportunity');
  const th = cfg<{ lookback_days: number }>('contract.opportunity');
  const history = all(
    `SELECT p.id AS po_id, p.po_no, p.po_date, p.plant, v.name AS vendor, v.id AS vendor_id, pl.qty, pl.unit_price, pl.qty * pl.unit_price AS value
     FROM po_lines pl JOIN pos p ON p.id = pl.po_id JOIN vendors v ON v.id = p.vendor_id
     WHERE pl.material_id = ? AND p.po_date >= ? AND pl.status != 'Cancelled' ORDER BY p.po_date DESC`, o.material_id, addDaysDate(today(), -th.lookback_days),
  );
  return { ...o, history };
}

export function reviewOpportunity(actor: Actor, id: number) {
  const o = mustOpp(id);
  if (o.status !== 'Identified') throw conflict(`Opportunity is ${o.status.toLowerCase()}.`);
  update('opportunities', id, { status: 'Under review', decided_by: actor.id, decided_at: now() });
  audit(actor, { action: 'contract.opportunity_review', objectType: 'opportunity', objectId: id, before: { status: o.status }, after: { status: 'Under review' } });
  return mustOpp(id);
}

/** Accept: sourcing starts (annual-rate RFQ via Module 2) and a prefilled Draft ARC is created (FR-CON-08). */
export function acceptOpportunity(actor: Actor, id: number, input: { vendor_id?: number; note?: string }) {
  const o = mustOpp(id);
  if (!['Identified', 'Under review'].includes(o.status)) throw conflict(`Opportunity is already ${o.status.toLowerCase()}.`);
  const th = cfg<{ lookback_days: number }>('contract.opportunity');
  const since = addDaysDate(today(), -th.lookback_days);
  const stats = get<{ qty: number; min_price: number; last_price: number }>(
    `SELECT SUM(pl.qty) AS qty, MIN(pl.unit_price) AS min_price,
            (SELECT pl2.unit_price FROM po_lines pl2 JOIN pos p2 ON p2.id = pl2.po_id WHERE pl2.material_id = ? ORDER BY p2.po_date DESC LIMIT 1) AS last_price
     FROM po_lines pl JOIN pos p ON p.id = pl.po_id WHERE pl.material_id = ? AND p.po_date >= ? AND pl.status != 'Cancelled'`, o.material_id, o.material_id, since,
  )!;
  const incumbent = get<{ vendor_id: number }>(
    `SELECT p.vendor_id FROM po_lines pl JOIN pos p ON p.id = pl.po_id JOIN vendors v ON v.id = p.vendor_id
     WHERE pl.material_id = ? AND p.po_date >= ? AND v.sap_blocked = 0 GROUP BY p.vendor_id ORDER BY SUM(pl.qty * pl.unit_price) DESC LIMIT 1`, o.material_id, since,
  );
  const vendorId = input.vendor_id ?? incumbent?.vendor_id;
  if (!vendorId) throw badRequest('Choose the vendor to prefill the draft ARC with.', { vendor_id: 'Choose a vendor' });
  const m = get<{ code: string; description: string; category: string | null }>('SELECT code, description, category FROM materials WHERE id = ?', o.material_id)!;
  return tx(() => {
    const from = today();
    const draft = createContract(actor, {
      type: 'ARC', vendor_id: vendorId, title: `Annual rate contract – ${m.description}`, category: m.category ?? o.category ?? '', plant: '*',
      valid_from: from, valid_to: addDaysDate(addDaysDate(from, 365), -1), value_cap: Math.round(o.annual_value), payment_terms: '45 days from GRN', delivery_terms: 'FOR destination',
      terms: `Prefilled from ARC/OA opportunity #${id} (${o.frequency} POs, ${Math.round(o.annual_value)} INR in ${th.lookback_days} days). Confirm vendor, price and terms after the annual-rate RFQ.${input.note ? ` Note: ${input.note}` : ''}`,
      items: [{ material_id: o.material_id, unit_price: stats.min_price ?? stats.last_price ?? 0, qty_cap: stats.qty ?? null }],
    });
    update('opportunities', id, { status: 'Accepted', decided_by: actor.id, decided_at: now(), decision_reason: input.note ?? null, contract_id: draft.id });
    audit(actor, { action: 'contract.opportunity_accepted', objectType: 'opportunity', objectId: id, before: { status: o.status }, after: { status: 'Accepted', draft_contract: draft.contract_no }, reason: input.note ?? null });
    return { opportunity: mustOpp(id), contract_id: draft.id, contract_no: draft.contract_no, rfq_link: `/rfqs/new?opportunity=${id}` };
  });
}

export function rejectOpportunity(actor: Actor, id: number, reason: string) {
  const o = mustOpp(id);
  if (!['Identified', 'Under review'].includes(o.status)) throw conflict(`Opportunity is already ${o.status.toLowerCase()}.`);
  update('opportunities', id, { status: 'Rejected', decision_reason: reason, decided_by: actor.id, decided_at: now() });
  audit(actor, { action: 'contract.opportunity_rejected', objectType: 'opportunity', objectId: id, before: { status: o.status }, after: { status: 'Rejected' }, reason });
  return mustOpp(id);
}

// ------------------------------------------------------------------ reports data (RPT-06, RPT-07)
export function opportunityReport() {
  const rows = listOpportunities();
  const by = (s: string) => rows.filter((r) => r.status === s);
  return {
    rows, thresholds: cfg('contract.opportunity'),
    summary: ['Identified', 'Under review', 'Accepted', 'Rejected'].map((s) => ({ status: s, count: by(s).length, annual_value: round2(by(s).reduce((a, r) => a + (r.annual_value ?? 0), 0)) })),
  };
}

/** RPT-07 contract coverage: PO value under ARC/OA/FDS/VMI/fixed supplier vs spot (KPI-08, KPI-09). */
export function coverageReport(q: { from?: string; to?: string } = {}) {
  const from = q.from ?? addDaysDate(today(), -365);
  const to = q.to ?? today();
  const rows = all<{ type: string | null; category: string | null; value: number }>(
    `SELECT c.type, m.category, SUM(pl.qty * pl.unit_price) AS value FROM po_lines pl JOIN pos p ON p.id = pl.po_id
     LEFT JOIN contracts c ON c.id = p.contract_id LEFT JOIN materials m ON m.id = pl.material_id
     WHERE p.po_date BETWEEN ? AND ? AND pl.status != 'Cancelled' AND p.status != 'Cancelled' GROUP BY c.type, m.category`, from, to,
  );
  const total = rows.reduce((a, r) => a + r.value, 0);
  const covered = rows.filter((r) => r.type).reduce((a, r) => a + r.value, 0);
  const byType = [...CONTRACT_TYPES, 'Spot'].map((t) => ({ type: t, value: round2(rows.filter((r) => (r.type ?? 'Spot') === t).reduce((a, r) => a + r.value, 0)) }));
  const cats = [...new Set(rows.map((r) => r.category ?? '—'))];
  const byCategory = cats.map((cat) => {
    const rs = rows.filter((r) => (r.category ?? '—') === cat);
    const t = rs.reduce((a, r) => a + r.value, 0);
    const cv = rs.filter((r) => r.type).reduce((a, r) => a + r.value, 0);
    return { category: cat, total: round2(t), covered: round2(cv), spot: round2(t - cv), coverage: t ? cv / t : 0 };
  }).sort((a, b) => b.total - a.total);
  return {
    from, to, total: round2(total), covered: round2(covered), spot: round2(total - covered),
    kpi08_coverage: total ? covered / total : 0, kpi09_spot_dependency: total ? (total - covered) / total : 0,
    baseline: 'Baseline: to be measured', target: 'Target: pending approval', by_type: byType, by_category: byCategory,
  };
}

// ------------------------------------------------------------------ vendor view (own contracts only)
const VENDOR_HIDDEN = ['Draft', 'Pending approval'];
export function vendorList(actor: Actor) {
  return all<Contract>(`SELECT * FROM contracts WHERE vendor_id = ? AND status NOT IN ('Draft','Pending approval') ORDER BY CASE status WHEN 'Expiring' THEN 0 WHEN 'Active' THEN 1 ELSE 2 END, valid_to DESC`, actor.vendorId ?? -1).map((c) => {
    const items = itemsOf(c.id);
    const u = utilisation(c, items);
    const vmi = vmiStatus(c);
    return {
      id: c.id, contract_no: c.contract_no, sap_oa_no: c.sap_oa_no, type: c.type, title: c.title, status: c.status, valid_from: c.valid_from, valid_to: c.valid_to,
      value_cap: c.value_cap, utilisation_pct: u.pct, scope: items.map((i) => i.material_code).join(', '), days_to_expiry: daysTo(c.valid_to),
      vmi_below_min: vmi.filter((v) => v.state === 'Below minimum').length,
    };
  });
}

export function vendorDetail(actor: Actor, id: number) {
  const c = getContract(id);
  if (!c || VENDOR_HIDDEN.includes(c.status)) { assertVendorScope(actor, -1, 'contract', id); throw notFound('Contract'); }
  assertVendorScope(actor, c.vendor_id, 'contract', id);
  const items = itemsOf(id);
  const u = utilisation(c, items);
  return {
    id: c.id, contract_no: c.contract_no, sap_oa_no: c.sap_oa_no, type: c.type, title: c.title, status: c.status, category: c.category, plant: c.plant,
    valid_from: c.valid_from, valid_to: c.valid_to, value_cap: c.value_cap, payment_terms: c.payment_terms, delivery_terms: c.delivery_terms,
    discount_pct: c.discount_pct, terms: c.terms, price_revision_date: c.price_revision_date, days_to_expiry: daysTo(c.valid_to),
    items: items.map((i) => ({ id: i.id, material_code: i.material_code, description: i.description, uom: i.uom ?? i.material_uom, unit_price: i.unit_price, qty_cap: i.qty_cap, discount_pct: i.discount_pct, utilisation: u.items.find((x) => x.item_id === i.id) })),
    utilisation: { consumed: u.consumed, cap: u.cap, pct: u.pct, remaining: u.remaining },
    price_lists: priceLists(id).map((p) => ({ id: p.id, version: p.version, effective_from: p.effective_from, state: p.state, items: p.items, note: p.note })),
    vmi: c.vmi ? { replenishment_frequency: c.vmi.replenishment_frequency, billing_cycle: c.vmi.billing_cycle, reconciliation: c.vmi.reconciliation, plant: c.vmi.plant } : null,
    vmi_status: vmiStatus(c),
    pos: all('SELECT id, po_no, po_date, status, total_value FROM pos WHERE contract_id = ? AND vendor_id = ? ORDER BY po_date DESC', id, c.vendor_id),
  };
}

/** Who may read a contract and its files/threads. */
export function canAccessContract(actor: Actor, id: number) {
  const c = get<{ vendor_id: number; status: string }>('SELECT vendor_id, status FROM contracts WHERE id = ?', id);
  if (!c) return false;
  if (actor.role === 'VEN') return c.vendor_id === actor.vendorId && !VENDOR_HIDDEN.includes(c.status);
  return actor.perms.has('con.view');
}

export function formOptions() {
  return {
    vendors: all("SELECT id, name, sap_code, city, sap_blocked FROM vendors WHERE onboarding_status = 'Active' OR sap_code IS NOT NULL ORDER BY name"),
    materials: all('SELECT id, code, description, uom, category, lpp, gst_rate FROM materials WHERE is_service = 0 ORDER BY code'),
    categories: all('SELECT code, name FROM spend_categories ORDER BY name'),
    plants: all('SELECT code, name FROM plants ORDER BY code'),
    buyers: all("SELECT id, name FROM users WHERE active = 1 AND (',' || roles || ',') LIKE '%,BUY,%' ORDER BY name"),
    types: CONTRACT_TYPES, renewal_lead_days: cfg<number>('contract.renewal_lead_days'),
  };
}

export function pendingSap() {
  return all(
    `SELECT c.id, c.contract_no, c.type, c.title, c.status, c.valid_from, c.valid_to, c.value_cap, v.name AS vendor, v.sap_code AS vendor_sap_code
     FROM contracts c JOIN vendors v ON v.id = c.vendor_id
     WHERE c.status = 'Pending SAP' OR c.id IN (SELECT contract_id FROM contract_changes WHERE status = 'Pending SAP') ORDER BY c.id`,
  );
}

/** Guard used by routes: only the owner, creator or a manager acts on renewal decisions. */
export function assertCanManage(actor: Actor, c: Contract) {
  if (!actor.perms.has('con.manage')) throw forbidden('Your role cannot change contracts.');
  void c;
}
export { mustContract };
