/**
 * SAP SIMULATOR console actions (ENGINEERING.md "SAP simulator HTTP API").
 *
 * The simulator stands in for SAP: each action writes SAP documents (`sapPut`) in the payload shapes of
 * seed/base.ts, is audited, and then runs the matching inbound flow at once (`syncEvent`) so the platform
 * copy updates through the normal mappers. Finance control applies here too: an invoice is never parked or
 * posted without finance approval (FR-INV-19, AC-INV-10).
 */
import { all, get, now, scalar, update, run } from '../../core/db.ts';
import { audit } from '../../core/audit.ts';
import { notify } from '../../core/notify.ts';
import { cfg } from '../../core/config.ts';
import { badRequest, conflict, notFound, forbidden } from '../../core/http.ts';
import { nextSapNo } from '../../core/numbering.ts';
import { FLOWS, sapGet, sapList, sapPut, syncEvent, simSettings, setSimSettings, runAllInbound, type SimSettings } from '../../core/sap.ts';
import { poReference, getLine } from '../pr/service.ts';
import type { Actor } from '../../core/auth.ts';
import { processQueue, resolveRecoveredPulls } from './monitor.ts';

const today = () => now().slice(0, 10);
const addDaysDate = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const by = (a: Actor) => `SAP simulator · ${a.name}`;
const DOC_FLOW: Record<string, string> = { VENDOR: 'INT-M01', MATERIAL: 'INT-M02', PR: 'INT-M03', STOCK: 'INT-M04', OA: 'INT-M06', PO: 'INT-M07', GRN: 'INT-M10', INVSTATUS: 'INT-M12', ADVPAY: 'INT-M12' };

/** Run the inbound flow for a document straight away and report the real outcome. */
function syncNow(docType: string, key: string) {
  const r = syncEvent(docType);
  const flow = DOC_FLOW[docType];
  const err = get<{ id: number; error: string; error_type: string }>(
    "SELECT id, error, error_type FROM integration_errors WHERE flow = ? AND (message_id = ? OR message_id LIKE ?) AND status IN ('Queued','Retrying','Failed') ORDER BY id DESC LIMIT 1",
    flow, `${docType}:${key}`, `${docType}:pull:%`,
  );
  const synced = r.status !== 'Failed' && !err;
  return {
    flow, status: r.status, read: r.read, upserted: r.upserted, errors: r.errors, synced,
    message: synced ? `Platform updated through ${flow}.` : `Saved in the SAP simulator, but ${flow} could not update the platform: ${err?.error ?? 'sync failed'}. See the integration error queue.`,
    error_id: err?.id ?? null,
  };
}

// ---------------------------------------------------------------- purchase requisitions
const PR_ITEM = { material_code: '', qty: 0, plant: '', required_date: '', priority: 'Normal' as string, storage_location: undefined as string | undefined, est_unit_price: undefined as number | undefined };
export type PrItemInput = typeof PR_ITEM;

export function createPr(actor: Actor, input: { requisitioner_email: string; department?: string; items: PrItemInput[] }) {
  const req = get<{ id: number; roles: string; department: string | null; email: string }>('SELECT id, roles, department, email FROM users WHERE lower(email) = lower(?) AND vendor_id IS NULL AND active = 1', input.requisitioner_email);
  if (!req) throw badRequest('Choose an active internal user as the requisitioner.', { requisitioner_email: 'Unknown user' });
  if (!input.items.length) throw badRequest('Add at least one item to the PR.', { items: 'Add an item' });
  const plants = new Set(all<{ code: string }>('SELECT code FROM plants').map((p) => p.code));
  const items = input.items.map((it, i) => {
    const m = get<{ code: string; description: string; uom: string; lpp: number | null; is_service: number }>('SELECT code, description, uom, lpp, is_service FROM materials WHERE code = ?', it.material_code);
    if (!m) throw badRequest(`Item ${i + 1}: material ${it.material_code} is not in the SAP material master.`, { [`items.${i}.material_code`]: 'Unknown material' });
    if (!(it.qty > 0)) throw badRequest(`Item ${i + 1}: quantity must be more than zero.`, { [`items.${i}.qty`]: 'Must be > 0' });
    if (!plants.has(it.plant)) throw badRequest(`Item ${i + 1}: choose a valid plant.`, { [`items.${i}.plant`]: 'Unknown plant' });
    if (!it.required_date || it.required_date < today()) throw badRequest(`Item ${i + 1}: the required date must be today or later.`, { [`items.${i}.required_date`]: 'Past date' });
    return {
      item: (i + 1) * 10, material_code: m.code, description: m.description, qty: it.qty, uom: m.uom, plant: it.plant,
      storage_location: it.storage_location || (it.plant === 'DHN1' ? 'MS01' : 'WS01'), required_date: it.required_date, priority: it.priority || 'Normal',
      est_unit_price: it.est_unit_price ?? m.lpp ?? null, status: 'Released', ...(m.is_service ? { is_service: true } : {}),
    };
  });
  const prNo = nextSapNo('PR', 10045600);
  const payload = { pr_no: prNo, requisitioner_email: req.email, department: input.department || req.department, created_at: now(), items };
  sapPut('PR', prNo, payload, by(actor));
  audit(actor, { action: 'sapsim.pr_created', objectType: 'sapsim', objectId: `PR:${prNo}`, objectRef: prNo, after: { requisitioner: req.email, items: items.length } });
  return { pr_no: prNo, sync: syncNow('PR', prNo) };
}

export function listPrs() {
  return sapList<{ pr_no: string; requisitioner_email: string; department: string; created_at: string; items: { item: number; material_code: string; description: string; qty: number; uom: string; plant: string; required_date: string; priority: string; status: string }[] }>('PR')
    .slice(0, 60).map((d) => {
      const lines = all<{ item: number; id: number; status: string; buyer: string | null }>('SELECT l.item, l.id, l.status, u.name AS buyer FROM pr_lines l LEFT JOIN users u ON u.id = l.buyer_id WHERE l.pr_no = ?', d.doc_key);
      return { ...d.payload, pr_no: d.doc_key, changed_at: d.changed_at, items: (d.payload.items ?? []).map((i) => ({ ...i, platform: lines.find((l) => l.item === i.item) ?? null })) };
    });
}

// ---------------------------------------------------------------- purchase orders
interface PoItem { item: number; pr_no?: string | null; pr_item?: number | null; material_code: string; description: string; qty: number; uom: string; unit_price: number; gst_rate: number; freight?: number; delivery_date: string; deleted?: boolean }
interface PoPayload {
  po_no: string; vendor_sap_code: string; buyer_email: string | null; plant: string; po_date: string; released: boolean; version: number; delivery_terms: string | null;
  payment_terms: string | null; freight_terms?: string | null; oa_no?: string | null; urgency: string; rfq_id?: number | null; comparison_id?: number | null; rfq_date?: string | null;
  rfq_no?: string | null; cancelled?: boolean; amendment_id?: number | null; items: PoItem[];
}

const urgencyOf = (priority: string | null | undefined) => (priority === 'BD' || priority === 'Class 1' || priority === 'Urgent' ? priority : 'General stock');
const freightTerms = (delivery: string | null | undefined) => (/ex-?works/i.test(delivery ?? '') ? 'Freight to pay' : 'Freight paid');
const mustVendor = (vendorId: number) => {
  const v = get<{ id: number; sap_code: string | null; name: string; sap_blocked: number }>('SELECT id, sap_code, name, sap_blocked FROM vendors WHERE id = ?', vendorId);
  if (!v) throw badRequest('Vendor not found.', { vendor_id: 'Unknown vendor' });
  if (!v.sap_code) throw conflict(`${v.name} has no SAP vendor code yet. Create the vendor in SAP first (Vendors tab).`);
  if (v.sap_blocked) throw conflict(`${v.name} is blocked in SAP; no new POs can be created for this vendor.`);
  return v as { id: number; sap_code: string; name: string; sap_blocked: number };
};
const userEmail = (id: number | null | undefined) => (id ? get<{ email: string }>('SELECT email FROM users WHERE id = ?', id)?.email ?? null : null);

