/**
 * SAP monitor extended demo data (only with DEMO_EXTRA): a week of inbound sync runs, scheduler history, reconciliation history
 * and a few resolved, replayed and discarded integration errors, so the monitor screens look lived in.
 *
 * These are history rows of the integration log (like the base seed's resolved error); nothing here touches SAP documents or
 * audit events. Deterministic: no Math.random().
 */
import { all, insert, run } from '../../core/db.ts';
import { listJobs } from '../../core/scheduler.ts';
import { D, U } from '../../seed/ctx.ts';
import * as M from './monitor.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const warn = (what: string, e: unknown) => console.warn(`sap seed_extra: ${what} skipped —`, (e as Error).message);

/** IST hour and minute on a day offset, as an ISO string. */
const at = (day: number, hour: number, minute = 0) => {
  const d = new Date(D(day, hour));
  d.setUTCMinutes(d.getUTCMinutes() + minute);
  return d.toISOString();
};
const plusSeconds = (iso: string, s: number) => new Date(Date.parse(iso) + s * 1000).toISOString();

/** Rewrite ids in time order so "newest first" lists show the real latest rows on top (no table references these ids). */
function renumberByTime(table: string, col: string) {
  const rows = all<{ id: number }>(`SELECT id FROM ${table} ORDER BY ${col}, id`);
  run(`UPDATE ${table} SET id = id + 1000000`);
  rows.forEach((r, i) => run(`UPDATE ${table} SET id = ? WHERE id = ?`, i + 1, r.id + 1000000));
}

const FLOWS: { flow: string; doc: string; times: [number, number][]; read: [number, number]; ratio: number }[] = [
  { flow: 'INT-M01', doc: 'VENDOR', times: [[7, 0]], read: [0, 2], ratio: 1 },
  { flow: 'INT-M02', doc: 'MATERIAL', times: [[7, 15]], read: [0, 1], ratio: 1 },
  { flow: 'INT-M03', doc: 'PR', times: [[9, 0], [15, 0]], read: [0, 7], ratio: 1 },
  { flow: 'INT-M04', doc: 'STOCK', times: [[6, 30]], read: [14, 44], ratio: 1 },
  { flow: 'INT-M06', doc: 'OA', times: [[8, 0]], read: [0, 1], ratio: 1 },
  { flow: 'INT-M07', doc: 'PO', times: [[9, 5], [15, 5]], read: [0, 6], ratio: 1 },
  { flow: 'INT-M10', doc: 'GRN', times: [[9, 10], [15, 10]], read: [0, 5], ratio: 1 },
  { flow: 'INT-M12', doc: 'INVSTATUS', times: [[18, 0]], read: [0, 6], ratio: 1 },
];

