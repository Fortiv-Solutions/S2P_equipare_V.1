/**
 * Append-only, hash-chained audit trail (GOV-C01, FR-PLT-01, NFR-AUD-01).
 * Each event stores sha256(prev_hash + canonical event); `verifyChain` detects tampering.
 */
import crypto from 'node:crypto';
import { all, get, insert, J, now } from './db.ts';
import type { Actor } from './auth.ts';

export interface AuditInput {
  action: string;
  objectType?: string;
  objectId?: number | string | null;
  objectRef?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  channel?: string;
}

function canonical(e: Record<string, unknown>) {
  return JSON.stringify([e.ts, e.actor_id, e.role, e.action, e.object_type, e.object_id, e.object_ref, e.before_json, e.after_json, e.reason]);
}

export function audit(actor: Actor | null, input: AuditInput) {
  const prev = get<{ hash: string }>('SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1');
  const ev: Record<string, unknown> = {
    ts: now(),
    actor_id: actor?.id ?? null,
    actor_name: actor?.name ?? 'System',
    role: actor?.role ?? 'SYSTEM',
    action: input.action,
    object_type: input.objectType ?? null,
    object_id: input.objectId != null ? String(input.objectId) : null,
    object_ref: input.objectRef ?? null,
    // null and undefined are both stored as SQL NULL so verifyChain re-serialises identically.
    before_json: input.before == null ? null : J(input.before),
    after_json: input.after == null ? null : J(input.after),
    reason: input.reason ?? null,
    ip: actor?.ip ?? null,
    channel: input.channel ?? actor?.channel ?? 'system',
    prev_hash: prev?.hash ?? 'GENESIS',
  };
  ev.hash = crypto.createHash('sha256').update(String(ev.prev_hash) + canonical(ev)).digest('hex');
  insert('audit_events', ev);
}

/** Only changed keys, for compact before/after values. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after[k])) {
      b[k] = before?.[k] ?? null;
      a[k] = after[k];
    }
  }
  return { before: b, after: a };
}

export function verifyChain() {
  const rows = all<Record<string, unknown>>(
    'SELECT id, ts, actor_id, role, action, object_type, object_id, object_ref, before_json, after_json, reason, prev_hash, hash FROM audit_events ORDER BY id',
  );
  // `all` parses *_json columns; re-serialise to the stored form for hashing.
  let prev = 'GENESIS';
  for (const r of rows) {
    const ev = {
      ...r,
      before_json: r.before == null ? null : J(r.before),
      after_json: r.after == null ? null : J(r.after),
    };
    const expect = crypto.createHash('sha256').update(prev + canonical(ev)).digest('hex');
    if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, brokenAt: r.id as number, checked: rows.length };
    prev = r.hash as string;
  }
  return { ok: true, checked: rows.length };
}