function putPo(actor: Actor, payload: PoPayload, action: string, extra: Record<string, unknown> = {}) {
  sapPut('PO', payload.po_no, payload, by(actor));
  audit(actor, { action, objectType: 'sapsim', objectId: `PO:${payload.po_no}`, objectRef: payload.po_no, after: { vendor: payload.vendor_sap_code, released: payload.released, version: payload.version, items: payload.items.length, ...extra } });
  return syncNow('PO', payload.po_no);
}

export interface PoInput {
  source: 'comparison' | 'pr_reference' | 'manual';
  comparison_id?: number; pr_line_ids?: number[]; vendor_id?: number; release?: boolean;
  plant?: string; buyer_id?: number; payment_terms?: string; delivery_terms?: string; urgency?: string; oa_no?: string;
  items?: { material_code: string; qty: number; unit_price: number; delivery_date: string; gst_rate?: number; freight?: number; pr_no?: string; pr_item?: number }[];
}

export function createPo(actor: Actor, input: PoInput) {
  const release = input.release !== false;
  if (input.source === 'comparison') return poFromComparison(actor, input.comparison_id, release);
  if (input.source === 'pr_reference') return poFromPrReference(actor, input.pr_line_ids ?? [], release);
  return poManual(actor, input, release);
}

interface Award { rfq_line_id: number; pr_line_id: number | null; vendor_id: number; delivery_days?: number; qty: number; unit_price: number; gst_rate: number; freight: number; landed_unit?: number; lowest?: boolean; reason?: string }

function poFromComparison(actor: Actor, comparisonId: number | undefined, release: boolean) {
  if (!comparisonId) throw badRequest('Choose a comparison released for PO.', { comparison_id: 'Required' });
  const c = get<{ id: number; cmp_no: string | null; rfq_id: number; status: string; awards: Award[] | null; created_by: number | null }>('SELECT id, cmp_no, rfq_id, status, awards_json, created_by FROM comparisons WHERE id = ?', comparisonId);
  if (!c) throw notFound('Comparison');
  if (c.status !== 'Released for PO') throw conflict(`Comparison ${c.cmp_no ?? c.id} is ${c.status.toLowerCase()}. Only an approved comparison in "Released for PO" can be turned into a PO.`);
  const awards = (c.awards ?? []).filter((a) => a.qty > 0);
  if (!awards.length) throw conflict('The comparison has no awarded lines.');
  const rfq = get<{ id: number; rfq_no: string; published_at: string | null; created_at: string | null; delivery_terms: string | null; payment_terms: string | null; plant: string | null }>('SELECT id, rfq_no, published_at, created_at, delivery_terms, payment_terms, plant FROM rfqs WHERE id = ?', c.rfq_id);
  if (!rfq) throw notFound('RFQ of the comparison');
  const done = new Set(sapList<PoPayload>('PO').filter((d) => d.payload.comparison_id === c.id && !d.payload.cancelled).map((d) => d.payload.vendor_sap_code));
  const byVendor = new Map<number, Award[]>();
  for (const a of awards) byVendor.set(a.vendor_id, [...(byVendor.get(a.vendor_id) ?? []), a]);
  const buyer = userEmail(c.created_by);
  const created: { po_no: string; vendor: string; sync: ReturnType<typeof syncNow> }[] = [];
  const skipped: string[] = [];
  for (const [vendorId, list] of byVendor) {
    const v = mustVendor(vendorId);
    if (done.has(v.sap_code)) { skipped.push(v.name); continue; }
    const q = get<{ payment_terms: string | null; credit_days: number | null; delivery_terms: string | null; lines: { rfq_line_id: number; delivery_days?: number }[] | null }>(
      'SELECT payment_terms, credit_days, delivery_terms, lines_json FROM quotations WHERE rfq_id = ? AND vendor_id = ?', c.rfq_id, vendorId,
    );
    let plant = rfq.plant ?? '';
    let urgency = 'General stock';
    const items: PoItem[] = list.map((a, i) => {
      const prl = a.pr_line_id ? getLine(a.pr_line_id) : undefined;
      const rl = get<{ material_id: number | null; description: string; uom: string; required_date: string | null; plant: string | null; gst_rate: number | null }>('SELECT material_id, description, uom, required_date, plant, gst_rate FROM rfq_lines WHERE id = ?', a.rfq_line_id);
      const mat = get<{ code: string; uom: string }>('SELECT code, uom FROM materials WHERE id = ?', prl?.material_id ?? rl?.material_id ?? -1);
      const ql = q?.lines?.find((l) => l.rfq_line_id === a.rfq_line_id);
      if (i === 0) { plant = prl?.plant ?? rl?.plant ?? plant; urgency = urgencyOf(prl?.priority); }
      return {
        item: (i + 1) * 10, pr_no: prl?.pr_no ?? null, pr_item: prl?.item ?? null, material_code: mat?.code ?? prl?.material_code ?? '',
        description: prl?.description ?? rl?.description ?? '', qty: a.qty, uom: prl?.uom ?? rl?.uom ?? mat?.uom ?? 'EA', unit_price: a.unit_price,
        gst_rate: a.gst_rate ?? rl?.gst_rate ?? 0, freight: a.freight ?? 0,
        delivery_date: (ql?.delivery_days ?? a.delivery_days) ? addDaysDate(today(), (ql?.delivery_days ?? a.delivery_days)!) : prl?.required_date ?? rl?.required_date ?? addDaysDate(today(), 14),
      };
    });
    const poNo = nextSapNo('PO', 4500022000);
    const delivery = q?.delivery_terms ?? rfq.delivery_terms;
    const payload: PoPayload = {
      po_no: poNo, vendor_sap_code: v.sap_code, buyer_email: buyer, plant, po_date: today(), released: release, version: 1,
      delivery_terms: delivery, payment_terms: q?.payment_terms ?? (q?.credit_days ? `${q.credit_days} days` : rfq.payment_terms), freight_terms: freightTerms(delivery),
      oa_no: null, urgency, rfq_id: rfq.id, comparison_id: c.id, rfq_date: (rfq.published_at ?? rfq.created_at ?? now()).slice(0, 10), rfq_no: rfq.rfq_no, items,
    };
    created.push({ po_no: poNo, vendor: v.name, sync: putPo(actor, payload, 'sapsim.po_created', { source: 'comparison', comparison_id: c.id }) });
  }
  if (!created.length) throw conflict(`POs already exist in SAP for every awarded vendor of this comparison (${skipped.join(', ')}).`);
  return { po_no: created[0].po_no, po_nos: created.map((x) => x.po_no), created, skipped, sync: created[0].sync };
}

