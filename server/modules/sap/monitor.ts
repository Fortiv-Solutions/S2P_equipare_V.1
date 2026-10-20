/**
 * Module 12 — SAP integration monitoring, error queue, recovery and reconciliation
 * (FR-SAP-05..10, AC-SAP-01..05, SCR-SAP-01..03). Built on the adapter in core/sap.ts.
 */
import { all, get, insert, run, update, J, now, scalar } from '../../core/db.ts';
import { audit } from '../../core/audit.ts';
import { notify } from '../../core/notify.ts';
import { cfg } from '../../core/config.ts';
import { badRequest, conflict, notFound } from '../../core/http.ts';
import {
  FLOWS, freshness, runSync, sapGet, sapList, sapPut, simSettings, replayError, discardError, retryOutbound, reconcile, type FlowDef,
} from '../../core/sap.ts';
import type { Actor } from '../../core/auth.ts';

/** SAP document types read by each inbound flow (mirrors the adapter's flow map). */
export const FLOW_DOCS: Record<string, string[]> = {
  'INT-M01': ['VENDOR'], 'INT-M02': ['MATERIAL'], 'INT-M03': ['PR'], 'INT-M04': ['STOCK'], 'INT-M06': ['OA'],
  'INT-M07': ['PO'], 'INT-M10': ['GRN'], 'INT-M12': ['INVSTATUS', 'ADVPAY'],
};
/** Business-rule switch that governs each outbound write (all off until the decision is taken). */
const WRITE_SWITCH: Record<string, string | undefined> = { 'INT-M05': 'sap.write.rfq', 'INT-M08': 'sap.write.ack', 'INT-M11': 'sap.write.invoice_parking' };

export const isOutbound = (f: FlowDef) => f.direction === 'S2P → SAP';
export const isInbound = (f: FlowDef) => f.direction !== 'S2P → SAP';
export const OPEN_ERR = "('Queued','Retrying','Failed')";

export function mustFlow(id: string) {
  const f = FLOWS.find((x) => x.id === id);
  if (!f) throw notFound('Integration flow');
  return f;
}

function writeStatus(f: FlowDef) {
  if (f.write === 'No') return { label: 'Read only — SAP is the record', enabled: false, decision: f.decision ?? null };
  const key = WRITE_SWITCH[f.id];
  if (key) {
    const on = !!cfg<boolean>(key);
    return { label: on ? 'Write enabled (simulated SAP)' : 'Write off — platform is the record', enabled: on, decision: f.decision ?? null, config_key: key };
  }
  if (f.id === 'INT-M06') return { label: 'Read from SAP; write-back waits for DEC-03', enabled: false, decision: 'DEC-03' };
  return { label: 'Kept in platform with PO reference', enabled: false, decision: f.decision ?? null };
}