export function seedExtra() {
  const r = rng(77031);
  const between = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));

  // 1. A week of scheduled inbound runs, with an overnight outage on day 5, a partial PO run on day 3 and a partial GRN run on day 6.
  try {
    for (let d = 7; d >= 1; d--) {
      for (const f of FLOWS) {
        f.times.forEach(([h, m], idx) => {
          const started = at(-d, h, m);
          let status = 'Succeeded';
          let read = between(f.read[0], f.read[1]);
          let upserted = read;
          let errors = 0;
          let message = '';
          if (d === 5 && ['VENDOR', 'MATERIAL', 'STOCK'].includes(f.doc)) {
            status = 'Failed'; read = 0; upserted = 0; errors = 1;
            message = 'SAP system unavailable (simulated outage). Will retry on next schedule.';
          } else if (d === 3 && f.doc === 'PO' && idx === 0) {
            read = Math.max(read, 5); upserted = read - 1; errors = 1; status = 'Partial';
          } else if (d === 6 && f.doc === 'GRN' && idx === 1) {
            read = Math.max(read, 3); upserted = read - 1; errors = 1; status = 'Partial';
          }
          if (!message) message = `${f.doc}: read ${read}, upserted ${upserted}${errors ? `, ${errors} error(s)` : ''}`;
          insert('integration_jobs', {
            flow: f.flow, direction: 'SAP → S2P', trigger: 'scheduled', started_at: started, finished_at: plusSeconds(started, status === 'Failed' ? 1 : between(2, 9)),
            status, read_count: read, upserted, error_count: errors, message,
          });
        });
      }
    }
    // Manual runs by the SAP team (after the outage, and a full re-sync of outline agreements).
    for (const [d, h, doc, flow, trig, read] of [[5, 11, 'VENDOR', 'INT-M01', 'manual', 1], [5, 11, 'MATERIAL', 'INT-M02', 'manual', 0], [5, 11, 'STOCK', 'INT-M04', 'manual', 36], [4, 10, 'OA', 'INT-M06', 'full', 12], [2, 16, 'OA', 'INT-M06', 'event', 1], [1, 17, 'PO', 'INT-M07', 'event', 2]] as [number, number, string, string, string, number][]) {
      const started = at(-d, h, 20);
      insert('integration_jobs', { flow, direction: 'SAP → S2P', trigger: trig, started_at: started, finished_at: plusSeconds(started, 4), status: 'Succeeded', read_count: read, upserted: read, error_count: 0, message: `${doc}: read ${read}, upserted ${read}` });
    }
  } catch (e) { warn('job history', e); }

  // 2. Resolved, replayed and discarded integration errors with reasons (oldest first, so newer ones list first).
  try {
    const neha = U('neha.gupta');
    const err = (flow: string, messageId: string, idem: string | null, payload: unknown, error: string, type: 'business' | 'transient', attempts: number, status: string, day: number, hours: number, reason: string) =>
      insert('integration_errors', {
        flow, message_id: messageId, idempotency_key: idem, payload_json: JSON.stringify(payload), error, error_type: type, attempts, status, next_retry_at: null,
        created_at: at(day, 9), updated_at: at(day, 9 + hours), resolved_by: status === 'Resolved' && type === 'transient' && !idem ? null : neha, resolution_reason: reason,
      });
    err('INT-M06', 'OA:5500000150', null, { vendor_sap_code: '100150', type: 'ARC' }, 'Vendor 100150 not found for OA 5500000150', 'business', 2, 'Resolved', -26, 5, 'Vendor created through onboarding and linked by the INT-M01 sync; the outline agreement was replayed and the contract is active.');
    err('INT-M12', 'INVSTATUS:INV-26-90017', null, { inv_ref: 'INV-26-90017', status: 'Cleared' }, 'Invoice reference INV-26-90017 not found on the platform', 'business', 1, 'Discarded', -20, 2, 'Test document from the SAP quality client; finance and the SAP team confirmed it is not a production invoice.');
    err('INT-M10', 'GRN:5000298801-2026', null, { grn_no: '5000298801', po_no: '4500029880', plant: 'DHN1' }, 'PO 4500029880 for GRN 5000298801-2026 not in platform yet', 'business', 3, 'Discarded', -14, 20, 'GRN belongs to a plant pilot outside the platform scope; the Dhanbad stores in-charge confirmed it needs no supplier action.');
    err('INT-M07', 'PO:4500021014', null, { po_no: '4500021014', vendor_sap_code: '100099' }, 'Vendor 100099 not found for PO 4500021014', 'business', 2, 'Resolved', -9, 6, 'Vendor master corrected in SAP (wrong vendor code on the PO), re-synced, and the PO published to the right vendor.');
    err('INT-M08', 'POACK:4500020103:10:v1', 'POACK:4500020103:10:v1', { po_no: '4500020103', item: 10, ack_status: 'Accepted' }, 'SAP gateway timeout (504) while writing the acknowledgement', 'transient', 4, 'Replayed', -6, 3, 'Replayed after the gateway recovered; SAP confirmed the acknowledgement.');
    err('INT-M01', `VENDOR:pull:${at(-5, 7)}`, null, { docType: 'VENDOR' }, 'SAP system unavailable (simulated outage). Will retry on next schedule.', 'transient', 2, 'Resolved', -5, 4, 'A later sync of this document type succeeded');
  } catch (e) { warn('integration errors', e); }

  // 3. Scheduler history for every registered job (daily jobs for a week, frequent jobs for the last hours) and reconciliation history.
  try {
    for (const j of listJobs()) {
      if (j.everyMinutes >= 1440) {
        for (let d = 7; d >= 1; d--) {
          const started = at(-d, 2, between(0, 20));
          const failed = d === 4 && j.name === 'sap.reconcile';
          insert('job_runs', { job: j.name, started_at: started, finished_at: plusSeconds(started, between(1, 6)), status: failed ? 'Failed' : 'Succeeded', message: failed ? 'SAP read timed out while counting purchase order lines' : 'Completed — nothing needing attention' });
        }
      } else {
        const n = j.everyMinutes <= 30 ? 8 : 4;
        for (let i = n; i >= 1; i--) {
          const started = new Date(Date.now() - i * j.everyMinutes * 60000 - between(0, 40) * 1000).toISOString();
          insert('job_runs', { job: j.name, started_at: started, finished_at: plusSeconds(started, between(1, 3)), status: 'Succeeded', message: 'Completed — nothing needing attention' });
        }
      }
    }
    const base = M.getReconciliation();
    if (base) {
      const counts = base.counts as { object: string; sap: number; platform: number; sapTotal?: number; platformTotal?: number }[];
      for (let d = 9; d >= 1; d--) {
        const scale = (n: number) => Math.max(0, n - Math.round(((d * 9) / 100) * n * 0.1));
        const diffs = d === 3 ? [{ object: 'GRN line', key: '5000298801/4500029880/10', issue: 'In SAP, missing in platform', action: null, link: null }]
          : d === 6 ? [{ object: 'PO line', key: '4500021014/10', issue: 'Quantity differs: SAP 12, platform 10', action: null, link: null }] : [];
        const c = counts.map((x) => {
          const sap = scale(x.sap) + (d === 3 && x.object.startsWith('GRN') ? 1 : 0);
          const out: Record<string, unknown> = { ...x, sap, platform: scale(x.platform) };
          if (x.sapTotal != null) { out.sapTotal = scale(x.sapTotal) + (d === 6 && x.object.startsWith('Released PO') ? 2 : 0); out.platformTotal = scale(x.platformTotal ?? x.sapTotal); }
          return out;
        });
        insert('sap_reconciliations', { ran_at: at(-d, 2, 30), trigger: 'scheduled', actor_id: null, counts_json: JSON.stringify(c), diffs_json: JSON.stringify(diffs), diff_count: diffs.length });
      }
    }
    renumberByTime('integration_jobs', 'started_at');
    renumberByTime('job_runs', 'started_at');
    renumberByTime('sap_reconciliations', 'ran_at');
  } catch (e) { warn('scheduler and reconciliation history', e); }

}