function poFromPrReference(actor: Actor, ids: number[], release: boolean) {
  if (!ids.length) throw badRequest('Choose the PR line(s) to create the contract PO for.', { pr_line_ids: 'Required' });
  const groups = new Map<string, { ref: ReturnType<typeof poReference>; line: NonNullable<ReturnType<typeof getLine>> }[]>();
  for (const id of ids) {
    const line = getLine(id);
    if (!line) throw notFound('PR line');
    if (line.status !== 'Contract/VMI PO pending') throw conflict(`PR line ${line.pr_no}/${line.item} is ${line.status.toLowerCase()}; a contract PO can be created only while it is "Contract/VMI PO pending".`);
    const ref = poReference(id);
    if (!ref.valid) throw conflict(`${line.pr_no}/${line.item}: ${ref.message}`);
    const k = `${ref.vendor_sap_code}|${ref.sap_oa_no}|${ref.plant}`;
    groups.set(k, [...(groups.get(k) ?? []), { ref, line }]);
  }
  const created: { po_no: string; vendor: string; sync: ReturnType<typeof syncNow> }[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    const items: PoItem[] = list.map(({ ref, line }, i) => {
      const gst = get<{ gst_rate: number }>('SELECT gst_rate FROM materials WHERE id = ?', line.material_id ?? -1)?.gst_rate ?? 0;
      return { item: (i + 1) * 10, pr_no: line.pr_no, pr_item: line.item, material_code: ref.material_code, description: ref.description, qty: ref.qty, uom: ref.uom, unit_price: ref.unit_price ?? line.est_unit_price ?? 0, gst_rate: gst, freight: 0, delivery_date: ref.required_date };
    });
    const poNo = nextSapNo('PO', 4500022000);
    const payload: PoPayload = {
      po_no: poNo, vendor_sap_code: first.ref.vendor_sap_code, buyer_email: userEmail(first.line.buyer_id) ?? actor.email, plant: first.ref.plant, po_date: today(), released: release, version: 1,
      delivery_terms: first.ref.delivery_terms, payment_terms: first.ref.payment_terms, freight_terms: freightTerms(first.ref.delivery_terms), oa_no: first.ref.sap_oa_no,
      urgency: urgencyOf(first.line.priority), items,
    };
    created.push({ po_no: poNo, vendor: first.ref.vendor, sync: putPo(actor, payload, 'sapsim.po_created', { source: 'pr_reference', oa_no: first.ref.sap_oa_no, pr_lines: list.map((x) => x.line.id) }) });
  }
  return { po_no: created[0].po_no, po_nos: created.map((x) => x.po_no), created, skipped: [], sync: created[0].sync };
}

function poManual(actor: Actor, input: PoInput, release: boolean) {
  if (!input.vendor_id) throw badRequest('Choose the vendor.', { vendor_id: 'Required' });
  const v = mustVendor(input.vendor_id);
  const items = input.items ?? [];
  if (!items.length) throw badRequest('Add at least one PO item.', { items: 'Add an item' });
  if (!input.plant || !get('SELECT code FROM plants WHERE code = ?', input.plant)) throw badRequest('Choose the plant.', { plant: 'Required' });
  const buyerId = input.buyer_id ?? (actor.roles.includes('BUY') ? actor.id : null);
  const buyer = buyerId ? get<{ email: string; roles: string }>('SELECT email, roles FROM users WHERE id = ?', buyerId) : undefined;
  if (!buyer || !buyer.roles.split(',').includes('BUY')) throw badRequest('Choose the buyer responsible for this PO.', { buyer_id: 'Required' });
  if (input.oa_no && !sapGet('OA', input.oa_no)) throw badRequest(`Outline agreement ${input.oa_no} does not exist in SAP.`, { oa_no: 'Unknown OA' });
  let urgency = input.urgency ?? 'General stock';
  const poItems: PoItem[] = items.map((it, i) => {
    const m = get<{ code: string; description: string; uom: string; gst_rate: number }>('SELECT code, description, uom, gst_rate FROM materials WHERE code = ?', it.material_code);
    if (!m) throw badRequest(`Item ${i + 1}: material ${it.material_code} is not in the material master.`, { [`items.${i}.material_code`]: 'Unknown material' });
    if (!(it.qty > 0)) throw badRequest(`Item ${i + 1}: quantity must be more than zero.`, { [`items.${i}.qty`]: 'Must be > 0' });
    if (!(it.unit_price >= 0)) throw badRequest(`Item ${i + 1}: enter the unit price.`, { [`items.${i}.unit_price`]: 'Required' });
    if (!it.delivery_date) throw badRequest(`Item ${i + 1}: enter the delivery date.`, { [`items.${i}.delivery_date`]: 'Required' });
    let prNo = it.pr_no ?? null;
    let prItem = it.pr_item ?? null;
    if (prNo) {
      const l = get<{ id: number; priority: string }>('SELECT id, priority FROM pr_lines WHERE pr_no = ? AND item = ?', prNo, prItem);
      if (!l) throw badRequest(`Item ${i + 1}: PR line ${prNo}/${prItem} does not exist.`, { [`items.${i}.pr_no`]: 'Unknown PR line' });
      if (i === 0 && !input.urgency) urgency = urgencyOf(l.priority);
    } else { prNo = null; prItem = null; }
    return { item: (i + 1) * 10, pr_no: prNo, pr_item: prItem, material_code: m.code, description: m.description, qty: it.qty, uom: m.uom, unit_price: it.unit_price, gst_rate: it.gst_rate ?? m.gst_rate, freight: it.freight ?? 0, delivery_date: it.delivery_date };
  });
  const poNo = nextSapNo('PO', 4500022000);
  const payload: PoPayload = {
    po_no: poNo, vendor_sap_code: v.sap_code, buyer_email: buyer.email, plant: input.plant, po_date: today(), released: release, version: 1,
    delivery_terms: input.delivery_terms ?? 'FOR destination', payment_terms: input.payment_terms ?? '45 days from GRN', freight_terms: freightTerms(input.delivery_terms), oa_no: input.oa_no ?? null, urgency, items: poItems,
  };
  const sync = putPo(actor, payload, 'sapsim.po_created', { source: 'manual' });
  return { po_no: poNo, po_nos: [poNo], created: [{ po_no: poNo, vendor: v.name, sync }], skipped: [], sync };
}

function mustSapPo(poNo: string) {
  const d = sapGet<PoPayload>('PO', poNo);
  if (!d) throw notFound(`SAP PO ${poNo}`);
  return d.payload;
}

export function releasePo(actor: Actor, poNo: string) {
  const p = mustSapPo(poNo);
  if (p.cancelled) throw conflict(`PO ${poNo} is cancelled in SAP.`);
  if (p.released) throw conflict(`PO ${poNo} is already released.`);
  return { po_no: poNo, sync: putPo(actor, { ...p, released: true }, 'sapsim.po_released') };
}

