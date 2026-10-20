/** One status vocabulary → tone mapping for every module (PRD 10.1 status badges). */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'decision' | 'neutral' | 'amber' | 'deep';

const MAP: [RegExp, Tone][] = [
  [/^(approved|active|matched|posted|paid|payment released|received|closed|completed|accepted|deemed accepted|resolved|delivered|valid|succeeded|written|replayed|available|awarded|fully adjusted|applied|final|responded|submitted ✓)$/i, 'ok'],
  [/(rejected|blocked|failed|overdue|breach|expired|quarantined|cancelled in sap|exception|declined|payment blocked|dispute|lost|terminated|not responded|delivery failed)/i, 'bad'],
  [/(pending|awaiting|waiting|clarification|under review|under resolution|on hold|expiring|due|retrying|queued|partial|draft|not started|stale|returned|reopened|unassigned|requested|in transit|viewed|re-acknowledgement)/i, 'warn'],
  [/(approval|decision|deviation)/i, 'decision'],
  [/(published|in progress|assigned|synced|open|invited|raised|route decided|rfq in progress|po created|uploaded|ocr|validation|parked|in dispatch|submitted|running|identified|sent)/i, 'info'],
];

export function toneOf(status?: string | null): Tone {
  if (!status) return 'neutral';
  for (const [re, t] of MAP) if (re.test(status)) return t;
  return 'neutral';
}
