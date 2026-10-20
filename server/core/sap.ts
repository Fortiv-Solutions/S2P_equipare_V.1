/**
 * SAP integration adapter (Module 12) and the SAP SIMULATOR used by this MVP.
 *
 * No live SAP system is connected (DEC-17 open). `sap_documents` stands in for the SAP quality
 * system: simulator actions write there, and inbound flows copy changes into platform tables by
 * SAP key (FR-SAP-04). Business modules never read `sap_documents` (FR-SAP-02).
 *
 * Outbound writes carry an idempotency key (FR-SAP-03); failures go to an error queue with
 * back-off retry for transient errors and no retry for business errors (FR-SAP-05).
 */
import { all, get, insert, update, run, J, now, tx, scalar } from './db.ts';
import { audit } from './audit.ts';
import { notify } from './notify.ts';
import { cfg } from './config.ts';
import type { Actor } from './auth.ts';
import { SINGLE_USER, ADMIN_EMAIL } from './mode.ts';

export interface FlowDef {
  id: string;
  name: string;
  direction: 'SAP → S2P' | 'S2P → SAP' | 'SAP ↔ S2P';
  docType?: string;
  trigger: string;
  mechanism: string;
  write: 'No' | 'Open';
  decision?: string;
  release: string;
}

export const FLOWS: FlowDef[] = [
  { id: 'INT-M01', name: 'Vendor master', direction: 'SAP → S2P', docType: 'VENDOR', trigger: 'Scheduled / event', mechanism: 'OData / BAPI read (simulated)', write: 'No', release: 'R1' },
  { id: 'INT-M02', name: 'Material / service master', direction: 'SAP → S2P', docType: 'MATERIAL', trigger: 'Scheduled', mechanism: 'OData / BAPI read (simulated)', write: 'No', release: 'R1' },
  { id: 'INT-M03', name: 'Purchase requisitions', direction: 'SAP → S2P', docType: 'PR', trigger: 'Scheduled / event', mechanism: 'OData / BAPI delta read (simulated)', write: 'No', release: 'R1/R2' },
  { id: 'INT-M04', name: 'Stock / open PO / VMI', direction: 'SAP → S2P', docType: 'STOCK', trigger: 'Scheduled', mechanism: 'OData / BAPI read (simulated)', write: 'No', release: 'R2' },
  { id: 'INT-M05', name: 'RFQ / quotation reference', direction: 'S2P → SAP', docType: 'RFQREF', trigger: 'As designed', mechanism: 'Reference only until DEC-04', write: 'Open', decision: 'DEC-04', release: 'R2' },
  { id: 'INT-M06', name: 'Contract / ARC / OA', direction: 'SAP ↔ S2P', docType: 'OA', trigger: 'Scheduled / event', mechanism: 'OData / BAPI read (simulated); write needs DEC-03', write: 'Open', decision: 'DEC-03', release: 'R3' },
  { id: 'INT-M07', name: 'Purchase orders', direction: 'SAP → S2P', docType: 'PO', trigger: 'Event / scheduled', mechanism: 'Released POs via OData / BAPI (simulated)', write: 'No', release: 'R1' },
  { id: 'INT-M08', name: 'PO acknowledgement', direction: 'S2P → SAP', docType: 'POACK', trigger: 'Event', mechanism: 'SAP confirmation or Z-table per DEC-25 (simulated)', write: 'Open', decision: 'DEC-25', release: 'R1' },
  { id: 'INT-M09', name: 'ASN / dispatch', direction: 'S2P → SAP', docType: 'ASN', trigger: 'Event', mechanism: 'Kept in platform with PO reference', write: 'Open', release: 'R1' },
  { id: 'INT-M10', name: 'GRN / SES', direction: 'SAP → S2P', docType: 'GRN', trigger: 'Scheduled / event', mechanism: 'Material & service documents via OData / BAPI (simulated)', write: 'No', release: 'R1' },
  { id: 'INT-M11', name: 'Invoice parking', direction: 'S2P → SAP', docType: 'PARK', trigger: 'After validation', mechanism: 'Approved BAPI/OData only if DEC-06 (simulated)', write: 'Open', decision: 'DEC-06', release: 'R4' },
  { id: 'INT-M12', name: 'Invoice / payment status', direction: 'SAP → S2P', docType: 'INVSTATUS', trigger: 'Scheduled', mechanism: 'Accounting / clearing status via OData / BAPI (simulated)', write: 'No', release: 'R1/R4' },
];

const INBOUND = FLOWS.filter((f) => f.direction !== 'S2P → SAP' && f.docType);
export const flowByDoc = (docType: string) => FLOWS.find((f) => f.docType === docType);

// ---------------------------------------------------------------- simulator settings
export interface SimSettings {
  offline: boolean;
  fail: Record<string, 'transient' | 'business' | 'timeout_after_commit' | null>;
}
export function simSettings(): SimSettings {
  const row = get<{ value: SimSettings }>("SELECT value_json FROM sap_sim_settings WHERE key = 'settings'");
  return row?.value ?? { offline: false, fail: {} };
}
export function setSimSettings(s: SimSettings) {
  run("INSERT INTO sap_sim_settings (key, value_json) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", J(s));
}