export function changePo(actor: Actor, poNo: string, input: { changes: { item: number; qty?: number; unit_price?: number; delivery_date?: string; deleted?: boolean }[]; cancel?: boolean; amendment_id?: number; terms?: Record<string, string | null> }) {
  const p = mustSapPo(poNo);
  if (p.cancelled) throw conflict(`PO ${poNo} is already cancelled in SAP.`);
  if (!p.released) throw conflict(`Release PO ${poNo} before changing it.`);
  let amd: { id: number; status: string; type: string | null; amd_no: string | null } | undefined;
  if (input.amendment_id) {
    amd = get('SELECT a.id, a.status, a.type, a.amd_no FROM po_amendments a JOIN pos p ON p.id = a.po_id WHERE a.id = ? AND p.po_no = ?', input.amendment_id, poNo);
    if (!amd) throw badRequest(`Amendment ${input.amendment_id} does not belong to PO ${poNo}.`, { amendment_id: 'Not for this PO' });
    if (amd.status !== 'Approved') throw conflict(`Amendment ${amd.amd_no ?? amd.id} is ${amd.status.toLowerCase()}; only an approved amendment can be applied in SAP.`);
  }
  if (!input.cancel && !input.changes.length && !input.terms) throw badRequest('Enter at least one change, or cancel the PO.', { changes: 'Required' });
  const received = grnQtyByItem(poNo);
  const items = p.items.map((it) => ({ ...it }));
  for (const ch of input.changes) {
    const it = items.find((x) => x.item === ch.item);
    if (!it) throw badRequest(`PO ${poNo} has no item ${ch.item}.`, { changes: `Unknown item ${ch.item}` });
    const rec = received.get(ch.item) ?? 0;
    if (ch.deleted && rec > 0) throw conflict(`Item ${ch.item} already has ${rec} ${it.uom} received; it cannot be deleted.`);
    if (ch.qty !== undefined) {
      if (!(ch.qty > 0)) throw badRequest(`Item ${ch.item}: quantity must be more than zero (delete the item instead).`);
      if (ch.qty < rec) throw conflict(`Item ${ch.item}: quantity cannot go below the ${rec} ${it.uom} already received.`);
      it.qty = ch.qty;
    }
    if (ch.unit_price !== undefined) { if (!(ch.unit_price >= 0)) throw badRequest(`Item ${ch.item}: enter a valid unit price.`); it.unit_price = ch.unit_price; }
    if (ch.delivery_date) it.delivery_date = ch.delivery_date;
    if (ch.deleted) it.deleted = true;
  }
  if (input.cancel && [...received.values()].some((q) => q > 0)) throw conflict(`PO ${poNo} has goods receipts; cancel the open items individually instead of the whole PO.`);
  const termKeys = ['payment_terms', 'delivery_terms', 'freight_terms'] as const;
  const termPatch = Object.fromEntries(termKeys.filter((k) => input.terms && k in input.terms && input.terms[k] != null).map((k) => [k, input.terms![k]]));
  const payload: PoPayload = { ...p, ...termPatch, items, version: (p.version ?? 1) + 1, ...(input.cancel ? { cancelled: true } : {}), amendment_id: input.amendment_id ?? p.amendment_id ?? null };
  const sync = putPo(actor, payload, input.cancel ? 'sapsim.po_cancelled' : 'sapsim.po_changed', { changes: input.changes, terms: termPatch, amendment_id: input.amendment_id ?? null });
  // The approved amendment is now changed in SAP (FR-POM-09); the PO module republishes it from the synced version.
  if (amd) {
    const r = run("UPDATE po_amendments SET status = 'Changed in SAP', sap_changed_at = ? WHERE id = ? AND status = 'Approved'", now(), amd.id);
    if (r.changes) audit(actor, { action: 'po_amendment.changed_in_sap', objectType: 'po_amendment', objectId: amd.id, objectRef: amd.amd_no, before: { status: 'Approved' }, after: { status: 'Changed in SAP', sap_version: payload.version } });
  }
  return { po_no: poNo, version: payload.version, sync };
}

function grnQtyByItem(poNo: string) {
  const m = new Map<number, number>();
  for (const g of sapList<{ po_no: string; items: { po_item: number; qty: number }[] }>('GRN')) {
    if (g.payload.po_no !== poNo) continue;
    for (const it of g.payload.items ?? []) m.set(it.po_item, (m.get(it.po_item) ?? 0) + it.qty);
  }
  return m;
}

export function listPos(actor: Actor) {
  const docs = sapList<PoPayload>('PO');
  return docs.filter((d) => actor.plants === '*' || actor.plants.includes(d.payload.plant)).map((d) => {
    const p = d.payload;
    const rec = grnQtyByItem(d.doc_key);
    const vendor = get<{ id: number; name: string }>('SELECT id, name FROM vendors WHERE sap_code = ?', p.vendor_sap_code);
    const plat = get<{ id: number; status: string; version: number }>('SELECT id, status, version FROM pos WHERE po_no = ?', d.doc_key);
    return {
      po_no: d.doc_key, vendor_sap_code: p.vendor_sap_code, vendor_name: vendor?.name ?? null, vendor_id: vendor?.id ?? null, plant: p.plant, po_date: p.po_date,
      released: !!p.released, cancelled: !!p.cancelled, version: p.version ?? 1, urgency: p.urgency, oa_no: p.oa_no ?? null, comparison_id: p.comparison_id ?? null,
      buyer_email: p.buyer_email, delivery_terms: p.delivery_terms, payment_terms: p.payment_terms, changed_at: d.changed_at,
      value: Math.round(p.items.filter((i) => !i.deleted).reduce((s, i) => s + i.qty * i.unit_price, 0) * 100) / 100,
      items: p.items.map((i) => ({ ...i, received: rec.get(i.item) ?? 0, open: i.deleted ? 0 : Math.max(0, i.qty - (rec.get(i.item) ?? 0)) })),
      platform: plat ?? null,
    };
  });
}

export function poSources() {
  const comparisons = all<{ id: number; cmp_no: string | null; rfq_id: number; awards: Award[] | null; created_by: number | null; decided_at: string | null }>(
    "SELECT id, cmp_no, rfq_id, awards_json, created_by, decided_at FROM comparisons WHERE status = 'Released for PO' ORDER BY id DESC",
  ).map((c) => {
    const rfq = get<{ rfq_no: string; title: string | null }>('SELECT rfq_no, title FROM rfqs WHERE id = ?', c.rfq_id);
    const pos = sapList<PoPayload>('PO').filter((d) => d.payload.comparison_id === c.id && !d.payload.cancelled);
    const vendors = [...new Set((c.awards ?? []).map((a) => a.vendor_id))].map((vid) => {
      const v = get<{ id: number; name: string; sap_code: string | null }>('SELECT id, name, sap_code FROM vendors WHERE id = ?', vid);
      const lines = (c.awards ?? []).filter((a) => a.vendor_id === vid);
      return { vendor_id: vid, name: v?.name ?? `Vendor ${vid}`, sap_code: v?.sap_code ?? null, lines: lines.length, value: Math.round(lines.reduce((s, a) => s + a.qty * a.unit_price, 0)), po_no: pos.find((p) => p.payload.vendor_sap_code === v?.sap_code)?.doc_key ?? null };
    });
    return { id: c.id, cmp_no: c.cmp_no, rfq_id: c.rfq_id, rfq_no: rfq?.rfq_no ?? null, title: rfq?.title ?? null, buyer: userEmail(c.created_by), decided_at: c.decided_at, vendors, pending: vendors.filter((v) => !v.po_no).length };
  });
  const prLines = all<{ id: number; pr_no: string; item: number; description: string; qty: number; uom: string; plant: string; route: string; buyer: string | null; required_date: string }>(
    "SELECT l.id, l.pr_no, l.item, l.description, l.qty, l.uom, l.plant, l.route, u.name AS buyer, l.required_date FROM pr_lines l LEFT JOIN users u ON u.id = l.buyer_id WHERE l.status = 'Contract/VMI PO pending' ORDER BY l.id",
  ).map((l) => {
    try {
      const r = poReference(l.id);
      return { ...l, reference: r };
    } catch (e) {
      return { ...l, reference: null, problem: (e as Error).message };
    }
  });
  const amendments = all<{ id: number; amd_no: string | null; po_no: string; po_id: number; type: string | null; changes: unknown; reason: string | null; created_at: string }>(
    "SELECT a.id, a.amd_no, p.po_no, a.po_id, a.type, a.changes_json, a.reason, a.created_at FROM po_amendments a JOIN pos p ON p.id = a.po_id WHERE a.status = 'Approved' ORDER BY a.id",
  );
  return { comparisons, pr_lines: prLines, amendments };
}