/** SCR-SAP-01: one card per flow with run history, queue depth and freshness (FR-SAP-08). */
export function flowCards() {
  const fresh = new Map(freshness().map((f) => [f.id, f]));
  const since = new Date(Date.now() - 24 * 3600000).toISOString();
  return FLOWS.map((f) => {
    const fr = fresh.get(f.id);
    const jobs = get<{ ok: number; bad: number; last_run: string | null }>(
      `SELECT SUM(CASE WHEN status = 'Succeeded' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status IN ('Failed','Partial') THEN 1 ELSE 0 END) AS bad, MAX(started_at) AS last_run
       FROM integration_jobs WHERE flow = ? AND started_at >= ?`, f.id, since,
    )!;
    const out = get<{ ok: number; bad: number; queued: number; last_run: string | null; last_ok: string | null; total: number }>(
      `SELECT SUM(CASE WHEN status = 'Written' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END) AS bad,
              SUM(CASE WHEN status IN ('Queued','Pending') THEN 1 ELSE 0 END) AS queued, MAX(created_at) AS last_run, MAX(completed_at) AS last_ok, COUNT(*) AS total
       FROM sap_outbound WHERE flow = ?`, f.id,
    )!;
    const errs = get<{ open: number; business: number; retrying: number; next_retry: string | null }>(
      `SELECT COUNT(*) AS open, SUM(CASE WHEN error_type = 'business' THEN 1 ELSE 0 END) AS business,
              SUM(CASE WHEN status = 'Retrying' THEN 1 ELSE 0 END) AS retrying, MIN(CASE WHEN status = 'Retrying' THEN next_retry_at END) AS next_retry
       FROM integration_errors WHERE flow = ? AND status IN ${OPEN_ERR}`, f.id,
    )!;
    const inbound = isInbound(f);
    return {
      id: f.id, name: f.name, direction: f.direction, trigger: f.trigger, mechanism: f.mechanism, release: f.release,
      doc_types: FLOW_DOCS[f.id] ?? (f.docType ? [f.docType] : []), inbound, outbound: isOutbound(f) || f.direction === 'SAP ↔ S2P',
      write: writeStatus(f),
      last_run: [jobs.last_run, out.last_run].filter(Boolean).sort().at(-1) ?? fr?.lastRun ?? null,
      last_success: inbound ? fr?.lastSuccess ?? null : out.last_ok,
      last_status: inbound ? fr?.lastStatus ?? null : out.total ? (out.bad ? 'Failed' : out.queued ? 'Queued' : 'Written') : null,
      last_message: inbound ? fr?.lastMessage ?? null : null,
      success_24h: (jobs.ok ?? 0) + (inbound ? 0 : out.ok ?? 0),
      failure_24h: (jobs.bad ?? 0) + (inbound ? 0 : out.bad ?? 0),
      writes: inbound && f.direction !== 'SAP ↔ S2P' ? null : { written: out.ok ?? 0, queued: out.queued ?? 0, failed: out.bad ?? 0 },
      queue_depth: errs.open ?? 0, business_errors: errs.business ?? 0, retrying: errs.retrying ?? 0, next_retry_at: errs.next_retry,
      freshness: inbound && fr ? { age_minutes: fr.ageMinutes, threshold_minutes: fr.thresholdMinutes, stale: fr.stale } : null,
    };
  });
}

/** Live alerts for the monitor (FR-SAP-08, NTF-32/33). */
export function alerts() {
  const out: { tone: 'bad' | 'warn' | 'info'; title: string; body: string; link?: string }[] = [];
  const sim = simSettings();
  if (sim.offline) out.push({ tone: 'bad', title: 'SAP is unavailable (simulated outage)', body: 'Inbound syncs fail and outbound writes are queued until SAP returns. Switch the outage off in the SAP simulator to recover.', link: '/sap-simulator?tab=outage' });
  const fails = Object.entries(sim.fail).filter(([, m]) => m);
  if (fails.length) out.push({ tone: 'info', title: 'Failure injection armed', body: fails.map(([f, m]) => `${f}: next write ${String(m).replace(/_/g, ' ')}`).join(' · '), link: '/sap-simulator?tab=outage' });
  for (const f of freshness().filter((x) => x.stale)) {
    out.push({ tone: 'warn', title: `${f.id} ${f.name}: data older than ${f.thresholdMinutes} min`, body: f.lastSuccess ? `Last successful sync ${Math.round(f.ageMinutes ?? 0)} minutes ago.` : 'No successful sync yet.', link: '/integration/runbook#' + f.id });
  }
  const business = scalar<number>(`SELECT COUNT(*) FROM integration_errors WHERE status = 'Failed'`) ?? 0;
  if (business) out.push({ tone: 'bad', title: `${business} failed message${business === 1 ? ' needs' : 's need'} SAP/IT action`, body: 'Business errors are not retried automatically. Correct, replay or discard them with a reason.', link: '/integration/errors?status=Failed' });
  const retrying = scalar<number>(`SELECT COUNT(*) FROM integration_errors WHERE status IN ('Queued','Retrying')`) ?? 0;
  if (retrying) out.push({ tone: 'warn', title: `${retrying} message${retrying === 1 ? '' : 's'} queued for automatic retry`, body: 'Transient errors retry with back-off (1, 2, 4 … 30 minutes, up to 5 attempts).', link: '/integration/errors?status=Retrying' });
  return out;
}

export function recentJobs(flow?: string, limit = 60) {
  return all(
    `SELECT * FROM integration_jobs ${flow ? 'WHERE flow = ?' : ''} ORDER BY id DESC LIMIT ${Math.min(200, limit)}`, ...(flow ? [flow] : []),
  );
}

// ---------------------------------------------------------------- error queue (SCR-SAP-02)
interface ErrRow {
  id: number; flow: string; message_id: string; idempotency_key: string | null; payload: unknown; error: string; error_type: string;
  attempts: number; status: string; next_retry_at: string | null; created_at: string; updated_at: string; resolved_by: number | null; resolution_reason: string | null;
}