/** Write a document into the simulated SAP system. */
export function sapPut(docType: string, key: string, payload: unknown, by = 'SAP simulator') {
  run(
    `INSERT INTO sap_documents (doc_type, doc_key, payload_json, changed_at, deleted, created_by) VALUES (?,?,?,?,0,?)
     ON CONFLICT(doc_type, doc_key) DO UPDATE SET payload_json = excluded.payload_json, changed_at = excluded.changed_at, deleted = 0`,
    docType, key, J(payload), now(), by,
  );
}
export function sapGet<T = Record<string, unknown>>(docType: string, key: string) {
  return get<{ payload: T; changed_at: string }>('SELECT payload_json, changed_at FROM sap_documents WHERE doc_type = ? AND doc_key = ?', docType, key);
}
export function sapList<T = Record<string, unknown>>(docType: string) {
  return all<{ doc_key: string; payload: T; changed_at: string }>('SELECT doc_key, payload_json, changed_at FROM sap_documents WHERE doc_type = ? ORDER BY changed_at DESC', docType);
}

// ---------------------------------------------------------------- sync hooks
type SyncHook = (ids: { id: number; isNew: boolean; payload: any }[]) => void;
const hooks = new Map<string, SyncHook[]>();
/** Modules react to synchronised records (e.g. buyer assignment for new PR lines). */
export function onSynced(docType: string, fn: SyncHook) {
  hooks.set(docType, [...(hooks.get(docType) ?? []), fn]);
}

// ---------------------------------------------------------------- inbound mappers
type Mapper = (key: string, p: any, deleted: boolean) => { id: number; isNew: boolean }[];

const vendorIdBySap = (code: string | null | undefined) =>
  code ? get<{ id: number }>('SELECT id FROM vendors WHERE sap_code = ?', code)?.id ?? null : null;
const materialIdByCode = (code: string | null | undefined) =>
  code ? get<{ id: number }>('SELECT id FROM materials WHERE code = ?', code)?.id ?? null : null;
const userIdByEmail = (email: string | null | undefined) => {
  if (!email) return null;
  const id = get<{ id: number }>('SELECT id FROM users WHERE email = ?', email)?.id;
  if (id) return id;
  // Single-user mode: every buyer and requisitioner named by SAP is the one Administrator.
  return SINGLE_USER ? get<{ id: number }>('SELECT id FROM users WHERE email = ?', ADMIN_EMAIL)?.id ?? null : null;
};