// ---------------------------------------------------------------- GRN / SES
export function postGrn(actor: Actor, input: { po_no: string; items: { po_item: number; qty: number }[]; asn_id?: number | null; service?: boolean; posting_date?: string }) {
  const p = mustSapPo(input.po_no);
  if (!p.released) throw conflict(`PO ${input.po_no} is not released in SAP; goods cannot be received against it.`);
  if (p.cancelled) throw conflict(`PO ${input.po_no} is cancelled in SAP.`);
  if (actor.plants !== '*' && !actor.plants.includes(p.plant)) throw forbidden(`Your stores scope does not include plant ${p.plant}.`);
  const lines = input.items.filter((i) => i.qty > 0);
  if (!lines.length) throw badRequest('Enter a received quantity for at least one item.', { items: 'Enter a quantity' });
  const rec = grnQtyByItem(input.po_no);
  const items = lines.map((l) => {
    const it = p.items.find((x) => x.item === l.po_item && !x.deleted);
    if (!it) throw badRequest(`PO ${input.po_no} has no open item ${l.po_item}.`, { items: `Unknown item ${l.po_item}` });
    const open = it.qty - (rec.get(l.po_item) ?? 0);
    if (l.qty > open + 1e-9) throw badRequest(`Item ${l.po_item}: ${l.qty} ${it.uom} is more than the ${open} ${it.uom} still open on the PO. Receive at most the open quantity.`, { [`items.${l.po_item}`]: `Max ${open}` });
    return { po_item: l.po_item, qty: l.qty, value: Math.round(l.qty * it.unit_price * 100) / 100 };
  });
  if (input.asn_id) {
    const asn = get<{ id: number; po_id: number; status: string }>('SELECT a.id, a.po_id, a.status FROM asns a JOIN pos p ON p.id = a.po_id WHERE a.id = ? AND p.po_no = ?', input.asn_id, input.po_no);
    if (!asn) throw badRequest('The ASN does not belong to this PO.', { asn_id: 'Not for this PO' });
    if (['Cancelled', 'Delivered', 'Draft'].includes(asn.status)) throw conflict(`ASN is ${asn.status.toLowerCase()}; choose an ASN that is submitted or in transit.`);
  }
  const posting = input.posting_date ?? today();
  if (posting > today()) throw badRequest('The posting date cannot be in the future.', { posting_date: 'Future date' });
  const service = input.service ?? p.items.some((i) => !!get('SELECT id FROM materials WHERE code = ? AND is_service = 1', i.material_code));
  const grnNo = nextSapNo('GRN', 5000200000);
  const year = posting.slice(0, 4);
  const key = `${grnNo}-${year}`;
  const payload = { grn_no: grnNo, year, po_no: input.po_no, posting_date: posting, plant: p.plant, is_service: service, asn_id: input.asn_id ?? null, items };
  sapPut('GRN', key, payload, by(actor));
  audit(actor, { action: service ? 'sapsim.ses_posted' : 'sapsim.grn_posted', objectType: 'sapsim', objectId: `GRN:${key}`, objectRef: grnNo, after: { po_no: input.po_no, items, asn_id: input.asn_id ?? null } });
  return { grn_no: grnNo, doc_key: key, sync: syncNow('GRN', key) };
}

export function grnSources(actor: Actor) {
  const pos = listPos(actor).filter((p) => p.released && !p.cancelled && p.items.some((i) => i.open > 0));
  return pos.map((p) => ({
    ...p,
    asns: p.platform ? all<{ id: number; asn_no: string; status: string; expected_date: string | null; lines: unknown }>("SELECT id, asn_no, status, expected_date, lines_json FROM asns WHERE po_id = ? AND status IN ('Submitted','In transit') ORDER BY id", p.platform.id) : [],
  }));
}

// ---------------------------------------------------------------- invoices (INVSTATUS) — finance control
interface InvRow { id: number; inv_ref: string; vendor_id: number; po_id: number | null; status: string; total_value: number | null; taxable_value: number | null; approved_by: number | null; approved_at: string | null; invoice_date: string | null; dispute_hold: number; advance_adjusted: number | null; vendor_invoice_no: string | null; sap_doc_no: string | null }

function mustInvoice(ref: string) {
  const inv = get<InvRow>('SELECT * FROM invoices WHERE inv_ref = ?', ref);
  if (!inv) throw notFound(`Invoice ${ref}`);
  return inv;
}

/** FR-INV-19 / AC-INV-10: no parking or posting without finance approval, even in the simulator. */
export function financeControl(inv: InvRow) {
  const approver = inv.approved_by ? get<{ roles: string; name: string }>('SELECT roles, name FROM users WHERE id = ?', inv.approved_by) : undefined;
  if (!inv.approved_by || !inv.approved_at || !approver?.roles.split(',').includes('FIN')) {
    return `Invoice ${inv.inv_ref} has no finance approval. Finance must approve it (Matched, or exceptions approved) in the invoice review before it can be parked or posted in SAP.`;
  }
  const open = scalar<number>("SELECT COUNT(*) FROM invoice_exceptions WHERE invoice_id = ? AND status = 'Open'", inv.id) ?? 0;
  if (open) return `Invoice ${inv.inv_ref} still has ${open} open match exception${open === 1 ? '' : 's'}. Resolve or approve them before parking or posting.`;
  if (inv.dispute_hold) return `Invoice ${inv.inv_ref} is on dispute hold. Close the dispute or release the hold first.`;
  return null;
}

function invPayload(ref: string) {
  return (sapGet<Record<string, unknown>>('INVSTATUS', ref)?.payload ?? {}) as Record<string, unknown>;
}

function putInvoice(actor: Actor, inv: InvRow, patch: Record<string, unknown>, action: string, reason?: string) {
  const prev = invPayload(inv.inv_ref);
  const payload = { ...prev, inv_ref: inv.inv_ref, ...patch };
  sapPut('INVSTATUS', inv.inv_ref, payload, by(actor));
  audit(actor, { action, objectType: 'sapsim', objectId: `INVSTATUS:${inv.inv_ref}`, objectRef: inv.inv_ref, before: { status: prev.status ?? inv.status }, after: patch, reason: reason ?? null });
  return syncNow('INVSTATUS', inv.inv_ref);
}

function dueDateFor(inv: InvRow) {
  const po = inv.po_id ? get<{ po_no: string; payment_terms: string | null }>('SELECT po_no, payment_terms FROM pos WHERE id = ?', inv.po_id) : undefined;
  const terms = po?.payment_terms ?? '';
  const days = Number(/(\d+)\s*days?/i.exec(terms)?.[1] ?? cfg<number>('sapsim.default_payment_days'));
  let base = inv.invoice_date ?? today();
  let basis = 'invoice date';
  if (/grn|receipt/i.test(terms) && po) {
    const last = sapList<{ po_no: string; posting_date: string }>('GRN').filter((g) => g.payload.po_no === po.po_no).map((g) => g.payload.posting_date).sort().at(-1);
    if (last) { base = last; basis = 'last GRN'; }
  }
  return { due_date: addDaysDate(base, days), terms: terms || `${days} days (default)`, basis };
}

