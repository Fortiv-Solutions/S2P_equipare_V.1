/**
 * Every suggestion a person acts on or dismisses is recorded next to what they decided (BRD OCR-06/07 spirit):
 * it shows whether the assistance is useful and who accepted what. Audit events are written for each action as well.
 */
import { all, db, insert, now } from '../../core/db.ts';
import { audit } from '../../core/audit.ts';
import type { Actor } from '../../core/auth.ts';
import type { AiSource } from '../../core/ai.ts';

export function ensureSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_suggestions (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, object_type TEXT, object_id INTEGER, object_ref TEXT,
    source TEXT NOT NULL DEFAULT 'rules', summary TEXT, score INTEGER, decision TEXT NOT NULL,
    outcome TEXT, decided_by INTEGER, decided_by_name TEXT, decided_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_ai_sugg_obj ON ai_suggestions(object_type, object_id);`);
}

export type Decision = 'Accepted' | 'Edited' | 'Dismissed';
export interface SuggestionInput {
  kind: 'po_reminder' | 'po_escalation' | 'vendor_reply' | 'invoice_explanation' | 'ask';
  objectType?: string; objectId?: number; objectRef?: string; source?: AiSource; summary: string; score?: number | null; decision: Decision; outcome?: string | null;
}

export function logSuggestion(actor: Actor, s: SuggestionInput) {
  const id = insert('ai_suggestions', {
    kind: s.kind, object_type: s.objectType ?? null, object_id: s.objectId ?? null, object_ref: s.objectRef ?? null, source: s.source ?? 'rules',
    summary: s.summary.slice(0, 500), score: s.score ?? null, decision: s.decision, outcome: s.outcome?.slice(0, 500) ?? null,
    decided_by: actor.id, decided_by_name: actor.name, decided_at: now(),
  });
  audit(actor, { action: `ai.suggestion_${s.decision.toLowerCase()}`, objectType: s.objectType, objectId: s.objectId, objectRef: s.objectRef, after: { kind: s.kind, source: s.source ?? 'rules', score: s.score ?? null, outcome: s.outcome ?? null } });
  return id;
}

export function recentSuggestions(limit = 100) {
  return all<{ id: number; kind: string; object_type: string | null; object_id: number | null; object_ref: string | null; source: string; summary: string; score: number | null; decision: string; outcome: string | null; decided_by_name: string; decided_at: string }>(
    'SELECT id, kind, object_type, object_id, object_ref, source, summary, score, decision, outcome, decided_by_name, decided_at FROM ai_suggestions ORDER BY id DESC LIMIT ?', limit,
  );
}

export function suggestionStats() {
  const rows = all<{ kind: string; decision: string; n: number }>('SELECT kind, decision, COUNT(*) AS n FROM ai_suggestions GROUP BY kind, decision');
  const total = rows.reduce((a, r) => a + r.n, 0);
  const accepted = rows.filter((r) => r.decision !== 'Dismissed').reduce((a, r) => a + r.n, 0);
  return { total, accepted, acceptance_rate: total ? accepted / total : null, by_kind: rows };
}