const MAPPERS: Record<string, Mapper> = {
  VENDOR: (key, p) => {
    const ts = now();
    let v = get<{ id: number }>('SELECT id FROM vendors WHERE sap_code = ?', key);
    let isNew = false;
    if (!v && (p.pan || p.gstin)) {
      // Onboarded vendor waiting for its SAP code: link by PAN/GSTIN.
      v = get<{ id: number }>("SELECT id FROM vendors WHERE sap_code IS NULL AND (pan = ? OR gstin = ?)", p.pan ?? '', p.gstin ?? '');
      if (v) update('vendors', v.id, { sap_code: key, onboarding_status: 'Active' });
    }
    const fields = {
      name: p.name, legal_name: p.legal_name ?? p.name, pan: p.pan, gstin: p.gstin, msme_no: p.msme_no ?? null,
      msme_category: p.msme_category ?? null, address: p.address ?? null, city: p.city ?? null, state: p.state ?? null,
      bank_name: p.bank_name ?? null, bank_account_masked: p.bank_account_masked ?? null, bank_ifsc: p.bank_ifsc ?? null,
      sap_blocked: p.blocked ? 1 : 0, synced_at: ts,
    };
    if (v) update('vendors', v.id, fields);
    else {
      isNew = true;
      v = { id: insert('vendors', { sap_code: key, ...fields, onboarding_status: 'Active', portal_status: 'Not invited', created_at: ts }) };
    }
    // Bank change requests sent to SAP become Applied when SAP shows the new value.
    for (const cr of all<{ id: number; new_value: string }>("SELECT id, new_value FROM vendor_change_requests WHERE vendor_id = ? AND status = 'Sent to SAP' AND field = 'bank_account'", v.id)) {
      if (cr.new_value.slice(-4) === String(p.bank_account_masked ?? '').slice(-4)) update('vendor_change_requests', cr.id, { status: 'Applied', decided_at: ts });
    }
    return [{ id: v.id, isNew }];
  },
  MATERIAL: (key, p) => {
    const ts = now();
    const ex = get<{ id: number; category: string | null }>('SELECT id, category FROM materials WHERE code = ?', key);
    const mapped = get<{ category: string }>('SELECT category FROM material_group_map WHERE material_group = ?', p.material_group)?.category ?? null;
    const fields = {
      description: p.description, uom: p.uom, material_group: p.material_group, gst_rate: p.gst_rate, hsn: p.hsn,
      valuation_type: p.valuation_type ?? null, is_service: p.is_service ? 1 : 0, lpp: p.lpp ?? null,
      lpp_vendor_id: vendorIdBySap(p.lpp_vendor), lpp_date: p.lpp_date ?? null, budget_price: p.budget_price ?? null, brand: p.brand ?? null, synced_at: ts,
    };
    if (ex) {
      update('materials', ex.id, { ...fields, category: ex.category ?? mapped });
      return [{ id: ex.id, isNew: false }];
    }
    return [{ id: insert('materials', { code: key, ...fields, category: mapped }), isNew: true }];
  },
  PR: (key, p) => {
    const ts = now();
    const out: { id: number; isNew: boolean }[] = [];
    const reqId = userIdByEmail(p.requisitioner_email);
    for (const it of p.items ?? []) {
      const mat = get<{ id: number; category: string | null; material_group: string | null }>('SELECT id, category, material_group FROM materials WHERE code = ?', it.material_code);
      const ex = get<{ id: number; status: string; rfq_id: number | null; sap_status: string }>('SELECT id, status, rfq_id, sap_status FROM pr_lines WHERE pr_no = ? AND item = ?', key, it.item);
      const sapStatus = it.status ?? 'Released';
      const fields = {
        material_id: mat?.id ?? null, material_code: it.material_code, description: it.description,
        material_group: mat?.material_group ?? it.material_group ?? null, category: mat?.category ?? null,
        plant: it.plant, storage_location: it.storage_location ?? null, qty: it.qty, uom: it.uom, required_date: it.required_date,
        requisitioner_id: reqId, department: p.department ?? null, priority: it.priority ?? 'Normal',
        est_unit_price: it.est_unit_price ?? null, is_capex: it.is_capex ? 1 : 0, is_service: it.is_service ? 1 : 0,
        sap_status: sapStatus, sap_created_at: p.created_at ?? ts, synced_at: ts,
      };
      if (ex) {
        const extra: Record<string, unknown> = {};
        if (sapStatus !== 'Released' && ex.sap_status === 'Released') {
          if (ex.rfq_id && ['RFQ in progress'].includes(ex.status)) {
            extra.flag = `${sapStatus} in SAP while in RFQ — buyer decision needed`;
            run("UPDATE rfq_lines SET status = 'Flagged', flag_reason = ? WHERE pr_line_id = ? AND status = 'Active'", `PR line ${sapStatus.toLowerCase()} in SAP`, ex.id);
          } else if (!['PO created', 'Closed'].includes(ex.status)) {
            extra.status = 'Cancelled in SAP';
          }
        }
        update('pr_lines', ex.id, { ...fields, ...extra });
        out.push({ id: ex.id, isNew: false });
      } else if (sapStatus === 'Released') {
        out.push({ id: insert('pr_lines', { pr_no: key, item: it.item, ...fields, status: 'Synced', available_at: ts }), isNew: true });
      }
    }
    return out;
  },
  STOCK: (_key, p) => {
    const mid = materialIdByCode(p.material_code);
    if (!mid) throw new BusinessError(`Material ${p.material_code} not in material master`);
    run(
      `INSERT INTO stock (material_id, plant, unrestricted, open_po_qty, vmi, synced_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(material_id, plant) DO UPDATE SET unrestricted = excluded.unrestricted, open_po_qty = excluded.open_po_qty, vmi = excluded.vmi, synced_at = excluded.synced_at`,
      mid, p.plant, p.unrestricted ?? 0, p.open_po_qty ?? 0, p.vmi ? 1 : 0, now(),
    );
    return [{ id: mid, isNew: false }];
  },
  OA: (key, p) => {
    const ts = now();
    const vid = vendorIdBySap(p.vendor_sap_code);
    if (!vid) throw new BusinessError(`Vendor ${p.vendor_sap_code} not found for OA ${key}`);
    let c = get<{ id: number; status: string }>('SELECT id, status FROM contracts WHERE sap_oa_no = ?', key);
    if (!c && p.platform_ref) c = get<{ id: number; status: string }>('SELECT id, status FROM contracts WHERE contract_no = ?', p.platform_ref);
    const today = ts.slice(0, 10);
    const status = p.status === 'Blocked' ? 'Terminated' : p.valid_to < today ? 'Expired' : 'Active';
    const fields = {
      sap_oa_no: key, vendor_id: vid, valid_from: p.valid_from, valid_to: p.valid_to, value_cap: p.value_cap ?? null,
      consumed_value: p.consumed_value ?? 0, synced_at: ts, payment_terms: p.payment_terms ?? null, delivery_terms: p.delivery_terms ?? null,
    };
    let isNew = false;
    if (c) update('contracts', c.id, { ...fields, status: ['Draft', 'Pending approval'].includes(c.status) ? c.status : status });
    else {
      isNew = true;
      c = {
        id: insert('contracts', { contract_no: `SAP-${key}`, type: p.type ?? 'OA', title: p.title ?? `Outline agreement ${key}`, category: p.category ?? null, plant: p.plant ?? '*', ...fields, status, created_at: ts }),
        status,
      };
    }
    for (const it of p.items ?? []) {
      const mid = materialIdByCode(it.material_code);
      if (!mid) continue;
      const ci = get<{ id: number }>('SELECT id FROM contract_items WHERE contract_id = ? AND material_id = ?', c.id, mid);
      const f = { unit_price: it.unit_price, qty_cap: it.qty_cap ?? null, consumed_qty: it.consumed_qty ?? 0, uom: it.uom ?? null, discount_pct: it.discount_pct ?? null };
      if (ci) update('contract_items', ci.id, f);
      else insert('contract_items', { contract_id: c.id, material_id: mid, ...f });
    }
    return [{ id: c.id, isNew }];
  },
  PO: (key, p) => {
    if (!p.released) return []; // Only released POs are published (PO-01)
    const ts = now();
    const vid = vendorIdBySap(p.vendor_sap_code);
    if (!vid) throw new BusinessError(`Vendor ${p.vendor_sap_code} not found for PO ${key}`);
    const ex = get<{ id: number; version: number; status: string }>('SELECT id, version, status FROM pos WHERE po_no = ?', key);
    const contractId = p.oa_no ? get<{ id: number }>('SELECT id FROM contracts WHERE sap_oa_no = ?', p.oa_no)?.id ?? null : null;
    const items = (p.items ?? []).filter((i: any) => !i.deleted);
    const total = items.reduce((s: number, i: any) => s + i.qty * i.unit_price * (1 + (i.gst_rate ?? 0) / 100) + (i.freight ?? 0), 0);
    const header = {
      vendor_id: vid, buyer_id: userIdByEmail(p.buyer_email), plant: p.plant, po_date: p.po_date, sap_released: 1,
      delivery_terms: p.delivery_terms ?? null, payment_terms: p.payment_terms ?? null, freight_terms: p.freight_terms ?? null,
      total_value: Math.round(total * 100) / 100, contract_id: contractId, urgency: p.urgency ?? 'General stock',
      rfq_id: p.rfq_id ?? null, comparison_id: p.comparison_id ?? null, rfq_date: p.rfq_date ?? null, synced_at: ts,
    };
    let poId: number;
    let isNew = false;
    let amended = false;
    if (ex) {
      poId = ex.id;
      amended = (p.version ?? 1) > ex.version;
      update('pos', poId, { ...header, version: p.version ?? ex.version, sap_change_pending: 0, ...(p.cancelled ? { status: 'Cancelled' } : {}) });
    } else {
      isNew = true;
      poId = insert('pos', { po_no: key, ...header, version: p.version ?? 1, status: p.cancelled ? 'Cancelled' : 'Published', published_at: ts });
    }
    for (const it of p.items ?? []) {
      const exl = get<{ id: number; qty: number; unit_price: number; delivery_date: string; ack_status: string }>('SELECT id, qty, unit_price, delivery_date, ack_status FROM po_lines WHERE po_id = ? AND item = ?', poId, it.item);
      const prLine = it.pr_no ? get<{ id: number }>('SELECT id FROM pr_lines WHERE pr_no = ? AND item = ?', it.pr_no, it.pr_item)?.id ?? null : null;
      const f = {
        pr_line_id: prLine, material_id: materialIdByCode(it.material_code), description: it.description, qty: it.qty, uom: it.uom,
        unit_price: it.unit_price, gst_rate: it.gst_rate ?? 0, freight: it.freight ?? 0, delivery_date: it.delivery_date,
      };
      if (exl) {
        const changed = exl.qty !== it.qty || exl.unit_price !== it.unit_price || exl.delivery_date !== it.delivery_date || it.deleted;
        update('po_lines', exl.id, { ...f, ...(it.deleted ? { status: 'Cancelled', ack_status: 'Cancelled' } : changed && amended ? { ack_status: 'Pending re-acknowledgement', status: 'Published' } : {}) });
      } else {
        insert('po_lines', { po_id: poId, item: it.item, ...f, status: 'Published', ack_status: 'Pending' });
      }
      if (prLine) run("UPDATE pr_lines SET status = 'PO created', po_no = ? WHERE id = ? AND status NOT IN ('Closed')", key, prLine);
    }
    return [{ id: poId, isNew: isNew || amended }];
  },
  GRN: (key, p) => {
    const po = get<{ id: number }>('SELECT id FROM pos WHERE po_no = ?', p.po_no);
    if (!po) throw new BusinessError(`PO ${p.po_no} for GRN ${key} not in platform yet`);
    const out: { id: number; isNew: boolean }[] = [];
    for (const it of p.items ?? []) {
      const line = get<{ id: number }>('SELECT id FROM po_lines WHERE po_id = ? AND item = ?', po.id, it.po_item);
      if (!line) throw new BusinessError(`PO ${p.po_no} has no item ${it.po_item} (GRN ${key})`);
      const ex = get<{ id: number }>('SELECT id FROM grns WHERE grn_no = ? AND po_line_id = ?', p.grn_no, line.id);
      const f = { year: p.year, po_id: po.id, qty: it.qty, value: it.value ?? null, posting_date: p.posting_date, is_service: p.is_service ? 1 : 0, plant: p.plant, asn_id: p.asn_id ?? null, synced_at: now() };
      if (ex) update('grns', ex.id, f);
      else insert('grns', { grn_no: p.grn_no, po_line_id: line.id, ...f });
      const rec = scalar<number>('SELECT COALESCE(SUM(qty),0) FROM grns WHERE po_line_id = ?', line.id) ?? 0;
      const l = get<{ qty: number }>('SELECT qty FROM po_lines WHERE id = ?', line.id)!;
      update('po_lines', line.id, { received_qty: rec, status: rec >= l.qty ? 'Received' : rec > 0 ? 'Partially received' : undefined });
      out.push({ id: line.id, isNew: !ex });
    }
    const open = scalar<number>("SELECT COUNT(*) FROM po_lines WHERE po_id = ? AND status NOT IN ('Received','Closed','Cancelled')", po.id) ?? 0;
    if (!open) update('pos', po.id, { status: 'Closed', closed_at: now() });
    else update('pos', po.id, { status: 'Partially received' });
    if (p.asn_id) run("UPDATE asns SET status = 'Delivered', delivered_at = ? WHERE id = ? AND status != 'Cancelled'", now(), p.asn_id);
    return out;
  },
  INVSTATUS: (key, p) => {
    const inv = get<{ id: number; status: string }>('SELECT id, status FROM invoices WHERE inv_ref = ?', key);
    if (!inv) throw new BusinessError(`Invoice ${key} unknown to platform`);
    update('invoices', inv.id, {
      status: p.status, sap_doc_no: p.sap_doc_no ?? undefined, due_date: p.due_date ?? undefined, paid_at: p.paid_at ?? undefined,
      payment_ref: p.payment_ref ?? undefined, tds: p.tds ?? undefined, retention: p.retention ?? undefined,
      deductions_json: p.deductions ? J(p.deductions) : undefined, advance_adjusted: p.advance_adjusted ?? undefined,
      payment_advice_json: p.payment_advice ? J(p.payment_advice) : undefined, posted_at: p.posted_at ?? undefined,
      parked_at: p.parked_at ?? undefined, block_reason_internal: p.block_reason ?? undefined, vendor_reason: p.vendor_reason ?? undefined, updated_at: now(),
    });
    return [{ id: inv.id, isNew: inv.status !== p.status }];
  },
  ADVPAY: (key, p) => {
    const adv = get<{ id: number }>('SELECT id FROM advances WHERE adv_no = ?', key);
    if (!adv) throw new BusinessError(`Advance ${key} unknown to platform`);
    const amount = get<{ amount: number }>('SELECT amount FROM advances WHERE id = ?', adv.id)!.amount;
    const adjusted = p.adjusted_amount ?? 0;
    update('advances', adv.id, {
      sap_doc: p.sap_doc, paid_date: p.paid_date, adjusted_amount: adjusted,
      status: adjusted >= amount ? 'Fully adjusted' : adjusted > 0 ? 'Partially adjusted' : 'Paid',
    });
    return [{ id: adv.id, isNew: false }];
  },
};