export function invoiceAction(actor: Actor, ref: string, action: 'park' | 'post' | 'pay' | 'block' | 'unblock', body: Record<string, any> = {}) {
  const inv = mustInvoice(ref);
  const ts = now();
  if (action === 'park' || action === 'post') {
    const refusal = financeControl(inv);
    if (refusal) {
      audit(actor, { action: `sapsim.invoice_${action}_refused`, objectType: 'sapsim', objectId: `INVSTATUS:${ref}`, objectRef: ref, after: { status: inv.status }, reason: refusal });
      throw conflict(refusal);
    }
  }
  if (action === 'park') {
    if (!['Matched', 'Exception'].includes(inv.status)) throw conflict(`Invoice ${ref} is ${inv.status.toLowerCase()}; only an approved matched invoice can be parked.`);
    const docNo = inv.sap_doc_no ?? nextSapNo('INVDOC', 5105600000);
    return { inv_ref: ref, sap_doc_no: docNo, sync: putInvoice(actor, inv, { status: 'Parked', sap_doc_no: docNo, parked_at: ts }, 'sapsim.invoice_parked') };
  }
  if (action === 'post') {
    if (!['Matched', 'Exception', 'Parked'].includes(inv.status)) throw conflict(`Invoice ${ref} is ${inv.status.toLowerCase()}; it cannot be posted.`);
    const docNo = inv.sap_doc_no ?? nextSapNo('INVDOC', 5105600000);
    const due = dueDateFor(inv);
    return { inv_ref: ref, sap_doc_no: docNo, ...due, sync: putInvoice(actor, inv, { status: 'Posted', sap_doc_no: docNo, posted_at: ts, due_date: due.due_date }, 'sapsim.invoice_posted') };
  }
  if (action === 'pay') {
    if (!['Posted', 'Payment due'].includes(inv.status)) throw conflict(`Invoice ${ref} is ${inv.status.toLowerCase()}; only a posted invoice without a payment block can be paid.`);
    const gross = inv.total_value ?? 0;
    const deductions = (body.deductions ?? []) as { label: string; amount: number }[];
    const tds = body.tds as number | undefined;
    const retention = body.retention as number | undefined;
    const adv = (body.advance_adjusted as number | undefined) ?? inv.advance_adjusted ?? undefined;
    const net = Math.round((gross - (tds ?? 0) - deductions.reduce((s, d) => s + d.amount, 0) - (retention ?? 0) - (adv ?? 0)) * 100) / 100;
    if (net < 0) throw badRequest(`TDS, deductions, retention and advance adjustment (${gross - net}) exceed the invoice total ${gross}.`, { tds: 'Too high' });
    const paymentRef = (body.payment_ref as string | undefined)?.trim() || nextSapNo('PAY', 1500004000);
    const vendor = get<{ bank_name: string | null; bank_account_masked: string | null }>('SELECT bank_name, bank_account_masked FROM vendors WHERE id = ?', inv.vendor_id);
    const advice = { payment_ref: paymentRef, payment_date: today(), gross, ...(tds !== undefined ? { tds } : {}), deductions, ...(retention !== undefined ? { retention } : {}), ...(adv !== undefined ? { advance_adjusted: adv } : {}), net_paid: net, bank: vendor ? `${vendor.bank_name ?? ''} ${vendor.bank_account_masked ?? ''}`.trim() : null, sap_doc_no: inv.sap_doc_no };
    const sync = putInvoice(actor, inv, {
      status: 'Payment released', paid_at: ts, payment_ref: paymentRef, ...(tds !== undefined ? { tds } : {}), ...(retention !== undefined ? { retention } : {}),
      ...(deductions.length ? { deductions } : {}), ...(adv !== undefined ? { advance_adjusted: adv } : {}), payment_advice: advice,
    }, 'sapsim.invoice_paid');
    return { inv_ref: ref, payment_ref: paymentRef, net_paid: net, sync };
  }
  if (action === 'block') {
    if (!['Posted', 'Payment due'].includes(inv.status)) throw conflict(`Invoice ${ref} is ${inv.status.toLowerCase()}; only a posted invoice can be blocked for payment.`);
    const internal = String(body.reason_internal ?? '').trim();
    const vendorReason = String(body.vendor_reason ?? '').trim();
    if (internal.length < 10) throw badRequest('Enter the internal block reason (at least 10 characters).', { reason_internal: 'At least 10 characters' });
    if (vendorReason.length < 5) throw badRequest('Enter the vendor-safe reason the vendor will see (at least 5 characters).', { vendor_reason: 'Required' });
    return { inv_ref: ref, sync: putInvoice(actor, inv, { status: 'Payment blocked', block_reason: internal, vendor_reason: vendorReason }, 'sapsim.invoice_payment_blocked', internal) };
  }
  if (inv.status !== 'Payment blocked') throw conflict(`Invoice ${ref} is not blocked for payment.`);
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 10) throw badRequest('Enter why the payment block is removed (at least 10 characters).', { reason: 'At least 10 characters' });
  return { inv_ref: ref, sync: putInvoice(actor, inv, { status: 'Posted', block_reason: '', vendor_reason: '' }, 'sapsim.invoice_payment_unblocked', reason) };
}

export function listInvoices() {
  return all<InvRow & { vendor_name: string; po_no: string | null; approved_by_name: string | null; open_exceptions: number }>(
    `SELECT i.*, v.name AS vendor_name, p.po_no, u.name AS approved_by_name,
            (SELECT COUNT(*) FROM invoice_exceptions e WHERE e.invoice_id = i.id AND e.status = 'Open') AS open_exceptions
     FROM invoices i JOIN vendors v ON v.id = i.vendor_id LEFT JOIN pos p ON p.id = i.po_id LEFT JOIN users u ON u.id = i.approved_by
     WHERE i.status NOT IN ('Rejected') ORDER BY i.id DESC LIMIT 300`,
  ).map(({ extracted: _x, match: _m, payment_advice: _p, ...i }: any) => ({ ...i, finance_block:['Matched', 'Exception', 'Parked'].includes(i.status) ? financeControl(i) : null, sap: sapGet('INVSTATUS', i.inv_ref)?.payload ?? null }));
}

// ---------------------------------------------------------------- advances (ADVPAY)
function mustAdvance(no: string) {
  const a = get<{ id: number; adv_no: string; amount: number; status: string; vendor_id: number | null; adjusted_amount: number }>('SELECT * FROM advances WHERE adv_no = ?', no);
  if (!a) throw notFound(`Advance ${no}`);
  return a;
}

export function payAdvance(actor: Actor, advNo: string, body: { amount?: number }) {
  const a = mustAdvance(advNo);
  if (a.status !== 'Approved') throw conflict(`Advance ${advNo} is ${a.status.toLowerCase()}; only an approved advance can be paid in SAP.`);
  const amount = body.amount ?? a.amount;
  if (!(amount > 0) || amount > a.amount) throw badRequest(`Pay between ₹1 and the approved ₹${a.amount}.`, { amount: `Max ${a.amount}` });
  const sapDoc = nextSapNo('ADV', 1700000500);
  const payload = { adv_no: advNo, sap_doc: sapDoc, paid_date: today(), amount_paid: amount, adjusted_amount: 0 };
  sapPut('ADVPAY', advNo, payload, by(actor));
  audit(actor, { action: 'sapsim.advance_paid', objectType: 'sapsim', objectId: `ADVPAY:${advNo}`, objectRef: advNo, after: payload });
  return { adv_no: advNo, sap_doc: sapDoc, sync: syncNow('ADVPAY', advNo) };
}

export function adjustAdvance(actor: Actor, advNo: string, body: { amount: number }) {
  const a = mustAdvance(advNo);
  if (!['Paid', 'Partially adjusted'].includes(a.status)) throw conflict(`Advance ${advNo} is ${a.status.toLowerCase()}; only a paid advance can be adjusted.`);
  const prev = sapGet<{ sap_doc: string; paid_date: string; amount_paid?: number; adjusted_amount?: number }>('ADVPAY', advNo)?.payload;
  if (!prev) throw conflict(`SAP has no payment document for advance ${advNo}.`);
  const total = (prev.adjusted_amount ?? 0) + body.amount;
  if (!(body.amount > 0)) throw badRequest('Enter the amount to adjust.', { amount: 'Must be > 0' });
  if (total > a.amount + 1e-9) throw badRequest(`Only ₹${a.amount - (prev.adjusted_amount ?? 0)} of the advance is still unadjusted.`, { amount: `Max ${a.amount - (prev.adjusted_amount ?? 0)}` });
  const payload = { ...prev, adjusted_amount: total, last_adjusted: today() };
  sapPut('ADVPAY', advNo, payload, by(actor));
  audit(actor, { action: 'sapsim.advance_adjusted', objectType: 'sapsim', objectId: `ADVPAY:${advNo}`, objectRef: advNo, before: { adjusted_amount: prev.adjusted_amount ?? 0 }, after: { adjusted_amount: total } });
  return { adv_no: advNo, adjusted_amount: total, sync: syncNow('ADVPAY', advNo) };
}