function decorateError(e: ErrRow & { resolved_by_name?: string | null }) {
  const f = FLOWS.find((x) => x.id === e.flow);
  const outbound = !!e.idempotency_key;
  const [docType, ...rest] = e.message_id.split(':');
  const open = ['Queued', 'Retrying', 'Failed'].includes(e.status);
  return {
    ...e, flow_name: f?.name ?? e.flow, direction: outbound ? 'S2P → SAP' : 'SAP → S2P',
    doc_type: outbound ? f?.docType ?? null : docType, doc_key: outbound ? e.idempotency_key : rest.join(':'),
    pull_failure: !outbound && rest[0] === 'pull',
    open,
    /** Outbound messages are the platform's own payload and may be corrected before replay (FR-SAP-06). Inbound data is corrected in SAP. */
    editable: open && outbound,
    can_replay: open,
  };
}

export function listErrors(q: { status?: string; flow?: string; type?: string }) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (q.status === 'open') where.push(`e.status IN ${OPEN_ERR}`);
  else if (q.status && q.status !== 'all') { where.push('e.status = ?'); p.push(q.status); }
  if (q.flow) { where.push('e.flow = ?'); p.push(q.flow); }
  if (q.type) { where.push('e.error_type = ?'); p.push(q.type); }
  return all<ErrRow & { resolved_by_name: string | null }>(
    `SELECT e.*, u.name AS resolved_by_name FROM integration_errors e LEFT JOIN users u ON u.id = e.resolved_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE WHEN e.status IN ${OPEN_ERR} THEN 0 ELSE 1 END, e.id DESC LIMIT 500`, ...p,
  ).map(decorateError);
}

export function getError(id: number) {
  const e = get<ErrRow & { resolved_by_name: string | null }>('SELECT e.*, u.name AS resolved_by_name FROM integration_errors e LEFT JOIN users u ON u.id = e.resolved_by WHERE e.id = ?', id);
  if (!e) throw notFound('Integration error');
  const d = decorateError(e);
  const outbound = e.idempotency_key ? get('SELECT * FROM sap_outbound WHERE idempotency_key = ?', e.idempotency_key) : null;
  const sapDoc = d.doc_type && d.doc_key && !d.pull_failure ? sapGet(d.doc_type, String(d.doc_key)) ?? null : null;
  const trail = all("SELECT id, ts, actor_name, role, action, reason, after_json FROM audit_events WHERE object_type = 'integration_error' AND object_id = ? ORDER BY id DESC", String(id));
  return { ...d, outbound, sap_document: sapDoc, trail };
}

/** Replay one message; optionally with a corrected payload (outbound only), audited before/after. */
export function replay(actor: Actor, id: number, payload?: unknown) {
  const e = getError(id);
  if (!e.open) throw conflict(`This message is ${e.status.toLowerCase()} and cannot be replayed.`);
  if (payload !== undefined) {
    if (!e.editable) throw badRequest('Only outbound messages can be corrected here. Correct inbound data in SAP, then replay.', { payload: 'Not editable' });
    if (payload === null || typeof payload !== 'object') throw badRequest('The corrected payload must be a JSON object.', { payload: 'Enter a JSON object' });
    audit(actor, { action: 'integration.payload_corrected', objectType: 'integration_error', objectId: id, before: e.payload, after: payload, reason: 'Corrected before replay' });
    update('integration_errors', id, { payload_json: J(payload), updated_at: now() });
    run('UPDATE sap_outbound SET payload_json = ? WHERE idempotency_key = ?', J(payload), e.idempotency_key);
  }
  const r = replayError(actor, id);
  const after = getError(id);
  return { result: r, error: after };
}

export function discard(actor: Actor, id: number, reason: string) {
  const e = getError(id);
  if (!e.open) throw conflict(`This message is already ${e.status.toLowerCase()}.`);
  discardError(actor, id, reason);
  if (e.idempotency_key) run("UPDATE sap_outbound SET status = 'Discarded' WHERE idempotency_key = ? AND status != 'Written'", e.idempotency_key);
  return getError(id);
}