class BusinessError extends Error {}

// ---------------------------------------------------------------- inbound sync
const DOC_FLOW: Record<string, string> = { VENDOR: 'INT-M01', MATERIAL: 'INT-M02', PR: 'INT-M03', STOCK: 'INT-M04', OA: 'INT-M06', PO: 'INT-M07', GRN: 'INT-M10', INVSTATUS: 'INT-M12', ADVPAY: 'INT-M12' };
const ORDER = ['VENDOR', 'MATERIAL', 'STOCK', 'OA', 'PR', 'PO', 'GRN', 'INVSTATUS', 'ADVPAY'];

export function runSync(docType: string, trigger: 'scheduled' | 'event' | 'manual' | 'full' = 'scheduled', actor: Actor | null = null) {
  const flow = DOC_FLOW[docType];
  const state = get<{ watermark: string | null }>('SELECT watermark FROM sync_state WHERE flow = ?', `${flow}:${docType}`);
  const startedAt = now();
  const jobId = insert('integration_jobs', { flow, direction: 'SAP → S2P', trigger, started_at: startedAt, status: 'Running', message: docType });
  const settings = simSettings();
  const setState = (status: string, msg: string, success: boolean, wm?: string | null) => {
    run(
      `INSERT INTO sync_state (flow, watermark, last_success, last_run, last_status, last_message) VALUES (?,?,?,?,?,?)
       ON CONFLICT(flow) DO UPDATE SET watermark = COALESCE(excluded.watermark, sync_state.watermark),
       last_success = COALESCE(excluded.last_success, sync_state.last_success), last_run = excluded.last_run,
       last_status = excluded.last_status, last_message = excluded.last_message`,
      `${flow}:${docType}`, wm ?? null, success ? now() : null, now(), status, msg,
    );
  };
  if (settings.offline) {
    const msg = 'SAP system unavailable (simulated outage). Will retry on next schedule.';
    update('integration_jobs', jobId, { status: 'Failed', finished_at: now(), error_count: 1, message: msg });
    setState('Failed', msg, false);
    insertError(flow, `${docType}:pull:${startedAt}`, null, { docType }, msg, 'transient');
    return { status: 'Failed', read: 0, upserted: 0, errors: 1 };
  }
  const wm = trigger === 'full' ? '' : state?.watermark ?? '';
  const docs = all<{ doc_key: string; payload: any; changed_at: string; deleted: number }>(
    'SELECT doc_key, payload_json, changed_at, deleted FROM sap_documents WHERE doc_type = ? AND changed_at > ? ORDER BY changed_at, id',
    docType, wm,
  );
  let upserted = 0;
  let errors = 0;
  let maxWm = wm;
  const results: { id: number; isNew: boolean; payload: any }[] = [];
  for (const d of docs) {
    try {
      const r = tx(() => MAPPERS[docType](d.doc_key, d.payload, !!d.deleted));
      upserted += r.length;
      for (const x of r) results.push({ ...x, payload: d.payload });
      // An earlier failure for this document is resolved by a successful sync.
      run("UPDATE integration_errors SET status = 'Resolved', updated_at = ?, resolution_reason = 'Succeeded on later sync' WHERE flow = ? AND message_id = ? AND status IN ('Queued','Retrying','Failed')", now(), flow, `${docType}:${d.doc_key}`);
    } catch (e) {
      errors++;
      const business = e instanceof BusinessError;
      insertError(flow, `${docType}:${d.doc_key}`, null, d.payload, (e as Error).message, business ? 'business' : 'transient');
    }
    if (d.changed_at > maxWm) maxWm = d.changed_at;
  }
  // Run module hooks outside the per-document transaction.
  if (results.length) for (const fn of hooks.get(docType) ?? []) {
    try {
      fn(results);
    } catch (e) {
      console.error(`sync hook ${docType} failed`, e);
    }
  }
  const status = errors ? (upserted ? 'Partial' : 'Failed') : 'Succeeded';
  const msg = `${docType}: read ${docs.length}, upserted ${upserted}${errors ? `, ${errors} error(s)` : ''}`;
  update('integration_jobs', jobId, { status, finished_at: now(), read_count: docs.length, upserted, error_count: errors, message: msg });
  setState(status, msg, errors === 0 || upserted > 0, maxWm || null);
  if (errors) notify({ event: 'NTF-32', title: `SAP sync ${flow} (${docType}) had ${errors} error(s)`, body: msg, link: '/integration/errors', roles: ['SAP'], dedupeKey: `NTF-32:${flow}:${docType}:${startedAt.slice(0, 13)}`, severity: 'danger' });
  if (actor) audit(actor, { action: 'integration.sync_run', objectType: 'integration_flow', objectId: flow, after: { docType, trigger, read: docs.length, upserted, errors } });
  return { status, read: docs.length, upserted, errors };
}