export function listAdvances() {
  return all<{ id: number; adv_no: string; amount: number; status: string; vendor_name: string | null; po_no: string | null; adjusted_amount: number; paid_date: string | null; sap_doc: string | null; created_at: string }>(
    `SELECT a.*, v.name AS vendor_name, p.po_no FROM advances a LEFT JOIN vendors v ON v.id = a.vendor_id LEFT JOIN pos p ON p.id = a.po_id
     WHERE a.status IN ('Approved','Paid','Partially adjusted','Fully adjusted') ORDER BY a.id DESC`,
  );
}

// ---------------------------------------------------------------- vendors (VENDOR)
const mask = (acct: string) => `${'X'.repeat(Math.max(4, acct.length - 4))}${acct.slice(-4)}`;

export function createVendor(actor: Actor, vendorId: number) {
  const v = get<{ id: number; name: string; legal_name: string | null; pan: string | null; gstin: string | null; msme_no: string | null; msme_category: string | null; address: string | null; city: string | null; state: string | null; bank_name: string | null; bank_account_masked: string | null; bank_ifsc: string | null; sap_code: string | null; onboarding_status: string }>(
    'SELECT * FROM vendors WHERE id = ?', vendorId,
  );
  if (!v) throw notFound('Vendor');
  if (v.sap_code) throw conflict(`${v.name} already has SAP vendor code ${v.sap_code}.`);
  if (v.onboarding_status !== 'Pending SAP code') throw conflict(`${v.name} is ${v.onboarding_status.toLowerCase()}. The SAP vendor is created only after onboarding is approved (status "Pending SAP code").`);
  if (!v.pan && !v.gstin) throw conflict('The vendor needs a PAN or GSTIN before SAP can create the vendor master.');
  const code = nextSapNo('VENDOR', 100200);
  const payload = { sap_code: code, name: v.name, legal_name: v.legal_name ?? v.name, pan: v.pan, gstin: v.gstin, msme_no: v.msme_no, msme_category: v.msme_category, address: v.address, city: v.city, state: v.state, bank_name: v.bank_name, bank_account_masked: v.bank_account_masked, bank_ifsc: v.bank_ifsc, blocked: false };
  sapPut('VENDOR', code, payload, by(actor));
  audit(actor, { action: 'sapsim.vendor_created', objectType: 'sapsim', objectId: `VENDOR:${code}`, objectRef: code, after: { vendor_id: v.id, name: v.name } });
  return { sap_code: code, sync: syncNow('VENDOR', code) };
}

export function applyBankChange(actor: Actor, vendorId: number, changeRequestId: number) {
  const v = get<{ id: number; name: string; sap_code: string | null }>('SELECT id, name, sap_code FROM vendors WHERE id = ?', vendorId);
  if (!v) throw notFound('Vendor');
  if (!v.sap_code) throw conflict(`${v.name} has no SAP vendor code.`);
  const cr = get<{ id: number; vendor_id: number; field: string; new_value: string | null; status: string }>('SELECT * FROM vendor_change_requests WHERE id = ?', changeRequestId);
  if (!cr || cr.vendor_id !== vendorId) throw badRequest('This change request does not belong to the vendor.', { change_request_id: 'Not for this vendor' });
  if (cr.field !== 'bank_account') throw badRequest('Only bank account changes are applied here.', { change_request_id: 'Not a bank change' });
  if (!['Approved', 'Sent to SAP'].includes(cr.status)) throw conflict(`The bank change is ${cr.status.toLowerCase()}. Finance must approve it before SAP applies it (AC-VPT-04).`);
  let account = cr.new_value ?? '';
  let extra: Record<string, unknown> = {};
  try {
    const j = JSON.parse(account);
    if (j && typeof j === 'object') { account = String(j.account_no ?? j.account ?? j.bank_account ?? ''); extra = { ...(j.bank_name ? { bank_name: j.bank_name } : {}), ...(j.ifsc || j.bank_ifsc ? { bank_ifsc: j.ifsc ?? j.bank_ifsc } : {}) }; }
  } catch { /* plain account number */ }
  account = account.replace(/\s/g, '');
  if (account.length < 4) throw conflict('The change request has no usable account number.');
  if (cr.status === 'Approved') {
    update('vendor_change_requests', cr.id, { status: 'Sent to SAP' });
    audit(actor, { action: 'vendor_change.sent_to_sap', objectType: 'vendor_change', objectId: cr.id, before: { status: 'Approved' }, after: { status: 'Sent to SAP' } });
  }
  const prev = sapGet<Record<string, unknown>>('VENDOR', v.sap_code)?.payload ?? {};
  const payload = { ...prev, bank_account_masked: mask(account), ...extra };
  sapPut('VENDOR', v.sap_code, payload, by(actor));
  audit(actor, { action: 'sapsim.vendor_bank_changed', objectType: 'sapsim', objectId: `VENDOR:${v.sap_code}`, objectRef: v.sap_code, before: { bank_account_masked: prev.bank_account_masked ?? null }, after: { bank_account_masked: payload.bank_account_masked, change_request_id: cr.id } });
  const sync = syncNow('VENDOR', v.sap_code);
  const after = get<{ status: string }>('SELECT status FROM vendor_change_requests WHERE id = ?', cr.id);
  return { sap_code: v.sap_code, change_request_status: after?.status ?? null, sync };
}

export function vendorSources() {
  const pending = all<{ id: number; name: string; pan: string | null; gstin: string | null; city: string | null; onboarding_status: string; created_at: string | null }>(
    "SELECT id, name, pan, gstin, city, onboarding_status, created_at FROM vendors WHERE sap_code IS NULL AND onboarding_status IN ('Pending SAP code','Approved','Under review','Submitted') ORDER BY onboarding_status = 'Pending SAP code' DESC, id",
  );
  const bank = all<{ id: number; vendor_id: number; vendor_name: string; sap_code: string | null; old_value: string | null; new_value: string | null; status: string; created_at: string; decided_at: string | null }>(
    "SELECT c.id, c.vendor_id, v.name AS vendor_name, v.sap_code, c.old_value, c.new_value, c.status, c.created_at, c.decided_at FROM vendor_change_requests c JOIN vendors v ON v.id = c.vendor_id WHERE c.field = 'bank_account' AND c.status IN ('Approved','Sent to SAP','Pending') ORDER BY c.id DESC",
  ).map((c) => ({ ...c, new_value_masked: c.new_value ? mask(String(c.new_value).replace(/[^0-9A-Za-z]/g, '').slice(-12)) : null, new_value: undefined }));
  return { pending, bank };
}