/** Inbound pull failures (SAP unavailable) are cleared once a later sync of that document type succeeds. */
export function resolveRecoveredPulls() {
  const r = run(
    `UPDATE integration_errors SET status = 'Resolved', resolution_reason = 'A later sync of this document type succeeded', updated_at = ?
     WHERE status IN ('Queued','Retrying') AND idempotency_key IS NULL AND message_id LIKE '%:pull:%'
       AND EXISTS (SELECT 1 FROM sync_state s WHERE s.flow = integration_errors.flow || ':' || substr(integration_errors.message_id, 1, instr(integration_errors.message_id, ':') - 1)
                   AND s.last_success > integration_errors.created_at)`,
    now(),
  );
  return r.changes;
}

// ---------------------------------------------------------------- run now & recovery (FR-SAP-10)
export function runFlow(actor: Actor, flowId: string) {
  const f = mustFlow(flowId);
  if (isInbound(f)) {
    const results = (FLOW_DOCS[f.id] ?? []).map((d) => ({ docType: d, ...runSync(d, 'manual', actor) }));
    resolveRecoveredPulls();
    const errors = results.reduce((s, r) => s + r.errors, 0);
    const upserted = results.reduce((s, r) => s + r.upserted, 0);
    return { flow: f.id, kind: 'inbound', results, message: `${f.id} ran: ${results.map((r) => `${r.docType} read ${r.read}, upserted ${r.upserted}${r.errors ? `, ${r.errors} error(s)` : ''}`).join(' · ')}`, ok: errors === 0, upserted };
  }
  const queued = processQueue(actor, f.id);
  return { flow: f.id, kind: 'outbound', ...queued, ok: queued.failed === 0 && queued.still_queued === 0 };
}