export function runAllInbound(trigger: 'scheduled' | 'manual' | 'full' = 'scheduled', actor: Actor | null = null) {
  return ORDER.map((d) => ({ docType: d, ...runSync(d, trigger, actor) }));
}

/** Event trigger: simulator actions push the change straight away. */
export function syncEvent(docType: string) {
  return runSync(docType, 'event');
}

function insertError(flow: string, messageId: string, idem: string | null, payload: unknown, error: string, type: 'transient' | 'business') {
  const ex = get<{ id: number; attempts: number }>("SELECT id, attempts FROM integration_errors WHERE flow = ? AND message_id = ? AND status IN ('Queued','Retrying','Failed')", flow, messageId);
  const ts = now();
  if (ex) {
    update('integration_errors', ex.id, { attempts: ex.attempts + 1, error, updated_at: ts, status: type === 'business' ? 'Failed' : 'Retrying', next_retry_at: type === 'business' ? null : backoff(ex.attempts + 1) });
    return ex.id;
  }
  return insert('integration_errors', {
    flow, message_id: messageId, idempotency_key: idem, payload_json: J(payload), error, error_type: type, attempts: 1,
    status: type === 'business' ? 'Failed' : 'Retrying', next_retry_at: type === 'business' ? null : backoff(1), created_at: ts, updated_at: ts,
  });
}