// ---------------------------------------------------------------- outline agreements (OA)
export function createOa(actor: Actor, contractId: number) {
  const c = get<{ id: number; contract_no: string; type: string; vendor_id: number; title: string | null; category: string | null; plant: string | null; sap_oa_no: string | null; valid_from: string | null; valid_to: string | null; status: string; value_cap: number | null; payment_terms: string | null; delivery_terms: string | null; discount_pct: number | null }>(
    'SELECT * FROM contracts WHERE id = ?', contractId,
  );
  if (!c) throw notFound('Contract');
  if (c.sap_oa_no) throw conflict(`${c.contract_no} is already linked to SAP OA ${c.sap_oa_no}.`);
  if (c.status !== 'Pending SAP') throw conflict(`${c.contract_no} is ${c.status.toLowerCase()}. The SAP outline agreement is created only after approval (status "Pending SAP").`);
  if (!c.valid_from || !c.valid_to) throw conflict(`${c.contract_no} needs validity dates before SAP can create the outline agreement.`);
  const v = mustVendor(c.vendor_id);
  const items = all<{ code: string; unit_price: number | null; qty_cap: number | null; uom: string | null; discount_pct: number | null }>(
    'SELECT m.code, ci.unit_price, ci.qty_cap, ci.uom, ci.discount_pct FROM contract_items ci JOIN materials m ON m.id = ci.material_id WHERE ci.contract_id = ?', c.id,
  );
  if (!items.length) throw conflict(`${c.contract_no} has no material lines; add the scope before creating the SAP outline agreement.`);
  const oaNo = nextSapNo('OA', 5500000200);
  const payload = {
    type: c.type, title: c.title ?? c.contract_no, category: c.category, plant: c.plant ?? '*', vendor_sap_code: v.sap_code, valid_from: c.valid_from, valid_to: c.valid_to,
    value_cap: c.value_cap, consumed_value: 0, payment_terms: c.payment_terms, delivery_terms: c.delivery_terms, platform_ref: c.contract_no,
    items: items.map((i) => ({ material_code: i.code, unit_price: i.unit_price, qty_cap: i.qty_cap, consumed_qty: 0, uom: i.uom, discount_pct: i.discount_pct ?? c.discount_pct ?? null })),
  };
  sapPut('OA', oaNo, payload, by(actor));
  audit(actor, { action: 'sapsim.oa_created', objectType: 'sapsim', objectId: `OA:${oaNo}`, objectRef: oaNo, after: { contract_no: c.contract_no, vendor: v.sap_code, items: items.length } });
  return { oa_no: oaNo, sync: syncNow('OA', oaNo) };
}

export function oaSources() {
  return all<{ id: number; contract_no: string; type: string; title: string | null; vendor_name: string; sap_code: string | null; valid_from: string | null; valid_to: string | null; value_cap: number | null; items: number }>(
    `SELECT c.id, c.contract_no, c.type, c.title, v.name AS vendor_name, v.sap_code, c.valid_from, c.valid_to, c.value_cap,
            (SELECT COUNT(*) FROM contract_items ci WHERE ci.contract_id = c.id) AS items
     FROM contracts c JOIN vendors v ON v.id = c.vendor_id WHERE c.status = 'Pending SAP' AND c.sap_oa_no IS NULL ORDER BY c.id`,
  );
}

// ---------------------------------------------------------------- stock (STOCK)
export function setStock(actor: Actor, input: { material_code: string; plant: string; unrestricted: number }) {
  if (!get('SELECT id FROM materials WHERE code = ?', input.material_code)) throw badRequest(`Material ${input.material_code} is not in the material master.`, { material_code: 'Unknown material' });
  if (!get('SELECT code FROM plants WHERE code = ?', input.plant)) throw badRequest('Choose a valid plant.', { plant: 'Unknown plant' });
  if (actor.plants !== '*' && !actor.plants.includes(input.plant)) throw forbidden(`Your stores scope does not include plant ${input.plant}.`);
  if (!(input.unrestricted >= 0)) throw badRequest('Unrestricted stock cannot be negative.', { unrestricted: 'Must be ≥ 0' });
  const key = `${input.material_code}|${input.plant}`;
  const prev = sapGet<{ unrestricted: number; open_po_qty: number; vmi: boolean }>('STOCK', key)?.payload;
  const payload = { material_code: input.material_code, plant: input.plant, unrestricted: input.unrestricted, open_po_qty: prev?.open_po_qty ?? 0, vmi: prev?.vmi ?? false };
  sapPut('STOCK', key, payload, by(actor));
  audit(actor, { action: 'sapsim.stock_set', objectType: 'sapsim', objectId: `STOCK:${key}`, objectRef: key, before: { unrestricted: prev?.unrestricted ?? null }, after: { unrestricted: input.unrestricted } });
  return { key, sync: syncNow('STOCK', key) };
}

export function listStock(actor: Actor) {
  return sapList<{ material_code: string; plant: string; unrestricted: number; open_po_qty: number; vmi: boolean }>('STOCK')
    .filter((d) => actor.plants === '*' || actor.plants.includes(d.payload.plant))
    .map((d) => ({ key: d.doc_key, ...d.payload, changed_at: d.changed_at, description: get<{ description: string; uom: string }>('SELECT description, uom FROM materials WHERE code = ?', d.payload.material_code) ?? null }));
}

// ---------------------------------------------------------------- outage & failure injection
export const OUTBOUND_FLOWS = FLOWS.filter((f) => f.direction !== 'SAP → S2P').map((f) => f.id);
export const FAIL_MODES = ['transient', 'business', 'timeout_after_commit'] as const;

export function getSettings() {
  const s = simSettings();
  return {
    ...s, fail: Object.fromEntries(OUTBOUND_FLOWS.map((f) => [f, s.fail[f] ?? null])),
    outbound_flows: FLOWS.filter((f) => OUTBOUND_FLOWS.includes(f.id)).map((f) => ({ id: f.id, name: f.name, direction: f.direction })),
    modes: FAIL_MODES,
  };
}

export function putSettings(actor: Actor, input: { offline?: boolean; fail?: Record<string, (typeof FAIL_MODES)[number] | null> }) {
  const before = simSettings();
  const next: SimSettings = { offline: input.offline ?? before.offline, fail: { ...before.fail } };
  for (const [flow, mode] of Object.entries(input.fail ?? {})) {
    if (!OUTBOUND_FLOWS.includes(flow)) throw badRequest(`${flow} is not an outbound flow; failure injection applies to S2P → SAP writes only.`, { fail: `Unknown flow ${flow}` });
    next.fail[flow] = mode ?? null;
  }
  setSimSettings(next);
  audit(actor, { action: 'sapsim.settings_changed', objectType: 'sapsim', objectId: 'settings', before, after: next });
  let recovery: { queue: ReturnType<typeof processQueue>; inbound: { docType: string; status: string; upserted: number; errors: number }[]; cleared: number } | null = null;
  if (before.offline && !next.offline) {
    // SAP is back: process the queued writes and catch up the inbound flows now (AC-SAP-05, FR-SAP-12).
    const queue = processQueue(actor);
    const inbound = runAllInbound('manual', null).map((r) => ({ docType: r.docType, status: r.status, upserted: r.upserted, errors: r.errors }));
    recovery = { queue, inbound, cleared: resolveRecoveredPulls() };
    notify({ event: 'NTF-32', title: 'SAP connection restored (simulated)', body: queue.message, link: '/integration', roles: ['SAP'], severity: 'success', dedupeKey: `NTF-32:online:${now()}` });
  } else if (!before.offline && next.offline) {
    notify({ event: 'NTF-32', title: 'SAP is unavailable (simulated outage)', body: 'Inbound syncs fail and outbound writes are queued until SAP returns.', link: '/integration', roles: ['SAP'], severity: 'danger', dedupeKey: `NTF-32:offline:${now()}` });
  }
  return { settings: getSettings(), recovery };
}

export { OUTBOUND_FLOWS as outboundFlows };