/** Retry the queued outbound writes of one flow (or all) now, ignoring the back-off timer. */
export function processQueue(actor: Actor | null, flowId?: string) {
  const ids = all<{ id: number }>(
    `SELECT id FROM integration_errors WHERE status = 'Retrying' AND idempotency_key IS NOT NULL ${flowId ? 'AND flow = ?' : ''}`, ...(flowId ? [flowId] : []),
  ).map((r) => r.id);
  if (ids.length) run(`UPDATE integration_errors SET next_retry_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, now(), ...ids);
  const msg = retryOutbound();
  const still = ids.length ? scalar<number>(`SELECT COUNT(*) FROM integration_errors WHERE status IN ('Queued','Retrying') AND id IN (${ids.map(() => '?').join(',')})`, ...ids) ?? 0 : 0;
  const failed = ids.length ? scalar<number>(`SELECT COUNT(*) FROM integration_errors WHERE status = 'Failed' AND id IN (${ids.map(() => '?').join(',')})`, ...ids) ?? 0 : 0;
  if (actor) audit(actor, { action: 'integration.queue_processed', objectType: 'integration_flow', objectId: flowId ?? 'all', after: { attempted: ids.length, still_queued: still, failed, result: msg } });
  return { attempted: ids.length, written: ids.length - still - failed, still_queued: still, failed, message: ids.length ? `Retried ${ids.length} queued write(s): ${ids.length - still - failed} written, ${still} still queued, ${failed} failed.` : 'No queued writes for this flow.' };
}

export type ResyncMode = 'document' | 'from_date' | 'full';

/**
 * Manual recovery (FR-SAP-10): re-send one SAP document (re-triggers its change pointer), re-sync from a
 * date (watermark reset) or full re-sync. Audited with the reason.
 */
export function resync(actor: Actor, input: { flow: string; mode: ResyncMode; doc_type?: string; key?: string; from?: string; reason?: string }) {
  const f = mustFlow(input.flow);
  if (!isInbound(f)) throw badRequest(`${f.id} is an outbound flow. Use "Process queue now" or replay messages from the error queue.`);
  const docs = FLOW_DOCS[f.id] ?? [];
  const types = input.doc_type ? [input.doc_type] : docs;
  if (types.some((t) => !docs.includes(t))) throw badRequest(`${f.id} reads ${docs.join(', ')} documents.`, { doc_type: 'Not part of this flow' });
  let results: { docType: string; status: string; read: number; upserted: number; errors: number }[] = [];
  if (input.mode === 'document') {
    const key = input.key?.trim();
    if (!key) throw badRequest('Enter the SAP document key to re-sync.', { key: 'Required' });
    if (types.length !== 1) throw badRequest('Choose the document type for this key.', { doc_type: 'Required' });
    const doc = sapGet(types[0], key);
    if (!doc) throw badRequest(`SAP has no ${types[0]} document ${key}. Check the key (see the SAP document list in the runbook).`, { key: 'Not found in SAP' });
    // Re-trigger the SAP change pointer so the next delta read picks up this document again.
    sapPut(types[0], key, doc.payload, `Re-sync by ${actor.name}`);
    results = [{ docType: types[0], ...runSync(types[0], 'manual', actor) }];
  } else if (input.mode === 'from_date') {
    if (!input.from || !/^\d{4}-\d{2}-\d{2}$/.test(input.from)) throw badRequest('Choose the date to re-sync from.', { from: 'Use YYYY-MM-DD' });
    if (input.from > now().slice(0, 10)) throw badRequest('The re-sync date cannot be in the future.', { from: 'Future date' });
    for (const t of types) {
      run('INSERT INTO sync_state (flow, watermark) VALUES (?, ?) ON CONFLICT(flow) DO UPDATE SET watermark = excluded.watermark', `${f.id}:${t}`, `${input.from}T00:00:00.000Z`);
      results.push({ docType: t, ...runSync(t, 'manual', actor) });
    }
  } else {
    for (const t of types) results.push({ docType: t, ...runSync(t, 'full', actor) });
  }
  resolveRecoveredPulls();
  audit(actor, { action: `integration.resync_${input.mode}`, objectType: 'integration_flow', objectId: f.id, after: { doc_types: types, key: input.key ?? null, from: input.from ?? null, results }, reason: input.reason ?? null });
  const errors = results.reduce((s, r) => s + r.errors, 0);
  const lastErr = errors ? get<{ id: number; error: string }>(`SELECT id, error FROM integration_errors WHERE flow = ? AND status IN ${OPEN_ERR} ORDER BY updated_at DESC LIMIT 1`, f.id) : undefined;
  return {
    ok: errors === 0, results,
    message: `${f.id} ${input.mode === 'document' ? `document ${input.key}` : input.mode === 'from_date' ? `from ${input.from}` : 'full'} re-sync: ${results.map((r) => `${r.docType} read ${r.read}, upserted ${r.upserted}${r.errors ? `, ${r.errors} error(s)` : ''}`).join(' · ')}`,
    error: lastErr ?? null,
  };
}

export function documents(docType: string, q?: string) {
  const rows = sapList<Record<string, unknown>>(docType);
  const term = (q ?? '').trim().toLowerCase();
  return rows.filter((r) => !term || r.doc_key.toLowerCase().includes(term) || JSON.stringify(r.payload).toLowerCase().includes(term)).slice(0, 50)
    .map((r) => ({ doc_key: r.doc_key, changed_at: r.changed_at, summary: docSummary(docType, r.payload) }));
}

function docSummary(docType: string, p: any): string {
  switch (docType) {
    case 'PO': return `${p.vendor_sap_code} · ${p.plant} · ${p.released ? 'released' : 'not released'} · v${p.version ?? 1}${p.cancelled ? ' · cancelled' : ''}`;
    case 'GRN': return `PO ${p.po_no} · ${p.posting_date} · ${(p.items ?? []).length} item(s)`;
    case 'PR': return `${p.requisitioner_email} · ${(p.items ?? []).length} item(s)`;
    case 'VENDOR': return `${p.name}${p.blocked ? ' · blocked' : ''}`;
    case 'MATERIAL': return p.description ?? '';
    case 'OA': return `${p.type} · ${p.vendor_sap_code} · ${p.valid_from} – ${p.valid_to}`;
    case 'STOCK': return `${p.material_code} @ ${p.plant}: ${p.unrestricted}`;
    case 'INVSTATUS': return p.status ?? '';
    case 'ADVPAY': return `paid ${p.paid_date ?? '—'} · adjusted ${p.adjusted_amount ?? 0}`;
    default: return '';
  }
}

// ---------------------------------------------------------------- reconciliation (FR-SAP-07, SCR-SAP-03)
export function ensureTables() {
  run(`CREATE TABLE IF NOT EXISTS sap_reconciliations (
    id INTEGER PRIMARY KEY, ran_at TEXT NOT NULL, trigger TEXT, actor_id INTEGER, counts_json TEXT, diffs_json TEXT, diff_count INTEGER DEFAULT 0
  )`);
}

/** Map a reconciliation difference to the SAP document that can be re-sent. */
function diffAction(d: { object: string; key: string; issue: string }) {
  if (d.issue.startsWith('In platform')) return null;
  const k = d.key.split('/');
  switch (d.object) {
    case 'Vendor': return { flow: 'INT-M01', doc_type: 'VENDOR', key: d.key };
    case 'PR line': return { flow: 'INT-M03', doc_type: 'PR', key: k[0] };
    case 'PO line': return { flow: 'INT-M07', doc_type: 'PO', key: k[0] };
    case 'OA': return { flow: 'INT-M06', doc_type: 'OA', key: d.key };
    case 'GRN line': {
      const doc = sapList<{ grn_no: string; po_no: string }>('GRN').find((x) => x.payload.grn_no === k[0] && x.payload.po_no === k[1]);
      return doc ? { flow: 'INT-M10', doc_type: 'GRN', key: doc.doc_key } : null;
    }
    default: return null;
  }
}

function platformLink(d: { object: string; key: string }) {
  const k = d.key.split('/');
  if (d.object === 'PO line' || d.object === 'GRN line') {
    const po = get<{ id: number }>('SELECT id FROM pos WHERE po_no = ?', d.object === 'PO line' ? k[0] : k[1]);
    return po ? `/pos/${po.id}` : null;
  }
  if (d.object === 'PR line') {
    const l = get<{ id: number }>('SELECT id FROM pr_lines WHERE pr_no = ? AND item = ?', k[0], Number(k[1]));
    return l ? `/pr/${l.id}` : null;
  }
  if (d.object === 'Vendor') {
    const v = get<{ id: number }>('SELECT id FROM vendors WHERE sap_code = ?', d.key);
    return v ? `/vendors/${v.id}` : null;
  }
  return null;
}

export function runReconciliation(actor: Actor | null, trigger: 'manual' | 'scheduled' | 'seed') {
  const r = reconcile();
  const diffs = r.diffs.map((d) => ({ ...d, action: diffAction(d), link: platformLink(d) }));
  const id = insert('sap_reconciliations', { ran_at: r.ran_at, trigger, actor_id: actor?.id ?? null, counts_json: J(r.counts), diffs_json: J(diffs), diff_count: diffs.length });
  if (actor) audit(actor, { action: 'integration.reconciliation_run', objectType: 'integration_flow', objectId: 'reconciliation', after: { id, differences: diffs.length } });
  if (diffs.length && trigger === 'scheduled') {
    notify({ event: 'NTF-32', title: `SAP reconciliation found ${diffs.length} difference${diffs.length === 1 ? '' : 's'}`, body: diffs.slice(0, 3).map((d) => `${d.object} ${d.key}: ${d.issue}`).join('; '), link: '/integration/reconciliation', roles: ['SAP'], severity: 'warning', dedupeKey: `NTF-32:recon:${r.ran_at.slice(0, 10)}` });
  }
  return getReconciliation(id)!;
}

export function getReconciliation(id?: number) {
  const row = id
    ? get<{ id: number; ran_at: string; trigger: string; actor_id: number | null; counts: unknown; diffs: unknown; diff_count: number }>('SELECT * FROM sap_reconciliations WHERE id = ?', id)
    : get<{ id: number; ran_at: string; trigger: string; actor_id: number | null; counts: unknown; diffs: unknown; diff_count: number }>('SELECT * FROM sap_reconciliations ORDER BY id DESC LIMIT 1');
  if (!row) return null;
  const by = row.actor_id ? get<{ name: string }>('SELECT name FROM users WHERE id = ?', row.actor_id)?.name ?? null : null;
  return { ...row, ran_by: by ?? (row.trigger === 'manual' ? null : 'Scheduled job') };
}

export function reconciliationHistory() {
  return all<{ id: number; ran_at: string; trigger: string; diff_count: number }>('SELECT id, ran_at, trigger, diff_count FROM sap_reconciliations ORDER BY id DESC LIMIT 30');
}

/** Scheduler: NTF-33 when a flow is beyond its freshness threshold (FR-SAP-09). */
export function freshnessJob() {
  const cleared = resolveRecoveredPulls();
  let n = 0;
  for (const f of freshness().filter((x) => x.stale)) {
    n += notify({ event: 'NTF-33', title: `SAP freshness breached: ${f.id} ${f.name}`, body: f.lastSuccess ? `Last successful sync ${f.ageMinutes} minutes ago (threshold ${f.thresholdMinutes}).` : 'No successful sync yet.', link: '/integration', roles: ['SAP'], severity: 'warning', dedupeKey: `NTF-33:${f.id}:${now().slice(0, 13)}` }).length;
  }
  return `${n} freshness alert(s), ${cleared} recovered pull error(s) cleared`;
}