const backoff = (attempt: number) => new Date(Date.now() + Math.min(2 ** (attempt - 1), 30) * 60000).toISOString();

// ---------------------------------------------------------------- outbound writes
export interface OutboundResult {
  status: 'Written' | 'Duplicate' | 'Queued' | 'Failed';
  sapKey?: string;
  message: string;
}

/**
 * Idempotent write to SAP (simulated). Replaying the same key never creates a second document.
 * `docType` is the SAP-side document kind (e.g. POACK); `flow` is the INT id.
 */
export function sapWrite(flow: string, docType: string, idempotencyKey: string, payload: unknown, actor: Actor | null): OutboundResult {
  const existing = get<{ id: number; status: string; sap_doc_key: string | null }>('SELECT id, status, sap_doc_key FROM sap_outbound WHERE idempotency_key = ?', idempotencyKey);
  if (existing?.status === 'Written') return { status: 'Duplicate', sapKey: existing.sap_doc_key ?? undefined, message: 'Already written to SAP — no new document created.' };
  // SAP may have committed on a previous attempt that timed out: check SAP before writing again.
  const inSap = sapGet(docType, idempotencyKey);
  const outId = existing?.id ?? insert('sap_outbound', { flow, idempotency_key: idempotencyKey, payload_json: J(payload), status: 'Pending', attempts: 0, created_at: now() });
  run('UPDATE sap_outbound SET attempts = attempts + 1 WHERE id = ?', outId);
  if (inSap) {
    update('sap_outbound', outId, { status: 'Written', sap_doc_key: idempotencyKey, completed_at: now() });
    run("UPDATE integration_errors SET status = 'Resolved', updated_at = ?, resolution_reason = 'SAP already held the document (idempotent replay)' WHERE idempotency_key = ? AND status IN ('Queued','Retrying','Failed')", now(), idempotencyKey);
    return { status: 'Written', sapKey: idempotencyKey, message: 'SAP already held this document; linked without creating a duplicate.' };
  }
  const s = simSettings();
  const mode = s.offline ? 'transient' : s.fail[flow] ?? null;
  if (mode === 'timeout_after_commit') {
    sapPut(docType, idempotencyKey, payload, 'S2P adapter');
    s.fail[flow] = null;
    setSimSettings(s);
    insertError(flow, idempotencyKey, idempotencyKey, payload, 'Timeout waiting for SAP response (SAP committed the document)', 'transient');
    update('sap_outbound', outId, { status: 'Queued' });
    return { status: 'Queued', message: 'SAP did not respond in time. The write is queued for retry.' };
  }
  if (mode === 'transient') {
    insertError(flow, idempotencyKey, idempotencyKey, payload, s.offline ? 'SAP system unavailable (simulated outage)' : 'Connection reset by SAP gateway (simulated)', 'transient');
    update('sap_outbound', outId, { status: 'Queued' });
    if (!s.offline) { s.fail[flow] = null; setSimSettings(s); }
    return { status: 'Queued', message: 'SAP is unavailable. The write is saved and queued for retry.' };
  }
  if (mode === 'business') {
    insertError(flow, idempotencyKey, idempotencyKey, payload, 'SAP business error: document locked by another user (simulated)', 'business');
    update('sap_outbound', outId, { status: 'Failed' });
    s.fail[flow] = null;
    setSimSettings(s);
    notify({ event: 'NTF-32', title: `SAP rejected ${flow} write`, body: idempotencyKey, link: '/integration/errors', roles: ['SAP'], severity: 'danger', dedupeKey: `NTF-32:${idempotencyKey}` });
    return { status: 'Failed', message: 'SAP rejected the write with a business error. SAP/IT has been alerted.' };
  }
  sapPut(docType, idempotencyKey, payload, 'S2P adapter');
  update('sap_outbound', outId, { status: 'Written', sap_doc_key: idempotencyKey, completed_at: now() });
  if (actor) audit(actor, { action: 'integration.outbound_write', objectType: 'integration_flow', objectId: flow, after: { docType, idempotencyKey } });
  return { status: 'Written', sapKey: idempotencyKey, message: 'Written to SAP (simulated).' };
}

