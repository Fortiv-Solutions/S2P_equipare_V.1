/**
 * AI assistance boundary.
 *
 * Facts, matching, tolerances and scores are always computed by deterministic rules. An AI model is used for one
 * thing only: wording a short plain-language summary of facts the rules already produced. It is optional:
 *   - off by default (config `ai.model_wording` = false), and
 *   - needs `ANTHROPIC_API_KEY` on the server (never stored in the database or sent to the browser).
 * Any failure, timeout or ungrounded answer returns null and the caller shows the rules text, labelled as such.
 * Nothing here posts to SAP or changes a record.
 */
import { cfg } from './config.ts';

export type AiSource = 'rules' | 'model';

export interface AiStatus {
  mode: 'rules' | 'rules+model';
  /** An API key is present on the server. */
  keyPresent: boolean;
  /** The business rule switch is on. */
  enabled: boolean;
  /** Both of the above: the model is called for wording. */
  active: boolean;
  model: string;
  note: string;
}

export function aiStatus(): AiStatus {
  const keyPresent = !!process.env.ANTHROPIC_API_KEY;
  let enabled = false;
  try { enabled = cfg<boolean>('ai.model_wording') === true; } catch { /* config not registered yet */ }
  const active = keyPresent && enabled;
  return {
    mode: active ? 'rules+model' : 'rules', keyPresent, enabled, active, model: process.env.S2P_AI_MODEL || 'claude-sonnet-5-5',
    note: active
      ? 'Summaries are worded by an AI model from facts the rules computed. Matching, tolerances and scores stay rule-based.'
      : keyPresent
        ? 'A model key is present but the “AI-worded summaries” rule is off. Summaries use plain rules text.'
        : 'No AI model is connected. Suggestions come from the rules engine; nothing is sent outside this server.',
  };
}

const SYSTEM = [
  'You write one short, plain-English summary (at most 3 sentences) for a procurement or finance user.',
  'Use ONLY the facts in the JSON the user sends. Never add numbers, names, dates or causes that are not in it.',
  'Do not give legal, tax or accounting advice. Do not claim anything was sent, posted or approved.',
  'Write for someone who knows procurement but has not seen this record.',
].join(' ');

/** Numbers in `text` must all appear in the facts, otherwise the wording is rejected. */
export function isGrounded(text: string, facts: unknown) {
  const hay = JSON.stringify(facts).replace(/,/g, '');
  const nums = text.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) ?? [];
  return nums.every((n) => hay.includes(n));
}

/** Ask the model to word a summary. Resolves null when the model is not active or anything goes wrong. */
export async function wordSummary(facts: unknown, instruction: string): Promise<{ text: string; model: string } | null> {
  const st = aiStatus();
  if (!st.active) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: st.model, max_tokens: 300, system: SYSTEM, messages: [{ role: 'user', content: `${instruction}\n\nFacts (JSON):\n${JSON.stringify(facts)}` }] }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((c) => c.type === 'text')?.text?.trim();
    if (!text || text.length > 800 || !isGrounded(text, facts)) return null;
    return { text, model: st.model };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