/** Scheduler: retry transient outbound errors whose back-off has elapsed. */
export function retryOutbound() {
  const due = all<{ id: number; flow: string; idempotency_key: string | null; payload: unknown; attempts: number; message_id: string }>(
    "SELECT id, flow, idempotency_key, payload_json, attempts, message_id FROM integration_errors WHERE status = 'Retrying' AND next_retry_at <= ?",
    now(),
  );
  let ok = 0;
  for (const e of due) {
    if (!e.idempotency_key) {
      // Inbound pull failure: the next scheduled sync retries it.
      continue;
    }
    if (e.attempts >= 5) {
      update('integration_errors', e.id, { status: 'Failed', updated_at: now() });
      continue;
    }
    const out = get<{ flow: string }>('SELECT flow FROM sap_outbound WHERE idempotency_key = ?', e.idempotency_key);
    const docType = FLOWS.find((f) => f.id === (out?.flow ?? e.flow))?.docType ?? 'UNKNOWN';
    const r = sapWrite(e.flow, docType, e.idempotency_key, e.payload, null);
    if (r.status === 'Written' || r.status === 'Duplicate') {
      update('integration_errors', e.id, { status: 'Resolved', updated_at: now(), resolution_reason: 'Automatic retry succeeded' });
      ok++;
    }
  }
  return `retried ${due.length}, succeeded ${ok}`;
}

export function replayError(actor: Actor, id: number) {
  const e = get<{ id: number; flow: string; idempotency_key: string | null; payload: unknown; message_id: string; status: string }>('SELECT * FROM integration_errors WHERE id = ?', id);
  if (!e) throw new Error('Not found');
  audit(actor, { action: 'integration.replay', objectType: 'integration_error', objectId: id, after: { flow: e.flow, key: e.idempotency_key ?? e.message_id } });
  if (e.idempotency_key) {
    const docType = FLOWS.find((f) => f.id === e.flow)?.docType ?? 'UNKNOWN';
    update('integration_errors', id, { attempts: (get<{ attempts: number }>('SELECT attempts FROM integration_errors WHERE id = ?', id)!.attempts) + 1, updated_at: now() });
    const r = sapWrite(e.flow, docType, e.idempotency_key, e.payload, actor);
    if (r.status === 'Written' || r.status === 'Duplicate') update('integration_errors', id, { status: 'Replayed', resolved_by: actor.id, updated_at: now(), resolution_reason: r.message });
    return r;
  }
  // Inbound document: re-pull that document type.
  const docType = e.message_id.split(':')[0];
  run("UPDATE sync_state SET watermark = '' WHERE flow = ?", `${e.flow}:${docType}`);
  const r = runSync(docType, 'manual', actor);
  const still = get<{ status: string }>('SELECT status FROM integration_errors WHERE id = ?', id);
  if (still && !['Resolved'].includes(still.status) && r.errors === 0) update('integration_errors', id, { status: 'Replayed', resolved_by: actor.id, updated_at: now(), resolution_reason: 'Re-synchronised' });
  return { status: r.errors ? 'Failed' : 'Written', message: `Re-sync ${docType}: ${r.upserted} upserted, ${r.errors} errors` };
}

export function discardError(actor: Actor, id: number, reason: string) {
  update('integration_errors', id, { status: 'Discarded', resolved_by: actor.id, resolution_reason: reason, updated_at: now() });
  audit(actor, { action: 'integration.discard', objectType: 'integration_error', objectId: id, reason });
}

// ---------------------------------------------------------------- reconciliation & freshness
export function reconcile() {
  const diffs: { object: string; key: string; issue: string }[] = [];
  const counts: { object: string; sap: number; platform: number; sapTotal?: number; platformTotal?: number }[] = [];
  // Vendors
  const sapVendors = sapList<any>('VENDOR');
  const platVendors = new Set(all<{ sap_code: string }>('SELECT sap_code FROM vendors WHERE sap_code IS NOT NULL').map((v) => v.sap_code));
  counts.push({ object: 'Vendors', sap: sapVendors.length, platform: platVendors.size });
  for (const v of sapVendors) if (!platVendors.has(v.doc_key)) diffs.push({ object: 'Vendor', key: v.doc_key, issue: 'In SAP, missing in platform' });
  // Open PR lines
  const sapPrLines = sapList<any>('PR').flatMap((d) => (d.payload.items ?? []).filter((i: any) => (i.status ?? 'Released') === 'Released').map((i: any) => `${d.doc_key}/${i.item}`));
  const platPr = new Set(all<{ k: string }>("SELECT pr_no || '/' || item AS k FROM pr_lines WHERE sap_status = 'Released'").map((r) => r.k));
  counts.push({ object: 'Released PR lines', sap: sapPrLines.length, platform: platPr.size });
  for (const k of sapPrLines) if (!platPr.has(k)) diffs.push({ object: 'PR line', key: k, issue: 'In SAP, missing in platform' });
  // Released PO lines
  const sapPo = sapList<any>('PO').filter((d) => d.payload.released);
  const sapPoLines = sapPo.flatMap((d) => (d.payload.items ?? []).filter((i: any) => !i.deleted).map((i: any) => ({ k: `${d.doc_key}/${i.item}`, qty: i.qty })));
  const platPoLines = all<{ k: string; qty: number }>("SELECT p.po_no || '/' || l.item AS k, l.qty FROM po_lines l JOIN pos p ON p.id = l.po_id WHERE l.status != 'Cancelled'");
  const platPoMap = new Map(platPoLines.map((r) => [r.k, r.qty]));
  counts.push({ object: 'Released PO lines', sap: sapPoLines.length, platform: platPoLines.length, sapTotal: sapPoLines.reduce((s, x) => s + x.qty, 0), platformTotal: platPoLines.reduce((s, x) => s + x.qty, 0) });
  for (const l of sapPoLines) {
    if (!platPoMap.has(l.k)) diffs.push({ object: 'PO line', key: l.k, issue: 'In SAP, missing in platform' });
    else if (platPoMap.get(l.k) !== l.qty) diffs.push({ object: 'PO line', key: l.k, issue: `Quantity SAP ${l.qty} vs platform ${platPoMap.get(l.k)}` });
  }
  // GRN lines
  const sapGrn = sapList<any>('GRN').flatMap((d) => (d.payload.items ?? []).map((i: any) => ({ k: `${d.payload.grn_no}/${d.payload.po_no}/${i.po_item}`, qty: i.qty })));
  const platGrn = all<{ k: string; qty: number }>("SELECT g.grn_no || '/' || p.po_no || '/' || l.item AS k, g.qty FROM grns g JOIN po_lines l ON l.id = g.po_line_id JOIN pos p ON p.id = l.po_id");
  const platGrnMap = new Map(platGrn.map((r) => [r.k, r.qty]));
  counts.push({ object: 'GRN / SES lines', sap: sapGrn.length, platform: platGrn.length, sapTotal: sapGrn.reduce((s, x) => s + x.qty, 0), platformTotal: platGrn.reduce((s, x) => s + x.qty, 0) });
  for (const g of sapGrn) {
    if (!platGrnMap.has(g.k)) diffs.push({ object: 'GRN line', key: g.k, issue: 'In SAP, missing in platform' });
    else if (platGrnMap.get(g.k) !== g.qty) diffs.push({ object: 'GRN line', key: g.k, issue: `Quantity SAP ${g.qty} vs platform ${platGrnMap.get(g.k)}` });
  }
  const sapGrnKeys = new Set(sapGrn.map((g) => g.k));
  for (const g of platGrn) if (!sapGrnKeys.has(g.k)) diffs.push({ object: 'GRN line', key: g.k, issue: 'In platform, not in SAP' });
  // Outline agreements
  const sapOa = sapList<any>('OA');
  const platOa = new Set(all<{ sap_oa_no: string }>('SELECT sap_oa_no FROM contracts WHERE sap_oa_no IS NOT NULL').map((r) => r.sap_oa_no));
  counts.push({ object: 'Outline agreements', sap: sapOa.length, platform: platOa.size });
  for (const o of sapOa) if (!platOa.has(o.doc_key)) diffs.push({ object: 'OA', key: o.doc_key, issue: 'In SAP, missing in platform' });
  return { ran_at: now(), counts, diffs };
}

export function freshness() {
  const th = cfg<Record<string, number>>('sap.freshness_minutes');
  return INBOUND.map((f) => {
    const st = all<{ flow: string; last_success: string | null; last_run: string | null; last_status: string | null; last_message: string | null }>(
      'SELECT * FROM sync_state WHERE flow LIKE ?', `${f.id}:%`,
    );
    const lastSuccess = st.map((s) => s.last_success).filter(Boolean).sort().at(0) ?? null;
    const lastRun = st.map((s) => s.last_run).filter(Boolean).sort().at(-1) ?? null;
    const age = lastSuccess ? (Date.now() - new Date(lastSuccess).getTime()) / 60000 : null;
    const threshold = th[f.id] ?? 60;
    return {
      ...f,
      lastSuccess, lastRun, lastStatus: st.map((s) => s.last_status).find((s) => s && s !== 'Succeeded') ?? st[0]?.last_status ?? null,
      lastMessage: st.map((s) => s.last_message).join(' · '), ageMinutes: age != null ? Math.round(age) : null, thresholdMinutes: threshold,
      stale: age == null || age > threshold,
      openErrors: scalar<number>("SELECT COUNT(*) FROM integration_errors WHERE flow = ? AND status IN ('Queued','Retrying','Failed')", f.id) ?? 0,
    };
  });
}

/** Freshness threshold lookup used by FR-PLT-04 stale badges. */
export function staleInfo(flowId: string, syncedAt: string | null | undefined) {
  const th = cfg<Record<string, number>>('sap.freshness_minutes')[flowId] ?? 60;
  if (!syncedAt) return { stale: true, thresholdMinutes: th };
  return { stale: (Date.now() - new Date(syncedAt).getTime()) / 60000 > th, thresholdMinutes: th };
}
